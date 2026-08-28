"use strict";

/**
 * 单独调试一个动作模块（不经过引擎、不停止环境，方便逐个调）。
 * 用法：
 *   node tools/run-action.js <serial> <actionId> [apiKey] [账号邮箱或ID] [--wipe]
 * 例如：
 *   node tools/run-action.js 153 detect-region b45e...
 *   node tools/run-action.js 153 login b45e... user@example.com --wipe
 *
 * 传了「账号邮箱或ID」时，会从账号库读取真实账号（含密码/2FA）喂给动作；
 * 带 --wipe 时，连接后先清空浏览器全部数据（模拟筛号的干净开局，常用于调登录）。
 */

const { AdsPower } = require("../src/automation/adspower");
const browserMod = require("../src/automation/browser");
const actions = require("../src/automation/actions");
const accounts = require("../src/accounts");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const serial = positional[0] || "";
const actionId = positional[1] || "";
const apiKey = positional[2] || process.env.AP_KEY || "";
const accountSel = positional[3] || "";

function findAccount(sel) {
  if (!sel) return null;
  const byId = accounts.getById(sel);
  if (byId) return byId;
  return accounts.list().find((a) => a.email && a.email.toLowerCase() === sel.toLowerCase()) || null;
}

async function main() {
  if (!serial || !actionId) throw new Error("用法：node tools/run-action.js <serial> <actionId> [apiKey] [账号邮箱或ID] [--wipe]");
  const action = actions.get(actionId);
  if (!action) throw new Error(`未知动作：${actionId}（可用：${actions.list().map((a) => a.id).join(", ")}）`);

  let account = findAccount(accountSel);
  if (accountSel && !account) throw new Error(`账号库里找不到：${accountSel}`);
  if (!account) account = { id: "debug", email: `#${serial}` };
  else console.log(`使用账号：${account.email}（2FA：${account.totpSecret ? "有" : "无"}）`);

  const ads = new AdsPower({ apiKey });
  console.log(`打开环境 #${serial} …`);
  const opened = await ads.start(serial);
  const session = await browserMod.connect(opened.cdpEndpoint);

  if (flags.has("--wipe")) {
    const w = await session.wipe();
    console.log(`清空数据：${w.ok ? "ok" : "失败 " + w.error}`);
  }

  const emit = (type, data = {}) => console.log(`  · ${type}`, Object.keys(data).length ? JSON.stringify(data) : "");
  console.log(`运行动作：${action.label}`);
  const res = await action.run(session.page, account, { emit, browser: session.browser });

  console.log("\n结果：");
  console.log(JSON.stringify(res, null, 2));

  // 和引擎一致：拿到真实账号 + fieldPatch/statusPatch 时写回库（否则改了 Google 端却没存，号会丢）。
  if (account && account.id !== "debug" && res && (res.fieldPatch || res.statusPatch)) {
    const patch = { ...(res.fieldPatch || {}) };
    if (res.statusPatch) patch.status = { ...(account.status || {}), ...res.statusPatch };
    accounts.update(account.id, patch);
    accounts.flush(); // 关键：去抖写盘是异步的，进程马上退出会丢，先同步落盘
    console.log(`\n已写回账号库：${Object.keys(patch).join(", ")}`);
  }

  await session.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ 失败：${err.message}`);
  process.exit(1);
});
