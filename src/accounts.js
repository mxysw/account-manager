"use strict";

const path = require("path");
const { JsonDB } = require("./db");
const totp = require("./totp");
const { accurateNow } = require("./automation/time-sync");

const DATA_DIR = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR)
  : path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "accounts.json");
const db = new JsonDB(DB_FILE, { accounts: [] });

// 状态字段及其允许值，未检测一律 unknown。
const STATUS_FIELDS = {
  // 登录：ok=登录成功；2fa_error=2FA 密钥错误(需核对密钥)；need_verify=遇到验证页需人工；failed=登录失败/账号异常。
  login: ["unknown", "ok", "2fa_error", "need_verify", "failed"],
  gmail: ["unknown", "ok", "banned"],
  youtube: ["unknown", "ok", "banned"],
  // 服务使用限制（账号级处罚，只读检测 detect-restrict 写回）：
  //   unknown=未检测；ok=「查看服务使用限制」页无任何受限服务；
  //   restricted=有 Google 服务被限制/封禁（如「Google云端平台」整项服务完全无法使用、自某日起无法使用，需提交申诉）。
  restrict: ["unknown", "ok", "restricted"],
  // 支付资料：closed=已全部删除；open=仍有残留未清；locked=有订阅/服务占用，无法删除。
  payment: ["unknown", "closed", "open", "locked"],
  family: ["unknown", "on", "off"],
  gemini: ["unknown", "ok", "blocked"],
  // GPT：ok=能用 Google 一键授权并进入 ChatGPT；blocked=授权时弹「无法验证身份」(rejected)；
  //      banned=进得去但账号被停用/封禁；cf_blocked=卡在 Cloudflare 人机验证未能放行，需人工接管。
  gpt: ["unknown", "ok", "blocked", "banned", "cf_blocked"],
  claude: ["unknown", "ok", "blocked"],
  x: ["unknown", "ok", "blocked"],
  // 设备清理：cleaned=已退出其它设备只剩当前；rejected=Google 拒绝「确认是你本人」/仍有残留，需人工；
  //          seckey=遇到无法自动完成的验证（安全码/安全密钥/无法验证身份），已停止并跳过后续动作。
  device: ["unknown", "cleaned", "rejected", "seckey"],
  // 年龄验证：ok=能建 Gem(不需验证/已通过)；needs=建 Gem 失败需年龄验证；verified=信用卡验证已完成；failed=验证失败。
  age: ["unknown", "ok", "needs", "verified", "failed"],
  // 验证电话（remove-phones 写回）：unknown=未检测；removed=已移除2步验证电话/恢复电话；
  //   none=本来就没有验证/恢复电话；failed=移除失败/需人工。ok 预留兼容（可不用）。
  phone: ["unknown", "ok", "removed", "none", "failed"],
};

// 可直接行内编辑的普通字段。source=货源渠道/进货标签，跟备注一样允许手动改。
const EDITABLE = new Set([
  "email", "password", "totpSecret", "oldTotpSecret", "recoveryEmail",
  "year", "country", "language", "devices", "notes", "source",
]);

// 销售状态：in_stock 在库（可售）/ sold 已售（已出库交付）。
const SALE_STATUSES = ["in_stock", "sold"];

// 卖号分类「库」：unchecked 未检测（从没检测过）/ none 未分类（检测了但不达标）/ sell 出售 / nurture 养号 / scrap 废号。
const CATEGORIES = ["unchecked", "none", "sell", "nurture", "scrap"];

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function blankStatus() {
  const status = {};
  for (const key of Object.keys(STATUS_FIELDS)) status[key] = "unknown";
  return status;
}

/**
 * 解析一行账号，字段顺序不固定：
 * 自动识别 2FA 密钥（base32）、辅助邮箱（含 @）、年份、国家。
 * 支持分隔符 `----` 与 `|`。
 */
function parseLine(line) {
  const value = String(line || "").trim();
  if (!value) return null;
  const sep = value.includes("----") ? "----" : (value.includes("|") ? "|" : null);
  if (!sep) throw new Error(`无法识别的格式：${value}`);
  const parts = value.split(sep).map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`格式错误（至少需要 邮箱${sep}密码）：${value}`);
  }
  const out = { email: parts[0], password: parts[1], totpSecret: "", recoveryEmail: "", year: "", country: "", raw: value };
  for (let i = 2; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg || seg === "空" || seg === "?") continue;
    if (!out.totpSecret && totp.looksLikeSecret(seg) && !seg.includes("@")) {
      out.totpSecret = seg.replace(/[\s-]/g, "");
    } else if (!out.recoveryEmail && seg.includes("@")) {
      out.recoveryEmail = seg;
    } else if (!out.year && /^(19|20)\d{2}$/.test(seg)) {
      out.year = seg;
    } else if (!out.country && /^[A-Za-z]{2,}$/.test(seg) && seg.length <= 24) {
      out.country = seg;
    }
  }
  return out;
}

function createFrom(parsed) {
  return {
    id: genId(),
    email: parsed.email,
    password: parsed.password,
    totpSecret: parsed.totpSecret || "",
    // 2FA 更换记录（本工具 change-2fa 成功换绑时累计）：备份的旧密钥、累计更换次数、最近更换时间。
    oldTotpSecret: "",
    totpChangeCount: 0,
    totpChangedAt: "",
    recoveryEmail: parsed.recoveryEmail || "",
    year: parsed.year || "",
    country: parsed.country || "",
    language: "",
    devices: "",
    notes: "",
    // 货源渠道/进货标签：导入时可整批写入，之后也能在表格里行内编辑。默认空。
    source: "",
    tags: [],
    status: blankStatus(),
    // 分类「库」：默认未分类，需点「一键分类」按规则算出。
    category: "none",
    // 销售状态：默认在库（可售）；出库交付后置 sold 并记 soldAt，避免重复卖。
    saleStatus: "in_stock",
    soldAt: "",
    // 是否已进入「出售管理」页：检测系统里点「导入到出售管理」才置 true。
    // 出售管理视图只看 inSales===true 的号；检测系统仍是全量主库。
    inSales: false,
    // 是否已进入「养号管理」页：检测系统里点「导入到养号管理」才置 true（move 语义）。
    // 养号管理视图只看 inNurture===true 的号；检测系统账号库会排除 inNurture===true 的号（被搬走不再显示）。
    inNurture: false,
    // 是否已进入「废号管理」页：检测系统里点「导入到废号管理」才置 true（move 语义）。
    // 废号管理视图只看 inScrap===true 的号；检测系统账号库会排除 inScrap===true 的号（被搬走不再显示）。
    inScrap: false,
    // 是否已进入「登录失败管理」页：检测系统里点「导入到登录失败管理」才置 true（move 语义）。
    // 登录失败管理视图只看 inFailed===true 的号；检测系统账号库会排除 inFailed===true 的号（被搬走不再显示）。
    inFailed: false,
    // 是否已进入「待人工管理」页：检测系统里点「导入到待人工管理」才置 true（move 语义）。
    // 待人工管理视图只看 inNeedVerify===true 的号；检测系统账号库会排除 inNeedVerify===true 的号（被搬走不再显示）。
    inNeedVerify: false,
    // 是否已进入「密钥错误管理」页：检测系统里点「导入到密钥错误管理」才置 true（move 语义）。
    // 密钥错误管理视图只看 in2faError===true 的号；检测系统账号库会排除 in2faError===true 的号（被搬走不再显示）。
    in2faError: false,
    // cookie 轻量标记：检测任务登录成功后会把会话 cookie 存进独立的 cookies.json，
    // 这里只放标记（有没有存、何时存），避免把大块 cookie 塞进账号主表导致臃肿。
    hasCookie: false,
    cookieSavedAt: "",
    raw: parsed.raw,
    lastCheckedAt: "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

/**
 * 纯计算函数：根据账号当前 status 算出它应归入哪个「库」(category)。
 * 规则优先级从上到下，先命中先归类（与 STATUS_FIELDS / 各检测动作写回的真实枚举一致）：
 *
 *   1) scrap 废号：gmail/youtube/gpt 任意一个 === "banned"（被封）。
 *      —— 真实值来自 detect-ban.js（gmail/youtube 写 "banned"）、detect-gpt.js（gpt 写 "banned"）。
 *   2) sell 出售：login/gmail/youtube/gpt 全 === "ok" 且 device === "cleaned"。
 *      —— device "cleaned" 是 remove-devices.js 成功移除（只剩当前会话）时写回的真实值；
 *         gpt "ok" 是 detect-gpt.js「可一键授权并进入 ChatGPT」的真实值。
 *   3) nurture 养号：login/gmail/youtube 全 === "ok"，且 gpt 没被封（!== "banned"）。
 *      —— 用户口径：养号只要「能登录 + Gmail/YouTube 正常 + GPT 没被封」即可。
 *         GPT「拒绝登录/无法验证身份」（真实值 "blocked"/"rejected"，以及卡 CF 的 "cf_blocked"、未检测 "unknown"）
 *         都不算被封，应归养号——只有 gpt === "banned" 才是废号（已在第 1 步拦掉）。
 *         所以走到这一步 gpt 必然 != banned；不满足「出售」的全绿号一律算养号（养着等达标出售）。
 *   4) none 未分类：登录/Gmail/YouTube 没全绿（没登进去或没检测全），不硬塞。
 */
function computeCategory(account) {
  const s = (account && account.status) || {};
  const v = (k) => s[k] || "unknown";

  // 0) 未检测：所有检测状态都还是 unknown（从没跑过任何检测）。和「未分类」区分开——
  //    未分类 = 检测过但不满足出售/养号（如只登录了一半），未检测 = 压根没检测。
  if (Object.keys(STATUS_FIELDS).every((k) => v(k) === "unknown")) return "unchecked";

  // 1) 废号：任意核心产品被封。
  if (v("gmail") === "banned" || v("youtube") === "banned" || v("gpt") === "banned") return "scrap";

  // 公共前置：登录 + Gmail + YouTube 全绿（没登进去/没检测全的不往下归类）。
  const baseGreen = v("login") === "ok" && v("gmail") === "ok" && v("youtube") === "ok";

  // 2) 出售：全绿 + GPT 可一键授权 + 设备已成功清理。
  if (baseGreen && v("gpt") === "ok" && v("device") === "cleaned") return "sell";

  // 3) 养号：全绿即可（gpt 被封已在第 1 步排除，这里 gpt 必然没被封）。还没达到出售标准就先养着。
  if (baseGreen) return "nurture";

  // 4) 其余未分类。
  return "none";
}

/**
 * 一键分类：对全部账号（ids 为空）或指定账号，按 computeCategory 算出 category 写回。
 * 返回各「库」计数 + 总数。
 */
function classify(ids) {
  const data = db.get();
  const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const counts = { sell: 0, nurture: 0, scrap: 0, none: 0, unchecked: 0 };
  let changed = 0;
  for (const account of data.accounts) {
    if (set && !set.has(account.id)) continue;
    const cat = computeCategory(account);
    if (account.category !== cat) {
      account.category = cat;
      account.updatedAt = nowIso();
      changed += 1;
    }
    counts[cat] += 1;
  }
  db.save();
  return { counts, changed, total: data.accounts.length };
}

/**
 * 一键归位：把「当前还在检测系统账号库里」的号（未进任何 bucket、且未售）按状态自动搬进对应管理页，
 * 只把真正的「未分类/未检测」留在检测库。已在各管理页、已售的号一律不动（防止打乱用户手动归置）。
 *
 * scope = !inSales && !inNurture && !inScrap && !inFailed && !inNeedVerify && !in2faError && saleStatus!=="sold"。
 * 传了 ids（勾选）则再与 scope 取交集；ids 为空则对所有在检测库的号归位。
 *
 * 优先级（scope 内这些 flag 本来都为 false，命中即设一个唯一 flag）：
 *   1) banned（gmail/youtube/gpt 任一被封）→ inScrap（废号）—— banned 优先于 login 状态，保证封禁号一定进废号。
 *   2) login==="failed"      → inFailed（登录失败）
 *   3) login==="need_verify" → inNeedVerify（待人工）
 *   4) login==="2fa_error"   → in2faError（密钥错误）
 *   5) 全绿 + gpt==="ok" + device==="cleaned" → inSales（出售）
 *   6) 全绿（其余）→ inNurture（养号）
 *   7) 其它（未分类/未检测）→ 不设 flag，留在检测库。
 *
 * 不论是否搬动，都顺带用 computeCategory 同步 account.category；搬动或 category 变化都刷新 updatedAt。
 * 返回分布计数：{ moved: { scrap, failed, needVerify, tfaError, sales, nurture }, stayed, total }。
 */
function autoSort(ids) {
  const data = db.get();
  const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const moved = { scrap: 0, failed: 0, needVerify: 0, tfaError: 0, sales: 0, nurture: 0 };
  let stayed = 0;
  let total = 0;
  for (const account of data.accounts) {
    // 只处理「当前在检测库」的号：已在任何 bucket 或已售的一律跳过不动。
    if (account.inSales || account.inNurture || account.inScrap ||
        account.inFailed || account.inNeedVerify || account.in2faError) continue;
    if (account.saleStatus === "sold") continue;
    // 传了勾选 ids：只归位选中且仍在检测库的号。
    if (set && !set.has(account.id)) continue;

    total += 1;
    const s = account.status || {};
    const v = (k) => s[k] || "unknown";
    const banned = v("gmail") === "banned" || v("youtube") === "banned" || v("gpt") === "banned";
    const baseGreen = v("login") === "ok" && v("gmail") === "ok" && v("youtube") === "ok";

    let moveField = null;
    if (banned) {
      moveField = "inScrap"; moved.scrap += 1;
    } else if (v("login") === "failed") {
      moveField = "inFailed"; moved.failed += 1;
    } else if (v("login") === "need_verify") {
      moveField = "inNeedVerify"; moved.needVerify += 1;
    } else if (v("login") === "2fa_error") {
      moveField = "in2faError"; moved.tfaError += 1;
    } else if (baseGreen && v("gpt") === "ok" && v("device") === "cleaned") {
      moveField = "inSales"; moved.sales += 1;
    } else if (baseGreen) {
      moveField = "inNurture"; moved.nurture += 1;
    } else {
      stayed += 1;
    }

    let touched = false;
    if (moveField) {
      account[moveField] = true;
      touched = true;
    }
    // 同步派生的 category 标签，保持库一致。
    const cat = computeCategory(account);
    if (account.category !== cat) {
      account.category = cat;
      touched = true;
    }
    if (touched) account.updatedAt = nowIso();
  }
  db.save();
  return { moved, stayed, total };
}

/** 标记某账号「已存 cookie」（检测任务登录成功后由引擎调用，cookie 实体存在 cookies.json）。 */
function markCookie(id, savedAt) {
  const account = getById(id);
  if (!account) return null;
  account.hasCookie = true;
  account.cookieSavedAt = savedAt || nowIso();
  account.updatedAt = nowIso();
  db.save();
  return account;
}

function list() {
  return db.get().accounts;
}

function getById(id) {
  return db.get().accounts.find((a) => a.id === id) || null;
}

/**
 * 导入多行，按 email 去重；已存在的只补全空字段，不覆盖。
 * opts.source：本批货源渠道/标签——写到所有「新导入」账号上；
 *   对已存在的账号只在其 source 为空时补上（非破坏性），不覆盖已有货源。
 */
function importText(text, opts = {}) {
  const data = db.get();
  const source = String((opts && opts.source) || "").trim();
  const byEmail = new Map(data.accounts.map((a) => [a.email.toLowerCase(), a]));
  let added = 0;
  let merged = 0;
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
    const key = parsed.email.toLowerCase();
    const existing = byEmail.get(key);
    if (existing) {
      existing.password = existing.password || parsed.password;
      existing.totpSecret = existing.totpSecret || parsed.totpSecret;
      existing.recoveryEmail = existing.recoveryEmail || parsed.recoveryEmail;
      existing.year = existing.year || parsed.year;
      existing.country = existing.country || parsed.country;
      if (source && !existing.source) existing.source = source;
      existing.updatedAt = nowIso();
      merged += 1;
    } else {
      const account = createFrom(parsed);
      if (source) account.source = source;
      data.accounts.push(account);
      byEmail.set(key, account);
      added += 1;
    }
  }
  db.save();
  return { added, merged, total: data.accounts.length, errors };
}

function update(id, patch) {
  const account = getById(id);
  if (!account) return null;
  for (const [key, value] of Object.entries(patch || {})) {
    if (EDITABLE.has(key)) {
      account[key] = String(value == null ? "" : value);
    } else if (key === "totpChangeCount") {
      // 更换次数是整数（change-2fa 换绑成功时 +1 写回），非法值时保持原值不倒退。
      const n = Math.floor(Number(value));
      account.totpChangeCount = Number.isFinite(n) && n >= 0 ? n : (Number(account.totpChangeCount) || 0);
    } else if (key === "totpChangedAt") {
      account.totpChangedAt = String(value == null ? "" : value);
    } else if (key === "tags" && Array.isArray(value)) {
      account.tags = value.map((t) => String(t)).filter(Boolean);
    } else if (key === "status" && value && typeof value === "object") {
      for (const [sKey, sVal] of Object.entries(value)) {
        const allowed = STATUS_FIELDS[sKey];
        if (allowed && allowed.includes(sVal)) account.status[sKey] = sVal;
      }
      account.lastCheckedAt = nowIso();
    }
  }
  account.updatedAt = nowIso();
  db.save();
  return account;
}

/** 复原检测显示：把选中账号的所有检测状态重置为 unknown（未检测），并清掉 lastCheckedAt（不动邮箱/密码/2FA 等账号资料）。 */
function resetStatus(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let cleared = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    account.status = blankStatus();
    // category 是由检测状态算出来的派生值；全部复原为 unknown 后应回到「未检测」。
    account.category = "unchecked";
    account.lastCheckedAt = "";
    account.updatedAt = nowIso();
    cleared += 1;
  }
  db.save();
  return { cleared, total: data.accounts.length };
}

function remove(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => !set.has(a.id));
  db.save();
  return { removed: before - data.accounts.length, total: data.accounts.length };
}

/** 取某账号当前的 TOTP 验证码。 */
function currentTotp(id) {
  const account = getById(id);
  if (!account) return null;
  if (!account.totpSecret) return { error: "该账号没有 2FA 密钥" };
  try {
    // 用网络校准时间，避免本机时钟漂移导致「取码」算错（和登录自动化同一套时间）。
    return totp.generate(account.totpSecret, { now: accurateNow() });
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 老数据兜底：早期账号没有 source/saleStatus/soldAt/inSales 字段，
 * 首次加载时补上默认值（in_stock/空/false），避免前端渲染 undefined、也保证筛选/出库逻辑一致。
 * 一次性执行；有补全才落盘。
 */
function migrateSaleFields() {
  const data = db.get();
  let changed = false;
  for (const account of data.accounts) {
    if (account.source == null) { account.source = ""; changed = true; }
    if (account.saleStatus == null) { account.saleStatus = "in_stock"; changed = true; }
    if (account.soldAt == null) { account.soldAt = ""; changed = true; }
    if (account.inSales == null) {
      // 保留历史：以前卖过的号(saleStatus==="sold")自动进入出售管理页，其余默认不在。
      account.inSales = account.saleStatus === "sold";
      changed = true;
    }
    // 养号管理是新功能，老数据一律默认不在养号管理（仍留在检测系统账号库）。
    if (account.inNurture == null) { account.inNurture = false; changed = true; }
    // 废号管理是新功能，老数据一律默认不在废号管理（仍留在检测系统账号库）。
    if (account.inScrap == null) { account.inScrap = false; changed = true; }
    // 登录失败管理是新功能，老数据一律默认不在登录失败管理（仍留在检测系统账号库）。
    if (account.inFailed == null) { account.inFailed = false; changed = true; }
    // 待人工管理是新功能，老数据一律默认不在待人工管理（仍留在检测系统账号库）。
    if (account.inNeedVerify == null) { account.inNeedVerify = false; changed = true; }
    // 密钥错误管理是新功能，老数据一律默认不在密钥错误管理（仍留在检测系统账号库）。
    if (account.in2faError == null) { account.in2faError = false; changed = true; }
    // 2FA 更换记录是新功能，老数据补默认：无旧密钥、更换 0 次、无更换时间。
    if (account.oldTotpSecret == null) { account.oldTotpSecret = ""; changed = true; }
    if (account.totpChangeCount == null) { account.totpChangeCount = 0; changed = true; }
    if (account.totpChangedAt == null) { account.totpChangedAt = ""; changed = true; }
    // 状态字段兜底：老数据可能缺新增的检测字段（如 restrict 服务限制），逐个补默认 unknown，
    // 保证前端渲染 / computeCategory 遍历 STATUS_FIELDS 时不出现 undefined。
    if (!account.status || typeof account.status !== "object") { account.status = blankStatus(); changed = true; }
    for (const key of Object.keys(STATUS_FIELDS)) {
      if (account.status[key] == null) { account.status[key] = "unknown"; changed = true; }
    }
  }
  if (changed) db.save();
}
migrateSaleFields();

/** 批量标记「已售」：置 saleStatus=sold + 记 soldAt。已是 sold 的跳过（不刷新 soldAt），防重复卖与误改时间。 */
function markSold(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.saleStatus === "sold") continue;
    account.saleStatus = "sold";
    account.soldAt = nowIso();
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  return { changed, total: data.accounts.length };
}

/** 批量「退回在库」：撤销误标的已售，saleStatus 回 in_stock、清空 soldAt。 */
function markInStock(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.saleStatus === "in_stock") continue;
    account.saleStatus = "in_stock";
    account.soldAt = "";
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  return { changed, total: data.accounts.length };
}

/** 批量「导入到出售管理」：把选中账号置 inSales=true，使其出现在出售管理视图。已在出售管理的跳过。 */
function pushToSales(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inSales === true) continue;
    account.inSales = true;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inSales = data.accounts.filter((a) => a.inSales === true).length;
  return { changed, inSales, total: data.accounts.length };
}

/** 批量「移出出售管理」：把误推的号置 inSales=false（不影响检测状态/销售状态，只是不再出现在出售管理视图）。 */
function removeFromSales(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inSales !== true) continue;
    account.inSales = false;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inSales = data.accounts.filter((a) => a.inSales === true).length;
  return { changed, inSales, total: data.accounts.length };
}

/** 批量「导入到养号管理」：把选中账号置 inNurture=true，使其出现在养号管理视图、并从检测系统账号库搬走。已在养号管理的跳过。 */
function pushToNurture(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inNurture === true) continue;
    account.inNurture = true;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inNurture = data.accounts.filter((a) => a.inNurture === true).length;
  return { changed, inNurture, total: data.accounts.length };
}

/** 批量「移出养号管理」：把号置 inNurture=false（不影响检测状态/销售状态，移出后该号重新出现在检测系统账号库）。 */
function removeFromNurture(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inNurture !== true) continue;
    account.inNurture = false;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inNurture = data.accounts.filter((a) => a.inNurture === true).length;
  return { changed, inNurture, total: data.accounts.length };
}

/** 批量「导入到废号管理」：把选中账号置 inScrap=true，使其出现在废号管理视图、并从检测系统账号库搬走。已在废号管理的跳过。 */
function pushToScrap(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inScrap === true) continue;
    account.inScrap = true;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inScrap = data.accounts.filter((a) => a.inScrap === true).length;
  return { changed, inScrap, total: data.accounts.length };
}

/** 批量「移出废号管理」：把号置 inScrap=false（不影响检测状态/销售状态，移出后该号重新出现在检测系统账号库）。 */
function removeFromScrap(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inScrap !== true) continue;
    account.inScrap = false;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inScrap = data.accounts.filter((a) => a.inScrap === true).length;
  return { changed, inScrap, total: data.accounts.length };
}

/** 批量「导入到登录失败管理」：把选中账号置 inFailed=true，使其出现在登录失败管理视图、并从检测系统账号库搬走。已在登录失败管理的跳过。 */
function pushToFailed(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inFailed === true) continue;
    account.inFailed = true;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inFailed = data.accounts.filter((a) => a.inFailed === true).length;
  return { changed, inFailed, total: data.accounts.length };
}

/** 批量「移出登录失败管理」：把号置 inFailed=false（不影响检测状态/销售状态，移出后该号重新出现在检测系统账号库）。 */
function removeFromFailed(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inFailed !== true) continue;
    account.inFailed = false;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inFailed = data.accounts.filter((a) => a.inFailed === true).length;
  return { changed, inFailed, total: data.accounts.length };
}

/** 批量「导入到待人工管理」：把选中账号置 inNeedVerify=true，使其出现在待人工管理视图、并从检测系统账号库搬走。已在待人工管理的跳过。 */
function pushToNeedVerify(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inNeedVerify === true) continue;
    account.inNeedVerify = true;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inNeedVerify = data.accounts.filter((a) => a.inNeedVerify === true).length;
  return { changed, inNeedVerify, total: data.accounts.length };
}

/** 批量「移出待人工管理」：把号置 inNeedVerify=false（不影响检测状态/销售状态，移出后该号重新出现在检测系统账号库）。 */
function removeFromNeedVerify(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.inNeedVerify !== true) continue;
    account.inNeedVerify = false;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const inNeedVerify = data.accounts.filter((a) => a.inNeedVerify === true).length;
  return { changed, inNeedVerify, total: data.accounts.length };
}

/** 批量「导入到密钥错误管理」：把选中账号置 in2faError=true，使其出现在密钥错误管理视图、并从检测系统账号库搬走。已在密钥错误管理的跳过。 */
function pushTo2faError(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.in2faError === true) continue;
    account.in2faError = true;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const in2faError = data.accounts.filter((a) => a.in2faError === true).length;
  return { changed, in2faError, total: data.accounts.length };
}

/** 批量「移出密钥错误管理」：把号置 in2faError=false（不影响检测状态/销售状态，移出后该号重新出现在检测系统账号库）。 */
function removeFrom2faError(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const account of data.accounts) {
    if (!set.has(account.id)) continue;
    if (account.in2faError !== true) continue;
    account.in2faError = false;
    account.updatedAt = nowIso();
    changed += 1;
  }
  db.save();
  const in2faError = data.accounts.filter((a) => a.in2faError === true).length;
  return { changed, in2faError, total: data.accounts.length };
}

module.exports = {
  STATUS_FIELDS,
  CATEGORIES,
  SALE_STATUSES,
  parseLine,
  list,
  getById,
  importText,
  update,
  resetStatus,
  remove,
  currentTotp,
  computeCategory,
  classify,
  autoSort,
  markCookie,
  markSold,
  markInStock,
  pushToSales,
  removeFromSales,
  pushToNurture,
  removeFromNurture,
  pushToScrap,
  removeFromScrap,
  pushToFailed,
  removeFromFailed,
  pushToNeedVerify,
  removeFromNeedVerify,
  pushTo2faError,
  removeFrom2faError,
  flush: () => db.flushSync(),
  _db: db,
};
