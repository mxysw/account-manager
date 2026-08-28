"use strict";

/**
 * 信用卡年龄验证：账号被判「需年龄验证」后，用卡池里的信用卡完成 Google 的 age-verification。
 *
 * 真机结构（来自探针）：
 *   入口 https://myaccount.google.com/age-verification/credit-card?hl=en
 *   表单在 payments.google.com 的 buyflow iframe 内，字段靠关联 label 文本定位：
 *     Card number / Expiration date(MM/YY) / Security code / Cardholder name /
 *     Street address / Post town(城市) / Postal code，按钮 "Save and submit"。
 *   提示「You won't be charged. Any transaction fee will be fully refunded.」
 *
 * 地址策略（用户选定）：默认美国地址，$0 验证一般不严校地址；国家固定 US。
 */

const login = require("./login");
const cards = require("../../cards");
const { sleep, parseLoc, clickText } = login.helpers;

const CC_URL = "https://myaccount.google.com/age-verification/credit-card?hl=en";

// 账单国家由账号归属地预设，邮编/地址必须匹配该国格式，否则报「postal code format not recognized」。
// 按国家给一套有效的默认地址（邮编都是该国真实有效格式）。
const ADDR_BY_COUNTRY = {
  "united states": { line1: "350 5th Ave", city: "New York", state: "NY", zip: "10001" },
  "united kingdom": { line1: "221 Baker Street", city: "London", state: "", zip: "NW1 6XE" },
  "canada": { line1: "301 Front St W", city: "Toronto", state: "ON", zip: "M5V 2T6" },
  "australia": { line1: "1 Macquarie St", city: "Sydney", state: "NSW", zip: "2000" },
  "germany": { line1: "Friedrichstrasse 43", city: "Berlin", state: "", zip: "10117" },
  "france": { line1: "8 Rue de Rivoli", city: "Paris", state: "", zip: "75004" },
  "india": { line1: "1 MG Road", city: "Bengaluru", state: "Karnataka", zip: "560001" },
  "japan": { line1: "1 Chome-1 Marunouchi", city: "Tokyo", state: "", zip: "100-0005" },
};
const FALLBACK_ADDR = ADDR_BY_COUNTRY["united states"];

function addrFor(countryText) {
  const c = String(countryText || "").toLowerCase();
  for (const [name, addr] of Object.entries(ADDR_BY_COUNTRY)) {
    if (c.includes(name)) return { ...addr, country: name };
  }
  return { ...FALLBACK_ADDR, country: c || "united states" };
}

const OK_RE = /age (is )?verified|verification (complete|successful)|you'?re all set|thanks for verifying|已验证|验证(成功|完成)|年龄已验证/i;
const FAIL_RE = /can'?t verify|couldn'?t verify|verification failed|declined|card (was )?declined|try (a )?(different|another) card|invalid card|拒绝|验证失败|无法验证|卡.*(被拒|无效)/i;

function payFrame(page) {
  return page.frames().find((f) => /payments\.google\.com/i.test(f.url()) && /buyflow|w\/u/i.test(f.url())) || null;
}

// 在指定 frame 里按 label 文本定位输入框并填值（返回是否成功）。
async function typeByLabel(frame, labelSrc, value) {
  const id = await frame.evaluate((src) => {
    const re = new RegExp(src, "i");
    const labelText = (n) => {
      const by = n.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((x) => { const e = document.getElementById(x); return e ? e.textContent : ""; }).join(" ");
        if (t.trim()) return t.replace(/\s+/g, " ").trim();
      }
      let p = n.parentElement;
      for (let i = 0; i < 4 && p; i += 1) { const t = (p.textContent || "").replace(/\s+/g, " ").trim(); if (t && t.length < 45) return t; p = p.parentElement; }
      return "";
    };
    for (const n of document.querySelectorAll("input")) {
      const lab = `${labelText(n)} ${n.getAttribute("aria-label") || ""}`;
      if (re.test(lab)) {
        if (!n.id) n.id = "amp_" + Math.random().toString(36).slice(2, 8);
        return n.id;
      }
    }
    return "";
  }, labelSrc).catch(() => "");
  if (!id) return false;
  const h = await frame.$(`#${id}`);
  if (!h) return false;
  await h.click({ clickCount: 3 }).catch(() => {});
  await h.type(String(value), { delay: 55 }).catch(() => {});
  await h.dispose().catch(() => {});
  await sleep(250);
  return true;
}

async function fillCardForm(frame, card, addr) {
  const filled = {};
  filled.number = await typeByLabel(frame, "card number|卡号", card.number);
  filled.exp = await typeByLabel(frame, "expiration|MM/YY|有效期|到期", String(card.exp || "").replace(/[^0-9]/g, ""));
  filled.cvc = await typeByLabel(frame, "security code|cvc|cvv|安全码", card.cvc);
  filled.holder = await typeByLabel(frame, "cardholder name|name on card|持卡人", card.holder || "John Carter");
  // 账单地址（默认）。州/省字段不一定存在，存在才填。
  await typeByLabel(frame, "street address|address line ?1|地址", addr.line1);
  await typeByLabel(frame, "post town|^city$|town/city|城市", addr.city);
  await typeByLabel(frame, "^state$|province|county|州|省", addr.state);
  await typeByLabel(frame, "postal code|zip|邮编|邮政编码", addr.zip);
  return filled;
}

async function ageVerify(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};

  // 领一张可用卡。
  const card = cards.takeForAccount(account.email || account.id || "");
  if (!card) {
    return { outcome: "error", detail: { age: "卡池里没有可用的信用卡，请先在「信用卡卡池」导入卡" } };
  }
  emit("card_picked", { last4: String(card.number).slice(-4) });

  await page.goto(CC_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (parseLoc(page.url()).host === "accounts.google.com") {
    const r = await login.reauth(page, account, ctx);
    if (r.outcome !== "ok") {
      return { outcome: r.outcome, detail: { age: `进入年龄验证前重新验证未通过：${Object.values(r.detail || {})[0] || ""}` } };
    }
    await sleep(2500);
    await page.goto(CC_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(4000);
  }

  // 等支付 iframe 出现并渲染出卡号框。
  let frame = null;
  for (let i = 0; i < 12; i += 1) {
    frame = payFrame(page);
    if (frame) {
      const hasInput = await frame.$("input").then((h) => { if (h) h.dispose().catch(() => {}); return !!h; }).catch(() => false);
      if (hasInput) break;
    }
    await sleep(2000);
  }
  if (!frame) {
    return { outcome: "need_verify", detail: { age: `没找到信用卡表单 iframe，停在：${page.url().slice(0, 90)}` } };
  }

  // 读取表单预设的账单国家，按国家选匹配的有效地址（邮编格式必须对）。
  const countryText = await frame.evaluate(() => {
    const m = (document.body ? document.body.innerText : "").match(/Country\/region\s*([A-Za-z ()]+?)\s*(Street address|Address|Card number|Postal)/i);
    return m ? m[1].trim() : "";
  }).catch(() => "");
  const addr = addrFor(countryText);
  emit("billing_country", { country: addr.country });

  emit("fill_card");
  const filled = await fillCardForm(frame, card, addr);
  if (!filled.number || !filled.cvc) {
    return { outcome: "need_verify", detail: { age: `卡号/安全码没填进去（表单结构可能变了）：${JSON.stringify(filled)}` } };
  }
  await sleep(800);

  emit("submit_card");
  // 提交按钮在 iframe 里。
  const submitted = await clickInFrame(frame, ["^Save and submit$", "^Submit$", "^Verify$", "^保存并提交$", "^提交$", "^验证$"]);
  if (!submitted) {
    return { outcome: "need_verify", detail: { age: "没找到/点不动「Save and submit」按钮，需真机看一眼" } };
  }

  // 等结果（最多 ~25s）。
  let verdict = null;
  let validationMsg = "";
  for (let i = 0; i < 25; i += 1) {
    await sleep(1000);
    const txt = await frameBody(page);
    if (OK_RE.test(txt)) { verdict = "ok"; break; }
    if (FAIL_RE.test(txt)) { verdict = "fail"; break; }
    // 验证成功常会跳回 age-verification 主页且不再要求验证。
    if (/age-verification\b/i.test(page.url()) && !/credit-card/i.test(page.url())) { verdict = "ok"; break; }
    const vm = txt.match(/(postal code format is not recognized|enter a valid|this field is required|invalid (card|expiration|security)|检查|格式|必填)[^.。]*/i);
    if (vm) validationMsg = vm[0].slice(0, 60);
  }

  if (verdict === null && validationMsg) {
    return { outcome: "need_verify", detail: { age: `表单校验未过：${validationMsg}（地址/卡信息需调整）` } };
  }

  if (verdict === "ok") {
    cards.update(card.id, { status: "used", usedBy: account.email || "" });
    cards.flush();
    emit("age_verified");
    return { outcome: "ok", statusPatch: { age: "verified" }, detail: { age: `信用卡年龄验证成功（卡尾号 ${String(card.number).slice(-4)}）` } };
  }
  if (verdict === "fail") {
    cards.update(card.id, { status: "failed", usedBy: account.email || "" });
    cards.flush();
    emit("age_failed");
    return { outcome: "blocked", statusPatch: { age: "failed" }, detail: { age: `信用卡年龄验证失败/被拒（卡尾号 ${String(card.number).slice(-4)}），可换卡再试` } };
  }
  return { outcome: "need_verify", detail: { age: `提交后 ~25s 未拿到明确结果，需复核：${page.url().slice(0, 80)}` } };
}

// 在 iframe 内按文本点击按钮。
async function clickInFrame(frame, sources) {
  return frame.evaluate((srcs) => {
    const res = srcs.map((s) => new RegExp(s, "i"));
    const btns = [...document.querySelectorAll("button,[role='button']")];
    for (const b of btns) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (res.some((r) => r.test(t))) { b.click(); return true; }
    }
    return false;
  }, sources).catch(() => false);
}

// 读主页面 + 所有子 frame 的可见文本（结果提示可能在 iframe 或主页）。
async function frameBody(page) {
  const parts = [];
  for (const f of page.frames()) {
    const t = await f.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    if (t) parts.push(t);
  }
  return parts.join("\n").replace(/\s+/g, " ");
}

module.exports = ageVerify;
