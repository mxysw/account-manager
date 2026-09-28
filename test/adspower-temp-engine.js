"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const engineSource = fs.readFileSync(path.join(__dirname, "../src/automation/engine.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(predicate, description, ms = 2500) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待失败：${description}`);
    await tick();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the real engine against an in-memory ledger, browser and AdsPower.
// The require allowlist prevents this suite from touching accounts or Local API.
function fixture(options = {}) {
  const calls = [];
  const accountsById = new Map([
    ["account-1", { id: "account-1", email: "one@example.invalid", status: {} }],
    ["account-2", { id: "account-2", email: "two@example.invalid", status: {} }],
  ]);
  const records = [];
  const profileStates = new Map([["existing-profile", "Active"]]);
  let nextNonce = 1;
  let nextProfile = 1;

  const ledger = {
    begin(jobId, taskId) {
      const nonce = `fixture_nonce_${String(nextNonce++).padStart(12, "0")}`;
      const record = { jobId, taskId, nonce, profileId: null, state: "creating" };
      records.push(record);
      calls.push({ kind: "ledger.begin", nonce, taskId });
      return { ...record };
    },
    recordProfile(nonce, profileId) {
      const record = records.find((item) => item.nonce === nonce);
      assert.ok(record && record.state === "creating");
      assert.ok(!records.some((item) => item !== record && item.profileId === profileId));
      record.profileId = profileId;
      record.state = "created";
      calls.push({ kind: "ledger.recordProfile", nonce, profileId });
      return { ...record };
    },
    markClosed(nonce) {
      const record = records.find((item) => item.nonce === nonce);
      assert.ok(record && record.state === "created");
      record.state = "closed";
      calls.push({ kind: "ledger.markClosed", nonce, profileId: record.profileId });
      return { ...record };
    },
    deletionCandidate(nonce) {
      const record = records.find((item) => item.nonce === nonce);
      assert.ok(record && record.state === "closed");
      calls.push({ kind: "ledger.deletionCandidate", nonce, profileId: record.profileId });
      return record.profileId;
    },
    markDeleted(nonce) {
      const record = records.find((item) => item.nonce === nonce);
      assert.ok(record && record.state === "closed");
      record.state = "deleted";
      calls.push({ kind: "ledger.markDeleted", nonce, profileId: record.profileId });
      return { ...record };
    },
    get(nonce) { const record = records.find((item) => item.nonce === nonce); return record ? { ...record } : null; },
    listOwned() { return records.filter((item) => item.profileId && item.state !== "deleted").map((item) => ({ ...item })); },
  };

  class AdsPower {
    constructor({ base, ownedProfileIds = [] } = {}) {
      this.base = base || "http://127.0.0.1:50360";
      this.ownedProfileIds = new Set(ownedProfileIds);
      calls.push({ kind: "ads.constructor", base: this.base });
    }

    checkOwned(profileId) {
      assert.notStrictEqual(profileId, "existing-profile", "既有环境绝不能触碰");
      assert.ok(this.ownedProfileIds.has(profileId), `未登记所有权：${profileId}`);
    }

    async createTempProfile({ marker }) {
      assert.ok(records.some((item) => item.nonce === marker && item.state === "creating"), "必须先记创建意图");
      const profileId = `fixture-profile-${nextProfile++}`;
      this.ownedProfileIds.add(profileId);
      profileStates.set(profileId, "Inactive");
      calls.push({ kind: "ads.create", marker, profileId });
      return { profileId, profileNo: String(nextProfile), marker };
    }

    async startProfile(profileId) {
      this.checkOwned(profileId);
      calls.push({ kind: "ads.start", profileId });
      profileStates.set(profileId, "Active");
      if (options.startProfile) return options.startProfile(profileId);
      return { profileId, cdpEndpoint: `fixture://ads/${profileId}` };
    }

    async profileStatus(profileId) {
      this.checkOwned(profileId);
      const status = profileStates.get(profileId);
      calls.push({ kind: "ads.status", profileId, status });
      return { profileId, status };
    }

    async stopProfile(profileId) {
      this.checkOwned(profileId);
      calls.push({ kind: "ads.stop", profileId });
      if (options.stopProfile) return options.stopProfile(profileId);
      profileStates.set(profileId, "Inactive");
      return { profileId, stopped: true };
    }

    async deleteProfile(profileId) {
      this.checkOwned(profileId);
      assert.strictEqual(profileStates.get(profileId), "Inactive", "删除前必须确认关闭");
      assert.ok(records.some((item) => item.profileId === profileId && item.state === "closed"), "删除前必须完成台账关闭记录");
      calls.push({ kind: "ads.delete", profileId });
      return { profileId, deleted: true };
    }

    // Temporary mode must never call the existing-profile/proxy/fingerprint API.
    start() { throw new Error("既有环境 start 被误调用"); }
    stop() { throw new Error("既有环境 stop 被误调用"); }
    status() { throw new Error("既有环境 status 被误调用"); }
    bindProxyId() { throw new Error("代理设置被误调用"); }
    bindRandomProxy() { throw new Error("代理池被误调用"); }
    randomizeFingerprint() { throw new Error("指纹随机化被误调用"); }
  }

  const dependencies = {
    "./adspower": { AdsPower },
    "./adspower-temp-ledger": { createLedger: () => ledger },
    "./browser": {
      connect: async (endpoint) => {
        calls.push({ kind: "browser.connect", endpoint });
        return {
          page: {}, browser: {},
          close: async () => { calls.push({ kind: "browser.close", endpoint }); },
          disconnect: async () => { calls.push({ kind: "browser.disconnect", endpoint }); },
          wipe: async () => ({ ok: true }),
          label: async () => ({ ok: true }),
        };
      },
    },
    "./local-browser": { start: () => { throw new Error("本机浏览器不应启动"); } },
    "./actions": {
      list: () => [{ id: "fixture-action" }],
      get: (id) => id === "fixture-action" ? {
        run: async (_page, account) => {
          calls.push({ kind: "action.run", accountId: account.id });
          return { outcome: "ok", detail: {} };
        },
      } : null,
      normalizeSelection: (ids) => [...new Set(ids || [])],
      validateSelection: () => "",
    },
    "../accounts": {
      getById: (id) => accountsById.get(id) || null,
      update: () => { throw new Error("测试动作不应写账号"); },
      flush: async () => {},
      normalizeTotpSecret: (value) => value,
      normalizePendingTotpSetup: (value) => value,
      normalizeTotpSetup: (value) => value,
    },
    "./capsolver": {
      normalizeConfig: () => null,
      createSolver: () => { throw new Error("测试不应启动 CAPTCHA 服务"); },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(engineSource, {
    module, exports: module.exports, console, AbortController, AbortSignal, DOMException, URL,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Number(ms) >= 3000 ? 200 : Math.min(Number(ms) || 0, 5), ...args),
    clearTimeout, setImmediate, clearImmediate,
    require: (name) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`禁止真实依赖：${name}`);
      return dependencies[name];
    },
  }, { filename: "adspower-temp-engine-fixture.js" });

  const engine = module.exports;
  const create = (overrides = {}) => engine.createJob({
    mode: "adspower_temp", apiKey: "fixture-api-key", adsBase: "http://127.0.0.1:50360",
    envSerials: ["existing-profile"], accountIds: ["account-1"], actionIds: ["fixture-action"],
    maxConcurrent: 1, clearData: false, randomFp: true, keepOpen: false,
    proxy: { enabled: true, proxyIds: ["existing-proxy"] },
    ...overrides,
  });
  return { engine, create, calls, records, profileStates };
}

module.exports = async function runAdsPowerTempEngineTests({ checkAsync }) {
  await checkAsync("AdsPower 临时模式：每账号新建、执行、确认关闭后仅按精确 ID 删除", async () => {
    const f = fixture();
    const job = f.create({ accountIds: ["account-1", "account-2"] });
    await until(() => job.status === "done", "两账号临时任务完成");
    const publicJob = f.engine.publicJob(job);
    assert.strictEqual(publicJob.closeErrors.length, 0);
    assert.ok(publicJob.tasks.every((task) => task.status === "done"));
    assert.deepStrictEqual(f.records.map((record) => record.state), ["deleted", "deleted"]);
    const created = f.calls.filter((call) => call.kind === "ads.create");
    const deleted = f.calls.filter((call) => call.kind === "ads.delete");
    assert.deepStrictEqual(created.map((call) => call.profileId), ["fixture-profile-1", "fixture-profile-2"]);
    assert.deepStrictEqual(deleted.map((call) => call.profileId), created.map((call) => call.profileId));
    assert.strictEqual(f.calls.filter((call) => call.kind === "action.run").length, 2);
    assert.strictEqual(f.profileStates.get("existing-profile"), "Active", "既有环境保持原状");
    for (const { profileId } of created) {
      const sequence = f.calls.filter((call) => call.profileId === profileId).map((call) => call.kind);
      assert.deepStrictEqual(sequence, [
        "ads.create", "ledger.recordProfile", "ads.start", "ads.status", "ads.stop", "ads.status",
        "ledger.markClosed", "ledger.deletionCandidate", "ads.delete", "ledger.markDeleted",
      ]);
    }
  });

  await checkAsync("AdsPower 临时模式：取消时迟到的启动响应仍关闭并删除自建环境", async () => {
    const lateStart = deferred();
    const f = fixture({ startProfile: () => lateStart.promise });
    const job = f.create();
    await until(() => f.calls.some((call) => call.kind === "ads.start"), "临时环境启动请求发出");
    await f.engine.cancelJob(job.id);
    assert.strictEqual(f.calls.filter((call) => call.kind === "ads.delete").length, 0,
      "启动请求未返回前不能猜测并删除环境");
    lateStart.resolve({ profileId: "fixture-profile-1", cdpEndpoint: "fixture://ads/fixture-profile-1" });
    await until(() => f.records[0]?.state === "deleted" && job.status === "cancelled", "迟到启动完成后的清理");
    assert.strictEqual(f.calls.filter((call) => call.kind === "action.run").length, 0);
    assert.strictEqual(f.calls.filter((call) => call.kind === "browser.connect").length, 0);
    assert.deepStrictEqual(f.calls.filter((call) => call.kind === "ads.delete").map((call) => call.profileId), ["fixture-profile-1"]);
    assert.strictEqual(f.engine.publicJob(job).closeErrors.length, 0);
  });

  await checkAsync("AdsPower 临时模式：关闭失败保留环境并公开错误，不执行删除", async () => {
    const f = fixture({ stopProfile: async () => { throw new Error("fixture stop refused"); } });
    const job = f.create();
    await until(() => job.status === "done", "关闭失败任务完成");
    const publicJob = f.engine.publicJob(job);
    assert.strictEqual(publicJob.tasks[0].status, "done", "业务动作结果与清理错误独立呈现");
    assert.strictEqual(publicJob.envs[0].retained, true);
    assert.match(publicJob.closeErrors[0]?.message || "", /fixture stop refused/);
    assert.strictEqual(f.records[0].state, "created", "未确认关闭不能记为 closed");
    assert.strictEqual(f.calls.filter((call) => call.kind === "ads.delete").length, 0);
    assert.strictEqual(f.profileStates.get("fixture-profile-1"), "Active");
  });
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, run) => { await run(); passed += 1; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} AdsPower temporary engine groups passed`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
