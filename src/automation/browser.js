"use strict";

/**
 * 通过 CDP 接管 AdsPower 已打开的浏览器。
 *
 * 为什么用 puppeteer-core 而不是 playwright：
 * AdsPower 每个环境都带一个自有扩展的 service_worker 目标，
 * Playwright 的 connectOverCDP / Puppeteer 的 pages() 在 attach 这个 SW 时会卡死。
 * 解决办法：
 *   1) puppeteer.connect 时用 targetFilter 跳过 service_worker / worker 目标；
 *   2) 不去接管已有标签（pages() 会卡），而是 newPage() 新开一个干净标签来操作。
 *
 * puppeteer-core 为可选依赖：未安装时给清晰提示，不影响管理面板运行。
 */
function loadPuppeteer() {
  try {
    // eslint-disable-next-line global-require
    return require("puppeteer-core");
  } catch (_) {
    throw new Error("未安装 puppeteer-core，自动化功能不可用。运行：npm install puppeteer-core");
  }
}

// 跳过 service_worker / worker，避免 attach 卡死。
function targetFilter(target) {
  const type = typeof target.type === "function" ? target.type() : target.type;
  return type !== "service_worker" && type !== "worker";
}

/**
 * 给某个 page 注册「自动放行原生对话框」处理器。
 *
 * 为什么必须有：从 Gmail 等会注册 beforeunload 的重页面跨站导航离开时（page.goto / location 跳转），
 * Chrome 会弹原生「离开此网站？/ 系统可能不会保存您所做的更改」确认框。puppeteer 默认不处理它，
 * 于是 goto/导航一直挂起 → 卡死（也表现为偶发 net::ERR_ABORTED / 卡在原页）。
 *
 * 处理策略：beforeunload 一律 accept（= 点「离开」，放行导航，这是自动化期望行为）；
 * 其它 alert/confirm/prompt 也 accept（默默确认，不阻塞流程）。任何异常都吞掉，绝不反过来卡住自己。
 * 幂等：用标记位避免对同一 page 重复挂监听。
 */
function attachDialogAutoAccept(page) {
  if (!page || page.__dialogAutoAccept) return;
  page.__dialogAutoAccept = true;
  page.on("dialog", async (dialog) => {
    try { await dialog.accept(); } catch (_) { /* ignore：对话框可能已被页面自身关闭 */ }
  });
}

/**
 * 让页面无论窗口是否在前台，都表现为「已聚焦 + 可见 + active」，规避 Chrome 的后台节流。
 *
 * 为什么必须有：Chrome 对非前台/最小化/被遮挡/失焦的窗口会做节流——后台计时器降频
 * (background timer throttling)、渲染器降频(renderer backgrounding)、被遮挡窗口降频，
 * 并把页面 document.visibilityState 置为 hidden、触发 blur。结果自动化里大量 waitForSelector /
 * 导航 / 轮询等待被拖慢甚至超时报错；窗口放前台后节流解除又恢复正常。
 *
 * 处理：每个 page 建一个 CDP session：
 *   - Emulation.setFocusEmulationEnabled{enabled:true}：页面始终认为自己有焦点
 *     （document.hasFocus()=true、不再 blur、visibilityState 不再因失焦变 hidden）→ 解除失焦类节流。
 *   - Page.setWebLifecycleState{state:"active"}：强制 web 生命周期为 active，防止被冻结/降频。
 * 全部 try/catch 吞掉：CDP 不支持/失败都不影响主流程。幂等：用标记位避免重复设置。
 */
async function applyAntiThrottle(page) {
  if (!page || page.__antiThrottle) return;
  page.__antiThrottle = true;
  try {
    const client = await page.target().createCDPSession();
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await client.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  } catch (_) { /* ignore：拿不到 CDP session 也不影响主流程 */ }
}

/** 给一个 page 做统一初始化：自动放行原生对话框 + 反后台节流。新开的 page 也走这里。 */
async function initPage(page) {
  attachDialogAutoAccept(page);
  await applyAntiThrottle(page);
}

/** 把 AdsPower 返回的端点统一成 puppeteer 用的 browserURL（http://host:port）。 */
function toBrowserURL(cdpEndpoint) {
  if (!cdpEndpoint) throw new Error("缺少 CDP 调试地址");
  if (/^https?:\/\//i.test(cdpEndpoint)) {
    // 形如 http://127.0.0.1:1376/devtools/browser/xxx → 只取 http://host:port
    const m = cdpEndpoint.match(/^https?:\/\/[^/]+/i);
    return m ? m[0] : cdpEndpoint;
  }
  const portMatch = String(cdpEndpoint).match(/:(\d+)(?:\/|$)/);
  if (portMatch) return `http://127.0.0.1:${portMatch[1]}`;
  throw new Error(`无法解析 CDP 地址：${cdpEndpoint}`);
}

/**
 * 连接并返回一个可操作的新标签页。
 * @returns {{ browser, page, close }}
 */
async function connect(cdpEndpoint) {
  const puppeteer = loadPuppeteer();
  const browserURL = toBrowserURL(cdpEndpoint);
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null, targetFilter });
  const page = await browser.newPage();
  // 兼容动作模块里用到的 Playwright 风格 API。
  if (typeof page.waitForTimeout !== "function") {
    page.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, ms));
  }
  // 关键修复：对每个 page 统一做 ①自动放行原生 beforeunload/alert 对话框（避免「离开此网站？」卡死 goto）
  // ②反后台节流（让窗口最小化/被遮挡/失焦时页面仍表现为聚焦+可见+active，不被 Chrome 降频拖慢）。
  // 一处注册全局生效——
  //   1) 主操作 page 直接初始化；
  //   2) 监听 targetcreated，让后续 newPage（如 login 重试新开的干净 page、label 标识页）也自动覆盖到，
  //      这样所有动作经 connect 拿到的 page 都不会被原生弹窗卡住、也不会被后台节流。
  await initPage(page);
  browser.on("targetcreated", async (target) => {
    try {
      const t = typeof target.type === "function" ? target.type() : target.type;
      if (t !== "page") return;
      const p = await target.page();
      if (p) await initPage(p);
    } catch (_) { /* ignore：拿不到 page（SW/插页等）就跳过 */ }
  });
  return {
    browser,
    page,
    /**
     * 清空登录态：清 Cookie + 缓存。
     * 不用 Storage.clearDataForOrigin{origin:"*"}——它会让 Chrome 大规模重建 frame，
     * 配合 AdBlock 等扩展会导致随后页面反复 detached。清 Cookie 即可强制登出 / 干净重登；
     * 更彻底的存储清理交给 AdsPower 关窗时的 clear_cache_after_closing。
     */
    async wipe() {
      try {
        const client = await page.target().createCDPSession();
        await client.send("Network.enable").catch(() => {});
        await client.send("Network.clearBrowserCookies").catch(() => {});
        await client.send("Network.clearBrowserCache").catch(() => {});
        // 浏览器级清 Cookie（覆盖所有分区），不触发 frame 重建。
        await client.send("Storage.clearCookies").catch(() => {});
        await client.detach().catch(() => {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async close() {
      try { await page.close(); } catch (_) { /* ignore */ }
      // 只断开连接，不关闭 AdsPower 的浏览器本体。
      try { await browser.disconnect(); } catch (_) { /* ignore */ }
    },
    /**
     * 抓取当前浏览器里的全部 cookie（跨所有域，用于养号免密登录）。
     * 用 CDP Network.getAllCookies 拿浏览器级全量 cookie（含 HttpOnly/分区 cookie），
     * 比 page.cookies() 只拿当前页域名的更全。失败返回空数组，绝不抛（不影响检测主流程）。
     */
    async getCookies() {
      try {
        const client = await page.target().createCDPSession();
        await client.send("Network.enable").catch(() => {});
        const r = await client.send("Network.getAllCookies").catch(() => ({ cookies: [] }));
        await client.detach().catch(() => {});
        return (r && r.cookies) || [];
      } catch (_) {
        return [];
      }
    },
    /**
     * 把一整套已存 cookie 注入当前浏览器（用于「一键登录」免密进入登录态）。
     * 用 CDP Network.setCookies 一次性写入；写入前先清掉现有 cookie，保证以注入的这套为准
     * （避免和环境里的残留会话混在一起）。
     */
    async setCookies(cookies) {
      try {
        const client = await page.target().createCDPSession();
        await client.send("Network.enable").catch(() => {});
        await client.send("Network.clearBrowserCookies").catch(() => {});
        const arr = Array.isArray(cookies) ? cookies : [];
        if (arr.length) await client.send("Network.setCookies", { cookies: arr });
        await client.detach().catch(() => {});
        return { ok: true, count: arr.length };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    /**
     * 在被保留的窗口里新开一个醒目的「账号标签页」，让用户能一眼把窗口和账号对上号。
     *
     * 为什么这么做：批量任务勾「保留窗口」时会留下一堆浏览器窗口，标签栏/任务栏只显示网页标题，
     * 用户无法分辨哪个窗口是哪个号。这里 newPage 一个干净标签页，把 document.title 设为邮箱
     * （标签栏 + Windows 任务栏都会显示它），正文用大字渲染邮箱 + 状态摘要。
     *
     * AdsPower / 本机两种模式都走 connect → 都能复用此方法；AdsPower 下 newPage 本就是现有流程，可用。
     *
     * 健壮性：所有步骤包 try/catch + 超时保护；任何失败都只返回 { ok:false }，绝不抛出，
     * 以免影响窗口保留本身。
     *
     * @param {object} opts
     * @param {string} opts.email   账号邮箱（用作标题）
     * @param {string[]|string} [opts.summary] 状态摘要（每项一行；非 ok 的检测结论）
     */
    async label({ email, summary } = {}) {
      const safeEmail = String(email || "未知账号");
      const lines = (Array.isArray(summary) ? summary : (summary ? [summary] : []))
        .map((s) => String(s).trim())
        .filter(Boolean);
      const withTimeout = (p, ms, tag) => Promise.race([
        Promise.resolve(p),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`label.${tag} 超时`)), ms)),
      ]);
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
      ));
      let labelPage = null;
      try {
        labelPage = await withTimeout(browser.newPage(), 8000, "newPage");
        const title = `📌 ${safeEmail} ← 此号`;
        const hasIssue = lines.length > 0;
        const summaryHtml = hasIssue
          ? `<ul class="summary">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
          : `<p class="ok">✓ 全部动作正常完成</p>`;
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
          + `<title>${esc(title)}</title><style>`
          + `*{box-sizing:border-box;margin:0;padding:0}`
          + `body{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;`
          + `font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;`
          + `background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);color:#f8fafc;padding:6vh 5vw;gap:28px}`
          + `.tag{font-size:18px;letter-spacing:2px;color:#94a3b8}`
          + `.email{font-size:clamp(28px,6vw,64px);font-weight:800;color:#fde047;word-break:break-all;`
          + `text-align:center;line-height:1.2;text-shadow:0 2px 12px rgba(0,0,0,.4)}`
          + `.summary{list-style:none;display:flex;flex-direction:column;gap:12px;max-width:90vw}`
          + `.summary li{font-size:clamp(16px,2.4vw,26px);font-weight:600;background:rgba(239,68,68,.15);`
          + `border-left:6px solid #ef4444;border-radius:8px;padding:12px 20px;color:#fecaca}`
          + `.ok{font-size:clamp(18px,3vw,30px);font-weight:700;color:#86efac;`
          + `background:rgba(34,197,94,.12);border-radius:10px;padding:14px 28px}`
          + `.hint{font-size:14px;color:#64748b}`
          + `</style></head><body>`
          + `<div class="tag">保留的浏览器窗口 · 请人工处理</div>`
          + `<div class="email">${esc(safeEmail)}</div>`
          + `${summaryHtml}`
          + `<div class="hint">此标签页仅用于标识窗口归属，可在处理完后关闭</div>`
          + `</body></html>`;
        await withTimeout(labelPage.setContent(html, { waitUntil: "load" }), 8000, "setContent");
        // 双保险：setContent 后再强制设一次 title（部分环境 <title> 解析时机不稳）。
        await withTimeout(labelPage.evaluate((t) => { document.title = t; }, title), 5000, "title")
          .catch(() => { /* 标题设置失败不影响整体 */ });
        try { await labelPage.bringToFront(); } catch (_) { /* ignore */ }
        return { ok: true, email: safeEmail };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    /** 只断开自动化连接，保留标签和窗口（用于「不关闭窗口」）。 */
    async disconnect() {
      try { await browser.disconnect(); } catch (_) { /* ignore */ }
    },
  };
}

module.exports = { connect, targetFilter, toBrowserURL };
