"use strict";

/**
 * 检测 Gmail / YouTube 是否被封禁 / 停用 / 限制 / 终止。
 *
 * 判定以「最终跳转的 hostname + path」为主，绝不在整段 url 里做子串匹配
 * （url 常带 continue=https://mail.google.com/... ，子串匹配会命中 continue 参数里的域名而误判）。
 *
 * 【为什么要重写 YouTube 判定 —— 假阴性根因】
 * 旧逻辑只做两件事：访问 youtube.com/account，匹配极窄的 terminated 文案；命不中就「只要还在
 * youtube.com 域名上 → 判 ok」。这是个兜底式 ok，会把下面这些异常统统当成正常（漏报）：
 *   1) 频道被「终止/Community Guidelines」封掉时，Google 账号本身没停用，
 *      youtube.com/account（账号设置页）照样能正常打开 → 文案里没有 terminated → 被判 ok。
 *      —— 频道终止的权威展示位是 YouTube Studio（studio.youtube.com），账号设置页看不出来。
 *      这就是某些账号「实际被封却判正常」的最可能原因。
 *   2) cookie 同意墙（consent.youtube.com，host 仍以 youtube.com 结尾）→ 被判 ok。
 *   3) 未登录时 youtube 首页 / 仅剩「登录」入口 → 被判 ok。
 *   4) 固定只等 2.5s，SPA 还没渲染出封禁横幅就读取 → 被判 ok。
 *   5) 文案正则只覆盖 terminated 一种、且基本只英文 → 中文/繁体/其它封禁形态全漏。
 *
 * 【加固思路】
 *   - ok 改为「正向确认」：必须在 youtube 自有域 + 已登录（头像按钮在）+ 无任何封禁特征，才判 ok。
 *   - 账号设置页看起来正常时，再去 YouTube Studio 确认频道是否被终止（频道封禁的权威页）。
 *   - 封禁文案大幅扩充：终止/停用/移除/封禁/「无法访问 Google 产品」帮助页，覆盖中(简/繁)英。
 *   - 处理 consent 同意墙、等页面真正渲染出可判定状态再读。
 *   - 任何「读不到真实页面 / 未登录 / 频道状态未确认」一律判 unknown（需人工），绝不当 ok
 *     —— 漏报（封号当正常卖出去）比误报危险得多。
 */

function loc(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { host: u.hostname.toLowerCase(), path: u.pathname.toLowerCase() };
  } catch (_) {
    return { host: "", path: "" };
  }
}

async function innerText(page) {
  return page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
}

const SIGNIN_PATHS = /(signin|servicelogin|accountchooser|\/v3\/signin)/i;

// consent（cookie 同意墙）所在域：host 仍以 youtube.com/google.com 结尾，不能当 ok。
const RE_CONSENT_HOST = /(^|\.)consent\.(youtube|google)\.com$/i;

function isYoutubeHost(host) {
  return /(^|\.)youtube\.com$/i.test(host);
}

/**
 * YouTube 封禁/终止/停用文案（频道终止常见多种措辞，且账号可能是中文/繁体/英文界面）。
 * 这些措辞只会出现在「出问题」的页面上，正常的账号设置页 / Studio 仪表盘不会出现，
 * 因此命中即视为封禁。
 */
const RE_YT_BANNED = new RegExp([
  // —— 英文：频道/账号被终止、移除、停用、封禁 ——
  "this account has been terminated",
  "account (?:has been|was) terminated",
  "your channel has been terminated",
  "channel (?:was|has been) (?:removed|terminated|suspended)",
  "(?:was|has been) removed because it violated",
  "violat(?:ed|ing|ion of)[\\s\\S]{0,80}?community guidelines",
  "(?:account|channel) (?:has been|was) suspended",
  "has been permanently (?:banned|disabled|suspended)",
  "account has been disabled",
  "unable to access a google product",
  // —— 英文：频道被移除 + 申诉页（channel-appeal 真实页的英文形态）——
  // 真机实测：被封频道访问 youtube.com/account / studio 会跳到 studio.youtube.com/channel-appeal，
  // 文案是「<频道名> has been removed from YouTube … doesn't follow our policies … submit an appeal」。
  "(?:has been|was|been) removed from youtube",
  "removed from youtube",
  "your channel[\\s\\S]{0,80}(?:has been|was) removed",
  "we'?ve removed (?:it|your channel|this channel)",
  "(?:doesn'?t|does not|don'?t) follow our[\\s\\S]{0,80}polic(?:y|ies)",
  "(?:start|submit|file|request) (?:your |an )?appeal",
  // —— 简体中文 ——
  "此帐[号户]已终止",
  "账[号户]已(?:被)?(?:终止|停用|封禁|永久停用|删除)",
  "频道已(?:被)?(?:终止|删除|停用|封禁)",
  "此频道(?:已|因)[\\s\\S]{0,12}(?:删除|终止)",
  "您的?账[号户]已(?:被)?停用",
  "已被永久停用",
  "(?:因|由于)违反[\\s\\S]{0,16}(?:社区准则|服务条款|使用条款)",
  "无法(?:访问|使用) ?google ?产品",
  // —— 简体中文：频道被移除 + 申诉（channel-appeal 真实页文案，真机实测命中）——
  // 真实文案：「TrendSec已从 YouTube 上移除」「为了保护社区，我们已将其移除。」「…并发起申诉」「…并提出申诉」
  // 旧正则只覆盖 终止/删除/停用/封禁/违反，漏了「移除」+「不符合…政策」这套措辞，且频道名会插在「已从」前面，
  // 导致 “频道已…移除” 这类锚定也命不中 —— 这正是历史漏报的根因。
  "已从\\s*youtube\\s*上(?:被)?移除",
  "已将(?:其|该?频道|你的?频道)移除",
  "频道[\\s\\S]{0,24}已(?:被)?(?:移除|下架)",
  "不符合(?:我们)?[\\s\\S]{0,40}政策[\\s\\S]{0,60}移除",
  "(?:发起|提出|进行)申诉",
  // —— 繁体中文 ——
  "此帳[號户]已終止",
  "帳[號户]已(?:被)?(?:終止|停用|封鎖|永久停用|刪除)",
  "頻道已(?:被)?(?:終止|刪除|停用|封鎖)",
  "已遭終止",
  "(?:因|由於)違反[\\s\\S]{0,16}(?:社群規範|社區規範|服務條款)",
  "無法存取 ?google ?產品",
  // —— 繁体中文：频道被移除 + 申诉 ——
  "已從\\s*youtube\\s*上(?:被)?移除",
  "已將(?:其|該?頻道|你的?頻道)移除",
  "頻道[\\s\\S]{0,24}已(?:被)?(?:移除|下架)",
  "(?:發起|提出|進行)申訴",
].join("|"), "i");

/**
 * 在页面里采集判定信号（一次 evaluate 拿全，省往返）：
 *   - text       body 文本（用于封禁文案匹配）
 *   - hasAvatar  右上角账号头像在 → 已登录（youtube 与 studio 选择器都覆盖）
 *   - signInLink 页面出现「登录」入口 / 指向 Google 登录的链接 → 未登录
 *   - consent    cookie 同意墙特征（拒绝/接受全部、before you continue、consent 表单/域名）
 * 任何异常都吞掉返回空信号，让上层据「最终 url + 是否超时」继续判。
 */
async function ytSignals(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : "";
    const q = (s) => document.querySelector(s);
    const hasAvatar = !!(
      q("#avatar-btn") ||
      q("button#avatar-btn") ||
      q("ytd-topbar-menu-button-renderer") ||
      q("#account-button") ||
      q("ytcp-icon-button#account-button") ||
      q("img.ytcp-img-shadow")
    );
    const anchors = Array.from(document.querySelectorAll("a"));
    const signInByHref = anchors.some((a) => /accounts\.google\.com\/(?:servicelogin|signin)/i.test(a.href || ""));
    const RE_SIGNIN_LABEL = /^(sign in|登录|登 录|登入|로그인|iniciar sesión)$/i;
    const clickables = Array.from(document.querySelectorAll('a,button,tp-yt-paper-button,ytd-button-renderer,yt-button-renderer,[role="button"]'));
    const signInByText = clickables.some((el) => RE_SIGNIN_LABEL.test((el.textContent || "").replace(/\s+/g, " ").trim()));
    const consent = /before you continue|reject all|accept all|i agree to|在继续前|继续前往\s*youtube|繼續前往\s*youtube|全部拒绝|拒绝全部|全部接受|接受全部|拒絕全部|接受全部/i.test(bodyText)
      || !!q('form[action*="consent"]')
      || /(^|\.)consent\./i.test(location.hostname);
    return { text: bodyText, hasAvatar, signInLink: signInByHref || signInByText, consent };
  }).catch(() => ({ text: "", hasAvatar: false, signInLink: false, consent: false }));
}

/**
 * 等页面真正渲染出「可判定」的状态再读，替代旧的固定 2.5s（读太早是漏报根因之一）。
 * 出现以下任一即可停止等待：封禁文案、已登录头像、登录入口、consent、或已跳离 youtube 自有域。
 */
async function waitYouTubeSettled(page, timeout = 16000) {
  const start = Date.now();
  let sig = await ytSignals(page);
  while (Date.now() - start < timeout) {
    const { host, path } = loc(page.url());
    // 落到 channel-appeal（频道申诉/被移除页）即已是确定的封禁态，立即停等。
    const onAppeal = host === "studio.youtube.com" && /\/channel[-_]?appeal/i.test(path);
    const settled = onAppeal || sig.hasAvatar || sig.signInLink || sig.consent
      || RE_YT_BANNED.test(sig.text)
      || (host && !isYoutubeHost(host));
    if (settled) break;
    await page.waitForTimeout(800);
    sig = await ytSignals(page);
  }
  return sig;
}

/** 尝试点掉 cookie 同意墙（接受/同意优先；点不到再试拒绝），让我们能读到真实页面。 */
async function dismissConsent(page) {
  return page.evaluate(() => {
    const RE = /^(accept all|i agree|agree|accept|reject all|continue|同意|全部接受|接受全部|我同意|继续|繼續|全部拒绝|拒绝全部|拒絕全部)$/i;
    const els = Array.from(document.querySelectorAll('button,tp-yt-paper-button,a,[role="button"],ytd-button-renderer,yt-button-renderer'));
    for (const el of els) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (RE.test(t)) { try { el.click(); return true; } catch (_) { return false; } }
    }
    return false;
  }).catch(() => false);
}

/** 打开某个 YouTube 相关地址，等渲染稳定，遇 consent 自动点一次再重读。返回 { url, text, hasAvatar, signInLink, consent }。 */
async function loadYouTube(page, url) {
  // 真机实测：从 Gmail 这类重型 SPA 直接跨站跳 YouTube 偶发导航中断(net::ERR_ABORTED)，
  // goto 抛错被吞后会卡在上一页（Gmail），导致 YouTube 被误判 unknown。
  // 对策：最多重试 3 次；每次先回 about:blank 脱离上一页，再 goto 目标，
  // 直到落到 youtube 自有域 / 已知判定域（账号停用、帮助页、登录页）才停。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) {
        try { await page.goto("about:blank", { timeout: 8000 }); } catch (_) { /* ignore */ }
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (_) {
      // 跳转/超时也继续：用当前真实状态判定，比抛错丢弃信息更有用。
    }
    const h = loc(page.url()).host;
    if (isYoutubeHost(h) || h === "accounts.google.com" || h === "support.google.com") break;
    await page.waitForTimeout(800);
  }
  let sig = await waitYouTubeSettled(page);
  if (sig.consent || RE_CONSENT_HOST.test(loc(page.url()).host)) {
    await dismissConsent(page);
    await page.waitForTimeout(1500);
    sig = await waitYouTubeSettled(page);
  }
  return { url: page.url(), ...sig };
}

/**
 * 纯判定函数（无副作用，便于用 mock 文案/状态做单测）。
 * @param {{url:string,text:string,hasAvatar:boolean,signInLink:boolean,consent:boolean}} obs
 * @param {"account"|"studio"} stage
 * @returns {{verdict:"banned"|"signin"|"consent"|"ok"|"unknown", detail:string}}
 */
function classifyYouTube(obs, stage) {
  const { host, path } = loc(obs.url);
  const text = obs.text || "";

  // 0) 频道被终止/移除的「权威跳转位」：真机实测被封频道访问 youtube.com/account 或 studio 首页，
  //    都会被重定向到 studio.youtube.com/channel-appeal（频道申诉页）。这是语言无关、最稳的封禁信号，
  //    放在最前面：哪怕文案没渲染出来 / 换了语言，只要落到这个 URL 就判 banned。
  if (host === "studio.youtube.com" && /\/channel[-_]?appeal/i.test(path)) {
    return { verdict: "banned", detail: "频道已被 YouTube 移除（跳转到频道申诉页 channel-appeal）" };
  }
  // 1) 整个 Google 账号被停用 → YouTube 必然不可用。
  if (host === "accounts.google.com" && /\/disabled\b|deniedsigninrejected/i.test(path)) {
    return { verdict: "banned", detail: "Google 账号已被停用(disabled)，YouTube 不可用" };
  }
  // 2) 封号后常跳到「无法访问 Google 产品」帮助页。
  if (host === "support.google.com" && /answer\/40039/i.test(path)) {
    return { verdict: "banned", detail: "跳转到「无法访问 Google 产品」帮助页，账号疑被停用" };
  }
  // 3) 文案命中：频道/账号终止、停用、移除、封禁（中简/繁/英）。
  if (RE_YT_BANNED.test(text)) {
    return { verdict: "banned", detail: stage === "studio" ? "YouTube Studio 显示频道已终止/被移除" : "页面显示账号/频道已终止/停用" };
  }
  // 4) consent 同意墙没过：读不到真实页面，绝不当正常。
  if (obs.consent || RE_CONSENT_HOST.test(host)) {
    return { verdict: "consent", detail: "被 cookie 同意墙拦截，未能读到真实页面" };
  }
  // 5) 未登录：youtube/account、studio 未登录会跳 Google 登录；或页面只剩「登录」入口。
  if ((host === "accounts.google.com" && SIGNIN_PATHS.test(path)) || (obs.signInLink && !obs.hasAvatar)) {
    return { verdict: "signin", detail: "未登录，无法判定（请先登录后再检测）" };
  }
  // 6) 正常：必须正向确认「在 youtube 自有域 + 已登录头像在」。
  if (isYoutubeHost(host) && obs.hasAvatar) {
    return { verdict: "ok", detail: "" };
  }
  // 7) Studio 在「账号没有频道」时会提示创建频道，账号本身正常 → 视为 ok。
  if (stage === "studio" && isYoutubeHost(host)
      && /create (?:a )?channel|create your channel|创建频道|建立頻道|get started/i.test(text)) {
    return { verdict: "ok", detail: "" };
  }
  // 8) 其余一律未知（加载中/异常页/陌生跳转）——宁可人工，绝不误判为正常。
  return { verdict: "unknown", detail: `无法判定，最终地址：${(obs.url || "").slice(0, 90)}` };
}

async function detectBan(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const result = { statusPatch: {}, detail: {}, outcome: "ok" };

  // ---- Gmail ----
  try {
    emit("checking_gmail");
    await page.goto("https://mail.google.com/mail/u/0/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const { host, path } = loc(page.url());
    const text = await innerText(page);

    const accountDisabled = host === "accounts.google.com" && /\/disabled\b|deniedsigninrejected/i.test(path);
    // 封号后常跳到「无法访问 Google 产品」帮助页，同样视为停用。
    const productBlocked = host === "support.google.com" && /answer\/40039/i.test(path);
    const serviceRestricted = host === "myaccount.google.com" && /\/restrictions\//i.test(path);
    const restrictedByText = /service restriction|access to (a|this) (service|feature) (has|is)|has been restricted|been used to send unwanted|spamming is a violation|unable to access a google product|服务限制|已被限制|发送垃圾内容|此帐号已被停用|account has been disabled|账号已被停用|无法(?:访问|使用) ?google ?产品/i.test(text);

    if (accountDisabled || productBlocked) {
      result.statusPatch.gmail = "banned";
      result.detail.gmail = "账号已被停用(disabled)";
    } else if (serviceRestricted || restrictedByText) {
      result.statusPatch.gmail = "banned";
      // 抓限制原因首句，便于人工判断是临时限制还是永久。
      const reason = (text.match(/(It looks like[^.]+\.|[^。\n]{0,40}(?:限制|垃圾)[^。\n]{0,40}。)/i) || [])[0];
      const reasonClean = reason ? reason.replace(/\s+/g, " ").trim().slice(0, 90) : "";
      result.detail.gmail = `Gmail 被限制/封禁${reasonClean ? "：" + reasonClean : ""}`;
    } else if (host === "mail.google.com") {
      // 正向确认：真正进到收件箱域名才算 ok（未登录会跳 accounts.google.com）。
      result.statusPatch.gmail = "ok";
    } else if (host === "accounts.google.com" && SIGNIN_PATHS.test(path)) {
      // 未登录无法判定，不写 ok 也不写 banned，保持现状（unknown）。
      result.detail.gmail = "未登录，无法判定(请先登录)";
    } else {
      result.detail.gmail = `无法判定，最终地址：${page.url().slice(0, 90)}`;
    }
  } catch (err) {
    result.detail.gmail = `检测失败：${err.message}`;
  }

  // ---- YouTube ----
  try {
    emit("checking_youtube");
    // 第一步：账号设置页。能查出「账号级停用 / 明确封禁文案 / 未登录 / consent」，
    // 并正向确认是否已登录。
    const acc = await loadYouTube(page, "https://www.youtube.com/account");
    const va = classifyYouTube(acc, "account");

    if (va.verdict === "banned") {
      result.statusPatch.youtube = "banned";
      result.detail.youtube = va.detail;
    } else if (va.verdict === "ok") {
      // 账号设置页正常 ≠ 频道没事：频道被终止时账号设置页照常打开，
      // 必须再去 YouTube Studio 确认频道状态（频道终止的权威展示位），否则漏报。
      emit("checking_youtube_studio");
      const stu = await loadYouTube(page, "https://studio.youtube.com/");
      const vs = classifyYouTube(stu, "studio");
      if (vs.verdict === "banned") {
        result.statusPatch.youtube = "banned";
        result.detail.youtube = vs.detail;
      } else if (vs.verdict === "ok") {
        result.statusPatch.youtube = "ok";
      } else {
        // Studio 没能确认频道健康（consent/未登录/异常页/超时）→ 宁可标未知，不当正常。
        result.statusPatch.youtube = "unknown";
        result.detail.youtube = `账号设置页正常，但 Studio 未能确认频道状态（${vs.detail}），需人工复核`;
      }
    } else {
      // signin / consent / unknown：一律 unknown（需人工），绝不当正常。
      result.statusPatch.youtube = "unknown";
      result.detail.youtube = va.detail;
    }
  } catch (err) {
    // 出错也不当正常：标未知，避免「检测失败」被当成 ok 卖出去。
    result.statusPatch.youtube = "unknown";
    result.detail.youtube = `检测失败：${err.message}`;
  }

  return result;
}

module.exports = detectBan;
// 暴露内部判定，便于用 mock 文案做单测（不影响引擎按函数调用）。
module.exports.classifyYouTube = classifyYouTube;
module.exports.RE_YT_BANNED = RE_YT_BANNED;
