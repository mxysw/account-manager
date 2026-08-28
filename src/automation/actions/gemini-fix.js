"use strict";

/**
 * Gemini 检测：用「新建 Gem」当探针判断账号是否需要年龄验证。
 *
 * 逻辑（用户给定）：
 *   打开 gems/create → 填名称 + 指令 → 点 Save。
 *     - 能保存            → 账号正常，不需要年龄验证（age=ok, gemini=ok）。
 *     - 保存后「Something went wrong / 出了点问题」 → 账号需要年龄验证（age=needs, gemini=blocked）。
 *
 * 注意：主页/换页时的 "Something went wrong" 是瞬时错误，不可作判据；只在「点过 Save 之后」判。
 * 选择器来自真机探针（gemini.google.com/gems/create）：
 *   名称  input[aria-label="Input for a Gem name"]（占位符 Give your Gem a name）
 *   指令  textarea[placeholder^="Describe your Gem"]
 *   保存  文本按钮 Save
 */

const login = require("./login");
const { sleep, parseLoc, clickText, fillField, visibleFirst, bodyText } = login.helpers;

const GEM_URL = "https://gemini.google.com/gems/create?hl=en";
const AGE_RE = /age verification|verify your age|年龄验证|年齡驗證|confirm your age|need to verify your age/i;

/**
 * 读取保存结果信号。真机要点：
 *  - 失败提示「Sorry, we can't save your Gem.」在 toast 容器（role=alert/status、aria-live、snackbar）里，
 *    不在 body.innerText；且撇号是弯引号 ' (U+2019)，只显示约 1.5 秒。
 *  - 「can't preview your Gem」是预览失败，与保存无关，必须排除。
 *  - 失败账号「Gem not saved」长期不消失；保存成功则该指示消失/出现已保存提示。
 */
async function readSignals(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
    const body = norm(document.body ? document.body.innerText : "");
    const nodes = [...document.querySelectorAll("[role='alert'],[role='status'],[aria-live],[class*='snackbar' i],[class*='toast' i]")];
    const toasts = nodes.map((n) => norm(n.textContent)).filter(Boolean);
    const all = `${body} || ${toasts.join(" || ")}`;
    return {
      url: location.href,
      failSave: /can't save your gem|couldn't save your gem|something went wrong|出了点问题|无法保存您的 ?gem|无法保存 gem|未能保存/.test(all),
      ageNeed: /age verification|verify your age|年龄验证|confirm your age/.test(all),
      notSaved: /gem not saved|尚未保存|未保存/.test(all),
      savedOk: /gem saved|saved your gem|已保存您的 ?gem|gem 已保存|已成功保存/.test(all),
    };
  }).catch(() => ({ url: "", failSave: false, notSaved: false, savedOk: false }));
}

const NAME_SEL = [
  "input[aria-label='Input for a Gem name']",
  "input[placeholder='Give your Gem a name']",
  "input[placeholder*='name' i]",
  "input[aria-label*='name' i]",
];
const INSTR_SEL = [
  "textarea[placeholder^='Describe your Gem']",
  "textarea[placeholder*='Describe' i]",
  "textarea[aria-label*='instruction' i]",
  "textarea",
];

async function openCreate(page, account, ctx) {
  await page.goto(GEM_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (parseLoc(page.url()).host === "accounts.google.com") {
    const r = await login.reauth(page, account, ctx);
    if (r.outcome !== "ok") return r;
    await sleep(2500);
    await page.goto(GEM_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(4000);
  }
  return { outcome: "ok" };
}

async function geminiCheck(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  emit("open_gemini");

  const nav = await openCreate(page, account, ctx);
  if (nav.outcome !== "ok") {
    return { outcome: nav.outcome, detail: { gemini: `进入 Gemini 前验证未通过：${Object.values(nav.detail || {})[0] || ""}` } };
  }

  // 等名称输入框出现（编辑器就绪）。
  let ready = false;
  for (let i = 0; i < 8; i += 1) {
    const h = await visibleFirst(page, NAME_SEL);
    if (h) { await h.dispose().catch(() => {}); ready = true; break; }
    await sleep(2000);
  }
  if (!ready) {
    // 编辑器没出来，可能是瞬时错误 → 重开一次再判，仍不行才转人工。
    const retry = await openCreate(page, account, ctx);
    if (retry.outcome === "ok") {
      const h2 = await visibleFirst(page, NAME_SEL);
      if (h2) { await h2.dispose().catch(() => {}); ready = true; }
    }
  }
  if (!ready) {
    return { outcome: "need_verify", detail: { gemini: `建 Gem 编辑器没渲染出来，停在：${page.url().slice(0, 90)}` } };
  }

  const stamp = Date.now().toString(36).slice(-4);
  emit("fill_gem");
  await fillField(page, NAME_SEL, `Helper ${stamp}`);
  await sleep(600);
  await fillField(page, INSTR_SEL, "A concise, helpful assistant.");
  await sleep(900);

  // 点一次 Save 并在窗口内判定结果。失败 toast 仅显示 ~1.5s，必须高频轮询。
  async function saveOnce() {
    emit("save_gem");
    const clicked = await clickText(page, ["^Save$", "^保存$", "^储存$", "^儲存$"]);
    if (!clicked) return "no_button";
    let sawNotSaved = false;
    for (let i = 0; i < 30; i += 1) {
      await sleep(500);
      const s = await readSignals(page);
      if (s.failSave || s.ageNeed) return "fail";
      if (s.notSaved) sawNotSaved = true;
      const urlMoved = !/\/gems\/create/i.test(s.url) && /\/gems\/[a-z0-9_-]{6,}/i.test(s.url);
      // 成功：出现已保存提示 / 进入具体 gem 详情 / 之前的「Gem not saved」消失。
      if (s.savedOk || urlMoved || (sawNotSaved && !s.notSaved && i >= 4)) return "ok";
    }
    return "timeout";
  }

  let r = await saveOnce();
  if (r === "no_button") {
    return { outcome: "need_verify", detail: { gemini: "没找到/点不动 Save 按钮（可能名称未生效），需真机看一眼" } };
  }
  // 失败可能是瞬时网络抖动，再点一次确认；两次都失败才判「需年龄验证」。
  if (r === "fail") {
    await sleep(1500);
    const r2 = await saveOnce();
    if (r2 === "ok") r = "ok";
  }

  if (r === "fail") {
    emit("gemini_save_failed");
    return {
      outcome: "ok",
      statusPatch: { gemini: "blocked", age: "needs" },
      detail: { gemini: "建 Gem 保存失败（Sorry, we can't save your Gem）→ 账号需要年龄验证" },
    };
  }
  if (r === "ok") {
    emit("gemini_ok");
    return {
      outcome: "ok",
      statusPatch: { gemini: "ok", age: "ok" },
      detail: { gemini: "建 Gem 保存成功 → Gemini 可用，不需要年龄验证" },
    };
  }
  // 超时既没失败也没明确成功 → 转人工复核，不瞎判。
  emit("gemini_timeout");
  return { outcome: "need_verify", detail: { gemini: `点了保存但 ~13s 内既无失败也无成功提示，需复核：${page.url().slice(0, 80)}` } };
}

module.exports = geminiCheck;
