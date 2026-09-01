"use strict";

const el = (id) => document.getElementById(id);

const STATUS_KEYS = ["login", "gmail", "youtube", "payment", "family", "gemini", "gpt", "device", "age", "restrict", "phone"];
const STATUS_TEXT = {
  unknown: "未检测", ok: "正常", banned: "封禁", closed: "已关", open: "开启",
  on: "已开", off: "未开", blocked: "被拦", cleaned: "已清", rejected: "拒验·人工",
  seckey: "需安全码·人工",
  needs: "待验证", verified: "已验证", failed: "失败",
  pending: "待生效/验证",
  "2fa_error": "2FA密钥错", need_verify: "待人工",
  locked: "有订阅·难关",
  cf_blocked: "CF验证·人工",
  restricted: "服务受限",
  removed: "已移除", none: "无",
};
const LOGIN_REASON_TEXT = {
  ok: "正常",
  password_correct: "密码正确",
  password_wrong: "密码错误",
  password_changed: "密码已更改",
  credentials_missing: "账号资料缺失",
  totp_missing: "缺少2FA密钥",
  totp_invalid: "2FA密钥错误",
  totp_flow_error: "2FA验证异常",
  captcha: "人机验证",
  device_prompt: "设备通知验证",
  sms_verification: "短信验证",
  security_code: "安全代码验证",
  no_supported_2fa: "无身份验证器",
  risk_verification: "风控/人工验证",
  browser_blocked: "浏览器被拦",
  browser_start_failed: "浏览器启动失败",
  account_disabled: "账号停用/封禁",
  account_not_found: "账号不存在",
  unknown_challenge: "未知验证页",
  timeout: "登录超时",
  other: "其他登录错误",
};
// 独立密码检测不能复用“登录超时/其他登录错误”等完整登录措辞；它只回答密码是否被接受。
const PASSWORD_CHECK_REASON_TEXT = {
  password_correct: "密码正确",
  password_wrong: "密码错误",
  password_changed: "密码已更改",
  credentials_missing: "账号或密码缺失",
  captcha: "人机验证",
  risk_verification: "风控·无法确认密码",
  browser_blocked: "浏览器被拦·无法确认",
  browser_start_failed: "浏览器启动失败",
  account_disabled: "账号停用/封禁",
  account_not_found: "账号不存在",
  timeout: "密码检测超时",
  other: "无法确认密码",
};

function diagnosticDetailText(check) {
  if (!check || !check.detail) return "";
  if (typeof check.detail === "string") return check.detail;
  if (typeof check.detail === "object") return Object.values(check.detail).filter(Boolean).join(" ");
  return String(check.detail);
}

function passwordChangedDaysAgo(check) {
  if (check && check.daysAgo != null) {
    const explicit = Math.floor(Number(check.daysAgo));
    if (Number.isFinite(explicit) && explicit >= 0 && explicit <= 36500) return explicit;
  }
  const detail = diagnosticDetailText(check);
  const match = detail.match(/(\d+)\s*天前/) || detail.match(/changed\s+(\d+)\s+days?\s+ago/i);
  const extracted = Math.floor(Number(match && match[1]));
  return Number.isFinite(extracted) && extracted >= 0 && extracted <= 36500 ? extracted : null;
}

function resultReasonText(check, dictionary, fallback) {
  if (!check || typeof check !== "object") return "";
  const base = dictionary[check.reasonCode] || fallback(check);
  const daysAgo = check.reasonCode === "password_changed" ? passwordChangedDaysAgo(check) : null;
  return daysAgo == null ? base : `${base}（${daysAgo}天前）`;
}

function loginCheckResultText(check) {
  return resultReasonText(check, LOGIN_REASON_TEXT, (item) => (
    item.outcome === "ok" ? "正常" : (item.outcome === "need_verify" ? "待人工验证" : "登录失败")
  ));
}

function passwordCheckResultText(check) {
  if (!check || typeof check !== "object") return "";
  return resultReasonText(check, PASSWORD_CHECK_REASON_TEXT, (item) => (
    item.outcome === "ok" ? "密码正确" : (item.outcome === "need_verify" ? "无法确认密码" : "密码异常")
  ));
}
const STATUS_OPTIONS = {
  login: ["unknown", "ok", "2fa_error", "need_verify", "failed"],
  gmail: ["unknown", "ok", "banned"],
  youtube: ["unknown", "ok", "banned"],
  payment: ["unknown", "closed", "open", "locked"],
  family: ["unknown", "on", "off"],
  gemini: ["unknown", "ok", "blocked"],
  gpt: ["unknown", "ok", "blocked", "banned", "cf_blocked"],
  claude: ["unknown", "ok", "blocked"],
  x: ["unknown", "ok", "blocked"],
  device: ["unknown", "cleaned", "rejected", "seckey"],
  age: ["unknown", "ok", "needs", "verified", "failed"],
  restrict: ["unknown", "ok", "restricted"],
  phone: ["unknown", "ok", "pending", "removed", "none", "failed"],
};
const STATUS_CLASS = {
  unknown: "s-unknown", ok: "s-ok", open: "s-ok", on: "s-ok", cleaned: "s-ok", verified: "s-ok",
  banned: "s-bad", blocked: "s-bad", rejected: "s-bad", closed: "s-mute", off: "s-mute",
  needs: "s-bad", failed: "s-bad", "2fa_error": "s-bad", need_verify: "s-bad", locked: "s-mute",
  cf_blocked: "s-mute", seckey: "s-bad", restricted: "s-bad", pending: "s-bad",
  removed: "s-ok", none: "s-unknown",
};
const LS = {
  apiKey: "am_apiKey", envs: "am_envs", max: "am_max", proxy: "am_proxy",
  accounts: "am_sel_accounts", actions: "am_sel_actions", flags: "am_flags",
  mode: "am_mode", job: "am_jobId", filterSale: "am_filter_sale",
  // 养号管理视图的销售状态筛选，刷新后保持（与出售管理 filterSale 各自独立）。
  filterNurtureSale: "am_filter_nurture_sale",
  // 顶部 dock 当前视图：detect 检测系统 / nurture 养号管理 / scrap 废号管理 / sales 出售管理。刷新后停留在同一视图。
  view: "am_view",
  // 运行日志「只看异常」筛选开关，刷新后保持。
  jobOnlyAbnormal: "am_job_only_abnormal",
  // “添加两步验证手机号”本次从共享池还是一号一绑池领取，刷新后保持。
  phoneMode: "am_phone_mode",
};

// 批量操作里勾选的「动作」按视图各记一套（检测系统/养号管理/出售管理互不同步）：
// key 形如 am_sel_actions_detect/nurture/sales。某视图首次进入、还没单独存过时，
// 继承旧的全局勾选(LS.actions)，之后该视图改动只存到自己的 key，三视图各自独立。
let currentView = localStorage.getItem(LS.view) || "detect";
const actionsKeyFor = (v) => `am_sel_actions_${v}`;
function loadActionsSet(v) {
  const key = actionsKeyFor(v);
  if (localStorage.getItem(key) != null) return loadSet(key);
  return loadSet(LS.actions);
}
// 把当前视图保存的动作勾选回填到（已渲染的）动作复选框上，不重新拉取列表。
function applyActionChecks() {
  const set = loadActionsSet(currentView);
  document.querySelectorAll('#actionList input[type="checkbox"]').forEach((c) => { c.checked = set.has(c.value); });
}

// 分类「库」：unchecked 未检测 / none 未分类 / sell 出售 / nurture 养号 / scrap 废号。
const CATEGORY_TEXT = { unchecked: "未检测", none: "未分类", sell: "出售", nurture: "养号", scrap: "废号" };
const CATEGORY_CLASS = { unchecked: "cat-unchecked", none: "cat-none", sell: "cat-sell", nurture: "cat-nurture", scrap: "cat-scrap" };
const catOf = (a) => (a && a.category) || "none";

// 销售状态：in_stock 在库(可售) / sold 已售。老数据没有该字段时兜底为 in_stock。
const SALE_TEXT = { in_stock: "在库", sold: "已售" };
const saleOf = (a) => (a && a.saleStatus) || "in_stock";
const sourceOf = (a) => (a && a.source) || "";
// 是否已进入「出售管理」页。老数据缺该字段时安全默认 false（不出现在出售管理视图）。
const inSalesOf = (a) => !!(a && a.inSales === true);
// 是否已进入「养号管理」页（move 语义）。检测系统里点「导入到养号管理」才置 true；
// 养号管理视图只看 inNurture===true 的号，检测系统账号库会排除这些号。老数据缺该字段时安全默认 false。
const inNurtureOf = (a) => !!(a && a.inNurture === true);
// 是否已进入「废号管理」页（move 语义）。检测系统里点「导入到废号管理」才置 true；
// 废号管理视图只看 inScrap===true 的号，检测系统账号库会排除这些号。老数据缺该字段时安全默认 false。
const inScrapOf = (a) => !!(a && a.inScrap === true);
// 是否已进入「登录失败管理」页（move 语义）。检测系统里点「导入到登录失败管理」才置 true；
// 登录失败管理视图只看 inFailed===true 的号，检测系统账号库会排除这些号。老数据缺该字段时安全默认 false。
const inFailedOf = (a) => !!(a && a.inFailed === true);
// 是否已进入「待人工管理」页（move 语义）。检测系统里点「导入到待人工管理」才置 true；
// 待人工管理视图只看 inNeedVerify===true 的号，检测系统账号库会排除这些号。老数据缺该字段时安全默认 false。
const inNeedVerifyOf = (a) => !!(a && a.inNeedVerify === true);
// 是否已进入「密钥错误管理」页（move 语义）。检测系统里点「导入到密钥错误管理」才置 true；
// 密钥错误管理视图只看 in2faError===true 的号，检测系统账号库会排除这些号。老数据缺该字段时安全默认 false。
const in2faErrorOf = (a) => !!(a && a.in2faError === true);

function saveSet(key, set) { try { localStorage.setItem(key, JSON.stringify([...set])); } catch (_) { /* ignore */ } }
function loadSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch (_) { return new Set(); } }

let accounts = [];
let selected = loadSet(LS.accounts);
let jobId = null;
let jobPolling = false;
let jobStarting = false;
let appReady = false;

function syncRunButton() {
  el("runBtn").disabled = !appReady || jobStarting || !!jobId || jobPolling;
}
// 运行日志：最近一次渲染过的 job（用于筛选开关切换时本地重渲染，无需等下一轮轮询）。
let lastJob = null;
// 运行日志：用户手动展开/折叠过的账号 email -> 是否展开。重渲染时尊重它，
// 没有记录的账号则按「是否需人工」决定默认折叠态（需人工默认展开，正常默认折叠）。
const jobManualExpand = new Map();
function loadJobOnlyAbnormal() { try { return localStorage.getItem(LS.jobOnlyAbnormal) === "1"; } catch (_) { return false; } }
function saveJobOnlyAbnormal(v) { try { localStorage.setItem(LS.jobOnlyAbnormal, v ? "1" : "0"); } catch (_) { /* ignore */ } }

const escapeHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function maskSecret(v) {
  const s = String(v || "");
  if (!s) return "";
  return s.length <= 4 ? "••" : `${s.slice(0, 2)}••••${s.slice(-2)}`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

const hasPasswordCheckIssue = (a) => !!(a && a.lastPasswordCheck && a.lastPasswordCheck.outcome !== "ok");
const isAbnormal = (a) => hasPasswordCheckIssue(a) || a.status.gmail === "banned" || a.status.youtube === "banned" || a.status.gpt === "banned"
  || a.status.gpt === "cf_blocked" || a.status.restrict === "restricted"
  || a.status.login === "2fa_error" || a.status.login === "failed" || a.status.login === "need_verify"
  || STATUS_KEYS.some((k) => a.status[k] === "blocked" || a.status[k] === "rejected" || a.status[k] === "seckey" || a.status[k] === "pending");
const isUnchecked = (a) => !a.lastPasswordCheck && STATUS_KEYS.every((k) => (a.status[k] || "unknown") === "unknown");

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function loadAccounts() {
  const data = await api("/api/accounts");
  accounts = data.accounts || [];
  render();
}

// 用户是否正在某个视图的账号表格里编辑（只认可编辑单元格 / 状态下拉）。
// 行内“检测”等按钮被点击后也会保留焦点，但按钮焦点不属于编辑；若把它算进去，
// 任务轮询的每次账号刷新都会被跳过，恰好造成“单独检测后结果不显示”。
function isEditingAccounts() {
  const active = document.activeElement;
  if (!active || !active.matches('.ec[contenteditable="true"], select.st')) return false;
  return ["rows", "salesRows", "nurtureRows", "scrapRows", "failedRows", "needVerifyRows", "tfaErrorRows", "soldRows"].some((id) => {
    const tb = el(id);
    return tb && tb.contains(active);
  });
}

// 取当前可见视图的表格滚动容器（隐藏视图的 tbody offsetParent 为 null），用于软刷新时保住横/纵向滚动。
function visibleTableWrap() {
  for (const id of ["rows", "salesRows", "nurtureRows", "scrapRows", "failedRows", "needVerifyRows", "tfaErrorRows", "soldRows"]) {
    const tb = el(id);
    if (tb && tb.offsetParent !== null) return tb.closest(".table-wrap");
  }
  return el("rows").closest(".table-wrap");
}

// 轮询期间的“软刷新”：拉取最新账号数据并重渲染，但保住用户当前的
// 勾选（selected 为模块级集合，render 会按它回填）、筛选（render 读取输入框）
// 与滚动位置（纵向在 window、横向在 .table-wrap）。正在编辑时直接跳过。
async function refreshAccountsSoft() {
  if (isEditingAccounts()) return;
  const wrap = visibleTableWrap();
  const winY = window.scrollY, winX = window.scrollX;
  const wrapLeft = wrap ? wrap.scrollLeft : 0, wrapTop = wrap ? wrap.scrollTop : 0;
  try {
    const data = await api("/api/accounts");
    accounts = data.accounts || [];
    render();
  } catch (_) { return; } // 轮询期间偶发失败忽略，下一轮再试
  if (wrap) { wrap.scrollLeft = wrapLeft; wrap.scrollTop = wrapTop; }
  window.scrollTo(winX, winY);
}

// 检测系统视图：主库（不按销售状态/inSales 过滤），但排除已「导入到养号管理」(inNurture===true)
// 与已「导入到废号管理」(inScrap===true) 的号——养号/废号管理都是 move 语义，搬走的号不再显示在
// 检测系统账号库（移出养号/废号管理后会重新出现）。
// 另外排除已售号(saleOf==="sold")：用户直接在检测系统点「出库」后，已售号不再留在检测库，
// 集中显示到全局「已售记录」视图；退回在库后若不属于任何 bucket 会重新出现在这里。
function filtered() {
  const q = el("search").value.trim().toLowerCase();
  const f = el("filterStatus").value;
  const cat = el("filterCategory") ? el("filterCategory").value : "";
  return accounts.filter((a) => {
    if (inNurtureOf(a)) return false;
    if (inScrapOf(a)) return false;
    if (inFailedOf(a)) return false;
    if (inNeedVerifyOf(a)) return false;
    if (in2faErrorOf(a)) return false;
    if (saleOf(a) === "sold") return false;
    if (f === "abnormal" && !isAbnormal(a)) return false;
    if (f === "unchecked" && !isUnchecked(a)) return false;
    if (cat && catOf(a) !== cat) return false;
    if (!q) return true;
    // 搜索把货源渠道也纳入，方便按进货来源找号。
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 出售管理视图：只看已「导入到出售管理」(inSales===true) 的号，再按销售状态/搜索筛。
function filteredSales() {
  const q = el("salesSearch") ? el("salesSearch").value.trim().toLowerCase() : "";
  const sale = el("filterSale") ? el("filterSale").value : "";
  return accounts.filter((a) => {
    if (!inSalesOf(a)) return false;
    // 销售状态筛选：默认只看在库，避免已售号混进可售视图被重复卖。
    if (sale && saleOf(a) !== sale) return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 养号管理视图：只看已「导入到养号管理」(inNurture===true) 的号（move 语义，不再按 category 过滤），再按销售状态/搜索筛。
function filteredNurture() {
  const q = el("nurtureSearch") ? el("nurtureSearch").value.trim().toLowerCase() : "";
  const sale = el("filterNurtureSale") ? el("filterNurtureSale").value : "";
  return accounts.filter((a) => {
    if (!inNurtureOf(a)) return false;
    // 销售状态筛选：默认只看在库，避免已售号混进可售视图被重复卖。
    if (sale && saleOf(a) !== sale) return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 废号管理视图：只看已「导入到废号管理」(inScrap===true) 的号（move 语义），再按搜索筛（邮箱/国家/备注/货源）。
function filteredScrap() {
  const q = el("scrapSearch") ? el("scrapSearch").value.trim().toLowerCase() : "";
  return accounts.filter((a) => {
    if (!inScrapOf(a)) return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 登录失败管理视图：只看已「导入到登录失败管理」(inFailed===true) 的号（move 语义），再按搜索筛（邮箱/国家/备注/货源）。
function filteredFailed() {
  const q = el("failedSearch") ? el("failedSearch").value.trim().toLowerCase() : "";
  return accounts.filter((a) => {
    if (!inFailedOf(a)) return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 待人工管理视图：只看已「导入到待人工管理」(inNeedVerify===true) 的号（move 语义），再按搜索筛（邮箱/国家/备注/货源）。
function filteredNeedVerify() {
  const q = el("needVerifySearch") ? el("needVerifySearch").value.trim().toLowerCase() : "";
  return accounts.filter((a) => {
    if (!inNeedVerifyOf(a)) return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 密钥错误管理视图：只看已「导入到密钥错误管理」(in2faError===true) 的号（move 语义），再按搜索筛（邮箱/国家/备注/货源）。
function filtered2faError() {
  const q = el("tfaErrorSearch") ? el("tfaErrorSearch").value.trim().toLowerCase() : "";
  return accounts.filter((a) => {
    if (!in2faErrorOf(a)) return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 已售记录视图：全局销售状态视图——按 saleOf==="sold" 过滤所有已售号，不限 bucket
// （inSales/inNurture/inScrap/inFailed 或都没有），再按搜索筛（邮箱/国家/备注/货源）。
// 这是固定筛选页，不引入新字段/新端点，只复用现有 saleStatus/soldAt 与 mark-instock。
function filteredSold() {
  const q = el("soldSearch") ? el("soldSearch").value.trim().toLowerCase() : "";
  return accounts.filter((a) => {
    if (saleOf(a) !== "sold") return false;
    if (!q) return true;
    return [a.email, a.country, a.notes, a.language, sourceOf(a)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// 分类单元格：只显示库标签。
function categoryCell(a) {
  const cat = catOf(a);
  return `<span class="cat ${CATEGORY_CLASS[cat] || "cat-none"}">${CATEGORY_TEXT[cat] || cat}</span>`;
}

// 销售单元格：在库/已售标签；已售再附上交付时间，便于核对。
function saleCell(a) {
  const sale = saleOf(a);
  const tag = `<span class="sale sale-${sale}">${SALE_TEXT[sale] || sale}</span>`;
  if (sale === "sold" && a.soldAt) return `${tag}<div class="muted sold-at">${escapeHtml(fmtTime(a.soldAt))}</div>`;
  return tag;
}

// “仅验证账号密码”的结果放在密码旁边展示，不占用新的表格列，也不冒充完整登录状态。
function passwordCheckBadge(a) {
  const check = a && a.lastPasswordCheck;
  if (!check || typeof check !== "object") return "";
  const text = passwordCheckResultText(check);
  const cls = check.outcome === "ok" ? "ok" : (check.outcome === "need_verify" ? "warn" : "bad");
  const detail = check.detail ? `；${check.detail}` : "";
  const checkedAt = check.checkedAt ? `；${fmtTime(check.checkedAt)}` : "";
  return `<span class="password-check ${cls}" title="${escapeHtml(`${text}${detail}${checkedAt}`)}">${escapeHtml(text)}</span>`;
}

// 状态列对应的检测项名称，用于下拉的悬停提示（滚动时即使表头看不见也能分清是哪项）。
const STATUS_FIELD_LABEL = {
  login: "登录", gmail: "Gmail", youtube: "YouTube", payment: "支付", family: "家庭组",
  gemini: "Gemini", gpt: "GPT", device: "设备清理", age: "年龄验证", restrict: "服务限制", phone: "两步验证手机号",
};

function statusCell(a, key) {
  const val = a.status[key] || "unknown";
  const loginCheck = key === "login" && a.lastLoginCheck && typeof a.lastLoginCheck === "object"
    ? a.lastLoginCheck : null;
  const reasonText = loginCheck ? loginCheckResultText(loginCheck) : "";
  const legacyText = key === "login" && val === "failed" && !loginCheck ? "失败·需重测" : "";
  const opts = STATUS_OPTIONS[key].map((o) => {
    const text = o === val && (reasonText || legacyText) ? (reasonText || legacyText) : (STATUS_TEXT[o] || o);
    return `<option value="${o}"${o === val ? " selected" : ""}>${escapeHtml(text)}</option>`;
  }).join("");
  const label = STATUS_FIELD_LABEL[key] || key;
  const detail = loginCheck && loginCheck.detail ? `；${loginCheck.detail}` : "";
  const title = `${label}（${reasonText || legacyText || STATUS_TEXT[val] || val}）${detail}`;
  return `<select class="st ${STATUS_CLASS[val] || ""}" data-id="${a.id}" data-status="${key}" title="${escapeHtml(title)}">${opts}</select>`;
}

function editCell(a, field, value, opts = {}) {
  const cls = opts.mono ? "ec mono" : "ec";
  const display = opts.mask ? maskSecret(value) : escapeHtml(value);
  const title = opts.mask ? ` title="${escapeHtml(value)}"` : "";
  return `<span class="${cls}" contenteditable="true" data-id="${a.id}" data-field="${field}"${title}>${display}</span>`;
}

function twoStepPhoneBadgeText(phone) {
  if (phone.origin === "added") return "新增";
  if (phone.origin === "preexisting") return "已有";
  if (phone.origin === "manual") return "确认";
  return "绑定";
}

// 列表只拿脱敏号码；完整号码不进入表格 DOM，点击时才按账号与绑定 id 向后端取回并复制。
function twoStepPhonesHtml(a) {
  const items = Array.isArray(a.twoStepPhones) ? a.twoStepPhones : [];
  if (!items.length) return "";
  const rows = items.map((phone) => {
    const stateBits = [twoStepPhoneBadgeText(phone)];
    if (phone.verification === "not_requested") stateBits.push("免验");
    if (phone.verification === "sms_completed") stateBits.push("已验");
    if (phone.activation === "deferred") stateBits.push("待生效");
    return `<div class="acc-phone-row">
      <button class="acc-phone-number row-copyphone" data-id="${escapeHtml(a.id)}" data-phone-id="${escapeHtml(phone.phoneId)}" title="点击复制完整手机号">${escapeHtml(phone.maskedNumber || `••••${phone.last4 || ""}`)}</button>
      <span class="acc-phone-state phone-origin-${escapeHtml(phone.origin || "unknown")}" title="${escapeHtml(stateBits.join(" / "))}">${escapeHtml(stateBits.join(" · "))}</span>
    </div>`;
  }).join("");
  return rows;
}

function twoStepPhoneCellHtml(a) {
  const phonesHtml = twoStepPhonesHtml(a);
  return `<td class="two-step-phone-cell">
    ${phonesHtml || '<span class="muted">—</span>'}
    <div class="two-step-phone-status">${statusCell(a, "phone")}</div>
  </td>`;
}

// 公共「完整列」行模板：检测系统 / 出售管理 / 养号管理三个视图共用同一份模板渲染每一行，
// 保证三张表列完全一致，且行内交互（取码 / 状态下拉 / 行内编辑 / 复制 / 删除 / 勾选）都在三视图生效。
// i 为各视图各自的序号（从 0 起），故行号按各自筛选结果计。
function accountRowHtml(a, i) {
  const rowClass = saleOf(a) === "sold" ? ' class="row-sold"' : (isAbnormal(a) ? ' class="row-bad"' : "");
  return `
    <tr data-id="${a.id}"${rowClass}>
      <td class="col-check"><input type="checkbox" data-id="${a.id}"${selected.has(a.id) ? " checked" : ""} /></td>
      <td class="muted">${i + 1}</td>
      <td class="acc-cell">
        <div class="acc-actions">
          <button class="primary slim row-run" data-id="${a.id}" title="用当前批量操作面板的配置，仅对该账号执行">检测</button>
          <button class="ghost slim row-copy" data-id="${a.id}" title="复制该账号（异常账号末尾会追加具体原因，例如：----人机验证）">复制</button>
          <button class="ghost slim row-sell" data-id="${a.id}" title="导出该账号交付文本并标记为「已售」（已售号不可重复出库）">出库</button>
        </div>
        <div class="acc-email" data-id="${a.id}" title="双击复制邮箱">${escapeHtml(a.email)}</div>
        <div class="acc-pass">${editCell(a, "password", a.password, { mono: true })}<button class="ghost slim row-copypass" data-id="${a.id}" title="复制该账号密码">复制密码</button>${passwordCheckBadge(a)}</div>
      </td>
      ${twoStepPhoneCellHtml(a)}
      <td class="cat-cell">${categoryCell(a)}</td>
      <td>${editCell(a, "source", sourceOf(a))}</td>
      <td class="sale-cell">${saleCell(a)}</td>
      <td class="totp-cell${a.status.login === "2fa_error" ? " totp-bad" : ""}">${a.totpSecret
        ? `<button class="ghost slim totp-btn" data-id="${a.id}">取码</button><span class="totp-out" data-id="${a.id}"></span><span class="totp-secret" data-id="${a.id}" title="双击复制完整2FA密钥">${maskSecret(a.totpSecret)}</span>${a.status.login === "2fa_error" ? '<span class="totp-err" title="2FA 密钥错误，Google 拒绝该验证码，请核对密钥">⚠ 密钥错误</span>' : ""}${Number(a.totpChangeCount) > 0 ? `<span class="totp-changed" title="最近更换：${escapeHtml(fmtTime(a.totpChangedAt) || "—")}；旧密钥：${escapeHtml(a.oldTotpSecret ? maskSecret(a.oldTotpSecret) : "无")}">已换 ${Number(a.totpChangeCount)} 次</span>` : ""}`
        : '<span class="muted">无</span>'}</td>
      <td>${statusCell(a, "login")}</td>
      <td>${editCell(a, "country", a.country)}</td>
      <td>${editCell(a, "language", a.language)}</td>
      <td>${statusCell(a, "gmail")}</td>
      <td>${statusCell(a, "youtube")}</td>
      <td>${statusCell(a, "payment")}</td>
      <td>${statusCell(a, "family")}</td>
      <td>${statusCell(a, "gemini")}</td>
      <td>${statusCell(a, "gpt")}</td>
      <td>${editCell(a, "devices", a.devices)}</td>
      <td>${statusCell(a, "device")}</td>
      <td>${statusCell(a, "age")}</td>
      <td>${statusCell(a, "restrict")}</td>
      <td>${editCell(a, "notes", a.notes)}</td>
      <td class="muted nowrap">${escapeHtml(fmtTime(a.updatedAt))}</td>
      <td class="nowrap">
        <button class="ghost danger slim row-del" data-id="${a.id}">删</button>
      </td>
    </tr>`;
}

function render() {
  const rows = filtered();
  el("rows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  el("emptyHint").style.display = accounts.length ? "none" : "block";
  el("rowBadge").textContent = `${rows.length} 行`;
  el("statTotal").textContent = accounts.length;
  el("statBanned").textContent = accounts.filter(isAbnormal).length;
  el("statSelected").textContent = selected.size;
  el("selectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
  updateCategoryCounts();
  // 多视图同库：每次渲染顺带刷新出售管理表、养号管理表、废号管理表、登录失败表与已售记录表，保证实时轮询下各视图都按各自口径显示。
  renderSales();
  renderNurture();
  renderScrap();
  renderFailed();
  renderNeedVerify();
  render2faError();
  renderSold();
}

// 出售管理表格渲染：只列 inSales 号，用与检测系统完全相同的「完整列」行模板（accountRowHtml），
// 这样出售页也能看到全部检测状态并直接行内操作（取码/状态/编辑/复制/删除）。
function renderSales() {
  if (!el("salesRows")) return;
  const rows = filteredSales();
  el("salesRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const inSalesAll = accounts.filter(inSalesOf);
  el("salesEmptyHint").style.display = inSalesAll.length ? "none" : "block";
  el("salesRowBadge").textContent = `${rows.length} 行`;
  // 可售/已售统计：只统计出售管理里的号（inSales），与出售页口径一致。
  const inStock = inSalesAll.filter((a) => saleOf(a) === "in_stock").length;
  const sold = inSalesAll.length - inStock;
  if (el("saleBadge")) el("saleBadge").textContent = `可售 ${inStock} / 已售 ${sold}`;
  el("salesSelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 养号管理表格渲染：只列已导入养号管理(inNurture===true)的号，用与检测系统完全相同的「完整列」行模板，
// 养号页同样能看到全部检测状态并直接行内操作。
function renderNurture() {
  if (!el("nurtureRows")) return;
  const rows = filteredNurture();
  el("nurtureRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const nurtureAll = accounts.filter(inNurtureOf);
  el("nurtureEmptyHint").style.display = nurtureAll.length ? "none" : "block";
  el("nurtureRowBadge").textContent = `${rows.length} 行`;
  // 可售/已售统计：只统计养号管理里的号（inNurture），与养号页一致。
  const inStock = nurtureAll.filter((a) => saleOf(a) === "in_stock").length;
  const sold = nurtureAll.length - inStock;
  if (el("nurtureBadge")) el("nurtureBadge").textContent = `可售 ${inStock} / 已售 ${sold}`;
  el("nurtureSelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 废号管理表格渲染：只列已导入废号管理(inScrap===true)的号，用与检测系统完全相同的「完整列」行模板，
// 废号页同样能看到全部检测状态并直接行内操作。
function renderScrap() {
  if (!el("scrapRows")) return;
  const rows = filteredScrap();
  el("scrapRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const scrapAll = accounts.filter(inScrapOf);
  el("scrapEmptyHint").style.display = scrapAll.length ? "none" : "block";
  el("scrapRowBadge").textContent = `${rows.length} 行`;
  el("scrapSelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 登录失败管理表格渲染：只列已导入登录失败管理(inFailed===true)的号，用与检测系统完全相同的「完整列」行模板，
// 登录失败页同样能看到全部检测状态并直接行内操作。
function renderFailed() {
  if (!el("failedRows")) return;
  const rows = filteredFailed();
  el("failedRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const failedAll = accounts.filter(inFailedOf);
  el("failedEmptyHint").style.display = failedAll.length ? "none" : "block";
  el("failedRowBadge").textContent = `${rows.length} 行`;
  el("failedSelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 待人工管理表格渲染：只列已导入待人工管理(inNeedVerify===true)的号，用与检测系统完全相同的「完整列」行模板，
// 待人工页同样能看到全部检测状态并直接行内操作。
function renderNeedVerify() {
  if (!el("needVerifyRows")) return;
  const rows = filteredNeedVerify();
  el("needVerifyRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const needVerifyAll = accounts.filter(inNeedVerifyOf);
  el("needVerifyEmptyHint").style.display = needVerifyAll.length ? "none" : "block";
  el("needVerifyRowBadge").textContent = `${rows.length} 行`;
  el("needVerifySelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 密钥错误管理表格渲染：只列已导入密钥错误管理(in2faError===true)的号，用与检测系统完全相同的「完整列」行模板，
// 密钥错误页同样能看到全部检测状态并直接行内操作。
function render2faError() {
  if (!el("tfaErrorRows")) return;
  const rows = filtered2faError();
  el("tfaErrorRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const tfaErrorAll = accounts.filter(in2faErrorOf);
  el("tfaErrorEmptyHint").style.display = tfaErrorAll.length ? "none" : "block";
  el("tfaErrorRowBadge").textContent = `${rows.length} 行`;
  el("tfaErrorSelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 已售记录表格渲染：全局列出所有已售号(saleOf==="sold")，用与检测系统完全相同的「完整列」行模板，
// 已售时间在「销售」列由 saleCell 显示。badge 显示「已售 N」总数（全局口径，不限 bucket）。
function renderSold() {
  if (!el("soldRows")) return;
  const rows = filteredSold();
  el("soldRows").innerHTML = rows.map((a, i) => accountRowHtml(a, i)).join("");

  const soldAll = accounts.filter((a) => saleOf(a) === "sold");
  el("soldEmptyHint").style.display = soldAll.length ? "none" : "block";
  el("soldRowBadge").textContent = `${rows.length} 行`;
  if (el("soldBadge")) el("soldBadge").textContent = `已售 ${soldAll.length}`;
  el("soldSelectAll").checked = rows.length > 0 && rows.every((a) => selected.has(a.id));
}

// 在「库/分类」筛选下拉里实时显示每类数量。
// 与检测系统列表口径一致：已「导入到养号管理」(inNurture)/「废号管理」(inScrap)/「登录失败管理」(inFailed) 的号已被搬走，
// 已售号(saleOf==="sold")也已移到「已售记录」页，均不计入这里。
function updateCategoryCounts() {
  const sel = el("filterCategory");
  if (!sel) return;
  const pool = accounts.filter((a) => !inNurtureOf(a) && !inScrapOf(a) && !inFailedOf(a) && !inNeedVerifyOf(a) && !in2faErrorOf(a) && saleOf(a) !== "sold");
  const counts = { unchecked: 0, none: 0, sell: 0, nurture: 0, scrap: 0 };
  pool.forEach((a) => { counts[catOf(a)] = (counts[catOf(a)] || 0) + 1; });
  const label = { "": `全部库（${pool.length}）`, sell: `出售（${counts.sell}）`, nurture: `养号（${counts.nurture}）`, scrap: `废号（${counts.scrap}）`, none: `未分类（${counts.none}）`, unchecked: `未检测（${counts.unchecked}）` };
  [...sel.options].forEach((o) => { if (label[o.value] != null) o.textContent = label[o.value]; });
}

async function patch(id, body) {
  try {
    const data = await api(`/api/accounts/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx >= 0 && data.account) accounts[idx] = data.account;
  } catch (err) {
    el("importStatus").textContent = `保存失败：${err.message}`;
  }
}

// ---- 导入 ----
el("importBtn").addEventListener("click", async () => {
  const text = el("importText").value;
  if (!text.trim()) { el("importStatus").textContent = "请粘贴账号"; return; }
  const source = el("importSource") ? el("importSource").value.trim() : "";
  el("importBtn").disabled = true;
  try {
    const data = await api("/api/accounts/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, source }),
    });
    accounts = data.accounts || [];
    el("importText").value = "";
    el("importStatus").textContent = `新增 ${data.added}，合并 ${data.merged}，共 ${data.total}`
      + (source ? `，货源「${source}」` : "")
      + (data.errors && data.errors.length ? `，${data.errors.length} 行无法识别` : "");
    render();
  } catch (err) {
    el("importStatus").textContent = err.message;
  } finally {
    el("importBtn").disabled = false;
  }
});

// ---- 折叠面板 ----
document.querySelectorAll("[data-toggle]").forEach((btn) => {
  const box = el(btn.dataset.toggle);
  if (!box) return;
  const storageKey = `am_panel_${btn.dataset.toggle}`;

  function applyPanelState(open) {
    box.style.display = open ? "" : "none";
    btn.textContent = open ? "收起" : "展开";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // 以 HTML 初始状态为默认值，并记住用户之后的展开/收起选择。
  let saved = null;
  try { saved = localStorage.getItem(storageKey); } catch (_) { /* ignore */ }
  const defaultOpen = box.style.display !== "none";
  applyPanelState(saved == null ? defaultOpen : saved === "open");

  btn.addEventListener("click", () => {
    const open = box.style.display === "none";
    applyPanelState(open);
    try { localStorage.setItem(storageKey, open ? "open" : "closed"); } catch (_) { /* ignore */ }
  });
});

// ---- 表格交互 ----
// 三个视图（检测系统 #rows / 出售管理 #salesRows / 养号管理 #nurtureRows）共用同一份完整列行模板，
// 行内交互也共用同一套事件委托处理器，统一绑到三个 tbody 上，保证取码 / 状态下拉 / 行内编辑 /
// 复制 / 删除 / 勾选在三视图都生效。处理器只认 e.target / dataset.id（账号在 accounts 里全局查找），
// 与所在 tbody 无关，故可直接复用。
function onRowChange(e) {
  const t = e.target;
  if (t.matches('input[type="checkbox"]')) {
    const id = t.dataset.id;
    if (t.checked) selected.add(id); else selected.delete(id);
    saveSet(LS.accounts, selected);
    render();
  } else if (t.matches("select.st")) {
    const id = t.dataset.id;
    const key = t.dataset.status;
    t.className = `st ${STATUS_CLASS[t.value] || ""}`;
    const body = key === "login"
      ? { status: { [key]: t.value }, lastLoginCheck: null }
      : { status: { [key]: t.value } };
    patch(id, body);
    const acc = accounts.find((a) => a.id === id);
    if (acc) {
      acc.status[key] = t.value;
      if (key === "login") acc.lastLoginCheck = null;
    }
  }
}

function onRowBlur(e) {
  const t = e.target;
  if (!t.matches(".ec")) return;
  const { id, field } = t.dataset;
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  const value = t.textContent.trim();
  if (field === "password" || field === "totpSecret") {
    if (value === maskSecret(acc[field]) || value === acc[field]) return;
  }
  if (acc[field] === value) return;
  const body = field === "password" ? { [field]: value, lastPasswordCheck: null } : { [field]: value };
  acc[field] = value;
  if (field === "password") {
    // 后端会清空两类旧凭据结论；前端同步清并立即重绘，避免保存成功后仍暂时显示旧“密码错误/登录失败”。
    acc.lastPasswordCheck = null;
    acc.lastLoginCheck = null;
    if (acc.status) acc.status.login = "unknown";
    render();
    patch(id, body).then(() => render());
    return;
  }
  patch(id, body);
}

function onRowKeydown(e) {
  if (e.target.matches(".ec") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
}

// 复制 / 导出共用的异常原因。按字段写清具体问题，避免只给一个笼统提示；
// unknown、已关闭支付资料、未开家庭组等中性/正常状态不会被误标。
const EXPORT_STATUS_WARNING_TEXT = {
  login: { failed: "登录失败", "2fa_error": "2FA密钥错误", need_verify: "待人工验证" },
  gmail: { banned: "Gmail封禁" },
  youtube: { banned: "YouTube封禁" },
  restrict: { restricted: "服务受限" },
  payment: { locked: "支付资料有订阅" },
  gemini: { blocked: "Gemini被拦截" },
  gpt: { blocked: "GPT授权被拦截", banned: "GPT封禁", cf_blocked: "GPT人机验证" },
  claude: { blocked: "Claude被拦截" },
  x: { blocked: "X被拦截" },
  device: { rejected: "设备验证被拒", seckey: "需要安全代码" },
  age: { needs: "待年龄验证", failed: "年龄验证失败" },
  phone: { pending: "手机号待生效/人工确认", failed: "验证电话操作失败" },
};

function exportWarningText(a) {
  const status = (a && a.status) || {};
  const issues = [];

  // 独立密码检测也使用精确原因；密码正确(outcome=ok)不是异常，不追加任何后缀。
  const passwordCheck = a && a.lastPasswordCheck;
  const passwordReasonCode = passwordCheck && passwordCheck.reasonCode;
  const precisePasswordIssue = passwordReasonCode && passwordReasonCode !== "password_correct" && passwordCheck.outcome !== "ok"
    ? passwordCheckResultText(passwordCheck) : "";
  if (precisePasswordIssue) issues.push(precisePasswordIssue);

  // 登录动作已经保存了精确原因时优先使用，例如 captcha → 人机验证；
  // 这样不会再把它降级成笼统的“待人工验证”。
  const loginCheck = a && a.lastLoginCheck;
  const reasonCode = loginCheck && loginCheck.reasonCode;
  const preciseLoginIssue = reasonCode && reasonCode !== "ok" && loginCheck.outcome !== "ok" ? loginCheckResultText(loginCheck) : "";
  if (preciseLoginIssue) issues.push(preciseLoginIssue);

  Object.entries(EXPORT_STATUS_WARNING_TEXT).forEach(([field, values]) => {
    if (field === "login" && preciseLoginIssue) return;
    const text = values[status[field]];
    if (text) issues.push(text);
  });

  return [...new Set(issues)].join("、");
}

function hasExportWarning(a) {
  return !!exportWarningText(a);
}

// 单账号导出格式：邮箱----密码----辅助邮箱/空----2FA密钥----年份----国家
// 异常账号追加具体原因，例如：----人机验证
function fmtAccount(a) {
  const base = [a.email || "", a.password || "", a.recoveryEmail || "空", a.totpSecret || "", a.year || "", a.country || ""].join("----");
  const warning = exportWarningText(a);
  return warning ? `${base}----${warning}` : base;
}

let toastTimer = null;
function toast(msg) {
  let box = document.getElementById("toast");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast";
    box.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%) translateY(-20px);"
      + "background:#1f9d55;color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;"
      + "box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:99999;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;";
    document.body.appendChild(box);
  }
  box.textContent = `✓ ${msg}`;
  box.style.opacity = "1";
  box.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.style.opacity = "0";
    box.style.transform = "translateX(-50%) translateY(-20px)";
  }, 1400);
}

function flashCopied(elm) {
  try { window.getSelection().removeAllRanges(); } catch (_) {}
  const old = elm.style.backgroundColor;
  elm.style.backgroundColor = "rgba(40,180,90,.35)";
  setTimeout(() => { elm.style.backgroundColor = old; }, 700);
}

function copyValue(elm, value, label) {
  if (!value) return;
  navigator.clipboard.writeText(value).then(
    () => { flashCopied(elm); toast(`${label || "内容"}已复制`); },
    () => window.prompt("复制以下内容：", value),
  );
}

// 双击邮箱 → 只复制邮箱；双击 2FA → 只复制完整 2FA 密钥。
function onRowDblclick(e) {
  const emailEl = e.target.closest(".acc-email");
  if (emailEl) {
    const acc = accounts.find((a) => a.id === emailEl.dataset.id);
    if (acc) copyValue(emailEl, acc.email, "邮箱");
    return;
  }
  const totpEl = e.target.closest(".totp-secret");
  if (totpEl) {
    const acc = accounts.find((a) => a.id === totpEl.dataset.id);
    if (acc) copyValue(totpEl, acc.totpSecret, "2FA 密钥");
  }
}

async function onRowClick(e) {
  // 单行「检测/单独运行」：用批量操作面板当前配置只对该账号发起任务（复用 startJob 的校验与发起逻辑）。
  const runBtn = e.target.closest(".row-run");
  if (runBtn) {
    // 释放按钮焦点，让轮询软刷新可以在首轮就重绘这一行。
    runBtn.blur();
    startJob([runBtn.dataset.id]);
    return;
  }
  const copyPhoneBtn = e.target.closest(".row-copyphone");
  if (copyPhoneBtn) {
    try {
      const accountId = encodeURIComponent(copyPhoneBtn.dataset.id || "");
      const phoneId = encodeURIComponent(copyPhoneBtn.dataset.phoneId || "");
      const data = await api(`/api/accounts/${accountId}/two-step-phones/${phoneId}`);
      copyValue(copyPhoneBtn, data.number, "两步验证手机号");
    } catch (err) {
      toast(`复制手机号失败：${err.message}`);
    }
    return;
  }
  // 单行「复制密码」：只复制该账号密码。
  const copyPassBtn = e.target.closest(".row-copypass");
  if (copyPassBtn) {
    const acc = accounts.find((a) => a.id === copyPassBtn.dataset.id);
    if (!acc) return;
    const pwd = acc.password || "";
    const done = () => {
      const old = copyPassBtn.textContent;
      copyPassBtn.textContent = "已复制";
      setTimeout(() => { copyPassBtn.textContent = old; }, 1000);
      toast("密码已复制");
    };
    navigator.clipboard.writeText(pwd).then(done, () => window.prompt("复制密码：", pwd));
    return;
  }
  const copyBtn = e.target.closest(".row-copy");
  if (copyBtn) {
    const id = copyBtn.dataset.id;
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return;
    const text = fmtAccount(acc);
    const done = () => {
      const old = copyBtn.textContent;
      copyBtn.textContent = "已复制";
      setTimeout(() => { copyBtn.textContent = old; }, 1000);
      toast("账号已复制");
    };
    navigator.clipboard.writeText(text).then(done, () => window.prompt("复制以下内容：", text));
    return;
  }
  // 单行「出库」：导出该账号交付文本并标记为已售（复用 fmtAccount + mark-sold，与批量出库口径一致）。
  const sellBtn = e.target.closest(".row-sell");
  if (sellBtn) {
    const id = sellBtn.dataset.id;
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return;
    if (saleOf(acc) === "sold") { toast("该账号已是「已售」，不能重复出库"); return; }
    if (!confirm(`确认出库账号 ${acc.email}？\n将先复制交付文本（邮箱----密码----辅助----2FA----年份----国家），再标记为「已售」。`)) return;
    const text = fmtAccount(acc);
    const markSold = async () => {
      try {
        const data = await api("/api/accounts/mark-sold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) });
        accounts = data.accounts || [];
        render();
        toast(`已出库 ${acc.email}（已复制交付文本）`);
      } catch (err) {
        toast(`标记已售失败：${err.message}`);
      }
    };
    navigator.clipboard.writeText(text).then(markSold, () => { window.prompt("复制以下交付内容：", text); markSold(); });
    return;
  }
  const delBtn = e.target.closest(".row-del");
  if (delBtn) {
    const id = delBtn.dataset.id;
    const acc = accounts.find((a) => a.id === id);
    if (!confirm(`删除账号 ${acc ? acc.email : ""}？`)) return;
    await api("/api/accounts/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) }).catch(() => {});
    selected.delete(id);
    saveSet(LS.accounts, selected);
    await loadAccounts();
    return;
  }
  const totpBtn = e.target.closest(".totp-btn");
  if (totpBtn) {
    const id = totpBtn.dataset.id;
    // 同一账号可能同时出现在多个视图（如 inSales 号在检测系统与出售管理都显示），
    // 故取码输出框只在「被点击的这一行」里找，避免命中别的视图（含隐藏视图）的同名节点。
    const row = totpBtn.closest("tr");
    const out = (row || document).querySelector(`.totp-out[data-id="${id}"]`);
    if (!out) return;
    out.textContent = "…";
    try {
      const r = await api(`/api/accounts/${id}/totp`);
      out.textContent = `${r.code} (${r.secondsRemaining}s)`;
      out.classList.add("flash");
      navigator.clipboard.writeText(r.code).catch(() => {});
      setTimeout(() => out.classList.remove("flash"), 600);
    } catch (err) {
      out.textContent = err.message;
    }
  }
}

// 把同一套行内交互绑到三个视图的 tbody 上（检测系统 / 出售管理 / 养号管理）。
// blur 需捕获阶段（contenteditable 失焦不冒泡），与原检测系统行为一致。
["rows", "salesRows", "nurtureRows", "scrapRows", "failedRows", "needVerifyRows", "tfaErrorRows", "soldRows"].forEach((tid) => {
  const tb = el(tid);
  if (!tb) return;
  tb.addEventListener("change", onRowChange);
  tb.addEventListener("blur", onRowBlur, true);
  tb.addEventListener("keydown", onRowKeydown);
  tb.addEventListener("dblclick", onRowDblclick);
  tb.addEventListener("click", onRowClick);
});

el("deleteBtn").addEventListener("click", async () => {
  if (!selected.size) { el("importStatus").textContent = "先勾选要删除的账号"; return; }
  if (!confirm(`确认删除选中的 ${selected.size} 个账号？`)) return;
  await api("/api/accounts/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...selected] }) }).catch(() => {});
  selected = new Set();
  saveSet(LS.accounts, selected);
  await loadAccounts();
});

// 复原检测：把选中（或全部）账号的检测状态全部复原成「未检测」，只动状态显示，不动账号资料。
el("resetDetectBtn").addEventListener("click", async () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id)) : filtered();
  if (!rows.length) { el("importStatus").textContent = "没有可复原的账号"; return; }
  const scope = selected.size ? `选中的 ${rows.length} 个账号` : `当前列表的全部 ${rows.length} 个账号`;
  if (!confirm(`确认把${scope}的检测状态复原成「未检测」？\n（只复原检测显示，邮箱/密码/2FA 等账号资料不受影响）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    await api("/api/accounts/reset-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    await loadAccounts();
    el("importStatus").textContent = `已复原 ${ids.length} 个账号的检测显示`;
    toast(`已复原 ${ids.length} 个账号的检测显示`);
  } catch (err) {
    el("importStatus").textContent = `复原失败：${err.message}`;
    toast(`复原失败：${err.message}`);
  }
});

el("exportBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id)) : filtered();
  if (!rows.length) { el("importStatus").textContent = "没有可导出的账号"; return; }
  // 格式：邮箱----密码----辅助邮箱/空----2FA密钥----年份----国家
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => {
      el("importStatus").textContent = `已复制 ${rows.length} 个账号（邮箱----密码----辅助----2FA----年份----国家）`;
      toast(`已复制 ${rows.length} 个账号`);
    },
    () => window.prompt("复制以下内容：", text),
  );
});

// 出库：对选中的在库账号「导出并标记已售」。先复制交付文本（复用 fmtAccount 同一套格式），
// 再调 mark-sold 置 sold + soldAt。已售号会从在库视图消失，防重复卖。
el("sellExportBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id));
  if (!rows.length) { el("importStatus").textContent = "先勾选要出库的账号"; toast("先勾选要出库的账号"); return; }
  // 防重复卖：已售的号不能再次出库，提示用户先退回在库或取消勾选。
  const alreadySold = rows.filter((a) => saleOf(a) === "sold");
  if (alreadySold.length) {
    el("importStatus").textContent = `选中里有 ${alreadySold.length} 个已是「已售」，请取消勾选后再出库`;
    toast(`有 ${alreadySold.length} 个已售号，不能重复出库`);
    return;
  }
  if (!confirm(`确认出库选中的 ${rows.length} 个账号？\n将先复制交付文本（邮箱----密码----辅助----2FA----年份----国家），再标记为「已售」。`)) return;
  const ids = rows.map((a) => a.id);
  const text = rows.map(fmtAccount).join("\n");
  const markSold = async () => {
    try {
      const data = await api("/api/accounts/mark-sold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      accounts = data.accounts || [];
      selected.clear();
      saveSet(LS.accounts, selected);
      render();
      el("importStatus").textContent = `已出库 ${data.changed} 个并复制交付文本`;
      toast(`已出库 ${data.changed} 个（已复制 ${rows.length} 个交付文本）`);
    } catch (err) {
      el("importStatus").textContent = `标记已售失败：${err.message}`;
      toast(`标记已售失败：${err.message}`);
    }
  };
  // 先复制再标记：复制失败也给手动兜底，但仍继续标记（用户已确认出库）。
  navigator.clipboard.writeText(text).then(markSold, () => { window.prompt("复制以下交付内容：", text); markSold(); });
});

// 退回在库：撤销误标的已售（多在「已售」视图里操作）。
el("restockBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && saleOf(a) === "sold");
  if (!rows.length) { el("importStatus").textContent = "先勾选要退回在库的已售账号"; toast("先勾选已售账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个已售账号退回在库？\n销售状态会回到「在库」、清空已售时间。`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/mark-instock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已退回在库 ${data.changed} 个`;
    toast(`已退回在库 ${data.changed} 个`);
  } catch (err) {
    el("importStatus").textContent = `退回失败：${err.message}`;
    toast(`退回失败：${err.message}`);
  }
});

// ---- 导入到出售管理（检测系统视图）----
// 有勾选：对勾选的号再按「出售」分类(category==="sell")过滤，只导入匹配的，不匹配的跳过。
// 无勾选：默认取所有「出售」分类的号。置 inSales=true 推送到出售管理页。
el("pushToSalesBtn").addEventListener("click", async () => {
  const picked = accounts.filter((a) => selected.has(a.id));
  const bySell = !picked.length;
  // 勾选模式也只导入出售分类的号，避免把非出售号一并搬进出售管理。
  let rows = (bySell ? accounts : picked).filter((a) => catOf(a) === "sell");
  if (!rows.length) {
    // 区分两种空：完全没勾选/没出售分类，或勾选了但里头一个出售分类都没有。
    if (!bySell) {
      el("importStatus").textContent = `选中的 ${picked.length} 个账号里没有「出售」分类的号，未导入`;
      toast("选中里没有出售分类的号，未导入");
    } else {
      el("importStatus").textContent = "没有可导入的账号：先勾选账号，或先「一键分类」产出「出售」分类的号";
      toast("没有可导入的账号");
    }
    return;
  }
  // 已在出售管理里的号会被后端跳过，这里据此给用户真实预期。
  const fresh = rows.filter((a) => !inSalesOf(a)).length;
  const skippedNotSell = bySell ? 0 : picked.length - rows.length;
  const scope = bySell
    ? `全部「出售」分类的 ${rows.length} 个号`
    : `选中 ${picked.length} 个，其中 ${rows.length} 个为出售分类`;
  const extra = skippedNotSell ? `；另有 ${skippedNotSell} 个非出售分类已过滤` : "";
  if (!confirm(`确认把${scope}导入到出售管理？\n（其中 ${fresh} 个为新导入，已在出售管理的会跳过${extra}）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    // 推送后清空勾选：这批号已进出售管理，避免勾选残留被带去别处误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已导入 ${data.changed} 个到出售管理（出售管理共 ${data.inSales} 个）`
      + (skippedNotSell ? `，跳过 ${skippedNotSell} 个非出售分类` : "");
    toast(`已导入 ${data.changed} 个到出售管理`);
  } catch (err) {
    el("importStatus").textContent = `导入到出售管理失败：${err.message}`;
    toast(`导入失败：${err.message}`);
  }
});

// ---- 导入到养号管理（检测系统视图）----
// 有勾选：对勾选的号再按「养号」分类(category==="nurture")过滤，只导入匹配的，不匹配的跳过。
// 无勾选：默认取所有「养号」分类的号。置 inNurture=true 推送到养号管理页（move 语义：从检测系统账号库搬走）。
el("pushToNurtureBtn").addEventListener("click", async () => {
  const picked = accounts.filter((a) => selected.has(a.id));
  const byNurture = !picked.length;
  // 勾选模式也只导入养号分类的号，避免把非养号号一并搬进养号管理。
  let rows = (byNurture ? accounts : picked).filter((a) => catOf(a) === "nurture");
  if (!rows.length) {
    // 区分两种空：完全没勾选/没养号分类，或勾选了但里头一个养号分类都没有。
    if (!byNurture) {
      el("importStatus").textContent = `选中的 ${picked.length} 个账号里没有「养号」分类的号，未导入`;
      toast("选中里没有养号分类的号，未导入");
    } else {
      el("importStatus").textContent = "没有可导入的账号：先勾选账号，或先「一键分类」产出「养号」分类的号";
      toast("没有可导入的账号");
    }
    return;
  }
  // 已在养号管理里的号会被后端跳过，这里据此给用户真实预期。
  const fresh = rows.filter((a) => !inNurtureOf(a)).length;
  const skippedNotNurture = byNurture ? 0 : picked.length - rows.length;
  const scope = byNurture
    ? `全部「养号」分类的 ${rows.length} 个号`
    : `选中 ${picked.length} 个，其中 ${rows.length} 个为养号分类`;
  const extra = skippedNotNurture ? `；另有 ${skippedNotNurture} 个非养号分类已过滤` : "";
  if (!confirm(`确认把${scope}导入到养号管理？\n（其中 ${fresh} 个为新导入，已在养号管理的会跳过${extra}；导入后这些号将从检测系统账号库搬走）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-nurture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    // 推送后清空勾选：这批号已进养号管理，避免勾选残留被带去别处误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已导入 ${data.changed} 个到养号管理（养号管理共 ${data.inNurture} 个）`
      + (skippedNotNurture ? `，跳过 ${skippedNotNurture} 个非养号分类` : "");
    toast(`已导入 ${data.changed} 个到养号管理`);
  } catch (err) {
    el("importStatus").textContent = `导入到养号管理失败：${err.message}`;
    toast(`导入失败：${err.message}`);
  }
});

// ---- 导入到废号管理（检测系统视图）----
// 有勾选：对勾选的号再按「废号」分类(category==="scrap")过滤，只导入匹配的，不匹配的跳过。
// 无勾选：默认取所有「废号」分类的号。置 inScrap=true 推送到废号管理页（move 语义：从检测系统账号库搬走）。
el("pushToScrapBtn").addEventListener("click", async () => {
  const picked = accounts.filter((a) => selected.has(a.id));
  const byScrap = !picked.length;
  // 勾选模式也只导入废号分类的号，避免把非废号号一并搬进废号管理。
  let rows = (byScrap ? accounts : picked).filter((a) => catOf(a) === "scrap");
  if (!rows.length) {
    // 区分两种空：完全没勾选/没废号分类，或勾选了但里头一个废号分类都没有。
    if (!byScrap) {
      el("importStatus").textContent = `选中的 ${picked.length} 个账号里没有「废号」分类的号，未导入`;
      toast("选中里没有废号分类的号，未导入");
    } else {
      el("importStatus").textContent = "没有可导入的账号：先勾选账号，或先「一键分类」产出「废号」分类的号";
      toast("没有可导入的账号");
    }
    return;
  }
  // 已在废号管理里的号会被后端跳过，这里据此给用户真实预期。
  const fresh = rows.filter((a) => !inScrapOf(a)).length;
  const skippedNotScrap = byScrap ? 0 : picked.length - rows.length;
  const scope = byScrap
    ? `全部「废号」分类的 ${rows.length} 个号`
    : `选中 ${picked.length} 个，其中 ${rows.length} 个为废号分类`;
  const extra = skippedNotScrap ? `；另有 ${skippedNotScrap} 个非废号分类已过滤` : "";
  if (!confirm(`确认把${scope}导入到废号管理？\n（其中 ${fresh} 个为新导入，已在废号管理的会跳过${extra}；导入后这些号将从检测系统账号库搬走）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-scrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    // 推送后清空勾选：这批号已进废号管理，避免勾选残留被带去别处误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已导入 ${data.changed} 个到废号管理（废号管理共 ${data.inScrap} 个）`
      + (skippedNotScrap ? `，跳过 ${skippedNotScrap} 个非废号分类` : "");
    toast(`已导入 ${data.changed} 个到废号管理`);
  } catch (err) {
    el("importStatus").textContent = `导入到废号管理失败：${err.message}`;
    toast(`导入失败：${err.message}`);
  }
});

// ---- 导入到登录失败管理（检测系统视图）----
// 与废号导入按分类不同：登录失败管理按「登录状态」过滤——只搬登录下拉显示「失败」的号(a.status.login === "failed")。
// 有勾选：对勾选的号再按 login==="failed" 过滤，只导入匹配的，非登录失败的跳过。
// 无勾选：默认取所有 login==="failed" 的号。置 inFailed=true 推送到登录失败管理页（move 语义：从检测系统账号库搬走）。
const isLoginFailed = (a) => a && a.status && a.status.login === "failed";
el("pushToFailedBtn").addEventListener("click", async () => {
  const picked = accounts.filter((a) => selected.has(a.id));
  const byFailed = !picked.length;
  // 勾选模式也只导入登录失败的号，避免把非登录失败的号一并搬进登录失败管理。
  let rows = (byFailed ? accounts : picked).filter(isLoginFailed);
  if (!rows.length) {
    // 区分两种空：完全没勾选/没登录失败的号，或勾选了但里头一个登录失败的都没有。
    if (!byFailed) {
      el("importStatus").textContent = `选中的 ${picked.length} 个账号里没有「登录失败」的号，未导入`;
      toast("选中里没有登录失败的号，未导入");
    } else {
      el("importStatus").textContent = "没有可导入的账号：先勾选账号，或先检测产出登录「失败」的号";
      toast("没有可导入的账号");
    }
    return;
  }
  // 已在登录失败管理里的号会被后端跳过，这里据此给用户真实预期。
  const fresh = rows.filter((a) => !inFailedOf(a)).length;
  const skippedNotFailed = byFailed ? 0 : picked.length - rows.length;
  const scope = byFailed
    ? `全部「登录失败」的 ${rows.length} 个号`
    : `选中 ${picked.length} 个，其中 ${rows.length} 个为登录失败`;
  const extra = skippedNotFailed ? `；另有 ${skippedNotFailed} 个非登录失败已过滤` : "";
  if (!confirm(`确认把${scope}导入到登录失败管理？\n（其中 ${fresh} 个为新导入，已在登录失败管理的会跳过${extra}；导入后这些号将从检测系统账号库搬走）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-failed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    // 推送后清空勾选：这批号已进登录失败管理，避免勾选残留被带去别处误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已导入 ${data.changed} 个到登录失败管理（登录失败管理共 ${data.inFailed} 个）`
      + (skippedNotFailed ? `，跳过 ${skippedNotFailed} 个非登录失败` : "");
    toast(`已导入 ${data.changed} 个到登录失败管理`);
  } catch (err) {
    el("importStatus").textContent = `导入到登录失败管理失败：${err.message}`;
    toast(`导入失败：${err.message}`);
  }
});

// ---- 导入到待人工管理（检测系统视图）----
// 按「登录状态」过滤——只搬登录下拉显示「待人工」的号(a.status.login === "need_verify")。
// 有勾选：对勾选的号再按 login==="need_verify" 过滤，只导入匹配的，非待人工的跳过。
// 无勾选：默认取所有 login==="need_verify" 的号。置 inNeedVerify=true 推送到待人工管理页（move 语义：从检测系统账号库搬走）。
const isLoginNeedVerify = (a) => a && a.status && a.status.login === "need_verify";
el("pushToNeedVerifyBtn").addEventListener("click", async () => {
  const picked = accounts.filter((a) => selected.has(a.id));
  const byNeedVerify = !picked.length;
  // 勾选模式也只导入待人工的号，避免把非待人工的号一并搬进待人工管理。
  let rows = (byNeedVerify ? accounts : picked).filter(isLoginNeedVerify);
  if (!rows.length) {
    // 区分两种空：完全没勾选/没待人工的号，或勾选了但里头一个待人工的都没有。
    if (!byNeedVerify) {
      el("importStatus").textContent = `选中的 ${picked.length} 个账号里没有「待人工」的号，未导入`;
      toast("选中里没有待人工的号，未导入");
    } else {
      el("importStatus").textContent = "没有可导入的账号：先勾选账号，或先检测产出登录「待人工」的号";
      toast("没有可导入的账号");
    }
    return;
  }
  // 已在待人工管理里的号会被后端跳过，这里据此给用户真实预期。
  const fresh = rows.filter((a) => !inNeedVerifyOf(a)).length;
  const skippedNotNeedVerify = byNeedVerify ? 0 : picked.length - rows.length;
  const scope = byNeedVerify
    ? `全部「待人工」的 ${rows.length} 个号`
    : `选中 ${picked.length} 个，其中 ${rows.length} 个为待人工`;
  const extra = skippedNotNeedVerify ? `；另有 ${skippedNotNeedVerify} 个非待人工已过滤` : "";
  if (!confirm(`确认把${scope}导入到待人工管理？\n（其中 ${fresh} 个为新导入，已在待人工管理的会跳过${extra}；导入后这些号将从检测系统账号库搬走）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-needverify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    // 推送后清空勾选：这批号已进待人工管理，避免勾选残留被带去别处误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已导入 ${data.changed} 个到待人工管理（待人工管理共 ${data.inNeedVerify} 个）`
      + (skippedNotNeedVerify ? `，跳过 ${skippedNotNeedVerify} 个非待人工` : "");
    toast(`已导入 ${data.changed} 个到待人工管理`);
  } catch (err) {
    el("importStatus").textContent = `导入到待人工管理失败：${err.message}`;
    toast(`导入失败：${err.message}`);
  }
});

// ---- 导入到密钥错误管理（检测系统视图）----
// 按「登录状态」过滤——只搬登录下拉显示「2FA密钥错」的号(a.status.login === "2fa_error")。
// 有勾选：对勾选的号再按 login==="2fa_error" 过滤，只导入匹配的，非密钥错误的跳过。
// 无勾选：默认取所有 login==="2fa_error" 的号。置 in2faError=true 推送到密钥错误管理页（move 语义：从检测系统账号库搬走）。
const isLogin2faError = (a) => a && a.status && a.status.login === "2fa_error";
el("pushTo2faErrorBtn").addEventListener("click", async () => {
  const picked = accounts.filter((a) => selected.has(a.id));
  const by2faError = !picked.length;
  // 勾选模式也只导入密钥错误的号，避免把非密钥错误的号一并搬进密钥错误管理。
  let rows = (by2faError ? accounts : picked).filter(isLogin2faError);
  if (!rows.length) {
    // 区分两种空：完全没勾选/没密钥错误的号，或勾选了但里头一个密钥错误的都没有。
    if (!by2faError) {
      el("importStatus").textContent = `选中的 ${picked.length} 个账号里没有「密钥错误」的号，未导入`;
      toast("选中里没有密钥错误的号，未导入");
    } else {
      el("importStatus").textContent = "没有可导入的账号：先勾选账号，或先检测产出登录「2FA密钥错」的号";
      toast("没有可导入的账号");
    }
    return;
  }
  // 已在密钥错误管理里的号会被后端跳过，这里据此给用户真实预期。
  const fresh = rows.filter((a) => !in2faErrorOf(a)).length;
  const skippedNot2faError = by2faError ? 0 : picked.length - rows.length;
  const scope = by2faError
    ? `全部「密钥错误」的 ${rows.length} 个号`
    : `选中 ${picked.length} 个，其中 ${rows.length} 个为密钥错误`;
  const extra = skippedNot2faError ? `；另有 ${skippedNot2faError} 个非密钥错误已过滤` : "";
  if (!confirm(`确认把${scope}导入到密钥错误管理？\n（其中 ${fresh} 个为新导入，已在密钥错误管理的会跳过${extra}；导入后这些号将从检测系统账号库搬走）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-2fa-error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    // 推送后清空勾选：这批号已进密钥错误管理，避免勾选残留被带去别处误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    el("importStatus").textContent = `已导入 ${data.changed} 个到密钥错误管理（密钥错误管理共 ${data.in2faError} 个）`
      + (skippedNot2faError ? `，跳过 ${skippedNot2faError} 个非密钥错误` : "");
    toast(`已导入 ${data.changed} 个到密钥错误管理`);
  } catch (err) {
    el("importStatus").textContent = `导入到密钥错误管理失败：${err.message}`;
    toast(`导入失败：${err.message}`);
  }
});

// ---- 出售管理视图：移出出售管理 / 复制选中（交付格式）----
el("removeFromSalesBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && inSalesOf(a));
  if (!rows.length) { toast("先勾选要移出的账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个账号移出出售管理？\n（不影响检测状态/销售状态，只是不再出现在本页；之后可在检测系统再次导入）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/remove-from-sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已移出 ${data.changed} 个`);
  } catch (err) {
    toast(`移出失败：${err.message}`);
  }
});

el("salesCopyBtn").addEventListener("click", () => {
  // 选中优先；未勾选则导出当前出售管理列表（已按销售状态/搜索过滤）。
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && inSalesOf(a)) : filteredSales();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 出售管理表格的行内交互（勾选 / 状态下拉 / 行内编辑 / 取码 / 复制 / 删除）已统一由上面
// 三 tbody 共用的事件委托处理（onRowChange/onRowBlur/onRowKeydown/onRowDblclick/onRowClick），此处不再单独绑定。
el("salesSelectAll").addEventListener("change", (e) => {
  const rows = filteredSales();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("salesSearch").addEventListener("input", render);

// ---- 养号管理视图：出库 / 退回在库 / 复制选中 / 导入到出售管理 ----
// 出库：选中优先；未勾选则取当前筛选的养号列表（filteredNurture，已按销售状态/搜索过滤）。
// 先复制交付文本，再 mark-sold 置 sold + soldAt；已售号不重复导出，防重复卖。
el("nurtureSellExportBtn").addEventListener("click", async () => {
  const rows = (selected.size ? accounts.filter((a) => selected.has(a.id) && inNurtureOf(a)) : filteredNurture())
    .filter((a) => saleOf(a) !== "sold");
  if (!rows.length) { toast("没有可出库的养号账号（已售号不重复导出）"); return; }
  const scope = selected.size ? `选中的 ${rows.length} 个养号` : `当前列表的 ${rows.length} 个养号`;
  if (!confirm(`确认出库${scope}？\n将先复制交付文本（邮箱----密码----辅助----2FA----年份----国家），再标记为「已售」。`)) return;
  const ids = rows.map((a) => a.id);
  const text = rows.map(fmtAccount).join("\n");
  const markSold = async () => {
    try {
      const data = await api("/api/accounts/mark-sold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      accounts = data.accounts || [];
      selected.clear();
      saveSet(LS.accounts, selected);
      render();
      toast(`已出库 ${data.changed} 个（已复制 ${rows.length} 个交付文本）`);
    } catch (err) {
      toast(`标记已售失败：${err.message}`);
    }
  };
  navigator.clipboard.writeText(text).then(markSold, () => { window.prompt("复制以下交付内容：", text); markSold(); });
});

// 退回在库：撤销误标的已售（多在「已售」筛选下操作）。
el("nurtureRestockBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && inNurtureOf(a) && saleOf(a) === "sold");
  if (!rows.length) { toast("先勾选要退回在库的已售养号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个已售养号退回在库？\n销售状态会回到「在库」、清空已售时间。`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/mark-instock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已退回在库 ${data.changed} 个`);
  } catch (err) {
    toast(`退回失败：${err.message}`);
  }
});

// 复制选中：仅复制交付格式，不改销售状态。未勾选则导出当前养号筛选列表。
el("nurtureCopyBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && inNurtureOf(a)) : filteredNurture();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 导入到出售管理：把选中的养号号也置 inSales=true（复用 push-to-sales，但默认用选中 ids，不取 category==="sell"）。
el("nurturePushToSalesBtn").addEventListener("click", async () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && inNurtureOf(a)) : filteredNurture();
  if (!rows.length) { toast("先勾选要导入到出售管理的养号"); return; }
  const fresh = rows.filter((a) => !inSalesOf(a)).length;
  if (!confirm(`确认把这 ${rows.length} 个养号导入到出售管理？\n（其中 ${fresh} 个为新导入，已在出售管理的会跳过；它们会同时出现在出售管理视图）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/push-to-sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已导入 ${data.changed} 个到出售管理（出售管理共 ${data.inSales} 个）`);
  } catch (err) {
    toast(`导入失败：${err.message}`);
  }
});

// 移出养号管理：把号置 inNurture=false（不影响检测状态/销售状态，只是不再出现在本页；移出后该号会重新出现在检测系统账号库）。
el("removeFromNurtureBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && inNurtureOf(a));
  if (!rows.length) { toast("先勾选要移出的账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个账号移出养号管理？\n（不影响检测状态/销售状态，移出后会重新出现在检测系统账号库）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/remove-from-nurture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已移出 ${data.changed} 个`);
  } catch (err) {
    toast(`移出失败：${err.message}`);
  }
});

// 养号管理表格的行内交互同样由上面三 tbody 共用的事件委托处理，此处不再单独绑定。
el("nurtureSelectAll").addEventListener("change", (e) => {
  const rows = filteredNurture();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("nurtureSearch").addEventListener("input", render);

// 养号管理销售状态筛选：默认在库（可售），记住用户选择；切换时清空勾选，避免跨筛选误操作。
if (localStorage.getItem(LS.filterNurtureSale) != null) {
  el("filterNurtureSale").value = localStorage.getItem(LS.filterNurtureSale);
}
el("filterNurtureSale").addEventListener("change", () => {
  localStorage.setItem(LS.filterNurtureSale, el("filterNurtureSale").value);
  selected.clear();
  saveSet(LS.accounts, selected);
  render();
});

// ---- 废号管理视图：复制选中 / 移出废号管理 ----
// 复制选中：仅复制交付格式（与各视图一致）。未勾选则导出当前废号筛选列表。
el("scrapCopyBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && inScrapOf(a)) : filteredScrap();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 移出废号管理：把号置 inScrap=false（不影响检测状态/销售状态，只是不再出现在本页；移出后该号会重新出现在检测系统账号库）。
el("removeFromScrapBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && inScrapOf(a));
  if (!rows.length) { toast("先勾选要移出的账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个账号移出废号管理？\n（不影响检测状态/销售状态，移出后会重新出现在检测系统账号库）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/remove-from-scrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已移出 ${data.changed} 个`);
  } catch (err) {
    toast(`移出失败：${err.message}`);
  }
});

// 废号管理表格的行内交互同样由上面四 tbody 共用的事件委托处理，此处不再单独绑定。
el("scrapSelectAll").addEventListener("change", (e) => {
  const rows = filteredScrap();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("scrapSearch").addEventListener("input", render);

// ---- 登录失败管理视图：复制选中 / 移出登录失败管理 ----
// 复制选中：仅复制交付格式（与各视图一致）。未勾选则导出当前登录失败筛选列表。
el("failedCopyBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && inFailedOf(a)) : filteredFailed();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 移出登录失败管理：把号置 inFailed=false（不影响检测状态/销售状态，只是不再出现在本页；移出后该号会重新出现在检测系统账号库）。
el("removeFromFailedBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && inFailedOf(a));
  if (!rows.length) { toast("先勾选要移出的账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个账号移出登录失败管理？\n（不影响检测状态/销售状态，移出后会重新出现在检测系统账号库）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/remove-from-failed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已移出 ${data.changed} 个`);
  } catch (err) {
    toast(`移出失败：${err.message}`);
  }
});

// 登录失败管理表格的行内交互同样由上面五 tbody 共用的事件委托处理，此处不再单独绑定。
el("failedSelectAll").addEventListener("change", (e) => {
  const rows = filteredFailed();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("failedSearch").addEventListener("input", render);

// ---- 待人工管理视图：复制选中 / 移出待人工管理 ----
// 复制选中：仅复制交付格式（与各视图一致）。未勾选则导出当前待人工筛选列表。
el("needVerifyCopyBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && inNeedVerifyOf(a)) : filteredNeedVerify();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 移出待人工管理：把号置 inNeedVerify=false（不影响检测状态/销售状态，只是不再出现在本页；移出后该号会重新出现在检测系统账号库）。
el("removeFromNeedVerifyBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && inNeedVerifyOf(a));
  if (!rows.length) { toast("先勾选要移出的账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个账号移出待人工管理？\n（不影响检测状态/销售状态，移出后会重新出现在检测系统账号库）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/remove-from-needverify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已移出 ${data.changed} 个`);
  } catch (err) {
    toast(`移出失败：${err.message}`);
  }
});

// 待人工管理表格的行内交互同样由上面共用的事件委托处理，此处不再单独绑定。
el("needVerifySelectAll").addEventListener("change", (e) => {
  const rows = filteredNeedVerify();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("needVerifySearch").addEventListener("input", render);

// ---- 密钥错误管理视图：复制选中 / 移出密钥错误管理 ----
// 复制选中：仅复制交付格式（与各视图一致）。未勾选则导出当前密钥错误筛选列表。
el("tfaErrorCopyBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && in2faErrorOf(a)) : filtered2faError();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 移出密钥错误管理：把号置 in2faError=false（不影响检测状态/销售状态，只是不再出现在本页；移出后该号会重新出现在检测系统账号库）。
el("removeFrom2faErrorBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && in2faErrorOf(a));
  if (!rows.length) { toast("先勾选要移出的账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个账号移出密钥错误管理？\n（不影响检测状态/销售状态，移出后会重新出现在检测系统账号库）`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/remove-from-2fa-error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已移出 ${data.changed} 个`);
  } catch (err) {
    toast(`移出失败：${err.message}`);
  }
});

// 密钥错误管理表格的行内交互同样由上面共用的事件委托处理，此处不再单独绑定。
el("tfaErrorSelectAll").addEventListener("change", (e) => {
  const rows = filtered2faError();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("tfaErrorSearch").addEventListener("input", render);

// ---- 已售记录视图：复制选中 / 退回在库 ----
// 复制选中：仅复制交付格式（与各视图一致），不改销售状态。未勾选则导出当前已售筛选列表。
el("soldCopyBtn").addEventListener("click", () => {
  const rows = selected.size ? accounts.filter((a) => selected.has(a.id) && saleOf(a) === "sold") : filteredSold();
  if (!rows.length) { toast("没有可复制的账号"); return; }
  const text = rows.map(fmtAccount).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${rows.length} 个账号`),
    () => window.prompt("复制以下内容：", text),
  );
});

// 退回在库：撤销已售（销售状态回 in_stock、清 soldAt）。撤销后该号离开已售记录页；
// 若不属于任何 bucket（inSales/inNurture/inScrap/inFailed）则重新出现在检测库。镜像现有 restock 逻辑。
el("soldRestockBtn").addEventListener("click", async () => {
  const rows = accounts.filter((a) => selected.has(a.id) && saleOf(a) === "sold");
  if (!rows.length) { toast("先勾选要退回在库的已售账号"); return; }
  if (!confirm(`确认把选中的 ${rows.length} 个已售账号退回在库？\n销售状态会回到「在库」、清空已售时间，并离开已售记录页。`)) return;
  const ids = rows.map((a) => a.id);
  try {
    const data = await api("/api/accounts/mark-instock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    toast(`已退回在库 ${data.changed} 个`);
  } catch (err) {
    toast(`退回失败：${err.message}`);
  }
});

// 已售记录表格的行内交互同样由上面六 tbody 共用的事件委托处理，此处不再单独绑定。
el("soldSelectAll").addEventListener("change", (e) => {
  const rows = filteredSold();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("soldSearch").addEventListener("input", render);

// ---- 顶部 dock：切换检测系统 / 养号管理 / 废号管理 / 登录失败管理 / 出售管理 / 已售记录六视图 ----
function applyView(view) {
  // 未知值安全回退到 detect。
  const v = (view === "sales" || view === "nurture" || view === "scrap" || view === "failed" || view === "needverify" || view === "tfaerror" || view === "sold") ? view : "detect";
  currentView = v;
  el("detectQuickTools").hidden = v !== "detect";
  el("viewDetect").hidden = v !== "detect";
  el("viewNurture").hidden = v !== "nurture";
  el("viewScrap").hidden = v !== "scrap";
  el("viewFailed").hidden = v !== "failed";
  el("viewNeedVerify").hidden = v !== "needverify";
  el("view2faError").hidden = v !== "tfaerror";
  el("viewSales").hidden = v !== "sales";
  el("viewSold").hidden = v !== "sold";
  document.querySelectorAll(".dock-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  try { localStorage.setItem(LS.view, v); } catch (_) { /* ignore */ }
  // 切到该视图时，把动作勾选回填成这个视图自己记住的那一套（三视图互不同步）。
  applyActionChecks();
}
document.querySelectorAll(".dock-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    // 切换视图清空勾选：selected 为两视图共用的全局集合，切换时清空避免跨视图误操作。
    selected.clear();
    saveSet(LS.accounts, selected);
    applyView(tab.dataset.view);
    render();
  });
});
applyView(localStorage.getItem(LS.view) || "detect");

el("selectAll").addEventListener("change", (e) => {
  const rows = filtered();
  if (e.target.checked) rows.forEach((a) => selected.add(a.id)); else rows.forEach((a) => selected.delete(a.id));
  saveSet(LS.accounts, selected);
  render();
});

el("search").addEventListener("input", render);
el("filterStatus").addEventListener("change", render);
// 切换「库」筛选时清空勾选：避免在「全部」里全选后切到某个库，旧勾选被带过去、看着像自动选中。
el("filterCategory").addEventListener("change", () => {
  selected.clear();
  saveSet(LS.accounts, selected);
  render();
});
// 销售状态筛选：默认在库（可售），记住用户选择；切换时同样清空勾选，
// 防止在「在库」里勾的号被带到「已售」视图误操作（如重复退回）。
if (localStorage.getItem(LS.filterSale) != null) {
  el("filterSale").value = localStorage.getItem(LS.filterSale);
}
el("filterSale").addEventListener("change", () => {
  localStorage.setItem(LS.filterSale, el("filterSale").value);
  selected.clear();
  saveSet(LS.accounts, selected);
  render();
});

// 一键归位：把检测库里的号按状态自动搬进对应管理页，未分类/未检测留在检测库；已在各管理页或已售的号不动。
el("classifyBtn").addEventListener("click", async () => {
  const ids = [...selected];
  const scope = ids.length ? `选中的 ${ids.length} 个账号（仅其中仍在检测库的）` : `检测库里的全部号`;
  const ok = confirm(
    "将把检测库里的号按状态自动归位到各管理页：\n" +
    "封禁→废号，登录失败→登录失败，待人工→待人工，密钥错误→密钥错误，可售→出售，养号→养号；\n" +
    "未分类/未检测的号留在检测库。\n" +
    "已在各管理页或已售的号不动。\n\n确认继续？"
  );
  if (!ok) return;
  el("classifyBtn").disabled = true;
  el("importStatus").textContent = `正在归位${scope}…`;
  try {
    const data = await api("/api/accounts/auto-sort", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }),
    });
    accounts = data.accounts || [];
    selected.clear();
    saveSet(LS.accounts, selected);
    render();
    const m = data.moved || { scrap: 0, failed: 0, needVerify: 0, tfaError: 0, sales: 0, nurture: 0 };
    const msg = `废号 ${m.scrap} / 登录失败 ${m.failed} / 待人工 ${m.needVerify} / 密钥错误 ${m.tfaError} / 出售 ${m.sales} / 养号 ${m.nurture}；留在检测库 ${data.stayed || 0}`;
    el("importStatus").textContent = `已归位：${msg}`;
    toast(`归位完成：${msg}`);
  } catch (err) {
    el("importStatus").textContent = `归位失败：${err.message}`;
    toast(`归位失败：${err.message}`);
  } finally {
    el("classifyBtn").disabled = false;
  }
});

// ---- 自动化 ----
el("apiKey").value = localStorage.getItem(LS.apiKey) || "";
el("maxConcurrent").value = localStorage.getItem(LS.max) || "3";
el("apiKey").addEventListener("input", () => localStorage.setItem(LS.apiKey, el("apiKey").value.trim()));
el("maxConcurrent").addEventListener("input", () => localStorage.setItem(LS.max, el("maxConcurrent").value));

// 记住开关：随机指纹 / 清空数据
function loadFlags() {
  let f = {};
  try { f = JSON.parse(localStorage.getItem(LS.flags) || "{}"); } catch (_) { f = {}; }
  if (typeof f.randomFp === "boolean") el("randomFp").checked = f.randomFp;
  if (typeof f.clearData === "boolean") el("clearData").checked = f.clearData;
  if (typeof f.keepOpen === "boolean") el("keepOpen").checked = f.keepOpen;
  if (f.manualChallengePolicy === "close" || f.manualChallengePolicy === "keep") {
    el("manualChallengePolicy").value = f.manualChallengePolicy;
  }
}
function saveFlags() {
  localStorage.setItem(LS.flags, JSON.stringify({
    randomFp: el("randomFp").checked,
    clearData: el("clearData").checked,
    keepOpen: el("keepOpen").checked,
    manualChallengePolicy: el("manualChallengePolicy").value,
  }));
}
el("randomFp").addEventListener("change", saveFlags);
el("clearData").addEventListener("change", saveFlags);
el("keepOpen").addEventListener("change", saveFlags);
el("manualChallengePolicy").addEventListener("change", saveFlags);
loadFlags();

// ---- 运行模式：调用 AdsPower / 不调用 AdsPower（本机临时浏览器）----
function currentMode() {
  const r = document.querySelector('input[name="runMode"]:checked');
  return r ? r.value : "local";
}
// 本机模式只保留必要开关；AdsPower 专属配置在切到兼容模式后再显示。
function syncModeVisibility() {
  const local = currentMode() === "local";
  el("apiKeyField").hidden = local;
  el("optRandomFp").hidden = local;
  el("optProxy").hidden = local;
  el("optLocalProxy").hidden = true;
  el("envField").hidden = local;
  el("localHint").hidden = true;
  el("maxConcurrentLabel").textContent = local ? "并发数" : "最大并发";
  if (local) { el("proxyBox").hidden = true; }
  else { syncProxyVisibility(); }
}
function saveMode() { localStorage.setItem(LS.mode, currentMode()); }
function loadMode() {
  const saved = localStorage.getItem(LS.mode) || "local";
  const r = document.querySelector(`input[name="runMode"][value="${saved}"]`);
  if (r) r.checked = true;
  syncModeVisibility();
}
document.querySelectorAll('input[name="runMode"]').forEach((r) => {
  r.addEventListener("change", () => {
    saveMode();
    syncModeVisibility();
    if (currentMode() === "adspower") { loadEnvs(); maybeAutoLoadTags(); }
  });
});
loadMode();

// ---- 动态住宅代理开关（只用 AdsPower 代理池 + 按标签筛选）----
function readProxyForm() {
  return {
    enabled: el("useProxy").checked,
    mode: "pool",
    tagId: el("proxyTag").value,
  };
}
function saveProxyForm() {
  localStorage.setItem(LS.proxy, JSON.stringify(readProxyForm()));
}
function syncProxyVisibility() {
  el("proxyBox").hidden = currentMode() === "local" || !el("useProxy").checked;
}
function loadProxyForm() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(LS.proxy) || "{}"); } catch (_) { p = {}; }
  el("useProxy").checked = !!p.enabled;
  savedProxyTagId = p.tagId || "";
  syncProxyVisibility();
}

let savedProxyTagId = "";
let proxyTagsLoaded = false;
async function loadProxyTags() {
  const apiKey = el("apiKey").value.trim();
  if (el("loadTagsBtn")) el("loadTagsBtn").disabled = true;
  el("proxyTagBadge").textContent = "加载中…";
  try {
    const r = await api(`/api/automation/proxy-tags?apiKey=${encodeURIComponent(apiKey)}`);
    const sel = el("proxyTag");
    sel.innerHTML = `<option value="">全部代理（不限标签 · 共 ${r.total} 条）</option>`;
    (r.tags || []).forEach((t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = `${t.name}（${t.count} 条）`;
      sel.appendChild(o);
    });
    if (savedProxyTagId) sel.value = savedProxyTagId;
    el("proxyTagBadge").textContent = `${(r.tags || []).length} 个标签`;
    proxyTagsLoaded = true;
  } catch (err) {
    el("proxyTagBadge").textContent = "加载失败";
  } finally {
    if (el("loadTagsBtn")) el("loadTagsBtn").disabled = false;
  }
}
// 勾上代理时自动拉一次标签（避免还要手点）。
function maybeAutoLoadTags() {
  if (currentMode() !== "adspower") return;
  if (el("useProxy").checked && !proxyTagsLoaded) loadProxyTags();
}
el("useProxy").addEventListener("change", () => { saveProxyForm(); syncProxyVisibility(); maybeAutoLoadTags(); });
el("proxyTag").addEventListener("change", saveProxyForm);
el("loadTagsBtn").addEventListener("click", () => { proxyTagsLoaded = false; loadProxyTags(); });
loadProxyForm();

// ---- 窗口（环境）选择 ----
let envProfiles = [];
let envSelected = loadSet(LS.envs);

function filteredEnvs() {
  const q = el("envSearch").value.trim().toLowerCase();
  if (!q) return envProfiles;
  return envProfiles.filter((e) => [e.serial, e.name, e.group, e.remark, e.username].some((v) => String(v || "").toLowerCase().includes(q)));
}

function renderEnvs() {
  const rows = filteredEnvs();
  if (!envProfiles.length) {
    el("envList").innerHTML = '<span class="muted">未读取到窗口。确认 AdsPower 已开启；可点「加载窗口」重试。</span>';
  } else if (!rows.length) {
    el("envList").innerHTML = '<span class="muted">没有匹配的窗口。</span>';
  } else {
    el("envList").innerHTML = rows.map((e) => `
      <label class="env-item${envSelected.has(e.serial) ? " on" : ""}">
        <input type="checkbox" data-serial="${e.serial}"${envSelected.has(e.serial) ? " checked" : ""} />
        <span class="env-name">${escapeHtml(e.name || "(未命名)")}</span>
        <span class="env-serial">#${escapeHtml(e.serial)}</span>
        ${e.group ? `<span class="env-group">${escapeHtml(e.group)}</span>` : ""}
        ${e.open ? '<span class="env-open">已打开</span>' : ""}
      </label>`).join("");
  }
  el("envBadge").textContent = envProfiles.length ? `${envSelected.size}/${envProfiles.length} 选中` : "未加载";
  const all = el("envSelectAll");
  all.checked = rows.length > 0 && rows.every((e) => envSelected.has(e.serial));
}

async function loadEnvs() {
  el("loadEnvsBtn").disabled = true;
  el("envBadge").textContent = "加载中…";
  try {
    const q = el("apiKey").value.trim() ? `?apiKey=${encodeURIComponent(el("apiKey").value.trim())}` : "";
    const data = await api(`/api/automation/envs${q}`);
    envProfiles = data.envs || [];
    // 保留仍存在的已选项（仅在确实拿到列表时才裁剪，避免加载失败清空已存选择）
    if (envProfiles.length) {
      envSelected = new Set([...envSelected].filter((s) => envProfiles.some((e) => e.serial === s)));
      saveSet(LS.envs, envSelected);
    }
    renderEnvs();
  } catch (err) {
    el("envList").innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
    el("envBadge").textContent = "加载失败";
  } finally {
    el("loadEnvsBtn").disabled = false;
  }
}
el("loadEnvsBtn").addEventListener("click", loadEnvs);

el("envSearch").addEventListener("input", renderEnvs);

el("envList").addEventListener("change", (e) => {
  if (!e.target.matches("input[type=checkbox]")) return;
  const s = e.target.dataset.serial;
  if (e.target.checked) envSelected.add(s); else envSelected.delete(s);
  saveSet(LS.envs, envSelected);
  renderEnvs();
});

el("envSelectAll").addEventListener("change", (e) => {
  const rows = filteredEnvs();
  if (e.target.checked) rows.forEach((x) => envSelected.add(x.serial));
  else rows.forEach((x) => envSelected.delete(x.serial));
  saveSet(LS.envs, envSelected);
  renderEnvs();
});

async function loadActions() {
  try {
    const data = await api("/api/automation/actions");
    const savedActions = loadActionsSet(currentView);
    el("actionList").innerHTML = (data.actions || []).map((a) => `
      <label class="action-item">
        <input type="checkbox" value="${a.id}" data-exclusive="${a.exclusive ? "1" : "0"}"${savedActions.has(a.id) ? " checked" : ""} />
        <span>${escapeHtml(a.label)}</span>
        <span class="risk risk-${a.risk}">${a.risk === "low" ? "低风险" : a.risk === "medium" ? "中风险" : "高风险"}</span>
      </label>`).join("");
  } catch (err) {
    el("actionList").innerHTML = `<span class="muted">加载操作失败：${escapeHtml(err.message)}</span>`;
  }
}
// 记住勾选的操作
el("actionList").addEventListener("change", (e) => {
  const changed = e.target && e.target.matches('input[type="checkbox"]') ? e.target : null;
  if (changed && changed.checked) {
    const all = [...document.querySelectorAll('#actionList input[type="checkbox"]')];
    if (changed.dataset.exclusive === "1") {
      all.forEach((input) => { if (input !== changed) input.checked = false; });
    } else {
      all.forEach((input) => { if (input.dataset.exclusive === "1") input.checked = false; });
    }
  }
  const ids = [...document.querySelectorAll('#actionList input:checked')].map((c) => c.value);
  saveSet(actionsKeyFor(currentView), new Set(ids));
});

// 发起任务的公共逻辑：批量「对选中账号运行」(#runBtn，传 [...selected]) 与单行「检测/单独运行」
// 按钮（传 [a.id]）都调用它，避免复制校验/发起逻辑。唯一区别是执行范围 ids 不同，
// 其余（动作、运行模式、窗口、代理/指纹/清数据/保留窗口等）都取批量操作面板的当前配置。
async function startJob(ids) {
  if (!appReady) {
    el("runStatus").textContent = "账号和操作仍在加载，请稍候";
    return;
  }
  // 并发约束：已有任务在运行（jobId 存在或正在轮询）时不重复发起，避免两个任务互相打架。
  if (jobStarting || jobId || jobPolling) {
    toast("已有任务在运行，请先停止或等待完成");
    el("runStatus").textContent = "已有任务在运行，请先停止或等待完成";
    return;
  }
  const mode = currentMode();
  const local = mode === "local";
  const accountIds = [...ids];
  const actionIds = [...document.querySelectorAll('#actionList input:checked')].map((c) => c.value);
  const envSerials = [...envSelected];
  if (!local && !envSerials.length) { el("runStatus").textContent = "请先加载并勾选至少一个窗口"; return; }
  if (!accountIds.length) { el("runStatus").textContent = "请先在账号库勾选账号"; return; }
  if (!actionIds.length) { el("runStatus").textContent = "请选择至少一个操作"; return; }
  jobStarting = true;
  syncRunButton();
  el("runStatus").textContent = "启动中…";
  try {
    const data = await api("/api/automation/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode,
        apiKey: el("apiKey").value.trim(),
        envs: local ? [] : envSerials,
        maxConcurrent: Number(el("maxConcurrent").value) || 3,
        randomFp: el("randomFp").checked,
        clearData: el("clearData").checked,
        keepOpen: el("keepOpen").checked,
        manualChallengePolicy: el("manualChallengePolicy").value,
        phoneMode: readPhoneRunMode(),
        // 本机模式代理仍在规划中：不传 AdsPower 代理池配置（后端会忽略）。
        proxy: local ? null : readProxyForm(),
        accountIds, actionIds,
      }),
    });
    jobId = data.jobId;
    jobManualExpand.clear(); // 新任务：清掉上一批的手动展开/折叠记录，按默认规则重新折叠
    // 单行“检测”就是为了马上看这个账号的结果：无论成功/失败，任务卡默认展开。
    if (accountIds.length === 1) {
      const single = accounts.find((a) => a.id === accountIds[0]);
      if (single && single.email) jobManualExpand.set(single.email, true);
    }
    el("runStatus").textContent = `任务已启动（${accountIds.length} 账号 · ${actionIds.length} 操作）`;
    el("stopBtn").disabled = false;
    renderJob(data.job);
    pollJob();
  } catch (err) {
    el("runStatus").textContent = err.message;
  } finally {
    jobStarting = false;
    syncRunButton();
  }
}

el("runBtn").addEventListener("click", () => startJob([...selected]));

el("stopBtn").addEventListener("click", async () => {
  if (!jobId) return;
  el("stopBtn").disabled = true;
  el("runStatus").textContent = "正在停止并关闭窗口…";
  try {
    const data = await api(`/api/automation/jobs/${jobId}/cancel`, { method: "POST" });
    renderJob(data.job);
    el("runStatus").textContent = "已停止，正在收尾关闭窗口";
  } catch (err) {
    el("runStatus").textContent = err.message;
    el("stopBtn").disabled = false;
  }
});

// 「需人工」判定里要扫描的 detail 关键词（多见于移除设备被风控拦下）。
const ATTENTION_DETAIL_KEYWORDS = ["拒绝验证", "确认是你本人", "安全码", "无法验证身份", "未通过"];
const JOB_ACTION_TEXT = {
  login: "登录",
  "check-password": "密码检测",
  "detect-ban": "Gmail/YouTube",
  "detect-restrict": "服务限制",
  "detect-region": "账号归属地",
  "detect-gpt": "GPT 授权",
  "change-language": "更改语言",
  "change-2fa": "更改 2FA",
  "remove-devices": "移除设备",
  "remove-phones": "移除验证电话",
  "add-2fa-phone": "添加验证手机号",
  "gemini-check": "Gemini",
  "age-verify": "年龄验证",
  "age-verify-close": "年龄验证并关支付",
  "close-payment": "关闭支付资料",
};
const JOB_OUTCOME_TEXT = {
  ok: "成功", error: "失败", need_verify: "需人工", blocked: "被拦截",
  skipped: "已跳过", rejected: "拒绝验证", seckey: "需要安全代码",
};
const JOB_STATUS_TEXT = { queued: "排队中", running: "检测中", done: "已完成", error: "失败", cancelled: "已停止" };

// 判定一个账号 task 是否「异常/需人工」。用于顶部汇总、「只看异常」筛选与默认展开。
// 满足以下任一条件即算需人工：
//  - task 自身有错误（t.error），或被取消（status === "cancelled"）；
//  - 任一动作结果 outcome === "error"（执行报错）；
//  - 任一动作结果 outcome === "skipped"（被跳过，通常是前置失败连带没跑）；
//  - 任一动作 outcome 为 rejected / seckey（被拒验 / 需安全码，多见于移除设备）；
//  - login / check-password 动作 outcome 不是 "ok"（登录或密码检测未通过）；
//  - 移除设备类动作（action 含 "device"）的 detail 文本里出现人工关键词。
function taskNeedsAttention(t) {
  if (!t) return false;
  if (t.error) return true;
  if (t.status === "cancelled") return true;
  for (const r of (t.results || [])) {
    if (!r) continue;
    const outcome = r.outcome;
    if (outcome === "error" || outcome === "need_verify" || outcome === "skipped") return true;
    if (outcome === "rejected" || outcome === "seckey") return true;
    if ((r.action === "login" || r.action === "check-password") && outcome !== "ok") return true;
    if (typeof r.action === "string" && r.action.includes("device")) {
      const text = r.detail ? Object.values(r.detail).filter(Boolean).join(" ") : "";
      if (ATTENTION_DETAIL_KEYWORDS.some((k) => text.includes(k))) return true;
    }
  }
  return false;
}

function renderJob(job) {
  if (!job) return;
  lastJob = job;
  const tasks = job.tasks || [];
  const onlyAbnormal = loadJobOnlyAbnormal();
  const total = tasks.length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const attnCount = tasks.filter(taskNeedsAttention).length;

  // 顶部工具条：汇总统计 + 只看异常筛选 + 清空日志。整块随轮询一起重渲染，
  // 交互全部走 #jobBoard 上的事件委托，所以重渲染不会丢绑定；筛选/折叠态从持久化与内存还原。
  const toolbar = `<div class="job-toolbar">
    <div class="job-summary">共 <b>${total}</b> 个 · 已完成 <b>${doneCount}</b> · <span class="job-summary-attn">需人工/异常 <b>${attnCount}</b></span></div>
    <label class="switch job-filter"><input type="checkbox" id="jobOnlyAbnormal"${onlyAbnormal ? " checked" : ""} /><span>只看异常</span></label>
    <button type="button" class="ghost slim job-clear-btn">清空日志</button>
  </div>`;

  const cards = tasks.map((t) => {
    const needs = taskNeedsAttention(t);
    if (onlyAbnormal && !needs) return ""; // 只看异常：隐藏全绿正常号
    // 折叠态：用户手动 toggle 过的以记录为准；否则需人工默认展开、正常默认折叠。
    const expanded = jobManualExpand.has(t.email) ? jobManualExpand.get(t.email) : needs;
    // 逐条动作结果 + 人话提示（detail），换 2FA 等关键写操作的成功/失败一眼可见。
    const lines = (t.results || []).map((r) => {
      const msg = r.detail ? Object.values(r.detail).filter(Boolean).join("；") : "";
      const mark = r.outcome === "ok" ? "✓" : (r.outcome === "error" ? "✗" : "•");
      const actionText = JOB_ACTION_TEXT[r.action] || r.action;
      const outcomeText = r.action === "check-password"
        ? (passwordCheckResultText(r) || JOB_OUTCOME_TEXT[r.outcome] || r.outcome)
        : r.action === "login" && r.reasonCode
          ? (loginCheckResultText(r) || JOB_OUTCOME_TEXT[r.outcome] || r.outcome)
        : (JOB_OUTCOME_TEXT[r.outcome] || r.outcome);
      return `<div class="job-line out-${escapeHtml(r.outcome)}">${mark} ${escapeHtml(actionText)}：${escapeHtml(outcomeText)}${msg ? " — " + escapeHtml(msg) : ""}</div>`;
    }).join("");
    const head = t.error ? `错误：${t.error}` : (JOB_STATUS_TEXT[t.status] || t.status);
    return `<div class="job-task ${t.status}${needs ? " needs-attn" : ""}${expanded ? "" : " folded"}" data-email="${escapeHtml(t.email)}">
      <div class="job-task-head">
        <span class="job-caret">${expanded ? "▾" : "▸"}</span>
        <span class="job-email">${escapeHtml(t.email)}</span>
        <span class="job-env">${t.env ? `环境 ${t.env}` : "待分配"}</span>
        <span class="job-status">${escapeHtml(head)}</span>
        ${needs ? `<span class="job-attn">需人工</span>` : ""}
      </div>
      <div class="job-lines">${lines}</div>
    </div>`;
  }).join("");

  const emptyHint = (onlyAbnormal && attnCount === 0 && total > 0)
    ? `<div class="job-empty-hint">没有需人工的账号（关闭「只看异常」查看全部）</div>` : "";

  el("jobBoard").innerHTML = toolbar + emptyHint + cards;
}

// 只清运行日志的「显示」，不触碰 jobId / pollJob / clearJob 等轮询逻辑：
// 若 job 仍在运行，下一轮轮询会自动重新渲染回来，数据不会丢。
function clearJobBoard() {
  el("jobBoard").innerHTML = "";
  lastJob = null;
}

// #jobBoard 内容每轮轮询都会整块重渲染，故所有交互一律走事件委托（只绑一次）。
el("jobBoard").addEventListener("click", (e) => {
  if (e.target.closest(".job-clear-btn")) { clearJobBoard(); return; }
  const head = e.target.closest(".job-task-head");
  if (!head) return;
  const card = head.closest(".job-task");
  if (!card) return;
  const willExpand = card.classList.contains("folded"); // 折叠中→点击展开
  card.classList.toggle("folded", !willExpand);
  const caret = head.querySelector(".job-caret");
  if (caret) caret.textContent = willExpand ? "▾" : "▸";
  const email = card.dataset.email;
  if (email) jobManualExpand.set(email, willExpand); // 记住手动选择，重渲染后保持
});
el("jobBoard").addEventListener("change", (e) => {
  if (e.target && e.target.id === "jobOnlyAbnormal") {
    saveJobOnlyAbnormal(e.target.checked);
    if (lastJob) renderJob(lastJob); // 本地重渲染应用筛选（job 已终态时也即时生效）
  }
});

function clearJob() {
  jobId = null;
  try { localStorage.removeItem(LS.job); } catch (_) { /* ignore */ }
  syncRunButton();
}

function completedJobText(job) {
  const tasks = (job && job.tasks) || [];
  if (job && job.status === "cancelled") return "已停止";
  if (tasks.length === 1) {
    const task = tasks[0];
    const credentialResult = (task.results || []).find((r) => r && (r.action === "login" || r.action === "check-password"));
    if (credentialResult) {
      const reason = credentialResult.action === "check-password"
        ? (passwordCheckResultText(credentialResult) || JOB_OUTCOME_TEXT[credentialResult.outcome] || credentialResult.outcome)
        : credentialResult.reasonCode
          ? (loginCheckResultText(credentialResult) || JOB_OUTCOME_TEXT[credentialResult.outcome] || credentialResult.outcome)
        : (JOB_OUTCOME_TEXT[credentialResult.outcome] || credentialResult.outcome);
      const label = credentialResult.action === "check-password" ? "密码" : "登录";
      return `检测完成：${task.email} · ${label}：${reason}`;
    }
    if (task.error) return `检测失败：${task.email} · ${task.error}`;
    return `检测完成：${task.email}`;
  }
  const abnormal = tasks.filter(taskNeedsAttention).length;
  return `检测完成：${tasks.length} 个账号${abnormal ? `，${abnormal} 个需人工/异常` : "，全部正常"}`;
}

async function pollJob() {
  if (jobPolling || !jobId) return;
  jobPolling = true;
  syncRunButton();
  try { localStorage.setItem(LS.job, jobId); } catch (_) { /* ignore */ }
  while (jobId) {
    const res = await fetch(`/api/automation/jobs/${jobId}`).catch(() => null);
    if (res && res.ok) {
      const { job } = await res.json();
      renderJob(job);
      // 实时刷新账号库：引擎每完成一个动作就已写回库，这里逐轮拉取即可让
      // “每个账号一完成就显示最新检测状态”，无需等整个 job 跑完。
      await refreshAccountsSoft();
      // 添加手机号每个账号独立经历 reserved → pending → used/failed；同步刷新池便于查看并发数量
      // 就能看到号码已经被哪个账号领取、是否已确认生效或仍需人工处理。
      if ((job.actionIds || []).includes("add-2fa-phone")) await loadPhones({ skipIfEditing: true });
      if (job.status === "done" || job.status === "cancelled") {
        el("stopBtn").disabled = true;
        el("runStatus").textContent = completedJobText(job);
        clearJob(); // 进入终态：清掉 jobId 让 while 退出，轮询自动停止，不再空转
        break;
      }
    } else if (res && res.status === 404) {
      // job 已不存在（如服务重启丢失内存态）：停止轮询，避免无意义空转。
      clearJob();
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  jobPolling = false;
  syncRunButton();
}

// 页面刷新/重新进入时，若存在仍在运行的 job 则恢复实时轮询；否则清掉记录。
async function resumeJobIfAny() {
  let saved = "";
  try { saved = localStorage.getItem(LS.job) || ""; } catch (_) { saved = ""; }
  if (!saved) return;
  jobId = saved;
  syncRunButton();
  try {
    const res = await fetch(`/api/automation/jobs/${saved}`);
    if (!res.ok) { clearJob(); return; }
    const { job } = await res.json();
    renderJob(job);
    if (job.status === "running") {
      el("stopBtn").disabled = false;
      el("runStatus").textContent = "检测到运行中的任务，已恢复实时刷新";
      pollJob();
    } else {
      clearJob(); // 已是终态：不需要轮询了
    }
  } catch (_) {
    clearJob();
  }
}

// ---- 信用卡卡池 ----
const CARD_STATUS_TEXT = { unused: "未用", used: "已用", failed: "失败", disabled: "停用" };
const CARD_STATUS_CLASS = { unused: "s-unknown", used: "s-ok", failed: "s-bad", disabled: "s-mute" };
const CARD_STATUSES = ["unused", "used", "failed", "disabled"];
let cards = [];
let cardSelected = new Set();

function maskCard(num) {
  const s = String(num || "");
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)} •••• ${s.slice(-4)}`;
}

function cardEdit(c, field, value) {
  return `<span class="ec mono" contenteditable="true" data-id="${c.id}" data-cfield="${field}">${escapeHtml(value)}</span>`;
}

function filteredCards() {
  const f = el("cardFilter").value;
  return cards.filter((c) => !f || c.status === f);
}

function renderCards() {
  const rows = filteredCards();
  el("cardRows").innerHTML = rows.map((c, i) => {
    const opts = CARD_STATUSES.map((o) => `<option value="${o}"${o === c.status ? " selected" : ""}>${CARD_STATUS_TEXT[o]}</option>`).join("");
    return `<tr data-id="${c.id}">
      <td class="col-check"><input type="checkbox" data-cid="${c.id}"${cardSelected.has(c.id) ? " checked" : ""} /></td>
      <td class="muted">${i + 1}</td>
      <td><span class="ec mono" contenteditable="true" data-id="${c.id}" data-cfield="number" title="${escapeHtml(c.number)}">${escapeHtml(maskCard(c.number))}</span></td>
      <td>${cardEdit(c, "exp", c.exp)}</td>
      <td>${cardEdit(c, "cvc", c.cvc)}</td>
      <td>${cardEdit(c, "holder", c.holder)}</td>
      <td>${cardEdit(c, "zip", c.zip)}</td>
      <td>${cardEdit(c, "country", c.country)}</td>
      <td><select class="st ${CARD_STATUS_CLASS[c.status] || ""}" data-cid="${c.id}" data-cstatus="1">${opts}</select></td>
      <td class="muted nowrap">${escapeHtml(c.usedBy || "")}</td>
      <td>${cardEdit(c, "notes", c.notes)}</td>
      <td><button class="ghost danger slim card-del" data-cid="${c.id}">删</button></td>
    </tr>`;
  }).join("");
  el("cardTableWrap").hidden = cards.length === 0;
  el("cardEmptyHint").style.display = cards.length ? "none" : "block";
  el("cardBadge").textContent = `${cards.length} 张（未用 ${cards.filter((c) => c.status === "unused").length}）`;
  el("cardSelectAll").checked = rows.length > 0 && rows.every((c) => cardSelected.has(c.id));
}

async function loadCards() {
  try {
    const data = await api("/api/cards");
    cards = data.cards || [];
    renderCards();
  } catch (err) {
    el("cardImportStatus").textContent = err.message;
  }
}

async function cardPatch(id, body) {
  try {
    const data = await api(`/api/cards/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const idx = cards.findIndex((c) => c.id === id);
    if (idx >= 0 && data.card) cards[idx] = data.card;
  } catch (err) {
    el("cardImportStatus").textContent = `保存失败：${err.message}`;
  }
}

el("cardImportBtn").addEventListener("click", async () => {
  const text = el("cardImportText").value;
  if (!text.trim()) { el("cardImportStatus").textContent = "请粘贴卡信息"; return; }
  el("cardImportBtn").disabled = true;
  try {
    const data = await api("/api/cards/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    cards = data.cards || [];
    el("cardImportText").value = "";
    el("cardImportStatus").textContent = `新增 ${data.added}，重复跳过 ${data.dup}，共 ${data.total}` + (data.errors && data.errors.length ? `，${data.errors.length} 行无法识别` : "");
    renderCards();
  } catch (err) {
    el("cardImportStatus").textContent = err.message;
  } finally {
    el("cardImportBtn").disabled = false;
  }
});

el("cardDeleteBtn").addEventListener("click", async () => {
  if (!cardSelected.size) { el("cardImportStatus").textContent = "先勾选要删除的卡"; return; }
  if (!confirm(`确认删除选中的 ${cardSelected.size} 张卡？`)) return;
  await api("/api/cards/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...cardSelected] }) }).catch(() => {});
  cardSelected = new Set();
  await loadCards();
});

el("cardSelectAll").addEventListener("change", (e) => {
  const rows = filteredCards();
  if (e.target.checked) rows.forEach((c) => cardSelected.add(c.id)); else rows.forEach((c) => cardSelected.delete(c.id));
  renderCards();
});

el("cardFilter").addEventListener("change", renderCards);

el("cardRows").addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches('input[type="checkbox"]')) {
    const id = t.dataset.cid;
    if (t.checked) cardSelected.add(id); else cardSelected.delete(id);
    renderCards();
  } else if (t.matches("select[data-cstatus]")) {
    const id = t.dataset.cid;
    t.className = `st ${CARD_STATUS_CLASS[t.value] || ""}`;
    cardPatch(id, { status: t.value });
    const c = cards.find((x) => x.id === id);
    if (c) c.status = t.value;
  }
});

el("cardRows").addEventListener("blur", (e) => {
  const t = e.target;
  if (!t.matches(".ec")) return;
  const id = t.dataset.id;
  const field = t.dataset.cfield;
  const c = cards.find((x) => x.id === id);
  if (!c || !field) return;
  const value = t.textContent.trim();
  if (field === "number" && (value === maskCard(c.number) || value === c.number)) return;
  if (c[field] === value) return;
  cardPatch(id, { [field]: value });
}, true);

el("cardRows").addEventListener("keydown", (e) => {
  if (e.target.matches(".ec") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
});

el("cardRows").addEventListener("click", async (e) => {
  const del = e.target.closest(".card-del");
  if (!del) return;
  const id = del.dataset.cid;
  if (!confirm("删除这张卡？")) return;
  await api("/api/cards/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) }).catch(() => {});
  cardSelected.delete(id);
  await loadCards();
});

// ---- 两步验证手机号池 ----
const PHONE_STATUS_TEXT = {
  unused: "未用", reserved: "已占用", pending: "待生效 / 待确认", used: "已用", failed: "失败", disabled: "停用",
};
const PHONE_STATUS_CLASS = {
  unused: "s-unknown", reserved: "s-mute", pending: "s-bad", used: "s-ok", failed: "s-bad", disabled: "s-mute",
};
const PHONE_USAGE_MODE_TEXT = { shared: "共享号码", exclusive: "一号一绑" };
const PHONE_FALLBACK_MANUAL_STATUSES = {
  unused: ["unused", "used", "failed", "disabled"],
  reserved: ["reserved"],
  pending: ["pending"],
  used: ["used"],
  failed: ["failed", "unused", "disabled"],
  disabled: ["disabled", "unused", "failed"],
};
let phones = [];
let phoneSelected = new Set();

function normalizePhoneUsageMode(value) {
  return value === "exclusive" ? "exclusive" : "shared";
}

function phoneUsageMode(item) {
  return normalizePhoneUsageMode(item && item.usageMode);
}

function phoneBindingCount(item) {
  const count = Math.floor(Number(item && item.bindingCount));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function phoneActiveCount(item) {
  const count = Math.floor(Number(item && item.activeCount));
  if (Number.isFinite(count) && count > 0) return count;
  return item && (item.status === "reserved" || item.status === "pending") ? 1 : 0;
}

function phoneIsAvailable(item) {
  if (item && typeof item.available === "boolean") return item.available;
  // 兼容页面热更新期间尚未带 available 的旧 DTO；旧接口只有 unused 可领取。
  return !!(item && item.status === "unused");
}

function phoneStatusPresentation(item) {
  const mode = phoneUsageMode(item);
  const count = phoneBindingCount(item);
  const active = phoneActiveCount(item);
  if (item && item.status === "reserved" && item.submitIntentAt) {
    return { text: "提交状态待核对", cls: "s-bad" };
  }
  if (mode === "shared" && phoneIsAvailable(item)) {
    return { text: active ? `共享可用（并发 ${active}）` : `共享可用（已绑 ${count}）`, cls: "s-ok" };
  }
  if (mode === "exclusive" && item && item.status === "used") {
    return { text: "一号一绑·已用", cls: "s-ok" };
  }
  return {
    text: PHONE_STATUS_TEXT[item && item.status] || (item && item.status) || "未知",
    cls: PHONE_STATUS_CLASS[item && item.status] || "",
  };
}

function phoneHasBindings(item) {
  return !!(item && (phoneBindingCount(item) > 0 || item.status === "used"));
}

function phoneIsBusy(item) {
  return phoneActiveCount(item) > 0;
}

function phoneStatusOptionText(item, status, statusView) {
  const isSharedBound = phoneUsageMode(item) === "shared" && phoneHasBindings(item);
  if (isSharedBound && status === "disabled") {
    return status === item.status ? "已停用复用" : "停用复用";
  }
  if (isSharedBound && status === "used" && item.status === "disabled") {
    return "恢复共享可用";
  }
  if (status === item.status) return statusView.text;
  return PHONE_STATUS_TEXT[status] || status;
}

function readPhoneRunMode() {
  const select = el("phoneRunMode");
  return normalizePhoneUsageMode(select && select.value);
}

const storedPhoneRunMode = (() => {
  try { return localStorage.getItem(LS.phoneMode); } catch (_) { return null; }
})();
el("phoneRunMode").value = normalizePhoneUsageMode(storedPhoneRunMode);
el("phoneRunMode").addEventListener("change", () => {
  const value = readPhoneRunMode();
  el("phoneRunMode").value = value;
  try { localStorage.setItem(LS.phoneMode, value); } catch (_) { /* ignore */ }
});

function isEditingPhonePool() {
  const active = document.activeElement;
  const rows = el("phoneRows");
  return !!(active && rows && rows.contains(active)
    && active.matches('.ec[contenteditable="true"], select[data-phone-status], select[data-phone-mode]'));
}

function filteredPhones() {
  const filter = el("phoneFilter").value;
  return phones.filter((item) => !filter || item.status === filter);
}

function phoneDeleteProtected(item) {
  return phoneIsBusy(item);
}

function renderPhones() {
  const rows = filteredPhones();
  const byId = new Map(phones.map((item) => [item.id, item]));
  phoneSelected = new Set([...phoneSelected].filter((id) => byId.has(id) && !phoneDeleteProtected(byId.get(id))));
  el("phoneRows").innerHTML = rows.map((item, index) => {
    const allowed = Array.isArray(item.allowedStatuses) && item.allowedStatuses.length
      ? item.allowedStatuses : (PHONE_FALLBACK_MANUAL_STATUSES[item.status] || [item.status]);
    const statusView = phoneStatusPresentation(item);
    const options = allowed.map((status) => {
      const text = phoneStatusOptionText(item, status, statusView);
      return `<option value="${status}"${status === item.status ? " selected" : ""}>${escapeHtml(text)}</option>`;
    }).join("");
    const mode = phoneUsageMode(item);
    const modeOptions = Object.entries(PHONE_USAGE_MODE_TEXT).map(([value, text]) => (
      `<option value="${value}"${value === mode ? " selected" : ""}>${escapeHtml(text)}</option>`
    )).join("");
    const bindingCount = phoneBindingCount(item);
    const activeCount = phoneActiveCount(item);
    const statusDetail = item.lastError ? `<div class="muted" title="${escapeHtml(item.lastError)}">${escapeHtml(item.lastError)}</div>` : "";
    const masked = item.maskedNumber || `•••• ${escapeHtml(item.last4 || "")}`;
    const deleteProtected = phoneDeleteProtected(item);
    const hasBindings = phoneHasBindings(item);
    const sharedActive = mode === "shared" && phoneIsBusy(item);
    const actionButton = sharedActive
      ? `<button class="ghost slim phone-release" data-phone-id="${item.id}" title="紧急结束这个号码当前全部并发任务的本地占用">释放全部 ${activeCount} 个占用</button>`
      : item.status === "reserved" && !item.submitIntentAt
        ? `<button class="ghost slim phone-release" data-phone-id="${item.id}" title="仅释放未提交的旧占用；正在运行或已经提交的号码不会被释放">释放占用</button>`
      : item.status === "reserved"
        ? '<button class="ghost slim" disabled title="这个号码可能已经提交，请先核对 Google 页面结果">待核对</button>'
      : `<button class="ghost danger slim phone-del${hasBindings ? " phone-del-bound" : ""}" data-phone-id="${item.id}"${deleteProtected ? ' disabled title="号码正在等待 Google 确认，不能删除或释放"' : hasBindings ? ' title="删除本地记录（不会从 Google 解绑）"' : ""}>删</button>`;
    return `<tr data-id="${item.id}"${hasBindings ? ' class="phone-bound"' : ""}>
      <td class="col-check"><input type="checkbox" data-phone-id="${item.id}"${phoneSelected.has(item.id) ? " checked" : ""}${deleteProtected ? " disabled" : ""} /></td>
      <td class="muted">${index + 1}</td>
      <td><span class="mono" title="手机号已脱敏">${escapeHtml(masked)}</span></td>
      <td><select class="filter-select phone-mode-select" data-phone-id="${item.id}" data-phone-mode="1" title="切换号码的分配模式">${modeOptions}</select></td>
      <td><select class="st phone-status-select ${statusView.cls}" data-phone-id="${item.id}" data-phone-status="1"${allowed.length === 1 ? " disabled" : ""}>${options}</select></td>
      <td class="muted phone-binding-count" title="已成功绑定的账号数量">${bindingCount}</td>
      <td class="muted nowrap" title="${escapeHtml(item.usedBy || "")}">${escapeHtml(item.usedBy || "")}</td>
      <td><span class="ec" contenteditable="true" data-phone-id="${item.id}" data-phone-field="notes">${escapeHtml(item.notes || "")}</span>${statusDetail}</td>
      <td>${actionButton}</td>
    </tr>`;
  }).join("");
  el("phoneTableWrap").hidden = phones.length === 0;
  el("phoneEmptyHint").style.display = phones.length ? "none" : "block";
  const sharedAvailable = phones.filter((item) => phoneUsageMode(item) === "shared" && phoneIsAvailable(item)).length;
  const exclusiveUnused = phones.filter((item) => phoneUsageMode(item) === "exclusive" && phoneIsAvailable(item)).length;
  const active = phones.reduce((total, item) => total + phoneActiveCount(item), 0);
  el("phoneBadge").textContent = `${phones.length} 个（共享可用 ${sharedAvailable}，一号一绑未用 ${exclusiveUnused}${active ? `，执行中 ${active}` : ""}）`;
  const deletable = rows.filter((item) => !phoneDeleteProtected(item));
  el("phoneSelectAll").disabled = deletable.length === 0;
  el("phoneSelectAll").checked = deletable.length > 0 && deletable.every((item) => phoneSelected.has(item.id));
}

async function loadPhones(options = {}) {
  if (options.skipIfEditing && isEditingPhonePool()) return false;
  try {
    const data = await api("/api/phones");
    phones = data.phones || [];
    renderPhones();
    return true;
  } catch (err) {
    el("phoneImportStatus").textContent = err.message;
    return false;
  }
}

async function phonePatch(id, body) {
  try {
    const data = await api(`/api/phones/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const index = phones.findIndex((item) => item.id === id);
    if (index >= 0 && data.phone) phones[index] = data.phone;
    renderPhones();
    return true;
  } catch (err) {
    el("phoneImportStatus").textContent = `保存失败：${err.message}`;
    await loadPhones();
    return false;
  }
}

el("phoneImportBtn").addEventListener("click", async () => {
  const text = el("phoneImportText").value;
  const usageMode = normalizePhoneUsageMode(el("phoneImportMode").value);
  if (!text.trim()) { el("phoneImportStatus").textContent = "请粘贴带国家码的手机号"; return; }
  el("phoneImportBtn").disabled = true;
  try {
    const data = await api("/api/phones/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, usageMode }),
    });
    phones = data.phones || [];
    el("phoneImportText").value = "";
    el("phoneImportStatus").textContent = `${PHONE_USAGE_MODE_TEXT[usageMode]}：新增 ${data.added}，重复跳过 ${data.dup}，共 ${data.total}`
      + (data.errors && data.errors.length ? `，${data.errors.length} 行无法识别` : "");
    renderPhones();
  } catch (err) {
    el("phoneImportStatus").textContent = err.message;
  } finally {
    el("phoneImportBtn").disabled = false;
  }
});

el("phoneDeleteBtn").addEventListener("click", async () => {
  if (!phoneSelected.size) { el("phoneImportStatus").textContent = "先勾选要删除的手机号"; return; }
  const selectedItems = phones.filter((item) => phoneSelected.has(item.id));
  const boundCount = selectedItems.filter(phoneHasBindings).length;
  const warning = boundCount
    ? `确认删除选中的 ${selectedItems.length} 个手机号？\n其中 ${boundCount} 个已有绑定记录。只会删除本地手机号池记录，不会从 Google 账号解绑手机号。`
    : `确认删除选中的 ${selectedItems.length} 个手机号？`;
  if (!confirm(warning)) return;
  try {
    const data = await api("/api/phones/delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [...phoneSelected], ...(boundCount ? { forceBound: true } : {}) }),
    });
    phones = data.phones || [];
    phoneSelected = new Set();
    el("phoneImportStatus").textContent = boundCount
      ? `已删除 ${selectedItems.length} 条本地记录；Google 账号中的手机号未解绑`
      : `已删除 ${selectedItems.length} 个手机号`;
    renderPhones();
  } catch (err) {
    el("phoneImportStatus").textContent = err.message;
    await loadPhones();
  }
});

el("phoneSelectAll").addEventListener("change", (event) => {
  const rows = filteredPhones().filter((item) => !phoneDeleteProtected(item));
  if (event.target.checked) rows.forEach((item) => phoneSelected.add(item.id));
  else rows.forEach((item) => phoneSelected.delete(item.id));
  renderPhones();
});

el("phoneFilter").addEventListener("change", renderPhones);

el("phoneRows").addEventListener("change", async (event) => {
  const target = event.target;
  if (target.matches('input[type="checkbox"]')) {
    const id = target.dataset.phoneId;
    if (target.checked) phoneSelected.add(id); else phoneSelected.delete(id);
    renderPhones();
  } else if (target.matches("select[data-phone-mode]")) {
    const item = phones.find((entry) => entry.id === target.dataset.phoneId);
    const previous = phoneUsageMode(item);
    const next = normalizePhoneUsageMode(target.value);
    if (!item || previous === next) return;
    target.disabled = true;
    await phonePatch(target.dataset.phoneId, { usageMode: next });
  } else if (target.matches("select[data-phone-status]")) {
    const item = phones.find((entry) => entry.id === target.dataset.phoneId);
    const previous = item && item.status;
    const next = target.value;
    if (!item || !previous || previous === next) return;
    if ((previous === "reserved" || previous === "pending")
      && !confirm(`确认把这个${previous === "pending" ? "待生效/待确认" : "占用中"}的号码标记为“${PHONE_STATUS_TEXT[next] || next}”？这会终止当前占用，且不能直接恢复为未用。`)) {
      target.value = previous;
      return;
    }
    target.disabled = true;
    await phonePatch(target.dataset.phoneId, { status: next });
  }
});

el("phoneRows").addEventListener("blur", (event) => {
  const target = event.target;
  if (!target.matches(".ec[data-phone-field]")) return;
  const item = phones.find((entry) => entry.id === target.dataset.phoneId);
  const value = target.textContent.trim();
  if (!item || item.notes === value) return;
  phonePatch(item.id, { notes: value });
}, true);

el("phoneRows").addEventListener("keydown", (event) => {
  if (event.target.matches(".ec[data-phone-field]") && event.key === "Enter") {
    event.preventDefault();
    event.target.blur();
  }
});

el("phoneRows").addEventListener("click", async (event) => {
  const releaseButton = event.target.closest(".phone-release");
  if (releaseButton) {
    const item = phones.find((entry) => entry.id === releaseButton.dataset.phoneId);
    if (!item || !phoneIsBusy(item)) return;
    const shared = phoneUsageMode(item) === "shared";
    const activeCount = phoneActiveCount(item);
    const warning = shared
      ? `确认紧急释放这个共享号码当前全部 ${activeCount} 个本地占用？\n这会让仍在运行的对应任务失去手机号租约；正常批次无需手动释放。`
      : "确认释放这个未提交的旧占用？\n正在执行中的占用和已经点击 Google 保存的号码会被后端拒绝，不会误释放。";
    if (!confirm(warning)) return;
    releaseButton.disabled = true;
    try {
      const data = await api(`/api/phones/${item.id}/release-reservation`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedReservedAt: item.reservedAt,
          expectedActiveRevision: item.activeRevision,
          expectedActiveCount: activeCount,
        }),
      });
      const index = phones.findIndex((entry) => entry.id === item.id);
      if (index >= 0 && data.phone) phones[index] = data.phone;
      renderPhones();
      el("phoneImportStatus").textContent = shared
        ? `共享号码的 ${activeCount} 个占用已全部释放`
        : "旧占用已释放，这个号码可以继续使用";
    } catch (err) {
      el("phoneImportStatus").textContent = `释放失败：${err.message}`;
      await loadPhones();
    }
    return;
  }
  const button = event.target.closest(".phone-del");
  if (!button) return;
  const item = phones.find((entry) => entry.id === button.dataset.phoneId);
  if (!item || phoneIsBusy(item)) return;
  const hasBindings = phoneHasBindings(item);
  const warning = hasBindings
    ? "确认删除这个已绑定手机号的本地记录？\n这不会从 Google 账号解绑手机号。"
    : "确认删除这个手机号？";
  if (!confirm(warning)) return;
  try {
    await api("/api/phones/delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [button.dataset.phoneId], ...(hasBindings ? { forceBound: true } : {}) }),
    });
    phoneSelected.delete(button.dataset.phoneId);
    await loadPhones();
    el("phoneImportStatus").textContent = hasBindings
      ? "已删除本地记录；Google 账号中的手机号未解绑"
      : "已删除手机号";
  } catch (err) {
    el("phoneImportStatus").textContent = err.message;
  }
});

Promise.all([loadAccounts(), loadActions()])
  .then(() => resumeJobIfAny()) // 账号和操作都就绪后，再恢复旧任务并开放首次点击
  .then(() => { appReady = true; })
  .catch((err) => {
    el("importStatus").textContent = err.message;
    el("runStatus").textContent = "初始化失败，请刷新后重试";
  })
  .finally(() => { syncRunButton(); });
loadCards();
loadPhones();
// 仅在 AdsPower 模式下自动加载窗口/代理；本机模式不发起任何 AdsPower 请求。
if (currentMode() === "adspower") {
  loadEnvs();
  maybeAutoLoadTags();
}
// API Key 改了只在 AdsPower 模式重拉窗口和标签，本机模式不发 AdsPower 请求。
el("apiKey").addEventListener("change", () => {
  if (currentMode() !== "adspower") return;
  loadEnvs();
  proxyTagsLoaded = false;
  maybeAutoLoadTags();
});
