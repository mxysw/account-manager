"use strict";

const path = require("path");
const { JsonDB } = require("./db");

/**
 * 养号 cookie 的独立存储（仿 cards.js 的「单独 JSON + 模块」范式）。
 *
 * 为什么单独存：会话 cookie 是一大块数组（几十上百条），塞进 accounts.json 主表会让它臃肿、
 * 还会拖慢账号库的读写与渲染。这里按账号 id 存 { cookies, savedAt, count }，主表只留一个
 * 轻量标记（hasCookie/cookieSavedAt，见 accounts.js）。一键登录时按 id 取回 cookie 注入浏览器。
 */
const DATA_DIR = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR)
  : path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "cookies.json");
const db = new JsonDB(DB_FILE, { byAccount: {} });

function nowIso() {
  return new Date().toISOString();
}

function ensureMap() {
  const data = db.get();
  if (!data.byAccount || typeof data.byAccount !== "object") data.byAccount = {};
  return data;
}

/** 保存某账号的整套 cookie（覆盖旧的，最新一次为准）。 */
function save(accountId, cookies) {
  const data = ensureMap();
  const arr = Array.isArray(cookies) ? cookies : [];
  data.byAccount[accountId] = { cookies: arr, count: arr.length, savedAt: nowIso() };
  db.save();
  return data.byAccount[accountId];
}

/** 取某账号已存的 cookie 记录（{ cookies, count, savedAt }）或 null。 */
function get(accountId) {
  const data = ensureMap();
  return data.byAccount[accountId] || null;
}

function has(accountId) {
  const rec = get(accountId);
  return !!(rec && rec.cookies && rec.cookies.length);
}

/** 删除若干账号的 cookie（账号被删时一并清理，避免残留）。 */
function remove(ids) {
  const data = ensureMap();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let removed = 0;
  for (const id of set) {
    if (data.byAccount[id]) { delete data.byAccount[id]; removed += 1; }
  }
  db.save();
  return { removed };
}

function flush() {
  db.flushSync();
}

module.exports = {
  save,
  get,
  has,
  remove,
  flush,
  _db: db,
};
