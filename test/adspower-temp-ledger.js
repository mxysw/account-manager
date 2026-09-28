"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLedger } = require("../src/automation/adspower-temp-ledger");

async function withFile(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "am-ads-ledger-"));
  const file = path.join(directory, "ledger.json");
  try { await work(file); }
  finally {
    for (const name of fs.readdirSync(directory)) {
      if (name === "ledger.json" || /^ledger\.json\.[A-Za-z0-9-]+\.tmp$/.test(name)) {
        fs.unlinkSync(path.join(directory, name));
      } else {
        throw new Error(`测试留下未知文件：${name}`);
      }
    }
    fs.rmdirSync(directory);
  }
}

module.exports = async function runAdsPowerTempLedgerTests({ checkAsync }) {
  await checkAsync("AdsPower 临时台账：创建意图先持久化，未知 profileId 绝不能删除", () => withFile(async (file) => {
    const ledger = createLedger({ file });
    const intent = ledger.begin("job-1", "task-1");
    assert.match(intent.nonce, /^[A-Za-z0-9_-]{16,128}$/);
    assert.strictEqual(intent.state, "creating");
    assert.strictEqual(intent.profileId, null);
    assert.deepStrictEqual(ledger.listOwned(), []);
    assert.throws(() => ledger.deletionCandidate(intent.nonce), /禁止删除/);
    const reloaded = createLedger({ file });
    assert.deepStrictEqual(reloaded.get(intent.nonce), intent);
    assert.strictEqual(reloaded.begin("job-1", "task-1").nonce, intent.nonce,
      "同一个任务重试不能再生成第二个创建意图");
  }));

  await checkAsync("AdsPower 临时台账：仅响应 ID 可成为所有权，关闭后才能删除", () => withFile(async (file) => {
    const ledger = createLedger({ file });
    const intent = ledger.begin("job-2", "task-2", "fixture_nonce_000000002");
    assert.throws(() => ledger.markClosed(intent.nonce), /状态不能/);
    assert.throws(() => ledger.markDeleted(intent.nonce), /状态不能/);
    const created = ledger.recordProfile(intent.nonce, "profile-2");
    assert.strictEqual(created.state, "created");
    assert.strictEqual(created.profileId, "profile-2");
    assert.strictEqual(ledger.recordProfile(intent.nonce, "profile-2").state, "created");
    assert.deepStrictEqual(ledger.listOwned().map((item) => item.profileId), ["profile-2"]);
    assert.throws(() => ledger.deletionCandidate(intent.nonce), /禁止删除/);
    ledger.markClosed(intent.nonce);
    assert.strictEqual(ledger.markClosed(intent.nonce).state, "closed");
    assert.strictEqual(ledger.deletionCandidate(intent.nonce), "profile-2");
    const reloaded = createLedger({ file });
    assert.deepStrictEqual(reloaded.listOwned().map((item) => item.profileId), ["profile-2"]);
    assert.strictEqual(reloaded.deletionCandidate(intent.nonce), "profile-2");
    reloaded.markDeleted(intent.nonce);
    assert.strictEqual(reloaded.markDeleted(intent.nonce).state, "deleted");
    assert.deepStrictEqual(reloaded.listOwned(), []);
    assert.throws(() => reloaded.deletionCandidate(intent.nonce), /禁止删除/);
    assert.strictEqual(createLedger({ file }).get(intent.nonce).state, "deleted");
  }));

  await checkAsync("AdsPower 临时台账：冲突 ID、nonce 与非法状态拒绝覆盖", () => withFile(async (file) => {
    const ledger = createLedger({ file });
    const first = ledger.begin("job-3", "task-a", "fixture_nonce_000000003");
    const second = ledger.begin("job-3", "task-b", "fixture_nonce_000000004");
    assert.throws(() => ledger.begin("job-3", "task-a", "fixture_nonce_000000005"), /不同的创建意图/);
    assert.throws(() => ledger.begin("job-4", "task-c", first.nonce), /nonce 已存在/);
    assert.throws(() => ledger.recordProfile("unknown_nonce_00000001", "profile-x"), /不存在/);
    assert.throws(() => ledger.recordProfile(first.nonce, "../../other"), /profileId 无效/);
    ledger.recordProfile(first.nonce, "profile-a");
    assert.throws(() => ledger.recordProfile(second.nonce, "profile-a"), /已归属其它/);
    assert.throws(() => ledger.recordProfile(first.nonce, "profile-b"), /状态不能/);
    assert.throws(() => ledger.markDeleted(first.nonce), /状态不能/);
    assert.strictEqual(ledger.get(first.nonce).profileId, "profile-a");
    assert.strictEqual(ledger.get(second.nonce).profileId, null);
  }));

  await checkAsync("AdsPower 临时台账：读取损坏记录时失败关闭，不重建空台账", () => withFile(async (file) => {
    fs.writeFileSync(file, "{broken", "utf8");
    assert.throws(() => createLedger({ file }), /读取失败/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{broken");
    fs.writeFileSync(file, JSON.stringify({ version: 1, records: [{
      jobId: "job-4", taskId: "task-4", nonce: "fixture_nonce_000000006",
      profileId: "profile-4", state: "creating", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }] }), "utf8");
    assert.throws(() => createLedger({ file }), /创建意图不能包含 profileId/);
  }));

  await checkAsync("AdsPower 临时台账：原子替换失败时磁盘和内存均保留旧状态", () => withFile(async (file) => {
    const initial = createLedger({ file });
    const intent = initial.begin("job-5", "task-5", "fixture_nonce_000000007");
    const before = fs.readFileSync(file, "utf8");
    const failingFs = new Proxy(fs, {
      get(target, key) {
        if (key === "renameSync") return () => { throw new Error("fixture rename failed"); };
        return Reflect.get(target, key);
      },
    });
    const failing = createLedger({ file, fsApi: failingFs });
    assert.throws(() => failing.recordProfile(intent.nonce, "profile-5"), /保存失败/);
    assert.strictEqual(failing.get(intent.nonce).state, "creating");
    assert.strictEqual(fs.readFileSync(file, "utf8"), before);
    assert.strictEqual(fs.readdirSync(path.dirname(file)).length, 1, "失败的临时写盘文件已清理");
    assert.strictEqual(createLedger({ file }).get(intent.nonce).state, "creating");
  }));

  await checkAsync("AdsPower 临时台账：返回副本不能篡改已登记所有权", () => withFile(async (file) => {
    const ledger = createLedger({ file });
    const intent = ledger.begin("job-6", "task-6", "fixture_nonce_000000008");
    ledger.recordProfile(intent.nonce, "profile-6");
    const owned = ledger.listOwned();
    owned[0].profileId = "someone-else";
    assert.strictEqual(ledger.get(intent.nonce).profileId, "profile-6");
    assert.strictEqual(createLedger({ file }).listOwned()[0].profileId, "profile-6");
  }));
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (_name, run) => { await run(); passed += 1; } })
    .then(() => console.log(`${passed} AdsPower temporary ledger groups passed`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
