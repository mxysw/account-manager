"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Readable } = require("stream");

const engineSource = fs.readFileSync(path.join(__dirname, "../src/automation/engine.js"), "utf8");
const routerSource = fs.readFileSync(path.join(__dirname, "../src/router.js"), "utf8");
const adsSource = fs.readFileSync(path.join(__dirname, "../src/automation/adspower.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(predicate, description, ms = 1500) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待失败：${description}`);
    await tick();
  }
}

// Every dependency is an in-memory fake. Never use live accounts, launch a
// browser or make an AdsPower/CAPTCHA/network request from this suite.
function engineFixture(options = {}) {
  const calls = { start: [], connect: [], adsStart: [], localStop: 0, adsStop: 0, close: 0, disconnect: 0, actions: [], writes: [] };
  const record = { id: "fixture", email: "background-fixture@example.invalid", password: "fixture-window-password", status: {} };
  const locals = [];
  const sessions = [];
  const makeLocal = () => {
    const local = {
      cdpEndpoint: `fixture://background/${locals.length + 1}`,
      port: 10000 + locals.length,
      executablePath: "fixture-browser.exe",
      closed: false,
      stop: async () => { calls.localStop += 1; local.closed = true; },
    };
    locals.push(local);
    return local;
  };
  const makeSession = () => {
    const session = {
      page: {}, browser: {},
      close: async () => { calls.close += 1; },
      disconnect: async () => { calls.disconnect += 1; },
      wipe: async () => ({ ok: true }),
      label: async () => ({ ok: true }),
    };
    sessions.push(session);
    return session;
  };
  const localBrowser = {
    start: async (args) => {
      calls.start.push(args);
      return options.start ? options.start(args, makeLocal, calls) : makeLocal();
    },
  };
  const browser = {
    connect: async (endpoint, args) => {
      calls.connect.push({ endpoint, args });
      return options.connect ? options.connect(endpoint, args, makeSession, calls) : makeSession();
    },
  };
  class AdsPower {
    async start(serial, args) {
      calls.adsStart.push({ serial, args });
      return { cdpEndpoint: `fixture://ads/${serial}` };
    }
    async stop() { calls.adsStop += 1; return { ok: true }; }
    async setProxy() { return { ok: true }; }
    async bindProxyId() { return { ok: true }; }
    async bindRandomProxy() { return { ok: true }; }
    async randomizeFingerprint() { return { ok: true }; }
  }
  const action = {
    run: async (_page, account, context) => {
      calls.actions.push(context);
      return options.action ? options.action(account, context) : { outcome: "ok", detail: {} };
    },
  };
  const dependencies = {
    "./adspower": { AdsPower }, "./browser": browser, "./local-browser": localBrowser,
    "./actions": {
      list: () => [{ id: "login", label: "Fixture login" }],
      get: (id) => id === "login" ? action : null,
      normalizeSelection: (ids) => [...new Set(ids || [])],
      validateSelection: () => "",
    },
    "../accounts": {
      getById: (id) => id === record.id ? record : null,
      update: (id, patch) => {
        assert.strictEqual(id, record.id);
        calls.writes.push(patch);
        Object.assign(record, patch);
        return record;
      },
      flush: async () => {},
      normalizeTotpSecret: (value) => String(value || ""),
      normalizePendingTotpSetup: (value) => value || null,
      normalizeTotpSetup: (value) => value || null,
    },
    "./capsolver": {
      normalizeConfig: (config) => { assert.ok(!config || config.enabled !== true); return null; },
      createSolver: () => { throw new Error("Fixture must not start CAPTCHA services"); },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(engineSource, {
    module, exports: module.exports, console, AbortController, AbortSignal, DOMException, URL,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(Number(ms) || 0, 10), ...args),
    clearTimeout, setImmediate, clearImmediate,
    require: (name) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`禁止真实依赖：${name}`);
      return dependencies[name];
    },
  }, { filename: "background-engine-fixture.js" });
  const engine = module.exports;
  const create = (overrides = {}) => engine.createJob({
    mode: "local", envSerials: [], accountIds: [record.id], actionIds: ["login"],
    maxConcurrent: 1, clearData: false, randomFp: false, keepOpen: false, ...overrides,
  });
  return { engine, create, calls, record, locals, sessions, makeLocal, makeSession };
}

async function finish(f, job) {
  await until(() => job.status === "done", "模拟任务完成");
  return f.engine.publicJob(job);
}

async function cancel(f, job) {
  await f.engine.cancelJob(job.id);
  await until(() => !f.engine.publicJob(job).closing && job.tasks.every((task) => task.status !== "running"), "模拟任务取消收尾");
}

async function requestRun(body) {
  let forwarded;
  const dependencies = {
    fs: {}, path,
    "./accounts": {}, "./cards": {}, "./phones": {}, "./cookies": {},
    "./automation/engine": {
      normalizeActionSelection: (ids) => ids,
      validateActionSelection: () => "",
      createJob: (options) => { forwarded = options; return { id: "fixture-job", background: options.background === true }; },
      publicJob: (job) => job,
    },
    "./automation/adspower": { AdsPower: class {} }, "./automation/ads-cli": {},
    "./automation/time-sync": {}, "./capsolver-settings": { resolveConfig: () => null },
  };
  const module = { exports: {} };
  vm.runInNewContext(routerSource, {
    module, exports: module.exports, __dirname: path.join(__dirname, "../src"), URL,
    require: (name) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`禁止真实依赖：${name}`);
      return dependencies[name];
    },
  }, { filename: "background-router-fixture.js" });
  const req = Readable.from([JSON.stringify({ mode: "local", accountIds: ["fixture"], actionIds: ["login"], ...body })]);
  req.url = "/api/automation/run";
  req.method = "POST";
  req.headers = { host: "127.0.0.1:8910" };
  const response = {};
  await module.exports.handle(req, {
    writeHead: (status) => { response.status = status; },
    end: (text) => { response.body = JSON.parse(text); },
  });
  return { forwarded, response };
}

module.exports = async function runBackgroundEngineTests({ checkAsync }) {
  await checkAsync("后台运行：默认关闭且只接受布尔 true，本机启动和接管一致", async () => {
    for (const value of [undefined, false, "false", "true", 1, null, true]) {
      const f = engineFixture();
      const job = f.create(value === undefined ? {} : { background: value });
      const state = await finish(f, job);
      const expected = value === true;
      assert.strictEqual(job.background, expected);
      assert.strictEqual(state.background, expected);
      assert.strictEqual(f.calls.start.length, 1);
      assert.strictEqual(f.calls.connect.length, 1);
      assert.strictEqual(f.calls.start[0].background, expected);
      assert.strictEqual(f.calls.connect[0].args.background, expected);
      assert.strictEqual(f.calls.actions.length, 1);
      assert.strictEqual(f.locals[0].closed, true);
    }
  });

  await checkAsync("后台运行：本机接管重试与重启仍传递后台选项和警告回调", async () => {
    const f = engineFixture();
    const starts = [];
    const connects = [];
    const warning = () => {};
    const controller = new AbortController();
    const opened = await f.engine.helpers.openLocalSession({
      background: true, signal: controller.signal, onBackgroundWarning: warning,
    }, {
      launchAttempts: 2, connectAttempts: 2, sleep: async () => {},
      start: async (args) => { starts.push(args); return f.makeLocal(); },
      connect: async (_endpoint, args) => {
        connects.push(args);
        if (connects.length <= 3) throw new Error("fixture CDP not ready");
        return f.makeSession();
      },
    });
    assert.strictEqual(starts.length, 2);
    assert.strictEqual(connects.length, 4);
    assert.ok(starts.every((args) => args.background === true && args.signal === controller.signal));
    assert.ok(connects.every((args) => args.background === true && args.signal === controller.signal));
    assert.ok(connects.every((args) => args.onBackgroundWarning === warning));
    assert.strictEqual(f.locals[0].closed, true, "重启前仍须关闭原模拟进程");
    assert.strictEqual(opened.local, f.locals[1]);
    await opened.local.stop();
  });

  await checkAsync("后台运行：AdsPower 启动与浏览器接管接收同一个严格布尔配置", async () => {
    for (const background of [false, true]) {
      const f = engineFixture();
      const job = f.create({ mode: "adspower", envSerials: ["fixture-env"], background });
      const state = await finish(f, job);
      assert.strictEqual(state.background, background);
      assert.strictEqual(f.calls.adsStart.length, 1);
      assert.strictEqual(f.calls.adsStart[0].args.background, background);
      assert.strictEqual(f.calls.connect[0].args.background, background);
      assert.strictEqual(f.calls.start.length, 0);
      assert.strictEqual(f.calls.localStop, 0);
      assert.ok(f.calls.adsStop >= 2);
    }
  });

  await checkAsync("后台运行：后台选项不改变跑完保留窗口设置", async () => {
    for (const keepOpen of [false, true]) {
      const f = engineFixture();
      const job = f.create({ background: true, keepOpen });
      const state = await finish(f, job);
      assert.strictEqual(state.keepOpenSelected, keepOpen);
      assert.strictEqual(job.envs[0].retained, keepOpen);
      assert.strictEqual(f.locals[0].closed, !keepOpen);
      if (keepOpen) {
        assert.strictEqual(f.calls.disconnect, 1);
        await cancel(f, job);
        assert.strictEqual(f.locals[0].closed, true);
      }
    }
  });

  await checkAsync("后台运行：人工验证关闭或保留策略仍独立生效", async () => {
    for (const manualChallengePolicy of ["close", "keep"]) {
      const f = engineFixture({ action: async () => ({
        outcome: "need_verify", reasonCode: "fixture_manual", keepOpen: true, handoff: true,
        detail: { login: "fixture manual verification" },
      }) });
      const job = f.create({ background: true, manualChallengePolicy });
      await finish(f, job);
      const retained = manualChallengePolicy === "keep";
      assert.strictEqual(job.envs[0].retained, retained);
      assert.strictEqual(f.locals[0].closed, !retained);
      assert.strictEqual(job.tasks[0].results[0].outcome, "need_verify");
      if (retained) await cancel(f, job);
    }
  });

  await checkAsync("后台运行：运行中停止仍可取消动作并关闭对应窗口", async () => {
    const f = engineFixture({ action: () => new Promise(() => {}) });
    const job = f.create({ background: true, keepOpen: true });
    await until(() => f.calls.actions.length === 1, "后台模拟动作开始");
    await cancel(f, job);
    assert.strictEqual(job.status, "cancelled");
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(job.envs[0].retained, false);
    assert.strictEqual(f.calls.writes.length, 0);
  });

  await checkAsync("后台运行：最小化失败公开安全警告但不伪造账号检测失败", async () => {
    const f = engineFixture({ connect: async (_endpoint, args, makeSession) => {
      assert.strictEqual(typeof args.onBackgroundWarning, "function");
      args.onBackgroundWarning("无法最小化 fixture-window-password https://example.invalid/page?private=fixture-query JBSWY3DPEHPK3PXP");
      args.onBackgroundWarning("fixture repeated warning");
      return makeSession();
    } });
    const job = f.create({ background: true });
    const state = await finish(f, job);
    assert.ok(state.tasks[0].windowWarning, "前端轮询必须取得最小化警告");
    assert.strictEqual(state.tasks[0].error, null);
    assert.strictEqual(state.tasks[0].results[0].outcome, "ok");
    assert.ok(job.tasks[0].events.some((event) => event.type === "background_window_warning"));
    assert.strictEqual(job.tasks[0].events.filter((event) => event.type === "background_window_warning").length, 1);
    const visible = JSON.stringify({ warning: state.tasks[0].windowWarning, events: job.tasks[0].events });
    for (const secret of ["fixture-window-password", "fixture-query", "JBSWY3DPEHPK3PXP"]) {
      assert.ok(!visible.includes(secret), `警告不应泄露 ${secret}`);
    }
  });

  await checkAsync("后台运行：前台模式不得记录后台告警，正常结束后忽略迟到告警", async () => {
    for (const background of [false, true]) {
      let warn;
      const f = engineFixture({ connect: async (_endpoint, args, makeSession) => {
        warn = args.onBackgroundWarning;
        if (!background && typeof warn === "function") warn("fixture unexpected foreground warning");
        return makeSession();
      } });
      const job = f.create({ background });
      const state = await finish(f, job);
      assert.strictEqual(state.tasks[0].windowWarning, "");
      const before = JSON.stringify({ state, events: job.tasks[0].events });
      if (typeof warn === "function") warn("fixture warning after completion");
      await tick();
      assert.strictEqual(JSON.stringify({ state: f.engine.publicJob(job), events: job.tasks[0].events }), before);
    }
  });

  await checkAsync("后台运行：取消后的迟到窗口警告不能更改任务", async () => {
    let warn;
    const f = engineFixture({
      connect: async (_endpoint, args, makeSession) => { warn = args.onBackgroundWarning; return makeSession(); },
      action: () => new Promise(() => {}),
    });
    const job = f.create({ background: true });
    await until(() => f.calls.actions.length === 1, "模拟动作运行中");
    assert.strictEqual(typeof warn, "function");
    await cancel(f, job);
    const before = JSON.stringify({ state: f.engine.publicJob(job), events: job.tasks[0].events });
    warn("fixture late warning");
    await tick();
    assert.strictEqual(JSON.stringify({ state: f.engine.publicJob(job), events: job.tasks[0].events }), before);
  });

  await checkAsync("后台运行：AdsPower 不覆盖环境 launch_args，不切换 headless 或影响清缓存", async () => {
    const module = { exports: {} };
    vm.runInNewContext(adsSource, {
      module, exports: module.exports, URL,
      require: (name) => {
        assert.strictEqual(name, "http");
        return { request: () => { throw new Error("禁止真实 AdsPower HTTP 请求"); } };
      },
    }, { filename: "background-adspower-fixture.js" });
    for (const background of [undefined, false, "true", true]) {
      const ads = new module.exports.AdsPower();
      let request;
      ads._request = async (method, pathname, query) => {
        request = { method, pathname, query };
        return { code: 0, data: { ws: { selenium: "127.0.0.1:12345" } } };
      };
      const result = await ads.start("fixture-serial", { background, clearCache: true });
      assert.strictEqual(request.method, "GET");
      assert.strictEqual(request.pathname, "/api/v1/browser/start");
      assert.strictEqual(request.query.clear_cache_after_closing, 1);
      assert.strictEqual(request.query.serial_number, "fixture-serial");
      assert.strictEqual(result.cdpEndpoint, "http://127.0.0.1:12345");
      assert.ok(!Object.hasOwn(request.query, "launch_args"), "后台模式依赖接管后的 CDP 最小化，不得覆盖环境原有启动参数");
      assert.ok(!JSON.stringify(request.query).includes("headless"));
    }
  });

  await checkAsync("后台运行：运行接口传递选项但不混淆保留窗口与人工处理策略", async () => {
    for (const background of [undefined, false, "true", true]) {
      const body = { keepOpen: true, manualChallengePolicy: "keep", clearData: false };
      if (background !== undefined) body.background = background;
      const { forwarded, response } = await requestRun(body);
      assert.strictEqual(response.status, 202);
      assert.strictEqual(forwarded.background, background);
      assert.strictEqual(forwarded.keepOpen, true);
      assert.strictEqual(forwarded.manualChallengePolicy, "keep");
      assert.strictEqual(forwarded.clearData, false);
      assert.strictEqual(response.body.job.background, background === true);
    }
  });
};

if (require.main === module) {
  let passed = 0;
  const checkAsync = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); };
  module.exports({ checkAsync }).then(() => {
    console.log(`${passed} 项通过`);
  }).catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
