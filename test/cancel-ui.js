"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Deterministic frontend controller tests. No real browser, API or account data.
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const slice = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing controller section ${start}`);
  return source.slice(first, last);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let n = 0; n < 16; n += 1) await Promise.resolve(); };
const job = (patch = {}) => ({
  id: "fixture-job", status: "running", cancelRequested: false, closing: false, closeErrors: [],
  envs: [{ serial: "fixture-env", busy: true, retained: false }],
  tasks: [{ status: "running", email: "fixture@example.com", results: [] }], actionIds: ["login"], ...patch,
});
const terminal = (patch = {}) => job({
  status: "done", envs: [{ serial: "fixture-env", busy: false, retained: false }],
  tasks: [{ status: "done", email: "fixture@example.com", results: [] }], ...patch,
});
const response = (snapshot, status = 200) => ({ ok: status < 400, status, json: async () => ({ job: snapshot }) });

function harness(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const elements = new Map();
  const requests = [], queue = [], rendered = [];
  const timers = new Map();
  let timerId = 0;
  const deps = {
    el: (id) => {
      if (!elements.has(id)) elements.set(id, { disabled: false, textContent: "", title: "" });
      return elements.get(id);
    },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    LS: { job: "active", closeJob: "close", cancelJob: "cancel" },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (!queue.length) throw new Error("fixture has no queued response");
      const item = queue.shift();
      if (item instanceof Error) throw item;
      return typeof item === "function" ? item(url, options) : item;
    },
    AbortController,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    renderJob: (value) => rendered.push(value),
    refreshAccountsSoft: async () => {}, loadPhones: async () => {},
    totpSetupResultText: () => "待处理", passwordCheckResultText: () => "密码正确", loginCheckResultText: () => "正常",
    JOB_OUTCOME_TEXT: { ok: "成功" }, taskNeedsAttention: () => false,
  };
  const api = new Function(...Object.keys(deps), `
    ${slice("let jobId = null;", "// 运行日志：最近一次渲染过的 job")}
    ${slice("function jobHasOpenWindows(", "// ---- 信用卡卡池 ----")}
    appReady = true;
    return {
      acceptJobSnapshot, requestJobState, stopCurrentJob, pollJob, resumeJobIfAny, jobIsSettled,
      state: () => ({jobId, closeTargetId, trackedJob, cancelIntent, cancelInFlight, jobPolling, jobStateEpoch}),
      seed: (id, snapshot = null) => {jobId=id;closeTargetId=id;trackedJob=snapshot;jobStateEpoch+=1;persistJobHandles();syncRunButton();}
    };`)(...Object.values(deps));
  return { ...api, storage, requests, queue, rendered, el: deps.el,
    fire: async (ms) => {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
      await tick();
    },
  };
}

module.exports = async function runCancelUiTests({ checkAsync }) {
  await checkAsync("停止界面：请求接受、仍运行和关闭失败均不冒报窗口已关", async () => {
    const h = harness();
    h.seed("fixture-job");
    const epoch = h.state().jobStateEpoch;
    h.acceptJobSnapshot(job({ cancelRequested: true, closing: true }), "fixture-job", epoch);
    assert.match(h.el("runStatus").textContent, /等待关闭结果/);
    assert.strictEqual(h.el("stopBtn").disabled, false, "服务器关闭卡住时仍能重发关闭请求");
    h.acceptJobSnapshot(terminal({ status: "cancelled", tasks: [{ status: "running" }], cancelRequested: true }), "fixture-job", epoch);
    assert.strictEqual(h.state().jobId, "fixture-job", "任务还在跑不能当终态");
    const failed = terminal({ status: "cancelled", cancelRequested: true,
      envs: [{ busy: false, retained: true }], closeErrors: [{ env: "fixture-env", message: "fixture close failed" }] });
    h.acceptJobSnapshot(failed, "fixture-job", epoch);
    assert.match(h.el("runStatus").textContent, /关闭失败/);
    assert.strictEqual(h.state().closeTargetId, "fixture-job");
    assert.strictEqual(h.el("stopBtn").disabled, false);
    h.acceptJobSnapshot(terminal({ status: "cancelled", cancelRequested: true }), "fixture-job", epoch);
    assert.strictEqual(h.el("runStatus").textContent, "已停止并关闭窗口");
    assert.strictEqual(h.state().closeTargetId, null);
    assert.strictEqual(h.storage.has("close"), false);
    assert.strictEqual(h.el("stopBtn").disabled, true);
  });

  await checkAsync("停止界面：终态保留窗口不丢关闭目标，刷新后可关闭且不阻止新批次", async () => {
    const saved = terminal({ envs: [{ busy: false, retained: true }] });
    const h = harness();
    h.seed("fixture-job");
    h.acceptJobSnapshot(saved, "fixture-job", h.state().jobStateEpoch);
    assert.strictEqual(h.state().jobId, null);
    assert.strictEqual(h.storage.get("close"), "fixture-job");
    assert.strictEqual(h.el("runBtn").disabled, false);
    assert.strictEqual(h.el("stopBtn").textContent, "关闭保留窗口");
    const restored = harness(Object.fromEntries(h.storage));
    restored.queue.push(response(saved));
    await restored.resumeJobIfAny();
    assert.strictEqual(restored.state().closeTargetId, "fixture-job");
    assert.strictEqual(restored.el("stopBtn").disabled, false);
    restored.queue.push(response(terminal({ status: "cancelled", cancelRequested: true })));
    await restored.stopCurrentJob();
    assert.strictEqual(restored.requests.filter((r) => r.method === "POST").length, 1);
    assert.strictEqual(restored.el("runStatus").textContent, "已停止并关闭窗口");
  });

  await checkAsync("停止界面：取消请求超时恢复按钮并保留目标，不会重复关闭其他任务", async () => {
    const h = harness({ close: "unrelated-history" });
    h.seed("fixture-job", job());
    const pending = deferred(), polling = deferred();
    h.queue.push(pending.promise, polling.promise);
    const stopped = h.stopCurrentJob();
    assert.strictEqual(h.state().cancelInFlight, true);
    assert.strictEqual(h.el("stopBtn").disabled, true);
    await h.fire(12000);
    await stopped;
    assert.strictEqual(h.requests[0].signal.aborted, true);
    assert.strictEqual(h.state().cancelInFlight, false);
    assert.strictEqual(h.el("stopBtn").disabled, false);
    assert.strictEqual(h.storage.get("close"), "fixture-job");
    assert.match(h.el("runStatus").textContent, /未确认.*超时/);
    assert.ok(h.requests.every((r) => r.url.includes("fixture-job")), "不得关闭其他历史任务");
    h.queue.push(response(terminal({ status: "cancelled", cancelRequested: true })));
    await h.stopCurrentJob();
    polling.resolve(response(job()));
    await tick();
    assert.strictEqual(h.el("runStatus").textContent, "已停止并关闭窗口");
    assert.strictEqual(h.state().closeTargetId, null);
  });

  await checkAsync("停止界面：取消前的慢 GET 不能覆盖关闭中的新状态", async () => {
    const h = harness();
    h.seed("fixture-job", job());
    const oldGet = deferred();
    h.queue.push(oldGet.promise, response(job({ cancelRequested: true, closing: true })));
    const poll = h.pollJob();
    await h.stopCurrentJob();
    assert.strictEqual(h.state().trackedJob.closing, true);
    oldGet.resolve(response(terminal()));
    await tick();
    assert.strictEqual(h.state().closeTargetId, "fixture-job");
    assert.strictEqual(h.state().trackedJob.closing, true);
    h.queue.push(response(terminal({ status: "cancelled", cancelRequested: true })));
    await h.fire(2000);
    await poll;
    assert.strictEqual(h.state().jobPolling, false);
    assert.strictEqual(h.state().closeTargetId, null);
  });

  await checkAsync("停止界面：轮询 JSON 异常后继续，finally 不留下永久 polling 锁", async () => {
    const h = harness();
    h.seed("fixture-job", job());
    h.queue.push({ ok: true, status: 200, json: async () => { throw new Error("fixture invalid JSON"); } });
    const polling = h.pollJob();
    await tick();
    assert.match(h.el("runStatus").textContent, /无法确认/);
    assert.strictEqual(h.el("stopBtn").disabled, false);
    h.queue.push(response(terminal()));
    await h.fire(2000);
    await polling;
    assert.strictEqual(h.state().jobPolling, false);
    assert.strictEqual(h.state().jobId, null);
    assert.strictEqual(h.el("runBtn").disabled, false);
  });

  await checkAsync("停止界面：刷新恢复关闭中状态，404 或连接失败不能冒充已关", async () => {
    const h = harness({ active: "fixture-job", close: "fixture-job", cancel: "fixture-job" });
    const closingPoll = deferred();
    h.queue.push(response(job({ cancelRequested: true, closing: true })), closingPoll.promise);
    await h.resumeJobIfAny();
    assert.strictEqual(h.state().cancelIntent, true);
    assert.match(h.el("runStatus").textContent, /等待关闭结果/);
    closingPoll.resolve(response(null, 404));
    await tick();
    assert.strictEqual(h.state().jobPolling, false);
    assert.strictEqual(h.state().closeTargetId, "fixture-job");
    assert.match(h.el("runStatus").textContent, /不能据此确认窗口已关闭/);
    assert.strictEqual(h.el("stopBtn").disabled, false);
    assert.strictEqual(h.storage.get("close"), "fixture-job");
    const offline = harness({ close: "fixture-job" });
    offline.queue.push(new Error("fixture offline"));
    await offline.resumeJobIfAny();
    assert.strictEqual(offline.state().closeTargetId, "fixture-job");
    assert.strictEqual(offline.el("stopBtn").disabled, false);
  });

  await checkAsync("停止界面：缺少窗口或任务数组的响应不允许确认关闭", async () => {
    const h = harness();
    h.queue.push(response({ id: "fixture-job", status: "cancelled" }));
    await assert.rejects(h.requestJobState("fixture-job"), /响应不完整/);
  });
};
