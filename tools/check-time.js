"use strict";
const { syncTime, accurateNow, offset } = require("../src/automation/time-sync");
const totp = require("../src/totp");
const accounts = require("../src/accounts");

(async () => {
  const sys = Date.now();
  await syncTime();
  const off = offset();
  console.log("系统时间 :", new Date(sys).toISOString());
  console.log("网络偏移 :", off, "ms （", (off / 1000).toFixed(1), "s ）");
  console.log("校准时间 :", new Date(accurateNow()).toISOString());

  const a = accounts.list()[0];
  if (a && a.totpSecret) {
    const raw = totp.generate(a.totpSecret);
    const synced = totp.generate(a.totpSecret, { now: accurateNow() });
    console.log(`\n账号 ${a.email}`);
    console.log("原始时间取码 :", raw.code, `(剩 ${raw.secondsRemaining}s)`);
    console.log("校准时间取码 :", synced.code, `(剩 ${synced.secondsRemaining}s)`);
  }
  process.exit(0);
})().catch((e) => { console.error("err", e.message); process.exit(1); });
