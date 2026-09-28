"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { createStore } = require("../src/capsolver-settings");

module.exports = async function run({ checkAsync }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capsolver-settings-test-"));
  const file = path.join(directory, "settings.json");
  const key = "CAP-fixture-key-not-real";
  const codec = {
    protect: (value) => Buffer.from(value).toString("base64"),
    unprotect: (value) => Buffer.from(value, "base64").toString("utf8"),
  };
  try {
    await checkAsync("CAPSOLVER 保存：重建实例仍复用密钥，状态与配置文件不含明文", async () => {
      const store = createStore({ file, ...codec });
      assert.deepStrictEqual(store.status(), { configured: false });
      assert.deepStrictEqual(store.save(key), { configured: true });
      assert.ok(!fs.readFileSync(file, "utf8").includes(key));
      const reloaded = createStore({ file, ...codec });
      assert.strictEqual(reloaded.getKey(), key);
      assert.deepStrictEqual(reloaded.status(), { configured: true });
      assert.deepStrictEqual(reloaded.resolveConfig({ enabled: true, maxAttemptsPerAccount: 2 }), { enabled: true, maxAttemptsPerAccount: 2, apiKey: key });
      assert.strictEqual(reloaded.resolveConfig(null), null);
      assert.deepStrictEqual(reloaded.resolveConfig({ enabled: false }), { enabled: false });
      assert.strictEqual(reloaded.resolveConfig({ enabled: true, apiKey: "inline-fixture" }).apiKey, "inline-fixture");
    });
    await checkAsync("CAPSOLVER 保存：更换、清除、重复清除不会影响账号文件", async () => {
      const store = createStore({ file, ...codec });
      const other = path.join(directory, "accounts.json");
      fs.writeFileSync(other, '{"fixture":true}');
      store.save("CAP-replacement-fixture");
      assert.strictEqual(store.getKey(), "CAP-replacement-fixture");
      assert.deepStrictEqual(store.clear(), { configured: false });
      assert.deepStrictEqual(store.clear(), { configured: false });
      assert.throws(() => store.resolveConfig({ enabled: true }), /先保存/);
      assert.strictEqual(fs.readFileSync(other, "utf8"), '{"fixture":true}');
      assert.ok(!fs.readdirSync(directory).some(name => name.endsWith(".tmp")));
    });
    await checkAsync("CAPSOLVER 保存：非法输入或加密失败不覆盖旧配置，解密异常不泄露原文", async () => {
      const store = createStore({ file, ...codec });
      store.save(key);
      for (const bad of ["", "  ", "key\nsecret", null, 42]) assert.throws(() => store.save(bad), /有效/);
      const failing = createStore({ file, protect: () => { throw new Error(key); }, unprotect: () => { throw new Error(key); } });
      assert.throws(() => failing.save("replacement"), error => !error.message.includes(key));
      assert.throws(() => failing.getKey(), error => !error.message.includes(key));
      assert.strictEqual(store.getKey(), key);
    });
    await checkAsync("CAPSOLVER 保存：真实 Windows 加密可跨实例解密，原文件不含密钥", async () => {
      if (process.platform !== "win32") return;
      const windowsFile = path.join(directory, "windows.json");
      createStore({ file: windowsFile }).save(key);
      assert.ok(!fs.readFileSync(windowsFile, "utf8").includes(key));
      assert.strictEqual(createStore({ file: windowsFile }).getKey(), key);
    });
    await checkAsync("CAPSOLVER 设置 API：只返回配置状态，运行自动读取保存的密钥，跨域请求被拒", async () => {
      const store = createStore({ file, ...codec });
      store.clear();
      const jobs = [];
      const engine = {
        normalizeActionSelection: (ids) => ids, validateActionSelection: () => null,
        createJob: (config) => { jobs.push(config); return { id: "fixture-job" }; },
        publicJob: (job) => ({ id: job.id }),
      };
      const moduleObject = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/router.js"), "utf8"), {
        module: moduleObject, exports: moduleObject.exports, __dirname: path.join(__dirname, "../src"), URL,
        require: (name) => name === "fs" ? fs : name === "path" ? path : name === "./capsolver-settings" ? store
          : name === "./automation/engine" ? engine : {},
      });
      const server = http.createServer((req, res) => {
        moduleObject.exports.handle(req, res).catch(() => { res.writeHead(500); res.end('{}'); });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const request = (route, method = "GET", body, extraHeaders = {}) => fetch(base + route, {
        method, headers: { "content-type": "application/json", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const endpoint = "/api/settings/capsolver";
      try {
        assert.deepStrictEqual(await (await request(endpoint)).json(), { configured: false });
        assert.deepStrictEqual(await (await request(endpoint, "PUT", { apiKey: key })).json(), { configured: true });
        assert.deepStrictEqual(await (await request(endpoint)).json(), { configured: true });
        const run = { mode: "local", accountIds: ["fixture"], actionIds: ["login"], captchaSolver: { enabled: true, maxAttemptsPerAccount: 1 } };
        const response = await request("/api/automation/run", "POST", run);
        assert.strictEqual(response.status, 202);
        assert.strictEqual(jobs[0].captchaSolver.apiKey, key);
        assert.ok(!(await response.text()).includes(key));
        const autoRun = { ...run, actionIds: ["login", "detect-ban"], manualChallengePolicy: "solve_close", captchaSolver: null, keepOpen: true };
        const autoResponse = await request("/api/automation/run", "POST", autoRun);
        assert.strictEqual(autoResponse.status, 202);
        assert.strictEqual(jobs[1].captchaSolver.apiKey, key);
        assert.strictEqual(jobs[1].captchaSolver.enabled, true);
        assert.strictEqual(jobs[1].manualChallengePolicy, "solve_close");
        assert.ok(!(await autoResponse.text()).includes(key));
        assert.strictEqual((await request(endpoint, "PUT", { apiKey: "attacker" }, { origin: "https://other.example" })).status, 403);
        assert.strictEqual((await request(endpoint, "DELETE", undefined, { origin: "https://other.example" })).status, 403);
        assert.strictEqual((await request("/api/automation/run", "POST", run, { origin: "https://other.example" })).status, 403);
        assert.strictEqual((await request("/api/automation/run", "POST", autoRun, { origin: "https://other.example" })).status, 403);
        assert.strictEqual(store.getKey(), key);
        assert.deepStrictEqual(await (await request(endpoint, "DELETE")).json(), { configured: false });
        assert.strictEqual((await request("/api/automation/run", "POST", run)).status, 400);
        assert.strictEqual((await request("/api/automation/run", "POST", autoRun)).status, 400);
        assert.strictEqual(jobs.length, 2);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  } finally {
    // This freshly created test directory is the only cleanup target.
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, fn) => { await fn(); passed++; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} passed`)).catch(error => { console.error(error); process.exitCode = 1; });
}
