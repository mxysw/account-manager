"use strict";

/**
 * 检测 GPT 一键授权：用「使用 Google 账户继续」登录 ChatGPT，看能否进入页面。
 *
 * 真机流程（来自探针）：
 *   1) 打开 chatgpt.com → 点「登录」弹出登录框 → 点「使用 Google 账户继续」
 *      （同标签跳转，不开 popup）。
 *   2) 跳到 accounts.google.com 账号选择器（redirect_uri=auth.openai.com/.../google）
 *      → 点中本账号。
 *   3) 过 OAuth 同意：
 *        - 失败：Google 跳到 /signin/rejected，页面「我们无法验证您的身份」→ blocked。
 *        - 成功：跳回 chatgpt.com 且不再显示登录框 → ok（能进页面即合格）。
 *        - 进得去但账号被停用/封禁 → banned。
 *
 * 说明：Claude / X 不单独检测——GPT 能授权，它们基本都能（按用户要求）。
 * 前置：引擎应先跑 login，使浏览器已登录 Google。
 */

const login = require("./login");
const { sleep, parseLoc } = login.helpers;

const CHATGPT = "https://chatgpt.com/";

const GOOGLE_BTN = "使用\\s*google|continue with google|sign in with google|log in with google";
const LOGIN_ENTRY = "^\\s*(log in|login|sign in|登录|登 录)\\s*$";
const CONSENT_BTN = "^\\s*(continue|allow|continue as|继续|允许|同意|确认)\\s*$";

const RE_REJECTED = /signin\/rejected/i;
const RE_CANT_VERIFY = /无法验证您的身份|无法验证身份|无法登录|couldn'?t (sign|verify)|can'?t sign you in|verify it'?s you|出了点问题|something went wrong/i;
const RE_LOGIN_MODAL = /使用 Google 账户继续|登录或注册|log in or sign up|continue with google/i;
const RE_BANNED = /deactivated|account (was )?(flagged|banned|suspended|disabled)|account has been (deactivated|disabled|suspended)|您的账号.*(停用|封禁|暂停|禁用)|已被(停用|封禁|禁用)|access denied|您无权/i;

// Cloudflare 人机验证（多见于 auth.openai.com）：中英文挑战页文案。
// 注意：CF 的「Access denied」与账号被封的文案有重叠，所以判定 CF 必须配合 DOM 标记/Ray ID，
// 且在主循环里「先查 CF 再查 banned」，避免把 CF 拦截误判成账号封禁。
const RE_CF_TEXT = /正在进行安全验证|请验证您是真人|验证您是真人|安全验证|verifying you are (a )?human|checking (your browser|if the site connection is secure)|needs to review the security of your connection|just a moment|稍候片刻|請稍候/i;

// 带超时读正文，避免页面跳转中 evaluate 挂死。
// 任何对页面的操作都可能在页面跳转中挂死，统一加超时护栏。
function withTimeout(promise, ms, def) {
  return Promise.race([Promise.resolve(promise).catch(() => def), new Promise((r) => setTimeout(() => r(def), ms))]);
}

async function readText(page) {
  return withTimeout(page.evaluate(() => (document.body ? document.body.innerText : "")), 4000, "");
}

// 合成鼠标事件点击：ChatGPT 的 React 按钮（登录入口 / 使用 Google 账户继续）对此有效，
// 反而对 puppeteer 的真实 click() 不开弹窗。
async function synthClick(page, reSrc) {
  return withTimeout(page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const hit = [...document.querySelectorAll("button,[role='button'],a")].find((n) => re.test((n.textContent || "").replace(/\s+/g, " ")) && (n.offsetWidth || n.offsetHeight));
    if (!hit) return false;
    hit.scrollIntoView({ block: "center" });
    const r = hit.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) hit.dispatchEvent(new MouseEvent(t, o));
    return true;
  }, reSrc), 6000, false);
}

// 真实输入点击（CDP 真实鼠标事件）：Google 账号选择器/同意页需要它，合成事件常不响应。
// 跳转期间 click 可能挂死，整体加超时。
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

async function realClickByText(page, reSrc) {
  let handle = null;
  try {
    handle = await withTimeout(page.evaluateHandle((src) => {
      const re = new RegExp(src, "i");
      return [...document.querySelectorAll("button,[role='button'],a")].find((n) => re.test((n.textContent || "").replace(/\s+/g, " ")) && (n.offsetWidth || n.offsetHeight)) || null;
    }, reSrc), 6000, null);
    return await realClickHandle(page, handle);
  } catch (_) { return false; } finally { if (handle && handle.dispose) await handle.dispose().catch(() => {}); }
}

async function pickAccount(page, email) {
  // 关键：先等账号元素就绪，否则选择器还在加载时点击无效（detect 早期失败的根因）。
  await withTimeout(page.waitForSelector("[data-identifier]", { visible: true }), 12000, null);
  let handle = null;
  try {
    handle = await withTimeout(page.evaluateHandle((mail) => {
      // Gmail 忽略本地部分的点和大小写：归一化后再比，避免「RamdoyalBrya.n135」对不上「ramdoyalbryan135」。
      const norm = (s) => (s || "").toLowerCase().trim().replace(/@googlemail\.com$/, "@gmail.com").replace(/\.(?=[^@]*@)/g, "");
      const target = norm(mail);
      // 账号行真实结构：div[role=link][data-identifier=邮箱]（已验证可点）。优先用它。
      const ids = [...document.querySelectorAll("[data-identifier]")];
      let hit = ids.find((n) => norm(n.getAttribute("data-identifier")) === target) || ids[0] || null;
      if (!hit) {
        hit = [...document.querySelectorAll("div[role='link'],li,a")].find((n) => {
          const t = (n.textContent || "").replace(/\s+/g, " ");
          return /@/.test(t) && !/使用其他账号|use another account|add account|添加账号|其他账号|remove/i.test(t) && (n.offsetWidth || n.offsetHeight);
        }) || null;
      }
      if (!hit) return null;
      // 合成事件先打一遍（完全加载后对账号选择器有效），再交给外面真实点击兜底。
      hit.scrollIntoView({ block: "center" });
      const r = hit.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) hit.dispatchEvent(new MouseEvent(t, o));
      return hit;
    }, email), 6000, null);
    return await realClickHandle(page, handle);
  } catch (_) { return false; } finally { if (handle && handle.dispose) await handle.dispose().catch(() => {}); }
}

async function hasGoogleBtn(page) {
  return withTimeout(page.evaluate((src) => {
    const re = new RegExp(src, "i");
    return [...document.querySelectorAll("button,[role='button'],a")].some((n) => re.test((n.textContent || "").replace(/\s+/g, " ")) && (n.offsetWidth || n.offsetHeight));
  }, GOOGLE_BTN), 5000, false);
}

// 判断当前是否卡在 Cloudflare 人机验证页。
// 优先看 URL/DOM 上的硬特征（turnstile iframe、challenge 容器、Ray ID），文案仅作辅助，避免误判。
async function isCloudflareChallenge(page) {
  const url = page.url();
  if (/challenges\.cloudflare\.com|__cf_chl|cf[-_]chl|cdn-cgi\/challenge/i.test(url)) return true;
  const probe = await withTimeout(page.evaluate(() => {
    const txt = (document.body ? document.body.innerText : "") || "";
    const html = document.documentElement ? document.documentElement.outerHTML : "";
    const hasTurnstile = !!document.querySelector(
      'iframe[src*="challenges.cloudflare.com"],script[src*="challenges.cloudflare.com"],.cf-turnstile,#cf-turnstile,#challenge-running,#challenge-form,#cf-challenge-running',
    );
    return {
      title: document.title || "",
      txt: txt.slice(0, 4000),
      hasTurnstile,
      hasRay: /Ray ID|Cloudflare Ray|cf-ray/i.test(html),
    };
  }), 4000, { title: "", txt: "", hasTurnstile: false, hasRay: false });
  if (probe.hasTurnstile) return true;
  const text = `${probe.title}\n${probe.txt}`;
  // 文案命中 + (Ray ID 或 Cloudflare 字样) 才算 CF，单凭文案不下结论。
  if (RE_CF_TEXT.test(text) && (probe.hasRay || /cloudflare/i.test(text))) return true;
  return false;
}

// 像人一样轻微移动鼠标：CF turnstile 会采集鼠标/行为信号，纯静止的自动化更易被判机器人。
async function humanWiggle(page) {
  try {
    const x = 220 + Math.floor(Math.random() * 500);
    const y = 200 + Math.floor(Math.random() * 360);
    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 10) });
  } catch (_) { /* 跳转中 move 可能失败，忽略 */ }
}

// 对 turnstile 复选框做一次真实坐标点击。
// iframe 跨域读不到内容，但 page.mouse.click 是真实输入事件、按视口坐标点，不需要访问 iframe 内部 DOM。
// 复选框一般在 iframe 左侧垂直居中。只点一次，避免反复点击反而像机器人。
async function clickTurnstile(page) {
  try {
    const box = await withTimeout(page.evaluate(() => {
      const f = document.querySelector('iframe[src*="challenges.cloudflare.com"],.cf-turnstile iframe,#cf-turnstile iframe,.cf-turnstile');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }), 4000, null);
    if (!box) return false;
    const cx = box.x + Math.min(30, box.w * 0.18);
    const cy = box.y + box.h / 2;
    await page.mouse.move(cx - 24, cy - 12, { steps: 6 });
    await sleep(200 + Math.floor(Math.random() * 300));
    await page.mouse.click(cx, cy, { delay: 40 });
    return true;
  } catch (_) { return false; }
}

// 遇到 CF：先给它合理时间自动放行（托管挑战常会自动过），期间做一点拟人交互，
// 仍过不去就返回 false 交给上层下「需人工」结论——绝不死循环、绝不误判成 banned。
async function waitOutCloudflare(page, emit) {
  emit("gpt_cf_challenge", { url: page.url().slice(0, 110) });
  const deadline = Date.now() + 45000;
  let clickedTurnstile = false;
  while (Date.now() < deadline) {
    if (!(await isCloudflareChallenge(page))) { emit("gpt_cf_passed", {}); return true; }
    await humanWiggle(page);
    if (!clickedTurnstile) clickedTurnstile = await clickTurnstile(page);
    await sleep(2500);
  }
  const stillCf = await isCloudflareChallenge(page);
  if (!stillCf) { emit("gpt_cf_passed", {}); return true; }
  emit("gpt_cf_blocked", { url: page.url().slice(0, 110) });
  return false;
}

// 卡在 CF 的统一结论：状态记为 cf_blocked（需人工），不当成 banned/blocked。
// 配合任务的「不关闭窗口(keepOpen)」即可让用户在浏览器里手动点过验证后接管。
function cfResult(page) {
  const tail = page.url().slice(0, 110);
  return {
    outcome: "need_verify",
    statusPatch: { gpt: "cf_blocked" },
    detail: { gpt: `卡在 Cloudflare 人机验证（auth.openai.com「安全验证/请验证您是真人」），自动等待与拟人交互后仍未放行。CF 本质就是反自动化，可能需人工在浏览器里点一下验证；建议开「不关闭窗口」由人工接管。停在：${tail}` },
  };
}

async function detectGpt(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const email = account && account.email ? account.email : "";

  emit("gpt_open_chatgpt", {});
  await page.goto(CHATGPT, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(4000);

  // 打开首页就可能撞上 Cloudflare 人机验证：先等它放行，过不去就直接给「需人工」结论，别在找按钮时空转。
  if (await isCloudflareChallenge(page)) {
    if (!(await waitOutCloudflare(page, emit))) return cfResult(page);
  }

  // 轮询：首页没有 Google 按钮就点「登录」开弹窗，等到出现为止（页面 hydrate 慢，需重试）。
  let hasBtn = false;
  for (let i = 0; i < 10 && !hasBtn; i += 1) {
    hasBtn = await hasGoogleBtn(page);
    if (hasBtn) break;
    await synthClick(page, LOGIN_ENTRY);
    await sleep(2000);
  }
  if (!hasBtn) {
    return { outcome: "error", statusPatch: {}, detail: { gpt: "没找到『使用 Google 账户继续』按钮（ChatGPT 登录入口可能改版/加载失败）" } };
  }
  emit("gpt_click_google", {});
  // 点登录前先动一下鼠标：让本次会话有真实指针轨迹，跳转到 auth.openai.com 后更不易被 CF 判机器人。
  await humanWiggle(page);
  await synthClick(page, GOOGLE_BTN);
  await sleep(6000);

  // 轮询授权结果。url 用 page.url()（同步、不会挂），文本读取带超时。
  let pickTries = 0;
  let outcome = "";
  for (let i = 0; i < 35 && !outcome; i += 1) {
    const url = page.url();

    // 先查 Cloudflare（auth.openai.com 跳转途中最常见）：能放行就继续正常判定；
    // 放行不了就跳出循环给「需人工」，绝不在这里死等或误判成 banned。
    if (await isCloudflareChallenge(page)) {
      if (await waitOutCloudflare(page, emit)) { await sleep(1500); continue; }
      outcome = "cf"; break;
    }

    if (RE_REJECTED.test(url)) { outcome = "blocked"; break; }
    const text = await readText(page);
    if (RE_CANT_VERIFY.test(text)) { outcome = "blocked"; break; }

    if (parseLoc(url).host === "accounts.google.com") {
      // 只有真正的账号选择器页（url 含 accountchooser）才点账号；同意页的「继续前往」不算。
      if (/accountchooser/i.test(url)) {
        // 首次到选择器先等加载遮罩散去，否则点击被拦。
        if (pickTries === 0) await sleep(8000);
        if (pickTries < 12) {
          emit("gpt_pick_account", { try: pickTries + 1 });
          await pickAccount(page, email);
          pickTries += 1;
          await sleep(4000);
        } else {
          await sleep(2500);
        }
        continue;
      }
      // 其它 Google 页（同意页等）：点「继续/允许」。
      if (await realClickByText(page, CONSENT_BTN)) { emit("gpt_consent", {}); await sleep(4000); continue; }
      await sleep(2500);
      continue;
    }

    if (/chatgpt\.com|openai\.com/i.test(url)) {
      // 还在显示登录框 → OAuth 还没回来，继续等。
      if (RE_LOGIN_MODAL.test(text)) { await sleep(3000); continue; }
      if (RE_BANNED.test(text)) { outcome = "banned"; break; }
      outcome = "ok"; break;
    }
    await sleep(2500);
  }

  const tail = page.url().slice(0, 110);
  if (outcome === "ok") return { outcome: "ok", statusPatch: { gpt: "ok" }, detail: { gpt: "可一键授权，已进入 ChatGPT（合格）" } };
  if (outcome === "blocked") return { outcome: "ok", statusPatch: { gpt: "blocked" }, detail: { gpt: "授权失败：Google 弹「无法验证您的身份」(rejected)" } };
  if (outcome === "banned") return { outcome: "ok", statusPatch: { gpt: "banned" }, detail: { gpt: "能授权但账号被停用/封禁" } };
  if (outcome === "cf") return cfResult(page);
  // 收尾再兜一次：循环跑满仍停在 CF 页（极少见），也按需人工处理，不留模糊结论。
  if (await isCloudflareChallenge(page)) return cfResult(page);
  return { outcome: "need_verify", statusPatch: {}, detail: { gpt: `未判定出结果，停在：${tail}` } };
}

module.exports = detectGpt;
