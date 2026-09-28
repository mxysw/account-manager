"use strict";

// 已安装的 adspower-browser CLI 把 get-proxy-list 映射到本地
// POST /api/v2/proxy-list/list，并使用 Authorization: Bearer <key>。
// 直接调用同一接口，可避免 CLI runtime 将密钥写入其 pid 状态文件。
const { AdsPower } = require("./adspower");

async function command(apiKey, name, params, client) {
  if (name !== "get-proxy-list") throw new Error("不支持的 AdsPower 代理命令");
  const ads = client || new AdsPower({ apiKey });
  const response = await ads._request("POST", "/api/v2/proxy-list/list", {}, params || {});
  if (!response || response.code !== 0 || !response.data || typeof response.data !== "object") {
    throw new Error("AdsPower 代理列表读取失败");
  }
  return response.data;
}

/** 读取全部已保存代理（自动翻页），仅保留后续筛选所需的 ID 和标签。 */
async function listProxies(apiKey, base) {
  // Pin the API address and Bearer key for all pages. Settings may change while
  // an asynchronous list is in progress; never send its old key to a new port.
  const ads = new AdsPower({ apiKey, base });
  const all = [];
  let page = 1;
  for (;;) {
    const j = await command(apiKey, "get-proxy-list", { limit: 200, page }, ads);
    const list = j.list || [];
    for (const p of list) {
      all.push({
        proxyId: String(p.proxy_id),
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
async function listProxyTags(apiKey, base) {
  const proxies = await listProxies(apiKey, base);
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
async function proxyIdsByTag(apiKey, tagId, base) {
  const proxies = await listProxies(apiKey, base);
  if (!tagId) return proxies.map((p) => p.proxyId);
  return proxies.filter((p) => p.tags.some((t) => t.id === String(tagId))).map((p) => p.proxyId);
}

module.exports = { listProxies, listProxyTags, proxyIdsByTag, command };
