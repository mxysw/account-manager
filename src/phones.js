"use strict";

const path = require("path");
const { JsonDB } = require("./db");

const DATA_DIR = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR)
  : path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "phones.json");
const db = new JsonDB(DB_FILE, { phones: [] });

// reserved=动作已领取但尚未提交；pending=号码已提交、等待 Google 确认/生效（或条件性短信码）。
const STATUSES = ["unused", "reserved", "pending", "used", "failed", "disabled"];
const USAGE_MODES = ["shared", "exclusive"];
// 成功绑定证据跟随 binding 持久化。三态字段必须保留 unknown：旧数据没有
// 足够证据判断号码是本次新增还是页面原本已有，也不能把“未记录”冒充 false。
const BINDING_ORIGINS = ["added", "preexisting", "manual", "unknown"];
const BINDING_VERIFICATIONS = ["not_requested", "sms_completed", "unknown"];
const BINDING_ACTIVATIONS = ["deferred", "ready", "unknown"];
const ACTIVE_STATUSES = new Set(["reserved", "pending"]);
// 添加手机号动作的硬超时是 6 分钟。手动释放再留 4 分钟余量，避免用户在
// 正常页面等待期间把仍可能继续点击的 lease 释放给下一个账号。
const MANUAL_RELEASE_MIN_AGE_MS = 10 * 60 * 1000;
const MANUAL_STATUS_TRANSITIONS = {
  unused: new Set(["unused", "used", "failed", "disabled"]),
  // 活跃租约只能由自动化动作推进。即便 UI/API 改成 failed/disabled，迟到的点击也可能
  // 已经向 Google 发出短信；人工改状态会让 lease 失效并埋下重复分配风险。
  reserved: new Set(["reserved"]),
  pending: new Set(["pending"]),
  // 有成功绑定历史的号码可人工停用；恢复时仍保留绑定历史，不会变成“未用”。
  used: new Set(["used", "disabled"]),
  failed: new Set(["failed", "unused", "disabled"]),
  disabled: new Set(["disabled", "unused", "failed", "used"]),
};

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix = "p") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function stateConflict(message) {
  const err = new Error(message);
  err.code = "PHONE_STATE_CONFLICT";
  return err;
}

function requireUsageMode(value) {
  const mode = String(value == null ? "" : value).trim().toLowerCase();
  if (!USAGE_MODES.includes(mode)) throw new Error(`不支持的手机号使用模式：${mode || "空"}`);
  return mode;
}

/**
 * 统一为 E.164。允许空格、短横线、括号、全角加号和 00 国际前缀；
 * 不猜国家码，最终必须是 + 加 7~15 位数字，且国家码不能以 0 开头。
 */
function normalizeNumber(value) {
  let text = String(value == null ? "" : value).trim().replace(/^＋/, "+");
  text = text.replace(/[\s().-]/g, "");
  if (text.startsWith("00")) text = `+${text.slice(2)}`;
  if (!/^\+[1-9]\d{6,14}$/.test(text)) {
    // 错误会通过 API 返回；不要把用户粘贴的完整号码回显到响应或日志。
    throw new Error("手机号格式无效（需含国家码，如 +12025550123）");
  }
  return text;
}

/** 一行一个号码，可选用 | / ---- / Tab 在后面附备注。 */
function parseLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const sep = raw.includes("----") ? "----" : (raw.includes("|") ? "|" : (raw.includes("\t") ? "\t" : null));
  const parts = sep ? raw.split(sep).map((v) => v.trim()) : [raw];
  return {
    number: normalizeNumber(parts.shift()),
    notes: parts.filter(Boolean).join(" / "),
    raw,
  };
}

function createFrom(parsed, usageMode = "shared") {
  const now = nowIso();
  return {
    id: genId("phone"),
    number: parsed.number,
    usageMode: requireUsageMode(usageMode),
    bindings: [],
    // 共享号码允许多个账号同时执行。每次领取的可变状态全部放在独立 attempt 中，
    // 顶层 status/lease 字段仅保留为旧数据兼容和手机号池概览投影。
    attempts: [],
    // 只记录 active attempt 集合的变更次数，供手机号池的“释放全部”做乐观并发校验。
    // 它不包含 lease/account 信息，可以安全下发给本地页面。
    activeRevision: 0,
    status: "unused",
    usedByAccountId: "",
    usedBy: "",
    leaseId: "",
    completedLeaseId: "",
    reservedAt: "",
    submitIntentAt: "",
    submittedAt: "",
    usedAt: "",
    lastError: "",
    notes: parsed.notes || "",
    raw: parsed.raw,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeAttempt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const leaseId = String(value.leaseId || "").trim();
  const status = String(value.status || "reserved").trim().toLowerCase();
  if (!leaseId || !ACTIVE_STATUSES.has(status)) return null;
  const reservedAt = String(value.reservedAt || "");
  const submittedAt = String(value.submittedAt || "");
  let submitIntentAt = String(value.submitIntentAt || "");
  if (!submitIntentAt && (status === "pending" || submittedAt)) {
    submitIntentAt = submittedAt || reservedAt || nowIso();
  }
  return {
    leaseId,
    accountId: String(value.accountId || value.usedByAccountId || "").trim(),
    email: String(value.email || value.usedBy || "").trim(),
    status,
    reservedAt,
    submitIntentAt,
    submittedAt,
    lastError: String(value.lastError || ""),
  };
}

function mergeAttempts(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const attempt = normalizeAttempt(value);
    if (!attempt || seen.has(attempt.leaseId)) continue;
    seen.add(attempt.leaseId);
    result.push(attempt);
  }
  return result;
}

function sharedAttempts(item) {
  return item && item.usageMode === "shared" && Array.isArray(item.attempts) ? item.attempts : [];
}

function activeAttemptCount(item) {
  if (!item) return 0;
  if (item.usageMode === "shared") return sharedAttempts(item).length;
  return ACTIVE_STATUSES.has(item.status) && item.leaseId ? 1 : 0;
}

function bumpActiveRevision(item) {
  const current = Number.isSafeInteger(item && item.activeRevision) && item.activeRevision >= 0
    ? item.activeRevision : 0;
  item.activeRevision = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function displayAttempt(item) {
  const attempts = sharedAttempts(item);
  if (!attempts.length) return null;
  // 待确认比尚未提交更需要在池中显眼；同状态取最近领取的一次。
  return attempts.reduce((selected, attempt) => {
    if (!selected) return attempt;
    if (attempt.status === "pending" && selected.status !== "pending") return attempt;
    if (attempt.status !== "pending" && selected.status === "pending") return selected;
    return String(attempt.reservedAt || "") >= String(selected.reservedAt || "") ? attempt : selected;
  }, null);
}

/** 将共享 attempts 投影到旧顶层字段；业务状态机不得再用这些字段识别具体 lease。 */
function syncSharedProjection(item) {
  if (!item || item.usageMode !== "shared") return item;
  const attempts = sharedAttempts(item);
  if (attempts.length) {
    const display = displayAttempt(item);
    item.status = attempts.some((attempt) => attempt.status === "pending") ? "pending" : "reserved";
    item.usedByAccountId = display ? display.accountId : "";
    item.usedBy = display ? display.email : "";
    item.leaseId = display ? display.leaseId : "";
    item.reservedAt = display ? display.reservedAt : "";
    item.submitIntentAt = display ? display.submitIntentAt : "";
    item.submittedAt = display ? display.submittedAt : "";
    item.lastError = display ? display.lastError : "";
    item.usedAt = "";
    return item;
  }

  clearActiveLease(item);
  if (ACTIVE_STATUSES.has(item.status)) item.status = bindingCount(item) > 0 ? "used" : "unused";
  if (bindingCount(item) > 0) restoreRecentOwner(item);
  else {
    item.usedByAccountId = "";
    item.usedBy = "";
    item.usedAt = "";
  }
  return item;
}

function sameAccount(left, right) {
  const leftId = String(left && (left.accountId || left.id) || "").trim();
  const rightId = String(right && (right.accountId || right.id) || "").trim();
  const leftEmail = String(left && left.email || "").trim().toLowerCase();
  const rightEmail = String(right && right.email || "").trim().toLowerCase();
  return !!((leftId && rightId && leftId === rightId)
    || (leftEmail && rightEmail && leftEmail === rightEmail));
}

function bindingEnum(value, allowed) {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : "unknown";
}

function requireBindingEvidence(value) {
  if (value == null) return { origin: "unknown", verification: "unknown", activation: "unknown" };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("手机号绑定证据必须是对象");
  const allowedKeys = new Set(["origin", "verification", "activation"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("手机号绑定证据包含不支持的字段");
  }
  const read = (key, allowed) => {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] == null || value[key] === "") return "unknown";
    const normalized = String(value[key]).trim().toLowerCase();
    if (!allowed.includes(normalized)) throw new Error(`不支持的手机号绑定 ${key}：${normalized || "空"}`);
    return normalized;
  };
  return {
    origin: read("origin", BINDING_ORIGINS),
    verification: read("verification", BINDING_VERIFICATIONS),
    activation: read("activation", BINDING_ACTIVATIONS),
  };
}

function normalizeBinding(value, fallbackUsedAt = "") {
  const accountId = String(value && (value.accountId || value.id) || "").trim();
  const email = String(value && value.email || "").trim();
  if (!accountId && !email) return null;
  const removedAt = String(value && value.removedAt || "");
  const active = value && typeof value.active === "boolean" ? value.active : !removedAt;
  return {
    accountId,
    email,
    usedAt: String(value && value.usedAt || fallbackUsedAt || ""),
    completedLeaseId: String(value && value.completedLeaseId || ""),
    origin: bindingEnum(value && value.origin, BINDING_ORIGINS),
    verification: bindingEnum(value && value.verification, BINDING_VERIFICATIONS),
    activation: bindingEnum(value && value.activation, BINDING_ACTIVATIONS),
    active,
    // active 与 removedAt 互斥，避免旧/手改数据同时声称“仍绑定”和“已移除”。
    removedAt: active ? "" : removedAt,
  };
}

function mergeBindings(values, fallbackUsedAt = "") {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const binding = normalizeBinding(value, fallbackUsedAt);
    if (!binding) continue;
    const existing = result.find((entry) => sameAccount(entry, binding));
    if (existing) {
      if (!existing.accountId && binding.accountId) existing.accountId = binding.accountId;
      if (!existing.email && binding.email) existing.email = binding.email;
      if (!existing.usedAt && binding.usedAt) existing.usedAt = binding.usedAt;
      if (!existing.completedLeaseId && binding.completedLeaseId) existing.completedLeaseId = binding.completedLeaseId;
      // 首次可靠来源一旦写入就不能被后续“页面现在已存在”的观察覆盖。
      if (existing.origin === "unknown" && binding.origin !== "unknown") existing.origin = binding.origin;
      if (existing.verification === "unknown" && binding.verification !== "unknown") existing.verification = binding.verification;
      if (existing.activation === "unknown" && binding.activation !== "unknown") existing.activation = binding.activation;
      // 极少数旧数据可能有重复 binding；以较新的绑定/移除时间决定当前 active 状态。
      const existingStateAt = Date.parse(existing.removedAt || existing.usedAt || "");
      const bindingStateAt = Date.parse(binding.removedAt || binding.usedAt || "");
      if (Number.isFinite(bindingStateAt) && (!Number.isFinite(existingStateAt) || bindingStateAt > existingStateAt)) {
        existing.active = binding.active;
        existing.removedAt = binding.active ? "" : binding.removedAt;
      }
    } else {
      result.push(binding);
    }
  }
  return result;
}

function latestBinding(item) {
  const bindings = Array.isArray(item && item.bindings) ? item.bindings : [];
  if (!bindings.length) return null;
  return bindings.reduce((latest, binding) => {
    if (!latest) return binding;
    return String(binding.usedAt || "") >= String(latest.usedAt || "") ? binding : latest;
  }, null);
}

/**
 * 惰性迁移旧记录：旧号码默认 exclusive；旧 used 记录的 usedBy/usedAt 转成首个 binding。
 * active 记录的 usedBy 是当前租约所有者，不得误迁成成功绑定。
 */
function normalizeItem(item) {
  if (!item || typeof item !== "object") return false;
  let changed = false;
  if (!USAGE_MODES.includes(item.usageMode)) {
    item.usageMode = "exclusive";
    changed = true;
  }

  const fallbackUsedAt = String(item.usedAt || item.updatedAt || item.createdAt || "");
  let bindings = mergeBindings(item.bindings, fallbackUsedAt);
  if (item.status === "used" && (item.usedByAccountId || item.usedBy)) {
    const legacy = normalizeBinding({
      accountId: item.usedByAccountId,
      email: item.usedBy,
      usedAt: fallbackUsedAt || nowIso(),
      completedLeaseId: item.completedLeaseId,
    });
    if (legacy) {
      const existing = bindings.find((entry) => sameAccount(entry, legacy));
      if (!existing) bindings.push(legacy);
      else {
        if (!existing.accountId && legacy.accountId) existing.accountId = legacy.accountId;
        if (!existing.email && legacy.email) existing.email = legacy.email;
        if (!existing.usedAt && legacy.usedAt) existing.usedAt = legacy.usedAt;
        if (!existing.completedLeaseId && legacy.completedLeaseId) existing.completedLeaseId = legacy.completedLeaseId;
      }
    }
  }
  if (JSON.stringify(bindings) !== JSON.stringify(item.bindings || [])) {
    item.bindings = bindings;
    changed = true;
  } else if (!Array.isArray(item.bindings)) {
    item.bindings = bindings;
    changed = true;
  }

  // 有成功绑定历史的号码不能因旧数据或失败回退而变成“从未使用”。disabled 保留人工停用。
  if (bindings.length && (item.status === "unused" || item.status === "failed")) {
    item.status = "used";
    changed = true;
  }

  const defaults = {
    usedByAccountId: "", usedBy: "", leaseId: "", completedLeaseId: "",
    reservedAt: "", submitIntentAt: "", submittedAt: "", usedAt: "", lastError: "", notes: "", raw: "",
    createdAt: "", updatedAt: "", activeRevision: 0,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (item[key] == null) { item[key] = value; changed = true; }
  }
  if (!Number.isSafeInteger(item.activeRevision) || item.activeRevision < 0) {
    item.activeRevision = 0;
    changed = true;
  }

  let attempts = mergeAttempts(item.attempts);
  // 旧版共享号码只有一组顶层 lease 字段。首次读取时原样迁入 attempts；之后顶层字段
  // 只是投影，不能再次迁移成重复 attempt。
  if (item.usageMode === "shared" && ACTIVE_STATUSES.has(item.status) && attempts.length === 0) {
    const migrated = normalizeAttempt({
      leaseId: item.leaseId || genId("lease"),
      accountId: item.usedByAccountId,
      email: item.usedBy,
      status: item.status,
      reservedAt: item.reservedAt || item.updatedAt || item.createdAt || nowIso(),
      submitIntentAt: item.submitIntentAt,
      submittedAt: item.submittedAt,
      lastError: item.lastError,
    });
    if (migrated) {
      attempts.push(migrated);
      bumpActiveRevision(item);
    }
  }
  if (JSON.stringify(attempts) !== JSON.stringify(item.attempts || [])) {
    item.attempts = attempts;
    changed = true;
  } else if (!Array.isArray(item.attempts)) {
    item.attempts = attempts;
    changed = true;
  }

  // 兼容旧数据：pending 本身就代表已经跨过不可逆边界；旧 reserved 若已有
  // submittedAt，也必须视为已经产生提交意图。恢复流程只会处理两个字段都为空的 reserved。
  if (item.status === "pending" && !item.submitIntentAt) {
    item.submitIntentAt = String(item.submittedAt || item.reservedAt || item.updatedAt || item.createdAt || nowIso());
    changed = true;
  } else if (item.status === "reserved" && item.submittedAt && !item.submitIntentAt) {
    item.submitIntentAt = String(item.submittedAt);
    changed = true;
  }

  if (item.usageMode === "shared" && item.attempts.length) {
    const before = JSON.stringify([
      item.status, item.usedByAccountId, item.usedBy, item.leaseId, item.reservedAt,
      item.submitIntentAt, item.submittedAt, item.usedAt, item.lastError,
    ]);
    syncSharedProjection(item);
    const after = JSON.stringify([
      item.status, item.usedByAccountId, item.usedBy, item.leaseId, item.reservedAt,
      item.submitIntentAt, item.submittedAt, item.usedAt, item.lastError,
    ]);
    if (before !== after) changed = true;
  }

  if (!ACTIVE_STATUSES.has(item.status) && bindings.length) {
    const latest = latestBinding(item);
    if (latest && item.usedByAccountId !== latest.accountId) {
      item.usedByAccountId = latest.accountId;
      changed = true;
    }
    if (latest && item.usedBy !== latest.email) {
      item.usedBy = latest.email;
      changed = true;
    }
    if (latest && latest.usedAt && item.usedAt !== latest.usedAt) {
      item.usedAt = latest.usedAt;
      changed = true;
    }
  }
  return changed;
}

function list() {
  const data = db.get();
  if (!Array.isArray(data.phones)) data.phones = [];
  let changed = false;
  for (const item of data.phones) changed = normalizeItem(item) || changed;
  if (changed) db.save();
  return data.phones;
}

function getById(id) {
  return list().find((item) => item.id === id) || null;
}

function maskNumber(number) {
  const value = String(number || "");
  if (!value) return "";
  if (value.length <= 7) return `${value.slice(0, 2)}••${value.slice(-2)}`;
  return `${value.slice(0, 4)} •••• ${value.slice(-4)}`;
}

function redactPhoneText(value) {
  return String(value == null ? "" : value).replace(/(?:\+|00)[1-9][\d\s().-]{5,22}\d/g, (match) => {
    try { return maskNumber(normalizeNumber(match)); } catch (_) { return "••••"; }
  });
}

function bindingCount(item) {
  return Array.isArray(item && item.bindings) ? item.bindings.length : 0;
}

function isAvailable(item, requestedMode = "") {
  if (!item) return false;
  normalizeItem(item);
  if (requestedMode && item.usageMode !== requestedMode) return false;
  if (item.status === "failed" || item.status === "disabled") return false;
  // 共享号码的每个账号有独立 attempt，因此已有其它 active attempt 也仍可领取。
  if (item.usageMode === "shared") return ["unused", "used", "reserved", "pending"].includes(item.status);
  if (ACTIVE_STATUSES.has(item.status)) return false;
  return item.status === "unused" && bindingCount(item) === 0;
}

function manualStatusesFor(item) {
  if (activeAttemptCount(item) > 0) return [item.status];
  // 已经绑定过的号码只能在“已用”和“停用”之间切换。这样既能暂时阻止
  // 共享分配，也不会把 Google 侧已经存在的绑定伪装成未用/失败。
  if (bindingCount(item) > 0) {
    if (item.status === "used") return ["used", "disabled"];
    if (item.status === "disabled") return ["disabled", "used"];
  }
  const allowed = MANUAL_STATUS_TRANSITIONS[item && item.status];
  if (!allowed) return [];
  return [...allowed].filter((status) => {
    if (status === "unused" && bindingCount(item) > 0) return false;
    if (status === "used" && item.status === "disabled" && bindingCount(item) === 0) return false;
    if (status === "disabled" && item.status === "used" && bindingCount(item) === 0) return false;
    return true;
  });
}

/** 仅供本地 HTTP API/UI 使用；自动化模块继续通过 list/getById 读取完整号码。 */
function toPublic(item) {
  if (!item) return null;
  normalizeItem(item);
  const recent = latestBinding(item);
  const attempt = displayAttempt(item);
  const displayUsedBy = activeAttemptCount(item) > 0
    ? String(attempt && attempt.email || item.usedBy || "")
    : String(recent && recent.email || item.usedBy || "");
  return {
    id: item.id,
    maskedNumber: maskNumber(item.number),
    last4: String(item.number || "").slice(-4),
    status: item.status,
    usageMode: item.usageMode,
    bindingCount: bindingCount(item),
    activeCount: activeAttemptCount(item),
    activeRevision: item.activeRevision,
    available: isAvailable(item),
    allowedStatuses: manualStatusesFor(item),
    // 只显示当前租约或最近一次成功账号的邮箱；内部 accountId/bindings 不出 API。
    usedBy: displayUsedBy,
    reservedAt: item.reservedAt || "",
    submitIntentAt: item.submitIntentAt || "",
    submittedAt: item.submittedAt || "",
    usedAt: item.usedAt || "",
    lastError: redactPhoneText(item.lastError),
    notes: redactPhoneText(item.notes),
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
  };
}

function publicList() {
  return list().map(toPublic);
}

/**
 * 账号表使用的安全联表结果：只返回仍 active 的成功绑定，不包含完整手机号、邮箱或 lease。
 * 完整号码只能通过 numberForAccount 在再次校验账号绑定关系后取得。
 */
function publicBindingsForAccount(account, sourceItems = null) {
  const key = accountKey(account);
  if (!key.id && !key.email) return [];
  const result = [];
  // 批量账号列表可复用同一次已规范化的手机号快照，避免上千账号时反复迁移/扫描数据库。
  const items = Array.isArray(sourceItems) ? sourceItems : list();
  for (const item of items) {
    for (const binding of Array.isArray(item.bindings) ? item.bindings : []) {
      if (binding.active === false || !sameAccount(binding, { accountId: key.id, email: key.email })) continue;
      result.push({
        phoneId: item.id,
        maskedNumber: maskNumber(item.number),
        last4: String(item.number || "").slice(-4),
        origin: bindingEnum(binding.origin, BINDING_ORIGINS),
        verification: bindingEnum(binding.verification, BINDING_VERIFICATIONS),
        activation: bindingEnum(binding.activation, BINDING_ACTIVATIONS),
        boundAt: String(binding.usedAt || ""),
      });
    }
  }
  return result.sort((left, right) => (
    String(right.boundAt || "").localeCompare(String(left.boundAt || ""))
      || String(left.phoneId).localeCompare(String(right.phoneId))
  ));
}

/** 仅当 phoneId 确实有该账号的 active binding 时返回完整号码；否则返回空串。 */
function numberForAccount(phoneId, account) {
  const key = accountKey(account);
  if ((!key.id && !key.email) || !String(phoneId || "").trim()) return "";
  const item = getById(String(phoneId).trim());
  if (!item) return "";
  const binding = (Array.isArray(item.bindings) ? item.bindings : []).find((entry) => (
    entry.active !== false && sameAccount(entry, { accountId: key.id, email: key.email })
  ));
  return binding ? String(item.number || "") : "";
}

/**
 * Google 已明确移除账号号码后，由动作调用此函数同步本地绑定关系。
 * 先完整收集目标再修改；落盘失败会恢复内存快照，不产生“部分账号已移除”的状态。
 */
function markAccountBindingsRemoved(account) {
  const key = accountKey(account);
  if (!key.id && !key.email) throw new Error("移除手机号绑定需要账号 id 或邮箱");
  const targets = [];
  for (const item of list()) {
    for (const binding of Array.isArray(item.bindings) ? item.bindings : []) {
      if (binding.active === false || !sameAccount(binding, { accountId: key.id, email: key.email })) continue;
      targets.push({ item, binding });
    }
  }
  if (!targets.length) return { changed: 0 };

  const removedAt = nowIso();
  const snapshots = targets.map(({ item, binding }) => ({
    item,
    binding,
    active: binding.active,
    removedAt: binding.removedAt,
    updatedAt: item.updatedAt,
  }));
  try {
    for (const { item, binding } of targets) {
      binding.active = false;
      binding.removedAt = removedAt;
      item.updatedAt = removedAt;
    }
    db.flushSync();
  } catch (err) {
    for (const snapshot of snapshots) {
      snapshot.binding.active = snapshot.active;
      snapshot.binding.removedAt = snapshot.removedAt;
      snapshot.item.updatedAt = snapshot.updatedAt;
    }
    throw err;
  }
  return { changed: targets.length, removedAt };
}

function importText(text, options = {}) {
  const requested = typeof options === "string" ? options : (options && options.usageMode);
  const usageMode = requested == null || String(requested).trim() === ""
    ? "shared" : requireUsageMode(requested);
  const data = db.get();
  if (!Array.isArray(data.phones)) data.phones = [];
  const byNumber = new Map(data.phones.map((item) => [item.number, item]));
  let added = 0;
  let dup = 0;
  const errors = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (!parsed) continue;
    if (byNumber.has(parsed.number)) {
      dup += 1;
      continue;
    }
    const item = createFrom(parsed, usageMode);
    data.phones.push(item);
    byNumber.set(item.number, item);
    added += 1;
  }
  db.save();
  return { added, dup, total: data.phones.length, errors };
}

function accountKey(account) {
  const id = String(account && account.id || "").trim();
  const email = String(account && account.email || "").trim().toLowerCase();
  return { id, email };
}

function activeBelongsTo(item, account) {
  const key = accountKey(account);
  if (item && item.usageMode === "shared") {
    return sharedAttempts(item).some((attempt) => sameAccount(
      { accountId: attempt.accountId, email: attempt.email },
      { accountId: key.id, email: key.email },
    ));
  }
  if (!ACTIVE_STATUSES.has(item && item.status)) return false;
  return sameAccount(
    { accountId: item.usedByAccountId, email: item.usedBy },
    { accountId: key.id, email: key.email },
  );
}

function activeAttemptForAccount(item, account) {
  const key = accountKey(account);
  if (!item) return null;
  if (item.usageMode === "shared") {
    return sharedAttempts(item).find((attempt) => sameAccount(
      { accountId: attempt.accountId, email: attempt.email },
      { accountId: key.id, email: key.email },
    )) || null;
  }
  if (!ACTIVE_STATUSES.has(item.status) || !activeBelongsTo(item, account)) return null;
  return {
    leaseId: item.leaseId,
    accountId: item.usedByAccountId,
    email: item.usedBy,
    status: item.status,
    reservedAt: item.reservedAt,
    submitIntentAt: item.submitIntentAt,
    submittedAt: item.submittedAt,
    lastError: item.lastError,
  };
}

function bindingForAccount(item, account) {
  const key = accountKey(account);
  return (Array.isArray(item && item.bindings) ? item.bindings : []).find((binding) => (
    binding.active !== false && sameAccount(
      binding,
      { accountId: key.id, email: key.email },
    )
  )) || null;
}

function claimMode(options) {
  const requested = typeof options === "string" ? options
    : (options && (options.mode != null ? options.mode : options.usageMode));
  if (requested == null || String(requested).trim() === "") return "";
  return requireUsageMode(requested);
}

/**
 * 原子领取：shared 为每个账号创建独立 attempt，可把同一个号码同时交给多个任务；
 * exclusive 仍保持整条号码最多一个 active lease 且成功后不再分配。
 */
function claimForAccount(account, options = {}) {
  const items = list();
  const key = accountKey(account);
  if (!key.id && !key.email) throw new Error("领取手机号需要账号 id 或邮箱");
  const mode = claimMode(options);

  // active 优先于历史 binding，避免异常数据下把仍在提交的任务误报成已完成。
  let item = items.find((entry) => (!mode || entry.usageMode === mode) && activeBelongsTo(entry, account));
  let attempt = item ? activeAttemptForAccount(item, account) : null;
  if (item && attempt && attempt.status === "reserved") {
    throw stateConflict("该账号已有手机号添加任务正在提交中，请等待当前任务结束后再试");
  }
  if (item && attempt && attempt.status === "pending") {
    // pending 只能复用原 token 做只读复查。旧独享数据缺 token 时补一个。
    if (!attempt.leaseId && item.usageMode !== "shared") {
      item.leaseId = genId("lease");
      attempt.leaseId = item.leaseId;
    }
    item.updatedAt = nowIso();
    db.flushSync();
    return {
      item,
      attempt: { ...attempt },
      leaseId: attempt.leaseId,
      reused: true,
      alreadyUsed: false,
      readOnly: true,
    };
  }

  item = items.find((entry) => (!mode || entry.usageMode === mode) && bindingForAccount(entry, account));
  if (item) {
    return {
      item,
      leaseId: "",
      reused: true,
      alreadyUsed: true,
      readOnly: true,
      attempt: null,
      binding: bindingForAccount(item, account),
    };
  }

  const candidates = items.filter((entry) => isAvailable(entry, mode));
  // 多个共享号时优先把任务分给当前并发较少的号码；只有一个共享号时所有并发
  // 自然落到同一号码，满足一号多绑。独享仍按导入顺序领取不同号码。
  if (mode === "shared" || (!mode && candidates.some((entry) => entry.usageMode === "shared"))) {
    const shared = candidates.filter((entry) => entry.usageMode === "shared");
    if (shared.length) {
      item = shared.reduce((selected, entry) => (
        !selected || activeAttemptCount(entry) < activeAttemptCount(selected) ? entry : selected
      ), null);
    }
  }
  if (!item) item = candidates[0] || null;
  if (!item) return null;
  const reused = bindingCount(item) > 0 || item.status === "used";
  const now = nowIso();
  const leaseId = genId("lease");
  attempt = {
    leaseId,
    accountId: key.id,
    email: String(account && account.email || "").trim(),
    status: "reserved",
    reservedAt: now,
    submitIntentAt: "",
    submittedAt: "",
    lastError: "",
  };
  if (item.usageMode === "shared") {
    item.attempts.push(attempt);
    bumpActiveRevision(item);
    item.completedLeaseId = "";
    syncSharedProjection(item);
  } else {
    item.status = attempt.status;
    item.usedByAccountId = attempt.accountId;
    item.usedBy = attempt.email;
    item.leaseId = attempt.leaseId;
    item.completedLeaseId = "";
    item.reservedAt = attempt.reservedAt;
    item.submitIntentAt = "";
    item.submittedAt = "";
    item.usedAt = "";
    item.lastError = "";
  }
  item.updatedAt = now;
  db.flushSync();
  return { item, attempt: { ...attempt }, leaseId, reused, alreadyUsed: false, readOnly: false };
}

function getAttempt(id, leaseId) {
  const item = getById(id);
  if (!item || !leaseId) return null;
  if (item.usageMode === "shared") {
    const attempt = sharedAttempts(item).find((entry) => entry.leaseId === leaseId);
    return attempt ? { ...attempt } : null;
  }
  if (item.leaseId !== leaseId || !ACTIVE_STATUSES.has(item.status)) return null;
  return {
    leaseId: item.leaseId,
    accountId: item.usedByAccountId,
    email: item.usedBy,
    status: item.status,
    reservedAt: item.reservedAt,
    submitIntentAt: item.submitIntentAt,
    submittedAt: item.submittedAt,
    lastError: item.lastError,
  };
}

function validateLease(id, leaseId, allowed) {
  const item = getById(id);
  if (!item || !leaseId) return null;
  if (item.usageMode === "shared") {
    const attempt = sharedAttempts(item).find((entry) => entry.leaseId === leaseId);
    if (!attempt || !allowed.has(attempt.status)) return null;
    return { item, attempt };
  }
  if (item.leaseId !== leaseId || !allowed.has(item.status)) return null;
  return { item, attempt: null };
}

function fillUnknownBindingEvidence(binding, evidence) {
  let changed = false;
  for (const key of ["origin", "verification", "activation"]) {
    if (binding[key] === "unknown" && evidence[key] !== "unknown") {
      binding[key] = evidence[key];
      changed = true;
    }
  }
  return changed;
}

function appendBinding(item, account, usedAt = nowIso(), completedLeaseId = "", evidence = {}) {
  normalizeItem(item);
  const key = accountKey(account);
  if (!key.id && !key.email) throw new Error("成功绑定手机号需要账号 id 或邮箱");
  const normalizedEvidence = requireBindingEvidence(evidence);
  // inactive 历史记录也要复用同一条 binding；重新确认后恢复 active，但首次来源不改写。
  let binding = (Array.isArray(item && item.bindings) ? item.bindings : []).find((entry) => sameAccount(
    entry,
    { accountId: key.id, email: key.email },
  )) || null;
  if (!binding) {
    binding = {
      accountId: key.id,
      email: String(account && account.email || "").trim(),
      usedAt,
      completedLeaseId: String(completedLeaseId || ""),
      ...normalizedEvidence,
      active: true,
      removedAt: "",
    };
    item.bindings.push(binding);
  } else {
    const wasActive = binding.active !== false;
    if (!binding.accountId && key.id) binding.accountId = key.id;
    if (!binding.email && key.email) binding.email = String(account && account.email || "").trim();
    // 已移除后重新绑定是一轮全新的成功：时间与完成 token 必须换成新 lease，
    // 否则其它并发 claim 清掉根 token 后，新 lease 的幂等重放会无法识别。
    if (!wasActive) {
      binding.usedAt = usedAt;
      binding.completedLeaseId = String(completedLeaseId || "");
    } else {
      if (!binding.usedAt) binding.usedAt = usedAt;
      if (!binding.completedLeaseId && completedLeaseId) binding.completedLeaseId = String(completedLeaseId);
    }
    fillUnknownBindingEvidence(binding, normalizedEvidence);
    binding.active = true;
    binding.removedAt = "";
  }
  return binding;
}

function restoreRecentOwner(item) {
  const recent = latestBinding(item);
  item.usedByAccountId = recent ? recent.accountId : "";
  item.usedBy = recent ? recent.email : "";
  item.usedAt = recent ? recent.usedAt : "";
}

function clearActiveLease(item) {
  item.leaseId = "";
  item.reservedAt = "";
  item.submitIntentAt = "";
  item.submittedAt = "";
}

/**
 * 在可能产生外部副作用的点击前先落盘。仍保持 reserved，调用方只有在明确确认
 * 该点击没有提交（例如 Next 只打开了 Save 确认框）后才能 clearSubmitIntent。
 */
function markSubmitIntent(id, leaseId, reason = "即将提交手机号，等待页面结果") {
  const record = validateLease(id, leaseId, new Set(["reserved"]));
  if (!record) return null;
  const { item, attempt } = record;
  const target = attempt || item;
  if (target.submittedAt) return null;
  if (!target.submitIntentAt) target.submitIntentAt = nowIso();
  target.lastError = String(reason || "");
  if (attempt) syncSharedProjection(item);
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

/** 只有仍为 reserved、尚未真正提交的同一 lease 才能撤销预提交保护。 */
function clearSubmitIntent(id, leaseId, reason = "") {
  const record = validateLease(id, leaseId, new Set(["reserved"]));
  if (!record) return null;
  const { item, attempt } = record;
  const target = attempt || item;
  if (target.submittedAt) return null;
  target.submitIntentAt = "";
  target.lastError = String(reason || "");
  if (attempt) syncSharedProjection(item);
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

/** 号码已提交/短信可能已发出；只锁定当前 lease，终态由共享/独享策略分别处理。 */
function markPending(id, leaseId, reason = "手机号已提交，等待 Google 确认或生效") {
  const record = validateLease(id, leaseId, new Set(["reserved", "pending"]));
  if (!record) return null;
  const { item, attempt } = record;
  const target = attempt || item;
  const now = nowIso();
  target.status = "pending";
  if (!target.submitIntentAt) target.submitIntentAt = now;
  if (!target.submittedAt) target.submittedAt = now;
  target.lastError = String(reason || "");
  if (attempt) syncSharedProjection(item);
  item.updatedAt = now;
  db.flushSync();
  return item;
}

function confirmUsed(id, leaseId, evidence = {}) {
  // 即使是幂等重放也先验证调用方传入的证据，避免偶发拼写错误被静默吞掉。
  const normalizedEvidence = requireBindingEvidence(evidence);
  const existing = getById(id);
  // 两个只读观察者可能同时看到 Google 的明确成功。共享号码甚至可能已被下一账号
  // 领取，因此完成 token 同时保存在 binding 内；迟到确认只幂等返回，不能覆盖新 lease。
  const completedBefore = existing && leaseId && (Array.isArray(existing.bindings) ? existing.bindings : [])
    .some((binding) => binding.completedLeaseId === leaseId);
  if (existing && leaseId && (existing.completedLeaseId === leaseId || completedBefore)) return existing;
  const record = validateLease(id, leaseId, new Set(["reserved", "pending"]));
  if (!record) return null;
  const { item, attempt } = record;
  const now = nowIso();
  const account = attempt
    ? { id: attempt.accountId, email: attempt.email }
    : { id: item.usedByAccountId, email: item.usedBy };
  const binding = appendBinding(item, account, now, leaseId, normalizedEvidence);
  if (attempt) {
    item.attempts = sharedAttempts(item).filter((entry) => entry.leaseId !== leaseId);
    bumpActiveRevision(item);
    item.status = "used";
    item.completedLeaseId = leaseId;
    syncSharedProjection(item);
    if (!item.attempts.length) {
      item.usedByAccountId = binding.accountId;
      item.usedBy = binding.email;
      item.usedAt = binding.usedAt;
    }
  } else {
    item.status = "used";
    item.completedLeaseId = leaseId;
    clearActiveLease(item);
    item.usedByAccountId = binding.accountId;
    item.usedBy = binding.email;
    item.usedAt = binding.usedAt;
  }
  item.lastError = "";
  item.updatedAt = now;
  db.flushSync();
  return item;
}

/**
 * 用户已经在浏览器中亲自确认完成后，只同步本地记录，不再访问 Google。
 * 允许未占用的 unused、同账号的 reserved/pending，以及同账号 used 幂等确认；
 * 其它状态或跨账号占用一律拒绝，避免把号码错误归属给另一个账号。
 */
function confirmManualUsed(id, account, evidence = {
  origin: "manual",
  verification: "unknown",
  activation: "unknown",
}) {
  const normalizedEvidence = requireBindingEvidence(evidence);
  const item = getById(id);
  if (!item) return null;
  const key = accountKey(account);
  if (!key.id || !key.email) throw new Error("人工确认手机号需要有效账号 id 和邮箱");

  const matchingAttempt = activeAttemptForAccount(item, account);
  const active = activeAttemptCount(item) > 0;
  const existingBinding = bindingForAccount(item, account);
  if (active && !matchingAttempt && !existingBinding) {
    throw stateConflict("该手机号当前正由另一个账号提交，不能人工确认");
  }

  if (existingBinding) {
    // 同账号重复确认幂等，同时修复旧状态为 used。
    fillUnknownBindingEvidence(existingBinding, normalizedEvidence);
    if (item.usageMode === "shared" && matchingAttempt) {
      item.attempts = sharedAttempts(item).filter((entry) => entry.leaseId !== matchingAttempt.leaseId);
      bumpActiveRevision(item);
      item.status = "used";
      syncSharedProjection(item);
    } else if (!active) {
      item.status = "used";
      item.usedByAccountId = existingBinding.accountId;
      item.usedBy = existingBinding.email;
      item.usedAt = existingBinding.usedAt;
    }
    item.lastError = "";
    item.updatedAt = nowIso();
    db.flushSync();
    return item;
  }

  if (!active && item.usageMode === "exclusive" && bindingCount(item) > 0) {
    throw stateConflict("该独享手机号已成功绑定其它账号，不能再次使用");
  }
  if (!active && !["unused", "used"].includes(item.status)) {
    throw stateConflict(`手机号当前状态为 ${item.status}，不能人工确认已使用`);
  }

  const now = nowIso();
  const completedLeaseId = matchingAttempt ? matchingAttempt.leaseId : "";
  const binding = appendBinding(item, account, now, completedLeaseId, normalizedEvidence);
  if (item.usageMode === "shared") {
    if (matchingAttempt) {
      item.attempts = sharedAttempts(item).filter((entry) => entry.leaseId !== matchingAttempt.leaseId);
      bumpActiveRevision(item);
    }
    item.status = "used";
    syncSharedProjection(item);
    if (!item.attempts.length) {
      item.usedByAccountId = binding.accountId;
      item.usedBy = binding.email;
      item.usedAt = binding.usedAt;
    }
  } else {
    item.status = "used";
    item.usedByAccountId = binding.accountId;
    item.usedBy = binding.email;
    item.usedAt = binding.usedAt;
    clearActiveLease(item);
  }
  item.completedLeaseId = completedLeaseId;
  item.lastError = "";
  item.updatedAt = now;
  db.flushSync();
  return item;
}

function markFailed(id, leaseId, reason) {
  // 此安全失败入口只处理尚未提交的 reserved。共享任务终态复用 releaseSharedAttempt；
  // 独享 pending / durable submit intent 则继续保护，等待人工核对。
  const record = validateLease(id, leaseId, new Set(["reserved"]));
  if (!record) return null;
  const { item, attempt } = record;
  const target = attempt || item;
  if (target.submittedAt || target.submitIntentAt) return null;
  const error = String(reason || "Google 拒绝该手机号");
  if (attempt) {
    item.attempts = sharedAttempts(item).filter((entry) => entry.leaseId !== leaseId);
    bumpActiveRevision(item);
    syncSharedProjection(item);
    item.lastError = error;
    item.updatedAt = nowIso();
    db.flushSync();
    return item;
  }
  item.lastError = error;
  item.completedLeaseId = "";
  clearActiveLease(item);
  if (bindingCount(item) > 0) {
    item.status = "used";
    restoreRecentOwner(item);
  } else {
    item.status = "failed";
    item.usedByAccountId = "";
    item.usedBy = "";
    item.usedAt = "";
  }
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

/** 独享安全释放：只允许尚未提交的 reserved；pending 永不经此入口自动回收。 */
function release(id, leaseId, reason = "") {
  const record = validateLease(id, leaseId, new Set(["reserved"]));
  if (!record) return null;
  const { item, attempt } = record;
  const target = attempt || item;
  if (target.submittedAt || target.submitIntentAt) return null;
  if (attempt) {
    item.attempts = sharedAttempts(item).filter((entry) => entry.leaseId !== leaseId);
    bumpActiveRevision(item);
    syncSharedProjection(item);
    item.lastError = String(reason || "");
    item.updatedAt = nowIso();
    db.flushSync();
    return item;
  }
  clearActiveLease(item);
  item.completedLeaseId = "";
  item.lastError = String(reason || "");
  if (bindingCount(item) > 0) {
    item.status = "used";
    restoreRecentOwner(item);
  } else {
    item.status = "unused";
    item.usedByAccountId = "";
    item.usedBy = "";
    item.usedAt = "";
  }
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

/**
 * 共享号码每个账号有独立 attempt。任务一旦结束，无论 Google 成功、拒绝、
 * 超时或要求人工验证，都只清掉本 lease，其它并发账号不受影响。
 */
function releaseSharedAttempt(id, leaseId, reason = "共享号码本次尝试已结束") {
  const record = validateLease(id, leaseId, ACTIVE_STATUSES);
  if (!record || !record.attempt || record.item.usageMode !== "shared") return null;
  const { item } = record;
  item.attempts = sharedAttempts(item).filter((entry) => entry.leaseId !== leaseId);
  bumpActiveRevision(item);
  syncSharedProjection(item);
  item.lastError = String(reason || "共享号码本次尝试已结束");
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

function requireReleaseOptions(options) {
  if (options == null) return {};
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("释放选项必须是对象");
  const allowed = new Set([
    "reason", "expectedReservedAt", "expectedActiveRevision", "expectedActiveCount", "allowFresh",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("释放选项包含不支持的字段");
  if (Object.prototype.hasOwnProperty.call(options, "allowFresh") && typeof options.allowFresh !== "boolean") {
    throw new Error("allowFresh 必须是布尔值");
  }
  for (const key of ["expectedActiveRevision", "expectedActiveCount"]) {
    if (Object.prototype.hasOwnProperty.call(options, key)
      && (!Number.isSafeInteger(options[key]) || options[key] < 0)) {
      throw new Error(`${key} 必须是非负安全整数`);
    }
  }
  return options;
}

function restoreAfterAttemptRelease(item, reason) {
  if (item.usageMode === "shared" && sharedAttempts(item).length) {
    item.attempts = [];
    bumpActiveRevision(item);
  }
  clearActiveLease(item);
  item.completedLeaseId = "";
  item.lastError = String(reason || "手机号本次账号占用已释放");
  if (bindingCount(item) > 0) {
    item.status = "used";
    restoreRecentOwner(item);
  } else {
    item.status = "unused";
    item.usedByAccountId = "";
    item.usedBy = "";
    item.usedAt = "";
  }
  item.updatedAt = nowIso();
  return item;
}

/**
 * 释放单条 active lease。
 * - 共享号码允许用户立即结束当前账号占用，不以成功/失败或是否已提交为前提；
 * - 一号一绑仅允许释放尚未提交且超过安全时限的 reserved；
 * - shared 用 activeRevision + activeCount 校验整组 attempt 快照；
 * - exclusive 用 expectedReservedAt 防止旧页面误释放已经变化的新 lease；
 * - 启动恢复传 allowFresh=true，因为新进程不会继续上一进程内存中的 job。
 */
function releaseUnsubmittedReservation(id, options = {}) {
  const opts = requireReleaseOptions(options);
  const item = getById(id);
  if (!item) return null;
  if (activeAttemptCount(item) === 0) throw stateConflict("只有占用中或待确认的号码可以释放");
  const reusableShared = item.usageMode === "shared";
  if (!reusableShared && item.status !== "reserved") {
    throw stateConflict("一号一绑的待确认号码不能释放，请先人工核对结果");
  }
  if (!reusableShared && (item.submittedAt || item.submitIntentAt)) {
    throw stateConflict("该号码已有提交意图或可能已经提交，不能释放；请人工核对后确认结果");
  }
  if (reusableShared) {
    const hasRevision = Object.prototype.hasOwnProperty.call(opts, "expectedActiveRevision");
    const hasCount = Object.prototype.hasOwnProperty.call(opts, "expectedActiveCount");
    if (!hasRevision || !hasCount) {
      throw stateConflict("共享号码占用快照已过期，请刷新手机号池后重试");
    }
    if (opts.expectedActiveRevision !== item.activeRevision
      || opts.expectedActiveCount !== activeAttemptCount(item)) {
      throw stateConflict("共享号码的并发占用已经变化，请刷新后重试");
    }
  } else if (Object.prototype.hasOwnProperty.call(opts, "expectedReservedAt")
    && String(opts.expectedReservedAt || "") !== String(item.reservedAt || "")) {
    throw stateConflict("手机号占用已经变化，请刷新后重试");
  }
  if (!reusableShared && opts.allowFresh !== true) {
    const reservedTime = Date.parse(String(item.reservedAt || ""));
    if (!Number.isFinite(reservedTime)) {
      throw stateConflict("手机号缺少有效占用时间，请重启服务执行安全恢复");
    }
    if (Date.now() - reservedTime < MANUAL_RELEASE_MIN_AGE_MS) {
      throw stateConflict("手机号任务可能仍在运行，请停止任务并等待占用超过 10 分钟后再释放");
    }
  }
  restoreAfterAttemptRelease(item, opts.reason);
  db.flushSync();
  return item;
}

/**
 * 新服务进程启动后恢复上一进程留下的 active lease。jobs 不持久化，旧进程无法继续：
 * - 共享号码不论 reserved/pending/submit intent 都恢复为可复用；
 * - 一号一绑只恢复确定尚未提交的 reserved，可能已提交的状态继续保护。
 */
function recoverUnsubmittedReservations(options = {}) {
  const opts = requireReleaseOptions(options);
  if (Object.prototype.hasOwnProperty.call(opts, "allowFresh") && opts.allowFresh !== true) {
    throw new Error("启动恢复只支持 allowFresh=true");
  }
  const reason = opts.reason || "服务重启后自动恢复手机号池可用状态";
  const candidates = list().filter((item) => (
    item.usageMode === "shared" && activeAttemptCount(item) > 0
  ) || (
    item.usageMode !== "shared" && item.status === "reserved" && !item.submittedAt && !item.submitIntentAt
  ));
  let toUnused = 0;
  let toUsed = 0;
  for (const item of candidates) {
    const hadBindings = bindingCount(item) > 0;
    restoreAfterAttemptRelease(item, reason);
    if (hadBindings) toUsed += 1;
    else toUnused += 1;
  }
  if (candidates.length) db.flushSync();
  return { released: candidates.length, toUnused, toUsed };
}

function update(id, patch) {
  const item = getById(id);
  if (!item) return null;
  const next = patch || {};
  const hasMode = Object.prototype.hasOwnProperty.call(next, "usageMode");
  const desiredMode = hasMode ? requireUsageMode(next.usageMode) : item.usageMode;
  const hasActive = activeAttemptCount(item) > 0;
  if (hasMode && desiredMode !== item.usageMode) {
    if (hasActive) throw stateConflict("手机号有进行中的任务，不能切换共享/独享模式");
    if (item.usageMode === "shared" && desiredMode === "exclusive" && bindingCount(item) > 1) {
      throw stateConflict("该共享手机号已绑定多个账号，不能切换为独享模式");
    }
  }

  let normalizedNumber = null;
  if (Object.prototype.hasOwnProperty.call(next, "number")) {
    if (hasActive || item.status === "used" || bindingCount(item) > 0) {
      throw stateConflict("占用中或已有绑定历史的号码不能修改");
    }
    normalizedNumber = normalizeNumber(next.number);
    const duplicate = list().find((entry) => entry.id !== id && entry.number === normalizedNumber);
    if (duplicate) throw new Error("该手机号已存在");
  }

  let desiredStatus = null;
  if (Object.prototype.hasOwnProperty.call(next, "status")) {
    desiredStatus = String(next.status);
    if (!STATUSES.includes(desiredStatus)) throw new Error(`不支持的手机号状态：${desiredStatus}`);
    const allowed = manualStatusesFor(item);
    if (!allowed.includes(desiredStatus)) {
      if ((desiredStatus === "reserved" || desiredStatus === "pending") && !hasActive) {
        throw stateConflict("占用/待确认状态只能由添加手机号任务创建");
      }
      if (hasActive) {
        throw stateConflict("手机号有进行中的任务，只能由持有 lease 的自动化动作推进");
      }
      if (bindingCount(item) > 0) {
        throw stateConflict("已有成功绑定历史的号码只能在已用和停用之间切换");
      }
      throw stateConflict(`不允许把手机号状态从 ${item.status} 改为 ${desiredStatus}`);
    }
    if (desiredStatus === "unused" && bindingCount(item) > 0) {
      throw stateConflict("已有成功绑定历史的号码不能清空为未用");
    }
  }

  if (hasMode) item.usageMode = desiredMode;
  if (normalizedNumber) item.number = normalizedNumber;
  if (Object.prototype.hasOwnProperty.call(next, "notes")) item.notes = String(next.notes == null ? "" : next.notes);
  if (Object.prototype.hasOwnProperty.call(next, "lastError")) item.lastError = String(next.lastError == null ? "" : next.lastError);
  if (desiredStatus) {
    const now = nowIso();
    item.status = desiredStatus;
    if (desiredStatus === "unused") {
      clearActiveLease(item);
      item.usedByAccountId = "";
      item.usedBy = "";
      item.usedAt = "";
      item.lastError = "";
      item.completedLeaseId = "";
    } else if (desiredStatus === "used") {
      item.usedAt = item.usedAt || now;
      item.completedLeaseId = item.completedLeaseId || item.leaseId || "";
      clearActiveLease(item);
      item.lastError = "";
      if (bindingCount(item) > 0) restoreRecentOwner(item);
    } else if (desiredStatus === "failed" || desiredStatus === "disabled") {
      clearActiveLease(item);
      item.completedLeaseId = "";
    }
  }
  item.updatedAt = nowIso();
  db.save();
  return item;
}

/**
 * 默认保护 active lease、used 状态和成功 binding。
 * forceBound=true 只代表用户明确删除本地记录，不会也不能删除 Google 侧绑定；
 * reserved/pending 在任何情况下都不能删除，避免任务继续运行后写回一条已删除记录。
 */
function remove(ids, options = {}) {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("删除选项必须是对象");
  }
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => key !== "forceBound")) {
    throw new Error("删除选项只支持 forceBound");
  }
  if (Object.prototype.hasOwnProperty.call(options, "forceBound") && typeof options.forceBound !== "boolean") {
    throw new Error("forceBound 必须是布尔值");
  }
  const forceBound = options.forceBound === true;
  const rawIds = Array.isArray(ids) ? ids : [ids];
  const normalizedIds = rawIds.map((id) => {
    if (typeof id !== "string" || !id.trim()) throw new Error("手机号 id 必须是非空字符串");
    return id.trim();
  });
  const data = db.get();
  const items = list();
  const set = new Set(normalizedIds);
  const blocked = items.filter((item) => set.has(item.id) && (
    activeAttemptCount(item) > 0
    || (!forceBound && (item.status === "used" || bindingCount(item) > 0))
  ));
  if (blocked.length) return { removed: 0, blocked: blocked.map((item) => item.id), total: items.length };
  const before = items.length;
  data.phones = items.filter((item) => !set.has(item.id));
  db.save();
  return { removed: before - data.phones.length, blocked: [], total: data.phones.length };
}

function flush() {
  db.flushSync();
}

module.exports = {
  STATUSES,
  USAGE_MODES,
  BINDING_ORIGINS,
  BINDING_VERIFICATIONS,
  BINDING_ACTIVATIONS,
  MANUAL_RELEASE_MIN_AGE_MS,
  MANUAL_STATUS_TRANSITIONS,
  normalizeNumber,
  parseLine,
  list,
  publicList,
  publicBindingsForAccount,
  numberForAccount,
  markAccountBindingsRemoved,
  toPublic,
  getById,
  getAttempt,
  importText,
  update,
  remove,
  claimForAccount,
  markSubmitIntent,
  clearSubmitIntent,
  markPending,
  confirmUsed,
  confirmManualUsed,
  markFailed,
  release,
  releaseSharedAttempt,
  releaseUnsubmittedReservation,
  recoverUnsubmittedReservations,
  flush,
  _db: db,
};
