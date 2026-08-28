"use strict";

/**
 * 检测账号归属地（账号实际所属国家/地区）。
 *
 * 取值来源：登录态下打开 https://policies.google.com/terms?hl=en
 * 页脚的「Country version: <国家>」即 Google 判定的账号归属地，最稳。
 * 用 a[data-name="country-version"] 锚点定位（不随界面语言变），强制 hl=en 让国家名统一为英文。
 *
 * 注意：不回退到 IP 国家——那是代理出口落地国，跟账号归属地是两码事（用户明确不要）。
 */
const TERMS_URL = "https://policies.google.com/terms?hl=en";

async function readCountry(page) {
  return page.evaluate(() => {
    const a = document.querySelector('a[data-name="country-version"]');
    if (!a) return null;
    const box = a.closest("p") || a.parentElement;
    if (!box) return null;
    const full = (box.textContent || "").trim();
    const label = (a.textContent || "").trim();
    let v = full.startsWith(label) ? full.slice(label.length) : full.replace(label, "");
    v = v.replace(/^[:：\s]+/, "").trim();
    return v || null;
  });
}

async function detectRegion(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const result = { fieldPatch: {}, detail: {}, outcome: "ok" };

  emit("checking_region");

  // 登录闸门：没登录时条款页显示的是 IP 所在国（不是账号归属地），必须先确认已登录。
  try {
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    let host = "";
    try { host = new URL(page.url()).hostname.toLowerCase(); } catch (_) { host = ""; }
    if (host !== "myaccount.google.com") {
      result.detail.region = "未登录，无法判定归属地（条款页国家会变成 IP 所在国，已跳过不写）";
      result.outcome = "error";
      return result;
    }
  } catch (err) {
    result.detail.region = `登录态检查失败：${err.message}`;
    result.outcome = "error";
    return result;
  }

  try {
    await page.goto(TERMS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    result.detail.region = `打开服务条款页失败：${err.message}`;
    result.outcome = "error";
    return result;
  }

  // 等锚点出现（页面是 c-wiz 异步渲染，给几秒并轮询）。
  let country = null;
  for (let i = 0; i < 6 && !country; i += 1) {
    country = await readCountry(page).catch(() => null);
    if (!country) await page.waitForTimeout(1000);
  }

  if (country) {
    result.fieldPatch.country = country;
    result.detail.country = country;
    result.detail.source = "google-terms";
  } else {
    result.detail.region = "未读到归属地（可能未登录或页面结构变化）";
    result.outcome = "error";
  }
  return result;
}

module.exports = detectRegion;
