"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");

/**
 * 「不调用 AdsPower」模式的本机临时浏览器启动器。
 *
 * 设计取舍（为什么这么做）：
 * - 复用现有 puppeteer 动作零改动：本机起一个 Chrome/Edge，带 --remote-debugging-port，
 *   仍然用 browser.connect("http://127.0.0.1:<port>") 通过 CDP 接管。session 接口与所有
 *   动作完全不变，无需为本机模式重写任何动作。
 * - 不引入 playwright：本机已安装 Chrome（Windows 常见安装路径），直接复用系统浏览器二进制
 *   最省事、最可靠，也省去几百 MB 的 chromium 下载。找不到 Chrome 时回退到 Edge（同为
 *   Chromium 内核，--remote-debugging-port / --proxy-server 等参数通用）。
 * - 临时、用完即弃（ephemeral）：每次 start 都用一个全新的临时 user-data-dir，stop 时连进程
 *   一起杀掉并删除该目录，不长期保留 profile。
 */

// 允许用环境变量显式指定浏览器路径（最高优先级），方便特殊安装位置。
const ENV_OVERRIDE = process.env.LOCAL_BROWSER_PATH || "";

// Windows 常见 Chrome / Edge 安装路径（按优先级），找到第一个存在的即用。
function candidatePaths() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    ENV_OVERRIDE,
    // 优先 Chrome
    path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
    // 回退 Edge（Chromium 内核，参数通用）
    path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
  ].filter(Boolean);
}

function findExecutable() {
  for (const p of candidatePaths()) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return "";
}

/** 探测一个空闲 TCP 端口（绑 0 让系统分配，再关掉拿到端口号）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /json/version，等调试端口真正可用后返回该响应里的端点信息。 */
function probeDevtools(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/json/version", timeout: 1500 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data || "{}")); } catch (_) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function waitForDevtools(port, totalMs = 30000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const v = await probeDevtools(port);
    if (v && (v.webSocketDebuggerUrl || v.Browser)) return v;
    await sleep(300);
  }
  return null;
}

/**
 * 启动一个本机临时浏览器并等待其 CDP 调试端口就绪。
 * @param {object} opts
 * @param {boolean} [opts.clearData] 是否在关闭后清理临时数据目录（本模式恒为临时目录，恒清理）。
 * @param {string}  [opts.proxy] 代理服务器（如 "http://user:pass@host:port" 或 "socks5://host:port"）。
 *        —— 规划中字段：当前 UI 暂未对接代理导入，仅预留启动参数入口；传入即透传给 --proxy-server。
 * @returns {Promise<{cdpEndpoint:string, port:number, pid:number, userDataDir:string, stop:Function}>}
 */
async function start(opts = {}) {
  const exe = findExecutable();
  if (!exe) {
    throw new Error(
      "未找到本机浏览器（Chrome/Edge）。请安装 Chrome，或用环境变量 LOCAL_BROWSER_PATH 指定浏览器可执行文件路径。",
    );
  }

  const port = await freePort();
  // 一次性临时 user-data-dir，stop 时整目录删除（ephemeral，不长期保留 profile）。
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "am-local-"));

  const args = [
    `--remote-debugging-port=${port}`,
    // 新版 Chrome 经 CDP 接管需放开来源校验，否则 puppeteer 连接会被拒。
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,

    // —— 降低被 Cloudflare/风控判定为机器人的概率 ——
    // 这是一条全新的干净 Chrome，自动化特征明显，最容易被 CF 拦。下面的参数尽量把它伪装成普通用户在用。
    //
    // 关键：禁用 AutomationControlled blink 特征 → navigator.webdriver 变为 false。
    // 我们用 spawn 自己起 Chrome（不是 puppeteer.launch），本就不会带 --enable-automation 与
    // 「正在受自动化测试软件控制」信息栏；这里再显式压掉 webdriver 指纹，去掉最明显的破绽。
    "--disable-blink-features=AutomationControlled",

    // —— 压掉首启 / 默认浏览器 / 登录同步等弹窗与浮层 ——
    // 截图里那个「定制您的专属 Chrome / 开启同步」气泡，是网页登录 Google 后 Chrome 弹的登录拦截浮层，
    // 既干扰观察也增加自动化感。DiceWebSigninInterception 正是这个气泡的开关；配合 --disable-sync 一起关。
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-fre",
    "--disable-sync",
    // CalculateNativeWinOcclusion 追加进同一个 --disable-features：关掉「原生窗口遮挡判定」，
    // 否则窗口被其它窗口盖住时 Chrome 会判为 occluded 并降频 —— 这正是「窗口不打开就很慢」的根因之一。
    // 注意保留 DiceWebSigninInterception,SigninPromo 等抑制登录气泡的开关（是追加，不是替换）。
    "--disable-features=Translate,OptimizationHints,MediaRouter,DiceWebSigninInterception,SigninPromo,InterestFeedContentSuggestions,ChromeWhatsNewUI,PrivacySandboxSettings4,CalculateNativeWinOcclusion",

    // —— 禁用后台/失焦/被遮挡窗口的节流，让本机 Chrome 即使最小化或被遮挡也全速跑 ——
    // 对应三类节流：后台计时器降频、被遮挡窗口降频、渲染器整体降频。
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",

    // 杂项：减少后台请求/默认应用/密钥串弹窗，让进程行为更「干净安静」。
    "--disable-background-networking",
    "--disable-default-apps",
    "--password-store=basic",
    "--no-sb",

    // 给一个常见的窗口尺寸（defaultViewport=null 时视口跟随窗口）：太小或异常尺寸也是机器人特征之一。
    "--window-size=1280,860",
    "about:blank",
  ];

  // 代理（规划中）：若调用方传入 proxy，则透传给浏览器自身的 --proxy-server。
  // 这样代理由浏览器进程处理，后续用户只需把代理数据「导入」到这里即可，无需对接 AdsPower 代理池。
  if (opts.proxy) {
    args.unshift(`--proxy-server=${String(opts.proxy)}`);
  }

  const child = spawn(exe, args, { stdio: "ignore", windowsHide: false });
  child.on("error", () => { /* 启动失败由下面的 waitForDevtools 兜底报错 */ });

  let exited = false;
  child.on("exit", () => { exited = true; });

  const cleanupDir = () => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };

  const version = await waitForDevtools(port, 30000);
  if (!version) {
    try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
    cleanupDir();
    throw new Error(`本机浏览器启动后调试端口 ${port} 未就绪（30s 超时）。可执行文件：${exe}`);
  }

  return {
    cdpEndpoint: `http://127.0.0.1:${port}`,
    port,
    pid: child.pid,
    userDataDir,
    executablePath: exe,
    /** 关闭浏览器进程并清理临时目录（用完即弃）。 */
    async stop() {
      if (!exited) {
        try { child.kill(); } catch (_) { /* ignore */ }
        // 给优雅退出一点时间，超时则强杀，避免游离进程。
        const deadline = Date.now() + 3000;
        while (!exited && Date.now() < deadline) await sleep(150);
        if (!exited) { try { child.kill("SIGKILL"); } catch (_) { /* ignore */ } }
      }
      cleanupDir();
    },
  };
}

module.exports = { start, findExecutable };
