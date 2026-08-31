"use strict";

/**
 * Google 账号自动登录（puppeteer 版）。
 *
 * 流程：打开 Google 登录页 → 填邮箱 → 填密码 → 填 TOTP(2FA) → 跳过 passkey 等插页 → 登录完成。
 * 安全原则：遇到验证码 / 可疑活动 / “浏览器不安全” / 需要额外身份验证 → 立即停下，
 *           返回 outcome=need_verify（归「待人工」），绝不硬闯。
 *
 * 返回：{ outcome, detail, fieldPatch }
 *   outcome: ok          登录成功
 *            need_verify  遇到验证码/可疑，需人工
 *            error        缺密钥/超时等
 */

const totp = require("../../totp");
const { syncTime, accurateNow } = require("../time-sync");

const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2F";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TOTP 窗口长度（秒），需与 totp.generate 默认 step 一致。
const TOTP_STEP = 30;
// 提交前要求当前窗口至少还剩这么多秒。否则「打字 + 点提交 + 网络到达 Google」期间会跨进下一个
// 窗口，Google 用新窗口校验旧码 → 判错。3s 余量过紧（光打 6 位 + 点击 + 往返就可能吃掉它），
// 放宽到 6s 才安全。
const MIN_TOTP_MARGIN_SEC = 6;

// 验证码输入框选择器（多处复用，统一一份）。
const TOTP_SELECTORS = [
  "input[name='totpPin']",
  "input[name='idvPin']",
  "input[type='tel']",
  "input[aria-label*='code' i]",
  "input[aria-label*='验证码']",
];
// 同一组选择器拼成的 CSS 选择器字符串（供 waitForSelector 一次等多个）。
const TOTP_SELECTOR_CSS = TOTP_SELECTORS.join(",");

// 「设备通知验证(Google Prompt)」页识别：让用户在手机通知里点按、并按下屏幕上的数字。
// 这种验证必须真人在手机上操作，自动化无法完成 → 必须切到「身份验证器(TOTP)」走现有 TOTP 逻辑。
// 注意：刻意不用过于通用的「2-Step Verification / 两步验证」做识别（TOTP 输入页也带这串），
//      只认设备通知页特有的「查看您的设备 / 在手机上点按 / 打开 Google 应用 / 点按屏幕上的数字」等文案，
//      再由 URL 排除 selection / TOTP / 安全代码页。Google SPA 可能残留看似可见的旧输入框，
//      所以设备通知页不能再依赖「无邮箱/密码/验证码输入框」才能命中。
const DEVICE_PROMPT_RE = /查看您的设备|查看你的设备|檢查您的裝置|Google\s*已向您的.{0,60}(发送|發送)了通知|在通知中(点按|點按|轻触|輕觸)(是|Yes)|打开\s*Google\s*应用|開啟\s*Google\s*應用|在您的(手机|手機|设备|裝置|平板)上\s*(点按|點按|輕觸|轻触)\s*\d*|点按(您)?(手机|设备|通知).{0,12}(数字|对应|相符|是)|轻触.{0,12}数字|點按.{0,12}數字|Check your (phone|device|tablet)|Open the Google app|Tap (Yes|the number)|Google sent (a|you a) notification/i;

// 「试试其他方式 / 换一种方式」入口（点开后弹出验证方式列表）。
const TRY_ANOTHER_RE = /Try another way|Try a different way|More ways to verify|Try another method|Choose another way|试试其他方式|尝试其他方式|試試其他方式|嘗試其他方式|試試其他方法|换一种方式|換一種方式|其他验证方式|其他驗證方式|其他登入方式|別的方法|别的方式|다른 방법|다른 방식|Otra forma|Probar otra forma|Essayer une autre/i;

// 验证方式列表里「身份验证器」那一项（明确排除短信/安全密钥/备用码/设备通知）：
//   - Get a verification code from the Google Authenticator app
//   - 从 Google 身份验证器应用获取验证码 / 使用 Google 身份验证器应用
const AUTH_OPTION_RE = /Get a (verification|security) code from (the )?Google Authenticator|Get a code from (the )?Google Authenticator|Use (the |your )?Google Authenticator|Google\s*Authenticator(?:\s*(?:app|应用|應用程式))?|从.{0,8}(Google\s*)?身份验证器.{0,8}获取(验证码|安全码)|使用.{0,8}(Google\s*)?身份验证器|身份验证器应用|身分驗證器|验证码应用|從.{0,12}(?:身分驗證器|身份驗證器|Google\s*Authenticator|Google\s*驗證器).{0,12}取得驗證碼/i;

// Google「安全代码」页（截图实测：要求另开浏览器访问 g.co/sc 获取代码）不是身份验证器 TOTP。
// 该页同样有 6 位输入框，不能靠 input[type=tel]/“输入验证码”判断，否则会把 TOTP 填错地方。
const SECURITY_CODE_RE = /g\.co\/sc|(?:获取验证码以进行登录|取得驗證碼以登入|取得安全碼以登入|Get (?:a|your) (?:security|verification) code to sign in|To get your (?:security|verification) code|要获取您的验证码|要取得您的驗證碼).{0,160}(?:新的?浏览器窗口|新的?瀏覽器視窗|new browser)/i;
const AUTHENTICATOR_TOTP_RE = /Google Authenticator|Authenticator app|authentication app|身份验证器|身分驗證器|驗證器應用程式|验证码应用/i;

function isSecurityCodeChallenge(text, url) {
  return /\/challenge\/ootp(?:[/?#]|$)/i.test(String(url || ""))
    || SECURITY_CODE_RE.test(`${text || ""}\n${url || ""}`);
}

function isAuthenticatorTotpContext(text, url) {
  if (isSecurityCodeChallenge(text, url)) return false;
  // URL 有明确 challenge 类型时以 URL 为准：selection/idv/ipp/ootp 等页面即使正文列出了
  // “身份验证器”选项、甚至残留可见 tel 输入框，也不能填 TOTP；只有 challenge/totp 可以。
  const challenge = String(url || "").match(/\/challenge\/([^/?#]+)/i);
  if (challenge) return challenge[1].toLowerCase() === "totp";
  // 仅在 URL 无法提供 challenge 类型时，才用明确的 Authenticator 文案回退。
  return AUTHENTICATOR_TOTP_RE.test(String(text || ""));
}

function shouldFillTotp(text, url, hasVisibleCodeInput) {
  return !!hasVisibleCodeInput && isAuthenticatorTotpContext(text, url);
}

function isDevicePromptChallenge(text, url) {
  const rawUrl = String(url || "");
  const path = parseLoc(rawUrl).path;
  if (!/\/challenge\//i.test(path) || /\/challenge\/selection(?:\/|$)/i.test(path)) return false;
  if (/\/challenge\/(?:pwd|idvpin)(?:\/|$)/i.test(path) || IPP_CONSENT_RE.test(path)) return false;
  if (isSecurityCodeChallenge(text, rawUrl) || isAuthenticatorTotpContext(text, rawUrl)) return false;
  // /challenge/dp 是 Google Prompt 的稳定 URL。SPA 正文尚未 hydration 时可能只显示
  // “确认身份”等泛化文案；仅靠正文会先被 riskReason 误判为风控并过早终止。
  if (/\/challenge\/dp(?:\/|$)/i.test(path)) return true;
  return DEVICE_PROMPT_RE.test(String(text || ""));
}

function isAccountChooserContext(text, url) {
  const rawUrl = String(url || "");
  if (/\/challenge\//i.test(rawUrl)) return false;
  return /\/(?:accountchooser|signinchooser)(?:[/?#]|$)/i.test(rawUrl)
    || /Choose an account|Use another account|选择(一个)?账[号户戶]|選擇(一個)?帳戶|使用其他账[号户戶]|使用其他帳戶/i.test(String(text || ""));
}

// 「确认是你本人 / 获取验证码(默认给手机发短信)」类页：URL 形如 /challenge/ipp/consent。
// 这页通常只有「发送验证码(短信) Send」和「试试其他方式 / More ways to verify」，没有密码/验证码输入框。
// 实测案例：打开 two-step-verification 设置页被重定向到这里；若尝试自动处理会因页面含
// "verification code" 被 TOTP 分支误吞、还点了页面上的邮箱 → 跳 accountchooser → 反复绕最后卡密码页。
// 按用户要求：命中即【快速失败(need_verify)】，绝不点「试试其他方式」、不进 accountchooser、不在此填密码/TOTP。
const IPP_CONSENT_RE = /\/challenge\/ipp\/consent|\/challenge\/ipp\b/i;
// 文案回退（当 URL 不含 ipp 但确是「确认是你本人 + 发送验证码」页时用；需配合「无凭据/验证码输入框 + 有 Send 按钮 + 无身份验证器选项」）。
const VERIFY_SENDCODE_RE = /Get a verification code|We'?ll send you a|will send (you )?a (verification|text)|send a verification code|Verify it'?s you|确认是你本人|確認是你本人|确认是您本人|想确认是您本人|向.{0,24}(发送|發送).{0,8}验证码|發送驗證碼|获取验证码|取得驗證碼/i;

// 仅用于 URL 不是 ipp/consent 时的“短信页文案兜底”。Google Prompt 设备通知页也会出现
// “确认是你本人 / 已发送通知 / 重新发送”，必须显式排除，否则会被误判成短信并提前终止。
function isSmsConsentTextFallback(text, state = {}) {
  if (state.onDevicePrompt || state.hasCredInput || state.totpInputVisible || state.hasAuthenticatorOption) return false;
  const value = String(text || "");
  const hasCodeMeaning = /verification code|text message|短信|簡訊|验证码|驗證碼|SMS/i.test(value);
  const hasSendCodeAction = /send.{0,24}(verification code|text message)|(?:发送|發送).{0,12}(?:验证码|驗證碼)|we'?ll send you a/i.test(value);
  return VERIFY_SENDCODE_RE.test(value) && hasCodeMeaning && hasSendCodeAction;
}

// —— 「密码不可用」信号（密码错误 / 密码已被更改）——
// 账号库存的是旧密码时，Google 密码页会在提交后（或作为提示）显示这类文案。命中即判「库里密码已失效」，
// 立即登录失败、停止重试，不要因为字段被清空/hydration 就把它误当成「空提交需重填」而反复登录。
//
// 拆成两类只为在 detail 里给出更贴切的原因（changed / wrong），判定上等价（都归同一失败分支）。
//
// (1) 密码「已被更改」：中/繁/英多写法 + 「N 天前更改」回退。
//     - "Your password was changed 6 days ago"（英文，截图实测文案）
//     - "您的密码已于…更改" / "密码…天前…更改" / "密码已更改"（简中）
//     - "密碼…已變更/已更改"（繁中）
const PWD_CHANGED_RE = /Your password was (recently |just )?changed|password (was|has been) changed(\s+(a while ago|\d+\s+(day|days|hour|hours|week|weeks|month|months)\s+ago))?|您?的?密[码碼](已|於|于|在).{0,16}(更改|變更|变更|修改)|密[码碼].{0,12}(天前|小时前|小時前|週前|周前|个月前|個月前).{0,10}(更改|變更|变更|修改)|密[码碼]已(更改|變更|变更|修改)/i;

// (2) 密码「错误」：Google 直接判密码不对时的文案（中/繁/英）。
const WRONG_PWD_RE = /Wrong password|Incorrect password|That password is incorrect|The password you entered (is|was) incorrect|输入的密码有误|輸入的密碼有誤|密码错误|密碼錯誤|密码有误|密碼有誤|密码不正确|密碼不正確|密码不对|密碼不對/i;

// 从文案里尽量抠出「N 天前」的天数，用于 detail 提示（抠不到就返回 null，不影响判定）。
function extractPwdChangeDays(text) {
  const s = String(text || "");
  const m = s.match(/changed\s+(\d+)\s+days?\s+ago/i) || s.match(/(\d+)\s*天前/);
  return m ? m[1] : null;
}

// 纯函数：给密码页文案分类为「密码不可用」信号。抽出来便于确定性单测（脱离 puppeteer）。
//   返回 { failed, reason:'changed'|'wrong'|'', days:string|null }
function classifyPasswordProblem(text) {
  if (PWD_CHANGED_RE.test(text)) return { failed: true, reason: "changed", days: extractPwdChangeDays(text) };
  if (WRONG_PWD_RE.test(text)) return { failed: true, reason: "wrong", days: null };
  return { failed: false, reason: "", days: null };
}

// 某时刻落在第几个 TOTP 窗口（counter）。用它判断「是否已跨到新窗口」——
// 重试时必须换到不同 counter，否则重新生成的还是同一个错码。
function totpCounter(nowMs) {
  return Math.floor(nowMs / 1000 / TOTP_STEP);
}

// 纯函数：给定当前时刻与「要避开的窗口序号」，判断现在能否取码提交、否则该等多久。
// 抽出来是为了能脱离 puppeteer/真实时间做确定性单测，证明「窗口边界等新码 + 重试换窗」逻辑正确。
//   - ready=true 表示当前窗口既新(!=avoidCounter)又有足够余量(>=minMargin)，可立即取码；
//   - 否则 waitMs 为「睡到下一个窗口起点 + 300ms 抖动缓冲」，跨窗后再判一次必然满足。
function totpSubmitPlan(nowMs, avoidCounter, minMargin = MIN_TOTP_MARGIN_SEC) {
  const counter = totpCounter(nowMs);
  const secondsLeft = TOTP_STEP - Math.floor((nowMs / 1000) % TOTP_STEP);
  const freshWindow = avoidCounter === null || typeof avoidCounter !== "number" || counter !== avoidCounter;
  const ready = freshWindow && secondsLeft >= minMargin;
  return { counter, secondsLeft, freshWindow, ready, waitMs: ready ? 0 : secondsLeft * 1000 + 300 };
}

// 读当前可见输入框的值（用于判断是否已经填好，避免重复清空重打）。
async function curValue(page, selectors) {
  const h = await visibleFirst(page, selectors);
  if (!h) return null;
  const v = await h.evaluate((n) => n.value).catch(() => null);
  await h.dispose().catch(() => {});
  return v;
}

// 填完点「下一步」并等待离开当前步骤（host/path 变化）。
//
// 两个核心问题都在这里根治：
//  1) 空提交（截图里"密码框空 + 请输入密码"的根因）：React 密码/验证码页 hydration 慢时，DOM 里有值
//     但受控组件内部 state 仍为空，点下一步会提交空值并弹回。对策：点「下一步」【之前】务必 read-back
//     校验（ensureValue：值必须 === 期望且非空，用原生 setter + 派发 input/change 让 React 真正收值），
//     值不就绪就【绝不点】；若上一次点了没前进，则强制再派发一次事件把值同步进 React state。
//  2) 慢：老实现固定 22s、每 2.5s 才动一次，空提交场景一路干等到超时、外层再重试多轮 → 卡半天。
//     对策：点后短轮询（~350ms）等跳转，命中即返回；空提交自愈（重填 + 重点）在秒级完成，并有空提交
//     计数上限，不再干等。sel/value 给定时才做 read-back 与补填。
async function submitStep(page, beforeUrl, sel, value, totalMs = 15000, onSubmit = null) {
  const before = parseLoc(beforeUrl);
  const deadline = Date.now() + totalMs;
  let emptyGuard = 0;
  while (Date.now() < deadline) {
    const now = parseLoc(page.url());
    if (now.path !== before.path || now.host !== before.host) return true;

    if (sel && value != null) {
      // read-back 就绪校验（force:true）：点「下一步」前【每次】都用原生 setter 重新赋值并派发 input/change，
      // 确保受控组件(React)内部 state 与 DOM 值同步——这样即使 fillField 派发事件时页面还没 hydration、
      // 值只进了 DOM 没进 React state，这里也会在点击前把它同步好，从根上杜绝"DOM 有值但空提交"。
      // setter 赋的是同一个值，幂等、不清空重打、无闪烁。
      const ready = await ensureValue(page, sel, value, { force: true });
      if (!ready) {
        emptyGuard += 1;
        if (emptyGuard > 6) return false; // 反复填不进 → 交外层判定，不在这里干等
        await sleep(250);
        continue; // 值没就绪，绝不点下一步（杜绝空提交）
      }
    }

    const clicked = await clickNext(page).catch(() => false);
    if (clicked && typeof onSubmit === "function") onSubmit();

    // 点后短轮询等跳转：命中立即返回；~1.4s 内没前进就回到上面重判（重新同步值再点一次）。
    for (let i = 0; i < 4; i += 1) {
      await sleep(350);
      const n2 = parseLoc(page.url());
      if (n2.path !== before.path || n2.host !== before.host) return true;
    }
  }
  return false;
}

// 只看主机名/路径判断登录态，避免被 continue= 参数里的域名误导。
function parseLoc(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { host: u.hostname.toLowerCase(), path: u.pathname.toLowerCase() };
  } catch (_) {
    return { host: "", path: "" };
  }
}

// 跳过 passkey / 加恢复方式等可选插页时点的「以后/跳过/取消」按钮，覆盖主流语言。
const SKIP_WORDS = [
  "Not now", "No thanks", "Skip", "Maybe later", "Remind me later", "Not yet", "Later", "Cancel", "No, thanks",
  "Ahora no", "No, gracias", "Omitir", "Saltar", "Más tarde", "Cancelar",
  "Plus tard", "Pas maintenant", "Ignorer", "Annuler", "Non merci", "Passer",
  "Später", "Jetzt nicht", "Überspringen", "Abbrechen", "Nein danke",
  "Позже", "Не сейчас", "Пропустить", "Отмена",
  "後で", "今は表示しない", "スキップ", "キャンセル", "あとで",
  "나중에", "건너뛰기", "취소",
  "以后再说", "稍后再说", "稍后", "暂不", "暂时不", "跳过", "以后", "取消", "现在不要", "下次", "暫時不要", "略過",
];

function escapeRe(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SKIP_SOURCES = SKIP_WORDS.map((w) => `^${escapeRe(w)}$`);

async function bodyText(page) {
  return page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
}

async function visibleFirst(page, selectors) {
  for (const sel of selectors) {
    const handle = await page.$(sel).catch(() => null);
    if (!handle) continue;
    const visible = await handle.evaluate((n) => {
      const r = n.getBoundingClientRect();
      const s = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    }).catch(() => false);
    if (visible) return handle;
    await handle.dispose().catch(() => {});
  }
  return null;
}

async function typeInto(page, handle, value) {
  await handle.click({ clickCount: 3 }).catch(() => {});
  await handle.evaluate((n) => { n.value = ""; }).catch(() => {});
  await handle.type(String(value), { delay: 40 }).catch(() => {});
}

// 直接给输入框赋值并触发 input/change（React 受控组件也能识别）。
async function setValueViaJs(handle, value) {
  return handle.evaluate((n, v) => {
    const proto = n instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    return n.value;
  }, value).catch(() => null);
}

/**
 * 点「下一步」前的 read-back 就绪校验：确认受控输入框的值稳定等于期望值（非空）。
 * React hydration 慢时会把刚填的值清掉 / 内部 state 为空 → 空提交。故：读回当前值；
 * 为空/不等（或 opts.force）就用原生 setter 赋值 + 派发 input/change（让 React 受控组件识别并更新 state），
 * 短等一拍后复核。最多几次。返回值「是否已就绪、可安全点下一步」。
 *   - opts.force：上一次点击没能前进时置 true，强制再派发一次事件把 DOM 值同步进 React state
 *     （对应"DOM 有值但受控 state 空"这种点了没反应的情形）。
 */
async function ensureValue(page, selectors, value, opts = {}) {
  const target = String(value);
  for (let i = 0; i < 3; i += 1) {
    const h = await visibleFirst(page, selectors);
    if (!h) { await sleep(200); continue; }
    let v = await h.evaluate((n) => n.value).catch(() => null);
    if (v !== target || (opts.force && i === 0)) {
      await setValueViaJs(h, target);
      await sleep(160); // 给 React 一拍处理 onChange 更新内部 state
      v = await h.evaluate((n) => n.value).catch(() => null);
    }
    await h.dispose().catch(() => {});
    if (v === target) return true;
    await sleep(180);
  }
  return false;
}

/**
 * 健壮填字段：每次重新定位输入框，逐字符输入后回读校验；
 * 不一致就重试，再不行用 JS 赋值兜底。返回是否填成功。
 * Google 识别页会实时重渲染输入框，导致逐字符输入丢字（填一半），必须回读校验。
 */
async function fillField(page, selectors, value) {
  const target = String(value);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const handle = await visibleFirst(page, selectors);
    if (!handle) { await sleep(400); continue; }
    try {
      await handle.click({ clickCount: 3 }).catch(() => {});
      await handle.evaluate((n) => { n.value = ""; }).catch(() => {});
      await handle.type(target, { delay: 30 }).catch(() => {});
      await sleep(200);
      // 关键：打字后再补一次「原生 setter 赋值 + 派发 input/change 事件」。
      // Google 登录页 hydration 慢时，React 在我们打字时还没挂上监听，
      // DOM 的 value 虽然对了，但 React 内部状态仍是空，点下一步会提交空值并弹回。
      // 这步确保受控组件真正收到值。
      let val = await setValueViaJs(handle, target);
      if (val == null) val = await handle.evaluate((n) => n.value).catch(() => null);
      await sleep(150);
      if (val === target) { await handle.dispose().catch(() => {}); return true; }
    } finally {
      await handle.dispose().catch(() => {});
    }
    await sleep(300);
  }
  return false;
}

// 在页面里按文本/aria-label 找可见的可点击元素并点击。sources 为正则字符串数组。
async function clickText(page, sources) {
  return page.evaluate((src) => {
    const regexes = src.map((s) => new RegExp(s, "i"));
    const candidates = [...document.querySelectorAll("button, a, [role='button'], div, span")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((el) => ({
        el,
        tag: el.tagName,
        role: el.getAttribute("role") || "",
        text: [el.textContent || "", el.getAttribute("aria-label") || ""].join(" ").replace(/\s+/g, " ").trim(),
        area: Math.max(1, el.getBoundingClientRect().width * el.getBoundingClientRect().height),
      }))
      .filter((item) => item.text && regexes.some((rx) => rx.test(item.text)))
      .sort((a, b) => {
        const ac = /button/i.test(a.role) || /^(button|a)$/i.test(a.tag) ? 0 : 1;
        const bc = /button/i.test(b.role) || /^(button|a)$/i.test(b.tag) ? 0 : 1;
        return ac - bc || a.area - b.area;
      });
    if (!candidates[0]) return false;
    candidates[0].el.scrollIntoView({ block: "center", inline: "center" });
    candidates[0].el.click();
    return true;
  }, sources).catch(() => false);
}

// 给可能在页面跳转中挂死的操作（点击 / evaluateHandle / 等待）套个超时，超时返回 fallback（绝不抛）。
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    Promise.resolve(promise).catch(() => fallback).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

// 真实 CDP 输入点击：ElementHandle.click() 优先，失败退回 page.mouse 坐标点击。
// Google 账号页 / 验证方式列表对合成事件常不响应，真实输入更可靠（与 detect-gpt 的 realClick 同约定）。
async function realClickHandle(page, handle) {
  const el = handle && handle.asElement ? handle.asElement() : null;
  if (!el) return false;
  const doClick = (async () => {
    try { await el.evaluate((n) => n.scrollIntoView({ block: "center", inline: "center" })); } catch (_) { /* ignore */ }
    try { await el.click({ delay: 30 }); return true; } catch (_) { /* 退回坐标点击 */ }
    try {
      const box = await el.boundingBox();
      if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 }); return true; }
    } catch (_) { /* ignore */ }
    return false;
  })();
  return withTimeout(doClick, 8000, false);
}

// 按正则在页面里找「最具体」的文本节点，向上提升到真实可点击祖先后用 CDP 真实点击。
// Google 登录页有时把按钮文字放在 span，外层则是只有 jsaction/tabindex、没有标准 role 的 div；
// 只搜 button/[role=button] 会看得到文字却拿不到目标。优先最短文本、再取最小面积，避免点到整块大容器。
async function realClickByText(page, reSrc) {
  let handle = null;
  try {
    handle = await withTimeout(page.evaluateHandle((src) => {
      const re = new RegExp(src, "i");
      const selector = "button, a, li, [role='link'], [role='button'], [data-challengetype], [jsaction], [data-action], [tabindex='0'], div, span";
      const clickableSelector = "button, a, [role='link'], [role='button'], [data-challengetype], [jsaction], [data-action], [tabindex='0'], li";
      const cands = [...document.querySelectorAll(selector)]
        .filter((n) => {
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0
            && s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none"
            && !n.closest("[hidden], [inert]")
            && n.getAttribute("aria-disabled") !== "true" && !n.disabled;
        })
        .map((n) => {
          const r = n.getBoundingClientRect();
          const t = [n.textContent || "", n.getAttribute("aria-label") || ""].join(" ").replace(/\s+/g, " ").trim();
          return { n, t, area: Math.max(1, r.width * r.height) };
        })
        .filter((o) => o.t && o.t.length < 140 && re.test(o.t))
        .sort((a, b) => a.t.length - b.t.length || a.area - b.area);
      if (!cands[0]) return null;
      return cands[0].n.closest(clickableSelector) || cands[0].n;
    }, reSrc), 6000, null);
    return await realClickHandle(page, handle);
  } catch (_) {
    return false;
  } finally {
    if (handle && handle.dispose) await handle.dispose().catch(() => {});
  }
}

// 验证方式列表里是否存在「身份验证器」项（用于：没有就判需人工，不死循环）。
async function hasAuthenticatorOption(page) {
  return withTimeout(page.evaluate((src) => {
    const re = new RegExp(src, "i");
    return [...document.querySelectorAll("button, a, li, [role='link'], [role='button'], [data-challengetype], [jsaction], [data-action], [tabindex='0'], div, span")]
      .some((n) => {
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n);
        return r.width > 0 && r.height > 0
          && s.visibility !== "hidden" && s.display !== "none"
          && !n.closest("[hidden], [inert]")
          && n.getAttribute("aria-disabled") !== "true" && !n.disabled
          && re.test([n.textContent || "", n.getAttribute("aria-label") || ""].join(" ").replace(/\s+/g, " ").trim());
      });
  }, AUTH_OPTION_RE.source), 5000, false);
}

async function waitForAuthMethodList(page, totalMs = 3500) {
  const deadline = Date.now() + totalMs;
  let sawSelectionUrl = false;
  while (Date.now() < deadline) {
    if (/\/challenge\/selection(?:[/?#]|$)/i.test(page.url())) sawSelectionUrl = true;
    if (AUTH_OPTION_RE.test(await bodyText(page))) return true;
    await sleep(250);
  }
  // URL 先切到 selection、DOM 后渲染是 Google SPA 的常见时序。这里至少等完整个窗口，
  // 然后把控制权交给 selection 分支继续做有限次数的就绪等待，不能一看到 URL 就立即判“无身份验证器”。
  return sawSelectionUrl;
}

// 从设备通知 / g.co/sc 安全代码页打开「其他验证方式」。先用 ElementHandle/坐标真实点击；
// 页面没有标准可点击语义或真实点击未推进时，再用 DOM click 兜底，并确认确实进入方式列表。
async function openAlternativeMethods(page) {
  const physical = await realClickByText(page, TRY_ANOTHER_RE.source);
  if (physical && await waitForAuthMethodList(page)) return true;
  const synthetic = await clickText(page, [TRY_ANOTHER_RE.source]);
  if (synthetic && await waitForAuthMethodList(page)) return true;
  return false;
}

async function waitForAuthenticatorTotp(page, totalMs = 6000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const text = await bodyText(page);
    const url = page.url();
    const input = await visibleFirst(page, TOTP_SELECTORS);
    const visible = !!input;
    if (input) await input.dispose().catch(() => {});
    if (shouldFillTotp(text, url, visible)) return true;
    await sleep(250);
  }
  return false;
}

// 选择方式列表里的“Google 身份验证器”，并验证页面确实进入 challenge/totp 且输入框已出现。
// ElementHandle.click() 返回成功只代表输入事件已发出，不代表 Google SPA 接受了该点击。
async function chooseAuthenticatorMethod(page, transitionMs = 6000) {
  const physical = await realClickByText(page, AUTH_OPTION_RE.source);
  if (physical && await waitForAuthenticatorTotp(page, transitionMs)) return true;
  const synthetic = await clickText(page, [AUTH_OPTION_RE.source]);
  if (synthetic && await waitForAuthenticatorTotp(page, transitionMs)) return true;
  return false;
}

async function clickNext(page) {
  const ok = await page.evaluate(() => {
    const ids = ["#identifierNext", "#passwordNext", "#totpNext"];
    for (const id of ids) {
      const host = document.querySelector(id);
      if (host) {
        const btn = host.querySelector("button") || host;
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { btn.click(); return true; }
      }
    }
    return false;
  }).catch(() => false);
  if (ok) return true;
  return clickText(page, [
    "^Next$", "^Continue$", "^Verify$", "^下一步$", "^继续$", "^验证$",
    "^Siguiente$", "^Continuar$", "^Suivant$", "^Weiter$", "^次へ$", "^다음$",
  ]);
}

function riskReason(text, url) {
  const path = parseLoc(url).path;
  const hay = `${text}\n${url}`;
  if (/This browser or app may not be secure|Try using a different browser|此浏览器或应用可能不安全|请尝试使用其他浏览器/i.test(hay)) {
    return "Google 判定该浏览器环境不安全（自动化被拦）";
  }
  if (/captcha|recaptcha|证明您不是自动程序|验证您不是机器人/i.test(hay)) {
    return "出现验证码 / 人机验证，需人工处理";
  }
  // 所有 /challenge/... 页面都交给下方专门状态机：dp/selection/totp/ipp 有明确处理，
  // Google 新增的未知 challenge 也会有限等待 hydration 后返回“未知验证页”。否则 SPA 壳上的
  // “Verify it's you / 验证身份”会在真实验证方式出现前被误判成笼统风控。
  if (path === "/" || /\/challenge(?:\/|$)/i.test(path)) return "";
  if (/suspicious|unusual activity|verify it'?s you|可疑|异常活动|验证身份/i.test(hay)
    && !isDevicePromptChallenge(text, url)
    && !/Authenticator|verification code|身份验证器|验证码应用|totp/i.test(hay)) {
    return `Google 要求额外身份验证（可疑登录，页面：${path || "未知"}）`;
  }
  return "";
}

/**
 * 填 2FA 验证码并提交。
 *
 * 反复输错的根因多在「取码/提交时机」而非密钥本身，这里逐条防住：
 *   - 窗口边界：提交前确保当前窗口还剩 >= MIN_TOTP_MARGIN_SEC 秒，不足就等到下一个新窗口再取码，
 *     避免输入/网络到达 Google 时已跨窗被判错；
 *   - 重试换窗：opts.avoidCounter 给定上次用过的窗口序号时，强制等到不同窗口再取码，
 *     否则同一 30s 窗内重新生成的还是同一个错码，必然继续错；
 *   - 对时漂移：每次取码前对时，重试时 forceSync 强制刷新偏移；
 *   - 输入可靠：用 fillField（清空→逐字符输入→原生 setter 派发事件→回读校验 value==code），
 *     防止丢字/旧值残留/受控组件没收到值。
 *
 * @param {object} [opts]
 * @param {number|null} [opts.avoidCounter] 上次提交用过的窗口序号，重试时避开它
 * @param {boolean} [opts.forceSync] 是否强制重新对时（重试时为 true）
 * @returns {Promise<number|false>} 成功返回本次实际使用的窗口序号（供下次重试避开），失败返回 false
 */
async function fillTotp(page, secret, opts = {}) {
  const avoidCounter = typeof opts.avoidCounter === "number" ? opts.avoidCounter : null;

  // 先确认这是“身份验证器”页面且输入框可见。Google 安全代码(g.co/sc)、短信、备用码等页面
  // 也可能使用 idvPin/type=tel；只看输入框会把 TOTP 填错验证方式。
  const pageText = await bodyText(page);
  const pageUrl = page.url();
  const probe = await visibleFirst(page, TOTP_SELECTORS);
  if (!probe) return false;
  await probe.dispose().catch(() => {});
  if (!shouldFillTotp(pageText, pageUrl, true)) return false;

  // 每次取码前对时；重试时强制刷新，防止缓存内的旧偏移已不准。
  await syncTime({ force: !!opts.forceSync });

  // 等到一个「码足够新、且与上次不同窗口」的时刻再取码：
  // 任一条件不满足就睡到下一个窗口起点(+300ms 抖动缓冲)后重判，跨窗后必然满足。
  for (let guard = 0; guard < 40; guard += 1) {
    const plan = totpSubmitPlan(accurateNow(), avoidCounter);
    if (plan.ready) break;
    await sleep(plan.waitMs);
  }

  // counter 与 code 用同一个时间戳算，避免在边界处两次读时间落到不同窗口。
  const now = accurateNow();
  const usedCounter = totpCounter(now);
  const { code } = totp.generate(secret, { now });

  // 用带回读校验的健壮填法，确保提交的就是这 6 位（fillField 会校验最终 value === code）。
  const ok = await fillField(page, TOTP_SELECTORS, code);
  if (!ok) return false;
  // 点提交前再 read-back 一次并强制同步 React state：防 hydration 把码清掉造成"验证码空提交"。
  await ensureValue(page, TOTP_SELECTORS, code, { force: true });

  if (!(await clickNext(page))) {
    const h = await visibleFirst(page, TOTP_SELECTORS);
    if (h) {
      await h.press("Enter").catch(() => {});
      await h.dispose().catch(() => {});
    }
  }
  await sleep(1500);
  return usedCounter;
}

const LOGIN_REASON_CODES = new Set([
  "ok", "password_correct",
  "password_wrong", "password_changed", "credentials_missing",
  "totp_missing", "totp_invalid", "totp_flow_error",
  "captcha", "device_prompt", "sms_verification", "security_code", "no_supported_2fa",
  "risk_verification", "browser_blocked", "browser_start_failed",
  "account_disabled", "account_not_found",
  "unknown_challenge", "timeout", "other",
]);

function loginDetailText(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  return Object.values(detail).filter(Boolean).join(" ");
}

function normalizedPasswordChangedDays(result, detailText = "") {
  const explicit = Math.floor(Number(result && result.daysAgo));
  if (Number.isFinite(explicit) && explicit >= 0 && explicit <= 36500) return explicit;
  const extracted = Math.floor(Number(extractPwdChangeDays(detailText)));
  return Number.isFinite(extracted) && extracted >= 0 && extracted <= 36500 ? extracted : null;
}

/**
 * 把 Google 页面的人话结果归一为稳定 reasonCode。关键终态会显式传 reasonCode；
 * 这里同时保留文案兜底，兼容旧分支和 Google 文案细微变化。
 */
function inferLoginReasonCode(result = {}) {
  const explicit = String(result.reasonCode || "");
  if (LOGIN_REASON_CODES.has(explicit)) return explicit;
  if (result.outcome === "ok") return "ok";

  const text = loginDetailText(result.detail);
  if (/缺少邮箱或密码|账号资料.*缺失/i.test(text)) return "credentials_missing";
  if (/密码已被更改|密码.*天前更改|password was changed/i.test(text)) return "password_changed";
  if (/密码错误|密码与 Google.*不一致|wrong password|incorrect password/i.test(text)) return "password_wrong";
  if (/缺少\s*2FA\s*密钥|缺少.*TOTP/i.test(text)) return "totp_missing";
  if (/验证码连续错误|2FA 密钥很可能不正确|动态码.*(错误|不正确)|wrong.*(?:totp|authenticator)|incorrect.*(?:totp|authenticator)/i.test(text)) return "totp_invalid";
  if (/2FA.*(?:反复报错|无法切换)|身份验证器.*(?:反复|无法进入)|TOTP.*(?:失败|异常)/i.test(text)) return "totp_flow_error";
  if (/captcha|recaptcha|人机验证|不是机器人|不是自动程序/i.test(text)) return "captcha";
  if (/浏览器环境不安全|自动化被拦|browser or app may not be secure|different browser/i.test(text)) return "browser_blocked";
  if (/短信验证|发送验证码到手机|SMS/i.test(text)) return "sms_verification";
  if (/Google 安全代码|g\.co\/sc|安全代码.*页面/i.test(text)) return "security_code";
  if (/设备通知验证|查看您的.*(?:手机|设备)|Google Prompt/i.test(text)) return "device_prompt";
  if (/无[「\"]?身份验证器|仅有设备通知|无法自动跳过 passkey|通行密钥.*人工/i.test(text)) return "no_supported_2fa";
  if (/停用|封禁|disabled|deniedsigninrejected/i.test(text)) return "account_disabled";
  if (/找不到该账号|找不到.*Google 账号|账号.*不存在|No account found/i.test(text)) return "account_not_found";
  if (/尚未识别的 Google 验证页面|未识别.*challenge/i.test(text)) return "unknown_challenge";
  if (/打开登录页失败|浏览器.*(?:启动|接管).*失败|CDP|调试地址|Target closed|Session closed|detached/i.test(text)) return "browser_start_failed";
  if (/可疑登录|额外身份验证|拒绝验证|环境\/IP 不被信任|unknownerror|瞬时\/风控/i.test(text)) return "risk_verification";
  if (/超时|timeout|timed out|未完成，停在/i.test(text)) return "timeout";
  return "other";
}

// 给登录结果打状态标记 + stop 标志：
//   - status.login 保留粗粒度值，继续兼容现有筛选/归位；
//   - lastLoginCheck 持久化精确原因，刷新或重启后账号行仍能显示；
//   - stop=true 时，引擎跳过该账号后续所有步骤（没登录成功，后面都白做）。
function tagLogin(r) {
  const reasonCode = inferLoginReasonCode(r);
  const needVerifyCodes = new Set([
    "totp_flow_error", "captcha", "device_prompt", "sms_verification", "security_code",
    "no_supported_2fa", "risk_verification", "browser_blocked", "unknown_challenge",
  ]);
  let s;
  if (r.outcome === "ok") s = "ok";
  else if (reasonCode === "totp_missing" || reasonCode === "totp_invalid") s = "2fa_error";
  else if (r.outcome === "need_verify" || needVerifyCodes.has(reasonCode)) s = "need_verify";
  else s = "failed";

  const detail = loginDetailText(r.detail) || (r.outcome === "ok" ? "登录成功" : "登录未通过");
  const lastLoginCheck = {
    reasonCode,
    outcome: r.outcome === "ok" ? "ok" : (r.outcome === "need_verify" ? "need_verify" : "error"),
    detail,
    checkedAt: new Date().toISOString(),
  };
  const daysAgo = reasonCode === "password_changed" ? normalizedPasswordChangedDays(r, detail) : null;
  if (daysAgo != null) lastLoginCheck.daysAgo = daysAgo;
  // 只有本次结果确实证明“密码被 Google 接受/拒绝”时，才取代独立密码检测。
  // 缺资料、缺 TOTP、浏览器启动失败、提交前的人机验证等都没有核验密码，不能抹掉旧结论。
  const supersedesPasswordCheck = r.passwordSubmitted === true && new Set([
    "ok", "password_wrong", "password_changed",
    "totp_invalid", "totp_flow_error", "device_prompt", "sms_verification",
    "security_code", "no_supported_2fa", "unknown_challenge",
  ]).has(reasonCode);
  const fieldPatch = { ...(r.fieldPatch || {}), lastLoginCheck };
  if (supersedesPasswordCheck) fieldPatch.lastPasswordCheck = null;
  return {
    ...r,
    reasonCode,
    statusPatch: { ...(r.statusPatch || {}), login: s },
    fieldPatch,
    stop: r.outcome !== "ok",
  };
}

// “仅检测账号密码”的结果单独持久化，不把“密码已被接受”冒充成完整登录成功。
// 无论结果如何都 stop=true：这个动作必须独立运行，绝不接着执行 2FA 或其它账号动作。
function tagPasswordCheck(r) {
  const reasonCode = r.outcome === "ok" ? "password_correct" : inferLoginReasonCode(r);
  const detail = loginDetailText(r.detail) || (r.outcome === "ok" ? "密码正确" : "密码检测未通过");
  const lastPasswordCheck = {
    reasonCode,
    outcome: r.outcome === "ok" ? "ok" : (r.outcome === "need_verify" ? "need_verify" : "error"),
    detail,
    checkedAt: new Date().toISOString(),
  };
  const daysAgo = reasonCode === "password_changed" ? normalizedPasswordChangedDays(r, detail) : null;
  if (daysAgo != null) lastPasswordCheck.daysAgo = daysAgo;
  return {
    ...r,
    reasonCode,
    statusPatch: { ...(r.statusPatch || {}) },
    fieldPatch: { ...(r.fieldPatch || {}), lastPasswordCheck },
    stop: true,
  };
}

function isPasswordAcceptedDestination(url) {
  const { host, path } = parseLoc(url);
  // 本动作的 continue 固定为 My Account。about:blank、chrome-error://、代理门户或任意外站
  // 都不能证明 Google 接受了密码；跨域成功只认这个明确的 Google 目的页。
  if (host === "myaccount.google.com") return true;
  if (host !== "accounts.google.com") return false;
  // Google 接受密码后才会进入二次验证 challenge 或可选插页；回到 identifier/accountchooser
  // 不算成功，避免异常跳转被误报为“密码正确”。
  if (/\/challenge\//i.test(path) && !/\/challenge\/pwd(?:\/|$)/i.test(path)) return true;
  return /\/speedbump(?:\/|$)/i.test(path);
}

// 密码检测专用的一次性提交。只选择 passwordNext，并且一旦发起 click（哪怕随后因导航导致
// execution context/detached 异常）就视为“已经尝试提交”，后续只读观察，绝不再 clickText/按 Enter。
// 只有页面根本没有 passwordNext 时，才以密码框 Enter 作为唯一一次提交方式。
async function submitPasswordOnce(page, selectors, opts = {}) {
  const findVisible = opts.visibleFirst || visibleFirst;
  const button = await findVisible(page, ["#passwordNext button", "button#passwordNext", "#passwordNext"]);
  if (button) {
    let confirmed = true;
    try {
      await button.click();
    } catch (_) {
      // 点击可能已经触发导航；异常不代表没有发出输入事件，禁止任何第二次尝试。
      confirmed = false;
    } finally {
      await button.dispose().catch(() => {});
    }
    return { attempted: true, confirmed };
  }

  const input = await findVisible(page, selectors);
  if (!input) return { attempted: false, confirmed: false };
  let confirmed = true;
  try {
    await input.press("Enter");
  } catch (_) {
    // 与 click 相同：按键可能已触发导航，进入只读观察而不是重复提交。
    confirmed = false;
  } finally {
    await input.dispose().catch(() => {});
  }
  return { attempted: true, confirmed };
}

// 打开登录页的冷启动重试由完整登录与“仅检测密码”共用。返回的新 page 可能替换掉清数据后
// 已 detached 的旧 page；调用方必须使用返回值继续。
async function openLoginPage(page, ctx) {
  await sleep(1000);
  const MAX_OPEN_TRIES = 8;
  for (let i = 0; i < MAX_OPEN_TRIES; i += 1) {
    try {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      return { page, error: null };
    } catch (err) {
      if (i === MAX_OPEN_TRIES - 1) return { page, error: err };
      const dead = /detached|Target closed|Session closed|frame got detached|Navigating frame was detached/i.test(err.message);
      if (dead && ctx && ctx.browser) {
        try {
          const fresh = await ctx.browser.newPage();
          fresh.waitForTimeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          page = fresh;
        } catch (_) { /* 下一轮再试 */ }
      }
      await sleep(2000);
    }
  }
  return { page, error: new Error("打开登录页失败") };
}

// 密码只提交一次，然后进入纯只读观察：不重按“下一步”，不点验证方式，不填任何验证码。
// opts 中的依赖覆盖只用于确定性单测，生产调用全部使用真实页面函数。
async function submitPasswordCheck(page, beforeUrl, selectors, value, opts = {}) {
  const label = opts.label || "password";
  const ensure = opts.ensureValue || ensureValue;
  const submitOnce = opts.submitOnce || (opts.clickNext
    ? async (targetPage) => {
      // 兼容确定性测试的旧注入点。调用一旦开始，抛错也按“可能已提交”处理，绝不 fallback。
      try { return (await opts.clickNext(targetPage)) !== false; } catch (_) { return true; }
    }
    : submitPasswordOnce);
  const readBody = opts.bodyText || bodyText;
  const pause = opts.sleep || sleep;
  const totalMs = Number.isFinite(opts.totalMs) ? opts.totalMs : 12000;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 300;

  const ready = await ensure(page, selectors, value, { force: true });
  if (!ready) {
    return { outcome: "error", reasonCode: "other", detail: { [label]: "密码未能可靠填入，已停止且没有提交" } };
  }

  const rawSubmission = await submitOnce(page, selectors).catch(() => ({ attempted: false, confirmed: false }));
  const submission = rawSubmission && typeof rawSubmission === "object"
    ? rawSubmission : { attempted: !!rawSubmission, confirmed: !!rawSubmission };
  if (!submission.attempted) {
    return { outcome: "error", reasonCode: "other", detail: { [label]: "未找到密码页“下一步”，密码未提交" } };
  }

  const before = parseLoc(beforeUrl);
  const deadline = Date.now() + totalMs;
  do {
    await pause(pollMs);
    const url = page.url();
    const loc = parseLoc(url);
    const text = await readBody(page);
    const stillPasswordPath = /\/challenge\/pwd|\/signin\/[^/]*\/pwd/i.test(loc.path);

    // “密码错误/已更改”只允许在提交后仍停留密码页时解析。My Account 等成功目的页也可能
    // 展示“密码于 N 天前更改”的安全历史，不能把那种说明文字误判成密码失败。
    if (stillPasswordPath) {
      const problem = classifyPasswordProblem(text);
      if (problem.failed) {
        const detail = problem.reason === "changed"
          ? `密码已被更改${problem.days ? `（提示：${problem.days} 天前更改）` : ""}，账号库密码已失效`
          : "密码错误：账号库密码与 Google 现有密码不一致";
        return {
          outcome: "error",
          reasonCode: problem.reason === "changed" ? "password_changed" : "password_wrong",
          daysAgo: problem.reason === "changed" && problem.days != null ? Number(problem.days) : undefined,
          detail: { [label]: detail },
        };
      }
    }

    if (/\/disabled\b|deniedsigninrejected/i.test(loc.path)) {
      return { outcome: "error", reasonCode: "account_disabled", detail: { [label]: "该账号已被停用/封禁，无法确认密码" } };
    }
    if (/Couldn'?t find your Google Account|找不到您的 ?Google 账[号戶]|No account found|找不到帐户/i.test(text)) {
      return { outcome: "error", reasonCode: "account_not_found", detail: { [label]: "Google 提示找不到该账号" } };
    }

    // 人机/浏览器拦截不能证明密码对错，必须报告“无法确认”，不能误标密码正确。
    const risk = riskReason(text, url);
    if (risk) {
      return { outcome: "need_verify", detail: { [label]: `${risk}；无法确认密码是否正确` } };
    }
    if (/\/signin\/rejected/i.test(loc.path) || /we couldn'?t verify it'?s you|无法验证是你本人|未能验证是您本人/i.test(text)) {
      return { outcome: "need_verify", reasonCode: "risk_verification", detail: { [label]: "Google 拒绝验证当前环境，无法确认密码是否正确" } };
    }

    const moved = loc.host !== before.host || loc.path !== before.path;
    if (moved && !stillPasswordPath && isPasswordAcceptedDestination(url)) {
      // 点击/Enter 若因导航竞态抛错，只能确定“可能提交过”，不能确定事件确实发出。
      // 即使随后恰好落到已登录会话的 My Account，也不冒险报告密码正确。
      if (!submission.confirmed) {
        return {
          outcome: "need_verify",
          reasonCode: "other",
          detail: { [label]: "密码提交状态不确定，无法可靠确认密码；已停止且没有再次提交" },
        };
      }
      return {
        outcome: "ok",
        reasonCode: "password_correct",
        detail: { [label]: "密码正确（Google 已接受密码，已停止，未继续两步验证）" },
      };
    }
  } while (Date.now() < deadline);

  return {
    outcome: "need_verify",
    reasonCode: "timeout",
    detail: { [label]: "密码只提交了一次，但页面未给出明确结果；已停止，未继续操作" },
  };
}

async function login(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  if (!account.email || !account.password) {
    return tagLogin({ outcome: "error", reasonCode: "credentials_missing", detail: { login: "缺少邮箱或密码" } });
  }
  if (!account.totpSecret) {
    return tagLogin({ outcome: "error", reasonCode: "totp_missing", detail: { login: "缺少 2FA 密钥（TOTP），无法自动过两步验证" } });
  }

  // 开页重试：清空数据(clearDataForOrigin)后浏览器要花几秒重建 frame，
  // 这期间任何 page 的 goto 都会 detached。所以：
  //   1) 先给一段 settle 等清理动作落地；
  //   2) 失败就从 browser 新开干净 page 再来（废掉的 page 上重试没意义）；
  //   3) 重试窗口放宽到 ~16s，覆盖清理高峰。
  const opened = await openLoginPage(page, ctx);
  if (opened.error) return tagLogin({ outcome: "error", reasonCode: "browser_start_failed", detail: { login: `打开登录页失败：${opened.error.message}` } });
  page = opened.page;

  const flowMeta = { passwordSubmitted: false };
  const r = await driveAuthFlow(page, account, emit, {
    label: "login",
    flowMeta,
    // 登录成功：到 myaccount，或离开 accounts.google.com 到其它 google 子域（且已填过邮箱密码）。
    isDone: (host, path, st) => host === "myaccount.google.com"
      || (host && host.endsWith("google.com") && host !== "accounts.google.com" && st.emailFilled && st.passwordFilled),
  });
  return tagLogin({ ...r, passwordSubmitted: flowMeta.passwordSubmitted });
}

async function checkPassword(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const open = ctx && ctx.openLoginPage ? ctx.openLoginPage : openLoginPage;
  const drive = ctx && ctx.driveAuthFlow ? ctx.driveAuthFlow : driveAuthFlow;
  if (!account.email || !account.password) {
    return tagPasswordCheck({ outcome: "error", reasonCode: "credentials_missing", detail: { password: "缺少邮箱或密码" } });
  }

  const opened = await open(page, ctx);
  if (opened.error) {
    return tagPasswordCheck({ outcome: "error", reasonCode: "browser_start_failed", detail: { password: `打开登录页失败：${opened.error.message}` } });
  }
  page = opened.page;

  const result = await drive(page, account, emit, {
    label: "password",
    passwordOnly: true,
    // 已有会话直接跳到 My Account 不代表本次密码被验证；密码检测必须实际提交一次密码。
    isDone: () => false,
  });
  return tagPasswordCheck(result);
}

/**
 * 通用「过身份验证流程」循环：处理 邮箱 / 密码 / 2FA / passkey插页 / 账号选择 / 风险页。
 * 登录和「敏感操作前重新验证(reauth)」复用同一套。opts.isDone(host,path,state) 决定何时算完成。
 */
async function driveAuthFlow(page, account, emit, opts = {}) {
  const label = opts.label || "auth";
  const isDone = opts.isDone || ((host) => host === "myaccount.google.com");
  const passwordOnly = opts.passwordOnly === true;
  // 敏感设置动作可显式要求：遇到 Google 默认的短信/设备验证时，优先切到已有身份验证器。
  // 默认关闭，避免改变普通登录动作已经稳定的快速失败语义。
  const preferAuthenticator = opts.preferAuthenticator === true;
  const flowMeta = opts.flowMeta && typeof opts.flowMeta === "object" ? opts.flowMeta : null;
  const st = { emailFilled: false, passwordFilled: false };
  let speedbumpStuck = 0;
  let emailFillTries = 0;
  let passwordFillTries = 0;
  let totpErrorTries = 0;
  let totpWrongTries = 0;
  // 设备通知页 →「试试其他方式」→ 选「身份验证器」这条切换链路的尝试次数，超过即判需人工，防止在
  // 「设备通知页 / 验证方式列表」之间打转死循环。
  let authSwitchTries = 0;
  // selection URL 往往先出现、选项 DOM 随后才 hydration；连续若干轮都没有身份验证器后才能判定确实不可用。
  let selectionEmptyTries = 0;
  // domcontentloaded 不等于 challenge 正文/输入框已 hydration。未知 challenge 先只读等待几轮，期间绝不乱点。
  let unknownChallengeKey = "";
  let unknownChallengeSettleTries = 0;
  // 记录上一次提交用过的 TOTP 窗口序号，重试时据此换到新窗口取新码（核心防「重复提交同一错码」）。
  let lastTotpCounter = null;
  // Google 偶发「出了点问题，请重试」的 unknownerror 页尝试次数（多为瞬时/风控，需重试而非空转）。
  let unknownErrorTries = 0;

  for (let step = 0; step < 40; step += 1) {
    // 首轮不空等（页面刚 goto 完已可读），之后每步只等 800ms 让页面 settle。
    if (step > 0) await sleep(800);
    const url = page.url();
    const { host, path } = parseLoc(url);
    const text = await bodyText(page);
    emit(`${label}_state`, { step, url: url.slice(0, 80) });

    // g.co/sc 安全代码页虽可能带「Verify it's you」，但它可以切换到身份验证器，不能先当风险页终止。
    const onSecurityCode = isSecurityCodeChallenge(text, url);
    const risk = onSecurityCode ? "" : riskReason(text, url);
    if (risk) return { outcome: "need_verify", detail: { [label]: risk } };

    if (/\/disabled\b|deniedsigninrejected/i.test(path)) {
      return { outcome: "error", reasonCode: "account_disabled", detail: { [label]: "该账号已被停用/封禁" } };
    }

    // Google 拒绝「确认是你本人」：环境/IP 不被信任，敏感操作无法自动完成，需人工在常用设备上操作。
    if (/\/signin\/rejected/i.test(path) || /we couldn'?t verify it'?s you|couldn'?t verify it'?s you|无法验证是你本人|未能验证是您本人/i.test(text)) {
      return { outcome: "need_verify", reasonCode: "risk_verification", detail: { [label]: "Google 拒绝验证「确认是你本人」（环境/IP 不被信任），无法自动完成，需人工在常用设备上操作" } };
    }

    if (isDone(host, path, st)) {
      emit(`${label}_done`, {});
      return { outcome: "ok", reasonCode: "ok", detail: { [label]: "通过" }, fieldPatch: {} };
    }

    // 密码检测必须由本次提交来得出结论。若尚未提交密码就已经进入其它登录态/验证页，
    // 只能判“无法确认”，并且不点击该页面的任何按钮。
    if (passwordOnly && !st.passwordFilled) {
      if (host && host !== "accounts.google.com") {
        return { outcome: "need_verify", reasonCode: "other", detail: { [label]: "检测到已有登录会话，未实际提交密码，无法确认；请开启清除数据后重试" } };
      }
      if (/\/challenge\//i.test(path) && !/\/challenge\/pwd(?:\/|$)/i.test(path)) {
        return { outcome: "need_verify", detail: { [label]: "尚未提交密码就进入了额外验证页面，已停止且未点击任何验证方式" } };
      }
      // 密码提交前只允许停留在账号识别、账号选择或密码页；unknownerror、speedbump、
      // OAuth/consent 等其它页一律只读停止，避免“仅验证密码”偷偷点击额外按钮。
      const allowedPrePasswordPath = path === "/"
        || /\/(?:servicelogin|identifier|accountchooser|signinchooser)(?:\/|$)/i.test(path)
        || /\/challenge\/pwd(?:\/|$)/i.test(path);
      if (!allowedPrePasswordPath) {
        return { outcome: "need_verify", reasonCode: "other", detail: { [label]: `密码提交前出现非预期页面（${path || "未知"}），已停止且未执行额外交互` } };
      }
    }

    // Google 偶发「出了点问题，请重试」的 unknownerror 页（accounts.google.com/v3/signin/unknownerror），
    // 多为瞬时/风控，常见于登录尾段多域 checkConnection（youtube 等）。老实现无分支处理 → 空转 40 步后误判。
    // 处理：点页面上的「下一步/重试/Try again/Next」推进；点不动或仍停在 unknownerror 就 reload 重跑该步；
    // 有限次仍不行才判 need_verify。reload 会带着 continue= 重新走一遍，往往能过掉瞬时错误（若此时已登录成功，
    // reload 会直接续跳到目标域，下一轮 isDone 命中）。
    if (/\/signin\/unknownerror/i.test(path) || /[?&]unknownerror\b/i.test(url)) {
      unknownErrorTries += 1;
      emit(`${label}_unknownerror`, { tries: unknownErrorTries });
      if (unknownErrorTries > 6) {
        return { outcome: "need_verify", reasonCode: "risk_verification", detail: { [label]: "Google 反复返回「出了点问题」(unknownerror)，多为瞬时/风控，请稍后人工重试" } };
      }
      const advanced = await clickText(page, ["^下一步$", "^重试$", "^再试一次$", "^Try again$", "^Next$", "^Continue$", "^Retry$", "^다시 시도$", "^Réessayer$"]);
      await sleep(1500);
      if (!advanced || /\/signin\/unknownerror/i.test(parseLoc(page.url()).path)) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await sleep(2500);
      }
      continue;
    }

    // 密码不可用（密码错误 / 密码已被更改）：账号库里存的是旧密码 → 立即判失败、停止重试。
    //
    // 判定时机（避免误判「首次进入密码页时的提示」）：只在
    //   ① st.passwordFilled 已为 true（说明我们确实已经把库里密码填进去并点了提交），且
    //   ② 此刻仍停在密码页（challenge/pwd 或密码框仍可见，说明那次提交没能前进）
    // 两个条件都满足、又命中「密码错误/密码被更改」文案时才判失败。
    // Google 有时会把「Your password was changed N days ago / 您的密码已于N天前更改」作为提示显示，
    // 但只有在「提交库里密码后仍卡在密码页并出现该提示/报错」时才是真失败——上面两个门槛正是为此设的，
    // 首次进入密码页(passwordFilled=false)或已成功前进(不在密码页)都不会命中。
    if (st.passwordFilled) {
      const onPwdPage = /\/challenge\/pwd|\/signin\/[^/]*\/pwd/i.test(path)
        || await visibleFirst(page, ["input[type='password']", "input[name='Passwd']"])
          .then((h) => { if (h) h.dispose().catch(() => {}); return !!h; });
      if (onPwdPage) {
        const prob = classifyPasswordProblem(text);
        if (prob.failed) {
          emit("password_invalid", { reason: prob.reason, days: prob.days || "" });
          const detailMsg = prob.reason === "changed"
            ? `密码已被更改${prob.days ? `（提示：${prob.days} 天前更改）` : ""}，账号库密码已失效，需更新密码`
            : "密码错误：账号库密码与 Google 现有密码不一致，账号库密码已失效，需更新密码";
          return {
            outcome: "error",
            reasonCode: prob.reason === "changed" ? "password_changed" : "password_wrong",
            daysAgo: prob.reason === "changed" && prob.days != null ? Number(prob.days) : undefined,
            detail: { [label]: detailMsg },
          };
        }
      }
    }

    // 2FA「验证码错误」：密钥多半不对（每次生成的码都不对）。连续错 2 次就立刻停下并明确提示，
    // 既不死循环，又避免反复试错把账号试到锁定。
    if (/\/challenge\/totp/i.test(url)
      && /wrong code|incorrect code|code is incorrect|that code didn'?t work|enter a valid code|验证码(输入)?(错误|有误|不正确)|输入的验证码有误|动态密码错误|验证码无效/i.test(text)) {
      totpWrongTries += 1;
      emit("totp_wrong", { tries: totpWrongTries });
      if (totpWrongTries >= 2) {
        return { outcome: "need_verify", reasonCode: "totp_invalid", detail: { [label]: "2FA 验证码连续错误：该账号的 2FA 密钥很可能不正确，已停止（避免反复试错锁号）。请人工核对该账号的 2FA 密钥。" } };
      }
      // 再给一次机会：强制对时、避开上次窗口，等到新窗口用新码重填。
      // 这样若密钥正确，新窗口的新码会通过；只有连续不同窗口的码都错，才说明密钥真的不对。
      if (account.totpSecret) {
        const c = await fillTotp(page, account.totpSecret, { avoidCounter: lastTotpCounter, forceSync: true });
        if (typeof c === "number") lastTotpCounter = c;
      }
      continue;
    }

    // 2FA 验证页偶发「出了点问题，请重试」弹窗：点「重新开始」复位 → 用新的验证码重填，避免卡死。
    if (/\/challenge\//i.test(url) && /出了点问题|出現問題|Something went wrong|Sorry, something went wrong/i.test(text)) {
      totpErrorTries += 1;
      if (totpErrorTries > 4) {
        return { outcome: "need_verify", reasonCode: "totp_flow_error", detail: { [label]: "2FA 反复报错「出了点问题，请重试」，需人工处理" } };
      }
      emit("totp_retry", { tries: totpErrorTries });
      await clickText(page, ["^重新开始$", "^重新開始$", "^重试$", "^再试一次$", "^Try again$", "^Start over$", "^Retry$"]);
      await sleep(2000);
      if (account.totpSecret) {
        const c = await fillTotp(page, account.totpSecret, { avoidCounter: lastTotpCounter, forceSync: true });
        if (typeof c === "number") lastTotpCounter = c;
      }
      continue;
    }

    // 2FA「设备通知验证(Google Prompt)」页 +「选择验证方式」页：统一切到「身份验证器」走 TOTP。
    //  - 设备通知页（查看您的设备 / 在手机上点按 + 屏幕数字）必须真人手机操作、自动化无法完成 →
    //    点「试试其他方式」展开验证方式列表，再选「身份验证器」。
    //  - 验证方式列表页（challenge/selection，列了 手机提示/验证器/passkey/安全码/短信 多种）→ 直接选「身份验证器」。
    //  - 列表里没有「身份验证器」（仅设备通知/安全密钥/备用码等无法自动完成的方式）→ 判需人工，不死循环。
    // 注意必须排在 speedbump / TOTP 分支之前：设备通知页 & 选择页带「试试其他方式」「Use your passkey」等字样，
    // 否则会被下面的 passkey 插页 / TOTP 分支误判而卡死。
    // 关键前置：选择页/设备通知页都不含「邮箱/密码」输入框。先排除掉「邮箱页/密码页」，
    // 否则密码页里「不妨『选择』试试其他方式…更安全地『登录』…方式」之类的提示文案会被
    // 「选择.*(验证|登录).*方式」误命中，把密码页错判成选择页（实测踩到的坑）。
    const hasCredInput = await visibleFirst(page, [
      "input[type='email']", "input[name='identifier']", "#identifierId",
      "input[type='password']", "input[name='Passwd']",
    ]).then((h) => { if (h) h.dispose().catch(() => {}); return !!h; });
    const totpInputVisible = await visibleFirst(page, TOTP_SELECTORS)
      .then((h) => { if (h) h.dispose().catch(() => {}); return !!h; });
    // 选择验证方式页：URL 为 /challenge/selection 时【权威判定】，即使页面残留了隐藏的邮箱/密码框
    // （实测：selection 页常带一个残留密码框，会让下面的密码分支误当密码页 filling_password 空转）也照判选择页；
    // 仅"靠文案识别"的回退才需 !hasCredInput 保护（避免把密码页的「选择…方式」提示文案误判成选择页）。
    const onSelection = /\/challenge\/selection/i.test(url)
      || (!hasCredInput && /Choose how you want to sign in|选择.*(验证|登录).*方式|選擇.*(驗證|登入).*方式|选择您要.*的方式|選擇您要.*的方式/i.test(text));
    // 设备通知页以「challenge URL + 专属文案」判定，不受 Google SPA 残留输入框影响。
    // classifier 已明确排除 selection / challenge/totp / g.co/sc，因而不会误填或误切其他验证码页。
    const onDevicePrompt = isDevicePromptChallenge(text, url);

    // Google 安全代码页（g.co/sc / challenge/ootp）有一个看起来很像 TOTP 的 6 位输入框，
    // 但它要求从另一台已登录设备获取安全代码。这里绝不填账号库里的 TOTP：先点「尝试其他方式」，
    // 回到验证方式列表，下一轮再由现有 onSelection 分支精确选择 Google 身份验证器。
    if (onSecurityCode) {
      authSwitchTries += 1;
      emit("security_code_challenge", { tries: authSwitchTries });
      if (authSwitchTries > 3) {
        return {
          outcome: "need_verify",
          reasonCode: "security_code",
          detail: { [label]: "当前是 Google 安全代码（g.co/sc）页面，不是身份验证器动态码；反复无法切换验证方式，需人工处理" },
        };
      }
      const switched = await openAlternativeMethods(page);
      if (!switched) {
        await sleep(800);
        continue;
      }
      continue;
    }

    // ★ 短信「确认是你本人 / 发送验证码到手机」页(/challenge/ipp/consent)：按用户要求【放弃自动处理，立即快速失败】。
    //   不点「试试其他方式」、不进 accountchooser、不在密码页打转——几秒内返回 need_verify，避免 40s+ 绕圈。
    //   仅在「无凭据框、无验证码框」时判定（这页只有「发送验证码」和「试试其他方式」，没有可自动填的输入）；
    //   URL 命中 ipp/consent 直接失败；纯文案回退需同时满足「确认是你本人/发送验证码」+ 有「Send/发送」按钮，
    //   且此刻没有可用「身份验证器」选项（保护：万一是含验证器的选择页，仍交给下面的分支自动过，不误杀）。
    const smsDetail = { [label]: "触发短信验证（Google 要求发送验证码到手机「确认是你本人」），无法自动处理，需人工在常用设备上完成验证" };
    // URL 是权威信号：即使 SPA 残留看似可见的 password/tel，也必须立即失败，绝不能往残留框写值。
    if (IPP_CONSENT_RE.test(url)) {
      if (preferAuthenticator && account.totpSecret) {
        authSwitchTries += 1;
        emit("sms_consent_switch_authenticator", { tries: authSwitchTries });
        if (authSwitchTries <= 3 && await openAlternativeMethods(page)) continue;
        if (authSwitchTries < 3) continue;
        return {
          outcome: "need_verify",
          reasonCode: "sms_verification",
          detail: { [label]: "已识别短信确认页，但无法切换到账号现有的身份验证器，需人工处理" },
        };
      }
      emit("sms_consent_fail", {});
      return { outcome: "need_verify", reasonCode: "sms_verification", detail: smsDetail };
    }
    if (isSmsConsentTextFallback(text, {
      onDevicePrompt,
      hasCredInput,
      totpInputVisible,
      hasAuthenticatorOption: false,
    })) {
      if (!(await hasAuthenticatorOption(page))) {
        if (preferAuthenticator && account.totpSecret) {
          authSwitchTries += 1;
          emit("sms_consent_switch_authenticator", { tries: authSwitchTries });
          if (authSwitchTries <= 3 && await openAlternativeMethods(page)) continue;
          if (authSwitchTries < 3) continue;
        }
        emit("sms_consent_fail", {});
        return { outcome: "need_verify", reasonCode: "sms_verification", detail: smsDetail };
      }
    }

    if (!onSelection) selectionEmptyTries = 0;
    if (onSelection || onDevicePrompt) {
      // 还停在设备通知页：先点「试试其他方式」展开验证方式列表，等列表出现再进入下面的选择逻辑。
      if (onDevicePrompt && !onSelection) {
        authSwitchTries += 1;
        emit("device_prompt", { tries: authSwitchTries });
        if (authSwitchTries > 3) {
          return {
            outcome: "need_verify",
            reasonCode: "device_prompt",
            detail: { [label]: "已识别 Google 设备通知验证，但反复无法进入身份验证器选择页，需人工处理" },
          };
        }
        const switched = await openAlternativeMethods(page);
        if (!switched && authSwitchTries >= 3) {
          return {
            outcome: "need_verify",
            reasonCode: "device_prompt",
            detail: { [label]: "已识别 Google 设备通知验证，但无法点击“试试其他方式”进入身份验证器选择页，需人工处理" },
          };
        }
        continue;
      }
      // 验证方式列表页：优先选「身份验证器」。
      emit("choose_2fa_method", {});
      if (await hasAuthenticatorOption(page)) {
        selectionEmptyTries = 0;
        authSwitchTries += 1;
        if (authSwitchTries > 6) {
          return { outcome: "need_verify", reasonCode: "totp_flow_error", detail: { [label]: "两步验证页反复无法切换到「身份验证器」，需人工处理" } };
        }
        const picked = await chooseAuthenticatorMethod(page);
        if (picked) {
          // 已验证 URL/输入框确实进入 TOTP；下一轮交给现有对时、取码和重试逻辑。
          continue;
        }
        // 有此项但点击后未进入 TOTP（渲染时机/坐标偏差）：仍留在列表页，短等后重试。
        await sleep(1200);
        continue;
      }
      // URL 可能已到 selection，但选项 DOM 还没有 hydration。先给有限 grace，不在第一轮误判“无身份验证器”。
      if (onSelection) {
        selectionEmptyTries += 1;
        emit("wait_2fa_methods", { tries: selectionEmptyTries });
        if (selectionEmptyTries <= 6) continue;
        return {
          outcome: "need_verify",
          reasonCode: "no_supported_2fa",
          detail: { [label]: "该账号两步验证仅有设备通知/安全密钥等方式，无「身份验证器」选项，无法自动完成，需人工验证" },
        };
      }
    }

    // passkey / speedbump 等可选插页 → 跳过。仅在「非 challenge 页」才把 passkey 字样当插页，
    // 否则会误吞掉上面的 2FA 选择页/验证页。
    const onChallenge = /\/challenge(?:\/|$)/i.test(path);
    if (/\/speedbump\//i.test(url) || (!onChallenge && /passkey|通行密钥|更快登录|simplify|simplifica/i.test(`${text}\n${url}`))) {
      emit("skip_speedbump", {});
      if (await clickText(page, SKIP_SOURCES)) {
        speedbumpStuck = 0;
        await sleep(1200);
        continue;
      }
      speedbumpStuck += 1;
      if (speedbumpStuck >= 4) {
        return { outcome: "need_verify", reasonCode: "no_supported_2fa", detail: { [label]: "无法自动跳过 passkey/插页，请人工处理" } };
      }
      continue;
    }

    if (/Couldn'?t find your Google Account|找不到您的 ?Google 账[号戶]|No account found|找不到帐户/i.test(text)) {
      return { outcome: "error", reasonCode: "account_not_found", detail: { [label]: "Google 提示找不到该账号（邮箱可能不存在或被删）" } };
    }

    // —— 判定当前处于哪个登录步骤：用页面上下文（URL 路径 + 可见输入框）划分，避免被
    //    "密码页/验证页里残留的隐藏邮箱框、验证页里残留的隐藏密码框"误导而进错分支。
    //    进错分支的后果（实测卡顿主因）：submitStep→clickNext 会点到本页的 passwordNext/totpNext，
    //    对空的密码/验证码做空提交，弹「请输入密码」并空转多轮 → 又错又慢。
    const onTotpPage = /\/challenge\/totp/i.test(url);
    const emailSel = ["input[type='email']", "input[name='identifier']", "#identifierId"];
    const passwordSel = ["input[type='password']", "input[name='Passwd']"];
    const emailVisible = await visibleFirst(page, emailSel).then((h) => { if (h) h.dispose().catch(() => {}); return !!h; });
    const passwordVisible = await visibleFirst(page, passwordSel).then((h) => { if (h) h.dispose().catch(() => {}); return !!h; });

    // 邮箱：仅在"识别页"才当作邮箱步骤——不在任何 /challenge/ 页，且没有可见密码框
    // （Google 密码/验证页常带一个用于无障碍/自动填充的邮箱输入，不排除会把密码页误判成邮箱步骤）。
    if (emailVisible && !passwordVisible && !onChallenge) {
      emit("filling_email", {});
      emailFillTries += 1;
      if (emailFillTries > 4) {
        return { outcome: "error", detail: { [label]: "邮箱反复填不进/被拒，停在识别页（疑似环境异常或账号无效）" } };
      }
      const beforeUrl = page.url();
      const already = await curValue(page, emailSel);
      if (already !== account.email) await fillField(page, emailSel, account.email);
      st.emailFilled = true;
      // 交给 submitStep：内部 read-back(ensureValue) 会在点下一步前再确保值就绪，绝不空提交。
      await submitStep(page, beforeUrl, emailSel, account.email);
      continue;
    }

    // 密码：有可见密码框、且不在 TOTP 验证页 / 选择验证方式页（这些页可能残留隐藏密码框）才当作密码步骤。
    if (passwordVisible && !onTotpPage && !/\/challenge\/selection/i.test(url)) {
      emit("filling_password", {});
      passwordFillTries += 1;
      if (passwordFillTries > 4) {
        return { outcome: "error", detail: { [label]: "密码反复填不进/被拒，停在密码页" } };
      }
      const beforeUrl = page.url();
      const already = await curValue(page, passwordSel);
      if (already !== account.password) await fillField(page, passwordSel, account.password);
      st.passwordFilled = true;
      if (passwordOnly) {
        return submitPasswordCheck(page, beforeUrl, passwordSel, account.password, {
          label,
          totalMs: opts.passwordCheckTimeoutMs,
          pollMs: opts.passwordCheckPollMs,
        });
      }
      await submitStep(page, beforeUrl, passwordSel, account.password, 15000, () => {
        if (flowMeta) flowMeta.passwordSubmitted = true;
      });
      continue;
    }

    // 2FA / TOTP：只有明确处于身份验证器上下文时才允许填码。通用的“verification code / 输入验证码”
    // 不能作为依据，因为安全代码、短信、备用码页面也有同样文案和 6 位输入框。
    if (isAuthenticatorTotpContext(text, url)) {
      if (!totpInputVisible) {
        await page.waitForSelector(TOTP_SELECTOR_CSS, { visible: true, timeout: 6000 }).catch(() => {});
        continue;
      }
      emit("handling_totp", {});
      const c = await fillTotp(page, account.totpSecret, { avoidCounter: lastTotpCounter });
      if (typeof c === "number") {
        lastTotpCounter = c;
        // 提交后短轮询等离开 totp 页（Google 处理首次提交需一两秒）：避免误判"还在 totp"而重复填一次、
        // 白白多等一个 30s 窗口（实测能省掉一次多余的验证码提交）。仍停在 totp 才回到循环重试。
        for (let w = 0; w < 12 && /\/challenge\/totp/i.test(page.url()); w += 1) await sleep(500);
        continue;
      }
    }

    // 账号选择器：只在明确的 account chooser 页面点击目标邮箱。
    // 所有 challenge 页左侧都会显示当前邮箱；旧兜底会把它误当账号项点击，导致设备通知流程跑偏。
    if (isAccountChooserContext(text, url)) {
      const chosen = await clickText(page, [`^${escapeRe(account.email)}$`]);
      if (chosen) {
        emit("account_selected", {});
        await sleep(1000);
        continue;
      }
    }

    if (!onChallenge && /consent|oauth/i.test(url)) {
      await clickNext(page);
      continue;
    }

    // 未识别的 challenge 不再盲点“下一步”。这里可能是短信、设备确认、备用码或 Google 新增的
    // 验证方式；自动推进既可能选错方式，也可能提交空值。停下交给人工最安全。
    if (onChallenge) {
      const challengeKey = path || url.split("?")[0];
      if (challengeKey !== unknownChallengeKey) {
        unknownChallengeKey = challengeKey;
        unknownChallengeSettleTries = 0;
      }
      unknownChallengeSettleTries += 1;
      if (unknownChallengeSettleTries <= 6) {
        emit("wait_challenge_hydration", { tries: unknownChallengeSettleTries, path: challengeKey });
        continue;
      }
      return {
        outcome: "need_verify",
        reasonCode: "unknown_challenge",
        detail: { [label]: `遇到尚未识别的 Google 验证页面，已停止自动点击：${url.slice(0, 100)}` },
      };
    }
  }

  return {
    outcome: "need_verify",
    reasonCode: "timeout",
    detail: { [label]: `未完成，停在：${page.url().slice(0, 80)}` },
  };
}

/**
 * 敏感操作前的「重新验证(Verify it's you)」：调用方已 goto 到目标页，
 * 若被重定向到 accounts.google.com 验证则自动过密码/2FA，直到回到非 accounts 域。
 */
async function reauth(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  return driveAuthFlow(page, account, emit, {
    label: "reauth",
    preferAuthenticator: !!(ctx && ctx.preferAuthenticator),
    isDone: (host) => !!host && host !== "accounts.google.com",
  });
}

module.exports = login;
module.exports.reauth = reauth;
module.exports.checkPassword = checkPassword;
module.exports.helpers = {
  sleep, parseLoc, visibleFirst, fillField, setValueViaJs, ensureValue, curValue,
  clickText, clickNext, submitStep, fillTotp, bodyText, SKIP_SOURCES,
  totpCounter, totpSubmitPlan, TOTP_STEP, MIN_TOTP_MARGIN_SEC,
  withTimeout, realClickHandle, realClickByText, hasAuthenticatorOption,
  DEVICE_PROMPT_RE, TRY_ANOTHER_RE, AUTH_OPTION_RE, SECURITY_CODE_RE,
  isSecurityCodeChallenge, isAuthenticatorTotpContext, shouldFillTotp, isDevicePromptChallenge,
  waitForAuthMethodList, openAlternativeMethods, waitForAuthenticatorTotp, chooseAuthenticatorMethod,
  riskReason, isAccountChooserContext, driveAuthFlow, openLoginPage, submitPasswordOnce, submitPasswordCheck, tagPasswordCheck, isPasswordAcceptedDestination,
  IPP_CONSENT_RE, VERIFY_SENDCODE_RE, isSmsConsentTextFallback,
  classifyPasswordProblem, extractPwdChangeDays, PWD_CHANGED_RE, WRONG_PWD_RE,
  LOGIN_REASON_CODES, loginDetailText, normalizedPasswordChangedDays, inferLoginReasonCode, tagLogin,
};
