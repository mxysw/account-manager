"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { normalizeConfig, createSolver } = require("../src/automation/capsolver");

const KEY = "fixture-private-api-key";
const TOKEN = "03_fixture_valid_token_never_log_this_0123456789";
const challenge = (extra = {}) => ({ type: "recaptcha-v2", websiteURL: "https://accounts.google.com/signin?session=private-session#private-hash",
  websiteKey: "fixture-public-sitekey", enterprise: false, ...extra });
const config = (extra = {}) => ({ enabled: true, apiKey: KEY, maxAttemptsPerAccount: 1, ...extra });
const context = (extra = {}) => ({ accountCount: 1, actionIds: ["login"], ...extra });
const success = () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: TOKEN, userAgent: "never-log-user-agent", "recaptcha-ca-e": "never-log-cookie" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(replies, options = {}) {
  let time = 0;
  const calls = [];
  const events = [];
  const sleeps = [];
  const solver = (options.createSolver || createSolver)(config(options.config), {
    signal: options.signal,
    emit: (type, data) => events.push({ type, data }),
    now: () => time,
    sleep: options.sleep || (async (ms) => { sleeps.push(ms); time += ms; }),
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, payload: JSON.parse(init.body) });
      if (options.fetchImpl) return options.fetchImpl(url, init, calls);
      assert.ok(replies.length > 0, "Unexpected request; fixtures must never use real fetch");
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(url, init);
      return { status: 200, json: async () => next };
    },
  });
  return { solver, calls, events, sleeps, advance: (ms) => { time += ms; } };
}

function errorCode(code) {
  return (error) => { assert.strictEqual(error.code, code); return true; };
}

function timedModule(requestTime = 10, totalTime = 1000) {
  const scheduled = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/automation/capsolver.js"), "utf8"), {
    module, exports: module.exports, URL, AbortController, WeakSet, Date,
    setTimeout: (fn, ms) => {
      scheduled.push(ms);
      return setTimeout(fn, ms === 140000 ? totalTime : requestTime);
    },
    clearTimeout,
  }, { filename: "capsolver-timeout-fixture.js" });
  return { createSolver: module.exports.createSolver, scheduled };
}

async function run({ checkAsync }) {
  await checkAsync("CAPSOLVER: disabled configuration and strict opt-in validation", async () => {
    for (const disabled of [null, undefined, false, {}, { enabled: false, apiKey: KEY }]) assert.strictEqual(normalizeConfig(disabled), null);
    assert.deepStrictEqual(normalizeConfig({ enabled: true, apiKey: ` ${KEY} ` }, context()), config({ maxAttemptsPerAccount: 3 }));
    for (const maxAttemptsPerAccount of [0, 11, 1.5, "1", null, NaN]) assert.throws(() => normalizeConfig(config({ maxAttemptsPerAccount }), context()), errorCode("CAPSOLVER_LIMIT_INVALID"));
    assert.strictEqual(normalizeConfig(config({ maxAttemptsPerAccount: 10 }), context()).maxAttemptsPerAccount, 10);
    for (const legacy of [{ enabled: true, apiKey: KEY, maxTasks: 2 }, config({ maxTasks: 2 })]) {
      assert.throws(() => normalizeConfig(legacy, context()), errorCode("CAPSOLVER_CONFIG_OUTDATED"));
    }
    for (const actionIds of [undefined, [], ["check-password"], ["login", "check-password"], ["detect-ban", "login"],
      ["detect-ban"], ["add-2fa-phone"], ["add-2fa", "login"], ["add-2fa", "check-password"], ["add-2fa", "detect-ban"]]) {
      assert.throws(() => normalizeConfig(config(), context({ actionIds })), errorCode("CAPSOLVER_ACTION_UNSUPPORTED"));
    }
    assert.deepStrictEqual(normalizeConfig(config(), context({ actionIds: ["login", "detect-ban", "change-language"] })), config());
    assert.deepStrictEqual(normalizeConfig(config(), context({ actionIds: ["add-2fa"] })), config());
    assert.throws(() => normalizeConfig(config(), context({ proxy: "http://private-proxy" })), errorCode("CAPSOLVER_PROXY_UNSUPPORTED"));
    assert.throws(() => normalizeConfig(config(), context({ accountCount: 0 })), errorCode("CAPSOLVER_ACCOUNT_COUNT_INVALID"));
    assert.throws(() => normalizeConfig(config({ apiKey: "bad\nkey" }), context()), errorCode("CAPSOLVER_KEY_REQUIRED"));
    assert.throws(() => normalizeConfig(config({ cookies: "private" }), context()), errorCode("CAPSOLVER_CONFIG_INVALID"));
    const disabled = createSolver(null, { fetchImpl: () => { throw new Error("Must not fetch"); } });
    await assert.rejects(disabled.solve(challenge()), errorCode("CAPSOLVER_DISABLED"));
    assert.deepStrictEqual(disabled.summary(), { enabled: false, attempted: 0, ready: 0, failed: 0, maxAttemptsPerAccount: 0 });
  });

  await checkAsync("CAPSOLVER: ordinary and Enterprise payloads strip URL secrets", async () => {
    for (const enterprise of [false, true]) {
      const f = fixture([{ errorId: 0, taskId: "task-1" }, { errorId: 0, status: "processing" }, success()]);
      assert.deepStrictEqual(await f.solver.solve(challenge({ enterprise, dataS: "private-s", pageAction: "login", isInvisible: true })), { token: TOKEN });
      assert.strictEqual(f.calls.length, 3);
      const task = f.calls[0].payload.task;
      assert.strictEqual(task.type, enterprise ? "ReCaptchaV2EnterpriseTaskProxyLess" : "ReCaptchaV2TaskProxyLess");
      assert.strictEqual(task.websiteURL, "https://accounts.google.com/signin");
      assert.strictEqual(task.pageAction, "login");
      assert.strictEqual(task.isInvisible, true);
      assert.deepStrictEqual(enterprise ? task.enterprisePayload : task.recaptchaDataSValue, enterprise ? { s: "private-s" } : "private-s");
      assert.ok(!("cookies" in task) && !("proxy" in task) && !("userAgent" in task));
      for (const call of f.calls) {
        assert.ok(["https://api.capsolver.com/createTask", "https://api.capsolver.com/getTaskResult"].includes(call.url));
        assert.strictEqual(call.redirect, "error");
        assert.strictEqual(call.credentials, "omit");
        assert.strictEqual(call.payload.clientKey, KEY);
        assert.ok(!call.body.includes("private-session") && !call.body.includes("private-hash"));
      }
      assert.deepStrictEqual(f.sleeps, [3000, 3000]);
      assert.deepStrictEqual(f.events.map((event) => event.type), ["capsolver_attempt", "capsolver_created", "capsolver_processing", "capsolver_ready"]);
      assert.deepStrictEqual(f.events[0].data, { attempt: 1, maxAttemptsPerAccount: 1 });
      const visible = JSON.stringify({ events: f.events, summary: f.solver.summary() });
      for (const secret of [KEY, TOKEN, "private-s", "task-1", "never-log-cookie", "never-log-user-agent"]) assert.ok(!visible.includes(secret));
      assert.deepStrictEqual(f.solver.summary(), { enabled: true, attempted: 1, ready: 1, failed: 0, maxAttemptsPerAccount: 1 });
    }
  });

  await checkAsync("CAPSOLVER: rejects unsupported URLs and credential-bearing extra fields before charging", async () => {
    for (const websiteURL of ["http://accounts.google.com/", "https://evil.example/", "https://accounts.google.com.evil.example/", "https://accounts.google.com:444/", "https://user:pass@accounts.google.com/", "not a URL"]) {
      const f = fixture([]);
      await assert.rejects(f.solver.solve(challenge({ websiteURL })), errorCode("CAPSOLVER_URL_UNSUPPORTED"));
      assert.strictEqual(f.calls.length, 0);
      assert.strictEqual(f.solver.summary().attempted, 0);
    }
    for (const extra of [{ cookies: [] }, { userAgent: "private" }, { proxy: "private" }, { enterprise: "true" }, { dataS: "bad\nvalue" }, { pageAction: "bad action" }, { isInvisible: "true" }, { websiteKey: "bad/key" }]) {
      const f = fixture([]);
      await assert.rejects(f.solver.solve(challenge(extra)), errorCode("CAPSOLVER_CHALLENGE_INVALID"));
      assert.strictEqual(f.calls.length, 0);
    }
    await assert.rejects(fixture([]).solver.solve(challenge({ type: "recaptcha-v3" })), errorCode("CAPSOLVER_CHALLENGE_UNSUPPORTED"));
  });

  await checkAsync("CAPSOLVER: the same account reserves its cap before awaiting createTask", async () => {
    let release;
    const f = fixture([() => new Promise((resolve) => { release = resolve; }), success()]);
    const account = f.solver.forAccount("same-account");
    const first = account.solve(challenge());
    assert.strictEqual(f.solver.summary().attempted, 1);
    await assert.rejects(f.solver.forAccount("same-account").solve(challenge()), errorCode("CAPSOLVER_ACCOUNT_LIMIT"));
    assert.strictEqual(f.calls.length, 1);
    release({ status: 200, json: async () => ({ errorId: 0, taskId: "task-1" }) });
    await first;
    assert.strictEqual(f.calls.filter((call) => call.url.endsWith("/createTask")).length, 1);
    assert.strictEqual(f.solver.summary().failed, 0);
  });

  await checkAsync("CAPSOLVER: ambiguous create errors are redacted and never recreated", async () => {
    const hostile = `${KEY} ${TOKEN} raw-body-private`;
    for (const response of [new Error(hostile), { errorId: 1, errorCode: hostile, errorDescription: hostile }, { errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: hostile }, { errorId: 0 }, () => ({ status: 503, json: () => { throw new Error(hostile); } }), () => ({ status: 200, json: () => { throw new Error(hostile); } })]) {
      const f = fixture([response]);
      await assert.rejects(f.solver.solve(challenge()), (error) => {
        const visible = JSON.stringify({ message: error.message, code: error.code, stack: error.stack, events: f.events, summary: f.solver.summary() });
        for (const secret of [KEY, TOKEN, "raw-body-private"]) assert.ok(!visible.includes(secret));
        assert.ok(error.code);
        assert.deepStrictEqual(f.events.at(-1).data, { code: error.code });
        return true;
      });
      assert.strictEqual(f.calls.length, 1);
      assert.strictEqual(f.solver.summary().failed, 1);
      await assert.rejects(f.solver.solve(challenge()), errorCode("CAPSOLVER_ACCOUNT_LIMIT"));
      assert.strictEqual(f.calls.length, 1);
    }
  });

  await checkAsync("CAPSOLVER: concurrent solves keep account emitters separate", async () => {
    const accountEvents = [[], []];
    const f = fixture([], { config: { maxAttemptsPerAccount: 1 }, fetchImpl: async (url, init, calls) => ({
      status: 200,
      json: async () => url.endsWith("/createTask") ? { errorId: 0, taskId: `task-${calls.length}` } : success(),
    }) });
    await Promise.all(accountEvents.map((events, i) => f.solver.forAccount(`account-${i}`, { emit: (type, data) => events.push({ type, data }) }).solve(challenge())));
    for (const events of accountEvents) assert.deepStrictEqual(events.map(({ type }) => type), ["capsolver_attempt", "capsolver_created", "capsolver_ready"]);
    assert.deepStrictEqual(f.events, []);
    assert.deepStrictEqual(f.solver.summary(), { enabled: true, attempted: 2, ready: 2, failed: 0, maxAttemptsPerAccount: 1 });
  });

  await checkAsync("CAPSOLVER: ten accounts can each exhaust three attempts without a shared batch cap", async () => {
    const f = fixture([], { config: { maxAttemptsPerAccount: 3 }, fetchImpl: async () => ({
      status: 200, json: async () => ({ errorId: 1, errorCode: "ERROR_CAPTCHA_UNSOLVABLE" }),
    }) });
    const scoped = Array.from({ length: 10 }, (_, index) => f.solver.forAccount(`account-${index}`));
    await Promise.all(scoped.map(async (account) => {
      assert.strictEqual(account.maxAttemptsPerAccount, 3);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await assert.rejects(account.solve(challenge()), errorCode("ERROR_CAPTCHA_UNSOLVABLE"));
        assert.strictEqual(account.getAttemptCount(), attempt);
      }
      await assert.rejects(account.solve(challenge()), errorCode("CAPSOLVER_ACCOUNT_LIMIT"));
      assert.deepStrictEqual(account.summary(), { enabled: true, attempted: 3, ready: 0, failed: 3, maxAttemptsPerAccount: 3 });
    }));
    assert.strictEqual(f.calls.length, 30);
    assert.deepStrictEqual(f.solver.summary(), { enabled: true, attempted: 30, ready: 0, failed: 30, maxAttemptsPerAccount: 3 });
    assert.strictEqual(f.events.filter(({ type }) => type === "capsolver_attempt").length, 30);
    assert.strictEqual(f.events.filter(({ type }) => type === "capsolver_failed").length, 30);
  });

  await checkAsync("CAPSOLVER: transient polling retries only the same task ID", async () => {
    const f = fixture([{ errorId: 0, taskId: "task-original" }, () => ({ status: 503 }), () => ({ status: 429 }), success()]);
    await f.solver.solve(challenge());
    assert.strictEqual(f.calls.filter((call) => call.url.endsWith("/createTask")).length, 1);
    assert.deepStrictEqual(f.calls.slice(1).map((call) => call.payload.taskId), ["task-original", "task-original", "task-original"]);
    assert.deepStrictEqual(f.sleeps, [3000, 3000, 3000]);
  });

  await checkAsync("CAPSOLVER: ready tokens must be bounded printable token strings", async () => {
    for (const token of [null, 123, "", "short", `<script>${TOKEN}</script>`, `${TOKEN}\n`, "a".repeat(16385)]) {
      const f = fixture([{ errorId: 0, taskId: "task-1" }, { errorId: 0, status: "ready", solution: { gRecaptchaResponse: token } }]);
      await assert.rejects(f.solver.solve(challenge()), errorCode("CAPSOLVER_TOKEN_INVALID"));
      assert.strictEqual(f.solver.summary().ready, 0);
      assert.strictEqual(f.solver.summary().failed, 1);
      assert.ok(!JSON.stringify(f.events).includes(TOKEN));
    }
  });

  await checkAsync("CAPSOLVER: cancellation before creation, during fetch, and during sleep", async () => {
    const before = new AbortController();
    before.abort(new Error(KEY));
    const cancelled = fixture([], { signal: before.signal });
    await assert.rejects(cancelled.solver.solve(challenge()), errorCode("CAPSOLVER_CANCELLED"));
    assert.strictEqual(cancelled.calls.length, 0);
    for (const phase of ["fetch", "sleep"]) {
      const controller = new AbortController();
      const f = fixture(phase === "fetch" ? [() => new Promise(() => {})] : [{ errorId: 0, taskId: "task-1" }], {
        signal: controller.signal,
        ...(phase === "sleep" ? { sleep: () => new Promise(() => {}) } : {}),
      });
      const pending = f.solver.solve(challenge());
      await tick();
      controller.abort(new Error(`${KEY} ${TOKEN}`));
      await assert.rejects(pending, (error) => {
        assert.strictEqual(error.name, "AbortError");
        assert.strictEqual(error.code, "CAPSOLVER_CANCELLED");
        assert.ok(!error.message.includes(KEY));
        return true;
      });
      assert.strictEqual(f.calls.length, 1);
      assert.strictEqual(f.solver.summary().failed, 1);
    }
  });

  await checkAsync("CAPSOLVER: poll and overall deadlines are bounded", async () => {
    const f = fixture([{ errorId: 0, taskId: "task-1" }, ...Array.from({ length: 40 }, () => ({ errorId: 0, status: "processing" }))]);
    await assert.rejects(f.solver.solve(challenge()), errorCode("CAPSOLVER_TIMEOUT"));
    assert.strictEqual(f.calls.length, 41);
    assert.strictEqual(f.sleeps.length, 40);
    assert.strictEqual(f.solver.summary().failed, 1);
    let advance;
    const deadline = fixture([{ errorId: 0, taskId: "task-1" }], { sleep: async () => advance(140000) });
    advance = deadline.advance;
    await assert.rejects(deadline.solver.solve(challenge()), errorCode("CAPSOLVER_TIMEOUT"));
    assert.strictEqual(deadline.calls.length, 1);
  });

  await checkAsync("CAPSOLVER: real timers bound hung fetch, body parsing and injected sleep", async () => {
    for (const hang of ["fetch", "body", "sleep"]) {
      const clock = timedModule(10, hang === "sleep" ? 25 : 1000);
      const f = fixture(hang === "fetch" ? [() => new Promise(() => {})]
        : hang === "body" ? [() => ({ status: 200, json: () => new Promise(() => {}) })]
          : [{ errorId: 0, taskId: "task-1" }], {
        createSolver: clock.createSolver,
        ...(hang === "sleep" ? { sleep: () => new Promise(() => {}) } : {}),
      });
      await assert.rejects(f.solver.solve(challenge()), errorCode(hang === "sleep" ? "CAPSOLVER_TIMEOUT" : "CAPSOLVER_REQUEST_TIMEOUT"));
      assert.ok(clock.scheduled.includes(18000));
      assert.ok(clock.scheduled.includes(140000));
      assert.strictEqual(f.calls.length, 1);
      assert.strictEqual(f.solver.summary().failed, 1);
    }
  });

  await checkAsync("CAPSOLVER: dispose blocks future requests without aborting caller signal", async () => {
    const controller = new AbortController();
    const input = config();
    const f = fixture([], { signal: controller.signal, config: input });
    f.solver.dispose();
    await assert.rejects(f.solver.solve(challenge()), errorCode("CAPSOLVER_DISPOSED"));
    assert.strictEqual(controller.signal.aborted, false);
    assert.strictEqual(input.apiKey, KEY);
    assert.strictEqual(f.calls.length, 0);
    assert.deepStrictEqual(Object.keys(f.solver.summary()).sort(), ["attempted", "enabled", "failed", "maxAttemptsPerAccount", "ready"]);
  });
}

module.exports = run;
if (require.main === module) {
  let passed = 0;
  run({ checkAsync: async (name, check) => { await check(); passed += 1; process.stdout.write(`PASS ${name}\n`); } })
    .then(() => process.stdout.write(`CAPSOLVER: ${passed} fixture tests passed; no network or browser access.\n`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
