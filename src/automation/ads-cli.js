"use strict";

/**
 * AdsPower 官方 CLI（adspower-browser）封装。
 *
 * 为什么需要它：AdsPower 客户端的本地 API（50325）不暴露「代理池」，
 * 而代理池（保存的代理 + 标签）只能通过官方 CLI（走云端）读取。
 * 我们用它来按标签读取代理，再用本地 API 把指定 proxyid 绑到环境上。
 *
 * 依赖：CLI 运行时需先启动（adspower-browser start -k <KEY>）。
 * 本模块会在命令失败且提示 runtime 未启动时，自动 start 一次再重试。
 */

const { execFile } = require("child_process");
const path = require("path");

// 直接用 node 调 CLI 入口（数组传参，避免 Windows 下 spawn npx.cmd 的 EINVAL 与引号问题）。
const CLI_ENTRY = require.resolve("adspower-browser/cli/index.js");

function run(args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_ENTRY, ...args], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * 从 CLI 输出里提取结果 JSON。
 * 首行是 "Executing command: <name>, params: {...}" —— 里面也有花括号，
 * 必须先去掉首行,否则会从 params 的 { 开始截取导致解析失败。
 */
function extractJson(text) {
  const nl = text.indexOf("\n");
  const rest = nl === -1 ? text : text.slice(nl + 1);
  const i = rest.indexOf("{");
  const j = rest.lastIndexOf("}");
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(rest.slice(i, j + 1)); } catch (_) { return null; }
}

let started = false;
async function ensureRuntime(apiKey) {
  if (started) return;
  await run(["start", "-k", apiKey], { timeout: 60000 });
  started = true;
}

async function command(apiKey, name, params) {
  const arg = JSON.stringify(params || {});
  let r = await run([name, arg, "--api-key", apiKey]);
  let out = `${r.stdout}\n${r.stderr}`;
  if (/runtime is not running|Please run .*start/i.test(out)) {
    await ensureRuntime(apiKey);
    r = await run([name, arg, "--api-key", apiKey]);
    out = `${r.stdout}\n${r.stderr}`;
  }
  const json = extractJson(out);
  if (!json) throw new Error(`CLI ${name} 无法解析输出：${out.slice(0, 200)}`);
  return json;
}

/** 读取全部已保存代理（自动翻页），返回 [{proxyId, type, host, port, tags:[{id,name}]}]。 */
async function listProxies(apiKey) {
  const all = [];
  let page = 1;
  for (;;) {
    const j = await command(apiKey, "get-proxy-list", { limit: 200, page });
    const list = j.list || [];
    for (const p of list) {
      all.push({
        proxyId: String(p.proxy_id),
        type: p.type,
        host: p.host,
        port: p.port,
        tags: (p.proxy_tags || []).map((t) => ({ id: String(t.id), name: t.name })),
      });
    }
    const total = Number(j.total || 0);
    if (all.length >= total || list.length === 0) break;
    page += 1;
    if (page > 100) break;
  }
  return all;
}

/** 聚合出代理标签列表：[{id, name, count}]。 */
async function listProxyTags(apiKey) {
  const proxies = await listProxies(apiKey);
  const byId = new Map();
  let untagged = 0;
  for (const p of proxies) {
    if (!p.tags.length) untagged += 1;
    for (const t of p.tags) {
      const cur = byId.get(t.id) || { id: t.id, name: t.name, count: 0 };
      cur.count += 1;
      byId.set(t.id, cur);
    }
  }
  const tags = [...byId.values()].sort((a, b) => b.count - a.count);
  return { tags, untagged, total: proxies.length };
}

/** 取某标签下所有 proxyId（tagId 为空则返回全部）。 */
async function proxyIdsByTag(apiKey, tagId) {
  const proxies = await listProxies(apiKey);
  if (!tagId) return proxies.map((p) => p.proxyId);
  return proxies.filter((p) => p.tags.some((t) => t.id === String(tagId))).map((p) => p.proxyId);
}

module.exports = { listProxies, listProxyTags, proxyIdsByTag, command };
