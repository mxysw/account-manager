"use strict";

/**
 * 更改账号 2FA 密钥（更换验证器 Authenticator）。
 *
 * 思路：Google 的密钥由它生成（不能自定义），所以本质是「换绑验证器」：
 *   进验证器设置 → (必要时)重新验证 → 点 Change authenticator app → Can't scan it? 抓新密钥
 *   → Next → 用新密钥生成验证码验证 → 成功后 Google 才真正切换。
 *
 * 关键坑（用户多号实测）：进「验证器设置」时 Google 常要求重新验证身份，表现为整页跳到
 *   accounts.google.com 的 `/challenge/totp`（要求输入当前验证器验证码）。老实现只在 goto 后
 *   检查一次 host===accounts.google.com；但这个重定向经常「晚到」（domcontentloaded 落在 myaccount
 *   之后再客户端跳到 challenge），或在点「更换验证器」之后才弹出——于是老实现直接在挑战页找按钮、
 *   报「没找到按钮」。
 *   另有账号会跳到 accounts.google.com 的 `/signin/unknownerror`（多为瞬时/风控）。
 *
 * 本次修复（复用 login.js 的 reauth，不另写 TOTP）：
 *   1) 进设置页 / 点更换 前后都用 handleBlockers 统一处理：
 *      - 重新验证挑战（accounts.google.com / challenge / signin）→ 调 login.reauth（用账号「现有」
 *        totpSecret 过验证，reauth 内部已能处理密码 / 设备通知转身份验证器 / 选择验证方式等）；
 *      - unknownerror → 重试（reload / 重新导航）若干次；
 *      - 明确被拒（signin/rejected、disabled）→ 需人工。
 *   2) 稳健找按钮：等页面渲染稳定（settle + 轮询），用多语言 + 多回退选择器找「更换/设置验证器」，
 *      绝不在挑战页 / 加载中就判「没找到」。
 *   3) 收敛：reauth / unknownerror 次数上限 + 动作总超时，避免在挑战页 / 设置页 / 错误页之间打转。
 *
 * 安全性：Google 只有在「用新密钥生成的码验证通过」后才会切换验证器。
 *   - 抓错/抓不到密钥 → 我们生成的码必然错 → Google 拒绝 → 旧验证器原样保留，账号不受影响。
 *   - 验证通过 → 新密钥一定可用（刚用它过了验证）。
 *   因此不存在「抓错密钥把号锁死」的风险。
 *
 * 成功后写回：totpSecret=新密钥，oldTotpSecret=旧密钥（备份）。
 */

const login = require("./login");
const totp = require("../../totp");
const { syncTime, accurateNow } = require("../time-sync");

const {
  sleep, parseLoc, visibleFirst, setValueViaJs, clickText, bodyText, withTimeout,
} = login.helpers;

const AUTH_URL = "https://myaccount.google.com/two-step-verification/authenticator?hl=en";

// 收敛上限：避免在挑战页/设置页/错误页之间无限打转。
const ACTION_TIMEOUT_MS = 6 * 60 * 1000; // 整个动作总超时
const REAUTH_TIMEOUT_MS = 180 * 1000; // 单次 reauth 超时
const MAX_REAUTH = 3; // 累计触发重新验证的次数上限
const MAX_UNKNOWN = 4; // 累计遇到 unknownerror 的重试上限

// 「更换/设置验证器」按钮：多语言 + 多回退（页面用 ?hl=en，故英文优先，其余作兜底）。
// 覆盖：Change authenticator app / Set up authenticator / 更换验证器 / 设置验证器 / 换用其他验证器 App…
const CHANGE_BTN_SOURCES = [
  "^Change authenticator app$", "Change authenticator app", "Change authenticator",
  "^Set up authenticator$", "Set up authenticator app", "Set up a different authenticator",
  "^Set up$", "Add authenticator app", "Change your authenticator",
  "更换验证器", "更换身份验证器", "更改验证器", "更改身份验证器", "更换其他验证器", "换用其他验证器", "换用其它验证器",
  "设置验证器", "设置身份验证器", "重新设置验证器",
  "更換驗證器", "更換身分驗證器", "設定驗證器", "變更驗證器", "設定驗證器應用程式",
];

// 「Can't scan it? / 手动输入」——展开后露出 base32 setup key。
const CANT_SCAN_SOURCES = [
  "Can.t scan it", "Can.t scan", "Enter this text code", "Enter.*manually",
  "无法扫描", "無法掃描", "手动输入", "手動輸入", "改为手动", "改為手動",
];

// 从「Can't scan it?」露出的文本里抠出 base32 setup key。
// Google 渲染为一个 <strong>，密钥是「4 位一组、空格分隔」的 8 组（共 32 位），如：
//   cn5w 7wbz pucj mh3y p7pe pp6r mj6q hzy3
// 因此严格匹配「4 位×≥6 组」，并取最长候选，避免抓到别处的短 base32 残片。
async function extractSecret(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    // 整段「只有密钥」的叶子元素：4 位×≥6 组、整段从头到尾就是分组密钥（无其它词）。
    const GROUPED = /^[a-z2-7]{4}(?: [a-z2-7]{4}){5,}$/i;
    const cands = [];
    for (const el of document.querySelectorAll("strong, b, code, span, div, p")) {
      const t = norm(el.textContent);
      if (GROUPED.test(t)) cands.push(t.replace(/\s+/g, ""));
    }
    if (!cands.length) return null;
    // Google 标准密钥为 32 位（160-bit）。优先精确 32，其次最接近 32 且在合理范围(16~40)。
    const valid = cands.filter((c) => c.length >= 16 && c.length <= 40);
    const pool = valid.length ? valid : cands;
    const exact = pool.find((c) => c.length === 32);
    if (exact) return exact;
    pool.sort((a, b) => Math.abs(a.length - 32) - Math.abs(b.length - 32));
    return pool[0];
  }).catch(() => null);
}

// 填验证码（myaccount 弹窗里的输入框 #c0，跟登录页选择器不同）并保存。
// 注意：填完要稍等让按钮可用 + 让 React 收值，再点 Verify；点太快会提交到窗口边缘导致过期。
async function submitCode(page, code) {
  const input = await visibleFirst(page, [
    "#c0",
    "input[type='tel']",
    "input[name='totpPin']",
    "input[aria-label*='code' i]",
    "input[type='text']",
  ]);
  if (!input) return false;
  await input.click({ clickCount: 3 }).catch(() => {});
  await input.evaluate((n) => { n.value = ""; }).catch(() => {});
  await input.type(code, { delay: 80 }).catch(() => {});
  await setValueViaJs(input, code);
  await input.dispose().catch(() => {});
  await sleep(800);
  // 弹窗里按钮文字一般是 Verify（也兼容 Done/Save/Next）。
  if (!(await clickText(page, ["^Verify$", "^Done$", "^Save$", "^Confirm$", "^Next$"]))) {
    await page.keyboard.press("Enter").catch(() => {});
  }
  return true;
}

// 生成一个「新鲜」TOTP：避开 30s 窗口末尾，确保 Google 收到时仍有效。
async function freshCode(secret) {
  await syncTime();
  const secondsLeft = 30 - (Math.floor(accurateNow() / 1000) % 30);
  if (secondsLeft <= 12) await sleep((secondsLeft + 1) * 1000);
  return totp.generate(secret, { now: accurateNow() }).code;
}

function flatDetail(d) {
  return d ? Object.values(d).filter(Boolean).join("；") : "";
}

// 当前页面属于哪种「拦路」状态。注意 unknownerror 也在 accounts.google.com，必须排在 reauth 之前判。
function pageKind(url) {
  const { host, path } = parseLoc(url);
  if (/unknownerror/i.test(path)) return "unknownerror";
  if (/\/signin\/rejected/i.test(path) || /\/disabled\b/i.test(path) || /deniedsigninrejected/i.test(path)) return "rejected";
  // accounts.google.com 的任意页（challenge/totp、challenge/pwd、signin/challenge/… 等）都需先过 reauth。
  if (host === "accounts.google.com") return "reauth";
  if (host === "myaccount.google.com") return "settings";
  return "other";
}

// 给 page.goto 套超时，绝不抛。
async function safeGoto(page, url) {
  await withTimeout(
    page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    65000,
    null,
  );
}

// 等页面 URL 稳定（连续 2s 不变）后返回——用于捕捉「晚到」的重定向（如客户端跳到 challenge/totp）。
async function settle(page, ms = 9000) {
  await sleep(1500); // 基础等待：初始渲染 / 立即重定向
  const deadline = Date.now() + ms;
  let last = page.url();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const now = page.url();
    if (now !== last) { last = now; stableSince = Date.now(); } else if (Date.now() - stableSince >= 2000) return;
    await sleep(500);
  }
}

/**
 * 若当前页是「拦路」页（重新验证 / unknownerror / 被拒），统一处理。
 * 返回：
 *   { handled:false }               —— 当前不是拦路页（已在 myaccount 或其它可继续页），调用方照常往下走。
 *   { handled:true }                —— 处理了一次（reauth 通过 / unknownerror 已重试），调用方应重判/重导航。
 *   { terminal:true, result }       —— 终态失败（被拒 / 超上限 / reauth 未过），调用方直接返回 result。
 */
async function handleBlockers(page, account, ctx, emit, counters) {
  const kind = pageKind(page.url());

  if (kind === "rejected") {
    return {
      terminal: true,
      result: {
        outcome: "need_verify",
        detail: { change2fa: "Google 拒绝验证「确认是你本人」（环境/IP 不被信任），无法自动更换验证器，需人工在常用设备上操作" },
      },
    };
  }

  if (kind === "unknownerror") {
    counters.unknown += 1;
    emit("unknownerror", { tries: counters.unknown });
    if (counters.unknown > MAX_UNKNOWN) {
      return {
        terminal: true,
        result: {
          outcome: "need_verify",
          detail: { change2fa: `Google 反复返回 unknownerror（多为瞬时/风控），已停止，可稍后人工重试。停在：${page.url().slice(0, 80)}` },
        },
      };
    }
    // 递增退避后由调用方重新导航到设置入口。
    await sleep(2000 + counters.unknown * 1500);
    return { handled: true, needReload: true };
  }

  if (kind === "reauth") {
    counters.reauth += 1;
    emit("reauth", { tries: counters.reauth });
    if (counters.reauth > MAX_REAUTH) {
      return {
        terminal: true,
        result: { outcome: "need_verify", detail: { change2fa: "反复要求重新验证仍未通过，需人工处理" } },
      };
    }
    // 复用 login.js 的 reauth：用账号「现有」totpSecret 过 challenge/totp（内部已能处理密码/设备通知转验证器等）。
    const r = await withTimeout(
      login.reauth(page, account, ctx),
      REAUTH_TIMEOUT_MS,
      { outcome: "error", detail: { reauth: "重新验证超时（180s）" } },
    );
    if (r.outcome !== "ok") {
      return {
        terminal: true,
        result: {
          outcome: r.outcome === "need_verify" ? "need_verify" : "error",
          detail: { change2fa: `重新验证未通过：${flatDetail(r.detail)}` },
        },
      };
    }
    emit("reauth_passed", { tries: counters.reauth });
    await sleep(1500);
    return { handled: true };
  }

  return { handled: false };
}

// 换绑向导是否已出现：有验证码输入框，或页面出现「Can't scan / 扫描二维码 / 手动输入」等向导文案。
// 注意：Google 用的是弯引号 "Can’t"（U+2019），正则用 `.?` 兼容直/弯引号与无引号；文案实测为「Scan a QR code」。
async function wizardVisible(page) {
  const hasInput = await visibleFirst(page, ["#c0", "input[type='tel']", "input[name='totpPin']"])
    .then((h) => { if (h) h.dispose().catch(() => {}); return !!h; });
  if (hasInput) return true;
  const text = await withTimeout(bodyText(page), 5000, "");
  return /Can.?t scan|Scan a QR code|Scan the QR code|scan the barcode|tap the \+|In the Google Authenticator app|enter this (setup|text) (key|code)|You won.?t be able to use your old authenticator|无法扫描|無法掃描|扫描.*二维码|掃描.*QR|输入以下|手动输入|手動輸入/i.test(text);
}

/**
 * 阶段 A：进入「验证器设置」页（过掉任何重新验证 / unknownerror）。
 * 返回 { ok:true } 或 { ok:false, result }。
 */
async function gotoSettings(page, account, ctx, emit, counters, deadline) {
  await safeGoto(page, AUTH_URL);
  await settle(page);
  for (let round = 0; round < 12; round += 1) {
    if (Date.now() > deadline) {
      return { ok: false, result: { outcome: "error", detail: { change2fa: "进入验证器设置页超时" } } };
    }

    if (pageKind(page.url()) === "settings") return { ok: true };

    const blocked = await handleBlockers(page, account, ctx, emit, counters);
    if (blocked.terminal) return { ok: false, result: blocked.result };
    if (blocked.handled) {
      // 过完拦路页后：reauth 常直接把我们带回设置页（authenticator?rapt=...），此时绝不能再重导航——
      // 重新 goto 会丢掉 rapt、再次触发一次多余的重新验证（实测会白白吃掉一次 reauth 上限）。
      await settle(page, 4000);
      if (pageKind(page.url()) === "settings") return { ok: true };
      await safeGoto(page, AUTH_URL);
      await settle(page);
      continue;
    }
    // 既非设置页也非拦路页（未知/仍在加载）：重新导航到设置入口再判。
    await safeGoto(page, AUTH_URL);
    await settle(page);
  }
  return {
    ok: false,
    result: { outcome: "need_verify", detail: { change2fa: `未能进入验证器设置页，停在：${page.url().slice(0, 80)}` } },
  };
}

/**
 * 阶段 B：点「更换/设置验证器」进入换绑向导（点按前后都可能弹重新验证 / unknownerror）。
 * 返回 { ok:true }（向导已出现）或 { ok:false, result }。
 */
async function startChange(page, account, ctx, emit, counters, deadline) {
  let clicks = 0;
  for (let round = 0; round < 12; round += 1) {
    if (Date.now() > deadline) {
      return { ok: false, result: { outcome: "error", detail: { change2fa: "进入换绑向导超时" } } };
    }

    // 先清掉任何拦路页（点更换后常整页跳去 challenge/totp 或 unknownerror）。
    const blocked = await handleBlockers(page, account, ctx, emit, counters);
    if (blocked.terminal) return { ok: false, result: blocked.result };
    if (blocked.handled) {
      // 过完拦路页：可能直接进了向导，也可能回到设置页。
      if (await wizardVisible(page)) return { ok: true };
      if (pageKind(page.url()) !== "settings") { await safeGoto(page, AUTH_URL); await settle(page); }
      continue;
    }

    // 向导已出现（点按已生效 / 重新验证后 Google 直接带进向导）。
    if (await wizardVisible(page)) return { ok: true };

    // 还没到设置页（可能仍在加载或跳转中）→ 等一下再看。
    if (pageKind(page.url()) !== "settings") { await sleep(1500); continue; }

    // 已点过若干次仍没进向导（多半是弹窗已开但没被识别 / 按钮点了没反应）：别再重复点堆叠弹窗，收敛判失败。
    if (clicks >= 4) {
      return {
        ok: false,
        result: { outcome: "error", detail: { change2fa: `点了「更换验证器」但未进入换绑向导，停在：${page.url().slice(0, 80)}` } },
      };
    }

    // 在设置页：点「更换/设置验证器」。等页面渲染稳定后再判，绝不在加载中就判「没找到」。
    const clicked = await withTimeout(clickText(page, CHANGE_BTN_SOURCES), 6000, false);
    if (clicked) {
      clicks += 1;
      emit("clicked_change", { clicks });
      await sleep(2500);
      continue; // 下一轮：处理点后可能弹出的重新验证，或检测向导。
    }
    // 没找到按钮：多半仍在渲染，轮询等待重试（受 round 上限收敛）。
    await sleep(1500);
    if (clicks === 0 && round >= 7) {
      return {
        ok: false,
        result: { outcome: "error", detail: { change2fa: `没找到「更换/设置验证器」按钮，停在：${page.url().slice(0, 80)}` } },
      };
    }
  }
  return {
    ok: false,
    result: { outcome: "error", detail: { change2fa: `未能进入换绑向导（按钮点后未出现向导），停在：${page.url().slice(0, 80)}` } },
  };
}

async function changeTotp(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const result = { fieldPatch: {}, detail: {}, outcome: "ok" };
  const counters = { reauth: 0, unknown: 0 };
  const deadline = Date.now() + ACTION_TIMEOUT_MS;

  if (!account.totpSecret) {
    return { outcome: "error", detail: { change2fa: "账号没有当前 2FA 密钥，无法自动过重新验证" } };
  }

  // 1) 进验证器设置页（过掉任何重新验证 / unknownerror）。
  emit("open_authenticator");
  const navA = await gotoSettings(page, account, ctx, emit, counters, deadline);
  if (!navA.ok) return navA.result;

  // 2) 点「更换/设置验证器」进入换绑向导（点按前后都可能弹重新验证）。
  emit("click_change");
  const started = await startChange(page, account, ctx, emit, counters, deadline);
  if (!started.ok) return started.result;

  // 3) 点「Can't scan it?」露出密钥。
  emit("reveal_secret");
  await withTimeout(clickText(page, CANT_SCAN_SOURCES), 6000, false);
  await sleep(2000);

  let newSecret = null;
  for (let i = 0; i < 6 && !newSecret; i += 1) {
    newSecret = await extractSecret(page);
    if (newSecret && !totp.looksLikeSecret(newSecret)) newSecret = null;
    if (!newSecret) {
      // 可能「Can't scan it?」还没点开，或页面仍在渲染：再点一次并稍等。
      await withTimeout(clickText(page, CANT_SCAN_SOURCES), 4000, false);
      await sleep(1200);
    }
  }
  if (!newSecret) {
    return { outcome: "error", detail: { change2fa: "没抓到新密钥（页面结构可能变化或未进入换绑向导），已中止，旧验证器未改动" } };
  }
  emit("secret_captured", { len: newSecret.length });

  // 4) 进入输入验证码界面。
  emit("click_next");
  await clickText(page, ["^Next$", "^Continue$", "^下一步$", "^繼續$", "^다음$"]);
  await sleep(2500);

  // 5+6) 用新密钥生成验证码提交并判定；被拒（多半是窗口边缘过期）则换新码重试一次。
  let success = false;
  for (let attempt = 0; attempt < 2 && !success; attempt += 1) {
    const code = await freshCode(newSecret);
    emit("submit_code", { attempt });
    const filled = await submitCode(page, code);
    if (!filled) {
      return { outcome: "error", detail: { change2fa: "没找到验证码输入框，已中止，旧验证器未改动" } };
    }
    await sleep(4500);
    const text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    if (/Authenticator app has been changed|Added just now|已更改|刚刚添加|just now/i.test(text)) {
      success = true;
      break;
    }
    if (/Wrong code|incorrect|输入的验证码有误|验证码错误|try again/i.test(text)) {
      emit("code_rejected", { attempt });
      await clickText(page, ["#c0"]).catch(() => {}); // 留在输入框，下一轮重填
      continue;
    }
    // 既无失败提示也无明确成功文案：再读一次确认（弹窗可能已关、回到列表）。
    success = /Authenticator[\s\S]{0,40}(just now|刚刚)/i.test(text);
  }

  if (!success) {
    return { outcome: "error", detail: { change2fa: "新验证码被拒/未确认成功，已中止，旧验证器未改动（账号安全）" } };
  }

  // 成功：写回新密钥，备份旧密钥；同时累计更换次数并记录本次更换时间（只有真正换成功才 +1）。
  result.fieldPatch.totpSecret = newSecret;
  result.fieldPatch.oldTotpSecret = account.totpSecret;
  result.fieldPatch.totpChangeCount = (Number(account.totpChangeCount) || 0) + 1;
  result.fieldPatch.totpChangedAt = new Date().toISOString();
  result.detail.change2fa = "已更换 2FA 密钥（新密钥已验证可用，旧密钥已备份到 oldTotpSecret）";
  emit("change2fa_done");
  return result;
}

module.exports = changeTotp;
// 暴露纯逻辑函数，便于脱离 puppeteer 做确定性单测。
module.exports._internals = { pageKind, flatDetail, CHANGE_BTN_SOURCES, CANT_SCAN_SOURCES };
// 供其它写操作动作复用「安全设置页导航 + 过重新验证/unknownerror」这套能力（如 remove-phones）。
// handleBlockers/settle/safeGoto/pageKind 均与具体设置页无关，可直接复用。
module.exports.shared = { handleBlockers, settle, safeGoto, pageKind, flatDetail };
