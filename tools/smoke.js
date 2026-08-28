"use strict";

/**
 * AdsPower 连通性冒烟测试。
 * 用法：
 *   node tools/smoke.js <serial> [apiKey]
 * 或用环境变量：
 *   AP_SERIAL=153 AP_KEY=xxxx node tools/smoke.js
 *
 * 它只做：打开环境 -> CDP 接管 -> 读出每个标签页的网址/标题 -> 断开（不关闭你的浏览器）。
 */

const { AdsPower } = require("../src/automation/adspower");
const browser = require("../src/automation/browser");

const serial = process.argv[2] || process.env.AP_SERIAL || "";
const apiKey = process.argv[3] || process.env.AP_KEY || "";

async function main() {
  if (!serial) throw new Error("请提供环境编号：node tools/smoke.js <serial> [apiKey]");
  const ads = new AdsPower({ apiKey });

  console.log(`[1/3] 打开 AdsPower 环境 #${serial} …`);
  const opened = await ads.start(serial);
  if (!opened.cdpEndpoint) throw new Error("AdsPower 没有返回 CDP 调试地址");
  console.log(`      CDP: ${opened.cdpEndpoint}`);

  console.log("[2/3] 用 puppeteer-core 接管浏览器并新开标签 …");
  const session = await browser.connect(opened.cdpEndpoint);

  console.log("[3/3] 打开 myaccount.google.com 验证读取：");
  await session.page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log(`      url   : ${session.page.url()}`);
  console.log(`      title : ${(await session.page.title()).slice(0, 50)}`);

  await session.close();
  console.log("\n✅ 连通性正常：AdsPower API -> CDP -> puppeteer-core 全链路打通。");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ 失败：${err.message}`);
  process.exit(1);
});
