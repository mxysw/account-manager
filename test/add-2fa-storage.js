"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Fixture-only storage/engine tests. The caller must provide the isolated test account store.
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const WHEN = "2026-09-12T00:00:00.000Z";

module.exports = async function runAdd2faStorageTests({ check, checkAsync, accounts }) {
  const engine = require("../src/automation/engine");
  const helpers = engine.helpers;
  const created = [];
  let count = 0;
  const seed = () => {
    const email = `__add2fa_storage_${Date.now()}_${count++}@example.com`;
    accounts.importText(`${email}|fixture-password|backup@example.net|FA`);
    const account = accounts.list().find((item) => item.email === email);
    created.push(account.id);
    return account;
  };
  try {
    check("添加 2FA 结果只保存白名单状态、短说明和时间", () => {
      for (const state of ["added", "already_configured", "needs_attention", "failed", "pending_activation"]) {
        assert.deepStrictEqual(accounts.normalizeTotpSetup({ state, detail: "fixture", checkedAt: WHEN, secret: SECRET, junk: true }),
          { state, detail: "fixture", checkedAt: WHEN });
      }
      assert.strictEqual(accounts.normalizeTotpSetup([]), null);
      const invalid = accounts.normalizeTotpSetup({ state: "ok", detail: "测".repeat(700), checkedAt: "invalid" });
      assert.strictEqual(invalid.state, "failed");
      assert.strictEqual(invalid.detail.length, 500);
      assert.ok(Number.isFinite(Date.parse(invalid.checkedAt)));
      const sanitized = accounts.normalizeTotpSetup({ state: "failed", detail: `otpauth://totp/fixture?secret=${SECRET} https://example.com/?token=hidden ${SECRET}` });
      assert.ok(!sanitized.detail.includes(SECRET));
      assert.ok(!sanitized.detail.includes("hidden"));
    });

    check("待确认 2FA 密钥规范化，不接受非法密钥或阶段", () => {
      assert.deepStrictEqual(accounts.normalizePendingTotpSetup({ secret: `jbsw y3dp-ehpk3pxpjbswy3dpehpk3pxp===`, stage: "prepared", createdAt: WHEN, confirmed: true }),
        { secret: SECRET, stage: "prepared", createdAt: WHEN });
      for (const secret of ["", "ABC", "INVALID-0189", "A".repeat(300)]) {
        assert.strictEqual(accounts.normalizePendingTotpSetup({ secret, stage: "prepared" }), null);
      }
      assert.strictEqual(accounts.normalizePendingTotpSetup({ secret: SECRET, stage: "verified" }), null);
      assert.strictEqual(accounts.normalizePendingTotpSetup([]), null);
    });

    check("无验证器导入默认未添加；复原检测不删除待确认密钥", () => {
      const account = seed();
      assert.strictEqual(account.lastTotpSetup, null);
      assert.strictEqual(account.pendingTotpSetup, null);
      accounts.update(account.id, {
        pendingTotpSetup: { secret: SECRET, stage: "submitted", createdAt: WHEN },
        lastTotpSetup: { state: "needs_attention", detail: "待确认", checkedAt: WHEN },
      });
      assert.strictEqual(account.totpSecret, "");
      assert.deepStrictEqual(accounts.currentTotp(account.id), { error: "该账号没有 2FA 密钥" });
      accounts.resetStatus([account.id]);
      assert.strictEqual(account.lastTotpSetup, null);
      assert.strictEqual(account.pendingTotpSetup.secret, SECRET);
      assert.strictEqual(account.pendingTotpSetup.stage, "submitted");
    });

    check("手工改动密钥清除旧添加结果，动作明确提供的新结果保留", () => {
      const account = seed();
      accounts.update(account.id, { lastTotpSetup: { state: "needs_attention", detail: "old", checkedAt: WHEN } });
      accounts.update(account.id, { totpSecret: SECRET });
      assert.strictEqual(account.lastTotpSetup, null);
      accounts.update(account.id, { totpSecret: "", lastTotpSetup: { state: "failed", detail: "fixture", checkedAt: WHEN } });
      assert.strictEqual(account.lastTotpSetup.state, "failed");
    });

    check("复原检测保留未结束的 2FA 开启阶段与密钥，其余添加结果正常清除", () => {
      const account = seed();
      const setup = { state: "pending_activation", detail: "验证器已确认，待开启两步验证", checkedAt: WHEN };
      accounts.update(account.id, { totpSecret: SECRET, lastTotpSetup: setup, status: { login: "ok" } });
      accounts.resetStatus([account.id]);
      assert.strictEqual(account.totpSecret, SECRET);
      assert.deepStrictEqual(account.lastTotpSetup, setup);
      assert.strictEqual(account.status.login, "unknown");
      assert.strictEqual(account.lastCheckedAt, "");
      for (const state of ["added", "already_configured", "needs_attention", "failed"]) {
        accounts.update(account.id, { lastTotpSetup: { state, detail: "fixture", checkedAt: WHEN } });
        accounts.resetStatus([account.id]);
        assert.strictEqual(account.lastTotpSetup, null, state);
        assert.strictEqual(account.totpSecret, SECRET, "复原检测不清密钥");
      }
    });

    check("老账号迁移规范化添加结果与待确认密钥，绝不提升为已启用密钥", () => {
      const os = require("os");
      const { spawnSync } = require("child_process");
      const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-manager-add2fa-migration-"));
      try {
        fs.writeFileSync(path.join(migrationDir, "accounts.json"), JSON.stringify({ accounts: [
          { id: "old-fixture", email: "old@example.com", totpSecret: "", pendingTotpSetup: { secret: SECRET.toLowerCase(), stage: "submitted", createdAt: WHEN, junk: true },
            lastTotpSetup: { state: "needs_attention", detail: "fixture", checkedAt: WHEN, secret: SECRET } },
          { id: "older-fixture", email: "older@example.com", totpSecret: "" },
        ] }));
        const script = `const a = require(${JSON.stringify(require.resolve("../src/accounts"))}); a.flush(); process.stdout.write(JSON.stringify(a.list().map(x => ({ id: x.id, totpSecret: x.totpSecret, lastTotpSetup: x.lastTotpSetup, pendingTotpSetup: x.pendingTotpSetup }))));`;
        const run = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, ACCOUNT_MANAGER_DATA_DIR: migrationDir }, encoding: "utf8" });
        assert.strictEqual(run.status, 0, run.stderr);
        const [old, older] = JSON.parse(run.stdout);
        assert.strictEqual(old.totpSecret, "");
        assert.deepStrictEqual(old.pendingTotpSetup, { secret: SECRET, stage: "submitted", createdAt: WHEN });
        assert.deepStrictEqual(old.lastTotpSetup, { state: "needs_attention", detail: "fixture", checkedAt: WHEN });
        assert.strictEqual(older.lastTotpSetup, null);
        assert.strictEqual(older.pendingTotpSetup, null);
      } finally {
        fs.rmSync(migrationDir, { recursive: true, force: true });
      }
    });

    await checkAsync("2FA checkpoint 先落盘待确认密钥，不能提前变成登录密钥", async () => {
      const account = seed();
      const ctx = helpers.createTotpSetupContext(account, { results: [] }, () => {});
      await ctx.checkpointTotpSetup({ pendingTotpSetup: { secret: SECRET, stage: "prepared", createdAt: WHEN }, password: "must-not-write" });
      const saved = JSON.parse(fs.readFileSync(accounts._db.file, "utf8")).accounts.find((item) => item.id === account.id);
      assert.strictEqual(saved.pendingTotpSetup.secret, SECRET);
      assert.strictEqual(saved.totpSecret, "");
      assert.strictEqual(saved.password, "fixture-password");
      await ctx.checkpointTotpSetup({
        totpSecret: SECRET, pendingTotpSetup: null,
        lastTotpSetup: { state: "pending_activation", detail: "验证器已确认，待开启两步验证", checkedAt: WHEN },
      });
      const confirmed = JSON.parse(fs.readFileSync(accounts._db.file, "utf8")).accounts.find((item) => item.id === account.id);
      assert.strictEqual(confirmed.totpSecret, SECRET);
      assert.strictEqual(confirmed.pendingTotpSetup, null);
      assert.strictEqual(confirmed.lastTotpSetup.state, "pending_activation");
    });

    await checkAsync("2FA checkpoint 等待持久化完成，保存失败不允许继续", async () => {
      const account = { id: "fixture", totpSecret: "", pendingTotpSetup: null };
      let flushDone;
      let finished = false;
      const store = {
        normalizePendingTotpSetup: accounts.normalizePendingTotpSetup,
        normalizeTotpSecret: accounts.normalizeTotpSecret,
        normalizeTotpSetup: accounts.normalizeTotpSetup,
        update: (_id, patch) => Object.assign(account, patch),
        flush: () => new Promise((resolve) => { flushDone = resolve; }),
      };
      const ctx = helpers.createTotpSetupContext(account, { results: [] }, () => {}, new Set(), store);
      const waiting = ctx.checkpointTotpSetup({ pendingTotpSetup: { secret: SECRET, stage: "prepared" } }).then(() => { finished = true; });
      await Promise.resolve();
      assert.strictEqual(finished, false);
      flushDone();
      await waiting;
      assert.strictEqual(finished, true);
      store.flush = () => { throw new Error(`disk-error ${SECRET}`); };
      await assert.rejects(ctx.checkpointTotpSetup({ totpSecret: SECRET, pendingTotpSetup: null }), /无法安全保存/);
      assert.strictEqual(account.totpSecret, "");
      assert.strictEqual(account.pendingTotpSetup.secret, SECRET);
      await assert.rejects(ctx.checkpointTotpSetup({ pendingTotpSetup: { secret: "bad", stage: "prepared" } }), /密钥无效/);
      await assert.rejects(ctx.checkpointTotpSetup({ totpSecret: "" }), /密钥无效/);
    });

    await checkAsync("2FA checkpoint 保存失败同时回滚隐式阶段清理与时间更新", async () => {
      const account = seed();
      accounts.update(account.id, { lastTotpSetup: { state: "needs_attention", detail: "before", checkedAt: WHEN } });
      account.lastCheckedAt = WHEN;
      account.updatedAt = WHEN;
      accounts.flush();
      const before = { lastTotpSetup: account.lastTotpSetup, lastCheckedAt: account.lastCheckedAt, updatedAt: account.updatedAt };
      const store = { ...accounts, flush: () => { throw new Error("fixture-disk-failure"); } };
      const ctx = helpers.createTotpSetupContext(account, { results: [] }, () => {}, new Set(), store);
      await assert.rejects(ctx.checkpointTotpSetup({ totpSecret: SECRET }), /无法安全保存/);
      assert.strictEqual(account.totpSecret, "");
      assert.deepStrictEqual(account.lastTotpSetup, before.lastTotpSetup);
      assert.strictEqual(account.lastCheckedAt, before.lastCheckedAt);
      assert.strictEqual(account.updatedAt, before.updatedAt);
      await assert.rejects(ctx.checkpointTotpSetup({ lastTotpSetup: { state: "added", detail: "after", checkedAt: WHEN } }), /无法安全保存/);
      assert.deepStrictEqual(account.lastTotpSetup, before.lastTotpSetup);
      assert.strictEqual(account.lastCheckedAt, before.lastCheckedAt);
      assert.strictEqual(account.updatedAt, before.updatedAt);
      accounts.flush();
    });

    await checkAsync("添加 2FA 内部登录同步保存结果，不再遗漏列表登录状态", async () => {
      const account = seed();
      const task = { results: [] };
      const ctx = helpers.createTotpSetupContext(account, task, () => {}, new Set([SECRET]));
      await ctx.recordLoginResult({ outcome: "ok", reasonCode: "ok", statusPatch: { login: "ok", gmail: "banned" }, detail: { login: "fixture", secret: SECRET },
        fieldPatch: { lastLoginCheck: { outcome: "ok", reasonCode: "ok", detail: "已登录", checkedAt: WHEN }, password: "do-not-change" } });
      const saved = JSON.parse(fs.readFileSync(accounts._db.file, "utf8")).accounts.find((item) => item.id === account.id);
      assert.strictEqual(saved.status.login, "ok");
      assert.strictEqual(saved.status.gmail, "unknown");
      assert.strictEqual(saved.lastLoginCheck.reasonCode, "ok");
      assert.strictEqual(saved.password, "fixture-password");
      assert.strictEqual(task.results.length, 1);
      assert.strictEqual(task.results[0].action, "login");
      assert.ok(!JSON.stringify(task).includes(SECRET));
      await ctx.recordLoginResult({ outcome: "need_verify", reasonCode: "captcha", statusPatch: { login: "need_verify" },
        fieldPatch: { lastLoginCheck: { outcome: "need_verify", reasonCode: "captcha", detail: "验证码", checkedAt: WHEN } } });
      assert.strictEqual(task.results.length, 1);
      assert.strictEqual(account.lastLoginCheck.reasonCode, "captcha");
    });

    check("添加 2FA 的公开任务结果不暴露活跃/待确认密钥、验证码、二维码", () => {
      const raw = { action: "add-2fa", outcome: "ok", detail: { "2fa": "已添加", secret: SECRET, code: "123456", nested: { uri: `otpauth://totp/x?secret=${SECRET}` } },
        fieldPatch: { totpSecret: SECRET, pendingTotpSetup: { secret: SECRET, stage: "prepared" }, lastTotpSetup: { state: "added", detail: "已添加", checkedAt: WHEN } } };
      const safe = helpers.publicActionResult(raw);
      assert.deepStrictEqual(Object.keys(safe.fieldPatch), ["lastTotpSetup"]);
      assert.strictEqual(safe.fieldPatch.lastTotpSetup.state, "added");
      assert.ok(!JSON.stringify(safe).includes(SECRET));
      assert.ok(!JSON.stringify(safe).includes("123456"));
      const job = { envs: [], tasks: [{ results: [raw] }] };
      assert.ok(!JSON.stringify(engine.publicJob(job)).includes(SECRET));
    });

    check("添加 2FA 意外中断保留阶段，不把待确认密钥判成成功", () => {
      const failed = helpers.buildUnhandledTotpSetupResult({ totpSecret: "", pendingTotpSetup: null }, "fixture-error");
      assert.strictEqual(failed.fieldPatch.lastTotpSetup.state, "failed");
      const pending = helpers.buildUnhandledTotpSetupResult({ totpSecret: "", pendingTotpSetup: { secret: SECRET } }, "fixture-error");
      assert.strictEqual(pending.fieldPatch.lastTotpSetup.state, "needs_attention");
      assert.strictEqual(pending.outcome, "need_verify");
      const activation = helpers.buildUnhandledTotpSetupResult({ totpSecret: SECRET, lastTotpSetup: { state: "pending_activation" } }, "fixture-error");
      assert.strictEqual(activation.fieldPatch.lastTotpSetup.state, "pending_activation");
      assert.ok(!JSON.stringify(pending).includes(SECRET));
    });

    await checkAsync("引擎只向添加 2FA 注入 checkpoint，并记录自动登录与设置中断", async () => {
      const localBrowser = require("../src/automation/local-browser");
      const browser = require("../src/automation/browser");
      const registry = require("../src/automation/actions");
      const original = { start: localBrowser.start, connect: browser.connect, add: registry.REGISTRY["add-2fa"].run, login: registry.REGISTRY.login.run };
      const account = seed();
      const wait = async (job) => {
        for (let attempt = 0; attempt < 100 && job.status === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.notStrictEqual(job.status, "running");
      };
      try {
        localBrowser.start = async () => ({ cdpEndpoint: "http://fixture", stop: async () => {} });
        browser.connect = async () => ({ page: {}, close: async () => {}, disconnect: async () => {}, label: async () => ({ ok: true }) });
        registry.REGISTRY.login.run = async (_page, _account, ctx) => {
          assert.strictEqual(ctx.checkpointTotpSetup, undefined);
          assert.strictEqual(ctx.recordLoginResult, undefined);
          return { outcome: "ok", statusPatch: { login: "ok" }, fieldPatch: {} };
        };
        await wait(engine.createJob({ mode: "local", accountIds: [account.id], actionIds: ["login"], clearData: false, keepOpen: false }));
        registry.REGISTRY["add-2fa"].run = async (_page, _account, ctx) => {
          await ctx.recordLoginResult({ outcome: "ok", statusPatch: { login: "ok" }, fieldPatch: {
            lastLoginCheck: { outcome: "ok", reasonCode: "ok", detail: "fixture-login", checkedAt: WHEN },
          } });
          await ctx.checkpointTotpSetup({ pendingTotpSetup: { secret: SECRET, stage: "submitted", createdAt: WHEN } });
          ctx.emit("fixture", { secret: SECRET, text: SECRET, nested: { code: "123456" } });
          throw new Error(`fixture-interrupted ${SECRET}`);
        };
        const job = engine.createJob({ mode: "local", accountIds: [account.id], actionIds: ["add-2fa"], clearData: false, keepOpen: false });
        await wait(job);
        assert.strictEqual(account.lastLoginCheck.outcome, "ok");
        assert.strictEqual(account.lastTotpSetup.state, "needs_attention");
        assert.strictEqual(account.pendingTotpSetup.secret, SECRET);
        assert.strictEqual(account.totpSecret, "");
        assert.deepStrictEqual(job.tasks[0].results.map((result) => result.action), ["login", "add-2fa"]);
        assert.ok(!JSON.stringify(job.tasks).includes(SECRET));
        assert.ok(!JSON.stringify(job.tasks).includes("123456"));
        const startupAccount = seed();
        localBrowser.start = async () => { throw new Error("未找到本机浏览器"); };
        const startup = engine.createJob({ mode: "local", accountIds: [startupAccount.id], actionIds: ["add-2fa"], clearData: false, keepOpen: false });
        await wait(startup);
        assert.strictEqual(startupAccount.lastLoginCheck.reasonCode, "browser_start_failed");
        assert.strictEqual(startupAccount.lastTotpSetup.state, "failed");
      } finally {
        localBrowser.start = original.start;
        browser.connect = original.connect;
        registry.REGISTRY["add-2fa"].run = original.add;
        registry.REGISTRY.login.run = original.login;
      }
    });
  } finally {
    accounts.remove(created);
    accounts.flush();
  }
};

if (require.main === module) {
  const os = require("os");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-manager-add2fa-test-"));
  process.env.ACCOUNT_MANAGER_DATA_DIR = dataDir;
  const accounts = require("../src/accounts");
  let passed = 0;
  const check = (name, fn) => { fn(); passed += 1; console.log(`ok ${name}`); };
  const checkAsync = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); };
  module.exports({ check, checkAsync, accounts })
    .then(() => console.log(`${passed} 项通过`))
    .catch((err) => { console.error(err.stack); process.exitCode = 1; })
    .finally(() => {
      accounts.flush();
      // dataDir is the concrete directory returned by mkdtemp above, never the workspace/data directory.
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
}
