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

function sameAccount(left, right) {
  const leftId = String(left && (left.accountId || left.id) || "").trim();
  const rightId = String(right && (right.accountId || right.id) || "").trim();
  const leftEmail = String(left && left.email || "").trim().toLowerCase();
  const rightEmail = String(right && right.email || "").trim().toLowerCase();
  return !!((leftId && rightId && leftId === rightId)
    || (leftEmail && rightEmail && leftEmail === rightEmail));
}

function normalizeBinding(value, fallbackUsedAt = "") {
  const accountId = String(value && (value.accountId || value.id) || "").trim();
  const email = String(value && value.email || "").trim();
  if (!accountId && !email) return null;
  return {
    accountId,
    email,
    usedAt: String(value && value.usedAt || fallbackUsedAt || ""),
    completedLeaseId: String(value && value.completedLeaseId || ""),
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
    createdAt: "", updatedAt: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (item[key] == null) { item[key] = value; changed = true; }
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
  if (ACTIVE_STATUSES.has(item.status) || item.status === "failed" || item.status === "disabled") return false;
  if (item.usageMode === "shared") return item.status === "unused" || item.status === "used";
  return item.status === "unused" && bindingCount(item) === 0;
}

function manualStatusesFor(item) {
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
  const displayUsedBy = ACTIVE_STATUSES.has(item.status)
    ? String(item.usedBy || "")
    : String(recent && recent.email || item.usedBy || "");
  return {
    id: item.id,
    maskedNumber: maskNumber(item.number),
    last4: String(item.number || "").slice(-4),
    status: item.status,
    usageMode: item.usageMode,
    bindingCount: bindingCount(item),
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
  if (!ACTIVE_STATUSES.has(item && item.status)) return false;
  return sameAccount(
    { accountId: item.usedByAccountId, email: item.usedBy },
    { accountId: key.id, email: key.email },
  );
}

function bindingForAccount(item, account) {
  const key = accountKey(account);
  return (Array.isArray(item && item.bindings) ? item.bindings : []).find((binding) => sameAccount(
    binding,
    { accountId: key.id, email: key.email },
  )) || null;
}

function claimMode(options) {
  const requested = typeof options === "string" ? options
    : (options && (options.mode != null ? options.mode : options.usageMode));
  if (requested == null || String(requested).trim() === "") return "";
  return requireUsageMode(requested);
}

/**
 * 原子领取：每个号码始终最多一个 active lease。先识别该账号已有 active/binding；
 * shared 在没有 active lease 时可从 used 再次领取给新账号，exclusive 成功一次后不再分配。
 * 首次领取和写入 leaseId 在同一同步调用内完成并立即落盘，避免并发任务拿到同一号码。
 */
function claimForAccount(account, options = {}) {
  const items = list();
  const key = accountKey(account);
  if (!key.id && !key.email) throw new Error("领取手机号需要账号 id 或邮箱");
  const mode = claimMode(options);

  // active 优先于历史 binding，避免异常数据下把仍在提交的任务误报成已完成。
  let item = items.find((entry) => (!mode || entry.usageMode === mode) && activeBelongsTo(entry, account));
  if (item && item.status === "reserved") {
    throw stateConflict("该账号已有手机号添加任务正在提交中，请等待当前任务结束后再试");
  }
  if (item && item.status === "pending") {
    // pending 只能复用原 token 做只读复查。旧数据缺 token 时补一个，但不改变提交时间。
    if (!item.leaseId) item.leaseId = genId("lease");
    item.updatedAt = nowIso();
    db.flushSync();
    return { item, leaseId: item.leaseId, reused: true, alreadyUsed: false, readOnly: true };
  }

  item = items.find((entry) => (!mode || entry.usageMode === mode) && bindingForAccount(entry, account));
  if (item) {
    return {
      item,
      leaseId: "",
      reused: true,
      alreadyUsed: true,
      readOnly: true,
      binding: bindingForAccount(item, account),
    };
  }

  item = items.find((entry) => isAvailable(entry, mode));
  if (!item) return null;
  const reused = bindingCount(item) > 0 || item.status === "used";
  const now = nowIso();
  item.status = "reserved";
  item.usedByAccountId = key.id;
  item.usedBy = String(account && account.email || "").trim();
  item.leaseId = genId("lease");
  item.completedLeaseId = "";
  item.reservedAt = now;
  item.submitIntentAt = "";
  item.submittedAt = "";
  item.usedAt = "";
  item.lastError = "";
  item.updatedAt = now;
  db.flushSync();
  return { item, leaseId: item.leaseId, reused, alreadyUsed: false, readOnly: false };
}

function validateLease(id, leaseId, allowed) {
  const item = getById(id);
  if (!item || !leaseId || item.leaseId !== leaseId || !allowed.has(item.status)) return null;
  return item;
}

function appendBinding(item, account, usedAt = nowIso(), completedLeaseId = "") {
  normalizeItem(item);
  const key = accountKey(account);
  if (!key.id && !key.email) throw new Error("成功绑定手机号需要账号 id 或邮箱");
  let binding = bindingForAccount(item, account);
  if (!binding) {
    binding = {
      accountId: key.id,
      email: String(account && account.email || "").trim(),
      usedAt,
      completedLeaseId: String(completedLeaseId || ""),
    };
    item.bindings.push(binding);
  } else {
    if (!binding.accountId && key.id) binding.accountId = key.id;
    if (!binding.email && key.email) binding.email = String(account && account.email || "").trim();
    if (!binding.usedAt) binding.usedAt = usedAt;
    if (!binding.completedLeaseId && completedLeaseId) binding.completedLeaseId = String(completedLeaseId);
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
  const item = validateLease(id, leaseId, new Set(["reserved"]));
  if (!item || item.submittedAt) return null;
  if (!item.submitIntentAt) item.submitIntentAt = nowIso();
  item.lastError = String(reason || "");
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

/** 只有仍为 reserved、尚未真正提交的同一 lease 才能撤销预提交保护。 */
function clearSubmitIntent(id, leaseId, reason = "") {
  const item = validateLease(id, leaseId, new Set(["reserved"]));
  if (!item || item.submittedAt) return null;
  item.submitIntentAt = "";
  item.lastError = String(reason || "");
  item.updatedAt = nowIso();
  db.flushSync();
  return item;
}

/** 号码已提交/短信可能已发出；动作运行期间保持互斥，终态由共享/独享策略分别处理。 */
function markPending(id, leaseId, reason = "手机号已提交，等待 Google 确认或生效") {
  const item = validateLease(id, leaseId, new Set(["reserved", "pending"]));
  if (!item) return null;
  const now = nowIso();
  item.status = "pending";
  if (!item.submitIntentAt) item.submitIntentAt = now;
  if (!item.submittedAt) item.submittedAt = now;
  item.lastError = String(reason || "");
  item.updatedAt = now;
  db.flushSync();
  return item;
}

function confirmUsed(id, leaseId) {
  const existing = getById(id);
  // 两个只读观察者可能同时看到 Google 的明确成功。共享号码甚至可能已被下一账号
  // 领取，因此完成 token 同时保存在 binding 内；迟到确认只幂等返回，不能覆盖新 lease。
  const completedBefore = existing && leaseId && (Array.isArray(existing.bindings) ? existing.bindings : [])
    .some((binding) => binding.completedLeaseId === leaseId);
  if (existing && leaseId && (existing.completedLeaseId === leaseId || completedBefore)) return existing;
  const item = validateLease(id, leaseId, new Set(["reserved", "pending"]));
  if (!item) return null;
  const now = nowIso();
  const account = { id: item.usedByAccountId, email: item.usedBy };
  const binding = appendBinding(item, account, now, leaseId);
  item.status = "used";
  item.lastError = "";
  item.completedLeaseId = leaseId;
  clearActiveLease(item);
  item.usedByAccountId = binding.accountId;
  item.usedBy = binding.email;
  item.usedAt = binding.usedAt;
  item.updatedAt = now;
  db.flushSync();
  return item;
}

/**
 * 用户已经在浏览器中亲自确认完成后，只同步本地记录，不再访问 Google。
 * 允许未占用的 unused、同账号的 reserved/pending，以及同账号 used 幂等确认；
 * 其它状态或跨账号占用一律拒绝，避免把号码错误归属给另一个账号。
 */
function confirmManualUsed(id, account) {
  const item = getById(id);
  if (!item) return null;
  const key = accountKey(account);
  if (!key.id || !key.email) throw new Error("人工确认手机号需要有效账号 id 和邮箱");

  const active = ACTIVE_STATUSES.has(item.status);
  if (active && !activeBelongsTo(item, account)) {
    throw stateConflict("该手机号当前正由另一个账号提交，不能人工确认");
  }

  const existingBinding = bindingForAccount(item, account);
  if (!active && existingBinding) {
    // 同账号重复确认幂等，同时修复旧状态为 used。
    item.status = "used";
    item.usedByAccountId = existingBinding.accountId;
    item.usedBy = existingBinding.email;
    item.usedAt = existingBinding.usedAt;
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
  const completedLeaseId = active ? item.leaseId : "";
  const binding = appendBinding(item, account, now, completedLeaseId);
  item.status = "used";
  item.usedByAccountId = binding.accountId;
  item.usedBy = binding.email;
  item.usedAt = binding.usedAt;
  clearActiveLease(item);
  item.completedLeaseId = completedLeaseId;
  item.lastError = "";
  item.updatedAt = now;
  db.flushSync();
  return item;
}

function markFailed(id, leaseId, reason) {
  // 此安全失败入口只处理尚未提交的 reserved。共享任务终态复用 releaseSharedAttempt；
  // 独享 pending / durable submit intent 则继续保护，等待人工核对。
  const item = validateLease(id, leaseId, new Set(["reserved"]));
  if (!item || item.submittedAt || item.submitIntentAt) return null;
  item.lastError = String(reason || "Google 拒绝该手机号");
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
  const item = validateLease(id, leaseId, new Set(["reserved"]));
  if (!item || item.submittedAt || item.submitIntentAt) return null;
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
 * 共享号码只在单个账号任务运行期间互斥。任务一旦结束，无论 Google 成功、拒绝、
 * 超时或要求人工验证，都清掉 active lease，让下一个账号继续使用同一个号码。
 */
function releaseSharedAttempt(id, leaseId, reason = "共享号码本次尝试已结束") {
  const item = validateLease(id, leaseId, ACTIVE_STATUSES);
  if (!item || item.usageMode !== "shared") return null;
  restoreAfterAttemptRelease(item, reason);
  db.flushSync();
  return item;
}

function requireReleaseOptions(options) {
  if (options == null) return {};
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("释放选项必须是对象");
  const allowed = new Set(["reason", "expectedReservedAt", "allowFresh"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("释放选项包含不支持的字段");
  if (Object.prototype.hasOwnProperty.call(options, "allowFresh") && typeof options.allowFresh !== "boolean") {
    throw new Error("allowFresh 必须是布尔值");
  }
  return options;
}

function restoreAfterAttemptRelease(item, reason) {
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
 * - expectedReservedAt 防止旧页面误释放已经变化的新 lease；
 * - 启动恢复传 allowFresh=true，因为新进程不会继续上一进程内存中的 job。
 */
function releaseUnsubmittedReservation(id, options = {}) {
  const opts = requireReleaseOptions(options);
  const item = getById(id);
  if (!item) return null;
  if (!ACTIVE_STATUSES.has(item.status)) throw stateConflict("只有占用中或待确认的号码可以释放");
  const reusableShared = item.usageMode === "shared";
  if (!reusableShared && item.status !== "reserved") {
    throw stateConflict("一号一绑的待确认号码不能释放，请先人工核对结果");
  }
  if (!reusableShared && (item.submittedAt || item.submitIntentAt)) {
    throw stateConflict("该号码已有提交意图或可能已经提交，不能释放；请人工核对后确认结果");
  }
  if (Object.prototype.hasOwnProperty.call(opts, "expectedReservedAt")
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
    item.usageMode === "shared" && ACTIVE_STATUSES.has(item.status)
  ) || (
    item.status === "reserved" && !item.submittedAt && !item.submitIntentAt
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
  if (hasMode && desiredMode !== item.usageMode) {
    if (ACTIVE_STATUSES.has(item.status)) throw stateConflict("手机号有进行中的任务，不能切换共享/独享模式");
    if (item.usageMode === "shared" && desiredMode === "exclusive" && bindingCount(item) > 1) {
      throw stateConflict("该共享手机号已绑定多个账号，不能切换为独享模式");
    }
  }

  let normalizedNumber = null;
  if (Object.prototype.hasOwnProperty.call(next, "number")) {
    if (ACTIVE_STATUSES.has(item.status) || item.status === "used" || bindingCount(item) > 0) {
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
      if ((desiredStatus === "reserved" || desiredStatus === "pending") && !ACTIVE_STATUSES.has(item.status)) {
        throw stateConflict("占用/待确认状态只能由添加手机号任务创建");
      }
      if (ACTIVE_STATUSES.has(item.status)) {
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
    ACTIVE_STATUSES.has(item.status)
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
  MANUAL_RELEASE_MIN_AGE_MS,
  MANUAL_STATUS_TRANSITIONS,
  normalizeNumber,
  parseLine,
  list,
  publicList,
  toPublic,
  getById,
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
