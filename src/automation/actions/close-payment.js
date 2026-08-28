"use strict";

/**
 * 关闭支付资料：彻底注销整个 Google Payments 支付档案（不只是删卡）。
 *
 * 流程（逻辑搬自已验证的浏览器插件 single-account-extension）：
 *   1) 先到 pay.google.com 支付方式页，尽量把已保存的卡删掉（有订阅删不掉也没关系）。
 *   2) 再到 payments.google.com 设置页，执行「Close payments profile / 关闭支付资料」：
 *      settings_has_close → 点关闭入口 → （Google 常要求再验证身份）→ final_confirm 对话框
 *      （选关闭原因下拉 + 点最终按钮）→ 提交后跳转帮助页 → 回设置页确认 closed/absent。
 *
 * 多 iframe：设置页 frame 和 wipeout 确认对话框 frame 分属不同 frame，用 page.frames() 遍历。
 * goog flat-menu 的两个坑：事件必须带 clientX/clientY；选项要先 hover 高亮再 mousedown/mouseup。
 */

const login = require("./login");
const { sleep, parseLoc } = login.helpers;

const PM_URL = "https://pay.google.com/gp/w/u/0/home/paymentmethods?hl=en";
const SETTINGS_URL = "https://payments.google.com/gp/w/u/0/home/settings?hl=en";

/* ------------------------------ 删卡（沿用旧逻辑） ------------------------------ */

function pmFrame(page) {
  return page.frames().find((f) => /payments\.google\.com/i.test(f.url()) && /payment_methods/i.test(f.url())) || null;
}
function confirmFrame(page) {
  return page.frames().find((f) => /payments\.google\.com/i.test(f.url()) && /fix_instrument|remove|delete/i.test(f.url())) || null;
}
async function clickRemove(frame) {
  return frame.evaluate(() => {
    const b = [...document.querySelectorAll("button,[role='button']")].find((x) => /^\s*remove\s*$/i.test(x.textContent || ""));
    if (!b) return false;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }).catch(() => false);
}
async function cardCount(frame) {
  return frame.evaluate(() => {
    const t = document.body ? document.body.innerText : "";
    return (t.match(/\u2022{2,}\s*\d{4}/g) || []).length;
  }).catch(() => 0);
}

// 删光支付方式页里的卡（尽力而为）。返回 { start, left }。
async function removeAllCards(page, account, ctx) {
  await page.goto(PM_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(3500);
  if (parseLoc(page.url()).host === "accounts.google.com") {
    const r = await login.reauth(page, account, ctx);
    if (r.outcome !== "ok") return { start: 0, left: 0, reauthFailed: true };
    await sleep(1500);
    await page.goto(PM_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(3500);
  }
  // 没开通 Google Pay → 跳到 signup，没有卡。
  if (/signup|\/home\/setup|\/home\/signup/i.test(page.url())) return { start: 0, left: 0 };

  let pf = pmFrame(page);
  for (let i = 0; i < 10 && !pf; i += 1) { await sleep(1200); pf = pmFrame(page); }
  if (!pf) return { start: 0, left: 0 };

  const start = await cardCount(pf);
  let prev = start;
  for (let round = 0; round < start + 6 && prev > 0; round += 1) {
    pf = pmFrame(page);
    if (!pf) break;
    if (!(await clickRemove(pf))) break;
    await sleep(1800);
    for (let j = 0; j < 10; j += 1) {
      const cf = confirmFrame(page);
      if (cf && cf !== pf && (await clickRemove(cf))) break;
      await sleep(600);
    }
    await sleep(2800);
    // 复核数量；没降说明这张删不掉（多半绑了订阅），不再纠缠，交给关档流程。
    await page.goto(PM_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(3000);
    const c = pmFrame(page) ? await cardCount(pmFrame(page)) : 0;
    if (c >= prev) break;
    prev = c;
  }
  const left = pmFrame(page) ? await cardCount(pmFrame(page)) : 0;
  return { start, left };
}

/* ------------------------------ 关闭整个支付档案 ------------------------------ */

// 判断单个 frame 的支付档案状态（文本 + url），与插件 paymentState() 一致。
async function frameState(frame) {
  return frame.evaluate(() => {
    const text = (document.body && document.body.innerText || "").replace(/\s+/g, " ").trim();
    const url = location.href;
    if (/payments\.google\.com\/gp\/w\/u\/\d+\/home\/signup/i.test(url)) return "absent";
    if (/This payments profile is closed|Payments profile closed|支付资料.*已关闭/i.test(text)) return "closed";
    if (/Create payments profile|Add payment method|No payments profile|创建支付资料|添加付款方式/i.test(text)
      && !/Close payments profile|关闭支付资料/i.test(text)) return "absent";
    if (/Why are you closing|Before you close|closing your payments profile|Close your payments profile|为什么.*关闭|关闭支付资料/i.test(text)
      && /select|option|reason|Submit|Continue|Close|原因|选项|提交|继续/i.test(text)) return "final_confirm";
    if (/Close payments profile|关闭支付资料/i.test(text)) return "settings_has_close";
    return "";
  }).catch(() => "");
}

// 某个 frame 是否在等再验证（"会出现新窗口/验证您的身份"）。
async function reauthPending(frame) {
  return frame.evaluate(() => {
    const text = (document.body && document.body.innerText || "").replace(/\s+/g, " ").trim();
    return /A new window will appear|verify it'?s you|请先验证您的身份|验证您的身份|身份验证后/i.test(text)
      && !/Why are you closing|Closing your payments profile/i.test(text);
  }).catch(() => false);
}

function payFrames(page) {
  const all = [page.mainFrame(), ...page.frames()];
  const seen = new Set();
  return all.filter((f) => {
    if (seen.has(f)) return false;
    seen.add(f);
    return /payments\.google\.com|pay\.google\.com/i.test(f.url()) || f === page.mainFrame();
  });
}

// 点设置页的「Close payments profile / 关闭支付资料」入口（port 自插件 clickByText）。
async function clickCloseEntry(frame) {
  return frame.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const regexes = [/Close payments profile/i, /关闭支付资料/i];
    const cands = [...document.querySelectorAll("button, a, [role='button'], [role='menuitem'], li, div, span")]
      .filter(visible)
      .map((el) => ({
        el,
        text: [el.textContent || "", el.getAttribute("aria-label") || ""].join(" ").replace(/\s+/g, " ").trim(),
        area: Math.max(1, el.getBoundingClientRect().width * el.getBoundingClientRect().height),
        tag: el.tagName, role: el.getAttribute("role") || "",
      }))
      .filter((it) => it.text && regexes.some((r) => r.test(it.text)))
      .sort((a, b) => {
        const ac = /button/i.test(a.role) || /^(button|a)$/i.test(a.tag) ? 0 : 1;
        const bc = /button/i.test(b.role) || /^(button|a)$/i.test(b.tag) ? 0 : 1;
        return ac - bc || a.area - b.area;
      });
    if (!cands[0]) return false;
    const el = cands[0].el;
    el.scrollIntoView({ block: "center", inline: "center" });
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
    return true;
  }).catch(() => false);
}

// final_confirm 对话框：滚到底 → 选关闭原因 → 点最终按钮。整个时序在页面上下文里完成。
async function doFinalConfirm(frame) {
  return frame.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const queryVisible = (sels) => {
      for (const sel of sels) { const el = [...document.querySelectorAll(sel)].find(visible); if (el) return el; }
      return null;
    };
    const fireMouse = (el, types) => {
      if (!el) return;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of types) el.dispatchEvent(new MouseEvent(t, o));
    };
    const scrollBottom = () => {
      const ns = [document.querySelector(".modal-dialog-content"), document.querySelector("[role='dialog']"), document.body, document.documentElement].filter(Boolean);
      for (const n of ns) { if (n.scrollHeight > n.clientHeight) { n.scrollTop = n.scrollHeight; n.dispatchEvent(new Event("scroll", { bubbles: true })); } }
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    };
    const reasonChosen = () => {
      const c = document.querySelector(".goog-flat-menu-button-caption, [data-id*='SelectCaption']");
      return !!(c && c.textContent && c.textContent.trim());
    };

    scrollBottom();
    let chosen = reasonChosen();
    if (!chosen) {
      const nativeSelect = queryVisible(["select"]);
      if (nativeSelect && nativeSelect.options && nativeSelect.options.length > 1) {
        nativeSelect.selectedIndex = 1;
        nativeSelect.dispatchEvent(new Event("input", { bubbles: true }));
        nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        chosen = true;
      } else {
        const listbox = queryVisible([
          "[data-name='closureReasonSelector'][role='listbox']",
          ".jfk-select[data-name='closureReasonSelector']",
          ".jfk-select",
          "[role='listbox']",
        ]);
        if (listbox) {
          let option = null;
          for (let a = 0; a < 2 && !option; a += 1) {
            fireMouse(listbox, ["mousedown", "mouseup", "click"]);
            await sleep(700);
            option = queryVisible([
              ".goog-menuitem[data-value='WIPEOUT_REASON_DONT_NEED_ACCOUNT_ANYMORE']",
              ".goog-menuitem[data-value='WIPEOUT_REASON_DECLINE_TO_STATE']",
              ".goog-menuitem[data-value='WIPEOUT_REASON_OTHER']",
              ".goog-menuitem[data-value]",
              ".goog-menuitem",
            ]);
          }
          if (option) {
            fireMouse(option, ["mouseover", "mouseenter", "mousemove", "mousedown", "mouseup"]);
            await sleep(500);
            chosen = reasonChosen();
          }
        }
      }
    }

    await sleep(600);
    scrollBottom();
    await sleep(300);

    const regexes = [/^Close payments profile$/i, /^Close profile$/i, /^Submit$/i, /^Continue$/i, /^关闭支付资料$/i, /^提交$/i, /^继续$/i];
    const cands = [...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
      .filter(visible)
      .map((el) => ({
        el,
        text: [el.textContent || "", el.getAttribute("aria-label") || "", el.getAttribute("value") || ""].join(" ").replace(/\s+/g, " ").trim(),
        rect: el.getBoundingClientRect(),
      }))
      .filter((it) => it.text && regexes.some((r) => r.test(it.text)))
      .sort((a, b) => b.rect.y - a.rect.y);
    if (!cands[0]) return { chosen, clicked: false };
    const el = cands[0].el;
    el.scrollIntoView({ block: "center", inline: "center" });
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
    return { chosen, clicked: true };
  }).catch(() => ({ chosen: false, clicked: false }));
}

// 关闭支付档案时 Google 可能弹出新标签做再验证；逮到 accounts.google.com 的标签就跑 reauth。
async function handleReauthPopup(browser, mainPage, account, ctx) {
  if (!browser) return false;
  let pages = [];
  try { pages = await browser.pages(); } catch (_) { return false; }
  for (const p of pages) {
    if (p === mainPage) continue;
    let url = "";
    try { url = p.url(); } catch (_) { continue; }
    if (!/accounts\.google\.com/i.test(url)) continue;
    if (typeof p.waitForTimeout !== "function") p.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, ms));
    try { await login.reauth(p, account, ctx); } catch (_) { /* 弹窗可能在成功后被关掉 */ }
    try { if (!p.isClosed()) await p.close(); } catch (_) { /* ignore */ }
    return true;
  }
  return false;
}

// 扫支付相关 frame，找「无法关闭/有订阅占用/有余额」之类的提示文案。
async function readBlockMsg(page) {
  const RE = /(can'?t close|cannot close|unable to close|outstanding balance|pending|active subscription|you have an? .*subscription|linked to a subscription|cancel .*subscription first|订阅|无法(关闭|删除|移除)|余额|请先取消|未结清)[^\n。.]{0,80}/i;
  for (const f of page.frames()) {
    if (!/payments\.google\.com|pay\.google\.com/i.test(f.url())) continue;
    const m = await f.evaluate((src) => {
      const re = new RegExp(src, "i");
      const t = document.body ? document.body.innerText : "";
      const mm = t.match(re);
      return mm ? mm[0].replace(/\s+/g, " ").trim().slice(0, 100) : "";
    }, RE.source).catch(() => "");
    if (m) return m;
  }
  return "";
}

// 关闭整个支付档案的状态机循环。
async function closeProfile(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(3500);

  let clickedCloseAt = 0;
  let submittedAt = 0;
  let reauthCount = 0;

  for (let round = 0; round < 22; round += 1) {
    const host = parseLoc(page.url()).host;

    // 主页面被导去 accounts → 内联再验证。
    // 注意：验证成功后 Google 会用 rl?rapt=... 续跳回关闭流程（直接带出关闭对话框）。
    // 千万别在这里强制 goto 设置页，否则会把对话框冲掉、退回设置页又点一次关闭、又触发再验证，陷入死循环。
    if (host === "accounts.google.com") {
      reauthCount += 1;
      if (reauthCount > 3) return { status: "reauth_loop" };
      emit("close_reauth", { n: reauthCount });
      const r = await login.reauth(page, account, ctx);
      if (r.outcome !== "ok") return { status: "reauth_failed", detail: Object.values(r.detail || {})[0] || "" };
      await sleep(3500);
      continue;
    }

    // 弹窗式再验证（同理：处理完别强制重导航，让主页面自己续跳出对话框）。
    if (await handleReauthPopup(ctx.browser, page, account, ctx)) {
      await sleep(3500);
      continue;
    }

    // 提交后 Google 跳到 Google Pay 帮助页，导回设置页确认结果。
    if (/support\.google\.com|googlepay/i.test(page.url())) {
      await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await sleep(3000);
      continue;
    }

    // 落到明显无关的页面（再验证后偶尔会跳 myaccount/google 首页）→ 兜底回设置页。
    if (host && !/payments\.google\.com|pay\.google\.com|accounts\.google\.com/i.test(host)) {
      await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await sleep(3000);
      continue;
    }

    const frames = payFrames(page);
    const states = [];
    let pending = false;
    for (const f of frames) {
      const s = await frameState(f);
      states.push({ f, s });
      if (await reauthPending(f)) pending = true;
    }
    const find = (s) => states.find((x) => x.s === s);

    if (find("closed")) return { status: "closed", submitted: submittedAt > 0 };
    if (find("absent")) return { status: "absent", submitted: submittedAt > 0 };

    const fc = find("final_confirm");
    if (fc) {
      if (Date.now() - submittedAt < 9000) { await sleep(2500); continue; }
      emit("close_confirm", {});
      const res = await doFinalConfirm(fc.f);
      if (res.clicked) submittedAt = Date.now();
      await sleep(3500);
      continue;
    }

    // 等再验证时别去重复点入口。
    if (pending) { await sleep(2500); continue; }

    const sh = find("settings_has_close");
    if (sh) {
      if (Date.now() - clickedCloseAt < 10000) { await sleep(2500); continue; }
      emit("close_click", {});
      await clickCloseEntry(sh.f);
      clickedCloseAt = Date.now();
      await sleep(3500);
      continue;
    }

    // 还没认出状态（多半仍在加载），稍等再看。
    await sleep(2000);
  }

  return { status: "timeout" };
}

/* ------------------------------ 动作入口 ------------------------------ */

async function closePayment(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};

  // 第一步：尽量删卡（有订阅删不掉也没关系，关档流程会兜底）。
  const cards = await removeAllCards(page, account, ctx);
  if (cards.reauthFailed) {
    return { outcome: "need_verify", detail: { payment: "打开支付页需重新验证，但验证未通过" } };
  }
  emit("payment_methods", { count: cards.start, left: cards.left });

  // 第二步：注销整个支付档案。
  const res = await closeProfile(page, account, ctx);

  if (res.status === "closed" || res.status === "absent") {
    const removedNote = cards.start ? `（先删除了 ${Math.max(0, cards.start - cards.left)} 张卡）` : "";
    // 走完关闭流程（提交过）后变成 absent/closed → 是我们刚注销的，不是本来就没有。
    const note = res.submitted
      ? `已注销整个支付档案${removedNote}`
      : (res.status === "absent" ? "该账号无支付档案（或已不存在），无需关闭" : "支付档案已是关闭状态");
    emit("payment_done", { closed: true });
    return { outcome: "ok", statusPatch: { payment: "closed" }, detail: { payment: note } };
  }

  if (res.status === "reauth_failed" || res.status === "reauth_loop") {
    return { outcome: "need_verify", detail: { payment: `关闭支付档案的身份再验证未通过或反复要求验证${res.detail ? `：${res.detail}` : ""}，请人工处理` } };
  }

  // 没关成：抓 Google 给的原因（订阅/余额等）。
  const blockMsg = await readBlockMsg(page);
  emit("payment_done", { closed: false, blocked: !!blockMsg });
  if (blockMsg) {
    return {
      outcome: "ok",
      statusPatch: { payment: "locked" },
      detail: { payment: `支付档案无法关闭（${blockMsg}），多半有订阅/余额未结清，需先处理` },
    };
  }
  return {
    outcome: "ok",
    statusPatch: { payment: "open" },
    detail: { payment: `支付档案未能关闭（流程超时，剩余卡 ${cards.left} 张），需复核` },
  };
}

module.exports = closePayment;
