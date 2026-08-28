"use strict";

/**
 * 更改账号「主显示语言」，默认改为简体中文。
 *
 * 真机流程（来自探针，强制 hl=en 让选择器稳定）：
 *   myaccount.google.com/language → 点「Edit language: <当前>」/「Change language」
 *   → 出现搜索框 aria-label="Change your primary language"
 *   → 输入关键词筛选 → 点目标语言项（如 Chinese (Simplified)）→ 点「Save」
 *   选项文本形如「繁體中文 (Chinese (Traditional))」，需排除繁体。
 */

const login = require("./login");
const { sleep, parseLoc, clickText, bodyText } = login.helpers;

const LANG_URL = "https://myaccount.google.com/language?hl=en";

// 目标语言定义：
//   search=搜索词，langMatch=语言项正则，langExclude=排除（如繁体），
//   region=选中语言后若出现「地区」二级列表时的首选地区，label=写回库的名字。
const TARGETS = {
  zh: {
    search: "chinese",
    langMatch: /chinese\s*\(simplified\)|中文\s*[（(]\s*简体/i,
    langExclude: /traditional|繁體|繁体/i,
    primaryMatch: /简体中文|chinese\s*\(simplified\)/i,
    primaryExclude: /traditional|繁體|繁体/i,
    region: /^china$|中国大陆|^中国$/i,
    label: "简体中文",
  },
  en: {
    search: "english",
    langMatch: /^english$/i,
    langExclude: /pseudo|pirate|upside|bork/i,
    primaryMatch: /^english/i,
    primaryExclude: /pseudo|pirate|upside|bork/i,
    region: /united states/i,
    label: "English",
  },
};

// 读当前主语言（列表里带「Change language」的那一项就是主语言）。
async function readPrimary(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll("[role='listitem'],li")];
    const primary = items.find((n) => /change language/i.test(n.textContent || ""));
    const t = (primary ? primary.textContent : (items[0] ? items[0].textContent : "")) || "";
    return t.replace(/change language|更改语言|修改语言/gi, "").replace(/\s+/g, " ").trim().slice(0, 40);
  }).catch(() => "");
}

async function typePrimarySearch(page, term) {
  return page.evaluate((t) => {
    const inputs = [...document.querySelectorAll("input[type='text']")];
    const i = inputs.find((x) => /primary language/i.test(x.getAttribute("aria-label") || ""))
      || inputs.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (x.getAttribute("aria-label") || "") !== "Search Google Account"; });
    if (!i) return false;
    i.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(i, t);
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, term).catch(() => false);
}

// 在 role=option 候选里点命中 match 且不命中 exclude 的项（跳过「当前主语言/自动添加」这些非选项行）。
async function clickOption(page, matchSrc, excludeSrc) {
  return page.evaluate((m, ex) => {
    const matchRe = new RegExp(m, "i");
    const exRe = ex ? new RegExp(ex, "i") : null;
    const opts = [...document.querySelectorAll("[role='option']")]
      .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    for (const n of opts) {
      const txt = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || txt.length > 45) continue;
      if (/change language|automatically add/i.test(txt)) continue;
      if (exRe && exRe.test(txt)) continue;
      if (matchRe.test(txt)) { n.scrollIntoView({ block: "center" }); n.click(); return txt.slice(0, 40); }
    }
    return "";
  }, matchSrc, excludeSrc).catch(() => "");
}

// 点第一个可见的 role=option（用于「地区」子列表没命中首选时兜底）。
async function clickFirstOption(page) {
  return page.evaluate(() => {
    const n = [...document.querySelectorAll("[role='option']")]
      .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .find((x) => !/change language|automatically add/i.test(x.textContent || ""));
    if (n) { n.scrollIntoView({ block: "center" }); n.click(); return (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40); }
    return "";
  }).catch(() => "");
}

async function saveEnabled(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("button,[role='button']")].find((x) => /^save$|^保存$|^儲存$/i.test((x.textContent || "").trim()));
    if (!b) return false;
    return !(b.disabled || b.getAttribute("aria-disabled") === "true");
  }).catch(() => false);
}

async function changeLanguage(page, account, ctx, opts = {}) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const key = opts.lang || "zh";
  const target = TARGETS[key] || TARGETS.zh;

  emit("opening_language_settings");
  await page.goto(LANG_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(2500);

  if (parseLoc(page.url()).host === "accounts.google.com") {
    const r = await login.reauth(page, account, ctx);
    if (r.outcome !== "ok") return { outcome: r.outcome, detail: { language: `需要先登录/验证：${Object.values(r.detail || {})[0] || ""}` } };
    await page.goto(LANG_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(2500);
  }

  const isTarget = (s) => target.primaryMatch.test(s) && !target.primaryExclude.test(s);

  const before = await readPrimary(page);
  emit("current_language", { current: before });
  if (isTarget(before)) {
    return { outcome: "ok", fieldPatch: { language: target.label }, detail: { language: `已经是${target.label}，无需更改` } };
  }

  // 打开「修改主语言」选择器。
  let opened = false;
  for (let i = 0; i < 3 && !opened; i += 1) {
    await clickText(page, ["^Edit language", "更改语言", "^Change language$", "修改语言"]);
    await sleep(1800);
    opened = await page.evaluate(() => [...document.querySelectorAll("input[type='text']")].some((x) => /primary language/i.test(x.getAttribute("aria-label") || ""))).catch(() => false);
  }
  if (!opened) return { outcome: "need_verify", detail: { language: "没能打开「修改主语言」选择器，页面结构可能变了" } };

  // 第一级：搜索并点语言。
  emit("searching_language", { term: target.search });
  await typePrimarySearch(page, target.search);
  await sleep(1800);
  let lang = await clickOption(page, target.langMatch.source, target.langExclude.source);
  if (!lang && key === "zh") {
    await typePrimarySearch(page, "中文");
    await sleep(1500);
    lang = await clickOption(page, target.langMatch.source, target.langExclude.source);
  }
  if (!lang) return { outcome: "need_verify", detail: { language: `没找到目标语言项（${target.label}），需人工确认` } };
  emit("language_picked", { lang });
  await sleep(1500);

  // 第二级：部分语言（如 English/中文）点完会再列「地区」，要选一个 Save 才会启用。
  if (!(await saveEnabled(page))) {
    let region = await clickOption(page, target.region.source, "");
    if (!region) region = await clickFirstOption(page);
    emit("region_picked", { region });
    await sleep(1500);
  }

  // 保存。
  const saved = await clickText(page, ["^Save$", "^保存$", "^儲存$", "^Done$", "^完成$"]);
  await sleep(3000);

  // 复核（保存后有时需刷新才反映）。
  let after = await readPrimary(page);
  if (!isTarget(after)) {
    await page.goto(LANG_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(2500);
    after = await readPrimary(page);
  }
  emit("after_save", { after });
  if (isTarget(after)) {
    return { outcome: "ok", fieldPatch: { language: target.label }, detail: { language: `已将主语言改为${target.label}` } };
  }
  return { outcome: "need_verify", detail: { language: `已选语言+地区并点保存(${saved ? "Save 已点" : "未找到 Save"})，但复核仍为「${after}」，需人工确认` } };
}

module.exports = changeLanguage;
