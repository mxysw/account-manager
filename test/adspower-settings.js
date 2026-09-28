"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
// Standalone runs must never read the user's real data directory.
const ownDataDirectory = process.env.ACCOUNT_MANAGER_DATA_DIR ? null : fs.mkdtempSync(path.join(os.tmpdir(), "adspower-data-test-"));
if (ownDataDirectory) process.env.ACCOUNT_MANAGER_DATA_DIR = ownDataDirectory;
const { createStore, validAddress, DEFAULT_ADDRESS, DEFAULT_PORT } = require("../src/adspower-settings");
const { AdsPower } = require("../src/automation/adspower");
const adsProxy = require("../src/automation/ads-cli");

module.exports = async function run({ checkAsync }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adspower-settings-test-"));
  const file = path.join(directory, "settings.json");
  const key = "fixture-adspower-key-not-real";
  const codec = {
    protect: (value) => Buffer.from(value).toString("base64"),
    unprotect: (value) => Buffer.from(value, "base64").toString("utf8"),
  };
  try {
    await checkAsync("AdsPower 设置：密钥受保护、地址和端口持久化且不会回传密钥", async () => {
      const store = createStore({ file, ...codec });
      assert.deepStrictEqual(store.status(), { configured: false, address: DEFAULT_ADDRESS, port: DEFAULT_PORT });
      assert.deepStrictEqual(store.save({ apiKey: key, address: "localhost", port: 50360 }), { configured: true, address: DEFAULT_ADDRESS, port: 50360 });
      assert.ok(!fs.readFileSync(file, "utf8").includes(key));
      const reloaded = createStore({ file, ...codec });
      assert.deepStrictEqual(reloaded.status(), { configured: true, address: DEFAULT_ADDRESS, port: 50360 });
      assert.strictEqual(reloaded.getBase(), "http://127.0.0.1:50360");
      assert.strictEqual(reloaded.getKey(), key);
      assert.deepStrictEqual(reloaded.save({ apiKey: "", address: "http://local.adspower.net", port: 50325 }), { configured: true, address: DEFAULT_ADDRESS, port: 50325 });
      assert.strictEqual(reloaded.getKey(), key);
      for (const port of [0, 65536, "50360x", "", 1.5]) {
        assert.throws(() => reloaded.save({ apiKey: "", port }), /端口/);
      }
      assert.throws(() => reloaded.save({ apiKey: "bad\nkey", port: 50360 }), /有效/);
      for (const address of ["", "example.com", "https://127.0.0.1", "http://127.0.0.1:50360", "http://user@localhost", "127.0.0.1/path", "127.0.0.1?x=1", "127.0.0.1#x", "127.0.0.2", "[::1]", "localhost.evil.example", "http://127.0.0.1@evil.example", "localhost\\evil.example", null, 42]) {
        assert.throws(() => reloaded.save({ apiKey: "", address, port: 50360 }), /地址/);
      }
      assert.strictEqual(validAddress("LOCAL.ADSPOWER.NET"), DEFAULT_ADDRESS);
      assert.strictEqual(reloaded.getKey(), key);
      assert.deepStrictEqual(reloaded.clear(), { configured: false, address: DEFAULT_ADDRESS, port: DEFAULT_PORT });
      assert.throws(() => reloaded.getKey(), /先保存/);
    });

    await checkAsync("AdsPower 设置：旧 v1 配置无地址时保留加密密钥并迁移到 v2", async () => {
      const store = createStore({ file, ...codec });
      const encryptedKey = codec.protect(key);
      fs.writeFileSync(file, JSON.stringify({ version: 1, protection: "windows-dpapi", port: 50360, encryptedKey }));
      assert.deepStrictEqual(store.status(), { configured: true, address: DEFAULT_ADDRESS, port: 50360 });
      assert.strictEqual(store.getBase(), "http://127.0.0.1:50360");
      assert.strictEqual(store.getKey(), key);
      assert.deepStrictEqual(store.save({ address: "localhost", port: 50361, apiKey: "" }), { configured: true, address: DEFAULT_ADDRESS, port: 50361 });
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.strictEqual(saved.version, 2);
      assert.strictEqual(saved.encryptedKey, encryptedKey);
      assert.strictEqual(saved.address, DEFAULT_ADDRESS);
      assert.strictEqual(store.getKey(), key);
      store.clear();
    });

    await checkAsync("AdsPower 客户端：只能连接指定本机端口", async () => {
      assert.strictEqual(new AdsPower({ base: "http://127.0.0.1:50360", apiKey: key }).base, "http://127.0.0.1:50360");
      assert.strictEqual(new AdsPower({ base: "http://127.0.0.1:80" }).base, "http://127.0.0.1:80");
      const settings = require("../src/adspower-settings");
      const getBase = settings.getBase;
      settings.getBase = () => "http://127.0.0.1:50360";
      try { assert.strictEqual(new AdsPower({ apiKey: key }).base, "http://127.0.0.1:50360"); }
      finally { settings.getBase = getBase; }
      for (const base of ["https://127.0.0.1:50360", "http://example.com:50360", "http://127.0.0.1:50360/other", "http://127.0.0.1:50360/?apiKey=bad"]) {
        assert.throws(() => new AdsPower({ base }), /本地|本机/);
      }
    });

    await checkAsync("AdsPower 客户端：连接测试只请求官方只读 /status", async () => {
      const original = AdsPower.prototype._request;
      const calls = [];
      AdsPower.prototype._request = async function (...args) {
        calls.push(args);
        return { code: 0, msg: "success" };
      };
      try {
        const client = new AdsPower({ base: "http://127.0.0.1:50360", apiKey: key });
        assert.strictEqual(await client.checkConnection(), true);
        assert.deepStrictEqual(calls, [["GET", "/status", {}, null, 5000]]);
        AdsPower.prototype._request = async () => ({ code: -1, msg: key });
        assert.strictEqual(await client.checkConnection(), false);
      } finally { AdsPower.prototype._request = original; }
    });

    await checkAsync("AdsPower 代理列表：通过本地 v2 接口读取并保持现有标签格式", async () => {
      const original = AdsPower.prototype._request;
      let calls = 0;
      AdsPower.prototype._request = async function (method, pathname, query, body) {
        calls += 1;
        assert.strictEqual(this.apiKey, key);
        assert.strictEqual(method, "POST");
        assert.strictEqual(pathname, "/api/v2/proxy-list/list");
        assert.deepStrictEqual(query, {});
        assert.deepStrictEqual(body, { limit: 200, page: 1 });
        return { code: 0, data: { total: 2, list: [
          { proxy_id: "p1", type: "http", host: "example.invalid", port: "8080", proxy_tags: [{ id: "7", name: "fixture" }] },
          { proxy_id: "p2", type: "http", host: "example.invalid", port: "8081", proxy_tags: [] },
        ] } };
      };
      try {
        assert.deepStrictEqual(await adsProxy.listProxyTags(key), { tags: [{ id: "7", name: "fixture", count: 1 }], untagged: 1, total: 2 });
        assert.deepStrictEqual(await adsProxy.proxyIdsByTag(key, "7"), ["p1"]);
        assert.strictEqual(calls, 2);
      } finally { AdsPower.prototype._request = original; }
    });

    await checkAsync("AdsPower 代理列表：分页期间配置变化不切换连接端口", async () => {
      const settings = require("../src/adspower-settings");
      const originalBase = settings.getBase;
      const originalRequest = AdsPower.prototype._request;
      let configuredBase = "http://127.0.0.1:50360";
      const seen = [];
      settings.getBase = () => configuredBase;
      AdsPower.prototype._request = async function (method, pathname, query, body) {
        assert.strictEqual(method, "POST");
        assert.strictEqual(pathname, "/api/v2/proxy-list/list");
        assert.strictEqual(this.apiKey, key);
        seen.push({ base: this.base, page: body.page });
        if (body.page === 1) {
          configuredBase = "http://127.0.0.1:50361";
          return { code: 0, data: { total: 2, list: [{ proxy_id: "first", proxy_tags: [] }] } };
        }
        return { code: 0, data: { total: 2, list: [{ proxy_id: "second", proxy_tags: [] }] } };
      };
      try {
        assert.deepStrictEqual(await adsProxy.listProxies(key), [
          { proxyId: "first", tags: [] }, { proxyId: "second", tags: [] },
        ]);
        assert.deepStrictEqual(seen, [
          { base: "http://127.0.0.1:50360", page: 1 },
          { base: "http://127.0.0.1:50360", page: 2 },
        ]);
        configuredBase = "http://127.0.0.1:50362";
        seen.length = 0;
        await adsProxy.listProxies(key, "http://127.0.0.1:50360");
        assert.deepStrictEqual(seen, [
          { base: "http://127.0.0.1:50360", page: 1 },
          { base: "http://127.0.0.1:50360", page: 2 },
        ]);
      } finally {
        settings.getBase = originalBase;
        AdsPower.prototype._request = originalRequest;
      }
    });

    await checkAsync("AdsPower 设置 API：地址配置及连接测试仅使用服务端密钥", async () => {
      const store = createStore({ file, ...codec });
      const jobs = [];
      const calls = [];
      let failEnvs = false;
      let failConnection = false;
      let changeConnectionDuringProxyLookup = false;
      const engine = {
        normalizeActionSelection: (ids) => ids, validateActionSelection: () => null,
        createJob: (config) => { jobs.push(config); return { id: "fixture-job" }; },
        publicJob: (job) => ({ id: job.id }),
      };
      const moduleObject = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/router.js"), "utf8"), {
        module: moduleObject, exports: moduleObject.exports, __dirname: path.join(__dirname, "../src"), URL,
        require: (name) => name === "fs" ? fs : name === "path" ? path
          : name === "./adspower-settings" ? store
            : name === "./capsolver-settings" ? { resolveConfig: (config) => config }
            : name === "./automation/engine" ? engine
              : name === "./automation/adspower" ? { AdsPower: class {
                constructor(options) { this.apiKey = options.apiKey; }
                async checkConnection() { calls.push({ kind: "connection-test", key: this.apiKey }); if (failConnection) throw new Error(key); return true; }
                async listProfiles() { calls.push({ kind: "envs", key: this.apiKey }); if (failEnvs) throw new Error(key); return []; }
                async activeUserIds() { return new Set(); }
              } }
                : name === "./automation/ads-cli" ? {
                  listProxyTags: async (apiKey) => { calls.push({ kind: "tags", key: apiKey }); return { tags: [], total: 0 }; },
                  proxyIdsByTag: async (apiKey, tagId, adsBase) => {
                    calls.push({ kind: "tag-filter", key: apiKey, base: adsBase });
                    if (changeConnectionDuringProxyLookup) {
                      store.save({ apiKey: "replacement-fixture-key", address: "localhost", port: 50361 });
                    }
                    return ["p1"];
                  },
                } : {},
      });
      const server = http.createServer((req, res) => {
        moduleObject.exports.handle(req, res).catch(() => { res.writeHead(500); res.end("{}"); });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const request = (route, method = "GET", body, headers = {}) => fetch(base + route, {
        method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      try {
        const settings = "/api/settings/adspower";
        assert.deepStrictEqual(await (await request(settings)).json(), { configured: false, address: DEFAULT_ADDRESS, port: DEFAULT_PORT });
        const unconfiguredTest = await request(`${settings}/test`, "POST");
        assert.strictEqual(unconfiguredTest.status, 502);
        assert.ok(!(await unconfiguredTest.text()).includes(key));
        assert.deepStrictEqual(await (await request(settings, "PUT", { apiKey: key, address: "localhost", port: 50360 })).json(), { configured: true, address: DEFAULT_ADDRESS, port: 50360 });
        const visible = JSON.stringify(await (await request(settings)).json());
        assert.ok(!visible.includes(key));
        assert.strictEqual((await request(settings, "PUT", { apiKey: "attacker", address: "localhost", port: 50360 }, { origin: "https://other.example" })).status, 403);
        const forgedBody = JSON.stringify({ apiKey: "attacker", address: "localhost", port: 50360 });
        const forgedStatus = await new Promise((resolve, reject) => {
          const call = http.request({
            hostname: "127.0.0.1", port: server.address().port, path: settings, method: "PUT",
            headers: {
              host: "attacker.example:8910", origin: "http://attacker.example:8910",
              "content-type": "application/json", "content-length": Buffer.byteLength(forgedBody),
            },
          }, (result) => { result.resume(); result.on("end", () => resolve(result.statusCode)); });
          call.on("error", reject);
          call.end(forgedBody);
        });
        assert.strictEqual(forgedStatus, 403);
        assert.strictEqual(store.getKey(), key);
        assert.strictEqual((await request(`${settings}/test`, "POST", undefined, { origin: "https://other.example" })).status, 403);
        const connection = await request(`${settings}/test`, "POST");
        assert.strictEqual(connection.status, 200);
        assert.deepStrictEqual(await connection.json(), { ok: true });
        failConnection = true;
        const failedConnection = await request(`${settings}/test`, "POST");
        assert.strictEqual(failedConnection.status, 502);
        assert.ok(!(await failedConnection.text()).includes(key));
        failConnection = false;
        assert.strictEqual((await request("/api/automation/envs", "GET", undefined, { origin: "https://other.example" })).status, 403);
        assert.strictEqual((await request("/api/automation/envs?apiKey=ignored-client-value")).status, 200);
        failEnvs = true;
        const failedEnvs = await request("/api/automation/envs");
        assert.strictEqual(failedEnvs.status, 502);
        assert.ok(!(await failedEnvs.text()).includes(key));
        failEnvs = false;
        assert.strictEqual((await request("/api/automation/proxy-tags?apiKey=ignored-client-value")).status, 200);
        const run = { mode: "adspower", accountIds: ["fixture"], actionIds: ["login"], envs: ["1"], apiKey: "ignored-client-value" };
        const response = await request("/api/automation/run", "POST", run);
        assert.strictEqual(response.status, 202);
        assert.ok(!(await response.text()).includes(key));
        assert.deepStrictEqual(calls, [
          { kind: "connection-test", key }, { kind: "connection-test", key },
          { kind: "envs", key }, { kind: "envs", key }, { kind: "tags", key },
        ]);
        assert.strictEqual(jobs[0].apiKey, key);
        assert.strictEqual((await request(settings, "DELETE")).status, 200);
        assert.strictEqual((await request("/api/automation/run", "POST", run)).status, 400);
        const local = { mode: "local", accountIds: ["fixture"], actionIds: ["login"], envs: [] };
        assert.strictEqual((await request("/api/automation/run", "POST", local)).status, 202);
        assert.strictEqual(jobs[1].apiKey, "");
        store.save({ apiKey: key, address: "localhost", port: 50360 });
        changeConnectionDuringProxyLookup = true;
        const proxyRun = { ...run, proxy: { enabled: true, tagId: "fixture-tag" } };
        assert.strictEqual((await request("/api/automation/run", "POST", proxyRun)).status, 202);
        assert.deepStrictEqual(calls[calls.length - 1], {
          kind: "tag-filter", key, base: "http://127.0.0.1:50360",
        });
        assert.strictEqual(jobs[2].apiKey, key);
        assert.strictEqual(jobs[2].adsBase, "http://127.0.0.1:50360");
        assert.strictEqual(store.getBase(), "http://127.0.0.1:50361");
        const tempRun = { mode: "adspower_temp", accountIds: ["fixture"], actionIds: ["login"], envs: [], maxConcurrent: 3 };
        assert.strictEqual((await request("/api/automation/run", "POST", tempRun)).status, 202);
        assert.strictEqual(jobs[3].mode, "adspower_temp");
        assert.strictEqual(jobs[3].apiKey, "replacement-fixture-key");
        assert.strictEqual(jobs[3].adsBase, "http://127.0.0.1:50361");
        assert.strictEqual((await request("/api/automation/run", "POST", { ...tempRun, envs: ["existing-profile"] })).status, 400);
        assert.strictEqual((await request("/api/automation/run", "POST", tempRun, { origin: "https://other.example" })).status, 403);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });

    await checkAsync("AdsPower 页面：旧密钥被清理，运行请求和查询 URL 不携带密钥", async () => {
      const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
      assert.ok(source.includes('localStorage.removeItem("am_apiKey")'));
      assert.ok(source.includes('api("/api/automation/envs")'));
      assert.ok(source.includes('api("/api/automation/proxy-tags")'));
      const startAt = source.indexOf("async function startJob(ids)");
      const start = source.slice(startAt, source.indexOf("jobId = data.jobId;", startAt));
      assert.ok(!/apiKey\s*:/.test(start));
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    if (ownDataDirectory) fs.rmSync(ownDataDirectory, { recursive: true, force: true });
  }
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, fn) => { await fn(); passed++; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} passed`)).catch(error => { console.error(error); process.exitCode = 1; });
}
