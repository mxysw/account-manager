"use strict";

/**
 * 从本地手机号池领取一个号码，添加到 Google 两步验证电话。
 *
 * 安全边界：
 * - Add / Next(Send) 各阶段有限次，真正“发送短信”的提交只执行一次；
 * - 出现短信验证码框时绝不把账号 TOTP 填进去；共享任务直接结束当前账号；
 * - 只有成功提示或号码列表明确出现目标号码才记 used / phone=ok；
 * - 共享号码的每个账号使用独立 attempt，任一终态只释放本账号，不影响其它并发任务。
 */

const login = require("./login");
const change2fa = require("./change-2fa");
const phones = require("../../phones");

const {
  sleep, parseLoc, fillField, bodyText, withTimeout, riskReason,
} = login.helpers;
const { handleBlockers, settle, safeGoto, flatDetail } = change2fa.shared;

const PHONE_URL = "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en";
const ACTION_TIMEOUT_MS = 6 * 60 * 1000;
const MANUAL_CODE_WAIT_MS = 5 * 60 * 1000;

const ADD_TEXT = [
  "^Add a phone number$", "^Add phone number$", "^Add phone$", "^Add another phone$",
  "^添加电话号码$", "^添加手机号$", "^添加电话$", "^新增電話號碼$", "^新增電話$",
];
const NEXT_TEXT = [
  "^Next$", "^Continue$", "^下一步$", "^继续$", "^繼續$",
];
const SAVE_TEXT = [
  "^Save$", "^Confirm$", "^保存$", "^确认$", "^儲存$", "^確認$",
];
// 保留聚合常量供诊断/旧测试读取；生产状态机按 Next 与 Save 两阶段分别定位。
const SEND_TEXT = [...NEXT_TEXT, ...SAVE_TEXT];
const PHONE_SELECTORS = [
  "input[autocomplete='tel']",
  "input[name*='phone' i]",
  "input[aria-label*='phone' i]",
  "input[aria-label*='电话']",
  "input[aria-label*='手機']",
  "input[type='tel']",
];

function maskPhone(number) {
  const value = String(number || "");
  return value.length <= 4 ? "••••" : `+••••${value.slice(-4)}`;
}

function isTargetUrl(url) {
  const { host, path } = parseLoc(url);
  return host === "myaccount.google.com" && /\/two-step-verification\/phone-numbers\/?$/i.test(path);
}

function numberDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * 浏览器内的纯 DOM 分类器。手机号与短信码都经常使用 type=tel，因此不能只看 type；
 * 强语义（autocomplete/name/aria/label/placeholder）优先，弱语义 type=tel 只在当前
 * dialog 明确处于“添加手机号”或“输入验证码”阶段时使用。
 *
 * args.markToken 只用于给生产填充流程定位同一个手机号输入框，不包含手机号。
 */
function inspectPhoneDocument(args = {}) {
  const target = String(args.targetNumber || "");
  const markToken = String(args.markToken || "");
  const visible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const digits = (value) => String(value || "").replace(/\D/g, "");
  const textOf = (node) => norm(node && (node.innerText || node.textContent));
  const attr = (node, name) => String(node && node.getAttribute ? (node.getAttribute(name) || "") : "");
  const bodyTextValue = norm(document.body ? document.body.innerText : "");
  const targetDigits = digits(target);
  const numberPattern = (value) => String(value || "").split("").join("[\\s().\\-–—]*");
  const fullNumberRe = targetDigits.length >= 7
    ? new RegExp(`(?:^|[^0-9])\\+?${numberPattern(targetDigits)}(?:[^0-9]|$)`)
    : null;
  // Google 的最终列表可能省略国家码（例如测试号 +85251234567 只显示 5123 4567）。
  // 仅允许同一文本节点中的独立 8 位本地号码，前后若仍是数字则不匹配。
  const localDigits = targetDigits.length > 8 ? targetDigits.slice(-8) : "";
  const localNumberRe = localDigits
    ? new RegExp(`(?:^|[^0-9])${numberPattern(localDigits)}(?:[^0-9]|$)`)
    : null;
  const containsTargetNumber = (value, allowLocal = false) => {
    const text = norm(value);
    return !!((fullNumberRe && fullNumberRe.test(text))
      || (allowLocal && localNumberRe && localNumberRe.test(text)));
  };

  const dialogs = [...document.querySelectorAll("[role='dialog'], dialog")].filter(visible);
  // Google/Chrome 有时会同时挂着多个可见 dialog（例如账号/个性化提示）。
  // 手机号确认框不保证是 DOM 中最后一个；优先选择正文包含目标号码的那个。
  const targetDialog = [...dialogs].reverse().find((node) => containsTargetNumber(textOf(node), true)) || null;
  const activeDialog = targetDialog || (dialogs.length ? dialogs[dialogs.length - 1] : null);
  const phaseText = textOf(activeDialog) || bodyTextValue;
  const hardBlockerRe = /captcha|recaptcha|verify you are human|证明您不是自动程序|验证您不是机器人|人机验证|驗證您是人類|browser or app may not be secure|try using a different browser|浏览器或应用可能不安全/i;
  // 目标确认框可以和 Chrome/Google 的其它提示同时存在；只有明确的安全/人机弹窗才阻止 Save，
  // 普通账号提示不能把目标确认框挤成“背景旧文案”。
  const blockingDialog = dialogs.some((node) => node !== targetDialog && hardBlockerRe.test(textOf(node)));
  const verificationPrompt = /code (was|has been) sent|sent.*verification code|enter (?:the )?(?:6[- ]?digit )?(?:verification )?code|已发送.*验证码|验证码.*(?:已)?发送|输入.*验证码|已傳送.*驗證碼|輸入.*驗證碼/i.test(phaseText);
  const phonePhase = /add (?:a |another )?(?:phone|phone number)|enter (?:a |your )?phone number|添加(?:手机|手机号|电话|电话号码)|输入(?:手机|手机号|电话|电话号码)|新增(?:電話|電話號碼)/i.test(phaseText);

  const labelledText = (node) => {
    const parts = [attr(node, "name"), attr(node, "autocomplete"), attr(node, "aria-label"), attr(node, "placeholder")];
    if (node.labels) {
      try { parts.push(...[...node.labels].map((label) => textOf(label))); } catch (_) { /* ignore */ }
    }
    const labelledBy = attr(node, "aria-labelledby").split(/\s+/).filter(Boolean);
    for (const id of labelledBy) {
      const label = document.getElementById ? document.getElementById(id) : null;
      if (label) parts.push(textOf(label));
    }
    return norm(parts.join(" "));
  };
  const codeFieldRe = /(?:verification|security|sms|text|one[- ]?time|otp|pin)[ _-]*(?:code|pin)|(?:^|\b)(?:otp|pin)(?:\b|$)|验证码|驗證碼|确认码|確認碼|短信码|簡訊碼/i;
  const phoneFieldRe = /phone(?:[ _-]*number)?|telephone|mobile|手机号|手机号码|电话号码|電話號碼|手機號碼/i;
  const classifyInput = (node) => {
    const semantic = labelledText(node);
    const autocomplete = attr(node, "autocomplete").toLowerCase();
    const type = attr(node, "type").toLowerCase();
    const inputMode = attr(node, "inputmode").toLowerCase();
    const explicitCode = autocomplete === "one-time-code" || codeFieldRe.test(semantic);
    const explicitPhone = /^(?:tel|tel-country-code|tel-national|tel-area-code|tel-local|tel-extension)$/.test(autocomplete)
      || phoneFieldRe.test(semantic);
    if (explicitCode) return "code";
    if (explicitPhone) return "phone";
    if (type === "tel" || inputMode === "tel" || inputMode === "numeric") {
      if (verificationPrompt) return "code";
      if (phonePhase) return "phone";
    }
    return "other";
  };

  const allInputs = [...document.querySelectorAll("input")].filter(visible);
  // 前景 dialog 存在时忽略背景表单，避免在重新验证/其它弹窗背后误填或误点。
  const scopedInputs = activeDialog && typeof activeDialog.contains === "function"
    ? allInputs.filter((node) => activeDialog.contains(node)) : allInputs;
  const classified = scopedInputs.map((node) => ({ node, kind: classifyInput(node) }));
  const phoneInput = (classified.find((item) => item.kind === "phone") || {}).node || null;
  const codeInput = (classified.find((item) => item.kind === "code") || {}).node || null;

  if (markToken) {
    for (const node of allInputs) {
      if (node.removeAttribute) node.removeAttribute("data-am-phone-input");
    }
    if (phoneInput && phoneInput.setAttribute) phoneInput.setAttribute("data-am-phone-input", markToken);
  }

  const successRe = /phone(?: number)? (?:was |has been )?(?:added|verified)|successfully added|number saved|电话号码.*(?:已添加|添加成功|已验证)|手機號碼.*(?:已新增|已驗證)/i;
  // Google 有时不会要求短信码，而是在添加后提示该号码将在几天后可用于验证。
  // 这类“稍后生效”提示本身就是提交成功证据，但只能由提交后的状态机消费。
  const delayedActivationRe = /security delay.{0,180}(?:new|this|your)?\s*phone.{0,180}2[- ]?step verification|(?:may|might|can|need(?:s)? to)?.{0,50}(?:take|wait).{0,40}(?:a|one|seven|1|7)?\s*(?:week|days?).{0,220}(?:new|this|your)?\s*phone number.{0,180}(?:verify|sensitive action)|(?:phone(?: number)?|this number).{0,180}(?:(?:has been |was )?(?:added|saved)|(?:will|can).{0,60}(?:use|available)).{0,180}(?:after|in|within|up to|later|take effect|effective).{0,80}(?:day|hour|week|time)?|(?:can|will).{0,60}(?:use|verify).{0,100}(?:phone(?: number)?|this number).{0,100}(?:after|in|within|up to|later).{0,60}(?:day|hour|week|time)?|(?:可能|需要|先)?.{0,20}(?:等待|等候).{0,40}(?:一周|一週|一星期|七天|7\s*天).{0,220}(?:新|此|该|這)?\s*(?:手机号码|手机号|电话号码|手機號碼|電話號碼).{0,180}(?:验证.*身份|驗證.*身分|敏感操作|生效|可使用|可用)|(?:手机号码|手机号|电话号码|手機號碼|電話號碼).{0,180}(?:已添加|添加成功|已新增|已儲存|已保存|設定完成).{0,180}(?:稍后|稍後|一段时间|一段時間|一周|一週|七天|7\s*天|生效|可使用|可用)/i;
  const liveRegions = [...document.querySelectorAll("[role='status'], [role='alert'], [aria-live='polite'], [aria-live='assertive']")].filter(visible);
  const successToast = liveRegions.some((node) => successRe.test(textOf(node)));
  const delayedActivation = delayedActivationRe.test(bodyTextValue);
  // 失败文案只读取当前手机号阶段，不能被页面背景残留的旧错误截断 Save。
  const invalidText = /invalid phone|not a valid phone|phone number cannot be used|can'?t use this phone|too many times|too many requests|unsupported phone|请输入有效.*(?:手机|电话)|手机号.*(?:无效|不能使用|次数过多)|電話號碼.*(?:無效|無法使用|次數過多)/i.test(phaseText);
  const captcha = hardBlockerRe.test(phaseText) || blockingDialog;
  const addButton = [...document.querySelectorAll("button, a, [role='button']")].filter(visible).some((node) => (
    /add (?:a )?(?:phone|phone number)|添加(?:手机|电话|电话号码)|新增(?:電話|電話號碼)/i.test(norm(`${node.textContent || ""} ${attr(node, "aria-label")}`))
  ));

  const dialogText = textOf(activeDialog);
  const phoneConfirmation = !!(activeDialog && !phoneInput && !codeInput
    && containsTargetNumber(dialogText, true)
    && /phone|number|save|confirm|手机|手机号|电话|电话号码|手機|電話|號碼|保存|确认|儲存|確認/i.test(dialogText));

  // 只允许“单个可见号码行”包含目标完整号码。不能把整页多个区域的数字去符号后拼起来。
  let listed = false;
  if (!activeDialog && targetDigits.length >= 7) {
    const rowNodes = [...document.querySelectorAll("li, tr, [role='listitem'], [role='row'], [data-phone-number], div, span, p")].filter(visible);
    const listContext = /2-Step Verification phone numbers?|phone numbers? for 2-Step|两步验证.*电话|2\s*步验证.*手机|兩步驗證.*電話/i.test(bodyTextValue);
    listed = listContext && rowNodes.some((node) => {
      // 只匹配同一个 DOM 文本节点；父容器 innerText 可能把两个不相干的号码行拼在一起。
      const directTexts = node.childNodes
        ? [...node.childNodes].filter((child) => child && child.nodeType === 3).map((child) => norm(child.nodeValue))
        : [];
      if (!directTexts.length && (!node.children || node.children.length === 0)) directTexts.push(textOf(node));
      return directTexts.some((value) => value.length > 0 && value.length <= 220
        && containsTargetNumber(value, true));
    });
  }

  return {
    hasCodeInput: !!codeInput,
    hasPhoneInput: !!phoneInput,
    phoneMarked: !!(markToken && phoneInput),
    verificationPrompt,
    invalidText,
    captcha,
    blockingDialog,
    addButton,
    phoneConfirmation,
    successToast,
    delayedActivation,
    // explicitSuccess 仅代表目标号码已在单个列表行确认；通用 toast 必须由提交后状态机单独消费。
    explicitSuccess: listed,
    listed,
  };
}

/**
 * 一次 DOM 快照只返回分类标志，不返回手机号/页面全文，避免号码落进任务日志。
 */
async function inspectPhonePage(page, targetNumber) {
  return withTimeout(page.evaluate(inspectPhoneDocument, { targetNumber }), 6000, {
    hasCodeInput: false,
    hasPhoneInput: false,
    phoneMarked: false,
    verificationPrompt: false,
    invalidText: false,
    captcha: false,
    blockingDialog: false,
    addButton: false,
    phoneConfirmation: false,
    successToast: false,
    delayedActivation: false,
    explicitSuccess: false,
    listed: false,
  });
}

/**
 * 只定位按钮，不在 page.evaluate 内点击。真正点击放到 Node 侧后，便可在调用 click() 前
 * 先记 attempted；即使点击触发导航、执行上下文销毁，也不会把“可能已发短信”降级成未提交。
 */
function locateScopedButtonDocument(args = {}) {
  const sources = Array.isArray(args.sources) ? args.sources : [];
  const kind = args.kind === "save" ? "save"
    : (args.kind === "next" || args.kind === "send" ? "next" : "add");
  const targetDigits = String(args.targetNumber || "").replace(/\D/g, "");
  const buttonSelector = "button, input[type='button'], input[type='submit'], a, [role='button']";
  const visible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const attr = (node, name) => String(node && node.getAttribute ? (node.getAttribute(name) || "") : "");
  const textOf = (node) => norm(node && (node.innerText || node.textContent));
  const dialogs = [...document.querySelectorAll("[role='dialog'], dialog")].filter(visible);
  const regexes = sources.map((value) => new RegExp(value, "i"));
  const negativeActionRe = /^(?:cancel|back|close|not now|skip|取消|返回|关闭|關閉|暂不|暫不|跳过|略过)$/i;
  const labelsOf = (node) => [...new Set([
    textOf(node),
    norm(node && node.textContent),
    attr(node, "aria-label"),
    attr(node, "value"),
    String(node && node.value || ""),
    attr(node, "title"),
  ].map(norm).filter(Boolean))];
  const candidatesIn = (scope) => [...scope.querySelectorAll(buttonSelector)]
    .filter((node) => visible(node) && !node.disabled && attr(node, "aria-disabled") !== "true")
    .map((node) => ({
      node,
      labels: labelsOf(node),
      area: Math.max(1, node.getBoundingClientRect().width * node.getBoundingClientRect().height),
    }))
    // visible text / aria-label / input value 分别做锚定匹配，避免 "Next"+"Next" 被拼成 "Next Next"。
    .filter((item) => item.labels.length
      && !item.labels.some((label) => negativeActionRe.test(label))
      && item.labels.some((label) => regexes.some((re) => re.test(label))))
    .sort((a, b) => a.area - b.area);

  const numberPattern = (value) => String(value || "").split("").join("[\\s().\\-–—]*");
  const containsTargetNumber = (value) => {
    if (targetDigits.length < 8) return false;
    const full = new RegExp(`(?:^|[^0-9])\\+?${numberPattern(targetDigits)}(?:[^0-9]|$)`);
    const local = targetDigits.length > 8
      ? new RegExp(`(?:^|[^0-9])${numberPattern(targetDigits.slice(-8))}(?:[^0-9]|$)`)
      : null;
    return full.test(norm(value)) || !!(local && local.test(norm(value)));
  };

  let scope = document;
  if (kind === "add") {
    // 有前景 dialog 时只在前景里找；不能越过重新验证弹窗去点背景 Add。
    if (dialogs.length) scope = dialogs[dialogs.length - 1];
  } else if (kind === "next") {
    const allInputs = [...document.querySelectorAll("input")].filter(visible);
    const phoneRe = /phone(?:[ _-]*number)?|telephone|mobile|手机号|手机号码|电话号码|電話號碼|手機號碼/i;
    const codeRe = /one[- ]?time|otp|pin|verification[ _-]*code|验证码|驗證碼|确认码|確認碼/i;
    const strongPhone = (node) => {
      if (attr(node, "data-am-phone-input")) return true;
      const semantic = norm([attr(node, "name"), attr(node, "autocomplete"), attr(node, "aria-label"), attr(node, "placeholder")].join(" "));
      if (attr(node, "autocomplete").toLowerCase() === "one-time-code" || codeRe.test(semantic)) return false;
      const explicitPhone = /^(?:tel|tel-country-code|tel-national|tel-area-code|tel-local|tel-extension)$/.test(attr(node, "autocomplete").toLowerCase())
        || phoneRe.test(semantic);
      if (explicitPhone) return true;
      const weakTel = attr(node, "type").toLowerCase() === "tel"
        || attr(node, "inputmode").toLowerCase() === "tel";
      const dialogText = dialogs.length ? textOf(dialogs[dialogs.length - 1]) : "";
      return weakTel && /add (?:a |another )?(?:phone|phone number)|enter (?:a |your )?phone number|添加(?:手机|手机号|电话|电话号码)|输入(?:手机|手机号|电话|电话号码)|新增(?:電話|電話號碼)/i.test(dialogText);
    };
    let phoneInput = null;
    if (dialogs.length) {
      const dialog = dialogs[dialogs.length - 1];
      phoneInput = allInputs.find((node) => dialog.contains(node) && strongPhone(node)) || null;
      if (phoneInput) scope = dialog;
      // 只检查最前景 dialog；其下层即便仍挂着手机号框，也不能越过 blocker 去点。
      if (!phoneInput) return null;
    } else {
      phoneInput = allInputs.find(strongPhone) || null;
      if (!phoneInput) return null;
      const form = typeof phoneInput.closest === "function" ? phoneInput.closest("form") : null;
      if (form) {
        scope = form;
      } else {
        // Google 某些版本不用 form；只向上寻找最近一个同时包含手机号框和目标按钮的小容器。
        let parent = phoneInput.parentElement;
        let found = null;
        for (let depth = 0; depth < 6 && parent; depth += 1, parent = parent.parentElement) {
          if (candidatesIn(parent).length) { found = parent; break; }
        }
        if (!found) return null;
        scope = found;
      }
    }
  } else {
    // 第二阶段 Save 弹窗不再包含手机号输入框；只能在最前景、且正文确实确认目标号码的弹窗内找。
    if (!dialogs.length) return null;
    const dialog = [...dialogs].reverse().find((candidate) => {
      const dialogText = textOf(candidate);
      return containsTargetNumber(dialogText)
        && /phone|number|save|confirm|手机|手机号|电话|电话号码|手機|電話|號碼|保存|确认|儲存|確認/i.test(dialogText)
        && candidatesIn(candidate).length > 0;
    }) || null;
    if (!dialog) return null;
    scope = dialog;
  }

  const candidates = candidatesIn(scope);
  if (!candidates.length) return null;
  candidates[0].node.scrollIntoView({ block: "center", inline: "center" });
  return candidates[0].node;
}

function normalizeClickAttempt(value) {
  if (value && typeof value === "object") {
    return {
      found: value.found !== false && (value.attempted === true || value.confirmed === true),
      attempted: value.attempted === true || value.confirmed === true,
      confirmed: value.confirmed === true,
    };
  }
  return { found: value === true, attempted: value === true, confirmed: value === true };
}

async function clickScoped(page, sources, options = {}) {
  const requestedKind = typeof options === "object" ? options.kind : "";
  const kind = requestedKind === "save" ? "save"
    : (requestedKind === "next" || requestedKind === "send" ? "next" : "add");
  const targetNumber = typeof options === "object" ? options.targetNumber : "";
  const beforeClick = typeof options === "object" && typeof options.beforeClick === "function"
    ? options.beforeClick : null;
  const handle = await withTimeout(page.evaluateHandle(
    locateScopedButtonDocument,
    { sources, kind, targetNumber },
  ), 6000, null);
  if (!handle) return { found: false, attempted: false, confirmed: false };
  const element = typeof handle.asElement === "function" ? handle.asElement() : null;
  if (!element) {
    if (typeof handle.dispose === "function") await handle.dispose().catch(() => {});
    return { found: false, attempted: false, confirmed: false };
  }
  // Save 之类的不可逆动作必须先把意图持久化，再执行真实 click。这样即使进程
  // 恰好在 click 后、Promise 返回前退出，启动恢复也不会把可能已提交的号码误释放。
  if (beforeClick) {
    try {
      await beforeClick();
    } catch (err) {
      if (typeof handle.dispose === "function") await handle.dispose().catch(() => {});
      throw err;
    }
  }
  // 这一行之后无论 click 的 Promise 如何结束，都必须按“可能已产生外部副作用”处理。
  const attempted = true;
  const confirmed = await withTimeout(Promise.resolve().then(() => element.click()).then(() => true), 6000, false);
  if (typeof handle.dispose === "function") await handle.dispose().catch(() => {});
  return { found: true, attempted, confirmed: confirmed === true };
}

async function fillPhoneField(page, value) {
  const token = `am-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const snapshot = await withTimeout(page.evaluate(inspectPhoneDocument, { targetNumber: value, markToken: token }), 6000, null);
  if (!snapshot || !snapshot.phoneMarked) return false;
  return fillField(page, [`input[data-am-phone-input="${token}"]`], value);
}

async function navigateToPhonePage(page, account, ctx, emit, deadline, deps = {}) {
  const counters = { reauth: 0, unknown: 0 };
  const authCtx = { ...(ctx || {}), preferAuthenticator: true };
  const goto = deps.safeGoto || safeGoto;
  const waitSettle = deps.settle || settle;
  const blockers = deps.handleBlockers || handleBlockers;
  const now = deps.now || (() => Date.now());
  await goto(page, PHONE_URL);
  await waitSettle(page);

  for (let round = 0; round < 10 && now() < deadline; round += 1) {
    // 即使 URL 已是目标页，也可能覆盖着 reauth / captcha dialog；必须先检查 blocker。
    const blocked = await blockers(page, account, authCtx, emit, counters);
    if (blocked.terminal) {
      return { ok: false, outcome: blocked.result.outcome || "need_verify", detail: flatDetail(blocked.result.detail) };
    }
    if (blocked.handled) {
      await waitSettle(page, 4000);
    }
    if (isTargetUrl(page.url())) return { ok: true };
    await goto(page, PHONE_URL);
    await waitSettle(page);
  }
  return { ok: false, outcome: "need_verify", detail: `未能进入两步验证手机号页面，停在：${page.url().split("?")[0].slice(0, 100)}` };
}

/**
 * 页面状态机。deps 仅用于确定性测试；生产调用不覆盖。
 * 返回 kind: added | already_present | code_required | rejected | blocked | before_submit_failure | timeout。
 */
async function drivePhoneFlow(page, account, number, ctx = {}, deps = {}) {
  const emit = typeof ctx.emit === "function" ? ctx.emit : () => {};
  const pause = deps.sleep || sleep;
  const inspect = deps.inspect || inspectPhonePage;
  const navigate = deps.navigate || navigateToPhonePage;
  const addClick = deps.clickAdd || ((targetPage) => clickScoped(targetPage, ADD_TEXT, { kind: "add" }));
  const nextClick = deps.clickNext || deps.clickSend
    || ((targetPage, beforeClick) => clickScoped(targetPage, NEXT_TEXT, { kind: "next", beforeClick }));
  const saveClick = deps.clickSave
    || ((targetPage, beforeClick) => clickScoped(targetPage, SAVE_TEXT, {
      kind: "save", targetNumber: number, beforeClick,
    }));
  const fill = deps.fillPhone || fillPhoneField;
  const now = deps.now || (() => Date.now());
  const manualWaitMs = Number.isFinite(ctx.manualCodeWaitMs) ? ctx.manualCodeWaitMs : MANUAL_CODE_WAIT_MS;
  const deadline = now() + (Number.isFinite(ctx.actionTimeoutMs) ? ctx.actionTimeoutMs : ACTION_TIMEOUT_MS);
  let submitted = false;
  let preliminaryIntent = false;
  let addClicks = 0;
  let completionNoticeSeenBeforeSubmit = false;

  // 某些 Google 版本的 Next 只打开 Save 确认框，另一些会直接发短信。
  // 点击前先落“可能提交”意图；看到纯确认框后再安全撤销，Save 前重新升级为 pending。
  const markPreliminaryIntent = async () => {
    if (preliminaryIntent || submitted) return;
    if (typeof ctx.onSubmitIntent === "function") await ctx.onSubmitIntent();
    preliminaryIntent = true;
  };
  const clearPreliminaryIntent = async () => {
    if (!preliminaryIntent || submitted) return;
    if (typeof ctx.onSubmitIntentCleared === "function") await ctx.onSubmitIntentCleared();
    preliminaryIntent = false;
  };
  const markIrreversible = async () => {
    if (submitted) return;
    const onSubmitAttempted = typeof ctx.onSubmitAttempted === "function"
      ? ctx.onSubmitAttempted : ctx.onSmsRequested;
    if (typeof onSubmitAttempted === "function") await onSubmitAttempted();
    submitted = true;
    preliminaryIntent = false;
  };

  const nav = await navigate(page, account, ctx, emit, deadline);
  if (!nav.ok) return { kind: "blocked", submitted: false, detail: nav.detail || "进入手机号设置失败" };

  let snap = await inspect(page, number);
  completionNoticeSeenBeforeSubmit = completionNoticeSeenBeforeSubmit
    || snap.successToast === true || snap.delayedActivation === true;
  if (snap.listed || snap.explicitSuccess) return { kind: "already_present", submitted: false, explicitSuccess: true };
  if (snap.captcha) return { kind: "blocked", submitted: !!ctx.alreadySubmitted, detail: "Google 要求人机验证，已停止" };

  // pending / used 重跑只能复核远端列表；残留 toast 不算证据，绝不填号或再次发送短信。
  if (ctx.alreadySubmitted) {
    return { kind: "code_required", submitted: true, codePromptVisible: snap.hasCodeInput, detail: "该号码此前已提交，尚未在号码列表确认；为避免重复发短信，本次未再次提交" };
  }

  // 进入填号表单。Add 可能先触发一次 reauth，允许重新回目标页后再点一次，但有总上限。
  for (let round = 0; round < 6 && now() < deadline; round += 1) {
    snap = await inspect(page, number);
    completionNoticeSeenBeforeSubmit = completionNoticeSeenBeforeSubmit
      || snap.successToast === true || snap.delayedActivation === true;
    if (snap.listed || snap.explicitSuccess) return { kind: "already_present", submitted: false, explicitSuccess: true };
    if (snap.captcha) return { kind: "blocked", submitted: false, detail: "Google 要求人机验证，已停止" };
    if (snap.hasPhoneInput) break;
    const addAttempt = addClicks >= 2 ? normalizeClickAttempt(false) : normalizeClickAttempt(await addClick(page));
    if (!addAttempt.attempted) {
      await pause(900);
      continue;
    }
    addClicks += 1;
    emit("phone_add_opened", { tries: addClicks });
    await pause(1500);
    if (!isTargetUrl(page.url())) {
      const back = await navigate(page, account, ctx, emit, deadline);
      if (!back.ok) return { kind: "blocked", submitted: false, detail: back.detail || "打开添加手机号表单时重新验证未通过" };
    }
  }

  snap = await inspect(page, number);
  completionNoticeSeenBeforeSubmit = completionNoticeSeenBeforeSubmit
    || snap.successToast === true || snap.delayedActivation === true;
  if (!snap.hasPhoneInput) return { kind: "before_submit_failure", submitted: false, detail: "没有找到添加手机号输入框（Google 页面结构可能变化）" };
  emit("phone_fill", { last4: number.slice(-4) });
  if (!(await fill(page, number))) return { kind: "before_submit_failure", submitted: false, detail: "手机号未能可靠填入，已停止且没有提交" };

  // 第一阶段 Next 只进入号码确认弹窗，本身不占用为 pending；真正不可逆边界是第二阶段 Save。
  const nextAttempt = normalizeClickAttempt(await nextClick(page, markPreliminaryIntent));
  if (!nextAttempt.attempted) {
    await clearPreliminaryIntent();
    return { kind: "before_submit_failure", submitted: false, detail: "没有在手机号表单中找到可点击的 Next 按钮，号码未提交" };
  }
  // 兼容忽略第二参数的测试/注入驱动；生产 clickScoped 会在真实 click 前调用。
  await markPreliminaryIntent();
  emit("phone_next_attempted", { last4: number.slice(-4), clickConfirmed: nextAttempt.confirmed });

  let sawCodePrompt = false;
  let saveAttempted = false;
  let manualDeadline = null;
  // 若提交前已有旧 toast，必须先看到它消失，之后的新 toast 才能证明本次提交成功。
  let completionNoticeArmed = !completionNoticeSeenBeforeSubmit;
  while (now() < deadline) {
    await pause(sawCodePrompt ? 1200 : 700);
    snap = await inspect(page, number);
    if (!snap.successToast && !snap.delayedActivation) completionNoticeArmed = true;
    // Next 后、Save 前确认弹窗里的提示仍是基线，不能被本轮 Save 当成新成功证据。
    if (!submitted && (snap.successToast || snap.delayedActivation)) completionNoticeArmed = false;
    if (snap.invalidText) {
      // Google 明确停在提交前拒绝页时没有待完成副作用，可撤销 Next 的保护意图。
      if (!submitted) await clearPreliminaryIntent();
      return { kind: "rejected", submitted, detail: "Google 明确拒绝该手机号（格式/次数/频率限制）" };
    }
    if (snap.captcha) {
      return { kind: "blocked", submitted, codePromptVisible: sawCodePrompt, detail: "Google 要求人机验证或安全检查" };
    }

    if (!saveAttempted && snap.phoneConfirmation) {
      // 已明确证明 Next 只是打开确认框；此刻尚未 Save，进程退出也可安全恢复。
      await clearPreliminaryIntent();
      // 生产 clickScoped 会在真实 click 前调用 markIrreversible。注入的旧测试驱动
      // 可能忽略第二参数，因此返回后仍幂等补调一次。
      const save = normalizeClickAttempt(await saveClick(page, markIrreversible));
      if (!save.attempted) {
        return { kind: "before_submit_failure", submitted: false, detail: "已进入号码确认弹窗，但没有找到可点击的 Save 按钮；号码尚未保存" };
      }
      saveAttempted = true;
      // Save click 一旦尝试，即使触发导航导致 confirmed=false，也必须先记为 pending，绝不重试；
      // 当前账号任务结束后，共享号码会由上层统一释放，一号一绑仍保守等待核对。
      await markIrreversible();
      emit("phone_save_attempted", { last4: number.slice(-4), clickConfirmed: save.confirmed });
      manualDeadline = null;
      continue;
    }

    const delayedSuccess = submitted && snap.delayedActivation && completionNoticeArmed
      && !snap.hasPhoneInput && !snap.hasCodeInput;
    const directCompletion = !submitted && (snap.listed || snap.explicitSuccess
      || (snap.successToast && completionNoticeArmed));
    // 先消费 Save 后的强成功证据，再做全页风控兜底。成功页自身可能包含
    // “verify it's you / security delay”，那是稍后生效说明，不是额外身份验证。
    if (directCompletion || (submitted && (snap.listed || snap.explicitSuccess
      || (snap.successToast && completionNoticeArmed) || delayedSuccess))) {
      // 少数版本可能在 Next 后直接完成；先把预提交意图升级为正式 pending，
      // 随后上层 confirmUsed 会原子记录成功绑定并重新开放共享号码。
      if (!submitted) await markIrreversible();
      return {
        kind: "added",
        submitted: true,
        explicitSuccess: true,
        activationDeferred: submitted && snap.delayedActivation && completionNoticeArmed,
        verificationCompleted: sawCodePrompt,
      };
    }

    // 没有新成功证据时，Save 后仍显示原确认框通常只是退出动画；继续等页面稳定，
    // 不能把其中的 “verify it's you” 当成可疑登录，也不能重复点 Save。
    if (saveAttempted && snap.phoneConfirmation) {
      if (!manualDeadline) manualDeadline = now() + 25000;
      if (now() >= manualDeadline) break;
      continue;
    }

    // 没有目标确认框时才读取全页风险文案；确认框已经精确匹配目标号码时，背景旧文案不能跳过 Save。
    const text = await bodyText(page);
    const risk = riskReason(text, page.url());
    if (risk) {
      return { kind: "blocked", submitted, codePromptVisible: sawCodePrompt, detail: risk };
    }

    if (snap.hasCodeInput || snap.verificationPrompt) {
      // 兼容 Google 的条件分支：如果 Next 后确实直接出现短信码框，说明 Next 已产生副作用。
      await markIrreversible();
      if (!sawCodePrompt) {
        sawCodePrompt = true;
        manualDeadline = now() + manualWaitMs;
        emit("phone_sms_code_required", { last4: number.slice(-4) });
      }
      // 这里只读等用户在浏览器里亲自输入验证码；绝不调用 fillField/click/keyboard。
      if (manualWaitMs <= 0 || now() >= manualDeadline) {
        return { kind: "code_required", submitted: true, codePromptVisible: true, detail: "Google 另行要求短信验证码，本账号未完成" };
      }
      continue;
    }

    // Save 前只等待确认弹窗；失败仍可安全释放。Save 后才进入不可逆 pending 超时。
    if (!manualDeadline) manualDeadline = now() + 25000;
    if (now() >= manualDeadline) break;
  }
  if (!submitted) {
    return { kind: "before_submit_failure", submitted: false, detail: "点击 Next 后未出现目标号码确认弹窗，号码尚未保存" };
  }
  return { kind: "timeout", submitted, codePromptVisible: sawCodePrompt, detail: "号码已保存，但 Google 没有给出明确成功结果；已保留为待确认" };
}

function pendingResult(masked, detail, options = {}) {
  const smsRequired = options && options.smsRequired === true;
  return {
    outcome: "need_verify",
    reasonCode: smsRequired ? "sms_code_required" : "phone_confirmation_pending",
    statusPatch: { phone: "pending" },
    detail: { phoneAdd: `${detail || "手机号已提交，等待 Google 确认或生效"}（${masked}）` },
    stop: true,
    // 一号一绑的提交结果不明时保留现场；共享模式会在 finishSharedAttempt 中关闭本账号窗口并继续队列。
    keepOpen: true,
    handoff: true,
  };
}

async function addPhone(page, account, ctx = {}) {
  const emit = typeof ctx.emit === "function" ? ctx.emit : () => {};
  const pool = ctx.phonePool || phones;
  const drive = ctx.drivePhoneFlow || drivePhoneFlow;
  const phoneMode = ctx.phoneMode === "exclusive" ? "exclusive" : "shared";
  let claim;
  try {
    claim = pool.claimForAccount(account, { mode: phoneMode });
  } catch (err) {
    return { outcome: "error", reasonCode: "phone_pool_error", detail: { phoneAdd: `领取手机号失败：${err.message}` }, stop: true };
  }
  if (!claim) {
    const poolLabel = phoneMode === "exclusive" ? "一号一绑池" : "共享池";
    return {
      outcome: "error",
      reasonCode: "phone_pool_empty",
      detail: { phoneAdd: `手机号${poolLabel}没有可用号码，请先在“手机号池”导入对应模式的号码` },
      stop: true,
    };
  }

  const { item, leaseId } = claim;
  const leaseState = () => {
    if (!item || !item.id || !leaseId) return null;
    if (typeof pool.getAttempt === "function") return pool.getAttempt(item.id, leaseId);
    const current = typeof pool.getById === "function" ? pool.getById(item.id) : item;
    // 兼容旧测试注入池：只有顶层单 lease 时必须确认仍是本 runner 的 token。
    return current && (!current.leaseId || current.leaseId === leaseId) ? current : null;
  };
  let masked = "••••";
  let readOnly = false;
  let submitted = false;
  const finishSharedAttempt = (result, reason) => {
    if (phoneMode !== "shared") return result;
    // pending 的重复任务只是观察者，不拥有原 runner 创建的 lease。观察未确认时
    // 只能结束自己的浏览器，绝不能释放或改坏原任务仍在使用的 attempt。
    const readOnlyObserver = claim.readOnly === true && claim.alreadyUsed !== true && !!leaseId;
    if (readOnlyObserver) {
      const detail = result && result.detail && typeof result.detail === "object" ? result.detail : {};
      const observedDetail = String(detail.phoneAdd || "该号码仍在等待原提交任务确认").trim();
      return {
        ...result,
        statusPatch: { ...(result.statusPatch || {}), phone: "pending" },
        detail: {
          ...detail,
          phoneAdd: `${observedDetail}；本次为只读复查，未修改原任务的共享号码占用`,
        },
        keepOpen: false,
        handoff: false,
      };
    }
    let releaseFailed = false;
    if (item && item.id && leaseId) {
      try {
        if (typeof pool.releaseSharedAttempt !== "function") {
          releaseFailed = true;
        } else {
          const released = pool.releaseSharedAttempt(item.id, leaseId, reason || "共享号码本次账号尝试已结束");
          if (!released) {
            const current = leaseState();
            releaseFailed = !!(current && (current.status === "reserved" || current.status === "pending"));
          }
        }
      } catch (_) {
        releaseFailed = true;
      }
    }
    if (releaseFailed) {
      const detail = result && result.detail && typeof result.detail === "object" ? result.detail : {};
      const prefix = detail.phoneAdd ? `${detail.phoneAdd}；` : "";
      return {
        ...result,
        outcome: "error",
        reasonCode: "phone_pool_state_error",
        statusPatch: { ...(result.statusPatch || {}), phone: "failed" },
        detail: { ...detail, phoneAdd: `${prefix}共享号码本次占用释放失败，请在手机号池点击“释放共享占用”` },
        stop: true,
        keepOpen: false,
        handoff: false,
      };
    }
    // 共享号码的单个账号任务结束后必须继续跑下一个，失败/待人工也不能占住批次。
    const detail = result && result.detail && typeof result.detail === "object" ? result.detail : {};
    const sharedDetail = String(detail.phoneAdd || "")
      .replace(/（号码继续锁定为待确认）/g, "")
      .replace(/[；，]?号码(?:继续)?(?:保持|锁定为)待(?:确认|核对|生效)(?:状态)?/g, "")
      .replace(/[；，]?号码保持待确认/g, "")
      .trim();
    const phoneAdd = detail.phoneAdd
      ? `${sharedDetail || "本账号的手机号添加任务已结束"}；本账号的共享号码占用已释放`
      : "本账号的手机号添加任务已结束；本账号的共享号码占用已释放";
    // 共享号码普通成功/失败仍关闭窗口并继续队列；内部登录/重新验证若撞到
    // 人机或风控页，则报告人工接管候选，由引擎的独立策略决定关窗还是保留。
    const keepBlockedWindow = result.reasonCode === "phone_add_blocked"
      && result.keepOpen === true;
    const retainBlockedWindow = keepBlockedWindow && ctx.manualChallengePolicy === "keep";
    return {
      ...result,
      statusPatch: { ...(result.statusPatch || {}), phone: result.outcome === "ok" ? "ok" : "failed" },
      detail: {
        ...detail,
        phoneAdd: retainBlockedWindow ? `${phoneAdd}；浏览器已保留供人工处理` : phoneAdd,
      },
      keepOpen: keepBlockedWindow,
      handoff: keepBlockedWindow && result.handoff === true,
    };
  };
  try {
    if (!item || !item.id) throw new Error("手机号池返回了无效的占用记录");
    masked = maskPhone(item.number);
    emit("phone_claimed", { poolId: item.id, last4: item.number.slice(-4), reused: !!claim.reused });

    // pending 和 used 都只能只读复核。共享并发必须读取本 lease 的 attempt，不能读取
    // 手机号根对象的概览状态，否则别的账号 pending 会把当前新任务误判为只读。
    const initialState = claim.attempt || leaseState() || (typeof pool.getAttempt !== "function" ? item : null);
    readOnly = claim.readOnly === true || claim.alreadyUsed === true
      || (initialState && (initialState.status === "pending"
        || !!initialState.submittedAt || !!initialState.submitIntentAt));
    submitted = readOnly;
    let preliminaryIntent = false;
    let submitCallbackUsed = false;
    const markIntent = async () => {
      if (preliminaryIntent || submitted) return;
      if (readOnly) throw new Error("只读复查状态禁止创建手机号提交意图");
      if (typeof pool.markSubmitIntent !== "function") {
        throw new Error("手机号池缺少提交意图保护，已停止以防重复提交");
      }
      const marked = pool.markSubmitIntent(item.id, leaseId, "即将点击 Next，等待 Google 页面结果");
      if (!marked) throw new Error("手机号占用状态已变化，已停止以防重复提交");
      preliminaryIntent = true;
    };
    const clearIntent = async () => {
      if (!preliminaryIntent || submitted) return;
      if (typeof pool.clearSubmitIntent !== "function") {
        throw new Error("手机号池无法撤销安全提交意图，已停止并保留号码待核对");
      }
      const cleared = pool.clearSubmitIntent(item.id, leaseId, "Next 仅打开确认框，尚未保存手机号");
      if (!cleared) throw new Error("手机号占用状态已变化，已停止以防重复提交");
      preliminaryIntent = false;
    };
    const markSubmitted = async () => {
      if (submitCallbackUsed) return;
      submitCallbackUsed = true;
      if (readOnly) throw new Error("只读复查状态禁止再次提交手机号");
      const marked = pool.markPending(item.id, leaseId, "手机号已提交，等待 Google 确认或生效");
      if (!marked) throw new Error("手机号占用状态已变化，已停止以防重复提交");
      submitted = true;
      preliminaryIntent = false;
    };
    const result = await drive(page, account, item.number, {
      ...ctx,
      // 共享号码以批量继续为优先：Google 若额外要求短信码，当前账号立即结束；
      // 一号一绑仍可沿用默认等待时间，保留现场供人工完成。
      manualCodeWaitMs: phoneMode === "shared" ? 0 : ctx.manualCodeWaitMs,
      alreadySubmitted: readOnly,
      readOnly,
      onSubmitIntent: markIntent,
      onSubmitIntentCleared: clearIntent,
      onSubmitAttempted: markSubmitted,
      // 兼容已有测试/注入驱动；生产状态机优先调用中性的 onSubmitAttempted。
      onSmsRequested: markSubmitted,
    });

    // Next 后若未能明确观察到“仅确认框”或正式提交结果，先升级为待核对；
    // 共享模式随后结束当前账号并释放号码，一号一绑则继续保守保护。
    const afterDrive = leaseState();
    if (!readOnly && !result.submitted && afterDrive && afterDrive.status === "reserved" && afterDrive.submitIntentAt) {
      const marked = pool.markPending(item.id, leaseId, result.detail || "Next 后页面状态不明确，等待人工核对");
      if (marked) {
        submitted = true;
        return finishSharedAttempt(pendingResult(masked, result.detail || "Next 后页面状态不明确，号码保持待确认", {
          smsRequired: result.codePromptVisible === true,
        }), result.detail || "Next 后页面状态不明确");
      }
    }

    if (result.explicitSuccess && (result.kind === "added" || result.kind === "already_present")) {
      const activationDeferred = result.activationDeferred === true;
      const bindingMeta = result.kind === "already_present"
        ? { origin: "preexisting", verification: "unknown", activation: "ready" }
        : {
          origin: "added",
          verification: result.verificationCompleted === true ? "sms_completed" : "not_requested",
          activation: activationDeferred ? "deferred" : "ready",
        };
      // 已是 used 的本地记录也必须先通过本次页面复核；复核后无需用空 lease 再 confirm。
      if (!claim.alreadyUsed) {
        const used = pool.confirmUsed(item.id, leaseId, bindingMeta);
        if (!used) {
          return finishSharedAttempt(
            pendingResult(masked, "Google 已显示添加成功，但本地手机号池占用已变化，请人工核对并标记"),
            "Google 显示成功，但本地确认失败",
          );
        }
      }
      emit("phone_added", { poolId: item.id, last4: item.number.slice(-4) });
      return {
        outcome: "ok",
        reasonCode: result.kind === "already_present" ? "phone_already_added"
          : (activationDeferred ? "phone_added_pending_activation" : "phone_added"),
        statusPatch: { phone: "ok" },
        detail: {
          phoneAdd: result.kind === "already_present"
            ? `目标两步验证手机号原本已经存在（${masked}）`
            : (activationDeferred
              ? `两步验证手机号已添加，无需短信验证；Google 提示需要等待一段时间后生效（${masked}）`
              : `两步验证手机号已添加并在号码列表确认（${masked}）`),
        },
        stop: true,
      };
    }

    if (claim.alreadyUsed) {
      // 本地 used 不是远端事实；列表未确认时不降级池状态、不冒充 phone=ok。
      return finishSharedAttempt({
        outcome: "need_verify",
        reasonCode: "phone_record_unconfirmed",
        detail: { phoneAdd: `手机号池记为已用，但本次未在 Google 号码列表确认目标号码（${masked}）；未重新发送短信` },
        stop: true,
        keepOpen: true,
        handoff: true,
      }, "已绑定记录本次远端复核未确认");
    }

    if (readOnly) {
      // pending 的第二任务只读复查：除明确成功可 confirmUsed 外，禁止 mark/release/failed。
      return finishSharedAttempt(pendingResult(masked, result.detail || "该号码此前已提交，等待 Google 确认、生效或人工复核", {
        smsRequired: result.codePromptVisible === true,
      }), result.detail || "共享号码待确认任务已结束");
    }

    if (result.kind === "rejected") {
      if (phoneMode !== "shared") pool.markFailed(item.id, leaseId, result.detail || "Google 拒绝该手机号");
      return finishSharedAttempt({
        outcome: "error",
        reasonCode: "phone_rejected",
        statusPatch: { phone: "failed" },
        detail: { phoneAdd: `${result.detail || "Google 拒绝该手机号"}（${masked}）` },
        stop: true,
      }, result.detail || "Google 拒绝该手机号");
    }

    if (result.submitted || submitted || result.kind === "code_required" || result.kind === "timeout") {
      pool.markPending(item.id, leaseId, result.detail || "手机号已提交，等待 Google 确认或生效");
      // 先记录可能已提交，避免在动作仍运行时并发复用；共享模式会在本账号终态统一释放，
      // 一号一绑仍保留窗口供人工核对。
      return finishSharedAttempt(
        pendingResult(masked, result.detail, { smsRequired: result.codePromptVisible === true }),
        result.detail || "共享号码提交结果待确认，本次任务已结束",
      );
    }

    // 所有提交前终态都可安全释放。
    if (phoneMode !== "shared") {
      pool.release(item.id, leaseId, result.detail || "提交前中止");
    }
    const blockedBeforeSubmit = result.kind === "blocked";
    const releaseNote = phoneMode === "shared" ? "（号码未提交）" : "（号码未提交，已释放）";
    return finishSharedAttempt({
      outcome: result.kind === "blocked" ? "need_verify" : "error",
      reasonCode: result.kind === "blocked" ? "phone_add_blocked" : "phone_add_failed",
      // 号码尚未提交时，只能说明本次动作没有完成，不能据此覆盖账号原有验证电话状态。
      detail: { phoneAdd: `${result.detail || "未能打开/填写添加手机号页面"}${releaseNote}` },
      stop: true,
      keepOpen: blockedBeforeSubmit,
      handoff: blockedBeforeSubmit,
    }, result.detail || "共享号码本次任务未完成");
  } catch (err) {
    if (claim.alreadyUsed) {
      return finishSharedAttempt({
        outcome: "need_verify",
        reasonCode: "phone_record_unconfirmed",
        detail: { phoneAdd: `手机号池记为已用，但远端复核异常：${err.message}（${masked}）；未重新发送短信` },
        stop: true,
        keepOpen: true,
        handoff: true,
      }, `已绑定记录复核异常：${err.message}`);
    }
    if (readOnly) {
      return finishSharedAttempt(
        pendingResult(masked, `只读复核异常：${err.message}；号码保持待确认状态`),
        `共享号码只读复核异常：${err.message}`,
      );
    }
    const current = leaseState();
    const isPending = submitted || (current && (current.status === "pending" || current.submitIntentAt));
    if (isPending) {
      pool.markPending(item.id, leaseId, `提交后页面异常：${err.message}`);
      return finishSharedAttempt(
        pendingResult(masked, "号码可能已经提交，但页面异常；本账号已结束"),
        `共享号码提交后页面异常：${err.message}`,
      );
    }
    if (item && item.id && leaseId && phoneMode !== "shared") {
      pool.release(item.id, leaseId, `提交前异常：${err.message}`);
    }
    return finishSharedAttempt(
      { outcome: "error", reasonCode: "phone_add_failed", detail: { phoneAdd: `添加手机号异常：${err.message}（本账号已结束）` }, stop: true },
      `共享号码提交前异常：${err.message}`,
    );
  }
}

module.exports = addPhone;
module.exports._internals = {
  PHONE_URL,
  PHONE_SELECTORS,
  NEXT_TEXT,
  SAVE_TEXT,
  SEND_TEXT,
  maskPhone,
  numberDigits,
  isTargetUrl,
  inspectPhoneDocument,
  inspectPhonePage,
  locateScopedButtonDocument,
  normalizeClickAttempt,
  clickScoped,
  fillPhoneField,
  navigateToPhonePage,
  drivePhoneFlow,
  pendingResult,
};
