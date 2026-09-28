"use strict";

// Observe Google's Cloud Shell phone-verification branch. Never submit a number,
// send a code, start a trial, create a project, or change account security settings.
const CONSOLE_URL = "https://console.cloud.google.com/welcome/new?hl=zh-CN";
const PHONE_METHOD_RE = /^(?:验证您的电话号码|驗證您的電話號碼|verify your phone number|전화번호\s*인증)(?:\s|$)/i;
const { sleep } = require("./login").helpers;

function locationOf(url) {
  try { return new URL(url); } catch (_) { return { hostname: "", pathname: "" }; }
}
function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function unknown(reasonCode, detail, manual = false) {
  return { state: "unknown", reasonCode, detail, outcome: manual ? "need_verify" : "error", stop: true };
}

// Only localize the current verification page. Preserve its session, account,
// continuation and fragment; this does not change account language preferences.
function localizedChallengeUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (_) { return ""; }
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com"
      || !/(?:\/uplevelingstep\/selection\/?$|\/(?:v3\/signin|signin\/v2|signin)\/challenge\/)/i.test(url.pathname)
      || /^zh(?:-cn)?$/i.test(url.searchParams.get("hl") || "")) return "";
  url.searchParams.set("hl", "zh-CN");
  return url.href;
}

function classifyPhoneChallenge(snapshot, context = {}) {
  const { hostname, pathname, protocol } = locationOf(snapshot.url);
  if (protocol !== "https:" || hostname !== "accounts.google.com") return null;
  const text = normalize(snapshot.text);
  if (snapshot.hasCaptcha || /verify (?:that )?you are (?:a )?human|prove you.re not a robot|人机验证|证明您不是自动程序|验证您不是机器人|로봇이\s*아님|자동입력\s*방지|사람인지\s*확인/i.test(text)) {
    return unknown("captcha", "人机验证；原号检测未确认", true);
  }
  if (!context.phoneMethodSelected && !context.cloudVerificationStarted) return null;

  // A phone-scan challenge is a separate observation, not evidence that the
  // account has no phone. Match the full instructions, never a QR option in a
  // method chooser, an Authenticator enrollment QR, or a passkey QR.
  const qrRoute = /(?:\/(?:v3\/signin|signin\/v2|signin)\/challenge\/|\/uplevelingstep\/)/i.test(pathname);
  const scanWithPhone = /(?:使用|用)(?:您|你)?的?手机扫描(?:上方的?)?二维码|(?:使用|用)(?:您|你)?的?手機掃描(?:上方的?)?(?:二維碼|QR\s*碼)|scan (?:the |this )?qr code (?:with|using) your (?:mobile )?phone|use your (?:mobile )?phone to scan (?:the |this )?qr code|휴대(?:전화|폰)(?:으)?로\s*QR\s*코드를?\s*스캔/i.test(text);
  const returnToComputer = /(?:回到|返回|切换回).{0,12}(?:这台|此|这部)?(?:电脑|设备).{0,10}(?:继续|完成)|(?:回到|返回|切換回).{0,12}(?:這台|此|這部)?(?:電腦|裝置).{0,10}(?:繼續|完成)|(?:switch back|return|go back) to (?:this|your) (?:device|computer|pc).{0,30}(?:continue|complete|finish)|(?:이\s*(?:기기|컴퓨터)|컴퓨터)(?:로|에서).{0,20}(?:돌아|계속)/i.test(text);
  const phoneOption = (snapshot.controls || []).some((item) => !item.disabled && PHONE_METHOD_RE.test(normalize(item.label)));
  const requiresQr = qrRoute && scanWithPhone && returnToComputer && !phoneOption
      && !snapshot.hasPhoneInput && !snapshot.hasCodeInput
      && !/authenticator|身份验证器|身份驗證器|身分驗證器|通行密钥|通行金鑰|passkey|security key|安全密钥|安全金鑰|인증\s*앱|패스키|보안\s*키/i.test(text);
  const qrResult = () => unknown("qr_verification_required", "需扫码验证：Google 要求使用手机扫描二维码后继续；原号未确认，不能据此判断是否绑定手机号。未扫码、未填写号码或发送短信", true);
  if (!/\/(?:v3\/signin|signin\/v2|signin)\/challenge\//i.test(pathname)) return requiresQr ? qrResult() : null;

  // Strong old-number language must win even though both branches have a tel input.
  const original = /confirm (?:the |your )?phone number (?:that )?you (?:added|provided|previously added) to your account|enter (?:the |your )?phone number (?:associated with|registered (?:on|with)|you (?:added|provided) to) your account|(?:确认|確認|输入|輸入).{0,35}(?:您|你).{0,15}(?:添加|新增|绑定|綁定|关联|關聯).{0,15}(?:账号|帐号|帐户|帳戶|账户).{0,15}(?:电话|手机|電話)|(?:确认|確認|输入|輸入).{0,15}(?:原来|原來|原先|已绑定|已綁定|恢复|備援|recovery).{0,10}(?:手机|电话|電話)/i;
  const phoneText = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "");
  const maskedNumber = /[•●*·xX]{2,}[\s\-().•●*·xX]*\d{2,4}(?!\d)/.test(phoneText);
  const smsToExisting = maskedNumber && /\b(?:send|sent|text)\b.{0,55}\b(?:code|message|sms)\b.{0,55}\b(?:to|at)\b|\b(?:code|message)\b.{0,35}\b(?:sent|texted)\b.{0,25}\bto\b|(?:向|给|給|發送至|发送至).{0,45}(?:发送|發送|短信|簡訊|验证码|驗證碼)|(?:验证码|驗證碼|短信|簡訊).{0,35}(?:发送|發送).{0,15}(?:至|到)/i.test(phoneText);
  if (original.test(text) || smsToExisting) {
    return { state: "existing_phone_required", reasonCode: "existing_phone_required", detail: "需原号：Google 要求确认已添加的号码或使用已有号码收码；未输入号码、未请求验证码", outcome: "ok", stop: true };
  }
  if (snapshot.hasCodeInput) return unknown("verification_code_required", "已进入验证码页面，但无法确认号码来源；未填写验证码", true);
  if (requiresQr) return qrResult();
  const newPhoneText = /(?:请输入|請輸入)(?:一个|一個)?(?:电话|手机|電話)号码.{0,25}(?:短信|簡訊).{0,15}(?:验证码|驗證碼)|enter (?:a |your )?phone number.{0,60}(?:verification code|code by (?:text|sms))/i.test(text);
  const storageText = /google\s*(?:会存储|會儲存|将存储|將儲存)(?:此|该|這個)?号码|google will (?:store|save) (?:this|your) (?:phone )?number/i.test(text);
  if (context.phoneMethodSelected && snapshot.hasPhoneInput && !snapshot.hasCodeInput && newPhoneText && storageText) {
    return { state: "new_number_allowed", reasonCode: "new_number_allowed", detail: "可填新号：本次验证允许输入新号码；不代表从未绑定手机号。未填写、未发送短信", outcome: "ok", stop: true };
  }
  if (snapshot.hasPhoneInput) return unknown("ambiguous_phone_input", "出现号码输入框，但页面没有明确说明新号或原号；未确认", true);
  return null;
}

const CLOUD_HOSTS = new Set(["console.cloud.google.com", "shell.cloud.google.com", "ssh.cloud.google.com", "cloudshell.cloud.google.com"]);
function trustedScope(scope) {
  const loc = locationOf(scope.url);
  return loc.protocol === "https:" && (loc.hostname === "accounts.google.com" || CLOUD_HOSTS.has(loc.hostname));
}
function exactEmail(value) { return normalize(value).toLowerCase(); }

function cloudSetupText(text) {
  return /服务条款|服務條款|terms of service/i.test(text) && /国家\s*\/\s*地区|國家\s*\/\s*地區|country/i.test(text);
}
function cloudSetupPrompt(scope) {
  if (!cloudSetupText(normalize(scope.text))) return false;
  // The Cloud homepage can mention both terms and country in its background
  // text. Require the actual welcome dialog or its co-located form controls.
  const controls = scope.controls || [];
  const country = controls.some((item) => item.kind === "country");
  const terms = controls.some((item) => item.kind === "checkbox"
    && /google cloud|服务条款|服務條款|terms of service/i.test(normalize(item.label)));
  const continueSetup = controls.some((item) => item.kind === "button"
    && /^(?:同意并继续|同意並繼續|agree and continue)$/i.test(normalize(item.label)));
  return scope.setupDialog === true || (country && (terms || continueSetup)) || (terms && continueSetup);
}
function selectedCountry(raw) {
  const value = normalize(raw).replace(/^(?:country(?:\s*\/\s*region|\s+or\s+region)?|国家\s*\/\s*地区|國家\s*\/\s*地區)\s*[:：-]?\s*/i, "");
  if (/^(?:select|choose|选择|選擇|請選擇|请选择|country|region|国家|國家|地区|地區)(?:\b|\s|$)/i.test(value)) return "";
  return value;
}
function cloudVerificationPrompt(text) {
  return /verify your account to start using cloud shell|(?:验证|驗證).{0,15}(?:账号|帐号|账户|帳號|帳戶).{0,30}cloud shell/i.test(text);
}
function cloudAuthorizationPrompt(text) {
  const title = /authori[sz]e\s+(?:google\s+)?cloud shell|(?:为|為)\s*(?:google\s+)?cloud shell\s*(?:提供)?授[权權]|授[权權]\s+(?:google\s+)?cloud shell/i.test(text);
  const credentials = /cloud shell needs permission to use your credentials|cloud shell.{0,50}(?:权限|權限).{0,50}(?:凭证|凭据|憑證|憑據)/i.test(text);
  return title && credentials;
}
function cloudDisabledMessage(text) {
  // Match an explicit statement about this service, not a disabled project,
  // a failed connection, or an account's eligibility for the service.
  return /\bcloud shell(?:\s+(?:access|service|account))?\s+(?:(?:is|was|has been)\s+)?(?:(?:temporarily|permanently)\s+)?(?:disabled|suspended|banned)\b/i.test(text)
    || /cloud shell\s*(?:服务|服務|访问权限|存取權限|账号|帳戶)?\s*(?:已|已经|已經|现已|現已)(?:被)?(?:停用|暂停|暫停|禁用|封禁|停权|停權)/i.test(text)
    || /(?:已|已经|已經|现已|現已)(?:被)?(?:停用|暂停|暫停|禁用|封禁)\s*(?:(?:您|你)的)?\s*(?:google\s+)?cloud shell/i.test(text);
}
function cloudUnavailableMessage(text) {
  // Do not match a distant "disabled" anywhere in the document: that also
  // matched "Cloud Shell is not disabled" and unrelated project warnings.
  return /\bcloud shell\s+(?:is\s+)?(?:temporarily\s+)?not available\b|\bcloud shell\s*:\s*(?:this|your)\s+account is not eligible\b|\b(?:not eligible|ineligible)\s+(?:to\s+(?:use|access)|for)\s+(?:google\s+)?cloud shell\b/i.test(text)
    || /(?:不支持|无法使用|無法使用|不符合资格|不符合資格).{0,30}(?:google\s+)?cloud shell|cloud shell\s*(?:暂时|暫時)?(?:不可用|无法使用|無法使用)/i.test(text);
}
function cloudScopePriority(scope) {
  if (!CLOUD_HOSTS.has(locationOf(scope.url).hostname)) return 10;
  const text = normalize(scope.text);
  // Use the actual prompt, not iframe order or a parent's dialog attribute:
  // dialog content can live in a child frame without role=dialog of its own.
  if (scope.hasCaptcha) return 1;
  if (cloudSetupPrompt(scope)) {
    // A frame with the complete form wins over a parent dialog whose controls
    // have not hydrated yet; never click a background Cloud control instead.
    const controls = scope.controls || [];
    return controls.some((item) => item.kind === "country")
      && controls.some((item) => item.kind === "checkbox")
      && controls.some((item) => /^(?:同意并继续|同意並繼續|agree and continue)$/i.test(normalize(item.label))) ? 2 : 2.5;
  }
  if (cloudVerificationPrompt(text)) return 3;
  if (cloudAuthorizationPrompt(text)) return 4;
  if (scope.cloudCallout) return 5;
  return 10;
}

async function runFlow(adapter, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 150000);
  const clicked = new Set();
  const missingControls = new Map();
  const localeAttempts = new Set();
  const localePending = new Map();
  const selectionMisses = new Map();
  const calloutStates = new Map();
  let countryPendingReads = 0;
  let setupControlPendingReads = 0;
  let unavailablePolls = 0;
  const context = { phoneMethodSelected: false, cloudVerificationStarted: false };
  let lastStage = "等待 Cloud 控制台";
  const emit = (detail) => { if (adapter.emit) adapter.emit("checking_cloud_phone", { detail }); };
  const localize = async (scope) => {
    const key = locationOf(scope.url).pathname;
    if (localeAttempts.has(key) || !localizedChallengeUrl(scope.url) || !adapter.localize) return false;
    // Even a timeout can mean navigation was dispatched; never reload in a loop.
    localeAttempts.add(key);
    emit("将当前验证页显示切换为简体中文（不修改账号语言）");
    try { if ((await adapter.localize(scope.id)) === false) return false; } catch (_) { /* reobserve after possible navigation */ }
    localePending.set(key, { polls: 0, deadline: Date.now() + 8000 });
    return true;
  };
  const awaitingLocale = (scope) => {
    const key = locationOf(scope.url).pathname;
    const pending = localePending.get(key);
    if (!pending) return false;
    // DOMContentLoaded can precede translated form hydration. Observe briefly,
    // without another navigation or submitting the still-visible phone form.
    if (++pending.polls <= 5 && Date.now() < pending.deadline) return true;
    localePending.delete(key);
    return false;
  };
  const once = async (scope, control, stage) => {
    if (clicked.has(stage)) return false;
    if (!control || control.disabled) return false;
    // Mark before clicking: a navigation timeout must not cause a duplicate write.
    clicked.add(stage);
    lastStage = stage;
    emit(stage);
    try {
      if (!await adapter.click(scope.id, control.id)) {
        // Adapter reports false only before dispatch: hydration can replace the
        // element between observation and lookup. Reobserve a bounded 3 times.
        const count = (missingControls.get(stage) || 0) + 1;
        missingControls.set(stage, count);
        if (count < 3) clicked.delete(stage);
        return false;
      }
    } catch (_) {
      // A click/navigation timeout may still have advanced the page. Never click
      // again; observe the resulting UI before deciding this action failed.
    }
    return true;
  };
  try {
    emit(lastStage);
    await adapter.open(CONSOLE_URL);
    for (let poll = 0; poll < (options.maxPolls || 90) && Date.now() < deadline; poll += 1) {
      const scopes = (await bounded(adapter.snapshots(), Math.min(15000, Math.max(1, deadline - Date.now())))).filter(trustedScope);
      let acted = false;
      let setupObserved = false;
      // Account challenges and Cloud prompts outrank background frames. A red
      // eligibility banner behind a Verify/Authorize modal is not the result.
      const scopePriority = (scope) => locationOf(scope.url).hostname === "accounts.google.com" ? 0 : cloudScopePriority(scope);
      scopes.sort((a, b) => scopePriority(a) - scopePriority(b));
      const activeCloudPriority = Math.min(10, ...scopes.map(cloudScopePriority));
      const blockingCloudScopes = new Set(scopes.filter((scope) => activeCloudPriority < 10
        && cloudScopePriority(scope) === activeCloudPriority));
      const verificationPending = scopes.some((scope) => {
        const { hostname, pathname } = locationOf(scope.url);
        return hostname === "accounts.google.com" && /\/(?:challenge|uplevelingstep)\//i.test(pathname);
      });
      let unavailableObserved = false;
      for (const scope of scopes) {
        const { hostname, pathname } = locationOf(scope.url);
        const text = normalize(scope.text);
        const controls = scope.controls || [];
        const control = (re, kind) => controls.find((c) => !c.disabled && (!kind || c.kind === kind) && re.test(normalize(c.label)));
        if (hostname === "accounts.google.com") {
          const chooser = controls.filter((c) => c.kind === "account");
          if (chooser.length) {
            const match = chooser.find((c) => exactEmail(c.label) === exactEmail(options.accountEmail));
            if (!match) return unknown("account_mismatch", "账号选择器中未找到当前账号；未选择其它账号", true);
            acted = await once(scope, match, "选择当前账号");
            break;
          }
          const shownEmails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
          if (shownEmails.length && options.accountEmail && !shownEmails.some((mail) => exactEmail(mail) === exactEmail(options.accountEmail))) {
            return unknown("account_mismatch", "验证页显示的账号与当前任务不一致；已停止", true);
          }
          const result = classifyPhoneChallenge(scope, context);
          if (result) {
            if (result.reasonCode === "ambiguous_phone_input" && (await localize(scope) || awaitingLocale(scope))) { acted = true; break; }
            return result;
          }
          if (/\/uplevelingstep\/selection\/?$/.test(pathname) && context.cloudVerificationStarted) {
            const method = control(PHONE_METHOD_RE);
            if (method && !clicked.has("选择电话验证")) {
              acted = await once(scope, method, "选择电话验证");
              context.phoneMethodSelected = true;
            }
            if (acted) break;
            if (!method && !context.phoneMethodSelected) {
              const misses = (selectionMisses.get(pathname) || 0) + 1;
              selectionMisses.set(pathname, misses);
              if (misses >= 3 && await localize(scope)) { acted = true; break; }
            }
          } else if (/\/challenge\//.test(pathname)) {
            // Never call the normal login/reauth driver here: it could submit a code.
            if (scope.hasPhoneInput || scope.hasCodeInput || /check your phone|google prompt|查看您的|安全密钥|security key|authenticator|身份验证器|验证您的身份|verify it.s you/i.test(text)) {
              return unknown("other_verification", "要求其它身份验证，原号检测未确认；未继续验证", true);
            }
            if (context.cloudVerificationStarted && await localize(scope)) { acted = true; break; }
          } else if (/\/signin|\/ServiceLogin/i.test(pathname) && /password|email|密码|电子邮件|邮箱/i.test(text)) {
            return unknown("login_required", "尚未登录 Google；请先运行登录账号，再检测", true);
          }
          continue;
        }
        // An unresolved verification popup also blocks background Cloud actions
        // and terminal status; a ready background terminal cannot skip it.
        if (verificationPending) continue;
        if (blockingCloudScopes.size && !blockingCloudScopes.has(scope)) continue;
        if (scope.hasCaptcha) return unknown("captcha", "人机验证；原号检测未确认", true);
        if (hostname === "console.cloud.google.com" && scope.cloudCallout) {
          // Informational Cloud coachmarks are not security/terms dialogs. Only
          // their positively identified, local close control may be dismissed.
          const key = scope.cloudCallout.key;
          if (!calloutStates.has(key)) {
            if (calloutStates.size >= 5) return unknown("cloud_callout_blocked", "Cloud 新手提示反复出现；已停止，未继续验证", true);
            calloutStates.set(key, { stage: `关闭 Cloud 新手提示（${calloutStates.size + 1}）`, polls: 0 });
          }
          const state = calloutStates.get(key);
          if (++state.polls > 8) return unknown("cloud_callout_blocked", "Cloud 新手提示未能关闭；请关闭提示后重试", true);
          const close = controls.find((item) => item.id === scope.cloudCallout.closeControlId);
          acted = await once(scope, close, state.stage);
          // Always reobserve: never click a header control from behind a dialog,
          // or repeat a dispatched close while the disappearance animates.
          break;
        }
        // Only the Cloud welcome dialog's terms checkbox may be accepted, opt-in.
        if (cloudSetupPrompt(scope)) {
          setupObserved = true;
          if (!options.acceptTerms) return unknown("cloud_setup_required", "首次使用 Cloud：请手动完成地区/条款，或勾选首次 Cloud 使用设置", true);
          const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
          if (!options.accountEmail || !emails.some((mail) => exactEmail(mail) === exactEmail(options.accountEmail))) {
            return unknown("account_mismatch", "Cloud 首次使用页未确认当前账号，未同意条款", true);
          }
          const countries = controls.filter((c) => c.kind === "country" && !c.disabled);
          const countryValue = countries.length === 1
            ? selectedCountry(countries[0].value || countries[0].label) : "";
          if (!countryValue) {
            // The default region can appear after the dialog itself. Reobserve
            // a few times before asking for manual input; never select a region.
            if (++countryPendingReads < 6) {
              emit("等待 Cloud 已选地区加载（未代选国家）");
              acted = true;
              break;
            }
            return unknown("country_required", "Cloud 地区选择未确认：等待加载后仍未读到唯一已选地区；未代选国家", true);
          }
          countryPendingReads = 0;
          const termsChoices = controls.filter((item) => item.kind === "checkbox"
            && /google cloud|服务条款|服務條款|terms of service/i.test(normalize(item.label)));
          const agreeChoices = controls.filter((item) => item.kind === "button"
            && /^(?:同意并继续|同意並繼續|agree and continue)$/i.test(normalize(item.label)));
          if (termsChoices.length !== 1 || agreeChoices.length !== 1
              || termsChoices[0].disabled || (termsChoices[0].checked && agreeChoices[0].disabled)) {
            if (++setupControlPendingReads < 6) {
              emit("等待 Cloud 条款表单加载（未同意条款）");
              acted = true;
              break;
            }
            return unknown("cloud_setup_required", "Cloud 首次使用表单未提供唯一可操作的条款控件；未同意条款", true);
          }
          setupControlPendingReads = 0;
          if (!termsChoices[0].checked) {
            acted = await once(scope, termsChoices[0], "勾选 Cloud 服务条款");
          } else {
            acted = await once(scope, agreeChoices[0], "同意 Cloud 条款并继续");
          }
          if (acted) break;
          continue;
        }
        if (cloudVerificationPrompt(text)) {
          const verify = control(/^(?:verify|验证|驗證)$/i);
          if (verify && !clicked.has("打开 Cloud 身份验证")) {
            acted = await once(scope, verify, "打开 Cloud 身份验证");
            context.cloudVerificationStarted = true;
          }
          if (acted) break;
          continue;
        }
        if (cloudAuthorizationPrompt(text)) {
          return { ...unknown("cloud_authorization_required", "Cloud Shell 要求 API 授权，未出现电话验证；原号未确认，未授权 API 访问"), outcome: "ok" };
        }
        // Require an explicit disabled/suspended statement tied to Cloud Shell.
        // Eligibility and temporary availability errors do not establish a ban.
        if (cloudDisabledMessage(text) && !context.cloudVerificationStarted) {
          return unknown("cloud_disabled", "Cloud Shell 已停用：页面明确提示服务已停用、暂停或封禁；原号未确认，不能据此判断是否绑定手机号");
        }
        if (cloudUnavailableMessage(text) && !context.cloudVerificationStarted) {
          unavailableObserved = true;
          // Cloud can paint the error panel before hydrating a verification
          // dialog. Reobserve briefly; never click controls behind that panel.
          continue;
        }
        if (scope.terminalReady) return { ...unknown("no_challenge", "Cloud Shell 可直接使用，本次无需电话验证；原号未确认，不能据此判断是否绑定手机号"), outcome: "ok" };
        if (/cloud shell/i.test(text) && /manage your infrastructure|cloud shell is free|管理您的基础架构|cloud sdk|cloud shell.*免费/i.test(text)) {
          acted = await once(scope, control(/^(?:continue|继续|繼續)$/i), "继续 Cloud Shell");
          if (acted) break;
        }
        const shell = control(/^(?:(?:activate|open|launch|start) cloud shell|(?:激活|啟用|启用|打开|開啟|启动)\s*cloud shell|cloud shell)(?:\s*\([^)]*\))?$/i);
        if (hostname === "console.cloud.google.com" && shell && !clicked.has("打开 Cloud Shell")) {
          acted = await once(scope, shell, "打开 Cloud Shell");
          if (acted) break;
        }
      }
      unavailablePolls = unavailableObserved && !acted && !verificationPending && !blockingCloudScopes.size ? unavailablePolls + 1 : 0;
      if (!setupObserved) {
        countryPendingReads = 0;
        setupControlPendingReads = 0;
      }
      if (unavailablePolls >= 3) return unknown("cloud_unavailable", "Cloud Shell 不可用，未取得电话验证信号");
      await adapter.wait();
    }
    if (countryPendingReads) return unknown("country_required", "Cloud 地区选择未确认：等待加载后仍未读到唯一已选地区；未代选国家", true);
    if (setupControlPendingReads) return unknown("cloud_setup_required", "Cloud 首次使用表单未提供唯一可操作的条款控件；未同意条款", true);
    return unknown("timeout", `原号检测未确认：${lastStage}后未出现明确结果；未填写号码或发送短信`, true);
  } catch (_) {
    // Do not persist exception URLs (which may contain Google session tokens).
    return unknown("page_error", `原号检测未确认：${lastStage}时页面操作失败`, true);
  }
}

// Runs in the browser; only current visible UI is read. Controls receive transient
// ids for real clicks, never a guessed button position or a broad text click.
function inspectDocument() {
  for (const node of document.querySelectorAll("[data-cloud-phone-control]")) node.removeAttribute("data-cloud-phone-control");
  const visible = (node) => {
    const r = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
  const root = dialogs[dialogs.length - 1] || document.body;
  if (!root) return { text: "", controls: [] };
  const text = norm(root.innerText);
  const label = (node) => norm(node.getAttribute("aria-label") || node.getAttribute("title") || [node.innerText, ...[...(node.labels || [])].map((n) => n.innerText)].filter(Boolean).join(" "));
  const inputs = [...root.querySelectorAll("input")].filter(visible);
  const semantic = (node) => norm([label(node), node.name, node.id, node.autocomplete, node.placeholder].join(" "));
  const codeRe = /(?:verification|security|sms|one.time|totp|otp|pin).?(?:code)?|验证码|驗證碼|安全码|security code|인증\s*코드|확인\s*코드|보안\s*코드/i;
  const hasCodeInput = inputs.some((n) => codeRe.test(semantic(n)));
  const hasPhoneInput = inputs.some((n) => !codeRe.test(semantic(n)) && (n.type === "tel" || /phone|telephone|mobile|电话号码|手机号码|電話號碼|전화번호|휴대전화|휴대폰/i.test(semantic(n))));
  const candidates = [...root.querySelectorAll('button,a,[role="button"],[role="link"],[role="radio"],[role="checkbox"],input[type="checkbox"],[data-identifier],select,[role="combobox"],[role="listbox"]')].filter(visible);
  const controls = candidates.map((node, index) => {
    const id = `cloud-phone-${index}`;
    node.setAttribute("data-cloud-phone-control", id);
    const checkbox = node.matches('[role="checkbox"],input[type="checkbox"]');
    const account = node.getAttribute("data-identifier");
    const countrySemantic = norm([
      node.getAttribute("aria-label"), node.getAttribute("aria-labelledby"),
      node.getAttribute("name"), node.getAttribute("id"),
      ...[...(node.labels || [])].map((item) => item.innerText),
    ].join(" "));
    const country = node.matches('select,[role="combobox"],[role="listbox"]')
      && (/country|region|国家|地区|國家|地區/i.test(countrySemantic)
        || /^(?:country(?:\s*\/\s*region)?|国家\s*\/\s*地区|國家\s*\/\s*地區)(?:\s|$)/i.test(norm(node.innerText)));
    const countryValue = country ? norm(node.tagName === "SELECT"
      ? node.selectedOptions[0]?.textContent
      : node.getAttribute("aria-valuetext") || node.value || node.innerText) : undefined;
    return { id, label: account || label(node), value: country ? selectedCountry(countryValue) : undefined, kind: account ? "account" : checkbox ? "checkbox" : country ? "country" : "button", checked: checkbox && (node.checked || node.getAttribute("aria-checked") === "true"), disabled: !!node.disabled || node.getAttribute("aria-disabled") === "true" };
  });
  // Observed Cloud UI uses aria-modal=false dialogs for onboarding callouts.
  // Do not globally ignore nonmodal dialogs: unknown, terms and auth dialogs
  // must retain their current isolation from background controls.
  const knownCallout = (node) => node.getAttribute("role") === "dialog"
    && node.getAttribute("aria-modal") === "false"
    && String(node.getAttribute("class") || "").split(/\s+/).includes("cfc-callout")
    && ((/从上次停下的地方继续/.test(norm(node.innerText)) && /近期查看过/.test(norm(node.innerText)))
      || (/这是生产环境吗/.test(norm(node.innerText)) && /标记/.test(norm(node.innerText))));
  let cloudCallout;
  if (document.location?.protocol === "https:" && document.location?.hostname === "console.cloud.google.com"
      && knownCallout(root) && dialogs.every(knownCallout)
      && inputs.length === 0 && !controls.some((item) => item.kind === "checkbox" || item.kind === "country")) {
    const close = controls.filter((item) => item.kind === "button" && /^(?:关闭标注|關閉標註|close callout)$/i.test(item.label));
    cloudCallout = { key: text.slice(0, 200), closeControlId: close.length === 1 && !close[0].disabled ? close[0].id : "" };
  }
  const hasCaptcha = [...root.querySelectorAll('iframe[src*="recaptcha"],input[name="ca"],input[name="captcha"],#captchaimg')].some(visible) || /verify (?:that )?you are (?:a )?human|人机验证|证明您不是自动程序|验证您不是机器人|로봇이\s*아님|자동입력\s*방지|사람인지\s*확인/i.test(text);
  // A terminal DOM alone may be present behind the verification modal: require
  // a visible prompt in the rendered terminal, not its generic container.
  const terminalReady = dialogs.length === 0 && [...root.querySelectorAll(".xterm-screen,.terminal")].some((n) => visible(n) && /(?:\$|#)\s*$/.test(norm(n.innerText)));
  const setupDialog = dialogs.length > 0 && root !== document.body && cloudSetupText(text);
  return { text, controls, hasPhoneInput, hasCodeInput, hasCaptcha, terminalReady, setupDialog, ...(cloudCallout ? { cloudCallout } : {}) };
}

function createAdapter(page, ctx) {
  const pages = new Set([page]);
  const scopes = new Map();
  const listeners = new Map();
  const track = (p) => {
    if (listeners.has(p)) return;
    pages.add(p);
    const listener = (popup) => track(popup);
    listeners.set(p, listener);
    p.on("popup", listener);
  };
  track(page);
  return {
    emit: ctx.emit,
    open: (url) => page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }),
    async snapshots() {
      const snapshots = [];
      scopes.clear();
      for (const p of pages) {
        if (p.isClosed()) continue;
        for (const frame of p.frames()) {
          if (!trustedScope({ url: frame.url() })) continue;
          try {
            const data = await bounded(frame.evaluate(inspectDocument), 7000);
            const id = `scope-${scopes.size}`;
            scopes.set(id, frame);
            snapshots.push({ id, url: frame.url(), ...data });
          } catch (_) { /* frame is navigating; retry next poll */ }
        }
      }
      return snapshots;
    },
    async click(scopeId, controlId) {
      const frame = scopes.get(scopeId);
      if (!frame || !/^cloud-phone-\d+$/.test(controlId)) return false;
      const handle = await bounded(frame.$(`[data-cloud-phone-control="${controlId}"]`), 5000);
      if (!handle) return false;
      try { await bounded(handle.click(), 8000); return true; } finally { await bounded(handle.dispose(), 2000).catch(() => {}); }
    },
    async localize(scopeId) {
      const frame = scopes.get(scopeId);
      if (!frame) return false;
      const url = localizedChallengeUrl(frame.url());
      if (!url) return false;
      await frame.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      return true;
    },
    wait: () => sleep(1000),
    dispose() { for (const [p, listener] of listeners) p.off("popup", listener); },
  };
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("page_timeout")), ms); })]).finally(() => clearTimeout(timer));
}

async function detectCloudPhone(page, account, ctx = {}) {
  const adapter = createAdapter(page, ctx);
  let result;
  try {
    result = await runFlow(adapter, { accountEmail: account.email, acceptTerms: ctx.targets?.cloudPhone?.acceptTerms === true });
  } finally { adapter.dispose(); }
  const check = { state: result.state, reasonCode: result.reasonCode, detail: result.detail, checkedAt: new Date().toISOString() };
  return { outcome: result.outcome, stop: result.stop, reasonCode: result.reasonCode, detail: { cloudPhone: result.detail }, fieldPatch: { lastCloudPhoneCheck: check } };
}

module.exports = detectCloudPhone;
module.exports.helpers = { classifyPhoneChallenge, runFlow, inspectDocument, createAdapter, localizedChallengeUrl, PHONE_METHOD_RE, CONSOLE_URL };
