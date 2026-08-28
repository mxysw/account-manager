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
//      并在主循环里附加「当前无验证码输入框」的前置条件，避免误吞 TOTP 输入页。
const DEVICE_PROMPT_RE = /查看您的设备|查看你的设备|檢查您的裝置|打开\s*Google\s*应用|開啟\s*Google\s*應用|在您的(手机|手機|设备|裝置|平板)上(点按|輕觸|轻触)|点按(您)?(手机|设备|通知).{0,12}(数字|对应|相符|是)|轻触.{0,12}数字|點按.{0,12}數字|Check your (phone|device|tablet)|Open the Google app|Tap (Yes|the number)|Google sent (a|you a) notification|Get a Google prompt|Google 提示|不再(在此设备上)?(询问|詢問)|don'?t ask again on this device/i;

// 「试试其他方式 / 换一种方式」入口（点开后弹出验证方式列表）。
const TRY_ANOTHER_RE = /Try another way|Try a different way|More ways to verify|Try another method|Choose another way|试试其他方式|尝试其他方式|换一种方式|換一種方式|其他验证方式|其他驗證方式|別的方法|别的方式|다른 방법|다른 방식|Otra forma|Probar otra forma|Essayer une autre/i;

// 验证方式列表里「身份验证器」那一项（明确排除短信/安全密钥/备用码/设备通知）：
//   - Get a verification code from the Google Authenticator app
//   - 从 Google 身份验证器应用获取验证码 / 使用 Google 身份验证器应用
const AUTH_OPTION_RE = /Get a (verification|security) code from (the )?Google Authenticator|Get a code from (the )?Google Authenticator|Use (the |your )?Google Authenticator|Google Authenticator app|从.{0,8}(Google\s*)?身份验证器.{0,8}获取(验证码|安全码)|使用.{0,8}(Google\s*)?身份验证器|身份验证器应用|身分驗證器|验证码应用|從.{0,8}(Google\s*)?驗證器.{0,8}取得驗證碼/i;

// 「确认是你本人 / 获取验证码(默认给手机发短信)」类页：URL 形如 /challenge/ipp/consent。
// 这页通常只有「发送验证码(短信) Send」和「试试其他方式 / More ways to verify」，没有密码/验证码输入框。
// 实测案例：打开 two-step-verification 设置页被重定向到这里；若尝试自动处理会因页面含
// "verification code" 被 TOTP 分支误吞、还点了页面上的邮箱 → 跳 accountchooser → 反复绕最后卡密码页。
// 按用户要求：命中即【快速失败(need_verify)】，绝不点「试试其他方式」、不进 accountchooser、不在此填密码/TOTP。
const IPP_CONSENT_RE = /\/challenge\/ipp\/consent|\/challenge\/ipp\b/i;
// 文案回退（当 URL 不含 ipp 但确是「确认是你本人 + 发送验证码」页时用；需配合「无凭据/验证码输入框 + 有 Send 按钮 + 无身份验证器选项」）。
const VERIFY_SENDCODE_RE = /Get a verification code|We'?ll send you a|will send (you )?a (verification|text)|send a verification code|Verify it'?s you|确认是你本人|確認是你本人|确认是您本人|想确认是您本人|向.{0,24}(发送|發送).{0,8}验证码|發送驗證碼|获取验证码|取得驗證碼/i;

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
async function submitStep(page, beforeUrl, sel, value, totalMs = 15000) {
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

    await clickNext(page).catch(() => {});

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
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
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

// 按正则在页面里找「最具体(可见且面积最小)」的可点击元素并真实点击。
// 覆盖验证方式列表常见结构：<li> / div[role=link] / [role=button] / button / a。
// 取面积最小的匹配项，避免点到「包含全部选项文本的大容器」而点不中具体那一项。
async function realClickByText(page, reSrc) {
  let handle = null;
  try {
    handle = await withTimeout(page.evaluateHandle((src) => {
      const re = new RegExp(src, "i");
      const cands = [...document.querySelectorAll("li, div[role='link'], div[role='button'], [role='link'], [role='button'], button, a")]
        .filter((n) => (n.offsetWidth || n.offsetHeight))
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { n, t: (n.textContent || "").replace(/\s+/g, " ").trim(), area: Math.max(1, r.width * r.height) };
        })
        .filter((o) => o.t && o.t.length < 140 && re.test(o.t))
        .sort((a, b) => a.area - b.area);
      return cands[0] ? cands[0].n : null;
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
    return [...document.querySelectorAll("li, div[role='link'], div[role='button'], [role='link'], [role='button'], button, a")]
      .some((n) => (n.offsetWidth || n.offsetHeight) && re.test((n.textContent || "").replace(/\s+/g, " ").trim()));
  }, AUTH_OPTION_RE.source), 5000, false);
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
  const hay = `${text}\n${url}`;
  if (/This browser or app may not be secure|Try using a different browser|此浏览器或应用可能不安全|请尝试使用其他浏览器/i.test(hay)) {
    return "Google 判定该浏览器环境不安全（自动化被拦）";
  }
  if (/captcha|recaptcha|证明您不是自动程序|验证您不是机器人/i.test(hay)) {
    return "出现验证码 / 人机验证，需人工处理";
  }
  if (/suspicious|unusual activity|verify it'?s you|可疑|异常活动|验证身份/i.test(hay)
    && !/Authenticator|verification code|身份验证器|验证码应用|totp/i.test(hay)) {
    return "Google 要求额外身份验证（可疑登录）";
  }
  return "";
}

// 选「身份验证器(Authenticator)」这条 2FA 方式（页面可能默认给了别的方式）。
async function chooseAuthenticator(page) {
  const text = await bodyText(page);
  if (/challenge\/totp|Authenticator|身份验证器|验证码应用/i.test(`${text}\n${page.url()}`)) return true;
  if (/Try another way|Otra forma|别的方式|其他验证方式|换一种方式|別の方法|다른 방법/i.test(text)) {
    await clickText(page, ["Try another way", "试试其他方式", "其他验证方式", "换一种方式", "别的方式", "別の方法", "다른 방법"]);
    await sleep(1200);
  }
  const after = await bodyText(page);
  if (/Authenticator|身份验证器|验证码应用|获取验证码/i.test(after)) {
    await clickText(page, ["Google Authenticator", "Authenticator", "身份验证器", "验证码应用", "获取验证码"]);
    await sleep(800);
    return true;
  }
  return false;
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
  await chooseAuthenticator(page);

  // 先确认输入框在再做后续对时/等窗，避免在已经离开验证页时空等。
  const probe = await visibleFirst(page, TOTP_SELECTORS);
  if (!probe) return false;
  await probe.dispose().catch(() => {});

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

// 给登录结果打状态标记 + stop 标志：
//   - login 状态写回账号库，面板一眼可见（尤其 2fa_error）
//   - stop=true 时，引擎跳过该账号后续所有步骤（没登录成功，后面都白做）
function tagLogin(r) {
  const d = r.detail ? Object.values(r.detail).filter(Boolean).join(" ") : "";
  let s;
  if (r.outcome === "ok") s = "ok";
  else if (/2FA 密钥|验证码连续错误|缺少 2FA 密钥/.test(d)) s = "2fa_error";
  else if (r.outcome === "need_verify") s = "need_verify";
  else s = "failed";
  return { ...r, statusPatch: { ...(r.statusPatch || {}), login: s }, stop: r.outcome !== "ok" };
}

async function login(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  if (!account.email || !account.password) {
    return tagLogin({ outcome: "error", detail: { login: "缺少邮箱或密码" } });
  }
  if (!account.totpSecret) {
    return tagLogin({ outcome: "error", detail: { login: "缺少 2FA 密钥（TOTP），无法自动过两步验证" } });
  }

  // 开页重试：清空数据(clearDataForOrigin)后浏览器要花几秒重建 frame，
  // 这期间任何 page 的 goto 都会 detached。所以：
  //   1) 先给一段 settle 等清理动作落地；
  //   2) 失败就从 browser 新开干净 page 再来（废掉的 page 上重试没意义）；
  //   3) 重试窗口放宽到 ~16s，覆盖清理高峰。
  await sleep(1000);
  const MAX_OPEN_TRIES = 8;
  let opened = false;
  for (let i = 0; i < MAX_OPEN_TRIES && !opened; i += 1) {
    try {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      opened = true;
    } catch (err) {
      if (i === MAX_OPEN_TRIES - 1) return tagLogin({ outcome: "error", detail: { login: `打开登录页失败：${err.message}` } });
      const dead = /detached|Target closed|Session closed|frame got detached|Navigating frame was detached/i.test(err.message);
      if (dead && ctx && ctx.browser) {
        try {
          const fresh = await ctx.browser.newPage();
          fresh.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, ms));
          page = fresh;
        } catch (_) { /* 下一轮再试 */ }
      }
      await sleep(2000);
    }
  }

  const r = await driveAuthFlow(page, account, emit, {
    label: "login",
    // 登录成功：到 myaccount，或离开 accounts.google.com 到其它 google 子域（且已填过邮箱密码）。
    isDone: (host, path, st) => host === "myaccount.google.com"
      || (host && host.endsWith("google.com") && host !== "accounts.google.com" && st.emailFilled && st.passwordFilled),
  });
  return tagLogin(r);
}

/**
 * 通用「过身份验证流程」循环：处理 邮箱 / 密码 / 2FA / passkey插页 / 账号选择 / 风险页。
 * 登录和「敏感操作前重新验证(reauth)」复用同一套。opts.isDone(host,path,state) 决定何时算完成。
 */
async function driveAuthFlow(page, account, emit, opts = {}) {
  const label = opts.label || "auth";
  const isDone = opts.isDone || ((host) => host === "myaccount.google.com");
  const st = { emailFilled: false, passwordFilled: false };
  let speedbumpStuck = 0;
  let emailFillTries = 0;
  let passwordFillTries = 0;
  let totpErrorTries = 0;
  let totpWrongTries = 0;
  // 设备通知页 →「试试其他方式」→ 选「身份验证器」这条切换链路的尝试次数，超过即判需人工，防止在
  // 「设备通知页 / 验证方式列表」之间打转死循环。
  let authSwitchTries = 0;
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

    const risk = riskReason(text, url);
    if (risk) return { outcome: "need_verify", detail: { [label]: risk } };

    if (/\/disabled\b|deniedsigninrejected/i.test(path)) {
      return { outcome: "error", detail: { [label]: "该账号已被停用/封禁" } };
    }

    // Google 拒绝「确认是你本人」：环境/IP 不被信任，敏感操作无法自动完成，需人工在常用设备上操作。
    if (/\/signin\/rejected/i.test(path) || /we couldn'?t verify it'?s you|couldn'?t verify it'?s you|无法验证是你本人|未能验证是您本人/i.test(text)) {
      return { outcome: "need_verify", detail: { [label]: "Google 拒绝验证「确认是你本人」（环境/IP 不被信任），无法自动完成，需人工在常用设备上操作" } };
    }

    if (isDone(host, path, st)) {
      emit(`${label}_done`, {});
      return { outcome: "ok", detail: { [label]: "通过" }, fieldPatch: {} };
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
        return { outcome: "need_verify", detail: { [label]: "Google 反复返回「出了点问题」(unknownerror)，多为瞬时/风控，请稍后人工重试" } };
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
          return { outcome: "error", detail: { [label]: detailMsg } };
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
        return { outcome: "need_verify", detail: { [label]: "2FA 验证码连续错误：该账号的 2FA 密钥很可能不正确，已停止（避免反复试错锁号）。请人工核对该账号的 2FA 密钥。" } };
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
        return { outcome: "need_verify", detail: { [label]: "2FA 反复报错「出了点问题，请重试」，需人工处理" } };
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
      || (!hasCredInput && /Choose how you want to sign in|选择.*(验证|登录).*方式|选择您要.*的方式|選擇您要.*的方式/i.test(text));
    const onDevicePrompt = !hasCredInput && !totpInputVisible && /\/challenge\//i.test(url) && DEVICE_PROMPT_RE.test(text);

    // ★ 短信「确认是你本人 / 发送验证码到手机」页(/challenge/ipp/consent)：按用户要求【放弃自动处理，立即快速失败】。
    //   不点「试试其他方式」、不进 accountchooser、不在密码页打转——几秒内返回 need_verify，避免 40s+ 绕圈。
    //   仅在「无凭据框、无验证码框」时判定（这页只有「发送验证码」和「试试其他方式」，没有可自动填的输入）；
    //   URL 命中 ipp/consent 直接失败；纯文案回退需同时满足「确认是你本人/发送验证码」+ 有「Send/发送」按钮，
    //   且此刻没有可用「身份验证器」选项（保护：万一是含验证器的选择页，仍交给下面的分支自动过，不误杀）。
    if (!hasCredInput && !totpInputVisible) {
      const smsDetail = { [label]: "触发短信验证（Google 要求发送验证码到手机「确认是你本人」），无法自动处理，需人工在常用设备上完成验证" };
      if (IPP_CONSENT_RE.test(url)) {
        emit("sms_consent_fail", {});
        return { outcome: "need_verify", detail: smsDetail };
      }
      if (VERIFY_SENDCODE_RE.test(text) && /(\bSend\b|发送|發送)/.test(text) && !(await hasAuthenticatorOption(page))) {
        emit("sms_consent_fail", {});
        return { outcome: "need_verify", detail: smsDetail };
      }
    }

    if (onSelection || onDevicePrompt) {
      authSwitchTries += 1;
      if (authSwitchTries > 6) {
        return { outcome: "need_verify", detail: { [label]: "两步验证页反复无法切换到「身份验证器」，需人工处理" } };
      }
      // 还停在设备通知页：先点「试试其他方式」展开验证方式列表，等列表出现再进入下面的选择逻辑。
      if (onDevicePrompt && !onSelection) {
        emit("device_prompt", { tries: authSwitchTries });
        await realClickByText(page, TRY_ANOTHER_RE.source);
        await page.waitForFunction(
          (src) => new RegExp(src, "i").test(document.body ? document.body.innerText : ""),
          { timeout: 8000 },
          "Choose how you want to sign in|选择.*方式|選擇.*方式|Google Authenticator|身份验证器|身分驗證器|验证码应用",
        ).catch(() => {});
        await sleep(1000);
        continue;
      }
      // 验证方式列表页：优先选「身份验证器」。
      emit("choose_2fa_method", {});
      if (await hasAuthenticatorOption(page)) {
        const picked = await realClickByText(page, AUTH_OPTION_RE.source);
        if (picked) {
          // 等验证码输入框出现，再交给下面的 TOTP 分支填码（复用现有 TOTP 输入/对时/重试逻辑）。
          await page.waitForSelector(TOTP_SELECTOR_CSS, { visible: true, timeout: 12000 }).catch(() => {});
          await sleep(600);
          continue;
        }
        // 有此项却没点中（渲染时机/坐标偏差）：重开「试试其他方式」刷新列表后再试。
        await realClickByText(page, TRY_ANOTHER_RE.source);
        await sleep(1200);
        continue;
      }
      // 列表里确实没有「身份验证器」选项 → 仅设备通知/安全密钥等无法自动完成的方式，判需人工。
      if (onSelection) {
        return {
          outcome: "need_verify",
          detail: { [label]: "该账号两步验证仅有设备通知/安全密钥等方式，无「身份验证器」选项，无法自动完成，需人工验证" },
        };
      }
      // 设备通知页点开后仍没看到验证方式列表：再点一次「试试其他方式」（受 authSwitchTries 上限收敛）。
      await realClickByText(page, TRY_ANOTHER_RE.source);
      await sleep(1200);
      continue;
    }

    // passkey / speedbump 等可选插页 → 跳过。仅在「非 challenge 页」才把 passkey 字样当插页，
    // 否则会误吞掉上面的 2FA 选择页/验证页。
    const onChallenge = /\/challenge\//i.test(url);
    if (/\/speedbump\//i.test(url) || (!onChallenge && /passkey|通行密钥|更快登录|simplify|simplifica/i.test(`${text}\n${url}`))) {
      emit("skip_speedbump", {});
      if (await clickText(page, SKIP_SOURCES)) {
        speedbumpStuck = 0;
        await sleep(1200);
        continue;
      }
      speedbumpStuck += 1;
      if (speedbumpStuck >= 4) {
        return { outcome: "need_verify", detail: { [label]: "无法自动跳过 passkey/插页，请人工处理" } };
      }
      continue;
    }

    if (/Couldn'?t find your Google Account|找不到您的 ?Google 账[号戶]|No account found|找不到帐户/i.test(text)) {
      return { outcome: "error", detail: { [label]: "Google 提示找不到该账号（邮箱可能不存在或被删）" } };
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
      await submitStep(page, beforeUrl, passwordSel, account.password);
      continue;
    }

    // 2FA / TOTP
    if (/challenge\/totp|Authenticator|身份验证器|验证码应用|verification code|Try another way|试试其他方式|输入验证码/i.test(`${text}\n${url}`)) {
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

    // 账号选择器：点击目标邮箱。
    const chosen = await clickText(page, [`^${escapeRe(account.email)}$`]);
    if (chosen) {
      emit("account_selected", {});
      await sleep(1000);
      continue;
    }

    if (/consent|oauth|challenge|signin\/v2\/challenge/i.test(url)) {
      await clickNext(page);
      continue;
    }
  }

  return {
    outcome: "need_verify",
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
    isDone: (host) => !!host && host !== "accounts.google.com",
  });
}

module.exports = login;
module.exports.reauth = reauth;
module.exports.helpers = {
  sleep, parseLoc, visibleFirst, fillField, setValueViaJs, ensureValue, curValue,
  clickText, clickNext, submitStep, fillTotp, bodyText, SKIP_SOURCES,
  totpCounter, totpSubmitPlan, TOTP_STEP, MIN_TOTP_MARGIN_SEC,
  withTimeout, realClickHandle, realClickByText, hasAuthenticatorOption,
  DEVICE_PROMPT_RE, TRY_ANOTHER_RE, AUTH_OPTION_RE, IPP_CONSENT_RE, VERIFY_SENDCODE_RE,
  classifyPasswordProblem, extractPwdChangeDays, PWD_CHANGED_RE, WRONG_PWD_RE,
};
