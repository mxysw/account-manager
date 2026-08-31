"use strict";

const http = require("http");
const router = require("./router");
const accounts = require("./accounts");
const cards = require("./cards");
const phones = require("./phones");
const cookies = require("./cookies");

process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r && r.message ? r.message : r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e && e.message ? e.message : e));

const PORT = Number(process.env.PORT || 8910);
const HOST = process.env.HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  router.handle(req, res).catch((err) => {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.listen(PORT, HOST, () => {
  // 自动化 jobs 只存在内存中；新进程不可能继续上一进程留下的 active lease。
  // 共享号码按产品语义在任务结束后总是可复用；一号一绑仍只恢复确定未提交的 reserved。
  try {
    const recovered = phones.recoverUnsubmittedReservations({
      allowFresh: true,
      reason: "服务重启后自动恢复手机号池可用状态",
    });
    if (recovered.released) {
      console.log(`手机号池：已恢复 ${recovered.released} 个遗留占用（未用 ${recovered.toUnused}，已用 ${recovered.toUsed}）`);
    }
  } catch (err) {
    console.error("[phone-recovery]", err && err.message ? err.message : err);
  }
  console.log(`Account Manager: http://${HOST}:${PORT}`);
});

// 退出前把缓存落盘，避免丢数据。
function shutdown() {
  try { accounts.flush(); } catch (_) { /* ignore */ }
  try { cards.flush(); } catch (_) { /* ignore */ }
  try { phones.flush(); } catch (_) { /* ignore */ }
  try { cookies.flush(); } catch (_) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = server;
