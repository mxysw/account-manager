"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const local = require("../src/automation/local-browser");
const browser = require("../src/automation/browser");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("fixture wait timeout");
    await tick();
  }
}
async function timely(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture cancellation timeout")), 500); })]);
  } finally { clearTimeout(timer); }
}
function childFixture() {
  const child = new EventEmitter();
  child.pid = 31337;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

module.exports = async function runLocalCancellationTests({ checkAsync }) {
  await checkAsync("本机停止：taskkill 非零但本次 child 随后确认退出，关闭与清理成功", async () => {
    const child = childFixture();
    let kills = 0;
    let cleanups = 0;
    const stop = local.helpers.createProcessStop(child, () => { cleanups += 1; }, {
      platform: "win32", exitTimeoutMs: 200,
      killWindowsTree: async (pid) => {
        assert.strictEqual(pid, child.pid);
        kills += 1;
        setImmediate(() => child.emit("exit", 0));
        throw new Error("taskkill exit 255: child already gone");
      },
    });
    const first = stop();
    assert.strictEqual(stop(), first, "并发关闭必须加入同一 Promise");
    assert.deepStrictEqual(await first, { ok: true });
    assert.deepStrictEqual(await stop(), { ok: true });
    assert.strictEqual(kills, 1);
    assert.strictEqual(cleanups, 1);
  });

  await checkAsync("本机停止：不能只凭 taskkill 128 忽略失败，未退出必须保留并允许重试", async () => {
    const child = childFixture();
    let cleanups = 0;
    let kills = 0;
    const stop = local.helpers.createProcessStop(child, () => { cleanups += 1; }, {
      platform: "win32", exitTimeoutMs: 5,
      killWindowsTree: async () => { kills += 1; throw new Error("taskkill exit 128"); },
    });
    await assert.rejects(stop(), /taskkill exit 128/);
    assert.strictEqual(cleanups, 0);
    child.emit("exit", 0);
    assert.deepStrictEqual(await stop(), { ok: true });
    assert.strictEqual(kills, 1);
    assert.strictEqual(cleanups, 1);
  });

  await checkAsync("本机启动：已取消不创建任何进程/目录，启动中取消关闭本次专有进程", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(local.start({ signal: aborted.signal }, { findExecutable: () => { throw new Error("不应查找浏览器"); } }), { name: "AbortError" });
    const child = childFixture();
    const controller = new AbortController();
    let probes = 0;
    let cleanups = 0;
    let kills = 0;
    const starting = local.start({ signal: controller.signal }, {
      findExecutable: () => "fixture-browser.exe", freePort: async () => 31337,
      createProfileDir: () => "fixture-only-profile", cleanupDir: () => { cleanups += 1; },
      spawn: () => child, platform: "win32", exitTimeoutMs: 50,
      killWindowsTree: async () => { kills += 1; child.emit("exit", 0); },
      waitForDevtools: (_port, _ms, signal) => { probes += 1; return local.helpers.sleep(30000, signal); },
    });
    await until(() => probes === 1);
    controller.abort();
    await assert.rejects(timely(starting), { name: "AbortError" });
    assert.strictEqual(kills, 1);
    assert.strictEqual(cleanups, 1);
  });

  await checkAsync("本机会话关闭：page.close 永久卡住也会及时断连并返回失败信息", async () => {
    let disconnects = 0;
    const close = browser.helpers.createSessionClose({ close: () => new Promise(() => {}) }, { disconnect: () => { disconnects += 1; } });
    const first = close({ timeoutMs: 5 });
    assert.strictEqual(close(), first);
    const result = await timely(first);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /关闭标签页.*超时/);
    assert.strictEqual(disconnects, 1);
  });

  await checkAsync("CDP 接管取消：puppeteer.connect 永久挂起仍及时返回 AbortError", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const connecting = browser.connect("http://127.0.0.1:31337", { signal: controller.signal }, {
      puppeteer: { connect: () => { attempts += 1; return new Promise(() => {}); } },
    });
    await until(() => attempts === 1);
    controller.abort();
    await assert.rejects(timely(connecting), { name: "AbortError" });
  });

  await checkAsync("CDP 接管取消：迟到的 browser 必须断开，不得创建页面", async () => {
    const controller = new AbortController();
    const pending = deferred();
    let attempts = 0;
    let disconnects = 0;
    let pages = 0;
    const connecting = browser.connect("http://127.0.0.1:31337", { signal: controller.signal }, {
      puppeteer: { connect: () => { attempts += 1; return pending.promise; } },
    });
    await until(() => attempts === 1);
    controller.abort();
    await assert.rejects(timely(connecting), { name: "AbortError" });
    pending.resolve({ disconnect: () => { disconnects += 1; }, newPage: () => { pages += 1; } });
    await until(() => disconnects === 1);
    assert.strictEqual(pages, 0);
  });

  await checkAsync("CDP 接管取消：newPage 挂起立即断开 browser，迟到页面只关闭自身", async () => {
    const controller = new AbortController();
    const pending = deferred();
    let attempts = 0;
    let disconnects = 0;
    let closes = 0;
    const fakeBrowser = { newPage: () => { attempts += 1; return pending.promise; }, disconnect: () => { disconnects += 1; } };
    const connecting = browser.connect("http://127.0.0.1:31337", { signal: controller.signal }, { puppeteer: { connect: async () => fakeBrowser } });
    await until(() => attempts === 1);
    controller.abort();
    await assert.rejects(timely(connecting), { name: "AbortError" });
    await until(() => disconnects === 1);
    pending.resolve({ close: () => { closes += 1; } });
    await until(() => closes === 1);
    assert.strictEqual(disconnects, 1);
  });

  await checkAsync("CDP 接管取消：初始化挂起也能及时关闭本次 page 和连接", async () => {
    const controller = new AbortController();
    let initialized = false;
    let disconnects = 0;
    let closes = 0;
    const page = { close: () => { closes += 1; } };
    const fakeBrowser = { newPage: async () => page, disconnect: () => { disconnects += 1; } };
    const connecting = browser.connect("http://127.0.0.1:31337", { signal: controller.signal }, {
      puppeteer: { connect: async () => fakeBrowser },
      initPage: () => { initialized = true; return new Promise(() => {}); },
    });
    await until(() => initialized);
    controller.abort();
    await assert.rejects(timely(connecting), { name: "AbortError" });
    await until(() => closes === 1 && disconnects === 1);
  });
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, run) => { await run(); passed += 1; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} 项通过`))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
