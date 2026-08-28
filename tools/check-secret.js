"use strict";
const totp = require("../src/totp");
const accounts = require("../src/accounts");
const { syncTime, accurateNow } = require("../src/automation/time-sync");

const emails = process.argv.slice(2);

(async () => {
  await syncTime().catch(() => {});
  for (const email of emails) {
    const a = accounts.list().find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!a) { console.log(`\n[${email}] 账号库找不到`); continue; }
    const sec = a.totpSecret || "";
    console.log(`\n===== ${a.email} =====`);
    console.log("存储密钥 :", JSON.stringify(sec), `(长度 ${sec.replace(/[\s-]/g, "").length})`);
    console.log("合法base32:", totp.looksLikeSecret(sec));
    console.log("oldTotpSecret:", a.oldTotpSecret || "(无)");
    // 从 raw 里取最后一个 base32 段，看是否与存储一致（排查解析/覆盖问题）
    if (a.raw) {
      const segs = a.raw.split(/----|\|/).map((s) => s.trim());
      const rawSecret = segs.filter((s) => totp.looksLikeSecret(s) && !s.includes("@")).pop() || "(raw里没有像密钥的段)";
      console.log("raw里的密钥 :", JSON.stringify(rawSecret), rawSecret === sec ? "← 与存储一致" : "← ⚠ 与存储不一致");
      console.log("raw全文   :", a.raw);
    }
    try {
      const r = totp.generate(sec, { now: accurateNow() });
      console.log("当前验证码 :", r.code, `(剩 ${r.secondsRemaining}s)`);
    } catch (e) {
      console.log("生成失败  :", e.message);
    }
    console.log("登录状态  :", a.status && a.status.login);
  }
  process.exit(0);
})();
