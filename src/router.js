"use strict";

const fs = require("fs");
const path = require("path");
const accounts = require("./accounts");
const cards = require("./cards");
const cookies = require("./cookies");
const engine = require("./automation/engine");
const { AdsPower } = require("./automation/adspower");
const adsCli = require("./automation/ads-cli");
const timeSync = require("./automation/time-sync");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) req.destroy(new Error("请求体过大"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (_) { reject(new Error("无效的 JSON")); }
    });
    req.on("error", reject);
  });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function serveStatic(res, pathname) {
  const file = path.resolve(PUBLIC_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

const ROUTES = [
  ["GET", /^\/api\/health$/, () => ({ status: 200, body: { ok: true } })],

  ["GET", /^\/api\/accounts$/, () => ({
    status: 200,
    body: { accounts: accounts.list(), statusFields: accounts.STATUS_FIELDS },
  })],

  ["POST", /^\/api\/accounts\/import$/, async (req) => {
    const body = await readBody(req);
    if (!String(body.text || "").trim()) return { status: 400, body: { error: "请粘贴至少一行账号" } };
    // source=本批货源渠道/标签（可选），写到本批新导入账号上。
    const r = accounts.importText(body.text, { source: body.source });
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  ["POST", /^\/api\/accounts\/delete$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要删除的账号 id" } };
    const r = accounts.remove(ids);
    cookies.remove(ids); // 账号删了，已存 cookie 一并清理，避免残留
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 一键分类：按规则把账号归入各「库」(category)。ids 可选：传则只分类选中，不传分类全部。
  ["POST", /^\/api\/accounts\/classify$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    const r = accounts.classify(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 一键归位：把检测库里的号按状态自动搬进对应管理页（废号/登录失败/待人工/密钥错误/出售/养号），
  // 未分类/未检测留在检测库；已在各管理页或已售的号不动。ids 可选：传则只归位选中且仍在检测库的号。
  ["POST", /^\/api\/accounts\/auto-sort$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    const r = accounts.autoSort(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 出库：把选中账号标记为「已售」并记下时间（前端会先复制交付文本再调它）。
  ["POST", /^\/api\/accounts\/mark-sold$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要标记已售的账号 id" } };
    const r = accounts.markSold(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 退回在库：撤销误标的已售（saleStatus 回 in_stock、清 soldAt）。
  ["POST", /^\/api\/accounts\/mark-instock$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要退回在库的账号 id" } };
    const r = accounts.markInStock(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 导入到出售管理：把选中账号置 inSales=true，推送到出售管理视图（出售页只看这些号）。
  ["POST", /^\/api\/accounts\/push-to-sales$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要导入到出售管理的账号 id" } };
    const r = accounts.pushToSales(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 移出出售管理：把误推的号置 inSales=false（不再出现在出售管理视图）。
  ["POST", /^\/api\/accounts\/remove-from-sales$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要移出出售管理的账号 id" } };
    const r = accounts.removeFromSales(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 导入到养号管理：把选中账号置 inNurture=true，推送到养号管理视图（move 语义：检测系统账号库不再显示）。
  ["POST", /^\/api\/accounts\/push-to-nurture$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要导入到养号管理的账号 id" } };
    const r = accounts.pushToNurture(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 移出养号管理：把号置 inNurture=false（移出后重新出现在检测系统账号库）。
  ["POST", /^\/api\/accounts\/remove-from-nurture$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要移出养号管理的账号 id" } };
    const r = accounts.removeFromNurture(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 导入到废号管理：把选中账号置 inScrap=true，推送到废号管理视图（move 语义：检测系统账号库不再显示）。
  ["POST", /^\/api\/accounts\/push-to-scrap$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要导入到废号管理的账号 id" } };
    const r = accounts.pushToScrap(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 移出废号管理：把号置 inScrap=false（移出后重新出现在检测系统账号库）。
  ["POST", /^\/api\/accounts\/remove-from-scrap$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要移出废号管理的账号 id" } };
    const r = accounts.removeFromScrap(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 导入到登录失败管理：把选中账号置 inFailed=true，推送到登录失败管理视图（move 语义：检测系统账号库不再显示）。
  ["POST", /^\/api\/accounts\/push-to-failed$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要导入到登录失败管理的账号 id" } };
    const r = accounts.pushToFailed(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 移出登录失败管理：把号置 inFailed=false（移出后重新出现在检测系统账号库）。
  ["POST", /^\/api\/accounts\/remove-from-failed$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要移出登录失败管理的账号 id" } };
    const r = accounts.removeFromFailed(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 导入到待人工管理：把选中账号置 inNeedVerify=true，推送到待人工管理视图（move 语义：检测系统账号库不再显示）。
  ["POST", /^\/api\/accounts\/push-to-needverify$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要导入到待人工管理的账号 id" } };
    const r = accounts.pushToNeedVerify(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 移出待人工管理：把号置 inNeedVerify=false（移出后重新出现在检测系统账号库）。
  ["POST", /^\/api\/accounts\/remove-from-needverify$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要移出待人工管理的账号 id" } };
    const r = accounts.removeFromNeedVerify(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 导入到密钥错误管理：把选中账号置 in2faError=true，推送到密钥错误管理视图（move 语义：检测系统账号库不再显示）。
  ["POST", /^\/api\/accounts\/push-to-2fa-error$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要导入到密钥错误管理的账号 id" } };
    const r = accounts.pushTo2faError(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  // 移出密钥错误管理：把号置 in2faError=false（移出后重新出现在检测系统账号库）。
  ["POST", /^\/api\/accounts\/remove-from-2fa-error$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要移出密钥错误管理的账号 id" } };
    const r = accounts.removeFrom2faError(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  ["POST", /^\/api\/accounts\/reset-status$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要复原检测显示的账号 id" } };
    const r = accounts.resetStatus(ids);
    return { status: 200, body: { ...r, accounts: accounts.list() } };
  }],

  ["GET", /^\/api\/accounts\/([^/]+)\/totp$/, async (req, m) => {
    await timeSync.syncTime().catch(() => {}); // 先校准网络时间，保证取码不受本机时钟漂移影响
    const r = accounts.currentTotp(m[1]);
    if (!r) return { status: 404, body: { error: "账号不存在" } };
    if (r.error) return { status: 400, body: { error: r.error } };
    return { status: 200, body: r };
  }],

  ["PATCH", /^\/api\/accounts\/([^/]+)$/, async (req, m) => {
    const body = await readBody(req);
    const account = accounts.update(m[1], body);
    if (!account) return { status: 404, body: { error: "账号不存在" } };
    return { status: 200, body: { account } };
  }],

  // ---- 信用卡卡池 ----
  ["GET", /^\/api\/cards$/, () => ({ status: 200, body: { cards: cards.list(), statuses: cards.STATUSES } })],

  ["POST", /^\/api\/cards\/import$/, async (req) => {
    const body = await readBody(req);
    if (!String(body.text || "").trim()) return { status: 400, body: { error: "请粘贴至少一行卡信息" } };
    const r = cards.importText(body.text);
    return { status: 200, body: { ...r, cards: cards.list() } };
  }],

  ["POST", /^\/api\/cards\/delete$/, async (req) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { status: 400, body: { error: "请提供要删除的卡 id" } };
    const r = cards.remove(ids);
    return { status: 200, body: { ...r, cards: cards.list() } };
  }],

  ["PATCH", /^\/api\/cards\/([^/]+)$/, async (req, m) => {
    const body = await readBody(req);
    const card = cards.update(m[1], body);
    if (!card) return { status: 404, body: { error: "卡不存在" } };
    return { status: 200, body: { card } };
  }],

  // ---- 自动化 ----
  ["GET", /^\/api\/automation\/actions$/, () => ({ status: 200, body: { actions: engine.listActions() } })],

  ["GET", /^\/api\/automation\/envs$/, async (req, m, url) => {
    const apiKey = String(url.searchParams.get("apiKey") || "").trim();
    const ads = new AdsPower({ apiKey });
    try {
      const [profiles, active] = await Promise.all([ads.listProfiles(), ads.activeUserIds()]);
      const envs = profiles.map((p) => ({ ...p, open: active.has(String(p.userId)) }));
      return { status: 200, body: { envs, total: envs.length } };
    } catch (err) {
      return { status: 502, body: { error: `连接 AdsPower 失败：${err.message}（确认 AdsPower 已开启，本地 API 端口 50325 可用）` } };
    }
  }],

  ["GET", /^\/api\/automation\/proxy-tags$/, async (req, m, url) => {
    const apiKey = String(url.searchParams.get("apiKey") || "").trim();
    try {
      const r = await adsCli.listProxyTags(apiKey);
      return { status: 200, body: r };
    } catch (err) {
      return { status: 502, body: { error: `读取代理标签失败：${err.message}（需 AdsPower 已登录该 API Key 的账号）` } };
    }
  }],

  ["POST", /^\/api\/automation\/run$/, async (req) => {
    const body = await readBody(req);
    const apiKey = String(body.apiKey || "").trim();
    const mode = body.mode === "local" ? "local" : "adspower";
    const envSerials = Array.isArray(body.envs) ? body.envs : String(body.envs || "").split(/[\s,，;；]+/).filter(Boolean);
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
    const actionIds = Array.isArray(body.actionIds) ? body.actionIds : [];
    // 本机临时浏览器模式不需要 AdsPower 环境编号，按并发数自动开 N 个本地窗口。
    if (mode !== "local" && !envSerials.length) return { status: 400, body: { error: "请提供至少一个 AdsPower 环境编号" } };
    if (!accountIds.length) return { status: 400, body: { error: "请选择至少一个账号" } };
    if (!actionIds.length) return { status: 400, body: { error: "请选择至少一个操作" } };

    // 代理：AdsPower 模式才用代理池 + 标签；本机模式的代理仍在规划中，透传 proxy.server 即可（UI 暂未对接）。
    const proxy = body.proxy || null;
    if (mode !== "local" && proxy && proxy.enabled && proxy.tagId) {
      try {
        proxy.proxyIds = await adsCli.proxyIdsByTag(apiKey, proxy.tagId);
        if (!proxy.proxyIds.length) {
          return { status: 400, body: { error: "该标签下没有代理，请检查标签或往里添加代理" } };
        }
      } catch (err) {
        return { status: 502, body: { error: `读取标签代理失败：${err.message}` } };
      }
    }

    const job = engine.createJob({
      apiKey, mode, envSerials, accountIds, actionIds,
      maxConcurrent: body.maxConcurrent, targets: body.targets,
      randomFp: body.randomFp, clearData: body.clearData, keepOpen: body.keepOpen,
      proxy,
    });
    return { status: 202, body: { jobId: job.id, job: engine.publicJob(job) } };
  }],

  ["GET", /^\/api\/automation\/jobs\/([^/]+)$/, (req, m) => {
    const job = engine.getJob(m[1]);
    if (!job) return { status: 404, body: { error: "任务不存在" } };
    return { status: 200, body: { job: engine.publicJob(job) } };
  }],

  ["POST", /^\/api\/automation\/jobs\/([^/]+)\/cancel$/, async (req, m) => {
    const job = await engine.cancelJob(m[1]);
    if (!job) return { status: 404, body: { error: "任务不存在" } };
    return { status: 200, body: { job: engine.publicJob(job) } };
  }],
];

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  for (const [method, pattern, fn] of ROUTES) {
    if (req.method !== method) continue;
    const m = url.pathname.match(pattern);
    if (!m) continue;
    const out = await fn(req, m, url);
    return sendJson(res, out.status, out.body);
  }
  if (req.method === "GET" && serveStatic(res, url.pathname)) return;
  sendJson(res, 404, { error: "Not found" });
}

module.exports = { handle };
