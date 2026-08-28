"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// 测试必须使用一次性数据目录，绝不读写真实的 data/accounts.json。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "account-manager-test-"));
process.env.ACCOUNT_MANAGER_DATA_DIR = TEST_DATA_DIR;
function cleanupTestData() {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
process.on("exit", cleanupTestData);

const assert = require("assert");
const totp = require("../src/totp");
const accounts = require("../src/accounts");
const login = require("../src/automation/actions/login");
const removePhones = require("../src/automation/actions/remove-phones");
const actionsRegistry = require("../src/automation/actions");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// RFC 6238 测试向量：secret = ASCII "12345678901234567890"
// 其 base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ；T=59s 时 6 位码为 287082。
check("TOTP RFC6238 向量", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const r = totp.generate(secret, { now: 59000 });
  assert.strictEqual(r.code, "287082");
});

check("base32 大小写/空格容错", () => {
  const a = totp.generate("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", { now: 59000 });
  assert.strictEqual(a.code, "287082");
});

check("解析 | 分隔 + 年份国家", () => {
  const p = accounts.parseLine("user-a@example.com|pw123|JBSWY3DPEHPK3PXPJBSWY3DP|2019|US");
  assert.strictEqual(p.email, "user-a@example.com");
  assert.strictEqual(p.totpSecret, "JBSWY3DPEHPK3PXPJBSWY3DP");
  assert.strictEqual(p.year, "2019");
  assert.strictEqual(p.country, "US");
});

check("解析 ---- 分隔 + 辅助邮箱", () => {
  const p = accounts.parseLine("user-b@example.com----pw----recovery@example.net----KZXW6YTBOI5XW4TBOIQXG5DBNJ");
  assert.strictEqual(p.recoveryEmail, "recovery@example.net");
  assert.strictEqual(p.totpSecret, "KZXW6YTBOI5XW4TBOIQXG5DBNJ");
});

check("非法格式抛错", () => {
  assert.throws(() => accounts.parseLine("no-separator-line"));
});

// ---- 服务限制 restrict 字段：默认 unknown、可被设为 restricted/ok（唯一假邮箱，跑完即清理）----
check("STATUS_FIELDS 含 restrict，允许值 unknown/ok/restricted", () => {
  assert.ok(Array.isArray(accounts.STATUS_FIELDS.restrict), "STATUS_FIELDS.restrict 应存在");
  assert.deepStrictEqual(accounts.STATUS_FIELDS.restrict, ["unknown", "ok", "restricted"]);
});

check("STATUS_FIELDS 含 phone(验证电话)，允许值 unknown/ok/removed/none/failed", () => {
  assert.ok(Array.isArray(accounts.STATUS_FIELDS.phone), "STATUS_FIELDS.phone 应存在");
  assert.deepStrictEqual(accounts.STATUS_FIELDS.phone, ["unknown", "ok", "removed", "none", "failed"]);
});

check("复原检测后分类回到 unchecked（未检测）", () => {
  const email = `__test_reset_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    accounts.update(a.id, { status: { login: "ok" } });
    accounts.classify([a.id]);
    accounts.resetStatus([a.id]);
    const reset = accounts.getById(a.id);
    assert.strictEqual(reset.category, "unchecked");
    assert.ok(Object.values(reset.status).every((v) => v === "unknown"));
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

check("导入默认 phone=unknown；可设 removed / none / failed；非法值被拒", () => {
  const email = `__test_phone_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    assert.strictEqual(a.status.phone, "unknown", "新导入 phone 默认 unknown");

    accounts.update(a.id, { status: { phone: "removed" } });
    assert.strictEqual(accounts.getById(a.id).status.phone, "removed", "removed 应写入");

    accounts.update(a.id, { status: { phone: "none" } });
    assert.strictEqual(accounts.getById(a.id).status.phone, "none", "none 应写入");

    accounts.update(a.id, { status: { phone: "failed" } });
    assert.strictEqual(accounts.getById(a.id).status.phone, "failed", "failed 应写入");

    // 非法值应被拒（保持上一次 failed）。
    accounts.update(a.id, { status: { phone: "banned" } });
    assert.strictEqual(accounts.getById(a.id).status.phone, "failed", "非法值不应写入");
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

check("remove-phones 已注册到动作表（high 风险写操作）", () => {
  const item = actionsRegistry.list().find((x) => x.id === "remove-phones");
  assert.ok(item, "actions 列表应含 remove-phones");
  assert.strictEqual(item.risk, "high");
  assert.strictEqual(item.readOnly, false);
  assert.strictEqual(typeof actionsRegistry.get("remove-phones").run, "function", "run 应为函数");
});

check("remove-phones summarize：两处都无→ok/none；均移除→ok/removed；有失败→need_verify/failed", () => {
  const { summarize, phonePresent } = removePhones._internals;

  const bothNone = summarize({ twosv: { kind: "none" }, recovery: { kind: "none" } });
  assert.strictEqual(bothNone.outcome, "ok");
  assert.strictEqual(bothNone.statusPatch.phone, "none");

  const bothRemoved = summarize({ twosv: { kind: "removed" }, recovery: { kind: "removed" } });
  assert.strictEqual(bothRemoved.outcome, "ok");
  assert.strictEqual(bothRemoved.statusPatch.phone, "removed");

  // 一处移除、一处本来就没有 → 仍算成功 removed。
  const removedAndNone = summarize({ twosv: { kind: "removed" }, recovery: { kind: "none" } });
  assert.strictEqual(removedAndNone.statusPatch.phone, "removed");

  // 有一处失败 → failed + need_verify。
  const withFail = summarize({ twosv: { kind: "removed" }, recovery: { kind: "failed" } });
  assert.strictEqual(withFail.outcome, "need_verify");
  assert.strictEqual(withFail.statusPatch.phone, "failed");

  // phonePresent：有删除控件或有号码且非空态 → 存在。
  assert.strictEqual(phonePresent({ controlCount: 1, hasNumber: false, emptyState: false }), true);
  assert.strictEqual(phonePresent({ controlCount: 0, hasNumber: true, emptyState: false }), true);
  assert.strictEqual(phonePresent({ controlCount: 0, hasNumber: true, emptyState: true }), false);
  assert.strictEqual(phonePresent({ controlCount: 0, hasNumber: false, emptyState: false }), false);
});

check("导入默认 restrict=unknown；可设为 restricted / ok；非法值被拒", () => {
  const email = `__test_restrict_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    assert.strictEqual(a.status.restrict, "unknown", "新导入 restrict 默认 unknown");

    accounts.update(a.id, { status: { restrict: "restricted" } });
    assert.strictEqual(accounts.getById(a.id).status.restrict, "restricted");

    accounts.update(a.id, { status: { restrict: "ok" } });
    assert.strictEqual(accounts.getById(a.id).status.restrict, "ok");

    // 非法值应被拒（保持上一次的 ok，不写入垃圾值）。
    accounts.update(a.id, { status: { restrict: "banned" } });
    assert.strictEqual(accounts.getById(a.id).status.restrict, "ok", "非法值不应写入");
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

check("2FA 更换记录·默认 count=0/changedAt=空，换绑成功写回后 count 递增+记时间", () => {
  const email = `__test_totpchg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123|JBSWY3DPEHPK3PXP`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    assert.strictEqual(a.totpChangeCount, 0, "新导入默认更换次数 0");
    assert.strictEqual(a.totpChangedAt, "", "新导入默认无更换时间");

    // 模拟 change-2fa 换绑成功后的写回（走 accounts.update 持久化，与真实动作一致）。
    const iso = new Date().toISOString();
    accounts.update(a.id, {
      totpSecret: "KZXW6YTBOI5XW4TBOIQXG5DB",
      oldTotpSecret: "JBSWY3DPEHPK3PXP",
      totpChangeCount: (Number(a.totpChangeCount) || 0) + 1,
      totpChangedAt: iso,
    });
    const b = accounts.getById(a.id);
    assert.strictEqual(b.totpChangeCount, 1, "换绑成功后计数应 +1");
    assert.strictEqual(typeof b.totpChangeCount, "number", "计数应存为整数");
    assert.strictEqual(b.totpChangedAt, iso, "应记录最近更换时间");
    assert.strictEqual(b.oldTotpSecret, "JBSWY3DPEHPK3PXP", "旧密钥应备份");
    assert.strictEqual(b.totpSecret, "KZXW6YTBOI5XW4TBOIQXG5DB", "新密钥应写回");

    // 再换一次：计数继续累加。
    accounts.update(a.id, { totpChangeCount: (Number(b.totpChangeCount) || 0) + 1, totpChangedAt: new Date().toISOString() });
    assert.strictEqual(accounts.getById(a.id).totpChangeCount, 2, "再次换绑计数应到 2");

    // 非法计数不应让已有次数倒退。
    accounts.update(a.id, { totpChangeCount: "abc" });
    assert.strictEqual(accounts.getById(a.id).totpChangeCount, 2, "非法计数应保持原值");
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 分类规则 computeCategory：覆盖各分支 + 边界 ----
// 构造一个带指定 status 的 mock 账号（未给的字段默认 unknown）。
function mockAcc(status = {}) {
  const base = {
    login: "unknown", gmail: "unknown", youtube: "unknown", payment: "unknown",
    family: "unknown", gemini: "unknown", gpt: "unknown", device: "unknown", age: "unknown",
  };
  return { id: "t", status: { ...base, ...status } };
}

check("分类·未检测(全 unknown) → unchecked", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc()), "unchecked");
});

check("分类·部分检测(只登录) → none", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok" })), "none");
});

check("分类·gmail 封禁 → scrap", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "banned", youtube: "ok" })), "scrap");
});

check("分类·youtube 封禁 → scrap", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ youtube: "banned" })), "scrap");
});

check("分类·gpt 封禁 → scrap（封禁优先于其它）", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok", youtube: "ok", gpt: "banned", device: "cleaned" })), "scrap");
});

check("分类·全绿+可授权+设备已清 → sell", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok", youtube: "ok", gpt: "ok", device: "cleaned" })), "sell");
});

check("分类·全绿+可授权但设备未清(rejected) → nurture（没达出售标准就养着）", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok", youtube: "ok", gpt: "ok", device: "rejected" })), "nurture");
});

check("分类·养号 gpt=blocked + device=rejected → nurture", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok", youtube: "ok", gpt: "blocked", device: "rejected" })), "nurture");
});

check("分类·养号 gpt=cf_blocked + device=seckey → nurture", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok", youtube: "ok", gpt: "cf_blocked", device: "seckey" })), "nurture");
});

check("分类·无法验证身份(gpt=blocked)但其它全绿 → nurture（拒绝登录≠被封）", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "ok", gmail: "ok", youtube: "ok", gpt: "blocked", device: "cleaned" })), "nurture");
});

check("分类·未登录(login!=ok)即使其它绿 → none", () => {
  assert.strictEqual(accounts.computeCategory(mockAcc({ login: "need_verify", gmail: "ok", youtube: "ok", gpt: "ok", device: "cleaned" })), "none");
});

// ---- 货源标签 source + 销售状态 saleStatus/soldAt（用唯一假邮箱，跑完即清理，不污染真实库）----
check("导入写入货源 source + 默认在库(in_stock)", () => {
  const email = `__test_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, { source: "测试货源A" });
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    assert.strictEqual(a.source, "测试货源A");
    assert.strictEqual(a.saleStatus, "in_stock");
    assert.strictEqual(a.soldAt, "");

    // 出库：标记已售 + 记 soldAt。
    assert.strictEqual(accounts.markSold([a.id]).changed, 1);
    const sold = accounts.getById(a.id);
    assert.strictEqual(sold.saleStatus, "sold");
    assert.ok(sold.soldAt, "已售应记录 soldAt");

    // 防重复卖：再次 markSold 不应再改动。
    assert.strictEqual(accounts.markSold([a.id]).changed, 0);

    // 退回在库：撤销已售。
    assert.strictEqual(accounts.markInStock([a.id]).changed, 1);
    const back = accounts.getById(a.id);
    assert.strictEqual(back.saleStatus, "in_stock");
    assert.strictEqual(back.soldAt, "");
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 出售管理 inSales：导入到出售/移出出售（唯一假邮箱，跑完即清理）----
check("导入默认 inSales=false；push-to-sales 置 true、remove-from-sales 移回", () => {
  const email = `__test_sales_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    // 新导入默认不在出售管理。
    assert.strictEqual(a.inSales, false);

    // 导入到出售管理：inSales 置 true，inSales 计数 +1。
    const r1 = accounts.pushToSales([a.id]);
    assert.strictEqual(r1.changed, 1);
    assert.strictEqual(accounts.getById(a.id).inSales, true);

    // 幂等：已在出售管理的再次 push 不应改动。
    assert.strictEqual(accounts.pushToSales([a.id]).changed, 0);

    // 移出出售管理：inSales 置回 false。
    assert.strictEqual(accounts.removeFromSales([a.id]).changed, 1);
    assert.strictEqual(accounts.getById(a.id).inSales, false);
    // 幂等：不在出售管理的再次移出不应改动。
    assert.strictEqual(accounts.removeFromSales([a.id]).changed, 0);
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 养号管理 inNurture：导入到养号/移出养号（唯一假邮箱，跑完即清理）----
check("导入默认 inNurture=false；push-to-nurture 置 true、remove-from-nurture 移回", () => {
  const email = `__test_nurture_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    // 新导入默认不在养号管理。
    assert.strictEqual(a.inNurture, false);

    // 导入到养号管理：inNurture 置 true，inNurture 计数 +1。
    const r1 = accounts.pushToNurture([a.id]);
    assert.strictEqual(r1.changed, 1);
    assert.strictEqual(accounts.getById(a.id).inNurture, true);

    // 幂等：已在养号管理的再次 push 不应改动。
    assert.strictEqual(accounts.pushToNurture([a.id]).changed, 0);

    // 移出养号管理：inNurture 置回 false。
    assert.strictEqual(accounts.removeFromNurture([a.id]).changed, 1);
    assert.strictEqual(accounts.getById(a.id).inNurture, false);
    // 幂等：不在养号管理的再次移出不应改动。
    assert.strictEqual(accounts.removeFromNurture([a.id]).changed, 0);
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 废号管理 inScrap：导入到废号/移出废号（唯一假邮箱，跑完即清理）----
check("导入默认 inScrap=false；push-to-scrap 置 true、remove-from-scrap 移回", () => {
  const email = `__test_scrap_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    // 新导入默认不在废号管理。
    assert.strictEqual(a.inScrap, false);

    // 导入到废号管理：inScrap 置 true，inScrap 计数 +1。
    const r1 = accounts.pushToScrap([a.id]);
    assert.strictEqual(r1.changed, 1);
    assert.strictEqual(accounts.getById(a.id).inScrap, true);

    // 幂等：已在废号管理的再次 push 不应改动。
    assert.strictEqual(accounts.pushToScrap([a.id]).changed, 0);

    // 移出废号管理：inScrap 置回 false。
    assert.strictEqual(accounts.removeFromScrap([a.id]).changed, 1);
    assert.strictEqual(accounts.getById(a.id).inScrap, false);
    // 幂等：不在废号管理的再次移出不应改动。
    assert.strictEqual(accounts.removeFromScrap([a.id]).changed, 0);
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 登录失败管理 inFailed：导入到登录失败/移出登录失败（唯一假邮箱，跑完即清理）----
check("导入默认 inFailed=false；push-to-failed 置 true、remove-from-failed 移回", () => {
  const email = `__test_failed_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    // 新导入默认不在登录失败管理。
    assert.strictEqual(a.inFailed, false);

    // 导入到登录失败管理：inFailed 置 true，inFailed 计数 +1。
    const r1 = accounts.pushToFailed([a.id]);
    assert.strictEqual(r1.changed, 1);
    assert.strictEqual(accounts.getById(a.id).inFailed, true);

    // 幂等：已在登录失败管理的再次 push 不应改动。
    assert.strictEqual(accounts.pushToFailed([a.id]).changed, 0);

    // 移出登录失败管理：inFailed 置回 false。
    assert.strictEqual(accounts.removeFromFailed([a.id]).changed, 1);
    assert.strictEqual(accounts.getById(a.id).inFailed, false);
    // 幂等：不在登录失败管理的再次移出不应改动。
    assert.strictEqual(accounts.removeFromFailed([a.id]).changed, 0);
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 待人工管理 inNeedVerify：导入到待人工/移出待人工（唯一假邮箱，跑完即清理）----
check("导入默认 inNeedVerify=false；push-to-needverify 置 true、remove-from-needverify 移回", () => {
  const email = `__test_needverify_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    // 新导入默认不在待人工管理。
    assert.strictEqual(a.inNeedVerify, false);

    // 导入到待人工管理：inNeedVerify 置 true，inNeedVerify 计数 +1。
    const r1 = accounts.pushToNeedVerify([a.id]);
    assert.strictEqual(r1.changed, 1);
    assert.strictEqual(accounts.getById(a.id).inNeedVerify, true);

    // 幂等：已在待人工管理的再次 push 不应改动。
    assert.strictEqual(accounts.pushToNeedVerify([a.id]).changed, 0);

    // 移出待人工管理：inNeedVerify 置回 false。
    assert.strictEqual(accounts.removeFromNeedVerify([a.id]).changed, 1);
    assert.strictEqual(accounts.getById(a.id).inNeedVerify, false);
    // 幂等：不在待人工管理的再次移出不应改动。
    assert.strictEqual(accounts.removeFromNeedVerify([a.id]).changed, 0);
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 密钥错误管理 in2faError：导入到密钥错误/移出密钥错误（唯一假邮箱，跑完即清理）----
check("导入默认 in2faError=false；push-to-2fa-error 置 true、remove-from-2fa-error 移回", () => {
  const email = `__test_2faerror_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.ok(a, "应能找到导入的测试账号");
    // 新导入默认不在密钥错误管理。
    assert.strictEqual(a.in2faError, false);

    // 导入到密钥错误管理：in2faError 置 true，in2faError 计数 +1。
    const r1 = accounts.pushTo2faError([a.id]);
    assert.strictEqual(r1.changed, 1);
    assert.strictEqual(accounts.getById(a.id).in2faError, true);

    // 幂等：已在密钥错误管理的再次 push 不应改动。
    assert.strictEqual(accounts.pushTo2faError([a.id]).changed, 0);

    // 移出密钥错误管理：in2faError 置回 false。
    assert.strictEqual(accounts.removeFrom2faError([a.id]).changed, 1);
    assert.strictEqual(accounts.getById(a.id).in2faError, false);
    // 幂等：不在密钥错误管理的再次移出不应改动。
    assert.strictEqual(accounts.removeFrom2faError([a.id]).changed, 0);
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

// ---- 一键归位 autoSort：按状态把检测库里的号搬进对应 bucket（唯一假邮箱，跑完即清理）----
// 说明：用显式 ids 调 autoSort（而非 []），以免在测试时误动数据库里真实的在库号；
// 显式 ids 与「全部检测库号」走的是同一套 scope/优先级逻辑，断言效果等价且安全。
check("autoSort 按优先级把检测库号归位，未分类/未检测留库，已在 bucket/已售不动", () => {
  const tag = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const mk = (name) => `__test_autosort_${name}_${tag}@example.com`;
  const created = [];
  function imp(name, status) {
    const email = mk(name);
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    if (status) accounts.update(a.id, { status });
    created.push(a.id);
    return accounts.getById(a.id);
  }
  try {
    // banned 优先于 login：即便 login=failed，gmail=banned 也应进废号。
    const banned = imp("banned", { login: "failed", gmail: "banned" });
    const failed = imp("failed", { login: "failed" });
    const needVerify = imp("needverify", { login: "need_verify" });
    const tfaError = imp("2faerror", { login: "2fa_error" });
    const sellable = imp("sellable", { login: "ok", gmail: "ok", youtube: "ok", gpt: "ok", device: "cleaned" });
    const nurture = imp("nurture", { login: "ok", gmail: "ok", youtube: "ok", gpt: "blocked" });
    const unchecked = imp("unchecked", null); // 全 unknown
    const partial = imp("partial", { login: "ok" }); // 检测了但不达标 → 留库

    // 已在 bucket（先 push 到废号）：即便状态像登录失败，也不应被改动。
    const inBucket = imp("inbucket", { login: "failed" });
    accounts.pushToScrap([inBucket.id]);
    // 已售：即便全绿可售，也不应进出售。
    const sold = imp("sold", { login: "ok", gmail: "ok", youtube: "ok", gpt: "ok", device: "cleaned" });
    accounts.markSold([sold.id]);

    const r = accounts.autoSort(created);

    // 各自被设置正确的唯一 move flag。
    assert.strictEqual(accounts.getById(banned.id).inScrap, true, "banned → inScrap");
    assert.strictEqual(accounts.getById(banned.id).inFailed, false, "banned 不应同时 inFailed（banned 优先）");
    assert.strictEqual(accounts.getById(failed.id).inFailed, true, "login=failed → inFailed");
    assert.strictEqual(accounts.getById(needVerify.id).inNeedVerify, true, "need_verify → inNeedVerify");
    assert.strictEqual(accounts.getById(tfaError.id).in2faError, true, "2fa_error → in2faError");
    assert.strictEqual(accounts.getById(sellable.id).inSales, true, "全绿+gpt ok+设备已清 → inSales");
    assert.strictEqual(accounts.getById(nurture.id).inNurture, true, "全绿(其余) → inNurture");

    // 未检测/未分类留在检测库（无任何 flag）。
    const u = accounts.getById(unchecked.id);
    assert.ok(!u.inScrap && !u.inFailed && !u.inNeedVerify && !u.in2faError && !u.inSales && !u.inNurture, "未检测应留库无 flag");
    const p = accounts.getById(partial.id);
    assert.ok(!p.inScrap && !p.inFailed && !p.inNeedVerify && !p.in2faError && !p.inSales && !p.inNurture, "未分类应留库无 flag");

    // category 同步。
    assert.strictEqual(accounts.getById(sellable.id).category, "sell", "sellable 的 category 应为 sell");
    assert.strictEqual(accounts.getById(banned.id).category, "scrap", "banned 的 category 应为 scrap");
    assert.strictEqual(accounts.getById(unchecked.id).category, "unchecked", "未检测 category 应为 unchecked");

    // 已在 bucket 的不动：仍只 inScrap，未被改成 inFailed。
    const ib = accounts.getById(inBucket.id);
    assert.strictEqual(ib.inScrap, true, "已在废号的应保持 inScrap");
    assert.strictEqual(ib.inFailed, false, "已在 bucket 的不应被归位到 inFailed");
    // 已售的不动：未被推入出售。
    assert.strictEqual(accounts.getById(sold.id).inSales, false, "已售号不应进出售");

    // 返回分布：total=scope 内处理数(8)，stayed=留库数(2)，各 move 各 1。
    assert.strictEqual(r.total, 8, "scope 内总数应为 8（已在 bucket/已售被跳过）");
    assert.strictEqual(r.stayed, 2, "留在检测库应为 2（未检测+未分类）");
    assert.deepStrictEqual(r.moved, { scrap: 1, failed: 1, needVerify: 1, tfaError: 1, sales: 1, nurture: 1 });
  } finally {
    const all = accounts.list().filter((x) => x.email.includes(`_autosort_`) && x.email.includes(tag));
    if (all.length) accounts.remove(all.map((x) => x.id));
  }
});

// ---- 登录：密码不可用（密码错误 / 密码已被更改）文案识别 ----
// 只测纯函数 classifyPasswordProblem（脱离 puppeteer 的确定性单测），
// 覆盖：英文「Your password was changed N days ago」、中/繁「密码被更改」多写法、
// 现有「Wrong password / 密码错误」仍生效，以及正常密码页文案不误判。
const { classifyPasswordProblem } = login.helpers;

check("密码识别·英文『Your password was changed 6 days ago』→ changed + 天数", () => {
  const r = classifyPasswordProblem("Welcome\ndemo.user@example.com\nEnter your password\nYour password was changed 6 days ago");
  assert.strictEqual(r.failed, true);
  assert.strictEqual(r.reason, "changed");
  assert.strictEqual(r.days, "6");
});

check("密码识别·简中『您的密码已于6天前更改』→ changed + 天数", () => {
  const r = classifyPasswordProblem("欢迎\n输入您的密码\n您的密码已于 6 天前更改");
  assert.strictEqual(r.failed, true);
  assert.strictEqual(r.reason, "changed");
  assert.strictEqual(r.days, "6");
});

check("密码识别·简中『密码已更改』/繁中『密碼已變更』→ changed", () => {
  assert.strictEqual(classifyPasswordProblem("您的密码已更改").reason, "changed");
  assert.strictEqual(classifyPasswordProblem("您的密碼已變更").reason, "changed");
});

check("密码识别·现有『Wrong password』/『密码错误』/『输入的密码有误』仍生效 → wrong", () => {
  assert.strictEqual(classifyPasswordProblem("Wrong password. Try again or click Forgot password to reset it.").reason, "wrong");
  assert.strictEqual(classifyPasswordProblem("密码错误，请重试").reason, "wrong");
  assert.strictEqual(classifyPasswordProblem("输入的密码有误").reason, "wrong");
  assert.strictEqual(classifyPasswordProblem("輸入的密碼有誤").reason, "wrong");
});

check("密码识别·正常密码页文案不误判（无信号 → failed=false）", () => {
  const r = classifyPasswordProblem("Welcome\ndemo.user@example.com\nEnter your password\nShow password\nForgot password?\nNext");
  assert.strictEqual(r.failed, false);
  assert.strictEqual(r.reason, "");
  assert.strictEqual(r.days, null);
});

// reauth 走到短信「确认是你本人·发送验证码」页(/challenge/ipp/consent)：按新要求【快速失败】。
// 用脱敏后的真机 URL/文案锁定识别正则——命中即立刻 need_verify，不再切身份验证器/绕圈。
check("ipp/consent 短信验证页：URL 与文案均能命中（用于快速失败识别）", () => {
  const { IPP_CONSENT_RE, VERIFY_SENDCODE_RE } = login.helpers;
  const ippUrl = "https://accounts.google.com/v3/signin/challenge/ipp/consent?TL=xxx&continue=https%3A%2F%2Fmyaccount.google.com%2Fsigninoptions%2Ftwo-step-verification";
  // 真机抓到的 ipp/consent 正文（掩码尾号 55）。
  const ippText = "Verify it’s you To help keep your account safe, Google wants to make sure it’s really you demo.user@example.com Get a verification code Google will send a verification code to •••• ••• •55. Standard message and data rates may apply. Send More ways to verify English (United States) Help Privacy Terms";
  assert.ok(IPP_CONSENT_RE.test(ippUrl), "URL 应命中 ipp/consent → 直接快速失败");
  assert.ok(VERIFY_SENDCODE_RE.test(ippText), "正文应命中「确认是你本人/获取验证码」");
  assert.ok(/(\bSend\b|发送|發送)/.test(ippText), "正文应含「Send/发送」按钮（短信发送页特征）");
});

check("ipp/consent 文案回退不误伤：普通 TOTP(challenge/totp) URL 不命中 ipp 正则", () => {
  const { IPP_CONSENT_RE } = login.helpers;
  const totpUrl = "https://accounts.google.com/v3/signin/challenge/totp?TL=xxx";
  assert.strictEqual(IPP_CONSENT_RE.test(totpUrl), false, "普通身份验证器页不应被当成短信验证页");
});

accounts.flush();
cleanupTestData();
console.log(`\n${passed} 项通过`);
