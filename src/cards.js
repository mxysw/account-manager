"use strict";

const path = require("path");
const { JsonDB } = require("./db");

const DATA_DIR = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR)
  : path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "cards.json");
const db = new JsonDB(DB_FILE, { cards: [] });

// 卡的可编辑字段。
const EDITABLE = new Set(["number", "exp", "cvc", "holder", "zip", "country", "notes"]);
// 状态：unused 未用 / used 已用(验证成功) / failed 验证失败 / disabled 停用。
const STATUSES = ["unused", "used", "failed", "disabled"];

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function digits(s) {
  return String(s || "").replace(/\D/g, "");
}

// 把 1/26、1/2026、01-26 之类统一成 MM/YY。
function normExp(s) {
  const m = String(s || "").match(/(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);
  if (!m) return "";
  let mm = m[1].padStart(2, "0");
  let yy = m[2];
  if (yy.length === 4) yy = yy.slice(2);
  return `${mm}/${yy}`;
}

/**
 * 解析一行卡，字段顺序较灵活。分隔符支持 ---- 与 |。
 * 优先识别：卡号(13-19位)、有效期(MM/YY)、CVC(3-4位)；其余按 持卡人/邮编/国家 兜底。
 * 例：4242424242424242|12/27|123|John Doe|10001|US
 */
function parseLine(line) {
  const value = String(line || "").trim();
  if (!value) return null;
  const sep = value.includes("----") ? "----" : (value.includes("|") ? "|" : (value.includes("\t") ? "\t" : null));
  const parts = sep ? value.split(sep).map((p) => p.trim()) : value.split(/\s+/).map((p) => p.trim());
  const out = { number: "", exp: "", cvc: "", holder: "", zip: "", country: "", raw: value };
  const rest = [];
  for (const seg of parts) {
    if (!seg) continue;
    const d = digits(seg);
    if (!out.number && d.length >= 13 && d.length <= 19 && /^\d[\d\s-]*$/.test(seg)) {
      out.number = d;
    } else if (!out.exp && /\d{1,2}\s*[\/\-.]\s*\d{2,4}/.test(seg)) {
      out.exp = normExp(seg);
    } else if (!out.cvc && /^\d{3,4}$/.test(d) && d.length === seg.replace(/\s/g, "").length) {
      out.cvc = d;
    } else {
      rest.push(seg);
    }
  }
  // 兜底：剩余段里，纯数字短串当邮编，2位字母当国家，含字母的当持卡人。
  for (const seg of rest) {
    if (!out.country && /^[A-Za-z]{2}$/.test(seg)) out.country = seg.toUpperCase();
    else if (!out.zip && /^[A-Za-z0-9 \-]{3,10}$/.test(seg) && /\d/.test(seg)) out.zip = seg;
    else if (!out.holder && /[A-Za-z\u4e00-\u9fa5]/.test(seg)) out.holder = seg;
  }
  if (!out.number) throw new Error(`没识别到卡号：${value}`);
  return out;
}

function createFrom(parsed) {
  return {
    id: genId(),
    number: parsed.number,
    exp: parsed.exp || "",
    cvc: parsed.cvc || "",
    holder: parsed.holder || "",
    zip: parsed.zip || "",
    country: parsed.country || "",
    status: "unused",
    usedBy: "",
    notes: "",
    raw: parsed.raw,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function list() {
  return db.get().cards;
}

function getById(id) {
  return db.get().cards.find((c) => c.id === id) || null;
}

/** 导入多行，按卡号去重。 */
function importText(text) {
  const data = db.get();
  const byNum = new Map(data.cards.map((c) => [c.number, c]));
  let added = 0;
  let dup = 0;
  const errors = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (!parsed) continue;
    if (byNum.has(parsed.number)) { dup += 1; continue; }
    const card = createFrom(parsed);
    data.cards.push(card);
    byNum.set(card.number, card);
    added += 1;
  }
  db.save();
  return { added, dup, total: data.cards.length, errors };
}

function update(id, patch) {
  const card = getById(id);
  if (!card) return null;
  for (const [key, value] of Object.entries(patch || {})) {
    if (EDITABLE.has(key)) {
      card[key] = key === "number" ? digits(value) : (key === "exp" ? normExp(value) : String(value == null ? "" : value));
    } else if (key === "status" && STATUSES.includes(value)) {
      card.status = value;
    } else if (key === "usedBy") {
      card.usedBy = String(value == null ? "" : value);
    }
  }
  card.updatedAt = nowIso();
  db.save();
  return card;
}

function remove(ids) {
  const data = db.get();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const before = data.cards.length;
  data.cards = data.cards.filter((c) => !set.has(c.id));
  db.save();
  return { removed: before - data.cards.length, total: data.cards.length };
}

/** 取一张可用的卡（unused 优先），标记给某账号占用。用于年龄验证。 */
function takeForAccount(accountEmail) {
  const data = db.get();
  // 已分配给该账号的卡优先复用。
  let card = data.cards.find((c) => c.usedBy === accountEmail && c.status !== "disabled" && c.status !== "failed");
  if (!card) card = data.cards.find((c) => c.status === "unused");
  if (!card) return null;
  card.usedBy = accountEmail;
  card.updatedAt = nowIso();
  db.save();
  return card;
}

function flush() {
  db.flushSync();
}

module.exports = {
  STATUSES,
  parseLine,
  list,
  getById,
  importText,
  update,
  remove,
  takeForAccount,
  flush,
  _db: db,
};
