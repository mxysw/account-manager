"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const browserModule = require("../src/automation/browser");
const local = require("../src/automation/local-browser");
const { createBackgroundWindowController, BACKGROUND_WARNING } = require("../src/automation/background-window");

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not settle");
    await tick();
  }
}
async function timely(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("fixture timed out")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

function targetFixture(windowId, options = {}) {
  const calls = [];
  let detached = 0;
  let attached = 0;
  const client = {
    async send(method, params) {
      calls.push([method, params]);
      if (options.send) return options.send(method, params);
      if (method === "Browser.getWindowForTarget") return { windowId };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "minimized" } };
      return {};
    },
    async detach() { detached += 1; },
  };
  const target = {
    type: () => options.type || "page",
    async createCDPSession() { attached += 1; return options.create ? options.create(client) : client; },
  };
  return { target, client, calls, get detached() { return detached; }, get attached() { return attached; } };
}

function browserFixture(options = {}) {
  const browser = new EventEmitter();
  const pages = [];
  let fronts = 0;
  let disconnects = 0;
  let closes = 0;
  browser.newPage = async () => {
    const fixture = targetFixture(100 + pages.length, options.unsupported ? {
      send: () => { throw new Error("fixture unsupported"); },
    } : {});
    const page = new EventEmitter();
    page.target = () => fixture.target;
    page.close = async () => { closes += 1; };
    page.setContent = async () => {};
    page.evaluate = async () => {};
    page.bringToFront = async () => { fronts += 1; };
    fixture.target.page = async () => page;
    pages.push({ page, ...fixture, fixture });
    browser.emit("targetcreated", fixture.target);
    return page;
  };
  browser.disconnect = async () => { disconnects += 1; browser.emit("disconnected"); };
  return {
    browser, pages, deps: { puppeteer: { connect: async () => browser }, initPage: async () => {} },
    get fronts() { return fronts; }, get disconnects() { return disconnects; }, get closes() { return closes; },
  };
}

module.exports = async function runBackgroundBrowserTests({ checkAsync }) {
  await checkAsync("后台浏览器：本机仅 background=true 最小化启动，仍保留有界面及任务栏", async () => {
    for (const value of [undefined, false, "true", 1, true]) {
      const child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = 0;
      let launch;
      let cleaned = 0;
      const handle = await local.start({ background: value }, {
        findExecutable: () => "fixture-chrome.exe", freePort: async () => 31337,
        createProfileDir: () => "fixture-profile", cleanupDir: () => { cleaned += 1; },
        spawn: (exe, args, opts) => { launch = { exe, args, opts }; return child; },
        waitForDevtools: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:31337/devtools/browser/fixture" }),
      });
      assert.strictEqual(launch.args.includes("--start-minimized"), value === true);
      assert.strictEqual(launch.opts.windowsHide, false);
      assert.strictEqual(launch.args.some((arg) => /headless|hide-scrollbars/i.test(arg)), false);
      for (const arg of ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"]) {
        assert.ok(launch.args.includes(arg), "不改变已有反节流设置");
      }
      await handle.stop();
      assert.strictEqual(cleaned, 1);
    }
  });

  await checkAsync("后台浏览器：仅最小化本次 CDP target 的窗口，不枚举其他窗口", async () => {
    const browser = new EventEmitter();
    browser.targets = () => { throw new Error("不得枚举现有窗口"); };
    const fixture = targetFixture(731);
    const control = createBackgroundWindowController(browser);
    assert.strictEqual(await control.minimize(fixture.target), true);
    assert.deepStrictEqual(fixture.calls, [
      ["Browser.getWindowForTarget", undefined],
      ["Browser.setWindowBounds", { windowId: 731, bounds: { windowState: "minimized" } }],
      ["Browser.getWindowBounds", { windowId: 731 }],
    ]);
    await until(() => fixture.detached === 1);
    control.dispose();
    assert.strictEqual(browser.listenerCount("targetcreated"), 0);
    assert.strictEqual(browser.listenerCount("targetchanged"), 0);
    assert.strictEqual(browser.listenerCount("disconnected"), 0);
  });

  await checkAsync("后台浏览器：自动覆盖新页面和弹出窗口，跳过 worker", async () => {
    const browser = new EventEmitter();
    const control = createBackgroundWindowController(browser);
    const popup = targetFixture(912);
    const worker = targetFixture(913, { type: "service_worker" });
    browser.emit("targetcreated", worker.target);
    browser.emit("targetcreated", popup.target);
    await until(() => popup.detached === 1);
    assert.strictEqual(worker.attached, 0);
    assert.deepStrictEqual(popup.calls[1][1], { windowId: 912, bounds: { windowState: "minimized" } });
    browser.emit("targetchanged", popup.target);
    await until(() => popup.detached === 2);
    control.dispose();
  });

  await checkAsync("后台浏览器：不支持窗口控制时只报告一次固定安全警告", async () => {
    const browser = new EventEmitter();
    const warnings = [];
    const control = createBackgroundWindowController(browser, { onWarning: (message) => warnings.push(message) });
    const fixture = targetFixture(731, { send: () => { throw new Error("fixture private endpoint"); } });
    assert.strictEqual(await control.minimize(fixture.target), false);
    assert.strictEqual(await control.minimize(fixture.target), false);
    await tick();
    assert.deepStrictEqual(warnings, [BACKGROUND_WARNING]);
    assert.doesNotMatch(warnings[0], /private|endpoint/);
    control.dispose();
  });

  await checkAsync("后台浏览器：设置命令成功但实际窗口没有最小化时必须告警", async () => {
    const browser = new EventEmitter();
    const warnings = [];
    const control = createBackgroundWindowController(browser, { onWarning: (message) => warnings.push(message) });
    const fixture = targetFixture(731, { send: (method) => {
      if (method === "Browser.getWindowForTarget") return { windowId: 731 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
      return {};
    } });
    assert.strictEqual(await control.minimize(fixture.target), false);
    await tick();
    assert.deepStrictEqual(warnings, [BACKGROUND_WARNING]);
    control.dispose();
  });

  await checkAsync("后台浏览器：CDP 命令挂起有超时上界，失败仍回收临时 session", async () => {
    const browser = new EventEmitter();
    const warnings = [];
    const control = createBackgroundWindowController(browser, { timeoutMs: 5, onWarning: (message) => warnings.push(message) });
    const fixture = targetFixture(731, { send: () => new Promise(() => {}) });
    assert.strictEqual(await timely(control.minimize(fixture.target)), false);
    await until(() => fixture.detached === 1 && warnings.length === 1);
    control.dispose();
  });

  await checkAsync("后台浏览器：迟到 CDP session 在超时后仍回收且不再发送最小化命令", async () => {
    const browser = new EventEmitter();
    let resolveClient;
    const fixture = targetFixture(731, { create: () => new Promise((resolve) => { resolveClient = resolve; }) });
    const control = createBackgroundWindowController(browser, { timeoutMs: 5 });
    assert.strictEqual(await timely(control.minimize(fixture.target)), false);
    control.dispose();
    resolveClient(fixture.client);
    await until(() => fixture.detached === 1);
    assert.deepStrictEqual(fixture.calls, []);
  });

  await checkAsync("后台浏览器：取消立即终止挂起控制、去除监听，且不误报失败", async () => {
    const browser = new EventEmitter();
    const abort = new AbortController();
    const warnings = [];
    const control = createBackgroundWindowController(browser, { signal: abort.signal, onWarning: (message) => warnings.push(message) });
    const fixture = targetFixture(731, { send: () => new Promise(() => {}) });
    const minimizing = control.minimize(fixture.target);
    await until(() => fixture.calls.length === 1);
    abort.abort();
    assert.strictEqual(await timely(minimizing), false);
    await until(() => fixture.detached === 1);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(browser.listenerCount("targetcreated"), 0);
    assert.strictEqual(browser.listenerCount("disconnected"), 0);
  });

  await checkAsync("后台浏览器：连接断开后不再最小化，用户可自行恢复保留窗口", async () => {
    const browser = new EventEmitter();
    const control = createBackgroundWindowController(browser);
    browser.emit("disconnected");
    const restored = targetFixture(731);
    browser.emit("targetcreated", restored.target);
    assert.strictEqual(await control.minimize(restored.target), false);
    assert.strictEqual(restored.attached, 0);
    assert.strictEqual(browser.listenerCount("targetcreated"), 0);
  });

  await checkAsync("后台浏览器：接管主页面并最小化，标识页不主动抢占前台", async () => {
    const fixture = browserFixture();
    const session = await browserModule.connect("http://127.0.0.1:31337", { background: true }, fixture.deps);
    assert.ok(fixture.pages[0].calls.some(([method]) => method === "Browser.setWindowBounds"));
    assert.strictEqual((await session.label({ email: "fixture@example.com" })).ok, true);
    assert.strictEqual(fixture.fronts, 0);
    assert.ok(fixture.pages[1].calls.some(([method]) => method === "Browser.setWindowBounds"));
    await session.disconnect();
    assert.strictEqual(fixture.closes, 0, "保留窗口断连不关页");
    assert.strictEqual(fixture.browser.listenerCount("targetcreated"), 0);
    assert.strictEqual(fixture.browser.listenerCount("disconnected"), 0);
  });

  await checkAsync("后台浏览器：未勾选和非布尔 true 保持原有前台行为", async () => {
    for (const value of [undefined, false, "true"]) {
      const fixture = browserFixture();
      const session = await browserModule.connect("http://127.0.0.1:31337", { background: value }, fixture.deps);
      await session.label({ email: "fixture@example.com" });
      assert.strictEqual(fixture.fronts, 1);
      assert.strictEqual(fixture.pages.flatMap((page) => page.calls).some(([method]) => method.startsWith("Browser.")), false);
      await session.close();
      assert.strictEqual(fixture.closes, 1);
      assert.strictEqual(fixture.disconnects, 1);
      assert.strictEqual(fixture.browser.listenerCount("targetcreated"), 0);
    }
  });

  await checkAsync("后台浏览器：最小化失败不阻止接管，回调异常不会中断任务", async () => {
    const fixture = browserFixture({ unsupported: true });
    let warned = 0;
    const session = await browserModule.connect("http://127.0.0.1:31337", {
      background: true, onBackgroundWarning: () => { warned += 1; throw new Error("fixture callback error"); },
    }, fixture.deps);
    await tick();
    assert.strictEqual(warned, 1);
    assert.ok(session.page);
    await session.close();
  });

  await checkAsync("后台浏览器：已接管会话取消会清理所有新增监听", async () => {
    const fixture = browserFixture();
    const abort = new AbortController();
    const session = await browserModule.connect("http://127.0.0.1:31337", { background: true, signal: abort.signal }, fixture.deps);
    abort.abort();
    assert.strictEqual(fixture.browser.listenerCount("targetcreated"), 0);
    assert.strictEqual(fixture.browser.listenerCount("disconnected"), 0);
    await session.close();
  });
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, run) => { await run(); passed += 1; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} 项后台浏览器测试通过`))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
