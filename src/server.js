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
