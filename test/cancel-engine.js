"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load the production engine into a fresh VM for each test. Every dependency is
// an in-memory fake: no live account database, browser process, AdsPower or CDP.
const SOURCE = fs.readFileSync(path.join(__dirname, "../src/automation/engine.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, description, limit = 1000) {
  const end = Date.now() + limit;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`等待失败：${description}`);
    await tick();
  }
}
async function bounded(promise, description, ms = 1200) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`操作未及时结束：${description}`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function cancelSettled(f, job) {
  await until(() => {
    const state = f.engine.publicJob(job);
    return state.closing !== true && job.tasks.every((task) => task.status !== "running");
  }, "取消清理结束且任务不再运行");
}

function engineFixture(options = {}) {
  const calls = { starts: 0, connects: 0, localStops: 0, adsStarts: 0, adsStops: 0, adsProxyChanges: 0,
    closes: 0, disconnects: 0, wipes: 0, labels: 0, actions: [], writes: [] };
  const records = new Map(["first", "second"].map((id) => [id, {
    id, email: `${id}@cancel-fixture.example`, password: "fixture-only-password", status: { login: "unknown" },
  }]));
  const locals = [];
  const sessions = [];
  const makeLocal = () => {
    const local = {
      cdpEndpoint: `fixture://local/${locals.length + 1}`, port: 10000 + locals.length,
      executablePath: "fixture-browser.exe", closed: false,
      stop: async () => {
        calls.localStops += 1;
        if (options.localStop) await options.localStop(local, calls);
        local.closed = true;
      },
    };
    locals.push(local);
    return local;
  };
  const makeSession = () => {
    const session = {
      page: {}, browser: {},
      wipe: async () => { calls.wipes += 1; return options.wipe ? options.wipe(session) : { ok: true }; },
      close: async () => { calls.closes += 1; if (options.sessionClose) await options.sessionClose(session); },
      disconnect: async () => { calls.disconnects += 1; if (options.disconnect) await options.disconnect(session); },
      label: async () => { calls.labels += 1; return { ok: true }; },
    };
    sessions.push(session);
    return session;
  };
  const localBrowser = {
    start: async (args) => {
      calls.starts += 1;
      return options.start ? options.start(args, makeLocal, calls) : makeLocal();
    },
  };
  const browser = {
    connect: async (endpoint, args) => {
      calls.connects += 1;
      return options.connect ? options.connect(endpoint, makeSession, calls, args) : makeSession();
    },
  };
  class AdsPower {
    async start(serial) {
      calls.adsStarts += 1;
      return options.adsStart ? options.adsStart(serial, calls) : { cdpEndpoint: `fixture://ads/${serial}` };
    }
    async stop(serial) {
      calls.adsStops += 1;
      if (options.adsStop) return options.adsStop(serial, calls);
      return { ok: true };
    }
    async setProxy(serial, proxy) {
      calls.adsProxyChanges += 1;
      return options.adsSetProxy ? options.adsSetProxy(serial, proxy, calls) : { ok: true };
    }
    async bindProxyId() { return { ok: true }; }
    async bindRandomProxy() { return { ok: true }; }
    async randomizeFingerprint() { return { ok: true }; }
  }
  const store = {
    getById: (id) => records.get(id) || null,
    update: (id, patch) => {
      const record = records.get(id);
      if (!record) return null;
      calls.writes.push({ id, patch: JSON.parse(JSON.stringify(patch)) });
      const status = { ...record.status, ...(patch.status || {}) };
      Object.assign(record, patch, { status });
      return record;
    },
    flush: async () => { if (options.flush) await options.flush(calls); },
    normalizeTotpSecret: (value) => String(value || ""),
    normalizePendingTotpSetup: (value) => value || null,
    normalizeTotpSetup: (value) => value || null,
  };
  const actionMap = new Map(["login", "after", "add-2fa"].map((id) => [id, {
    run: async (page, account, context) => {
      calls.actions.push({ id, accountId: account.id, context });
      return options.action ? options.action(id, page, account, context, calls) : { outcome: "ok", detail: {} };
    },
  }]));
  const actionRegistry = {
    list: () => [...actionMap.keys()].map((id) => ({ id, label: id })),
    get: (id) => actionMap.get(id),
    normalizeSelection: (ids) => [...new Set(ids || [])],
    validateSelection: () => "",
  };
  const capsolver = options.capsolver || {
    normalizeConfig: (config) => {
      assert.ok(!config || config.enabled !== true, "Enabled CAPSOLVER requires an explicit in-memory fixture");
      return null;
    },
    createSolver: () => { throw new Error("Fixture must never create a real CAPSOLVER client"); },
  };
  const dependencies = { "./adspower": { AdsPower }, "./browser": browser,
    "./local-browser": localBrowser, "./actions": actionRegistry, "../accounts": store, "./capsolver": capsolver };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console, AbortController, AbortSignal, DOMException, URL,
    // Keep production timeout/cancellation paths, shortening only their clock.
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(Number(ms) || 0, 10), ...args),
    clearTimeout, setImmediate, clearImmediate,
    require: (name) => {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`测试禁止访问真实依赖 ${name}`);
      return dependencies[name];
    },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "cancel-engine-fixture.js" });
  const engine = module.exports;
  const create = (overrides = {}) => engine.createJob({
    mode: "local", envSerials: [], accountIds: ["first"], actionIds: ["login"],
    maxConcurrent: 1, clearData: false, randomFp: false, keepOpen: false,
    ...overrides,
  });
  return { engine, create, calls, records, locals, sessions, makeLocal, makeSession };
}

function capsolverFixture({ waitForResult, maxAttemptsPerAccount = 1 } = {}) {
  const key = "fixture-engine-private-capsolver-key";
  const token = "fixture-engine-private-capsolver-token";
  let heldKey = "";
  let attempted = 0;
  let ready = 0;
  const calls = { normalized: [], created: 0, disposed: 0, signal: null, emit: null };
  const capsolver = {
    normalizeConfig: (config, context) => {
      calls.normalized.push(context);
      if (!config || !config.enabled) return null;
      assert.strictEqual(config.apiKey, key);
      return { enabled: true, apiKey: key, maxAttemptsPerAccount };
    },
    createSolver: (config, { signal }) => {
      calls.created += 1;
      calls.signal = signal;
      heldKey = config.apiKey;
      const accountStats = new Map();
      return {
        forAccount: (accountId, { emit }) => {
          if (!accountStats.has(accountId)) accountStats.set(accountId, { attempted: 0, ready: 0, failed: 0 });
          const stats = accountStats.get(accountId);
          return {
            solve: async () => {
              attempted += 1;
              stats.attempted += 1;
              calls.emit = emit;
              emit("capsolver_attempt", { attempt: stats.attempted, maxAttemptsPerAccount });
              emit("capsolver_created", {});
              if (waitForResult) await waitForResult();
              ready += 1;
              stats.ready += 1;
              emit("capsolver_ready", {});
              return { token };
            },
            maxAttemptsPerAccount,
            getAttemptCount: () => stats.attempted,
            summary: () => ({ enabled: true, ...stats, maxAttemptsPerAccount }),
          };
        },
        summary: () => ({ enabled: true, attempted, ready, failed: 0, maxAttemptsPerAccount }),
        dispose: () => { calls.disposed += 1; heldKey = ""; },
      };
    },
  };
  return { capsolver, calls, key, token, hasKey: () => heldKey !== "",
    config: { enabled: true, apiKey: key, maxAttemptsPerAccount } };
}

module.exports = async function runCancelEngineTests({ checkAsync }) {
  await checkAsync("添加 2FA 独占动作：内置登录与再次验证共用账号打码次数，保留检查点与脱敏", async () => {
    const provider = capsolverFixture({ maxAttemptsPerAccount: 3 });
    const secret = "FIXTURE_AUTHENTICATOR_SECRET";
    const f = engineFixture({ capsolver: provider.capsolver, action: async (id, _page, _account, ctx) => {
      assert.strictEqual(id, "add-2fa");
      const initialLoginSolver = ctx.captchaSolver;
      assert.strictEqual(initialLoginSolver.getAttemptCount(), 0);
      assert.strictEqual(initialLoginSolver.maxAttemptsPerAccount, 3);
      await initialLoginSolver.solve({ type: "fixture-initial-login" });
      await ctx.recordLoginResult({ outcome: "ok", statusPatch: { login: "ok" } });
      await ctx.checkpointTotpSetup({ pendingTotpSetup: {
        secret, state: "pending", createdAt: "2026-01-01T00:00:00.000Z",
      } });
      const reauthenticationContext = { ...ctx };
      assert.strictEqual(reauthenticationContext.captchaSolver, initialLoginSolver);
      assert.strictEqual(reauthenticationContext.captchaSolver.getAttemptCount(), 1);
      await reauthenticationContext.captchaSolver.solve({ type: "fixture-reauth" });
      assert.strictEqual(initialLoginSolver.getAttemptCount(), 2);
      ctx.emit("captcha_submitted", { token: provider.token, secret, apiKey: provider.key });
      return { outcome: "ok", detail: { totp: "fixture complete" }, keepOpen: true };
    } });
    const job = f.create({ actionIds: ["add-2fa"], captchaSolver: provider.config,
      accountIds: ["first", "second"], maxConcurrent: 2, manualChallengePolicy: "solve_close", keepOpen: true });
    await until(() => job.status === "done", "两个添加 2FA 独占动作完成");
    assert.deepStrictEqual(Array.from(job.actionIds), ["add-2fa"], "不能插入独立登录动作破坏独占选择");
    assert.deepStrictEqual(Array.from(provider.calls.normalized[0].actionIds), ["add-2fa"]);
    assert.deepStrictEqual(f.calls.actions.map(({ id }) => id), ["add-2fa", "add-2fa"]);
    assert.deepStrictEqual(Array.from(job.tasks, (task) => task.captcha.attempted), [2, 2]);
    assert.strictEqual(f.engine.publicJob(job).captchaSolver.attempted, 4);
    for (const account of f.records.values()) {
      assert.strictEqual(account.status.login, "ok");
      assert.strictEqual(account.pendingTotpSetup.secret, secret);
    }
    assert.ok(f.locals.every(({ closed }) => closed));
    const publicState = JSON.stringify(f.engine.publicJob(job));
    for (const value of [secret, provider.key, provider.token]) assert.ok(!publicState.includes(value));
    assert.strictEqual(provider.hasKey(), false);
  });

  await checkAsync("添加 2FA 独占动作：打码需人工时保留或关闭窗口仍服从用户策略", async () => {
    for (const policy of ["keep", "solve_close"]) {
      const provider = capsolverFixture();
      const f = engineFixture({ capsolver: provider.capsolver, action: async (id, _page, _account, ctx) => {
        assert.strictEqual(id, "add-2fa");
        await ctx.captchaSolver.solve({ type: "fixture-initial-login" });
        return { outcome: "need_verify", reasonCode: "captcha", keepOpen: true, handoff: true,
          detail: { totp: "fixture captcha requires attention" } };
      } });
      const job = f.create({ actionIds: ["add-2fa"], captchaSolver: provider.config,
        manualChallengePolicy: policy, keepOpen: true });
      await until(() => job.status === "done", "添加 2FA 人工验证收尾");
      assert.strictEqual(f.locals[0].closed, policy === "solve_close");
      assert.strictEqual(job.envs[0].retained, policy === "keep");
      assert.strictEqual(provider.hasKey(), false);
      if (policy === "keep") {
        await f.engine.cancelJob(job.id);
        await cancelSettled(f, job);
      }
    }
  });

  await checkAsync("添加 2FA 独占动作：打码等待时取消关闭窗口，迟到结果不能保存登录或密钥", async () => {
    const solved = deferred();
    const provider = capsolverFixture({ waitForResult: () => solved.promise });
    let context;
    const f = engineFixture({ capsolver: provider.capsolver, action: async (_id, _page, _account, ctx) => {
      context = ctx;
      await ctx.captchaSolver.solve({ type: "fixture-initial-login" });
      await ctx.recordLoginResult({ outcome: "ok", statusPatch: { login: "ok" } });
      return { outcome: "ok" };
    } });
    const job = f.create({ actionIds: ["add-2fa"], captchaSolver: provider.config, manualChallengePolicy: "solve_close" });
    await until(() => typeof provider.calls.emit === "function", "添加 2FA 打码正在等待");
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(provider.calls.signal.aborted, true);
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(provider.hasKey(), false);
    const eventsBefore = job.tasks[0].events.length;
    solved.resolve();
    await tick();
    await tick();
    assert.strictEqual(f.calls.writes.length, 0);
    assert.strictEqual(job.tasks[0].events.length, eventsBefore);
    await assert.rejects(context.checkpointTotpSetup({ pendingTotpSetup: {
      secret: "JBSWY3DPEHPK3PXP", state: "pending", createdAt: "2026-01-01T00:00:00.000Z",
    } }), /取消/);
    assert.strictEqual(job.tasks[0].results.length, 0);
  });

  await checkAsync("自动解题后关闭：登录成功继续后续步骤，只向登录提供解题器并覆盖保留窗口选项", async () => {
    for (const [keepOpen, actionKeepOpen] of [[true, false], [false, true], [true, true]]) {
      const provider = capsolverFixture();
      const f = engineFixture({ capsolver: provider.capsolver, action: async (id, _page, _account, ctx) => {
        assert.strictEqual(ctx.manualChallengePolicy, "solve_close");
        if (id === "login") {
          assert.deepStrictEqual(Object.keys(ctx.captchaSolver), ["solve", "maxAttemptsPerAccount", "getAttemptCount", "summary"]);
          assert.deepStrictEqual(await ctx.captchaSolver.solve({ type: "fixture-only" }), { token: provider.token });
        } else {
          assert.strictEqual(id, "after");
          assert.strictEqual(ctx.captchaSolver, null, "后续动作不能取得登录解题器");
        }
        return { outcome: "ok", keepOpen: actionKeepOpen, statusPatch: id === "login" ? { login: "ok" } : {} };
      } });
      const job = f.create({ manualChallengePolicy: "solve_close", captchaSolver: provider.config,
        actionIds: ["login", "after"], keepOpen });
      await until(() => job.status === "done", "自动解题后执行完全部步骤");
      assert.deepStrictEqual(f.calls.actions.map(({ id }) => id), ["login", "after"]);
      assert.deepStrictEqual(Array.from(job.tasks[0].results, ({ action, outcome }) => `${action}:${outcome}`),
        ["login:ok", "after:ok"]);
      assert.strictEqual(f.records.get("first").status.login, "ok");
      assert.strictEqual(f.engine.publicJob(job).manualChallengePolicy, "solve_close");
      assert.deepStrictEqual(Array.from(provider.calls.normalized[0].actionIds), ["login", "after"]);
      assert.strictEqual(f.locals[0].closed, true);
      assert.strictEqual(f.calls.localStops, 1);
      assert.strictEqual(job.envs[0].retained, false);
      assert.ok(job.tasks[0].events.some(({ type }) => type === "env_closed"));
      assert.ok(!job.tasks[0].events.some(({ type }) => type === "env_kept_open"));
      assert.strictEqual(provider.hasKey(), false);
      assert.ok(provider.calls.disposed >= 1);
    }
  });

  await checkAsync("自动解题后关闭：验证码提交后仍未通过会保存失败、跳过后续步骤并关窗", async () => {
    const provider = capsolverFixture();
    const f = engineFixture({ capsolver: provider.capsolver, action: async (id, _page, _account, ctx) => {
      assert.strictEqual(id, "login");
      await ctx.captchaSolver.solve({ type: "fixture-only" });
      ctx.emit("captcha_submitted", { callbackInvoked: true });
      return { outcome: "need_verify", reasonCode: "captcha", keepOpen: true, handoff: true,
        detail: { login: "模拟验证码提交后仍需人工验证" }, statusPatch: { login: "need_verify" } };
    } });
    const job = f.create({ manualChallengePolicy: "solve_close", captchaSolver: provider.config,
      actionIds: ["login", "after"], keepOpen: true });
    await until(() => job.status === "done", "验证码未通过后的收尾完成");
    assert.deepStrictEqual(f.calls.actions.map(({ id }) => id), ["login"]);
    assert.deepStrictEqual(Array.from(job.tasks[0].results, ({ action, outcome }) => `${action}:${outcome}`),
      ["login:need_verify", "after:skipped"]);
    assert.strictEqual(job.tasks[0].results[0].reasonCode, "captcha");
    assert.strictEqual(f.records.get("first").status.login, "need_verify");
    assert.strictEqual(f.engine.publicJob(job).captchaSolver.attempted, 1);
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(job.envs[0].retained, false);
    assert.strictEqual(provider.hasKey(), false);
  });

  await checkAsync("自动解题后关闭：短信等非验证码人工验证不调用解题器且仍会关闭窗口", async () => {
    const provider = capsolverFixture();
    const f = engineFixture({ capsolver: provider.capsolver, action: async (id, _page, _account, ctx) => {
      assert.strictEqual(id, "login");
      assert.strictEqual(typeof ctx.captchaSolver.solve, "function");
      return { outcome: "need_verify", reasonCode: "sms_verification", keepOpen: true, handoff: true,
        detail: { login: "模拟短信人工验证" }, statusPatch: { login: "need_verify" } };
    } });
    const job = f.create({ manualChallengePolicy: "solve_close", captchaSolver: provider.config,
      actionIds: ["login", "after"], keepOpen: true });
    await until(() => job.status === "done", "非验证码人工验证后的收尾完成");
    assert.deepStrictEqual(f.calls.actions.map(({ id }) => id), ["login"]);
    assert.strictEqual(job.tasks[0].results[0].reasonCode, "sms_verification");
    assert.strictEqual(job.tasks[0].results[1].outcome, "skipped");
    assert.strictEqual(f.engine.publicJob(job).captchaSolver.attempted, 0);
    assert.strictEqual(provider.calls.emit, null, "短信验证不能发起 CAPTCHA 任务");
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(job.envs[0].retained, false);
    assert.strictEqual(provider.hasKey(), false);
  });

  await checkAsync("自动解题后关闭：缺少或禁用解题配置会在开窗前报错", async () => {
    for (const captchaSolver of [undefined, { enabled: false }]) {
      const provider = capsolverFixture();
      const f = engineFixture({ capsolver: provider.capsolver });
      assert.throws(() => f.create({ manualChallengePolicy: "solve_close", captchaSolver,
        actionIds: ["login", "after"] }), /CAPSOLVER|解题配置|启用|密钥/);
      assert.strictEqual(provider.calls.created, 0);
      assert.strictEqual(f.calls.starts, 0);
      assert.strictEqual(f.calls.adsStarts, 0);
      assert.strictEqual(f.calls.connects, 0);
      assert.strictEqual(f.calls.actions.length, 0);
    }
  });

  await checkAsync("自动解题后关闭：解题等待中取消会中止任务、释放密钥并关闭窗口", async () => {
    const solved = deferred();
    const provider = capsolverFixture({ waitForResult: () => solved.promise });
    const f = engineFixture({ capsolver: provider.capsolver, action: async (_id, _page, _account, ctx) => {
      await ctx.captchaSolver.solve({ type: "fixture-only" });
      return { outcome: "ok", keepOpen: true, statusPatch: { login: "ok" } };
    } });
    const job = f.create({ manualChallengePolicy: "solve_close", captchaSolver: provider.config,
      actionIds: ["login", "after"], keepOpen: true });
    await until(() => typeof provider.calls.emit === "function", "自动解题请求正在等待");
    await bounded(f.engine.cancelJob(job.id), "取消自动解题请求");
    await cancelSettled(f, job);
    assert.strictEqual(provider.calls.signal.aborted, true);
    assert.strictEqual(provider.hasKey(), false);
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(job.envs[0].retained, false);
    const eventCount = job.tasks[0].events.length;
    solved.resolve();
    await tick();
    await tick();
    assert.strictEqual(job.tasks[0].events.length, eventCount, "取消后的迟到解题结果不能改变任务");
    assert.strictEqual(f.calls.actions.length, 1);
    assert.strictEqual(f.calls.writes.length, 0);
    assert.strictEqual(job.tasks[0].results.length, 0);
    assert.strictEqual(job.status, "cancelled");
  });

  await checkAsync("自动解题后关闭：关窗失败保留可重试句柄，取消可完成关闭", async () => {
    let fail = true;
    const provider = capsolverFixture();
    const f = engineFixture({ capsolver: provider.capsolver,
      localStop: async () => { if (fail) throw new Error("fixture solve-close stop failed"); } });
    const job = f.create({ manualChallengePolicy: "solve_close", captchaSolver: provider.config, keepOpen: true });
    await until(() => job.status === "done", "自动关闭失败后的任务完成");
    assert.strictEqual(f.locals[0].closed, false);
    assert.strictEqual(job.envs[0].local, f.locals[0]);
    assert.ok(f.engine.publicJob(job).closeErrors.length > 0);
    assert.ok(!job.tasks[0].events.some(({ type }) => type === "env_closed"));
    assert.strictEqual(provider.hasKey(), false);
    fail = false;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(job.envs[0].retained, false);
    assert.strictEqual(f.engine.publicJob(job).closeErrors.length, 0);
  });

  await checkAsync("CAPSOLVER 引擎：登录收到独立账号解题器，公开状态不含密钥，完成即释放密钥", async () => {
    const provider = capsolverFixture();
    const f = engineFixture({ capsolver: provider.capsolver, action: async (id, _page, _account, ctx) => {
      assert.strictEqual(id, "login");
      assert.deepStrictEqual(Object.keys(ctx.captchaSolver), ["solve", "maxAttemptsPerAccount", "getAttemptCount", "summary"]);
      ctx.emit("captcha_solving", {});
      assert.deepStrictEqual(await ctx.captchaSolver.solve({ type: "fixture-only" }), { token: provider.token });
      ctx.emit("captcha_submitted", { callbackSource: "observed", callbackInvoked: true, hasDataS: true,
        token: provider.token, apiKey: provider.key, callback: "PRIVATE_CALLBACK", dataS: "PRIVATE_CHALLENGE" });
      return { outcome: "ok", detail: {} };
    } });
    const job = f.create({ captchaSolver: provider.config, keepOpen: true });
    assert.strictEqual(provider.calls.created, 1);
    assert.strictEqual(provider.hasKey(), true);
    assert.strictEqual(provider.calls.signal, job.abortController.signal);
    assert.strictEqual(provider.calls.normalized[0].accountCount, 1);
    assert.deepStrictEqual(Array.from(provider.calls.normalized[0].actionIds), ["login"]);
    await until(() => job.status === "done", "启用 CAPSOLVER 的登录完成");
    const state = f.engine.publicJob(job);
    assert.deepStrictEqual(state.captchaSolver, { enabled: true, attempted: 1, ready: 1, failed: 0, maxAttemptsPerAccount: 1 });
    assert.strictEqual(state.tasks[0].captcha.state, "submitted");
    assert.strictEqual(state.tasks[0].captcha.callbackSource, "observed");
    assert.strictEqual(state.tasks[0].captcha.callbackInvoked, true);
    assert.strictEqual(state.tasks[0].captcha.hasDataS, true);
    assert.strictEqual(state.tasks[0].captcha.ready, 1);
    assert.strictEqual(job.envs[0].retained, true, "保留浏览器窗口也不保留供应商密钥");
    assert.ok(provider.calls.disposed >= 1);
    assert.strictEqual(provider.hasKey(), false);
    const visible = JSON.stringify({ state, events: job.tasks[0].events });
    assert.ok(!visible.includes(provider.key));
    assert.ok(!visible.includes(provider.token));
    assert.ok(!visible.includes("PRIVATE_CALLBACK"));
    assert.ok(!visible.includes("PRIVATE_CHALLENGE"));
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
  });

  await checkAsync("CAPSOLVER 引擎：取消时中止共享信号并释放密钥，迟到事件不改变账号进度", async () => {
    const provider = capsolverFixture({ waitForResult: () => new Promise(() => {}) });
    const f = engineFixture({ capsolver: provider.capsolver, action: async (_id, _page, _account, ctx) => {
      await ctx.captchaSolver.solve({ type: "fixture-only" });
      return { outcome: "ok" };
    } });
    const job = f.create({ captchaSolver: provider.config });
    await until(() => typeof provider.calls.emit === "function", "模拟验证码任务已开始");
    assert.strictEqual(provider.hasKey(), true);
    await f.engine.cancelJob(job.id);
    assert.strictEqual(provider.calls.signal.aborted, true);
    assert.strictEqual(provider.hasKey(), false);
    assert.ok(provider.calls.disposed >= 1);
    await cancelSettled(f, job);
    const before = JSON.stringify(job.tasks[0].captcha);
    const events = job.tasks[0].events.length;
    provider.calls.emit("capsolver_ready", {});
    assert.strictEqual(JSON.stringify(job.tasks[0].captcha), before);
    assert.strictEqual(job.tasks[0].events.length, events);
    assert.strictEqual(f.calls.writes.length, 0);
    assert.ok(!JSON.stringify(f.engine.publicJob(job)).includes(provider.key));
    assert.strictEqual(job.status, "cancelled");
  });

  await checkAsync("CAPSOLVER 引擎：账号重试独立累计，检查与失败日志不虚增调用次数", async () => {
    const provider = capsolverFixture({ maxAttemptsPerAccount: 3 });
    const f = engineFixture({ capsolver: provider.capsolver, action: async (_id, _page, account, ctx) => {
      ctx.emit("captcha_solving", {});
      assert.strictEqual(ctx.captchaSolver.getAttemptCount(), 0);
      const attempts = account.id === "first" ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1) ctx.emit("captcha_retrying", { attempt, maxAttemptsPerAccount: 3 });
        await ctx.captchaSolver.solve({ type: "fixture-only" });
      }
      ctx.emit("captcha_failed", {});
      assert.strictEqual(ctx.captchaSolver.getAttemptCount(), attempts);
      return { outcome: "need_verify", detail: {} };
    } });
    const job = f.create({ captchaSolver: provider.config, accountIds: ["first", "second"], maxConcurrent: 2 });
    await until(() => job.status === "done", "两个独立账号打码完成");
    const state = f.engine.publicJob(job);
    assert.deepStrictEqual(state.captchaSolver, { enabled: true, attempted: 3, ready: 3, failed: 0, maxAttemptsPerAccount: 3 });
    assert.deepStrictEqual(Array.from(state.tasks, (task) => task.captcha.attempted), [2, 1]);
    assert.deepStrictEqual(Array.from(state.tasks, (task) => task.captcha.failed), [0, 0]);
    assert.deepStrictEqual(Array.from(state.tasks, (task) => task.captcha.ready), [2, 1]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(job.tasks[0].events.find(({ type }) => type === "captcha_retrying").data)),
      { attempt: 2, maxAttemptsPerAccount: 3 });
  });

  await checkAsync("CAPSOLVER 引擎：未发起请求就停止，不显示一次调用或一次供应商失败", async () => {
    const provider = capsolverFixture();
    const f = engineFixture({ capsolver: provider.capsolver, action: async (_id, _page, _account, ctx) => {
      ctx.emit("captcha_solving", {});
      ctx.emit("captcha_failed", { code: "CAPSOLVER_ACCOUNT_LIMIT" });
      return { outcome: "need_verify", detail: {} };
    } });
    const job = f.create({ captchaSolver: provider.config });
    await until(() => job.status === "done", "未请求的账号停止");
    const captcha = f.engine.publicJob(job).tasks[0].captcha;
    assert.strictEqual(captcha.attempted, 0);
    assert.strictEqual(captcha.ready, 0);
    assert.strictEqual(captcha.failed, 0);
    assert.strictEqual(captcha.state, "failed");
  });

  await checkAsync("取消任务：动作永不返回也能结束运行并阻止排队账号启动", async () => {
    const f = engineFixture({ action: () => new Promise(() => {}) });
    const job = f.create({ accountIds: ["first", "second"] });
    await until(() => f.calls.actions.length === 1, "第一个动作开始");
    await bounded(f.engine.cancelJob(job.id), "取消永不返回的动作");
    await cancelSettled(f, job);
    assert.strictEqual(job.status, "cancelled");
    assert.strictEqual(f.calls.starts, 1);
    assert.strictEqual(f.calls.actions.length, 1);
    assert.strictEqual(f.calls.writes.length, 0);
    assert.ok(job.tasks.every((task) => task.status === "cancelled"));
    assert.ok(f.locals.every((local) => local.closed));
  });

  await checkAsync("取消任务：动作迟到返回不能写入结果，也不能执行后续动作或账号", async () => {
    const action = deferred();
    const f = engineFixture({ action: () => action.promise });
    const job = f.create({ accountIds: ["first", "second"], actionIds: ["login", "after"] });
    await until(() => f.calls.actions.length === 1, "动作开始");
    await bounded(f.engine.cancelJob(job.id), "取消延迟动作");
    await cancelSettled(f, job);
    action.resolve({ outcome: "ok", statusPatch: { login: "ok" }, fieldPatch: { country: "US" } });
    await tick();
    await tick();
    assert.strictEqual(f.calls.writes.length, 0, "取消后不能采用迟到的成功结果");
    assert.strictEqual(f.calls.actions.length, 1);
    assert.ok(job.tasks.every((task) => task.results.length === 0));
    assert.strictEqual(f.calls.starts, 1);
  });

  await checkAsync("取消任务：本机启动未返回时先取消，迟到的浏览器句柄仍被关闭", async () => {
    const launch = deferred();
    const f = engineFixture({ start: () => launch.promise });
    const job = f.create();
    await until(() => f.calls.starts === 1, "启动已发起");
    const cancellation = f.engine.cancelJob(job.id);
    await bounded(cancellation, "立即接受启动期间取消");
    await tick();
    assert.strictEqual(f.engine.publicJob(job).closing, true, "尚未返回的启动资源不能误报已关完");
    const lateLocal = f.makeLocal();
    launch.resolve(lateLocal);
    await bounded(cancellation, "取消启动中的任务");
    await until(() => lateLocal.closed, "迟到本机浏览器关闭");
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.connects, 0);
    assert.strictEqual(f.calls.actions.length, 0);
    assert.strictEqual(f.calls.starts, 1);
    assert.strictEqual(f.calls.writes.length, 0);
  });

  await checkAsync("取消任务：CDP 接管进行中取消，迟到会话不能开始动作", async () => {
    const connection = deferred();
    const f = engineFixture({ connect: () => connection.promise });
    const job = f.create();
    await until(() => f.calls.connects === 1, "CDP 接管已发起");
    const cancellation = f.engine.cancelJob(job.id);
    await bounded(cancellation, "立即接受接管期间取消");
    await tick();
    connection.resolve(f.makeSession());
    await bounded(cancellation, "取消接管中的任务");
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.actions.length, 0);
    assert.strictEqual(f.calls.writes.length, 0);
    assert.ok(f.locals[0].closed);
    assert.ok(f.calls.closes + f.calls.disconnects >= 1, "迟到的 CDP 会话也应释放");
  });

  await checkAsync("取消任务：CDP 接管永不返回也不阻止进程关闭和取消进入终态", async () => {
    const f = engineFixture({ connect: () => new Promise(() => {}) });
    const job = f.create();
    await until(() => f.calls.connects === 1, "CDP 正在等待但永不返回");
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(job.status, "cancelled");
    assert.strictEqual(f.engine.publicJob(job).closing, false);
    assert.strictEqual(f.locals[0].closed, true);
    assert.strictEqual(f.calls.actions.length, 0);
    assert.strictEqual(f.calls.writes.length, 0);
  });

  await checkAsync("取消任务：清理会话阻塞不能阻止关闭本机进程", async () => {
    const f = engineFixture({ action: () => new Promise(() => {}), sessionClose: () => new Promise(() => {}) });
    const job = f.create();
    await until(() => f.calls.actions.length === 1, "动作开始");
    await bounded(f.engine.cancelJob(job.id), "关闭被 CDP 阻塞的窗口");
    await cancelSettled(f, job);
    assert.ok(f.locals[0].closed, "必须独立终止临时浏览器进程");
    assert.strictEqual(job.status, "cancelled");
  });

  await checkAsync("取消任务：开窗后的清数据操作卡住也能停止，且不开始账号动作", async () => {
    const f = engineFixture({ wipe: () => new Promise(() => {}) });
    const job = f.create({ clearData: true });
    await until(() => f.calls.wipes === 1, "启动后的清理开始");
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.actions.length, 0);
    assert.strictEqual(f.calls.writes.length, 0);
    assert.strictEqual(f.calls.wipes, 1, "取消不再次执行可能卡住的关闭前清理");
    assert.strictEqual(f.locals[0].closed, true);
  });

  await checkAsync("取消任务：并发中的全部本机窗口均关闭，动作收到取消信号", async () => {
    const f = engineFixture({ action: () => new Promise(() => {}) });
    const job = f.create({ accountIds: ["first", "second"], maxConcurrent: 2 });
    await until(() => f.calls.actions.length === 2, "两个并发动作均开始");
    assert.ok(f.calls.actions.every(({ context }) => context.signal && !context.signal.aborted));
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.localStops, 2);
    assert.ok(f.locals.every((local) => local.closed));
    assert.ok(f.calls.actions.every(({ context }) => context.signal.aborted && context.isCancelled()));
    assert.ok(job.tasks.every((task) => task.status === "cancelled"));
    assert.strictEqual(f.calls.writes.length, 0);
  });

  await checkAsync("取消任务：普通完成并保留的窗口仍能通过取消关闭", async () => {
    const f = engineFixture();
    const job = f.create({ keepOpen: true });
    await until(() => job.status === "done", "保留窗口的任务完成");
    assert.strictEqual(job.envs[0].retained, true);
    assert.strictEqual(f.calls.localStops, 0);
    await bounded(f.engine.cancelJob(job.id), "关闭已完成但保留的窗口");
    await cancelSettled(f, job);
    assert.strictEqual(job.envs[0].retained, false);
    assert.ok(f.locals[0].closed);
  });

  await checkAsync("取消任务：同时多次取消只关闭一次本机窗口", async () => {
    const stopped = deferred();
    const f = engineFixture({ action: () => new Promise(() => {}), localStop: () => stopped.promise });
    const job = f.create();
    await until(() => f.calls.actions.length === 1, "动作开始");
    const first = f.engine.cancelJob(job.id);
    const second = f.engine.cancelJob(job.id);
    await until(() => f.calls.localStops > 0, "关闭已发起");
    assert.strictEqual(f.calls.localStops, 1, "并发取消应共享关闭过程");
    stopped.resolve();
    await bounded(Promise.all([first, second]), "并发取消收尾");
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.localStops, 1);
    assert.ok(f.locals[0].closed);
  });

  await checkAsync("取消任务：本机关闭失败不清掉句柄不误报已关，后续取消可重试", async () => {
    let fail = true;
    const f = engineFixture({ localStop: async () => { if (fail) throw new Error("fixture stop failed"); } });
    const job = f.create({ keepOpen: true });
    await until(() => job.status === "done", "保留窗口");
    await bounded(f.engine.cancelJob(job.id), "第一次关闭失败");
    await cancelSettled(f, job);
    assert.strictEqual(f.locals[0].closed, false);
    assert.ok(job.envs[0].local || job.envs[0].retained, "失败后必须保留可重试关闭的资源");
    assert.ok(!job.tasks[0].events.some((event) => event.type === "env_closed"), "未关闭不能记录 env_closed");
    assert.strictEqual(f.engine.publicJob(job).cancelRequested, true);
    assert.ok(f.engine.publicJob(job).closeErrors.length > 0, "公开任务必须报告关闭错误，不能误报完成关闭");
    fail = false;
    await bounded(f.engine.cancelJob(job.id), "再次关闭");
    await cancelSettled(f, job);
    assert.ok(f.locals[0].closed);
    assert.strictEqual(job.envs[0].retained, false);
    assert.ok(f.calls.localStops >= 2);
    assert.strictEqual(f.engine.publicJob(job).closeErrors.length, 0);
  });

  await checkAsync("取消任务：接口及时接受请求，实际关闭完成前保持 closing 状态", async () => {
    const stopped = deferred();
    const f = engineFixture({ action: () => new Promise(() => {}), localStop: () => stopped.promise });
    const job = f.create();
    await until(() => f.calls.actions.length === 1, "动作开始");
    const accepted = await bounded(f.engine.cancelJob(job.id), "及时接受取消请求");
    assert.strictEqual(accepted.id, job.id);
    assert.strictEqual(f.engine.publicJob(job).cancelRequested, true);
    assert.strictEqual(f.engine.publicJob(job).closing, true);
    assert.notStrictEqual(job.status, "cancelled", "窗口未关完前不能误报取消已完成");
    stopped.resolve();
    await cancelSettled(f, job);
    assert.strictEqual(job.status, "cancelled");
    assert.strictEqual(f.engine.publicJob(job).closing, false);
  });

  await checkAsync("取消任务：添加 2FA 动作取消后迟到的登录与密钥回调不得保存", async () => {
    const f = engineFixture({ action: () => new Promise(() => {}) });
    const job = f.create({ actionIds: ["add-2fa"] });
    await until(() => f.calls.actions.length === 1, "添加 2FA 动作开始");
    const context = f.calls.actions[0].context;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    await assert.rejects(context.recordLoginResult({ outcome: "ok", statusPatch: { login: "ok" } }), /取消/);
    await assert.rejects(context.checkpointTotpSetup({ pendingTotpSetup: {
      secret: "JBSWY3DPEHPK3PXP", state: "pending", createdAt: "2026-01-01T00:00:00.000Z",
    } }), /取消/);
    assert.strictEqual(f.calls.writes.length, 0);
    assert.strictEqual(job.tasks[0].results.length, 0, "主动取消不能伪造登录失败或添加失败结果");
  });

  await checkAsync("取消任务：密钥 checkpoint 落盘等待中取消后不得继续提交验证码", async () => {
    const flushed = deferred();
    let submitted = 0;
    const f = engineFixture({
      flush: () => flushed.promise,
      action: async (id, page, account, context) => {
        await context.checkpointTotpSetup({ pendingTotpSetup: {
          secret: "JBSWY3DPEHPK3PXP", state: "pending", createdAt: "2026-01-01T00:00:00.000Z",
        } });
        submitted += 1;
        return { outcome: "ok", fieldPatch: { totpSecret: "JBSWY3DPEHPK3PXP" } };
      },
    });
    const job = f.create({ actionIds: ["add-2fa"] });
    await until(() => f.calls.writes.length === 1, "提交前候选密钥正在落盘");
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    flushed.resolve();
    await tick();
    await tick();
    assert.strictEqual(submitted, 0, "取消不能让等待落盘的动作恢复并提交验证码");
    assert.strictEqual(f.calls.writes.length, 1, "取消前的候选检查点保留，但不写迟到结果或失败状态");
    assert.strictEqual(job.tasks[0].results.length, 0);
    assert.strictEqual(f.records.get("first").totpSecret, undefined);
  });

  await checkAsync("取消任务：停止本任务不得关闭其它已完成任务保留的窗口", async () => {
    const f = engineFixture();
    const previous = f.create({ accountIds: ["first"], keepOpen: true });
    await until(() => previous.status === "done", "历史任务保留窗口");
    const target = f.create({ accountIds: ["second"], keepOpen: true });
    await until(() => target.status === "done", "目标任务保留窗口");
    await f.engine.cancelJob(target.id);
    await cancelSettled(f, target);
    assert.strictEqual(f.locals[0].closed, false);
    assert.strictEqual(previous.envs[0].retained, true);
    assert.strictEqual(f.engine.publicJob(previous).cancelRequested, false);
    assert.strictEqual(f.locals[1].closed, true);
    assert.strictEqual(f.calls.localStops, 1);
  });

  await checkAsync("取消任务：AdsPower 动作阻塞时调用 AdsPower 关闭，不调用本机停止", async () => {
    const f = engineFixture({ action: () => new Promise(() => {}) });
    const job = f.create({ mode: "adspower", envSerials: ["fixture-ads-1"] });
    await until(() => f.calls.actions.length === 1, "AdsPower 动作开始");
    const before = f.calls.adsStops;
    await bounded(f.engine.cancelJob(job.id), "取消 AdsPower 任务");
    await cancelSettled(f, job);
    assert.ok(f.calls.adsStops > before);
    assert.strictEqual(f.calls.localStops, 0);
    assert.strictEqual(f.calls.starts, 0);
    assert.strictEqual(job.status, "cancelled");
  });

  await checkAsync("取消任务：AdsPower 启动前旧停止请求未返回时不能让其它任务抢环境", async () => {
    const initialStop = deferred();
    const f = engineFixture({ adsStop: async (serial, calls) => calls.adsStops === 1
      ? initialStop.promise : { code: 0 } });
    const options = { mode: "adspower", envSerials: ["fixture-ads-before-start"] };
    const job = f.create(options);
    await until(() => f.calls.adsStops === 1, "启动前初始停止请求仍未返回");
    await f.engine.cancelJob(job.id);
    await until(() => f.calls.adsStops >= 2, "取消时关闭已发起");
    await tick();
    assert.strictEqual(f.engine.publicJob(job).closing, true);
    assert.throws(() => f.create({ ...options, accountIds: ["second"] }), /另一个任务使用或保留/,
      "旧 stop 请求迟到可能关闭新任务窗口，必须保留环境所有权");
    assert.strictEqual(f.calls.adsStarts, 0);
    initialStop.resolve({ code: 0 });
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.adsStarts, 0, "取消后旧流程不能继续启动");
    const next = f.create({ ...options, accountIds: ["second"] });
    await until(() => next.status === "done", "旧请求完全结束后可安全复用环境");
    assert.strictEqual(f.calls.adsStarts, 1);
  });

  await checkAsync("取消任务：旧 AdsPower CDP 迟到只关闭自身会话，不再停止新任务已复用的环境", async () => {
    const oldConnection = deferred();
    const f = engineFixture({ connect: async (endpoint, makeSession, calls) => calls.connects === 1
      ? oldConnection.promise : makeSession() });
    const options = { mode: "adspower", envSerials: ["fixture-ads-late-cdp"] };
    const oldJob = f.create(options);
    await until(() => f.calls.connects === 1, "旧任务 CDP 接管尚未返回");
    await f.engine.cancelJob(oldJob.id);
    await cancelSettled(f, oldJob);
    const next = f.create({ ...options, accountIds: ["second"], keepOpen: true });
    await until(() => next.status === "done", "新任务已安全复用环境并保留窗口");
    const stopsBeforeLateConnection = f.calls.adsStops;
    const closesBeforeLateConnection = f.calls.closes;
    oldConnection.resolve(f.makeSession());
    await until(() => f.calls.closes > closesBeforeLateConnection, "旧接管会话被独立关闭");
    await tick();
    assert.strictEqual(f.calls.adsStops, stopsBeforeLateConnection, "不能 stop 已交给新任务的 AdsPower serial");
    assert.strictEqual(next.envs[0].retained, true);
    assert.strictEqual(f.engine.publicJob(next).cancelRequested, false);
    assert.strictEqual(f.calls.actions.length, 1);
  });

  await checkAsync("取消任务：AdsPower 代理设置迟到时持有环境直到请求结束且不再开窗", async () => {
    const changingProxy = deferred();
    const f = engineFixture({ adsSetProxy: async (serial, proxy, calls) => calls.adsProxyChanges === 1
      ? changingProxy.promise : { ok: true } });
    const options = { mode: "adspower", envSerials: ["fixture-ads-proxy-pending"] };
    const job = f.create(options);
    await until(() => f.calls.adsProxyChanges === 1, "代理修改请求已发起");
    await f.engine.cancelJob(job.id);
    await tick();
    assert.strictEqual(f.engine.publicJob(job).closing, true);
    assert.throws(() => f.create({ ...options, accountIds: ["second"] }), /另一个任务使用或保留/,
      "旧代理请求未结束前不能改变新任务环境的代理");
    assert.strictEqual(f.calls.adsStarts, 0);
    changingProxy.resolve({ ok: true });
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.adsStarts, 0);
    assert.strictEqual(f.calls.actions.length, 0);
    const next = f.create({ ...options, accountIds: ["second"] });
    await until(() => next.status === "done", "旧代理请求结束后可复用环境");
    assert.strictEqual(f.calls.adsStarts, 1);
  });

  await checkAsync("取消任务：正常批次逐个关窗不能提前释放后续账号仍需使用的 AdsPower 环境", async () => {
    const secondAction = deferred();
    const f = engineFixture({ action: async (id, page, account) => account.id === "first"
      ? { outcome: "ok" } : secondAction.promise });
    const options = { mode: "adspower", envSerials: ["fixture-ads-batch"], accountIds: ["first", "second"] };
    const job = f.create(options);
    await until(() => f.calls.actions.length === 2, "第一账号关闭后第二账号正在使用环境");
    assert.throws(() => f.create({ ...options, accountIds: ["first"] }), /另一个任务使用或保留/,
      "前一个账号关窗不代表整个批次已经释放共享环境");
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    secondAction.resolve({ outcome: "ok" });
    await tick();
  });

  await checkAsync("取消任务：AdsPower 关闭失败保留环境所有权，成功重试才释放", async () => {
    let fail = false;
    const f = engineFixture({ adsStop: async () => fail ? { ok: false, error: "fixture AdsPower stop failed" } : { ok: true } });
    const options = { mode: "adspower", envSerials: ["fixture-ads-retry"], keepOpen: true };
    const job = f.create(options);
    await until(() => job.status === "done", "AdsPower 保留窗口");
    fail = true;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(job.envs[0].retained, true);
    assert.ok(f.engine.publicJob(job).closeErrors.length > 0);
    assert.throws(() => f.create({ ...options, accountIds: ["second"] }), /另一个任务使用或保留/);
    assert.ok(!job.tasks[0].events.some((event) => event.type === "env_closed"));
    fail = false;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(job.envs[0].retained, false);
    assert.strictEqual(f.engine.publicJob(job).closeErrors.length, 0);
    const next = f.create({ ...options, accountIds: ["second"], keepOpen: false });
    await until(() => next.status === "done", "释放后环境可供下一任务使用");
    assert.strictEqual(f.calls.localStops, 0);
  });

  await checkAsync("取消任务：AdsPower 原始 code 非零响应不能被当成关闭成功", async () => {
    let fail = false;
    const f = engineFixture({ adsStop: async () => fail
      ? { code: 1, msg: "fixture API refused to stop" } : { code: 0, msg: "success" } });
    const job = f.create({ mode: "adspower", envSerials: ["fixture-ads-raw-error"], keepOpen: true });
    await until(() => job.status === "done", "AdsPower 窗口已保留");
    fail = true;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(job.envs[0].retained, true);
    assert.ok(f.engine.publicJob(job).closeErrors.some(({ message }) => /fixture API refused/.test(message)));
    fail = false;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(job.envs[0].retained, false);
    assert.strictEqual(f.engine.publicJob(job).closeErrors.length, 0);
  });

  await checkAsync("取消任务：AdsPower 空响应或缺少成功字段不能误报已关闭", async () => {
    for (const response of [null, {}, { error: "fixture response has no success flag" }]) {
      let fail = false;
      const f = engineFixture({ adsStop: async () => fail ? response : { code: 0 } });
      const options = { mode: "adspower", envSerials: ["fixture-ads-unconfirmed-stop"], keepOpen: true };
      const job = f.create(options);
      await until(() => job.status === "done", "AdsPower 窗口已保留");
      fail = true;
      await f.engine.cancelJob(job.id);
      await cancelSettled(f, job);
      assert.strictEqual(job.envs[0].retained, true);
      assert.ok(f.engine.publicJob(job).closeErrors.length > 0);
      assert.throws(() => f.create({ ...options, accountIds: ["second"] }), /另一个任务使用或保留/);
      fail = false;
      await f.engine.cancelJob(job.id);
      await cancelSettled(f, job);
    }
  });

  await checkAsync("取消任务：AdsPower 关闭外层超时后重试成功也须等旧请求结束再释放环境", async () => {
    const oldStop = deferred();
    let delayNextStop = false;
    const f = engineFixture({ adsStop: async () => {
      if (delayNextStop) { delayNextStop = false; return oldStop.promise; }
      return { code: 0 };
    } });
    const options = { mode: "adspower", envSerials: ["fixture-ads-stop-timeout"], keepOpen: true };
    const job = f.create(options);
    await until(() => job.status === "done", "AdsPower 窗口已保留");
    delayNextStop = true;
    await f.engine.cancelJob(job.id);
    await until(() => f.engine.publicJob(job).closeErrors.length > 0, "外层关闭计时器已超时而请求尚未结束");
    assert.strictEqual(f.engine.publicJob(job).closing, true);
    await f.engine.cancelJob(job.id);
    await until(() => !job.envs[0].retained && !job.envs[0].closePromise, "重试的关闭请求已成功");
    assert.strictEqual(f.engine.publicJob(job).closing, true, "旧 stop 请求仍在飞行，不能宣告所有收尾结束");
    assert.throws(() => f.create({ ...options, accountIds: ["second"] }), /另一个任务使用或保留/);
    oldStop.resolve({ code: 0 });
    await cancelSettled(f, job);
    const next = f.create({ ...options, accountIds: ["second"], keepOpen: false });
    await until(() => next.status === "done", "所有旧关闭请求结束后才可复用环境");
  });

  await checkAsync("取消任务：迟到 AdsPower 启动在旧关闭尚未返回时完成仍须再次关闭", async () => {
    const started = deferred();
    const firstCancellationStop = deferred();
    const f = engineFixture({
      adsStart: () => started.promise,
      adsStop: async (serial, calls) => calls.adsStops === 2 ? firstCancellationStop.promise : { code: 0 },
    });
    const job = f.create({ mode: "adspower", envSerials: ["fixture-ads-overlap"] });
    await until(() => f.calls.adsStarts === 1, "AdsPower 启动尚未返回");
    await f.engine.cancelJob(job.id);
    await until(() => f.calls.adsStops === 2, "取消时第一次停止尚未返回");
    started.resolve({ cdpEndpoint: "fixture://ads/overlap" });
    await tick();
    firstCancellationStop.resolve({ code: 0 });
    await cancelSettled(f, job);
    assert.ok(f.calls.adsStops >= 3, "旧关闭结果不能覆盖迟到启动登记的新资源");
    assert.strictEqual(f.calls.connects, 0);
    assert.strictEqual(f.calls.actions.length, 0);
    assert.strictEqual(f.engine.publicJob(job).closeErrors.length, 0);
  });

  await checkAsync("取消任务：本机启动失败且残留进程未关掉不能重试开新窗口覆盖句柄", async () => {
    let fail = true;
    let stranded;
    const f = engineFixture({
      start: async (args, makeLocal, calls) => {
        if (calls.starts > 1) return makeLocal();
        stranded = makeLocal();
        const error = new Error("fixture startup cleanup failed");
        error.cleanupFailed = true;
        error.local = stranded;
        throw error;
      },
      localStop: async () => { if (fail) throw new Error("fixture residual process still running"); },
    });
    const job = f.create();
    await until(() => job.status === "done", "启动失败后的任务结束");
    assert.strictEqual(f.calls.starts, 1, "残留窗口未关闭前不能重新启动并覆盖所有权");
    assert.strictEqual(f.calls.actions.length, 0);
    assert.strictEqual(job.envs[0].local, stranded);
    assert.strictEqual(stranded.closed, false);
    assert.strictEqual(job.envs[0].retained, true);
    fail = false;
    await f.engine.cancelJob(job.id);
    await cancelSettled(f, job);
    assert.strictEqual(stranded.closed, true);
    assert.strictEqual(job.envs[0].local, null);
  });

  await checkAsync("取消任务：AdsPower 启动迟到返回时关闭该环境且不连接", async () => {
    const started = deferred();
    const f = engineFixture({ adsStart: () => started.promise });
    const job = f.create({ mode: "adspower", envSerials: ["fixture-ads-late"] });
    await until(() => f.calls.adsStarts === 1, "AdsPower 正在启动");
    const cancellation = f.engine.cancelJob(job.id);
    await bounded(cancellation, "立即接受 AdsPower 启动取消");
    await tick();
    const stopsBeforeResolve = f.calls.adsStops;
    started.resolve({ cdpEndpoint: "fixture://ads/late" });
    await bounded(cancellation, "取消 AdsPower 启动");
    await cancelSettled(f, job);
    assert.strictEqual(f.calls.connects, 0);
    assert.strictEqual(f.calls.actions.length, 0);
    assert.ok(f.calls.adsStops > stopsBeforeResolve, "迟到启动在先前关闭请求之后返回时必须再确保环境关闭");
  });
};
