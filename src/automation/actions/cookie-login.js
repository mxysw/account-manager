"use strict";

/**
 * 一键登录：用某账号「已保存的 cookie」直接进入登录态，跳过密码/2FA，供养号人工接管。
 *
 * 流程：
 *   1) 从 cookies.json 取该账号已存的整套 cookie（没有就明确报错，提示先跑一次检测/登录生成 cookie）。
 *   2) 用 CDP Network.setCookies 注入这套 cookie（经 ctx.session.setCookies，会先清掉现有 cookie）。
 *   3) 打开 myaccount.google.com 验证是否已登录（落在 myaccount 自有域且没被弹回登录页 = 免密成功）。
 *   4) 不关窗：配合任务勾选「跑完不关闭窗口(keepOpen)」由引擎保留窗口，养号人工操作。
 *
 * 本地浏览器 / AdsPower 两种模式都走 browser.connect 那套，session.setCookies 通吃，无需区分。
 * 本动作不做任何写操作、不动账号资料、不退设备，只注入 cookie + 打开页面，安全。
 */

const cookies = require("../../cookies");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERIFY_URL = "https://myaccount.google.com/";

function host(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch (_) { return ""; }
}

async function cookieLogin(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const session = ctx && ctx.session ? ctx.session : null;

  const rec = cookies.get(account.id);
  if (!rec || !rec.cookies || !rec.cookies.length) {
    return {
      outcome: "error",
      detail: { cookieLogin: "该账号没有已保存的 cookie。请先对它跑一次「登录」检测，登录成功会自动存下 cookie，之后才能一键登录。" },
    };
  }
  if (!session || typeof session.setCookies !== "function") {
    return { outcome: "error", detail: { cookieLogin: "当前会话不支持注入 cookie（引擎未传 session）" } };
  }

  emit("cookie_login_inject", { count: rec.cookies.length, savedAt: rec.savedAt });
  const ir = await session.setCookies(rec.cookies);
  if (!ir.ok) {
    return { outcome: "error", detail: { cookieLogin: `注入 cookie 失败：${ir.error || "未知错误"}` } };
  }

  // 打开账号首页验证登录态。带 cookie 后应直接进 myaccount，不会被弹回 accounts.google.com 登录页。
  emit("cookie_login_open", {});
  await page.goto(VERIFY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(4000);

  const h = host(page.url());
  if (h === "myaccount.google.com") {
    emit("cookie_login_ok", {});
    return {
      outcome: "ok",
      detail: { cookieLogin: `已用已存 cookie 免密登入（cookie 存于 ${rec.savedAt}），窗口已保留供养号人工操作` },
    };
  }
  // 被弹回登录页 / 跳到别处：多半是 cookie 过期或被风控登出，需人工或重新跑登录刷新 cookie。
  return {
    outcome: "need_verify",
    detail: { cookieLogin: `注入 cookie 后未进入登录态（停在 ${page.url().slice(0, 90)}），cookie 可能已过期，请重新跑一次登录检测刷新 cookie` },
  };
}

module.exports = cookieLogin;
