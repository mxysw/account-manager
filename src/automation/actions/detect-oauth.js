"use strict";

/**
 * 检测「用 Google 登录」第三方平台时，能否到达授权同意页（即账号是否可一键授权）。
 * 只检测能否到达 Google OAuth 同意页 / 是否被拦，不真正完成长期授权。
 *
 * 各平台 OAuth 入口不同，这里用通用判定：跳转链路里出现 accounts.google.com 的
 * oauth/consent / signin/oauth 即视为“可授权(ok)”；若被风控页/错误页拦下视为 blocked。
 *
 * 注意：精确判定需要为每个平台单独适配登录入口，这里给出可用的基础版本。
 */
// Gemini 不在此检测（账号 100% 可授权，且已由「gemini-check」动作单独处理年龄验证）。
const TARGETS = {
  // 下面这些第三方入口需要按真实“用 Google 登录”流程逐个适配，先留通用检测。
  gpt: "https://auth.openai.com/authorize",
  claude: "https://claude.ai/login",
  x: "https://x.com/i/flow/login",
};

async function probe(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(2500);
    const cur = page.url();
    const text = (await page.content()).toLowerCase();
    if (/oauth\/consent|signin\/oauth|consent\?/.test(cur)) return "ok";
    if (/disabled|suspended|unusual traffic|verify it.?s you|确认是您本人|异常流量/.test(text)) return "blocked";
    if (/accounts\.google\.com/.test(cur)) return "ok";
    return "unknown";
  } catch (_) {
    return "unknown";
  }
}

async function detectOauth(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const result = { statusPatch: {}, detail: {}, outcome: "ok" };
  const only = ctx && ctx.targets;
  for (const [key, url] of Object.entries(TARGETS)) {
    if (only && !only.includes(key)) continue;
    emit("checking_oauth", { target: key });
    const outcome = await probe(page, url);
    if (outcome === "ok" || outcome === "blocked") result.statusPatch[key] = outcome;
    else result.detail[key] = "无法判定（入口需按平台适配）";
  }
  return result;
}

module.exports = detectOauth;
