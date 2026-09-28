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
function abortError() {
  const error = new Error("任务已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function freePort(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(port);
    };
    const onAbort = () => {
      try { srv.close(); } catch (_) { /* listening 回调也会检查取消，避免迟到的监听泄漏 */ }
      finish(abortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    srv.on("error", (error) => finish(error));
    srv.listen(0, "127.0.0.1", () => {
      if (settled || (signal && signal.aborted)) {
        srv.close();
        finish(abortError());
        return;
      }
      const { port } = srv.address();
      srv.close((error) => finish(error, port));
    });
  });
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Chrome 冷启动时 /json/version 可能先返回 Browser 字段，稍后才补上真正可连接的
 * webSocketDebuggerUrl。只有后者存在且格式正确，才代表 CDP 已经可以被 Puppeteer 接管。
 */
function isDevtoolsReady(version) {
  if (!version || typeof version.webSocketDebuggerUrl !== "string") return false;
  try {
    const endpoint = new URL(version.webSocketDebuggerUrl);
    return (endpoint.protocol === "ws:" || endpoint.protocol === "wss:")
      && endpoint.pathname.startsWith("/devtools/browser/");
  } catch (_) {
    return false;
  }
}

/** 轮询 /json/version，等调试端口真正可用后返回该响应里的端点信息。 */
function probeDevtools(port, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => { finish(null, abortError()); req.destroy(); };
    const req = http.get({ hostname: "127.0.0.1", port, path: "/json/version", timeout: 1500 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { finish(JSON.parse(data || "{}")); } catch (_) { finish(null); }
      });
      res.on("error", () => finish(null));
    });
    req.on("error", () => finish(null));
    req.on("timeout", () => { finish(null); req.destroy(); });
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (signal && signal.aborted) onAbort();
  });
}

async function waitForDevtools(port, totalMs = 30000, signal) {
  throwIfAborted(signal);
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const v = await probeDevtools(port, signal);
    throwIfAborted(signal);
    if (isDevtoolsReady(v)) return v;
    await sleep(Math.min(300, Math.max(0, deadline - Date.now())), signal);
  }
  return null;
}

function cleanupTempDir(userDataDir) {
  const resolved = path.resolve(userDataDir);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^am-local-[a-z0-9]+$/i.test(path.basename(resolved))) {
    throw new Error("临时浏览器目录超出允许范围，未删除");
  }
  if (!fs.existsSync(resolved)) return;
  const actual = fs.realpathSync(resolved);
  if (path.dirname(actual).toLowerCase() !== tempRoot.toLowerCase()) throw new Error("临时浏览器目录指向非预期位置，未删除");
  fs.rmSync(resolved, { recursive: true, force: true });
}

function killWindowsTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error("临时浏览器进程号无效，未关闭任何进程"));
  const spawnProcess = options.spawn || spawn;
  return new Promise((resolve, reject) => {
    let settled = false;
    let killer;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    try {
      // 只针对本次 spawn 的根 PID 和其子进程，不按 chrome.exe 名称或全局进程列表关闭。
      killer = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => finish(new Error("无法启动临时浏览器进程关闭命令")));
      killer.once("exit", (code) => finish(code === 0 ? null : new Error(`临时浏览器进程树关闭失败（退出码 ${code}）`)));
      if (!settled) timer = setTimeout(() => {
        finish(new Error("关闭临时浏览器进程超时"));
        try { killer.kill(); } catch (_) { /* 只停止本次创建的 taskkill 辅助进程 */ }
      }, Math.max(1, Number(options.timeoutMs) || 5000));
    } catch (_) { finish(new Error("无法执行临时浏览器进程关闭命令")); }
  });
}

/** 并发 stop 共用同一 Promise；失败可重试，只有确认进程退出才删除本次专有 profile。 */
function createProcessStop(child, cleanupDir, options = {}) {
  let exited = child.exitCode != null || child.signalCode != null;
  let stopped = false;
  let stopping = null;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { if (!child.pid) exited = true; });
  const wait = options.sleep || sleep;
  const platform = options.platform || process.platform;
  const confirmExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!exited && Date.now() < deadline) await wait(Math.min(50, Math.max(1, deadline - Date.now())));
    return exited;
  };
  const run = async () => {
    if (!exited) {
      if (platform === "win32") {
        let killError = null;
        try { await (options.killWindowsTree || killWindowsTree)(child.pid, options); }
        catch (error) { killError = error; }
        // Chrome 子进程会随根进程退出；taskkill 遍历过程中碰到刚退出的子进程时可能
        // 返回 128/255。只在本次 spawn 的 ChildProcess 已发出 exit 后认可关闭成功，
        // 不能只按 taskkill 的错误码忽略失败，也不能据 PID 查询误认复用的其它进程。
        if (!await confirmExit(Number(options.exitTimeoutMs) || 3000)) {
          throw killError || new Error("临时浏览器进程尚未退出，窗口关闭未确认");
        }
      } else {
        if (!child.kill("SIGTERM") && !exited) throw new Error("临时浏览器未接受关闭请求");
        if (!await confirmExit(Number(options.graceMs) || 500)) {
          if (!child.kill("SIGKILL") && !exited) throw new Error("临时浏览器强制关闭失败");
        }
      }
      if (!await confirmExit(Number(options.exitTimeoutMs) || 3000)) throw new Error("临时浏览器进程尚未退出，窗口关闭未确认");
    }
    let cleanupError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await cleanupDir(); cleanupError = null; break; } catch (error) { cleanupError = error; }
      if (attempt < 4) await wait(100);
    }
    if (cleanupError) throw new Error(`临时浏览器已退出，但数据目录清理失败：${cleanupError.message}`);
    stopped = true;
    return { ok: true };
  };
  return function stop() {
    if (stopped) return Promise.resolve({ ok: true });
    if (stopping) return stopping;
    stopping = run().finally(() => { stopping = null; });
    return stopping;
  };
}

/**
 * 启动一个本机临时浏览器并等待其 CDP 调试端口就绪。
 * @param {object} opts
 * @param {boolean} [opts.clearData] 是否在关闭后清理临时数据目录（本模式恒为临时目录，恒清理）。
 * @param {AbortSignal} [opts.signal] 取消启动探测并关闭本次专有浏览器；返回句柄后依然生效。
 * @param {boolean} [opts.background] 严格为 true 时最小化启动；保留任务栏入口，不使用无头模式。
 * @param {string}  [opts.proxy] 代理服务器（如 "http://user:pass@host:port" 或 "socks5://host:port"）。
 *        —— 规划中字段：当前 UI 暂未对接代理导入，仅预留启动参数入口；传入即透传给 --proxy-server。
 * @returns {Promise<{cdpEndpoint:string, port:number, pid:number, userDataDir:string, stop:Function}>}
 */
async function start(opts = {}, deps = {}) {
  const signal = opts.signal;
  throwIfAborted(signal);
  const exe = (deps.findExecutable || findExecutable)();
  if (!exe) {
    throw new Error(
      "未找到本机浏览器（Chrome/Edge）。请安装 Chrome，或用环境变量 LOCAL_BROWSER_PATH 指定浏览器可执行文件路径。",
    );
  }

  const port = await (deps.freePort || freePort)(signal);
  throwIfAborted(signal);
  // 一次性临时 user-data-dir，stop 时整目录删除（ephemeral，不长期保留 profile）。
  const userDataDir = (deps.createProfileDir || (() => fs.mkdtempSync(path.join(os.tmpdir(), "am-local-"))))();

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

  // 保留有界面浏览器及任务栏入口；CDP 接管后会再次确认最小化并处理新弹窗。
  if (opts.background === true) args.unshift("--start-minimized");

  // 代理（规划中）：若调用方传入 proxy，则透传给浏览器自身的 --proxy-server。
  // 这样代理由浏览器进程处理，后续用户只需把代理数据「导入」到这里即可，无需对接 AdsPower 代理池。
  if (opts.proxy) {
    args.unshift(`--proxy-server=${String(opts.proxy)}`);
  }

  const cleanupDir = () => (deps.cleanupDir || cleanupTempDir)(userDataDir);
  let child;
  try { child = (deps.spawn || spawn)(exe, args, { stdio: "ignore", windowsHide: false }); }
  catch (error) { cleanupDir(); throw error; }
  const stopProcess = createProcessStop(child, cleanupDir, deps);
  const readiness = new AbortController();
  let launchError = null;
  const onChildError = (error) => { launchError = error; readiness.abort(); };
  const onChildExit = () => { launchError = new Error("临时浏览器在调试端口就绪前已退出"); readiness.abort(); };
  child.once("error", onChildError);
  child.once("exit", onChildExit);
  const onAbort = () => {
    readiness.abort();
    // 启动期/返回句柄之后都可中止；引擎同时调用 stop 时会加入同一个关闭 Promise。
    void stop().catch(() => { /* 调用方的 start/stop 会读取并报告关闭失败 */ });
  };
  let stoppingResult = null;
  const stop = () => {
    if (stoppingResult) return stoppingResult;
    stoppingResult = stopProcess().then((result) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      return result;
    }).finally(() => { stoppingResult = null; });
    return stoppingResult;
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  if (signal && signal.aborted) onAbort();
  const handle = {
    cdpEndpoint: `http://127.0.0.1:${port}`,
    port,
    pid: child.pid,
    userDataDir,
    executablePath: exe,
    stop,
  };
  try {
    const version = await (deps.waitForDevtools || waitForDevtools)(port, 30000, readiness.signal);
    throwIfAborted(signal);
    if (launchError) throw launchError;
    if (!version) throw new Error(`本机浏览器启动后调试端口 ${port} 未就绪（30s 超时）。可执行文件：${exe}`);
    return handle;
  } catch (error) {
    readiness.abort();
    try { await stop(); } catch (cleanupError) {
      const failure = new Error(`浏览器启动已停止，但关闭/清理尚未成功：${cleanupError.message}`);
      failure.cleanupFailed = true;
      failure.local = handle;
      throw failure;
    }
    if (signal && signal.aborted) throw abortError();
    throw launchError || error;
  } finally {
    child.removeListener("error", onChildError);
    child.removeListener("exit", onChildExit);
  }
}

module.exports = {
  start,
  findExecutable,
  helpers: { isDevtoolsReady, waitForDevtools, probeDevtools, freePort, sleep, abortError, throwIfAborted, createProcessStop, killWindowsTree, cleanupTempDir },
};
