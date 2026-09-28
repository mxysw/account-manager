"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Isolated form/controller fixtures: no browser, server, credentials or account store.
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const markup = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing UI section: ${start}`);
  return source.slice(first, last);
}
const FIXTURE_KEY = "CAPSOLVER-FIXTURE-NOT-A-REAL-KEY";
const PREFERENCES_KEY = "am_capsolver_preferences";
const FLAGS_KEY = "am_flags";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness({ storage = new Map(), server = { configured: false } } = {}) {
  const elements = new Map(), pageEvents = new Map(), requests = [], failures = [];
  const responses = [];
  const config = { mode: "local", actionIds: ["login"], proxy: { enabled: false } };
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, hidden: false, disabled: false, textContent: "", attributes: {}, events: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { this.events[name] = fn; },
    });
    return elements.get(id);
  };
  el("manualChallengePolicy").value = "close";
  el("capsolverEnabled").checked = true;
  el("capsolverKey").value = FIXTURE_KEY;
  const deps = {
    el,
    LS: { flags: FLAGS_KEY },
    window: { addEventListener: (name, fn) => pageEvents.set(name, fn) },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => { assert.ok(!value.includes(FIXTURE_KEY)); storage.set(key, value); },
    },
    document: { querySelectorAll: () => config.actionIds.map((value) => ({ value })) },
    currentMode: () => config.mode,
    readProxyForm: () => config.proxy,
    readPhoneRunMode: () => "shared",
    syncRunButton: () => {}, persistJobHandles: () => {}, renderJob: () => {}, pollJob: () => {}, toast: () => {},
    api: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (failures.length) throw failures.shift();
      if (responses.length) return responses.shift();
      if (url === "/api/settings/capsolver") {
        if (options.method === "PUT") {
          assert.strictEqual(typeof JSON.parse(options.body).apiKey, "string");
          server.configured = true;
        }
        if (options.method === "DELETE") server.configured = false;
        return { configured: server.configured };
      }
      assert.strictEqual(url, "/api/automation/run");
      return { jobId: "fixture-job", job: { tasks: [] } };
    },
  };
  const controller = new Function(...Object.keys(deps), `
    let appReady = true, jobStarting = false, jobId = null, cancelInFlight = false;
    let adspowerSettingsLoaded = true, adspowerConfigured = true, adspowerSettingsBusy = false;
    let adspowerEnvsReady = true;
    let closeTargetId = null, trackedJob = null, cancelIntent = false;
    let cancelError = "", jobPollError = "", jobStateEpoch = 0;
    const envSelected = new Set(["fixture-env"]), accounts = [], jobManualExpand = new Map();
    ${extract("// 记住批量运行偏好", "// ---- CAPSOLVER")}
    ${extract("// ---- CAPSOLVER", "// ---- 运行模式")}
    ${extract("async function startJob(", 'el("runBtn").addEventListener')}
    return {startJob, readCapsolverForm, loadCapsolverSettings, saveCapsolverKey, clearCapsolverKey,
      syncCapsolverVisibility, loadFlags, saveFlags,
      finish: () => { jobId = null; }};
  `)(...Object.values(deps));
  return {
    ...controller, el, elements, config, requests, failures, responses, storage, server,
    enable(withKey = true) {
      el("capsolverEnabled").checked = true;
      el("capsolverEnabled").events.change();
      if (withKey) el("capsolverKey").value = FIXTURE_KEY;
      el("capsolverKey").events.input();
    },
    setPolicy(value) {
      el("manualChallengePolicy").value = value;
      el("manualChallengePolicy").events.change();
    },
    restorePage: () => pageEvents.get("pageshow")({ persisted: true }),
  };
}

module.exports = async function runCapsolverUiTests({ check, checkAsync }) {
  await checkAsync("CAPSOLVER 界面：默认关闭、密码输入，保存配置不会开启付费开关", async () => {
    const h = harness();
    await h.loadCapsolverSettings();
    assert.strictEqual(h.el("capsolverEnabled").checked, false);
    assert.strictEqual(h.el("capsolverKey").value, "");
    assert.strictEqual(h.el("capsolverKey").disabled, false);
    assert.strictEqual(h.el("capsolverMaxTasks").value, "3");
    assert.strictEqual(h.el("capsolverMaxTasks").disabled, true);
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "未配置");
    assert.strictEqual(h.el("capsolverClearBtn").disabled, true);
    assert.match(markup, /id="capsolverKey" type="password" autocomplete="off"/);
    assert.match(markup, /id="capsolverMaxTasks" type="number" min="1" max="10" step="1" value="3"/);
    assert.match(markup, /value="solve_close">自动打码，完成后关闭<\/option>/);
    assert.match(markup, /每账号最多打码次数（含首次）/);
    assert.match(markup, /每个账号独立计次 · 通过即停止重试/);
    assert.match(markup, /10 个需打码账号最多共 30 次/);
    assert.match(markup, /不能绕过短信验证码、设备通知/);
    assert.match(markup, /保存不启用付费服务/);
    h.el("capsolverKey").value = FIXTURE_KEY;
    h.el("capsolverKey").events.input();
    assert.strictEqual(h.el("capsolverSaveBtn").disabled, false);
    await h.el("capsolverSaveBtn").events.click();
    assert.strictEqual(h.el("capsolverEnabled").checked, false);
    assert.strictEqual(h.el("capsolverKey").value, "");
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "已保存到本机");
    assert.strictEqual(h.el("capsolverSaveBtn").textContent, "更换");
    assert.strictEqual(h.el("capsolverClearBtn").disabled, false);
    assert.match(h.el("capsolverKey").placeholder, /已保存/);
    assert.ok(!JSON.stringify([...h.storage]).includes(FIXTURE_KEY));
  });

  check("CAPSOLVER 界面：严格校验每账号整数次数，关闭时不读取或发送残留密钥", () => {
    const h = harness();
    h.enable();
    for (const value of ["", "0", "-1", "1.5", "11", "NaN", "Infinity"]) {
      h.el("capsolverMaxTasks").value = value;
      assert.throws(() => h.readCapsolverForm(["login"], null), /1–10/);
    }
    for (const maxAttemptsPerAccount of [1, 10]) {
      h.el("capsolverMaxTasks").value = String(maxAttemptsPerAccount);
      assert.deepStrictEqual(h.readCapsolverForm(["login"], null), { enabled: true, maxAttemptsPerAccount });
    }
    assert.deepStrictEqual(h.readCapsolverForm(["login", "detect-ban", "detect-region"], null), { enabled: true, maxAttemptsPerAccount: 10 });
    assert.throws(() => h.readCapsolverForm(["login", "check-password"], null), /不支持.*验证账号密码/);
    assert.throws(() => h.readCapsolverForm(["login"], { enabled: true }), /不支持代理/);
    h.el("capsolverEnabled").checked = false;
    assert.strictEqual(h.readCapsolverForm(["change-2fa"], { enabled: true }), null);
  });

  check("CAPSOLVER 界面：旧整批额度恢复为每账号默认3次，保留开关且不放大旧额度", () => {
    for (const enabled of [true, false]) {
      for (const maxTasks of [1, 2, 100]) {
        const storage = new Map([[PREFERENCES_KEY, JSON.stringify({ enabled, maxTasks })]]);
        const h = harness({ storage });
        assert.strictEqual(h.el("capsolverEnabled").checked, enabled);
        assert.strictEqual(h.el("capsolverMaxTasks").value, "3");
        h.el("capsolverMaxTasks").events.change();
        assert.deepStrictEqual(JSON.parse(storage.get(PREFERENCES_KEY)), { enabled, maxAttemptsPerAccount: 3 });
      }
    }
    for (const value of [0, 11, 1.5, "3", null]) {
      const storage = new Map([[PREFERENCES_KEY, JSON.stringify({ enabled: true, maxAttemptsPerAccount: value })]]);
      assert.strictEqual(harness({ storage }).el("capsolverMaxTasks").value, "3");
    }
  });

  await checkAsync("CAPSOLVER 界面：缺少登录、密码检测、代理和缺少密钥在提交前拦截", async () => {
    for (const [update, expected] of [
      [(h) => { h.config.actionIds = ["detect-ban"]; }, /登录账号/],
      [(h) => { h.config.actionIds = ["login", "check-password"]; }, /不支持.*验证账号密码/],
      [(h) => { h.config.mode = "adspower"; }, /本机浏览器/],
      [(h) => { h.el("capsolverKey").value = "   "; }, /请先输入并保存/],
      [(h) => { h.el("capsolverMaxTasks").value = "11"; }, /1–10/],
    ]) {
      const h = harness();
      h.enable();
      update(h);
      await h.startJob(["fixture-account"]);
      assert.strictEqual(h.requests.length, 0);
      assert.match(h.el("runStatus").textContent, expected);
    }
  });

  await checkAsync("CAPSOLVER 界面：自动打码策略复用已保存密钥、允许登录后的动作，并在退出后恢复开关", async () => {
    const storage = new Map([
      [PREFERENCES_KEY, JSON.stringify({ enabled: false, maxAttemptsPerAccount: 3 })],
      [FLAGS_KEY, JSON.stringify({ randomFp: true, clearData: true, keepOpen: true, manualChallengePolicy: "close" })],
    ]);
    const server = { configured: true };
    const first = harness({ storage, server });
    await first.loadCapsolverSettings();
    assert.strictEqual(first.el("capsolverEnabled").checked, false);
    assert.strictEqual(first.el("keepOpen").checked, true);

    first.setPolicy("solve_close");
    assert.strictEqual(first.el("capsolverEnabled").checked, true);
    assert.strictEqual(first.el("capsolverEnabled").disabled, true);
    assert.strictEqual(first.el("keepOpen").checked, false);
    assert.strictEqual(first.el("keepOpen").disabled, true);
    assert.strictEqual(JSON.parse(storage.get(FLAGS_KEY)).manualChallengePolicy, "solve_close");

    // 刷新后第三项仍恢复；强制显示不能改写用户原本关闭 CAPSOLVER、开启普通保留的偏好。
    const refreshed = harness({ storage, server });
    await refreshed.loadCapsolverSettings();
    assert.strictEqual(refreshed.el("manualChallengePolicy").value, "solve_close");
    assert.strictEqual(refreshed.el("capsolverEnabled").checked, true);
    assert.strictEqual(refreshed.el("capsolverEnabled").disabled, true);
    assert.strictEqual(refreshed.el("keepOpen").checked, false);
    assert.strictEqual(refreshed.el("keepOpen").disabled, true);
    refreshed.config.actionIds = ["login", "detect-ban", "detect-region"];
    await refreshed.startJob(["fixture-account"]);
    assert.strictEqual(refreshed.requests.length, 2, "已保存密钥应直接运行，不再 PUT 密钥");
    const body = JSON.parse(refreshed.requests[1].body);
    assert.deepStrictEqual(body.actionIds, ["login", "detect-ban", "detect-region"]);
    assert.deepStrictEqual(body.captchaSolver, { enabled: true, maxAttemptsPerAccount: 3 });
    assert.strictEqual(body.manualChallengePolicy, "solve_close");
    assert.strictEqual(body.keepOpen, false, "自动打码并关闭必须覆盖普通保留");
    assert.deepStrictEqual(JSON.parse(storage.get(PREFERENCES_KEY)), { enabled: false, maxAttemptsPerAccount: 3 });
    assert.strictEqual(JSON.parse(storage.get(FLAGS_KEY)).keepOpen, true);

    refreshed.finish();
    refreshed.setPolicy("close");
    assert.strictEqual(refreshed.el("capsolverEnabled").checked, false);
    assert.strictEqual(refreshed.el("capsolverEnabled").disabled, false);
    assert.strictEqual(refreshed.el("keepOpen").checked, true);
    assert.strictEqual(refreshed.el("keepOpen").disabled, false);
  });

  await checkAsync("CAPSOLVER 界面：自动打码策略缺少登录时明确拦截且不代选动作", async () => {
    const h = harness({ server: { configured: true } });
    await h.loadCapsolverSettings();
    h.setPolicy("solve_close");
    h.config.actionIds = ["detect-ban", "detect-region"];
    const before = [...h.config.actionIds];
    await h.startJob(["fixture-account"]);
    assert.deepStrictEqual(h.config.actionIds, before);
    assert.strictEqual(h.requests.length, 1, "缺少登录时不得发起任务或调用付费服务");
    assert.match(h.el("runStatus").textContent, /登录账号.*不会自动添加/);
  });

  await checkAsync("CAPSOLVER 界面：单独添加身份验证器支持手动开关和自动打码策略，不额外勾选登录", async () => {
    for (const policy of ["close", "solve_close"]) {
      const h = harness({ server: { configured: true } });
      await h.loadCapsolverSettings();
      if (policy === "solve_close") h.setPolicy(policy);
      else h.enable(false);
      h.config.actionIds = ["add-2fa"];
      h.el("capsolverMaxTasks").value = "4";
      await h.startJob(["fixture-account"]);
      assert.strictEqual(h.requests.length, 2);
      assert.strictEqual(h.requests[1].url, "/api/automation/run");
      const body = JSON.parse(h.requests[1].body);
      assert.deepStrictEqual(body.actionIds, ["add-2fa"]);
      assert.deepStrictEqual(h.config.actionIds, ["add-2fa"]);
      assert.deepStrictEqual(body.captchaSolver, { enabled: true, maxAttemptsPerAccount: 4 });
      assert.strictEqual(body.manualChallengePolicy, policy);
      if (policy === "solve_close") assert.strictEqual(body.keepOpen, false);
      assert.ok(!h.requests.some((request) => request.method === "PUT"), "复用已保存配置，不更换默认密钥");
    }
    assert.match(markup, /内部登录及重新验证共享该账号的次数/);
  });

  await checkAsync("CAPSOLVER 界面：添加身份验证器混选及其他独立操作仍在提交前拒绝", async () => {
    for (const policy of ["close", "solve_close"]) {
      for (const actionIds of [
        ["add-2fa", "login"], ["login", "add-2fa"], ["add-2fa", "detect-ban"],
        ["add-2fa", "check-password"], ["change-2fa"], ["detect-region"], ["check-password"],
      ]) {
        const h = harness({ server: { configured: true } });
        await h.loadCapsolverSettings();
        if (policy === "solve_close") h.setPolicy(policy);
        else h.enable(false);
        h.config.actionIds = [...actionIds];
        await h.startJob(["fixture-account"]);
        assert.strictEqual(h.requests.length, 1, "无效操作组合不能发起运行请求");
        assert.deepStrictEqual(h.config.actionIds, actionIds);
        assert.match(h.el("runStatus").textContent, actionIds.includes("add-2fa")
          ? /须单独运行/ : /登录账号.*单独选择.*添加身份验证器/);
      }
    }
  });

  await checkAsync("CAPSOLVER 界面：保存密钥有延迟时锁定策略，并按启动快照提交自动打码关窗", async () => {
    const h = harness();
    h.setPolicy("solve_close");
    h.config.actionIds = ["login", "detect-ban"];
    h.el("capsolverKey").value = FIXTURE_KEY;
    h.el("capsolverKey").events.input();
    const pendingSave = deferred();
    h.responses.push(pendingSave.promise);
    const starting = h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 1);
    assert.strictEqual(h.requests[0].url, "/api/settings/capsolver");
    assert.strictEqual(h.el("manualChallengePolicy").disabled, true);
    assert.strictEqual(h.el("keepOpen").disabled, true);
    // 模拟脚本强改 DOM；真实用户已被禁用，提交仍必须使用点击运行时的快照。
    h.el("manualChallengePolicy").value = "keep";
    h.el("keepOpen").checked = true;
    pendingSave.resolve({ configured: true });
    await starting;
    assert.strictEqual(h.requests.length, 2);
    const body = JSON.parse(h.requests[1].body);
    assert.strictEqual(body.manualChallengePolicy, "solve_close");
    assert.strictEqual(body.keepOpen, false);
    assert.deepStrictEqual(body.captchaSolver, { enabled: true, maxAttemptsPerAccount: 3 });
    assert.deepStrictEqual(body.actionIds, ["login", "detect-ban"]);
    assert.ok(h.requests.every((request) => !(request.body || "").includes(FIXTURE_KEY)
      || request.url === "/api/settings/capsolver"));
  });

  await checkAsync("CAPSOLVER 界面：先保存再启动，后续批次和刷新沿用密钥、开关及上限", async () => {
    const h = harness();
    h.enable();
    h.el("capsolverMaxTasks").value = "2";
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 2);
    assert.strictEqual(h.requests[0].url, "/api/settings/capsolver");
    assert.strictEqual(h.requests[0].method, "PUT");
    assert.deepStrictEqual(JSON.parse(h.requests[0].body), { apiKey: FIXTURE_KEY });
    const first = h.requests[1];
    assert.strictEqual(first.url, "/api/automation/run");
    assert.strictEqual(first.method, "POST");
    assert.deepStrictEqual(JSON.parse(first.body).captchaSolver, { enabled: true, maxAttemptsPerAccount: 2 });
    assert.ok(!first.body.includes(FIXTURE_KEY));
    assert.ok(!JSON.stringify(first.headers).includes(FIXTURE_KEY));
    assert.strictEqual(h.el("capsolverEnabled").checked, true);
    assert.strictEqual(h.el("capsolverKey").value, "");
    assert.strictEqual(h.el("capsolverMaxTasks").value, "2");
    assert.ok([...h.elements.values()].every((element) => !element.textContent.includes(FIXTURE_KEY)));
    h.finish();
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 3);
    assert.deepStrictEqual(JSON.parse(h.requests[2].body).captchaSolver, { enabled: true, maxAttemptsPerAccount: 2 });
    assert.ok(!h.requests[2].body.includes(FIXTURE_KEY));
    const refreshed = harness({ storage: h.storage, server: h.server });
    await refreshed.loadCapsolverSettings();
    assert.strictEqual(refreshed.el("capsolverEnabled").checked, true);
    assert.strictEqual(refreshed.el("capsolverMaxTasks").value, "2");
    assert.strictEqual(refreshed.el("capsolverKey").value, "");
    await refreshed.startJob(["fixture-account"]);
    assert.deepStrictEqual(JSON.parse(refreshed.requests[1].body).captchaSolver, { enabled: true, maxAttemptsPerAccount: 2 });
    assert.ok(refreshed.requests.every((r) => !(r.body || "").includes(FIXTURE_KEY)));
    assert.deepStrictEqual(JSON.parse(h.storage.get(PREFERENCES_KEY)), { enabled: true, maxAttemptsPerAccount: 2 });
    assert.ok(!JSON.stringify([...h.storage]).includes(FIXTURE_KEY));
  });

  await checkAsync("CAPSOLVER 界面：保存失败阻止启动，不输出密钥或自动重试", async () => {
    const h = harness();
    h.enable();
    h.failures.push(new Error(`fixture error ${FIXTURE_KEY}`));
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 1);
    assert.strictEqual(h.requests[0].method, "PUT");
    assert.match(h.el("runStatus").textContent, /启动失败/);
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "保存失败，请重试");
    assert.ok([...h.elements.values()].every((element) => !element.textContent.includes(FIXTURE_KEY)));
    assert.strictEqual(h.el("capsolverKey").value, FIXTURE_KEY);
    assert.strictEqual(h.el("capsolverEnabled").checked, true);
  });

  await checkAsync("CAPSOLVER 界面：已保存配置启动失败仍可重试，关闭时不发送或保存残留输入", async () => {
    const h = harness({ server: { configured: true } });
    await h.loadCapsolverSettings();
    h.enable(false);
    h.failures.push(new Error(`fixture error ${FIXTURE_KEY}`));
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 2);
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "已保存到本机");
    assert.match(h.el("runStatus").textContent, /启动失败/);
    assert.strictEqual(h.el("capsolverEnabled").checked, true);
    assert.ok([...h.elements.values()].every((element) => !element.textContent.includes(FIXTURE_KEY)));
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 3);
    h.finish();
    h.el("capsolverKey").value = FIXTURE_KEY;
    h.el("capsolverEnabled").checked = false;
    h.el("capsolverEnabled").events.change();
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 4);
    assert.strictEqual(JSON.parse(h.requests[3].body).captchaSolver, null);
    assert.ok(h.requests.every((r) => !(r.body || "").includes(FIXTURE_KEY)));
  });

  await checkAsync("CAPSOLVER 界面：清除已保存密钥后禁止空配置启动，失败可重试", async () => {
    const h = harness({ server: { configured: true } });
    await h.loadCapsolverSettings();
    h.enable(false);
    h.failures.push(new Error(`fixture error ${FIXTURE_KEY}`));
    await h.clearCapsolverKey();
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "清除失败，请重试");
    assert.strictEqual(h.el("capsolverClearBtn").disabled, false);
    assert.deepStrictEqual(h.readCapsolverForm(["login"], null), { enabled: true, maxAttemptsPerAccount: 3 });
    await h.el("capsolverClearBtn").events.click();
    assert.strictEqual(h.server.configured, false);
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "未配置");
    assert.strictEqual(h.el("capsolverClearBtn").disabled, true);
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 3);
    assert.match(h.el("runStatus").textContent, /请先输入并保存/);
    assert.ok([...h.elements.values()].every((element) => !element.textContent.includes(FIXTURE_KEY)));
  });

  await checkAsync("CAPSOLVER 界面：配置读取及历史恢复保留未保存输入，读取失败不假报已保存", async () => {
    const h = harness({ server: { configured: true } });
    const pending = deferred();
    h.responses.push(pending.promise);
    const loading = h.loadCapsolverSettings();
    h.el("capsolverKey").value = FIXTURE_KEY;
    pending.resolve({ configured: true });
    await loading;
    assert.strictEqual(h.el("capsolverKey").value, FIXTURE_KEY);
    h.enable(false);
    await h.restorePage();
    assert.strictEqual(h.el("capsolverKey").value, FIXTURE_KEY);
    assert.strictEqual(h.el("capsolverEnabled").checked, true);
    h.failures.push(new Error(`fixture error ${FIXTURE_KEY}`));
    await h.loadCapsolverSettings();
    assert.match(h.el("capsolverKeyStatus").textContent, /读取失败/);
    assert.strictEqual(h.el("capsolverKey").value, FIXTURE_KEY);
    assert.ok([...h.elements.values()].every((element) => !element.textContent.includes(FIXTURE_KEY)));
    h.el("capsolverKey").value = "";
    assert.throws(() => h.readCapsolverForm(["login"], null), /请先输入并保存/);
    await h.loadCapsolverSettings();
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "已保存到本机");
  });

  await checkAsync("CAPSOLVER 界面：旧读取响应不能覆盖新保存，保存中阻止重复启动", async () => {
    const h = harness();
    const pendingRead = deferred(), pendingSave = deferred();
    h.responses.push(pendingRead.promise);
    const loading = h.loadCapsolverSettings();
    h.enable();
    h.responses.push(pendingSave.promise);
    const saving = h.saveCapsolverKey();
    assert.strictEqual(h.el("capsolverSaveBtn").disabled, true);
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 2);
    assert.match(h.el("runStatus").textContent, /正在保存/);
    pendingSave.resolve({ configured: true });
    await saving;
    pendingRead.resolve({ configured: false });
    await loading;
    assert.strictEqual(h.el("capsolverKeyStatus").textContent, "已保存到本机");
    assert.strictEqual(h.el("capsolverKey").value, "");
    assert.deepStrictEqual(h.readCapsolverForm(["login"], null), { enabled: true, maxAttemptsPerAccount: 3 });
  });

  await checkAsync("CAPSOLVER 界面：启动期间锁定配置，避免密钥在请求前被清除或更换", async () => {
    const h = harness({ server: { configured: true } });
    await h.loadCapsolverSettings();
    h.enable(false);
    const pendingRun = deferred();
    h.responses.push(pendingRun.promise);
    const starting = h.startJob(["fixture-account"]);
    for (const id of ["manualChallengePolicy", "keepOpen", "capsolverEnabled", "capsolverKey", "capsolverMaxTasks", "capsolverSaveBtn", "capsolverClearBtn"]) {
      assert.strictEqual(h.el(id).disabled, true);
    }
    await h.clearCapsolverKey();
    assert.strictEqual(h.requests.length, 2);
    pendingRun.resolve({ jobId: "fixture-job", job: { tasks: [] } });
    await starting;
    assert.strictEqual(h.el("capsolverKey").disabled, false);
    assert.strictEqual(h.el("capsolverEnabled").disabled, false);
    assert.strictEqual(h.el("manualChallengePolicy").disabled, false);
    assert.strictEqual(h.el("keepOpen").disabled, false);
    assert.strictEqual(h.el("capsolverClearBtn").disabled, false);
  });

  check("CAPSOLVER 进度：仅固定公开状态标签，不渲染任意元数据", () => {
    const render = new Function(`${extract("function captchaProgressHtml(", "// 判定一个账号 task")}\nreturn captchaProgressHtml;`)();
    for (const state of ["inspecting", "solving", "processing", "ready", "submitted", "accepted", "failed", "retrying"]) {
      const html = render({ state, apiKey: FIXTURE_KEY, solution: "fixture-solution", error: "<script>fixture</script>" });
      assert.match(html, /CAPSOLVER/);
      assert.ok(!html.includes(FIXTURE_KEY));
      assert.ok(!html.includes("fixture"));
    }
    for (const captcha of [null, {}, { state: "__proto__" }, { state: "<script>fixture</script>" }]) {
      assert.strictEqual(render(captcha), "");
    }
  });

  check("CAPSOLVER 进度：按账号展示真实调用次数和重试状态，忽略无效计数", () => {
    const render = new Function(`${extract("function captchaProgressHtml(", "// 判定一个账号 task")}\nreturn captchaProgressHtml;`)();
    assert.match(render({ state: "retrying", attempted: 1, maxAttemptsPerAccount: 3 }), /准备重试 · 本账号已调用 1\/3 次/);
    assert.match(render({ state: "accepted", attempted: 2, maxAttemptsPerAccount: 3 }), /已通过 · 本账号已调用 2\/3 次/);
    assert.match(render({ state: "failed", attempted: 3, maxAttemptsPerAccount: 3 }), /未完成 · 本账号已调用 3\/3 次/);
    assert.ok(!render({ state: "direct_passed", attempted: 0, maxAttemptsPerAccount: 3 }).includes("本账号已调用"));
    for (const extra of [
      { attempted: -1, maxAttemptsPerAccount: 3 }, { attempted: 4, maxAttemptsPerAccount: 3 },
      { attempted: "<script>fixture</script>", maxAttemptsPerAccount: 3 },
      { attempted: 1, maxAttemptsPerAccount: 11 }, { attempted: 1, maxAttemptsPerAccount: "3" },
    ]) {
      const html = render({ state: "retrying", ...extra });
      assert.ok(!html.includes("本账号已调用"));
      assert.ok(!html.includes("fixture"));
    }
  });

  check("人机复选框进度：免费路径有独立标签，不冒报付费调用", () => {
    const render = new Function(`${extract("function captchaProgressHtml(", "// 判定一个账号 task")}\nreturn captchaProgressHtml;`)();
    const labels = {
      checking: "检查复选框", clicked: "已点击一次，等待结果",
      checkbox_passed: "复选框已通过，确认下一步", challenge: "出现挑战，准备打码",
      direct_passed: "直接通过 · 未调用打码",
    };
    for (const [state, label] of Object.entries(labels)) {
      const html = render({ state, apiKey: FIXTURE_KEY, token: "fixture-secret-token", method: "<script>fixture</script>" });
      assert.ok(html.includes(`>人机验证 · ${label}</span>`));
      assert.ok(!html.includes("CAPSOLVER"));
      assert.ok(!html.includes("fixture"));
      assert.ok(!html.includes(FIXTURE_KEY));
    }
    assert.match(markup, /先点一次复选框，直接通过不调用打码/);
    assert.match(markup, /只有实际出现支持的挑战时才向 CAPSOLVER/);
    assert.match(markup, /人机通过后继续登录和所选操作，需手机号或短信时仍停止/);
  });

  check("人机复选框事件：直接通过更新进度，不计付费尝试或就绪数", () => {
    const engine = fs.readFileSync(path.join(__dirname, "../src/automation/engine.js"), "utf8");
    const start = engine.indexOf("    const captchaStates = {");
    const end = engine.indexOf("    task.events.push({", start);
    assert.ok(start >= 0 && end > start);
    const update = new Function("type", "task", "job", "data", "accountCaptchaSolver", engine.slice(start, end));
    const task = {};
    const job = { captchaSolver: {} };
    const counters = { attempted: 0, ready: 0, failed: 0, maxAttemptsPerAccount: 3 };
    const accountSolver = { summary: () => ({ ...counters }) };
    const events = {
      captcha_checkbox_checking: "checking", captcha_checkbox_clicked: "clicked",
      captcha_checkbox_passed: "checkbox_passed", captcha_checkbox_challenge: "challenge",
      captcha_accepted: "accepted", captcha_free_accepted: "direct_passed",
    };
    for (const [event, state] of Object.entries(events)) {
      update(event, task, job, {}, accountSolver);
      assert.strictEqual(task.captcha.state, state);
      assert.strictEqual(task.captcha.attempted, 0);
      assert.strictEqual(task.captcha.ready, 0);
      assert.strictEqual(task.captcha.failed, 0);
    }
    update("captcha_solving", task, job, {}, accountSolver);
    assert.strictEqual(task.captcha.attempted, 0, "准备打码不能冒充已调用");
    assert.strictEqual(task.captcha.state, "solving");
    counters.attempted = 1;
    update("capsolver_attempt", task, job, {}, accountSolver);
    assert.strictEqual(task.captcha.attempted, 1);
    counters.failed = 1;
    update("captcha_retrying", task, job, {}, accountSolver);
    assert.strictEqual(task.captcha.state, "retrying");
    assert.strictEqual(task.captcha.attempted, 1, "等待重试不多记一次调用");
    counters.attempted = 2;
    counters.ready = 1;
    update("capsolver_ready", task, job, {}, accountSolver);
    assert.strictEqual(task.captcha.attempted, 2);
    assert.strictEqual(task.captcha.ready, 1);
    update("captcha_failed", task, job, {}, accountSolver);
    assert.strictEqual(task.captcha.failed, 1, "终止事件不能重复计入云端失败次数");
    const disabledTask = {};
    update("captcha_checkbox_checking", disabledTask, {}, {}, accountSolver);
    assert.strictEqual(disabledTask.captcha, undefined);
  });

  check("CAPSOLVER 诊断：回调来源、调用状态与 data-s 存在性仅显示固定悬停文字", () => {
    const render = new Function(`${extract("function captchaProgressHtml(", "// 判定一个账号 task")}\nreturn captchaProgressHtml;`)();
    for (const [callbackSource, label] of [["explicit", "显式"], ["observed", "程序注册"], ["none", "未发现"]]) {
      for (const callbackInvoked of [true, false]) {
        const html = render({ state: "submitted", callbackSource, callbackInvoked, hasDataS: true });
        assert.ok(html.includes(`title="回调：${label}；${callbackInvoked ? "已调用" : "未调用"}；data-s：有"`));
        assert.ok(html.includes(">CAPSOLVER · 已提交</span>"));
      }
    }
    assert.ok(render({ state: "ready", callbackSource: "none", callbackInvoked: false, hasDataS: false })
      .includes('title="回调：未发现；未调用；data-s：无"'));
    assert.ok(!render({ state: "ready" }).includes("title="), "旧任务没有诊断字段时不冒报来源或调用情况");
  });

  check("CAPSOLVER 诊断：无效枚举和任意原始参数、密钥、token、URL、账号均不渲染", () => {
    const render = new Function(`${extract("function captchaProgressHtml(", "// 判定一个账号 task")}\nreturn captchaProgressHtml;`)();
    const raw = {
      state: "failed", callbackSource: "observed", callbackInvoked: "fixture-callback-value",
      hasDataS: "fixture-data-s-presence", dataS: "fixture-data-s-secret", apiKey: FIXTURE_KEY,
      token: "fixture-token", websiteURL: "https://fixture.invalid/?secret=fixture",
      email: "fixture@example.invalid", callbackName: '<script>fixture</script>',
    };
    const html = render(raw);
    assert.ok(html.includes('title="回调：程序注册；未调用"'));
    assert.ok(!html.includes("fixture"));
    assert.ok(!html.includes(FIXTURE_KEY));
    for (const callbackSource of ["__proto__", "constructor", '<script>fixture</script>']) {
      const invalid = render({ ...raw, callbackSource });
      assert.ok(!invalid.includes("title="));
      assert.ok(!invalid.includes("fixture"));
    }
  });
};
