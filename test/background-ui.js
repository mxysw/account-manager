"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pure form/render fixtures: no browser, clipboard, credentials, accounts or network.
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const markup = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing UI section: ${start}`);
  return source.slice(first, last);
}
const FLAGS_KEY = "fixture-flags";
function harness(storage = new Map()) {
  const elements = new Map(), requests = [];
  const config = { mode: "local", awaitSave: false, savePromise: Promise.resolve() };
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, disabled: false, textContent: "", events: {},
      addEventListener(name, handler) { this.events[name] = handler; },
    });
    return elements.get(id);
  };
  el("manualChallengePolicy").value = "close";
  const dependencies = {
    el, LS: { flags: FLAGS_KEY },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    currentMode: () => config.mode,
    document: { querySelectorAll: () => [{ value: "fixture-action" }] },
    readProxyForm: () => ({ enabled: false }), readPhoneRunMode: () => "shared",
    readCapsolverForm: () => config.awaitSave ? { enabled: true } : undefined,
    saveCapsolverKey: () => config.savePromise, saveCapsolverPreferences: () => {},
    syncRunButton: () => {}, persistJobHandles: () => {}, renderJob: () => {}, pollJob: () => {}, toast: () => {},
    api: async (url, options) => {
      assert.strictEqual(url, "/api/automation/run");
      requests.push(JSON.parse(options.body));
      return { jobId: "fixture-job", job: { tasks: [] } };
    },
  };
  const controller = new Function(...Object.keys(dependencies), `
    let appReady = true, jobStarting = false, jobId = null, cancelInFlight = false;
    let closeTargetId = null, trackedJob = null, cancelIntent = false;
    let cancelError = "", jobPollError = "", jobStateEpoch = 0;
    let capsolverSettingsBusy = false, capsolverEnabledPreference = false;
    let capsolverConfigured = false, capsolverSettingsLoaded = true;
    const envSelected = new Set(["fixture-env"]), accounts = [], jobManualExpand = new Map();
    ${extract("// 记住批量运行偏好", "// ---- CAPSOLVER")}
    ${extract("function solveAndCloseSelected()", "function saveCapsolverPreferences()")}
    ${extract("async function startJob(", 'el("runBtn").addEventListener')}
    syncCapsolverVisibility();
    return { startJob, saveFlags, loadFlags, syncCapsolverVisibility, finish: () => { jobId = null; } };
  `)(...Object.values(dependencies));
  return { ...controller, el, config, requests, storage };
}

module.exports = async function runBackgroundUiTests({ check, checkAsync }) {
  check("后台运行界面：默认不选中，说明任务栏、恢复、非无头及保留策略", () => {
    const input = markup.match(/<input\b[^>]*\bid="backgroundRun"[^>]*>/);
    assert.ok(input);
    assert.match(input[0], /type="checkbox"/);
    assert.ok(!/\bchecked\b/.test(input[0]));
    assert.match(input[0], /aria-describedby="backgroundRunHint"/);
    assert.match(markup, /后台运行（最小化）/);
    for (const text of ["AdsPower", "任务栏", "手动恢复", "不是无头模式", "窗口保留设置不变", "短暂闪现"]) {
      assert.ok(markup.match(/id="backgroundRunHint"[^>]*>([^<]*)</)[1].includes(text));
    }
    assert.strictEqual(harness().el("backgroundRun").checked, false);
    assert.ok(source.includes("startJob([runBtn.dataset.id])"), "单行和批量运行必须共用启动逻辑");
  });

  check("后台运行界面：布尔偏好可持久化，旧记录或非法值保持原来的前台默认", () => {
    const storage = new Map(), first = harness(storage);
    first.el("keepOpen").checked = true;
    first.el("keepOpen").events.change();
    first.el("backgroundRun").checked = true;
    first.el("backgroundRun").events.change();
    assert.strictEqual(JSON.parse(storage.get(FLAGS_KEY)).background, true);
    const restored = harness(storage);
    assert.strictEqual(restored.el("backgroundRun").checked, true);
    assert.strictEqual(restored.el("keepOpen").checked, true);
    restored.el("backgroundRun").checked = false;
    restored.el("backgroundRun").events.change();
    assert.strictEqual(harness(storage).el("backgroundRun").checked, false);
    assert.strictEqual(JSON.parse(storage.get(FLAGS_KEY)).keepOpen, true);
    for (const value of ["{}", '{"keepOpen":true}', '{"background":"true"}', '{"background":1}', "invalid-json"]) {
      assert.strictEqual(harness(new Map([[FLAGS_KEY, value]])).el("backgroundRun").checked, false);
    }
  });

  await checkAsync("后台运行界面：本机和 AdsPower 的开关值均发送布尔快照，保留策略互不影响", async () => {
    for (const mode of ["local", "adspower"]) {
      for (const background of [false, true]) {
        for (const policy of ["close", "keep", "solve_close"]) {
          const h = harness();
          h.config.mode = mode;
          h.el("backgroundRun").checked = background;
          h.el("keepOpen").checked = true;
          h.el("keepOpen").events.change();
          h.el("manualChallengePolicy").value = policy;
          h.el("manualChallengePolicy").events.change();
          assert.strictEqual(h.el("backgroundRun").checked, background);
          await h.startJob(["fixture-account"]);
          assert.strictEqual(h.requests.length, 1);
          const request = h.requests[0];
          assert.strictEqual(request.mode, mode);
          assert.strictEqual(request.background, background);
          assert.strictEqual(typeof request.background, "boolean");
          assert.strictEqual(request.keepOpen, policy !== "solve_close");
          assert.strictEqual(request.manualChallengePolicy, policy);
          assert.deepStrictEqual(request.envs, mode === "local" ? [] : ["fixture-env"]);
          assert.strictEqual(h.el("backgroundRun").disabled, false);
        }
      }
    }
  });

  await checkAsync("后台运行界面：异步启动等待中禁用开关，改变页面也不改变本次请求快照", async () => {
    for (const initial of [false, true]) {
      const h = harness();
      let release;
      h.config.savePromise = new Promise((resolve) => { release = resolve; });
      h.config.awaitSave = true;
      h.el("capsolverKey").value = "fixture-placeholder";
      h.el("backgroundRun").checked = initial;
      const pending = h.startJob(["fixture-account"]);
      assert.strictEqual(h.requests.length, 0);
      assert.strictEqual(h.el("backgroundRun").disabled, true);
      h.el("backgroundRun").checked = !initial;
      release();
      await pending;
      assert.strictEqual(h.requests[0].background, initial);
      assert.strictEqual(h.el("backgroundRun").disabled, false);
    }
  });

  check("后台运行界面：任务标记按本批快照显示，最小化警告可见且不误报登录失败", () => {
    const board = { innerHTML: "" };
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    let onlyAbnormal = false;
    const render = new Function("el", "escapeHtml", "loadJobOnlyAbnormal", `
      let lastJob = null; const jobManualExpand = new Map();
      ${extract("const ATTENTION_DETAIL_KEYWORDS =", "function clearJobBoard()")}
      return { renderJob, taskNeedsAttention };
    `)(() => board, escapeHtml, () => onlyAbnormal);
    const task = { email: "fixture@example.test", status: "done", results: [],
      windowWarning: '未能最小化 <script>fixture</script>' };
    const original = JSON.stringify(task);
    for (const background of [true, false, undefined, "true"]) {
      render.renderJob({ background, tasks: [task] });
      assert.strictEqual(board.innerHTML.includes("后台运行（最小化）"), background === true);
      assert.ok(board.innerHTML.includes('class="job-window-warning">未能最小化 &lt;script&gt;fixture&lt;/script&gt;</div>'));
      assert.ok(!board.innerHTML.includes("<script>"));
      assert.ok(board.innerHTML.indexOf('class="job-window-warning"') < board.innerHTML.indexOf('class="job-lines"'),
        "警告在折叠的日志区域外，已折叠任务仍能看到");
      assert.strictEqual(render.taskNeedsAttention(task), false);
      assert.strictEqual(JSON.stringify(task), original);
    }
    render.renderJob({ background: false, tasks: [{ email: task.email, status: "done", results: [] }] });
    assert.ok(!board.innerHTML.includes("job-window-warning"));
    onlyAbnormal = true;
    const normalTask = { email: "normal@example.test", status: "done", results: [] };
    render.renderJob({ background: true, tasks: [task, normalTask] });
    assert.ok(board.innerHTML.includes('class="job-window-warning"'));
    assert.ok(board.innerHTML.includes(task.email));
    assert.ok(!board.innerHTML.includes(normalTask.email), "只看异常仍隐藏没有窗口警告的正常任务");
    assert.ok(!board.innerHTML.includes('class="job-empty-hint"'), "正在显示窗口警告时不提示空结果");
    assert.ok(board.innerHTML.includes('需人工/异常 <b>0</b>'), "窗口警告不改变需人工或异常计数");
    assert.ok(!board.innerHTML.includes('class="job-attn"'));
    assert.strictEqual(render.taskNeedsAttention(task), false);
    assert.strictEqual(JSON.stringify(task), original);
    render.renderJob({ background: true, tasks: [normalTask] });
    assert.ok(!board.innerHTML.includes(normalTask.email));
    assert.ok(board.innerHTML.includes('class="job-empty-hint"'));
  });
};

if (require.main === module) {
  let passed = 0;
  const check = (name, fn) => { fn(); passed += 1; console.log(`ok ${name}`); };
  const checkAsync = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); };
  module.exports({ check, checkAsync }).then(() => console.log(`${passed} 项通过`)).catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
