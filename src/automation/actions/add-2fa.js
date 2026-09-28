"use strict";

// 首次设置验证器与 change-2fa 分开：没有本地密钥不能证明 Google 未设置验证器。
// 只点击明确的首次设置入口；保存密钥与开启两步验证是两个独立、分别复核的阶段。
const login = require("./login");
const totp = require("../../totp");
const { syncTime, accurateNow } = require("../time-sync");
const { sleep, visibleFirst, setValueViaJs } = login.helpers;

const AUTH_URL = "https://myaccount.google.com/two-step-verification/authenticator?hl=en";
const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/two-step-verification?hl=en";
const activeSetups = new Set();

function setupResult(state, detail, extra = {}) {
  const attention = state === "needs_attention" || state === "pending_activation";
  return {
    outcome: attention ? "need_verify" : state === "failed" ? "error" : "ok",
    detail: { add2fa: detail },
    fieldPatch: { lastTotpSetup: { state, detail, checkedAt: new Date().toISOString() } },
    ...(attention ? { keepOpen: true, handoff: true, stop: true } : {}),
    ...extra,
  };
}

// Snapshot 只接受精确 Google 设置页，密钥只在本动作内存/持久化 checkpoint 间传递。
// 不使用 change-2fa 的宽泛 Set up / Change / 输入框回退规则。
function inspectDocument() {
  const url = new URL(document.location.href);
  if (url.protocol !== "https:") return { kind: "other" };
  if (url.hostname === "accounts.google.com") return { kind: "reauth" };
  if (url.hostname !== "myaccount.google.com") return { kind: "other" };
  const kind = /^\/two-step-verification\/authenticator\/?$/.test(url.pathname) ? "authenticator"
    : /^\/(?:(?:signinoptions\/)?two-step-verification|signinoptions\/twosv)\/?$/.test(url.pathname) ? "two_step" : "other";
  // 仅 Google 账号站点的静态路径用于诊断跳转；不输出查询、片段或动态令牌。
  if (kind === "other") {
    const staticParts = new Set(["u", "signinoptions", "two-step-verification", "twosv", "authenticator", "enroll-welcome", "enroll", "security", "phone-numbers"]);
    return { kind, route: url.pathname.split("/").map((part) => staticParts.has(part) || /^\d{1,2}$/.test(part) ? part : part ? "_" : "").join("/").slice(0, 180) };
  }
  const rendered = (n) => {
    const r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || n.closest('[hidden]')) return false;
    for (let ancestor = n; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor);
      if (css.display === "none" || /^(?:hidden|collapse)$/.test(css.visibility) || css.opacity === "0") return false;
    }
    return true;
  };
  const visible = (n) => rendered(n) && !n.closest('[aria-hidden="true"]');
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const root = dialogs[0] || document.querySelector("main") || document.body;
  const text = norm(root.innerText);
  const wizard = dialogs.length === 1 && kind === "authenticator"
    && /authenticator|验证器|驗證器|인증 앱|scan.*QR|QR.*scan|扫描.*二维码/i.test(text);
  const turnOnRe = /^(?:Turn on 2-Step Verification|Turn on two-step verification|开启两步验证|启用两步验证|開啟兩步驟驗證|2단계 인증 사용 설정)[?？]?$/i;
  const activationHeading = /^(?:Turn on (?:2-Step|two-step) Verification|开启两步验证|启用两步验证|開啟兩步驟驗證|2단계 인증 사용 설정)(?:[?？.!。]|\s|$)/i;
  const activationTitle = /^(?:Turn on (?:2-Step|two-step) Verification|开启两步验证|启用两步验证|開啟兩步驟驗證|2단계 인증 사용 설정)[?？.!。]?$/i;
  const successTitleSource = "(?:(?:2-Step|two-step) Verification (?:is (?:now )?on|has been turned on)|(?:两步验证|兩步驟驗證)已(?:开启|启用|啟用|開啟)|2단계 인증(?:이)? (?:사용 설정|설정)되었습니다)";
  const activationSuccessTitle = new RegExp(`^${successTitleSource}[!.。]?$`, "i");
  const activationSuccess = new RegExp(`^${successTitleSource}(?:[!.。]|\\s|$)`, "i");
  // Google 的完成弹窗本身就是总开关已开启的确认，Done 只负责关掉提示。
  // 只用第一个可见语义标题分类，允许标题前有说明文字；不从后续标题或正文任意找成功词。
  // 有隐藏语义标题时也不把其 innerText 降级为无标题成功证据。
  const headingNodes = [...root.querySelectorAll('h1,h2,h3,[role="heading"]')];
  const headings = headingNodes.filter(visible);
  const headingText = headings.length ? norm(headings[0].innerText) : "";
  const noSemanticHeading = headingNodes.length === 0;
  const protectionConfirmed = headings.length
    ? /^You['’]re now protected with 2-Step Verification[!.]?$/i.test(headingText)
    : noSemanticHeading && /^You['’]re now protected with 2-Step Verification[!.]?(?:\s+When signing in you['’]ll be asked to complete the most secure second step(?:[,.]|\s|$)|\s+Done$|$)/i.test(text);
  const explicitActivationSuccess = protectionConfirmed || (headings.length > 0 && activationSuccessTitle.test(headingText));
  const successDialog = explicitActivationSuccess || (noSemanticHeading && activationSuccess.test(text));
  const confirmationDialog = headings.length ? activationTitle.test(headingText) : noSemanticHeading && activationHeading.test(text);
  const controls = [...root.querySelectorAll('button,[role="button"],a')].filter(visible);
  const label = (n) => norm(n.innerText) || norm(n.getAttribute("aria-label"));
  const skipPhoneRe = /^(?:Skip|跳过|略過|跳過|건너뛰기)$/i;
  const addPhoneRe = /^(?:Add phone|添加(?:手机|电话)号码|新增電話號碼|전화번호 추가)$/i;
  const noInputDialog = dialogs.length === 1 && kind === "two_step"
    && ![...root.querySelectorAll('input,select,textarea,[role="textbox"],[role="combobox"]')].some(visible);
  // 仅识别开启过程中明确可跳过的建议弹窗。不能跳过强制手机验证或泛化的 Skip。
  const optionalPhoneTitle = /^(?:Add a phone number for (?:2-Step|two-step) Verification[?？]|(?:要|是否)?(?:为|為)(?:两步验证|兩步驟驗證)添加(?:手机|电话|電話)(?:号码|號碼)(?:吗|嗎)?[?？])$/i;
  const optionalPhoneHeading = headings.length ? optionalPhoneTitle.test(headingText)
    : noSemanticHeading && /^(?:Add a phone number for (?:2-Step|two-step) Verification[?？]|(?:要|是否)?(?:为|為)(?:两步验证|兩步驟驗證)添加(?:手机|电话|電話)(?:号码|號碼)(?:吗|嗎)?[?？])(?:\s|$)/i.test(text);
  const optionalPhone = noInputDialog
    && optionalPhoneHeading
    && controls.filter((n) => skipPhoneRe.test(label(n))).length === 1
    && controls.filter((n) => addPhoneRe.test(label(n))).length === 1;
  // 普通确认/完成弹窗不允许包含手机/付款步骤；可选手机号建议使用上面的严格独立分支。
  const activationDialog = optionalPhone ? "optional_phone" : noInputDialog
    && !/(?:add|enter|confirm|verify).{0,32}(?:phone|card)|payment|billing|(?:添加|输入|确认|验证).{0,12}(?:电话|手机|信用卡)|付款|支付/i.test(text)
    ? successDialog ? "success" : confirmationDialog ? "confirm" : "unsupported"
    : dialogs.length ? "unsupported" : "";
  // 只信任顶部当前账号控件，不从正文/切换账号列表随意抓一个邮箱。
  const identities = new Set();
  for (const n of document.querySelectorAll('a,button,[role="button"]')) {
    const aria = norm(n.getAttribute("aria-label"));
    let profileLink = false;
    try {
      const href = new URL(n.getAttribute("href"), document.location.href);
      profileLink = href.protocol === "https:" && href.hostname === "accounts.google.com" && href.pathname === "/SignOutOptions";
    } catch (_) { /* not an account profile link */ }
    // Google 的设置模态框会把仍显示在背景中的账号栏标为 aria-hidden。
    // 这不代表换了账号：仅对此向导中仍渲染的当前头像读取身份，不放宽任何点击控件。
    const backgroundProfile = (wizard || ["confirm", "success", "optional_phone"].includes(activationDialog)) && profileLink && rendered(n)
      && n.getAttribute("aria-hidden") !== "true"
      && !n.closest('[role="dialog"], [role="menu"], [role="listbox"]');
    if (!visible(n) && !backgroundProfile) continue;
    if (!profileLink && !/^(?:Google Account|Google 帐号|Google 账号|Google 帳戶|Google 계정)\s*[:：]/i.test(aria)) continue;
    const matches = aria.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    if (matches.length === 1) identities.add(matches[0].toLowerCase());
  }
  const accountEmail = identities.size === 1 ? [...identities][0] : "";
  if (dialogs.length > 1) return { kind, accountEmail, blocked: true };
  const snapshotId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let serial = 0;
  const idFor = (n) => {
    if (!n || n.disabled || n.getAttribute("aria-disabled") === "true") return "";
    const id = `am-auth-${snapshotId}-${++serial}`;
    n.setAttribute("data-am-auth-control", id);
    return `[data-am-auth-control="${id}"]`;
  };
  // 保证每次快照的 selector 唯一；不能让旧快照的 id 指向其它按钮。
  document.querySelectorAll("[data-am-auth-control]").forEach((n) => n.removeAttribute("data-am-auth-control"));
  const exact = (re) => {
    const matches = controls.filter((n) => re.test(label(n)));
    return matches.length === 1 ? idFor(matches[0]) : "";
  };
  if (kind === "two_step") {
    // 已开启的明确反向操作仅用于读状态，绝不点击关闭按钮。
    const enabled = !dialogs.length && controls.some((n) => /^(?:Turn off 2-Step Verification|Turn off two-step verification|关闭两步验证|關閉兩步驟驗證|2단계 인증 사용 중지)$/i.test(label(n)));
    return {
      kind, accountEmail, enabled, route: url.pathname.replace(/\/$/, ""),
      dialog: activationDialog,
      activationConfirmed: activationDialog === "success" && explicitActivationSuccess,
      turnOn: !dialogs.length ? exact(turnOnRe) : "",
      confirmTurnOn: activationDialog === "confirm" ? exact(/^(?:Turn on(?: (?:2-Step|two-step) Verification)?|开启(?:两步验证)?|启用(?:两步验证)?|開啟兩步驟驗證|2단계 인증 사용 설정)[?？]?$/i) : "",
      dismiss: activationDialog === "success" ? exact(/^(?:Done|OK|Got it|完成|确定|確定|知道了|완료|확인)$/i) : "",
      skipPhone: activationDialog === "optional_phone" ? exact(skipPhoneRe) : "",
    };
  }
  const existingRe = /^(?:Change authenticator app|Change authenticator|Change your authenticator|Set up a different authenticator(?: app)?|Remove authenticator(?: app)?|更换(?:身份)?验证器|更改(?:身份)?验证器|重新设置(?:身份)?验证器|换用其他验证器(?: App)?|更換(?:身分)?驗證器|變更驗證器|인증 앱 변경)$/i;
  const existing = controls.some((n) => existingRe.test(label(n)))
    || /You won.?t be able to use your old authenticator|旧验证器将无法|舊驗證器將無法/i.test(text);
  const setup = !dialogs.length && !existing
    ? exact(/^(?:Set up authenticator(?: app)?|Add authenticator app|设置(?:身份)?验证器|添加(?:身份)?验证器|設定(?:身分)?驗證器(?:應用程式)?|인증 앱 설정)$/i) : "";
  const manual = wizard ? exact(/^(?:Can.?t scan it\??|Can.?t scan\??|无法扫描[？?]?|無法掃描[？?]?|手动输入|手動輸入|스캔할 수 없나요\??)$/i) : "";
  const next = wizard ? exact(/^(?:Next|Continue|下一步|繼續|다음)$/i) : "";
  const verify = wizard ? exact(/^(?:Verify|Confirm|验证|驗證|确认|確認|확인)$/i) : "";
  const inputs = wizard && verify ? [...root.querySelectorAll('input')].filter((n) => visible(n)
    && !n.disabled && /^(?:text|tel|number)$/.test(n.type || "text")) : [];
  const codeInput = inputs.length === 1 ? idFor(inputs[0]) : "";
  const secrets = new Set();
  if (wizard && !codeInput) {
    for (const n of root.querySelectorAll("strong,b,code,span,div,p")) {
      if (!visible(n)) continue;
      const s = norm(n.innerText);
      if (/^[a-z2-7]{4}(?: [a-z2-7]{4}){7}$/i.test(s) || /^[a-z2-7]{32}$/i.test(s)) secrets.add(s.replace(/ /g, "").toUpperCase());
    }
  }
  const codeRejected = wizard && /Wrong code|incorrect code|try again|验证码(?:有误|错误)|验证码不正确|인증 코드.*(?:잘못|틀)/i.test(text);
  // 保存后向导消失且有“刚刚添加”，或回到明确的“更换”状态，才算验证器保存成功。
  // runFlow 仅在本次提交之后读取 saved；已有验证器的初始页面只走 existing 分支。
  const saved = !dialogs.length && !setup && (existing || /Authenticator (?:app )?(?:has been )?added|Added just now|刚刚添加|剛剛新增|방금 추가/i.test(text));
  return { kind, accountEmail, existing, wizard, setup, manual, next, verify, codeInput, codeRejected, saved,
    secret: secrets.size === 1 ? [...secrets][0] : null };
}

async function runFlow(adapter, account) {
  let loginResult = null;
  let verifiedSecret = "";
  let submitted = false;
  let prepared = false;
  let activationStage = "";
  let activationPage = "unknown";
  let activationRoute = "";
  let activationReadFailed = false;
  let activationDialog = "";
  let activationIdentity = "unknown";
  let activationAction = "";
  let setupStage = "precheck";
  let lastProgress = "";
  let progressCount = 0;
  const stageLabels = { precheck: "检查已有密钥", login: "登录账号", opening: "打开验证器设置", setup: "打开首次设置向导", reading_key: "读取新密钥", entering_code: "填写验证器验证码", verifying_code: "确认密钥保存", activation: "开启两步验证" };
  const dialogLabels = { "": "无弹窗", confirm: "开启确认", optional_phone: "可跳过的手机号建议", success: "完成提示", unsupported: "未识别弹窗", blocked: "多个弹窗" };
  const actionLabels = { turn_on: "点击开启", confirm: "确认开启", optional_phone: "跳过可选手机号", success: "关闭完成提示" };
  const progress = () => {
    const data = { stage: setupStage, activationStage, page: activationPage, dialog: activationDialog,
      identity: activationIdentity, lastAction: activationAction, readFailed: activationReadFailed };
    const key = JSON.stringify(data);
    if (key === lastProgress || progressCount >= 40) return;
    lastProgress = key;
    progressCount += 1;
    // 仅发固定枚举，不发 DOM、邮箱、密钥、验证码或原始异常；日志故障不能影响密钥流程。
    try { if (adapter.emit) adapter.emit("totp_setup_progress", data); } catch (_) { /* diagnostic only */ }
  };
  const setSetupStage = (stage) => { setupStage = stage; progress(); };
  // 仅记录枚举状态，不记录网页正文、账号、密钥、验证码或会话 URL。
  const activationDiagnosis = () => {
    const stages = { opening: "打开两步验证页", locating: "查找开启按钮", clicking: "点击开启按钮", confirming: "确认开启结果", dialog: "处理开启确认", rechecking: "重新读取总开关状态" };
    const pages = { unknown: "页面尚未读到", two_step: "两步验证页", authenticator: "验证器页", reauth: "重新验证页", other: "其它页面" };
    return `${stages[activationStage] || "开启两步验证"}；${pages[activationPage]}${activationRoute ? ` ${activationRoute}` : ""}；${dialogLabels[activationDialog]}${activationAction ? `；最近操作：${actionLabels[activationAction]}` : ""}${activationReadFailed ? "；页面读取异常" : ""}`;
  };
  const finish = (state, detail) => {
    const r = setupResult(state, !verifiedSecret && ["needs_attention", "failed"].includes(state)
      ? `${detail}（阶段：${stageLabels[setupStage]}）` : detail);
    if (loginResult) {
      r.statusPatch = { ...(loginResult.statusPatch || {}) };
      r.fieldPatch = { ...(loginResult.fieldPatch || {}), ...r.fieldPatch };
    }
    // 即便后续总开关被拦，也不能丢弃已经被 Google 确认保存的验证器密钥。
    if (verifiedSecret) Object.assign(r.fieldPatch, { totpSecret: verifiedSecret, pendingTotpSetup: null });
    return r;
  };
  const pending = account.pendingTotpSetup;
  if (pending && pending.secret) return finish("needs_attention", "上次添加结果尚未确认，候选密钥已保留；请先核对原窗口，不会再次设置或替换验证器");
  const resumeActivation = !!account.totpSecret && account.lastTotpSetup?.state === "pending_activation";
  if (account.totpSecret && !resumeActivation) return finish("already_configured", "本地已有验证器密钥，已跳过，不更换现有验证器");
  // 重试开启总开关时，登录受阻也必须保留这个阶段，不能退回“已有密钥，直接跳过”。
  if (resumeActivation) verifiedSecret = account.totpSecret;
  const accountEmail = String(account.email || "").trim().toLowerCase();
  const scopedUrl = (url) => `${url}&authuser=${encodeURIComponent(accountEmail)}`;
  let reauthCount = 0;
  const observe = async (ready, { retainLast = false } = {}) => {
    let identityUnconfirmed = false;
    let lastConfirmed = {};
    const deadline = Date.now() + 30000;
    for (let i = 0; i < 20; i += 1) {
      if (Date.now() >= deadline) break;
      let s;
      try {
        s = await adapter.read();
      } catch (err) {
        // 点击或导航可能销毁旧文档，给新文档有界的重新读取机会。
        if (activationStage) activationReadFailed = true;
        lastConfirmed = {};
        progress();
        // 仅导航销毁上下文值得重读；关闭/协议超时等持久错误不循环等待。
        if (!/Execution context was destroyed|Cannot find context with specified id|Execution context is not available|Inspected target navigated/i.test(String(err && err.message))) throw err;
        await adapter.pause();
        continue;
      }
      activationPage = ["two_step", "authenticator", "reauth", "other"].includes(s.kind) ? s.kind : "unknown";
      activationRoute = typeof s.route === "string" && s.route.length <= 180
        && /^(?:\/(?:u|signinoptions|two-step-verification|twosv|authenticator|enroll-welcome|enroll|security|phone-numbers|_|[0-9]{1,2}))*\/?$/.test(s.route) ? s.route : "";
      activationReadFailed = false;
      activationDialog = s.blocked ? "blocked" : Object.prototype.hasOwnProperty.call(dialogLabels, s.dialog || "") ? (s.dialog || "") : "unsupported";
      if (s.kind === "reauth") {
        lastConfirmed = {};
        activationIdentity = "unknown";
        progress();
        if (!adapter.reauth || ++reauthCount > 2) throw new Error("manual");
        // 只传入已确认保存的密钥，不能将尚未验证的候选密钥用于再次登录。
        const r = await adapter.reauth(verifiedSecret ? { ...account, totpSecret: verifiedSecret } : account);
        if (!r || r.outcome !== "ok") throw new Error("manual");
      } else {
        if (s.kind === "authenticator" || s.kind === "two_step") {
          const currentEmail = String(s.accountEmail || "").trim().toLowerCase();
          activationIdentity = !currentEmail ? "missing" : currentEmail === accountEmail ? "matched" : "mismatch";
          progress();
          if (activationIdentity === "mismatch") throw new Error("identity_mismatch");
          if (!currentEmail) { identityUnconfirmed = true; lastConfirmed = {}; await adapter.pause(); continue; }
          // 页面切换期间的身份缺失不是永久错误；恢复匹配后必须清掉旧标记。
          identityUnconfirmed = false;
        } else {
          activationIdentity = "unknown";
          progress();
        }
        lastConfirmed = s;
        if (ready(s)) return s;
      }
      await adapter.pause();
    }
    if (identityUnconfirmed) throw new Error("identity_unconfirmed");
    return retainLast ? lastConfirmed : {};
  };
  try {
    setSetupStage("login");
    loginResult = await adapter.login();
    if (adapter.recordLoginResult) await adapter.recordLoginResult(loginResult);
    if (!loginResult || loginResult.outcome !== "ok") {
      return finish(resumeActivation ? "pending_activation" : loginResult?.outcome === "need_verify" ? "needs_attention" : "failed",
        resumeActivation ? "登录未通过，已保存的验证器仍待开启两步验证；具体原因见登录结果，可稍后重试"
          : "登录未通过，未开始添加验证器；具体原因见登录结果");
    }
    if (resumeActivation) {
      verifiedSecret = account.totpSecret;
    } else {
      setSetupStage("opening");
      await adapter.open(scopedUrl(AUTH_URL));
      let s = await observe((v) => v.kind === "authenticator" && (v.existing || v.setup || v.wizard));
      if (s.existing) return finish("already_configured", "Google 已有验证器，本地未保存其密钥；已跳过，不替换");
      // 初始就在一个未由本次动作打开的向导，不能证明这是首次添加。
      if (!s.setup || s.wizard) return finish("needs_attention", "没有确认到首次设置验证器入口，未作改动");
      setSetupStage("setup");
      await adapter.click(s.setup);
      s = await observe((v) => v.kind === "authenticator" && (v.existing || v.wizard));
      if (s.existing) return finish("already_configured", "Google 提示已有验证器，已停止，不替换");
      if (!s.wizard) return finish("needs_attention", "首次设置向导未打开，未提交新密钥");
      if (!s.secret && s.manual) {
        setSetupStage("reading_key");
        await adapter.click(s.manual);
        s = await observe((v) => v.kind === "authenticator" && (v.existing || (v.wizard && v.secret)));
      }
      if (s.existing) return finish("already_configured", "Google 提示正在更换已有验证器，已停止");
      const secret = String(s.secret || "").replace(/\s/g, "").toUpperCase();
      if (!/^[A-Z2-7]{32}$/.test(secret) || !s.next) return finish("needs_attention", "未识别到唯一的新验证器密钥或下一步按钮，未提交");
      setSetupStage("entering_code");
      await adapter.click(s.next);
      s = await observe((v) => v.kind === "authenticator" && (v.existing || (v.wizard && v.codeInput && v.verify)));
      if (s.existing || !s.codeInput || !s.verify) return finish("needs_attention", "未确认到新验证器验证码输入页，未提交");
      if (!adapter.checkpoint) return finish("failed", "没有可用的密钥持久化服务，未提交设置");
      const createdAt = new Date().toISOString();
      // 必须先落盘再提交。浏览器断开/进程退出后仍有候选密钥可恢复，且不会当正式密钥取码。
      await adapter.checkpoint({ pendingTotpSetup: { secret, stage: "prepared", createdAt } });
      prepared = true;
      const code = await adapter.code(secret);
      await adapter.type(s.codeInput, code);
      // 输入后重新读取，按钮可能重渲染；不复用旧选择器，也不按通用 Enter。
      s = await observe((v) => v.kind === "authenticator" && v.wizard && v.codeInput && v.verify);
      if (!s.verify || s.existing) return finish("needs_attention", "验证码已填写但确认按钮不可用，候选密钥已保留");
      await adapter.checkpoint({ pendingTotpSetup: { secret, stage: "submitted", createdAt } });
      submitted = true;
      setSetupStage("verifying_code");
      await adapter.click(s.verify);
      s = await observe((v) => v.kind === "authenticator" && (v.codeRejected || (v.saved && !v.wizard)));
      if (s.codeRejected) return finish("needs_attention", "Google 未接受新验证码，候选密钥已保留，未标记添加成功");
      if (!s.saved || s.wizard) return finish("needs_attention", "已提交新验证码，但保存结果未确认；候选密钥已保留，请核对原窗口");
      verifiedSecret = secret;
      await adapter.checkpoint({ totpSecret: secret, pendingTotpSetup: null,
        lastTotpSetup: setupResult("pending_activation", "验证器已保存，正在确认两步验证总开关").fieldPatch.lastTotpSetup });
    }

    setSetupStage("activation");
    activationStage = "opening";
    progress();
    let navigationFailed = false;
    try { await adapter.open(scopedUrl(TWO_STEP_URL)); }
    catch (_) { navigationFailed = true; }
    // goto 超时不能证明导航失败；必须在真实目标页核对身份与状态。
    activationStage = "locating";
    // observe 已核对当前账号；只有明确的总开关反向操作或 Google 完成弹窗可作成功证据。
    const isActivated = (s) => s.kind === "two_step" && !s.blocked
      && (s.enabled || (s.dialog === "success" && s.activationConfirmed === true));
    const dialogSelector = (s) => s.dialog === "confirm" ? s.confirmTurnOn : s.dialog === "success" ? s.dismiss
      : s.dialog === "optional_phone" ? s.skipPhone : "";
    // 已知弹窗可以先出现、再启用按钮。不要在第一帧拿不到按钮时直接结束。
    // 未知或多层弹窗仍停在原处，绝不拿普通继续/确认按钮作回退。
    const activationReady = (s) => s.kind === "two_step" && (isActivated(s) || s.blocked
      || s.dialog === "unsupported" || dialogSelector(s) || (!s.dialog && s.turnOn));
    let state = await observe(activationReady, { retainLast: true });
    if (!isActivated(state) && !state.turnOn && !["confirm", "success", "optional_phone"].includes(state.dialog)) return finish("pending_activation",
      `验证器已保存，未识别到可用的开启按钮（${activationDiagnosis()}${navigationFailed ? "；导航超时或中断" : ""}）；未改动总开关`);
    if (!isActivated(state) && state.turnOn) {
      // 只允许明确的开启按钮，不点击泛化的“继续”，不进入手机号/备份/付款流程。
      activationStage = "clicking";
      activationAction = "turn_on";
      progress();
      let clickFailed = false;
      try { await adapter.click(state.turnOn); }
      catch (_) { clickFailed = true; }
      // click 可能在服务端已成功后因页面切换报错，不能直接判失败或重复点。
      activationStage = "confirming";
      state = await observe((v) => activationReady(v) && (!v.turnOn || v.dialog || isActivated(v)), { retainLast: true });
      // 继续以页面状态为准；发生导航异常也不重复提交开启按钮。
      navigationFailed = navigationFailed || clickFailed;
    }
    // 开启可有一次确认、一次可选手机号建议和一次完成提示，各至多点击一次。
    const handledDialogs = new Set();
    for (let i = 0; i < 3 && !isActivated(state); i += 1) {
      // 已经出现并处理完成提示后，不接受倒退的确认页再次提交。
      if (handledDialogs.has("success") && state.dialog !== "success") break;
      const selector = dialogSelector(state);
      if (!selector || handledDialogs.has(state.dialog)) break;
      const handledDialog = state.dialog;
      handledDialogs.add(handledDialog);
      activationStage = "dialog";
      activationAction = handledDialog;
      progress();
      try { await adapter.click(selector); } catch (_) { navigationFailed = true; }
      activationStage = "confirming";
      state = await observe((v) => activationReady(v) && (isActivated(v) || v.blocked || (v.dialog && v.dialog !== handledDialog)), { retainLast: true });
    }
    // 反馈可能未刷新；仅重新打开一次设置页读状态，绝不因此再次点开启。
    // 不清走未知/未完成的确认弹窗，也不在持续读取错误后反复导航。
    if (!isActivated(state) && state.kind === "two_step" && !state.blocked
      && (!state.dialog || state.dialog === "success") && !activationReadFailed) {
      activationStage = "rechecking";
      try { await adapter.open(scopedUrl(TWO_STEP_URL)); } catch (_) { navigationFailed = true; }
      state = await observe(activationReady, { retainLast: true });
    }
    if (!isActivated(state)) return finish("pending_activation",
      `验证器已保存，${state.dialog ? "开启确认尚未完成" : "复核后仍未确认两步验证开启"}（${activationDiagnosis()}${navigationFailed ? "；导航或点击中断" : ""}）；保留原密钥，可重试`);
    // 已确认成功后，只尝试一次关闭完成提示；不再导航/重试开启，也不因 Done 失败降级。
    if (state.activationConfirmed && state.dismiss && !handledDialogs.has("success")) {
      try { await adapter.click(state.dismiss); } catch (_) { /* activation is already confirmed */ }
    }
    return finish("added", resumeActivation ? "两步验证已开启，原验证器密钥保持不变" : "身份验证器已添加，两步验证已开启，新密钥已保存");
  } catch (err) {
    // 不把页面异常原文写入日志：可能含 OTP、setup key 或 URL 会话参数。
    const manual = err && err.message === "manual";
    const identity = err && /^identity_/.test(err.message);
    const identityDetail = err && err.message === "identity_mismatch"
      ? "设置页账号与所选账号不一致，已停止操作" : "设置页账号身份暂未读到，已停止操作";
    // 登录结果与设置页身份核对是两个阶段，不能用后者覆盖已成功的登录记录。
    if (!loginResult) {
      loginResult = login.helpers.tagLogin({ outcome: "error", reasonCode: "other",
        detail: { login: "登录流程异常，未开始添加验证器" } });
      if (adapter.recordLoginResult) { try { await adapter.recordLoginResult(loginResult); } catch (_) { /* final patch still retains diagnosis */ } }
    }
    return finish(verifiedSecret ? "pending_activation" : (submitted || prepared || manual || identity) ? "needs_attention" : "failed",
      verifiedSecret ? `验证器密钥已保存，两步验证仍待确认（${activationDiagnosis()}；${identity ? identityDetail : manual ? "Google 要求额外身份验证" : "流程异常"}）；保留原密钥，可重试`
        : submitted ? "提交后流程中断，添加结果未确认；候选密钥已保留，请核对原窗口"
          : identity ? `${identityDetail}；请核对浏览器账号，未继续提交设置`
            : manual ? "Google 要求额外身份验证，已停止添加，需人工处理"
            : "添加流程未完成（页面或保存异常），未确认添加成功");
  }
}

async function addTotp(page, account, ctx = {}) {
  const key = account.id || String(account.email || "").toLowerCase();
  if (activeSetups.has(key)) return { outcome: "blocked", stop: true,
    detail: { add2fa: "该账号已有添加验证器任务，已跳过重复执行" } };
  activeSetups.add(key);
  try {
    return await runWithPage(page, account, ctx);
  } finally {
    activeSetups.delete(key);
  }
}

async function runWithPage(page, account, ctx) {
  const openLogin = ctx.openLoginPage || login.helpers.openLoginPage;
  const loginContext = { ...ctx, openLoginPage: async (currentPage, context) => {
    const opened = await openLogin(currentPage, context);
    if (opened && opened.page) {
      page = opened.page;
      if (ctx.session) ctx.session.page = page;
    }
    return opened;
  } };
  return runFlow({
    emit: ctx.emit,
    login: () => login(page, account, loginContext),
    recordLoginResult: ctx.recordLoginResult,
    checkpoint: ctx.checkpointTotpSetup,
    reauth: (verifiedAccount) => login.reauth(page, verifiedAccount || account, ctx),
    open: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1500);
    },
    read: () => page.evaluate(inspectDocument),
    click: async (selector) => {
      const button = await visibleFirst(page, [selector]);
      if (!button) throw new Error("control_missing");
      try { await button.click(); } finally { await button.dispose().catch(() => {}); }
      await sleep(1000);
    },
    type: async (selector, code) => {
      const input = await visibleFirst(page, [selector]);
      if (!input) throw new Error("input_missing");
      try {
        await input.click({ clickCount: 3 });
        await setValueViaJs(input, code);
        const value = await input.evaluate((n) => n.value);
        if (value !== code) throw new Error("input_failed");
      } finally { await input.dispose().catch(() => {}); }
      await sleep(500);
    },
    code: async (secret) => {
      await syncTime();
      const left = 30 - Math.floor(accurateNow() / 1000) % 30;
      if (left <= 12) await sleep((left + 1) * 1000);
      return totp.generate(secret, { now: accurateNow() }).code;
    },
    pause: () => sleep(1000),
  }, account);
}

module.exports = addTotp;
module.exports.helpers = { runFlow, inspectDocument, setupResult, AUTH_URL, TWO_STEP_URL };
