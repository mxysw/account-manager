"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Isolated UI fixture: no browser, AdsPower process, real API key, or account data.
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const markup = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const start = source.indexOf("let adspowerConfigured = false;");
const end = source.indexOf("// 记住批量运行偏好", start);
assert.ok(start >= 0 && end > start, "AdsPower settings controller must be present");
const controllerSource = source.slice(start, end);
const FIXTURE_KEY = "ADSPOWER-FIXTURE-NOT-A-REAL-KEY";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(initial = {}) {
  const elements = new Map(), events = new Map(), requests = [];
  const server = {
    configured: !!initial.configured,
    address: initial.address || "127.0.0.1",
    port: initial.port || 50325,
  };
  const effects = { envLoads: 0, tagLoads: 0, renders: 0, resets: 0 };
  let mode = initial.mode || "local";
  let testResponse = { ok: true };
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", disabled: false, hidden: false, events: {},
      addEventListener(type, fn) { this.events[type] = fn; },
    });
    return elements.get(id);
  };
  el("adspowerAddress").value = "127.0.0.1";
  el("adspowerPort").value = "50325";
  const api = async (url, options = {}) => {
    requests.push({ url, ...options });
    assert.ok(!url.includes(FIXTURE_KEY), "API key must never appear in request URL");
    if (url === "/api/settings/adspower") {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        assert.deepStrictEqual(Object.keys(body).sort(), ["address", "apiKey", "port"]);
        assert.strictEqual(body.address, "127.0.0.1");
        if (body.apiKey) assert.strictEqual(body.apiKey, FIXTURE_KEY);
        server.configured = !!(body.apiKey || server.configured);
        server.address = body.address;
        server.port = body.port;
      } else if (options.method === "DELETE") {
        server.configured = false;
        server.address = "127.0.0.1";
        server.port = 50325;
      }
      return { configured: server.configured, address: server.address, port: server.port };
    }
    assert.strictEqual(url, "/api/settings/adspower/test");
    assert.strictEqual(options.method, "POST");
    assert.strictEqual(options.body, undefined, "test must use only the server-side saved key");
    if (testResponse instanceof Error) throw testResponse;
    return testResponse;
  };
  const deps = {
    el, api,
    syncRunButton: () => {},
    window: { addEventListener(type, fn) { events.set(type, fn); } },
    currentMode: () => mode,
    loadEnvs: () => { effects.envLoads += 1; },
    maybeAutoLoadTags: () => { effects.tagLoads += 1; },
    renderEnvs: () => { effects.renders += 1; },
    resetAdspowerEnvironments: () => { effects.resets += 1; },
  };
  const controller = new Function(...Object.keys(deps), `
    let jobStarting = false, proxyTagsLoaded = false, envProfiles = [];
    ${controllerSource}
    return { loadAdspowerSettings, saveAdspowerSettings, clearAdspowerSettings,
      testAdspowerConnection, syncAdspowerSettingsButtons, normalizeAdspowerAddress };
  `)(...Object.values(deps));
  const visibilityStart = source.indexOf("function syncModeVisibility() {");
  const visibilityEnd = source.indexOf("function saveMode()", visibilityStart);
  assert.ok(visibilityStart >= 0 && visibilityEnd > visibilityStart);
  const visibility = new Function("el", "currentMode", "syncProxyVisibility", `
    ${source.slice(visibilityStart, visibilityEnd)}
    return syncModeVisibility;
  `)(el, () => mode, () => {});
  return {
    ...controller, el, server, effects, events, requests, visibility,
    setMode(value) { mode = value; },
    setTestResponse(value) { testResponse = value; },
    edit(id, value) { el(id).value = value; el(id).events.input(); },
  };
}

function temporaryRunHarness(mode = "adspower_temp") {
  const elements = new Map(), requests = [];
  const config = { mode, configured: true, envsReady: false };
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, textContent: "" });
    return elements.get(id);
  };
  el("manualChallengePolicy").value = "close";
  el("maxConcurrent").value = "4";
  el("randomFp").checked = true;
  el("clearData").checked = true;
  const first = source.indexOf("async function startJob(");
  const last = source.indexOf('el("runBtn").addEventListener', first);
  assert.ok(first >= 0 && last > first);
  const deps = {
    el, currentMode: () => config.mode,
    document: { querySelectorAll: () => [{ value: "fixture-action" }] },
    readProxyForm: () => ({ enabled: true, mode: "pool", tagId: "fixture-tag" }),
    readCapsolverForm: () => undefined, readPhoneRunMode: () => "shared",
    saveCapsolverPreferences: () => {}, syncRunButton: () => {},
    syncCapsolverVisibility: () => {}, persistJobHandles: () => {},
    renderJob: () => {}, pollJob: () => {}, toast: () => {},
    api: async (url, options) => {
      assert.strictEqual(url, "/api/automation/run");
      requests.push(JSON.parse(options.body));
      return { jobId: "fixture-job", job: { tasks: [] } };
    },
  };
  const controller = new Function(...Object.keys(deps), `
    let appReady = true, jobStarting = false, jobId = null, cancelInFlight = false;
    let adspowerSettingsLoaded = true, adspowerConfigured = true, adspowerSettingsBusy = false;
    let adspowerEnvsReady = false;
    let closeTargetId = null, trackedJob = null, cancelIntent = false;
    let cancelError = "", jobPollError = "", jobStateEpoch = 0;
    const envSelected = new Set(["old-serial"]), accounts = [], jobManualExpand = new Map();
    ${source.slice(first, last)}
    return { startJob, setConfigured: (value) => { adspowerConfigured = value; },
      setEnvsReady: (value) => { adspowerEnvsReady = value; } };
  `)(...Object.values(deps));
  return { ...controller, el, config, requests };
}

function temporaryKeepOpenHarness(storage = new Map()) {
  const elements = new Map(), config = { mode: "local" };
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, disabled: false, placeholder: "", textContent: "", events: {},
      addEventListener(type, fn) { this.events[type] = fn; },
    });
    return elements.get(id);
  };
  el("manualChallengePolicy").value = "close";
  const first = source.indexOf("// 记住批量运行偏好");
  const last = source.indexOf("// ---- CAPSOLVER", first);
  const capStart = source.indexOf("function solveAndCloseSelected()");
  const capEnd = source.indexOf("function saveCapsolverPreferences()", capStart);
  assert.ok(first >= 0 && last > first && capStart >= 0 && capEnd > capStart);
  const deps = {
    el, LS: { flags: "fixture-flags" },
    localStorage: { getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value) },
    currentMode: () => config.mode,
  };
  const controller = new Function(...Object.keys(deps), `
    let capsolverEnabledPreference = false, capsolverSettingsBusy = false;
    let capsolverConfigured = false, capsolverSettingsLoaded = true, jobStarting = false;
    ${source.slice(first, last)}
    ${source.slice(capStart, capEnd)}
    return { syncCapsolverVisibility };
  `)(...Object.values(deps));
  controller.syncCapsolverVisibility();
  return { ...controller, el, config, storage };
}

function environmentHarness() {
  const elements = new Map(), storage = new Map([["am_envs", '["old-serial"]']]);
  const requests = [];
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, disabled: false, innerHTML: "", textContent: "", events: {},
      addEventListener(type, fn) { this.events[type] = fn; },
    });
    return elements.get(id);
  };
  const first = source.indexOf("// ---- 窗口（环境）选择 ----");
  const last = source.indexOf("async function loadActions()", first);
  assert.ok(first >= 0 && last > first);
  const deps = {
    el, LS: { envs: "am_envs" },
    loadSet: (key) => new Set(JSON.parse(storage.get(key) || "[]")),
    saveSet: (key, set) => storage.set(key, JSON.stringify([...set])),
    escapeHtml: (value) => String(value).replace(/[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])),
    syncRunButton: () => {},
    api: async (url) => {
      assert.strictEqual(url, "/api/automation/envs");
      const pending = deferred();
      requests.push(pending);
      return pending.promise;
    },
  };
  const controller = new Function(...Object.keys(deps), `
    let adspowerConfigured = true, adspowerEnvsReady = false;
    ${source.slice(first, last)}
    return { resetAdspowerEnvironments, loadEnvs,
      state: () => ({ ready: adspowerEnvsReady, profiles: envProfiles, selected: [...envSelected] }) };
  `)(...Object.values(deps));
  return { ...controller, el, storage, requests };
}

module.exports = async function runAdspowerUiTests({ check, checkAsync }) {
  check("AdsPower 连接表单只在 AdsPower 模式展示，并含地址、端口、密钥和连接测试", () => {
    assert.match(markup, /value="adspower" \/> AdsPower（复用现有环境）<\/label>/);
    assert.match(markup, /id="apiKeyField" hidden/);
    assert.match(markup, /id="adspowerAddress" type="text" value="127\.0\.0\.1"/);
    assert.match(markup, /id="adspowerPort" type="number" min="1" max="65535"/);
    assert.match(markup, /id="apiKey" type="password" autocomplete="off"/);
    assert.match(markup, /id="adspowerTestBtn"[^>]*disabled>测试连接<\/button>/);
    assert.match(markup, /仅连接本机/);
    const h = harness();
    h.visibility();
    assert.strictEqual(h.el("apiKeyField").hidden, true);
    h.setMode("adspower");
    h.visibility();
    assert.strictEqual(h.el("apiKeyField").hidden, false);
  });

  check("AdsPower 临时环境单独选项共用连接，隐藏旧窗口与指纹代理选项", () => {
    assert.match(markup, /value="adspower_temp" \/> AdsPower 临时环境<\/label>/);
    assert.match(markup, /id="adspowerTempHint" hidden/);
    assert.match(markup, /按「最大并发」创建空白临时环境/);
    assert.match(markup, /普通跑完默认不保留/);
    assert.match(markup, /成功关闭后才移入 AdsPower 回收站，关闭失败不删除/);
    assert.match(markup, /回收站需你手动永久清空/);
    const h = harness();
    h.setMode("adspower_temp");
    h.visibility();
    assert.strictEqual(h.el("apiKeyField").hidden, false);
    assert.strictEqual(h.el("envField").hidden, true);
    assert.strictEqual(h.el("optRandomFp").hidden, true);
    assert.strictEqual(h.el("optProxy").hidden, true);
    assert.strictEqual(h.el("optClearData").hidden, true);
    assert.strictEqual(h.el("proxyBox").hidden, true);
    assert.strictEqual(h.el("adspowerTempHint").hidden, false);
    assert.strictEqual(h.el("maxConcurrentLabel").textContent, "最大并发");
    h.setMode("adspower");
    h.visibility();
    assert.strictEqual(h.el("envField").hidden, false);
    assert.strictEqual(h.el("optRandomFp").hidden, false);
    assert.strictEqual(h.el("optProxy").hidden, false);
    assert.strictEqual(h.el("adspowerTempHint").hidden, true);
  });

  check("AdsPower 临时环境默认关闭；手动保留不覆盖现有模式偏好", () => {
    const storage = new Map([["fixture-flags", JSON.stringify({ keepOpen: true })]]);
    const h = temporaryKeepOpenHarness(storage);
    assert.strictEqual(h.el("keepOpen").checked, true);
    h.config.mode = "adspower_temp";
    h.syncCapsolverVisibility();
    assert.strictEqual(h.el("keepOpen").checked, false);
    h.el("keepOpen").checked = true;
    h.el("keepOpen").events.change();
    assert.strictEqual(JSON.parse(storage.get("fixture-flags")).keepOpen, true);
    h.config.mode = "adspower";
    h.syncCapsolverVisibility();
    assert.strictEqual(h.el("keepOpen").checked, true);
    const fresh = temporaryKeepOpenHarness(storage);
    fresh.config.mode = "adspower_temp";
    fresh.syncCapsolverVisibility();
    assert.strictEqual(fresh.el("keepOpen").checked, false);
  });

  await checkAsync("AdsPower 设置读取只返回状态，不回填 API Key 或写入浏览器存储", async () => {
    const h = harness({ configured: true, port: 50360 });
    await h.loadAdspowerSettings();
    assert.strictEqual(h.el("adspowerAddress").value, "127.0.0.1");
    assert.strictEqual(h.el("adspowerPort").value, "50360");
    assert.strictEqual(h.el("apiKey").value, "");
    assert.strictEqual(h.el("adspowerTestBtn").disabled, false);
    assert.strictEqual(h.effects.resets, 1);
    assert.deepStrictEqual(h.requests.map((r) => r.url), ["/api/settings/adspower"]);
    assert.match(source, /localStorage\.removeItem\("am_apiKey"\)/);
    assert.doesNotMatch(source, /localStorage\.setItem\("am_apiKey"/);
  });

  await checkAsync("AdsPower 设置校验本机地址并保存，测试只使用服务端已保存配置", async () => {
    const h = harness();
    await h.loadAdspowerSettings();
    assert.strictEqual(h.el("adspowerTestBtn").disabled, true);
    h.edit("adspowerAddress", "https://remote.example.test");
    h.edit("apiKey", FIXTURE_KEY);
    await h.saveAdspowerSettings();
    assert.strictEqual(h.requests.length, 1, "非法地址不得发送保存请求");
    assert.match(h.el("adspowerKeyStatus").textContent, /地址只能是本机/);
    h.edit("adspowerAddress", "localhost");
    h.edit("adspowerPort", "50360");
    await h.saveAdspowerSettings();
    assert.strictEqual(h.requests.length, 2);
    assert.deepStrictEqual(JSON.parse(h.requests[1].body), {
      address: "127.0.0.1", port: 50360, apiKey: FIXTURE_KEY,
    });
    assert.strictEqual(h.el("apiKey").value, "");
    assert.strictEqual(h.el("adspowerAddress").value, "127.0.0.1");
    assert.strictEqual(h.el("adspowerTestBtn").disabled, false);
    assert.strictEqual(h.effects.resets, 2, "读取和保存后都要使旧窗口选择失效");
    assert.strictEqual(h.effects.envLoads, 0, "本机模式保存不得自动加载环境");
    await h.testAdspowerConnection();
    assert.deepStrictEqual(h.requests[2], { url: "/api/settings/adspower/test", method: "POST" });
    assert.match(h.el("adspowerTestStatus").textContent, /本机 API 已连接/);
    assert.match(h.el("adspowerTestStatus").textContent, /密钥权限.*加载窗口/);
    assert.ok(!JSON.stringify(h.requests[2]).includes(FIXTURE_KEY));
  });

  await checkAsync("AdsPower 未保存修改时不能误测旧配置，失败消息不泄漏上游内容", async () => {
    const h = harness({ configured: true });
    await h.loadAdspowerSettings();
    h.edit("adspowerPort", "50360");
    assert.strictEqual(h.el("adspowerTestBtn").disabled, true);
    assert.strictEqual(h.effects.resets, 1);
    assert.match(h.el("adspowerTestStatus").textContent, /先保存后测试/);
    await h.testAdspowerConnection();
    assert.strictEqual(h.requests.length, 1);
    h.edit("adspowerPort", "50325");
    assert.strictEqual(h.el("adspowerTestBtn").disabled, false);
    h.setTestResponse(new Error(`upstream echoed ${FIXTURE_KEY}`));
    await h.testAdspowerConnection();
    assert.match(h.el("adspowerTestStatus").textContent, /连接失败/);
    assert.ok(!h.el("adspowerTestStatus").textContent.includes(FIXTURE_KEY));
    h.edit("apiKey", FIXTURE_KEY);
    assert.strictEqual(h.el("adspowerTestBtn").disabled, true);
  });

  await checkAsync("AdsPower 清除配置后关闭连接测试，密钥留空不送入状态接口", async () => {
    const h = harness({ configured: true, port: 50360 });
    await h.loadAdspowerSettings();
    await h.clearAdspowerSettings();
    assert.deepStrictEqual(h.requests.map((r) => [r.url, r.method]), [
      ["/api/settings/adspower", undefined], ["/api/settings/adspower", "DELETE"],
    ]);
    assert.strictEqual(h.el("apiKey").value, "");
    assert.strictEqual(h.el("adspowerTestBtn").disabled, true);
    assert.strictEqual(h.effects.resets, 2, "清除配置必须清空旧窗口选择");
    assert.strictEqual(h.el("adspowerPort").value, "50325");
    assert.match(h.el("adspowerTestStatus").textContent, /先保存连接/);
  });

  await checkAsync("AdsPower 切换连接后清除旧 serial，忽略旧请求并等待新列表刷新成功", async () => {
    const h = environmentHarness();
    assert.deepStrictEqual(h.state().selected, ["old-serial"]);
    const oldLoad = h.loadEnvs();
    assert.strictEqual(h.state().ready, false);
    h.resetAdspowerEnvironments();
    assert.deepStrictEqual(h.state().selected, []);
    assert.strictEqual(h.storage.get("am_envs"), "[]");
    const newLoad = h.loadEnvs();
    h.requests[0].resolve({ envs: [{ serial: "old-serial", name: "Old" }] });
    await oldLoad;
    assert.deepStrictEqual(h.state().profiles, [], "过期响应不得恢复旧窗口");
    assert.strictEqual(h.state().ready, false, "新列表未返回前不能运行");
    h.requests[1].resolve({ envs: [{ serial: "new-serial", name: "New" }] });
    await newLoad;
    assert.deepStrictEqual(h.state().profiles.map((env) => env.serial), ["new-serial"]);
    assert.deepStrictEqual(h.state().selected, []);
    assert.strictEqual(h.state().ready, true);
  });

  await checkAsync("AdsPower 当前窗口列表未成功刷新时，启动逻辑拒绝旧 serial", async () => {
    const first = source.indexOf("async function startJob(");
    const last = source.indexOf('el("runBtn").addEventListener', first);
    assert.ok(first >= 0 && last > first);
    const status = { textContent: "" };
    const startJob = new Function("el", "currentMode", "toast", `
      let appReady = true, jobStarting = false, jobId = null, cancelInFlight = false;
      let adspowerSettingsLoaded = true, adspowerConfigured = true, adspowerSettingsBusy = false;
      let adspowerEnvsReady = false;
      ${source.slice(first, last)}
      return startJob;
    `)(() => status, () => "adspower", () => {});
    await startJob(["fixture-account"]);
    assert.match(status.textContent, /先成功刷新当前 AdsPower 连接的窗口列表/);
  });

  await checkAsync("AdsPower 临时环境无需旧列表，按最大并发提交空环境且关闭指纹代理", async () => {
    const h = temporaryRunHarness();
    await h.startJob(["fixture-account"]);
    assert.strictEqual(h.requests.length, 1);
    const request = h.requests[0];
    assert.strictEqual(request.mode, "adspower_temp");
    assert.deepStrictEqual(request.envs, []);
    assert.strictEqual(request.maxConcurrent, 4);
    assert.strictEqual(request.randomFp, false);
    assert.strictEqual(request.clearData, false);
    assert.strictEqual(request.proxy, null);
    assert.strictEqual(request.keepOpen, false);
    assert.deepStrictEqual(request.accountIds, ["fixture-account"]);
  });

  await checkAsync("AdsPower 临时环境仍须已保存连接，复用模式仍须勾选旧窗口", async () => {
    const temp = temporaryRunHarness();
    temp.setConfigured(false);
    await temp.startJob(["fixture-account"]);
    assert.strictEqual(temp.requests.length, 0);
    assert.match(temp.el("runStatus").textContent, /请先保存 AdsPower 连接设置/);
    const reuse = temporaryRunHarness("adspower");
    await reuse.startJob(["fixture-account"]);
    assert.strictEqual(reuse.requests.length, 0);
    assert.match(reuse.el("runStatus").textContent, /请先成功刷新当前 AdsPower 连接的窗口列表/);
    reuse.setEnvsReady(true);
    await reuse.startJob(["fixture-account"]);
    assert.deepStrictEqual(reuse.requests[0].envs, ["old-serial"]);
    assert.strictEqual(reuse.requests[0].randomFp, true);
    assert.deepStrictEqual(reuse.requests[0].proxy, { enabled: true, mode: "pool", tagId: "fixture-tag" });
  });
};
