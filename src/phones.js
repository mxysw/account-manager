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
const MANUAL_STATUS_TRANSITIONS = {
  unused: new Set(["unused", "used", "failed", "disabled"]),
  // 活跃租约只能由自动化动作推进。即便 UI/API 改成 failed/disabled，迟到的点击也可能
  // 已经向 Google 发出短信；人工改状态会让 lease 失效并埋下重复分配风险。
  reserved: new Set(["reserved"]),
  pending: new Set(["pending"]),
  // 已使用号码是永久占用记录，不能再改回可分配状态。
  used: new Set(["used"]),
  failed: new Set(["failed", "unused", "disabled"]),
  disabled: new Set(["disabled", "unused", "failed"]),
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
    reservedAt: "", submittedAt: "", usedAt: "", lastError: "", notes: "", raw: "",
    createdAt: "", updatedAt: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (item[key] == null) { item[key] = value; changed = true; }
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
  const allowed = MANUAL_STATUS_TRANSITIONS[item && item.status];
  if (!allowed) return [];
  return [...allowed].filter((status) => status !== "unused" || bindingCount(item) === 0);
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
  let item = items.find((entry) => activeBelongsTo(entry, account));
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

  item = items.find((entry) => bindingForAccount(entry, account));
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
  item.submittedAt = "";
}

/** 号码已提交/短信可能已发出；从此不能自动释放给别的账号。 */
function markPending(id, leaseId, reason = "手机号已提交，等待 Google 确认或生效") {
  const item = validateLease(id, leaseId, new Set(["reserved", "pending"]));
  if (!item) return null;
  const now = nowIso();
  item.status = "pending";
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
  const item = validateLease(id, leaseId, new Set(["reserved", "pending"]));
  if (!item) return null;
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

/** 只允许释放尚未提交的 reserved；pending 永不自动回收。 */
function release(id, leaseId, reason = "") {
  const item = validateLease(id, leaseId, new Set(["reserved"]));
  if (!item || item.submittedAt) return null;
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
    const allowed = MANUAL_STATUS_TRANSITIONS[item.status];
    if (!allowed || !allowed.has(desiredStatus)) {
      if ((desiredStatus === "reserved" || desiredStatus === "pending") && !ACTIVE_STATUSES.has(item.status)) {
        throw stateConflict("占用/待确认状态只能由添加手机号任务创建");
      }
      if (ACTIVE_STATUSES.has(item.status)) {
        throw stateConflict("手机号有进行中的任务，只能由持有 lease 的自动化动作推进");
      }
      if (item.status === "used") {
        throw stateConflict("已有成功绑定历史的号码不能手工改为其它状态");
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

/** 有 active lease、used 状态或任何成功 binding 都拒绝删除，避免误删外部已使用记录。 */
function remove(ids) {
  const data = db.get();
  const items = list();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const blocked = items.filter((item) => set.has(item.id)
    && (ACTIVE_STATUSES.has(item.status) || item.status === "used" || bindingCount(item) > 0));
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
  markPending,
  confirmUsed,
  confirmManualUsed,
  markFailed,
  release,
  flush,
  _db: db,
};
