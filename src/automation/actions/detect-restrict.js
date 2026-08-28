"use strict";

/**
 * 检测账号是否存在「服务使用限制 / 封禁」（账号级处罚）。
 *
 * 背景：Google 有一个「查看服务使用限制」页（Review service usage limits），登录态下列出
 * 本账号被限制/封禁的 Google 服务。用户截图里：标题「查看服务使用限制」，正文「您对某项服务
 * 或功能的使用权限已受到限制…」，下面一张卡片：「Google云端平台 — 此账号曾使用…进行了违反
 * Google 政策的滥用活动。⊘ 整项服务完全无法使用 · 自 2023年11月21日起无法使用 · 提交申诉」。
 *
 * 权威入口（真机探测确认）：
 *   https://myaccount.google.com/restrictions
 *   —— /restrictions 是真实页面（未登录会跳 accounts.google.com 登录并带 continue=…restrictions），
 *      detect-ban.js 里也把「跳到 myaccount.google.com/restrictions/」当作 Gmail 被限制的信号。
 *      另一候选 /product-limits 实测硬 404，不用。
 *
 * 判定原则（对齐 detect-ban 的保守风格：读不到真实页面/歧义一律 unknown，不误报）：
 *   - restricted：页面出现「整项服务完全无法使用 / 自 X 起无法使用 / 违反 Google 政策 / 滥用活动 /
 *     提交申诉」等强信号（只会出现在真的有处罚的页面上），能识别出至少一条受限服务卡片。
 *   - ok：明确显示「未受到限制 / 没有任何限制 / not restricted」等；或已登录且成功打开限制页、
 *     页面渲染完成却没有任何受限信号（这个页面的用途就是列出限制，没列出即为无限制）。
 *   - unknown：未登录 / 跳去登录页 / 打不开 / 页面为空还在加载 / 歧义。
 *
 * 只读动作：只导航 + 读 DOM 文本，不做任何写操作。
 */

function loc(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { host: u.hostname.toLowerCase(), path: u.pathname.toLowerCase() };
  } catch (_) {
    return { host: "", path: "" };
  }
}

const SIGNIN_PATHS = /(signin|servicelogin|accountchooser|\/v3\/signin)/i;

/**
 * 「有服务被限制/封禁」的强信号（中英 + 尽量多语言回退）。
 * 这些措辞只会出现在真的有账号级处罚的限制页上，正常账号的限制页不会出现，命中即视为 restricted。
 */
const RE_RESTRICTED = new RegExp([
  // —— 简体中文（用户截图实际文案）——
  "整项服务完全无法使用",
  "部分功能(?:完全)?无法使用",
  "自[\\s\\S]{0,24}起(?:无法使用|(?:被)?限制)",
  "违反(?:了)? ?google ?政策",
  "违反[\\s\\S]{0,12}政策的?滥用",
  "滥用活动",
  "使用权限已(?:被|受到)?限制",
  "您对(?:某项|此)?服务或功能的使用权限已受到限制",
  "提交申诉",
  // —— 繁体中文 ——
  "整項服務完全無法使用",
  "自[\\s\\S]{0,24}起(?:無法使用|(?:被)?限制)",
  "違反(?:了)? ?google ?政策",
  "濫用活動",
  "使用權限已(?:被|受到)?限制",
  "提交申訴",
  // —— 英文 ——
  "your (?:access to|use of|usage of) (?:a|this|some|certain) (?:service|feature) (?:has been|is|was) (?:restricted|limited)",
  "(?:this|the) service is (?:entirely|completely|fully) unavailable",
  "(?:entirely|completely) unavailable(?: since)?",
  "unavailable since",
  "(?:restricted|limited) since",
  "abusive activity",
  "violat(?:ed|ing|ion of)[\\s\\S]{0,30}google[\\s\\S]{0,6}polic",
  "used[\\s\\S]{0,40}in violation of google",
  "submit (?:an )?appeal",
].join("|"), "i");

/**
 * 「明确无限制」文案（正常账号的限制页 / 空态）。命中即视为 ok。
 * 注意：restricted 强信号优先，避免「not restricted」里的 restricted 被误判。
 */
const RE_OK = new RegExp([
  // 简体
  "未受到(?:任何)?限制",
  "未(?:被)?限制",
  "没有(?:任何)?(?:使用)?限制",
  "不受(?:任何)?限制",
  "没有(?:发现|检测到)(?:任何)?(?:使用)?限制",
  "使用权限未受到限制",
  // 繁体
  "未受到(?:任何)?限制",
  "沒有(?:任何)?(?:使用)?限制",
  "使用權限未受到限制",
  // 英文
  "(?:your|the)[\\s\\S]{0,30}(?:isn'?t|is not|aren'?t|are not|not)[\\s\\S]{0,12}restricted",
  "no (?:service )?(?:usage )?restrictions",
  "you don'?t have any restrictions",
  "there are no restrictions",
  "not currently restricted",
].join("|"), "i");

/**
 * 在页面里一次性采集判定信号：
 *   - text        body 文本（用于文案匹配）
 *   - hasNav      myaccount 左侧/顶部导航或账号头像在 → 已登录、页面骨架渲染出来了
 *   - signInLink  出现指向 Google 登录的入口 → 未登录
 */
async function restrictSignals(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : "";
    const q = (s) => document.querySelector(s);
    const hasNav = !!(
      q('a[href*="myaccount.google.com"]') ||
      q('c-wiz[data-node-index]') ||
      q("header a[aria-label]") ||
      q('img[alt][src*="googleusercontent"]') ||
      q('[data-ogsr-up]') ||
      q('nav[role="navigation"]')
    );
    const anchors = Array.from(document.querySelectorAll("a"));
    const signInByHref = anchors.some((a) => /accounts\.google\.com\/(?:servicelogin|signin|v3\/signin|accountchooser)/i.test(a.href || ""));
    return { text: bodyText, hasNav, signInLink: signInByHref };
  }).catch(() => ({ text: "", hasNav: false, signInLink: false }));
}

/**
 * 等限制页真正渲染出「可判定」状态再读（c-wiz 异步渲染，读太早会漏）。
 * 出现以下任一即停等：受限强信号、无限制文案、已跳去登录页、或页面已有正文骨架。
 */
async function waitRestrictSettled(page, timeout = 15000) {
  const start = Date.now();
  let sig = await restrictSignals(page);
  while (Date.now() - start < timeout) {
    const { host, path } = loc(page.url());
    const onSignin = host === "accounts.google.com" && SIGNIN_PATHS.test(path);
    const settled = onSignin || sig.signInLink
      || RE_RESTRICTED.test(sig.text) || RE_OK.test(sig.text)
      || (host === "myaccount.google.com" && (sig.hasNav || (sig.text && sig.text.length > 200)));
    if (settled) break;
    await page.waitForTimeout(700);
    sig = await restrictSignals(page);
  }
  return sig;
}

/** 从限制页文本里尽量抽出「受限服务名 + 严重程度 + 自 X 起」等，方便人工核对。 */
function extractDetail(text) {
  const t = String(text || "");
  const parts = [];
  // 受限服务名：截图形态「此账号曾使用"Google云端平台"的系统功能进行了违反 Google 政策」。
  const svc = new Set();
  const reSvcQuote = /[“"]([^”"]{2,40})[”"]的(?:系统)?功能/g;
  let m;
  while ((m = reSvcQuote.exec(t)) !== null) svc.add(m[1].trim());
  // 严重程度标签。
  const severity = (t.match(/整项服务完全无法使用|整項服務完全無法使用|部分功能(?:完全)?无法使用|(?:entirely|completely) unavailable/i) || [])[0];
  // 自 X 起无法使用（日期）。
  const since = (t.match(/自\s*([0-9]{4}\s*年\s*[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*日|[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})\s*起/) || [])[1]
    || (t.match(/(?:restricted|unavailable) since\s*([A-Za-z0-9,\s]{4,20})/i) || [])[1];
  if (svc.size) parts.push(`受限服务：${Array.from(svc).join("、")}`);
  if (severity) parts.push(severity.replace(/\s+/g, ""));
  if (since) parts.push(`自 ${String(since).replace(/\s+/g, "")} 起无法使用`);
  return parts.join("；");
}

/**
 * 纯判定函数（无副作用，便于用 mock 文案/URL 做单测）。
 * @param {{url:string,text:string,hasNav:boolean,signInLink:boolean}} obs
 * @returns {{verdict:"restricted"|"ok"|"signin"|"unknown", detail:string}}
 */
function classifyRestrict(obs) {
  const { host, path } = loc(obs.url || "");
  const text = obs.text || "";

  // 1) 受限强信号优先（先于 ok 判，避免「未受到限制」这类里的字被误当受限；也避免被负向文案盖过）。
  if (RE_RESTRICTED.test(text)) {
    const extra = extractDetail(text);
    return { verdict: "restricted", detail: extra ? `账号存在服务使用限制/封禁：${extra}` : "账号存在服务使用限制/封禁（查看服务使用限制页列出了受限服务）" };
  }
  // 2) 未登录：跳到登录/选账号页，或页面只剩登录入口 → 无法判定。
  if ((host === "accounts.google.com" && SIGNIN_PATHS.test(path)) || (obs.signInLink && !obs.hasNav)) {
    return { verdict: "signin", detail: "未登录，无法判定（请先登录后再检测）" };
  }
  // 3) 明确无限制文案 → ok。
  if (RE_OK.test(text)) {
    return { verdict: "ok", detail: "" };
  }
  // 4) 已登录且成功停在限制页、页面渲染出正文却无任何受限信号 → 视为无限制（该页用途即列出限制）。
  if (host === "myaccount.google.com" && /\/restrictions\b/i.test(path) && (obs.hasNav || text.length > 200)) {
    return { verdict: "ok", detail: "" };
  }
  // 5) 其余（打不开/空白还在加载/陌生跳转）一律未知——宁可人工，绝不误判。
  return { verdict: "unknown", detail: `无法判定，最终地址：${(obs.url || "").slice(0, 90)}` };
}

/** 打开某个限制页地址，最多重试几次脱离上一页，等渲染稳定后返回观测 { url, text, hasNav, signInLink }。 */
async function loadRestrictions(page, url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) {
        try { await page.goto("about:blank", { timeout: 8000 }); } catch (_) { /* ignore */ }
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (_) {
      // 导航中断/超时也继续：用当前真实状态判定，比抛错丢弃信息更有用。
    }
    const h = loc(page.url()).host;
    if (h === "myaccount.google.com" || h === "accounts.google.com") break;
    await page.waitForTimeout(700);
  }
  const sig = await waitRestrictSettled(page);
  return { url: page.url(), ...sig };
}

async function detectRestrict(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const result = { statusPatch: {}, detail: {}, outcome: "ok" };

  // 权威入口 + 一个 /u/0/ 多登录回退（多会话时更稳）。/product-limits 实测 404，不做回退。
  const URLS = [
    "https://myaccount.google.com/restrictions",
    "https://myaccount.google.com/u/0/restrictions",
  ];

  try {
    emit("checking_restrict");
    let verdict = null;
    let obs = null;
    for (let i = 0; i < URLS.length; i += 1) {
      obs = await loadRestrictions(page, URLS[i]);
      verdict = classifyRestrict(obs);
      // 已能确定（restricted / ok / signin）就不再试回退；只有 unknown 才换下一个入口再试。
      if (verdict.verdict !== "unknown") break;
    }

    if (verdict.verdict === "restricted") {
      result.statusPatch.restrict = "restricted";
      result.detail.restrict = verdict.detail;
    } else if (verdict.verdict === "ok") {
      result.statusPatch.restrict = "ok";
    } else {
      // signin / unknown：一律 unknown（需人工），绝不当正常。
      result.statusPatch.restrict = "unknown";
      result.detail.restrict = verdict.detail;
    }
  } catch (err) {
    // 出错也不当正常：标未知。
    result.statusPatch.restrict = "unknown";
    result.detail.restrict = `检测失败：${err.message}`;
  }

  return result;
}

module.exports = detectRestrict;
// 暴露内部判定/正则，便于用 mock 文案做单测（不影响引擎按函数调用）。
module.exports.classifyRestrict = classifyRestrict;
module.exports.RE_RESTRICTED = RE_RESTRICTED;
module.exports.RE_OK = RE_OK;
module.exports.extractDetail = extractDetail;
