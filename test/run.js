"use strict";

const fs = require("fs");
const http = require("http");
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
const addPhone = require("../src/automation/actions/add-phone");
const phonePool = require("../src/phones");
const router = require("../src/router");
const actionsRegistry = require("../src/automation/actions");
const localBrowser = require("../src/automation/local-browser");
const engine = require("../src/automation/engine");

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

check("本机浏览器 CDP 就绪必须有有效 WebSocket 地址", () => {
  const { isDevtoolsReady } = localBrowser.helpers;
  assert.strictEqual(isDevtoolsReady({ Browser: "Chrome/151" }), false, "仅 Browser 名称不能算就绪");
  assert.strictEqual(isDevtoolsReady({ webSocketDebuggerUrl: "undefined" }), false, "非法地址不能算就绪");
  assert.strictEqual(
    isDevtoolsReady({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test-id" }),
    true,
  );
});

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

check("复制和导出账号时追加具体异常原因", () => {
  // 直接提取并执行浏览器端实际使用的格式函数，避免测试复制一份实现后产生偏差。
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const reasonStart = appSource.indexOf("const LOGIN_REASON_TEXT");
  const reasonEnd = appSource.indexOf("const STATUS_OPTIONS", reasonStart);
  assert.ok(reasonStart >= 0 && reasonEnd > reasonStart, "应能找到登录原因文案");
  const reasonHelpers = new Function(`${appSource.slice(reasonStart, reasonEnd)}\nreturn { LOGIN_REASON_TEXT, passwordCheckResultText, loginCheckResultText };`)();

  const start = appSource.indexOf("const EXPORT_STATUS_WARNING_TEXT");
  const end = appSource.indexOf("let toastTimer", start);
  assert.ok(start >= 0 && end > start, "应能找到账号复制/导出格式函数");
  const helpers = new Function("LOGIN_REASON_TEXT", "passwordCheckResultText", "loginCheckResultText", `${appSource.slice(start, end)}\nreturn { fmtAccount, hasExportWarning, exportWarningText };`)(
    reasonHelpers.LOGIN_REASON_TEXT,
    reasonHelpers.passwordCheckResultText,
    reasonHelpers.loginCheckResultText,
  );
  const normal = {
    email: "normal@example.com", password: "pw", recoveryEmail: "", totpSecret: "KEY", year: "2026", country: "US",
    status: { login: "ok", payment: "closed", family: "off", device: "cleaned" },
  };
  assert.strictEqual(
    helpers.fmtAccount(normal),
    "normal@example.com----pw----空----KEY----2026----US",
    "正常和中性状态不应追加提示",
  );

  const captcha = {
    ...normal,
    status: { login: "need_verify" },
    lastLoginCheck: { reasonCode: "captcha" },
  };
  assert.strictEqual(helpers.exportWarningText(captcha), "人机验证");
  assert.ok(helpers.fmtAccount(captcha).endsWith("----人机验证"), "人机验证必须写具体原因");

  const passwordWrong = {
    ...normal,
    status: { login: "failed" },
    lastLoginCheck: { reasonCode: "password_wrong" },
  };
  assert.ok(helpers.fmtAccount(passwordWrong).endsWith("----密码错误"));

  const passwordOnlyOk = {
    ...normal,
    lastPasswordCheck: { reasonCode: "password_correct", outcome: "ok" },
  };
  assert.strictEqual(helpers.fmtAccount(passwordOnlyOk), helpers.fmtAccount(normal), "密码正确不是异常，不能追加后缀");

  const passwordOnlyWrong = {
    ...normal,
    lastPasswordCheck: { reasonCode: "password_wrong", outcome: "error" },
  };
  assert.ok(helpers.fmtAccount(passwordOnlyWrong).endsWith("----密码错误"), "独立密码检测失败应追加具体原因");

  const passwordChangedDays = {
    ...normal,
    lastPasswordCheck: { reasonCode: "password_changed", outcome: "error", daysAgo: 26, detail: "密码已被更改" },
  };
  assert.strictEqual(reasonHelpers.passwordCheckResultText(passwordChangedDays.lastPasswordCheck), "密码已更改（26天前）");
  assert.ok(helpers.fmtAccount(passwordChangedDays).endsWith("----密码已更改（26天前）"), "独立密码检测导出应直接带更改天数");

  const loginChangedDays = {
    ...normal,
    status: { login: "failed" },
    lastLoginCheck: { reasonCode: "password_changed", outcome: "error", detail: { login: "您的密码已于 5 天前更改" } },
  };
  assert.strictEqual(reasonHelpers.loginCheckResultText(loginChangedDays.lastLoginCheck), "密码已更改（5天前）");
  assert.ok(helpers.fmtAccount(loginChangedDays).endsWith("----密码已更改（5天前）"), "完整登录诊断也应兼容从旧 detail 提取天数");

  const passwordOnlyTimeout = {
    ...normal,
    lastPasswordCheck: { reasonCode: "timeout", outcome: "need_verify" },
  };
  assert.ok(helpers.fmtAccount(passwordOnlyTimeout).endsWith("----密码检测超时"), "密码检测不能显示成登录超时");

  const multiple = { ...normal, status: { login: "2fa_error", restrict: "restricted" } };
  assert.strictEqual(helpers.exportWarningText(multiple), "2FA密钥错误、服务受限");
  assert.ok(helpers.fmtAccount(multiple).endsWith("----2FA密钥错误、服务受限"));
});

// ---- 服务限制 restrict 字段：默认 unknown、可被设为 restricted/ok（唯一假邮箱，跑完即清理）----
check("STATUS_FIELDS 含 restrict，允许值 unknown/ok/restricted", () => {
  assert.ok(Array.isArray(accounts.STATUS_FIELDS.restrict), "STATUS_FIELDS.restrict 应存在");
  assert.deepStrictEqual(accounts.STATUS_FIELDS.restrict, ["unknown", "ok", "restricted"]);
});

check("STATUS_FIELDS 含 phone(验证电话)，允许值含 pending 待生效/待确认", () => {
  assert.ok(Array.isArray(accounts.STATUS_FIELDS.phone), "STATUS_FIELDS.phone 应存在");
  assert.deepStrictEqual(accounts.STATUS_FIELDS.phone, ["unknown", "ok", "pending", "removed", "none", "failed"]);
});

check("登录失败原因分类：密码 / 2FA / 人机 / 设备 / 短信 / 安全代码 / 浏览器", () => {
  const { inferLoginReasonCode } = login.helpers;
  const reason = (detail, outcome = "error") => inferLoginReasonCode({ outcome, detail: { login: detail } });
  assert.strictEqual(reason("密码错误：账号库密码与 Google 现有密码不一致"), "password_wrong");
  assert.strictEqual(reason("密码已被更改（提示：3 天前更改）"), "password_changed");
  assert.strictEqual(reason("缺少 2FA 密钥（TOTP）"), "totp_missing");
  assert.strictEqual(reason("2FA 验证码连续错误：2FA 密钥很可能不正确", "need_verify"), "totp_invalid");
  assert.strictEqual(reason("出现验证码 / 人机验证，需人工处理", "need_verify"), "captcha");
  assert.strictEqual(reason("已识别 Google 设备通知验证", "need_verify"), "device_prompt");
  assert.strictEqual(reason("触发短信验证，发送验证码到手机", "need_verify"), "sms_verification");
  assert.strictEqual(reason("当前是 Google 安全代码（g.co/sc）页面", "need_verify"), "security_code");
  assert.strictEqual(reason("Google 判定该浏览器环境不安全（自动化被拦）", "need_verify"), "browser_blocked");
  assert.strictEqual(reason("Google 提示找不到该账号"), "account_not_found");
  assert.strictEqual(inferLoginReasonCode({ outcome: "ok", detail: { login: "通过" } }), "ok");
});

check("登录结果同时产生粗状态和可持久化精确原因", () => {
  const { tagLogin } = login.helpers;
  const wrongPwd = tagLogin({ outcome: "error", reasonCode: "password_wrong", passwordSubmitted: true, detail: { login: "密码错误" } });
  assert.strictEqual(wrongPwd.statusPatch.login, "failed");
  assert.strictEqual(wrongPwd.reasonCode, "password_wrong");
  assert.strictEqual(wrongPwd.fieldPatch.lastLoginCheck.reasonCode, "password_wrong");
  assert.strictEqual(wrongPwd.fieldPatch.lastLoginCheck.outcome, "error");
  assert.strictEqual(wrongPwd.fieldPatch.lastPasswordCheck, null, "明确核验过密码后应取代旧密码检测");

  const badTotp = tagLogin({ outcome: "need_verify", reasonCode: "totp_invalid", detail: { login: "验证码连续错误" } });
  assert.strictEqual(badTotp.statusPatch.login, "2fa_error");
  const captcha = tagLogin({ outcome: "need_verify", reasonCode: "captcha", detail: { login: "人机验证" } });
  assert.strictEqual(captcha.statusPatch.login, "need_verify");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captcha.fieldPatch, "lastPasswordCheck"), false, "未证明提交过密码的人机页不能清旧密码检测");

  const existingSession = tagLogin({ outcome: "ok", reasonCode: "ok", passwordSubmitted: false, detail: { login: "已有会话" } });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(existingSession.fieldPatch, "lastPasswordCheck"), false, "已有会话未提交本次密码，不能清旧密码检测");
});

check("仅验证密码使用独立结果，不冒充完整登录成功", () => {
  const { tagPasswordCheck } = login.helpers;
  const ok = tagPasswordCheck({ outcome: "ok", reasonCode: "password_correct", detail: { password: "密码正确" } });
  assert.strictEqual(ok.reasonCode, "password_correct");
  assert.strictEqual(ok.fieldPatch.lastPasswordCheck.outcome, "ok");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ok.statusPatch, "login"), false, "不能写 status.login=ok");
  assert.strictEqual(ok.stop, true, "密码检测完成后必须停止后续动作");

  const wrong = tagPasswordCheck({ outcome: "error", reasonCode: "password_wrong", detail: { password: "密码错误" } });
  assert.strictEqual(wrong.fieldPatch.lastPasswordCheck.reasonCode, "password_wrong");
  assert.strictEqual(wrong.fieldPatch.lastPasswordCheck.outcome, "error");
  assert.strictEqual(wrong.stop, true);

  const changed = tagPasswordCheck({ outcome: "error", reasonCode: "password_changed", daysAgo: 4, detail: { password: "密码已被更改（提示：4 天前更改）" } });
  assert.strictEqual(changed.fieldPatch.lastPasswordCheck.daysAgo, 4, "密码更改天数应结构化持久化");
});

check("账号库持久化登录原因；手改登录状态和复原检测会清掉旧原因", () => {
  const email = `__test_login_reason_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123|JBSWY3DPEHPK3PXP`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.strictEqual(a.lastLoginCheck, null, "新账号默认无登录诊断");

    accounts.update(a.id, {
      status: { login: "failed" },
      lastLoginCheck: {
        reasonCode: "password_wrong",
        outcome: "error",
        detail: "密码错误 https://accounts.google.com/test?TL=secret-token",
        checkedAt: "2026-08-28T01:02:03.000Z",
      },
    });
    let saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastLoginCheck.reasonCode, "password_wrong");
    assert.ok(!saved.lastLoginCheck.detail.includes("secret-token"), "不得持久化 URL 查询串令牌");

    accounts.update(a.id, { status: { login: "ok" } });
    assert.strictEqual(accounts.getById(a.id).lastLoginCheck, null, "人工改下拉后旧原因应清空");

    accounts.update(a.id, {
      status: { login: "failed" },
      lastLoginCheck: { reasonCode: "not-a-code", outcome: "error", detail: "未知" },
    });
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastLoginCheck.reasonCode, "other", "未知 reasonCode 应归一为 other");
    accounts.resetStatus([a.id]);
    assert.strictEqual(accounts.getById(a.id).lastLoginCheck, null, "复原检测应清空原因");
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

check("账号库独立持久化密码检测；改密码和复原检测会清掉旧结论", () => {
  const email = `__test_password_check_${Date.now()}_${Math.random().toString(16).slice(2, 8)}@example.com`;
  try {
    accounts.importText(`${email}|pw123`, {});
    const a = accounts.list().find((x) => x.email === email);
    assert.strictEqual(a.lastPasswordCheck, null, "新账号默认未检测密码");

    accounts.update(a.id, {
      lastPasswordCheck: {
        reasonCode: "password_correct",
        outcome: "ok",
        detail: "密码正确 https://accounts.google.com/test?TL=secret-token",
        checkedAt: "2026-08-31T01:02:03.000Z",
      },
    });
    let saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastPasswordCheck.reasonCode, "password_correct");
    assert.ok(!saved.lastPasswordCheck.detail.includes("secret-token"), "密码检测也不得持久化 URL 查询串令牌");

    accounts.update(a.id, {
      lastPasswordCheck: {
        reasonCode: "password_changed",
        outcome: "error",
        detail: "密码已被更改（提示：26 天前更改）",
        checkedAt: "2026-08-31T01:02:03.000Z",
      },
    });
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastPasswordCheck.daysAgo, 26, "旧 detail 中的更改天数也应迁移为结构字段");

    accounts.update(a.id, {
      status: { login: "failed" },
      lastLoginCheck: { reasonCode: "password_wrong", outcome: "error", detail: "旧密码错误" },
    });
    accounts.update(a.id, {
      lastPasswordCheck: { reasonCode: "password_correct", outcome: "ok", detail: "新检测密码正确" },
    });
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastLoginCheck, null, "新密码正确应使旧的密码错误登录诊断失效");
    assert.strictEqual(saved.status.login, "unknown", "不能保留与新密码结论冲突的登录失败状态");

    accounts.update(a.id, {
      lastPasswordCheck: { reasonCode: "password_correct", outcome: "error", detail: "非法配对" },
    });
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastPasswordCheck.reasonCode, "other", "密码正确不能与 error 结果配对");
    assert.strictEqual(saved.lastPasswordCheck.outcome, "error");

    accounts.update(a.id, { password: "new-password" });
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastPasswordCheck, null, "密码内容变化后旧密码结论必须失效");
    assert.strictEqual(saved.lastLoginCheck, null, "密码内容变化后旧完整登录结论也必须失效");
    assert.strictEqual(saved.status.login, "unknown");

    accounts.update(a.id, { password: "" });
    accounts.update(a.id, {
      status: { login: "failed" },
      lastLoginCheck: { reasonCode: "credentials_missing", outcome: "error", detail: "缺少密码" },
      lastPasswordCheck: { reasonCode: "credentials_missing", outcome: "error", detail: "缺少密码" },
    });
    accounts.importText(`${email}|import-filled-password`, {});
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.password, "import-filled-password");
    assert.strictEqual(saved.lastLoginCheck, null, "导入补全密码后旧的缺凭据登录诊断应失效");
    assert.strictEqual(saved.lastPasswordCheck, null, "导入补全密码后旧的缺凭据密码诊断应失效");
    assert.strictEqual(saved.status.login, "unknown");

    accounts.update(a.id, { lastPasswordCheck: { reasonCode: "password_wrong", outcome: "error", detail: "密码错误" } });
    accounts.resetStatus([a.id]);
    saved = accounts.getById(a.id);
    assert.strictEqual(saved.lastPasswordCheck, null, "复原检测应清空密码检测结果");
  } finally {
    const found = accounts.list().find((x) => x.email === email);
    if (found) accounts.remove([found.id]);
  }
});

check("浏览器在登录动作前启动失败也会生成可见登录结果", () => {
  const r = engine.helpers.buildUnhandledLoginResult(new Error("CDP connect timeout"), null);
  assert.strictEqual(r.action, "login");
  assert.strictEqual(r.reasonCode, "browser_start_failed");
  assert.strictEqual(r.statusPatch.login, "failed");
  assert.strictEqual(r.fieldPatch.lastLoginCheck.reasonCode, "browser_start_failed");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.fieldPatch, "lastPasswordCheck"), false, "启动失败尚未核验密码，不能清旧密码检测");

  const thrownInsideLogin = engine.helpers.buildUnhandledLoginResult(new Error("operation timed out"), "login");
  assert.strictEqual(thrownInsideLogin.reasonCode, "timeout");

  const passwordCheck = engine.helpers.buildUnhandledLoginResult(new Error("CDP connect timeout"), null, "check-password");
  assert.strictEqual(passwordCheck.action, "check-password");
  assert.deepStrictEqual(passwordCheck.statusPatch, {}, "密码检测启动失败不能改写完整登录状态");
  assert.strictEqual(passwordCheck.fieldPatch.lastPasswordCheck.reasonCode, "browser_start_failed");
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

    accounts.update(a.id, { status: { phone: "pending" } });
    assert.strictEqual(accounts.getById(a.id).status.phone, "pending", "pending 应写入");

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

check("仅验证账号密码已注册为中风险只读独占动作", () => {
  const item = actionsRegistry.list().find((x) => x.id === "check-password");
  assert.ok(item, "actions 列表应含 check-password");
  assert.strictEqual(item.risk, "medium");
  assert.strictEqual(item.readOnly, true);
  assert.strictEqual(item.exclusive, true);
  assert.strictEqual(typeof actionsRegistry.get("check-password").run, "function");
  assert.strictEqual(actionsRegistry.validateSelection(["check-password"]), "");
  assert.deepStrictEqual(actionsRegistry.normalizeSelection(["check-password", "check-password"]), ["check-password"]);
  assert.match(actionsRegistry.validateSelection(["check-password", "login"]), /必须单独运行/);
  assert.match(actionsRegistry.validateSelection(["not-an-action"]), /未知操作/);
  assert.match(engine.validateActionSelection(["detect-region", "check-password"]), /必须单独运行/);
  assert.throws(
    () => engine.createJob({ mode: "local", envSerials: [], accountIds: [], actionIds: ["check-password", "login"] }),
    /必须单独运行/,
    "直接调用引擎也不能绕过独占校验",
  );
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

check("仅验证密码只把后续挑战/离开 accounts 域视为密码已接受", () => {
  const { isPasswordAcceptedDestination } = login.helpers;
  assert.strictEqual(isPasswordAcceptedDestination("https://accounts.google.com/v3/signin/challenge/totp?TL=x"), true);
  assert.strictEqual(isPasswordAcceptedDestination("https://accounts.google.com/v3/signin/challenge/selection?TL=x"), true);
  assert.strictEqual(isPasswordAcceptedDestination("https://myaccount.google.com/"), true);
  assert.strictEqual(isPasswordAcceptedDestination("https://accounts.google.com/v3/signin/challenge/pwd?TL=x"), false);
  assert.strictEqual(isPasswordAcceptedDestination("https://accounts.google.com/v3/signin/identifier?TL=x"), false);
  assert.strictEqual(isPasswordAcceptedDestination("about:blank"), false);
  assert.strictEqual(isPasswordAcceptedDestination("chrome-error://chromewebdata/"), false);
  assert.strictEqual(isPasswordAcceptedDestination("https://example.com/captive-portal"), false);
  assert.strictEqual(isPasswordAcceptedDestination("https://accounts.google.com/v3/signin/unknownerror?TL=x"), false);
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

check("设备通知页即使含“确认本人/发送/重新发送”也不能误判成短信", () => {
  const {
    VERIFY_SENDCODE_RE, isDevicePromptChallenge, isSmsConsentTextFallback, riskReason,
  } = login.helpers;
  const promptUrl = "https://accounts.google.com/v3/signin/challenge/dp?TL=xxx";
  const promptText = [
    "两步验证 为了保护您的账号安全，Google 希望确认是您本人在尝试登录",
    "查看您的 Vivo X100 Pro",
    "Google 已向您的 Vivo X100 Pro 发送了通知。在通知中点按是，然后点按 1",
    "重新发送 试试其他方式",
  ].join(" ");
  const onDevicePrompt = isDevicePromptChallenge(promptText, promptUrl);
  assert.strictEqual(onDevicePrompt, true, "应先识别为 Google Prompt 设备通知页");
  assert.strictEqual(
    isDevicePromptChallenge("确认是您本人", promptUrl),
    true,
    "dp URL 应在正文尚未 hydration 时仍被权威识别为设备通知",
  );
  assert.strictEqual(riskReason("Verify it's you", promptUrl), "", "dp URL 不能先被通用风控判断截住");
  assert.strictEqual(
    riskReason("Verify it's you", "https://accounts.google.com/v3/signin/challenge/selection?TL=xxx"),
    "",
    "选择验证方式页 hydration 前不能被通用风控截住",
  );
  assert.strictEqual(
    riskReason("Verify it's you", "https://accounts.google.com/v3/signin/challenge/ipp/consent?TL=xxx"),
    "",
    "IPP 短信页应交给短信专门分支而不是笼统风控",
  );
  assert.strictEqual(
    riskReason("Verify it's you", "https://accounts.google.com/v3/signin/challenge/new-method?TL=xxx"),
    "",
    "未知 challenge 也应交给有限等待/未知页分支，不能被泛化风控抢先终止",
  );
  assert.strictEqual(
    riskReason("Verify it's you", "https://accounts.google.com/v3/signin/challenge?TL=xxx"),
    "",
    "无子路径的 challenge 过渡页也不能被泛化风控截住",
  );
  assert.strictEqual(
    riskReason("Verify it's you", "https://accounts.google.com/"),
    "",
    "accounts.google.com 根路径是 SPA 过渡壳，应等待真实 challenge URL",
  );
  assert.match(
    riskReason("Verify it's you due to unusual activity", "https://accounts.google.com/v3/signin/rejected"),
    /额外身份验证/,
    "非 challenge 的真实可疑登录页仍应识别为风控",
  );
  assert.strictEqual(VERIFY_SENDCODE_RE.test(promptText), true, "该真实文案确实会与短信兜底重叠");
  assert.strictEqual(isSmsConsentTextFallback(promptText, {
    onDevicePrompt, hasCredInput: false, totpInputVisible: false, hasAuthenticatorOption: false,
  }), false, "设备通知页必须排除在短信文案兜底之外");

  const smsText = "确认是您本人 获取验证码 我们会向您的手机发送验证码 Send";
  assert.strictEqual(isSmsConsentTextFallback(smsText, {
    onDevicePrompt: false, hasCredInput: false, totpInputVisible: false, hasAuthenticatorOption: false,
  }), true, "真正短信发送页仍应快速标记需人工");
  assert.strictEqual(isSmsConsentTextFallback("确认是您本人 重新发送 试试其他方式", {
    onDevicePrompt: false, hasCredInput: false, totpInputVisible: false, hasAuthenticatorOption: false,
  }), false, "只有重新发送而没有明确验证码语义时不能按短信页终止");
});

// Google 安全代码(g.co/sc / challenge/ootp)与身份验证器 TOTP 都有 6 位输入框，必须先按页面语义分类，
// 不能再用 input[type=tel] 或泛化的“输入验证码”直接判为 TOTP。
check("两步验证·g.co/sc 安全代码页不是身份验证器 TOTP", () => {
  const { isSecurityCodeChallenge, isAuthenticatorTotpContext, shouldFillTotp, TRY_ANOTHER_RE } = login.helpers;
  const url = "https://accounts.google.com/v3/signin/challenge/ootp?TL=xxx";
  const text = "获取验证码以进行登录 要获取您的验证码，请在新的浏览器窗口中前往 g.co/sc 输入验证码 此验证码无效。请获取新的验证码，然后重试。 尝试其他方式";
  assert.strictEqual(isSecurityCodeChallenge(text, url), true);
  assert.strictEqual(isAuthenticatorTotpContext(text, url), false);
  assert.strictEqual(shouldFillTotp(text, url, true), false, "即使有可见 6 位输入框也绝不能填 TOTP");
  assert.ok(TRY_ANOTHER_RE.test(text), "应识别截图中的“尝试其他方式”入口");
});

check("两步验证·方式列表能精确识别 Google 身份验证器选项", () => {
  const { AUTH_OPTION_RE, TRY_ANOTHER_RE, isSecurityCodeChallenge, shouldFillTotp } = login.helpers;
  const text = "选择您想要使用的登录方式：获取一次性安全码 从 Google 身份验证器应用获取验证码 通过短信接收验证码";
  const url = "https://accounts.google.com/v3/signin/challenge/selection?TL=xxx";
  assert.ok(AUTH_OPTION_RE.test(text));
  assert.strictEqual(isSecurityCodeChallenge(text, url), false);
  assert.strictEqual(shouldFillTotp(text, url, false), false, "方式列表本身不能填码，应先点击身份验证器选项");
  assert.strictEqual(shouldFillTotp(text, url, true), false, "即使选择页残留可见 tel 输入框也不能填码");
  assert.ok(AUTH_OPTION_RE.test("從 Google Authenticator 應用程式取得驗證碼"));
  assert.ok(TRY_ANOTHER_RE.test("嘗試其他方式"));
});

check("两步验证·真正 challenge/totp 页面才允许填动态码", () => {
  const { isAuthenticatorTotpContext, shouldFillTotp } = login.helpers;
  const url = "https://accounts.google.com/v3/signin/challenge/totp?TL=xxx";
  const text = "两步验证 输入 Google 身份验证器应用中的验证码";
  assert.strictEqual(isAuthenticatorTotpContext(text, url), true);
  assert.strictEqual(shouldFillTotp(text, url, false), false, "输入框尚未出现时不能空提交");
  assert.strictEqual(shouldFillTotp(text, url, true), true);
});

check("两步验证·短信/通用验证码输入框不能冒充 TOTP", () => {
  const { shouldFillTotp } = login.helpers;
  const url = "https://accounts.google.com/v3/signin/challenge/idvpin?TL=xxx";
  const text = "输入我们发送到您手机的验证码";
  assert.strictEqual(shouldFillTotp(text, url, true), false);
});

check("两步验证·设备通知页会切到其他方式且不会被残留输入框干扰", () => {
  const {
    DEVICE_PROMPT_RE, TRY_ANOTHER_RE, isDevicePromptChallenge, riskReason,
  } = login.helpers;
  const url = "https://accounts.google.com/v3/signin/challenge/dp?TL=xxx";
  const text = [
    "两步验证",
    "查看您的 Vivo X100 Pro",
    "Google 已向您的 Vivo X100 Pro 发送了通知。在通知中点按是，然后在您的手机上",
    "点按 1，即可验证您的身份。",
    "在此设备上不再询问",
    "试试其他方式",
  ].join("\n");
  assert.ok(DEVICE_PROMPT_RE.test(text), "应命中截图中的设备通知文案（含动态设备名和换行）");
  assert.ok(TRY_ANOTHER_RE.test(text), "应识别“试试其他方式”入口");
  assert.strictEqual(isDevicePromptChallenge(text, url), true);
  assert.strictEqual(riskReason(text, url), "", "设备通知页不能先被泛化成风险页终止");

  // classifier 不接收输入框状态：即使 Google SPA 残留旧邮箱/密码/tel 节点，仍由 URL+专属文案命中。
  assert.strictEqual(isDevicePromptChallenge(text, url), true);
  assert.strictEqual(isDevicePromptChallenge(text, url.replace("/dp", "/selection")), false);
  assert.strictEqual(isDevicePromptChallenge(text, url.replace("/dp", "/totp")), false);
  assert.strictEqual(isDevicePromptChallenge(`${text}\n前往 g.co/sc`, url.replace("/dp", "/ootp")), false);
  assert.strictEqual(
    isDevicePromptChallenge("确认是你本人 在此设备上不再询问 试试其他方式", url.replace("/dp", "/ipp/consent")),
    false,
    "IPP 短信确认页不能因弱提示语被误当成设备通知",
  );
  assert.strictEqual(
    isDevicePromptChallenge("输入密码 在此设备上不再询问", url.replace("/dp", "/pwd")),
    false,
    "密码 challenge 不能冒充设备通知",
  );
  assert.strictEqual(
    isDevicePromptChallenge("2-Step Verification Check your phone Google sent a notification Tap Yes Try another way", url),
    true,
    "英文 Google Prompt 也应识别",
  );
});

check("挑战页左侧邮箱不能冒充账号选择器", () => {
  const { isAccountChooserContext } = login.helpers;
  assert.strictEqual(
    isAccountChooserContext("synthetic@example.com 查看您的测试设备", "https://accounts.google.com/v3/signin/challenge/dp?TL=xxx"),
    false,
  );
  assert.strictEqual(
    isAccountChooserContext("选择一个账号 synthetic@example.com", "https://accounts.google.com/v3/signin/accountchooser?TL=xxx"),
    true,
  );
});

check("手机号池按 E.164 规范化、去重并拒绝缺国家码/超长号码", () => {
  assert.strictEqual(phonePool.normalizeNumber("＋1 (202) 555-0123"), "+12025550123");
  assert.strictEqual(phonePool.normalizeNumber("001-202-555-0123"), "+12025550123");
  assert.throws(() => phonePool.normalizeNumber("2025550123"), /格式无效/);
  assert.throws(() => phonePool.normalizeNumber("+1234567890123456"), /格式无效/);

  const result = phonePool.importText([
    "+1 (202) 555-0123|第一号",
    "001-202-555-0123|重复格式",
    "+1 202 555 0124|第二号",
    "2025550125",
    "+1234567890123456",
  ].join("\n"));
  assert.strictEqual(result.added, 2);
  assert.strictEqual(result.dup, 1);
  assert.strictEqual(result.errors.length, 2);
  assert.strictEqual(phonePool.list().length, 2);
  assert.ok(phonePool.list().every((item) => item.usageMode === "shared"), "新导入号码默认应为共享复用模式");
  assert.throws(
    () => phonePool.importText("+12025550122", { usageMode: "invalid" }),
    /不支持的手机号使用模式/,
    "非法分配模式必须在写入前拒绝",
  );
});

check("手机号池旧记录安全迁移为一号一绑，并保留成功账号与完成令牌", () => {
  const data = phonePool._db.get();
  data.phones.push({
    id: "legacy-phone-used",
    number: "+12025550137",
    status: "used",
    usedByAccountId: "legacy-account",
    usedBy: "legacy@example.com",
    usedAt: "2026-01-02T03:04:05.000Z",
    completedLeaseId: "legacy-completed-lease",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  });
  phonePool._db.save();
  const migrated = phonePool.list().find((item) => item.id === "legacy-phone-used");
  assert.strictEqual(migrated.usageMode, "exclusive", "旧号码不能因升级被静默解锁成共享号码");
  assert.strictEqual(migrated.bindings.length, 1);
  assert.strictEqual(migrated.bindings[0].accountId, "legacy-account");
  assert.strictEqual(migrated.bindings[0].completedLeaseId, "legacy-completed-lease");
  assert.strictEqual(phonePool.toPublic(migrated).available, false);
});

check("手机号池领取使用独占 lease；reserved 拒绝第二 runner，pending 仅只读复查", () => {
  const a = { id: "account-a", email: "a@example.com" };
  const b = { id: "account-b", email: "b@example.com" };
  const c = { id: "account-c", email: "c@example.com" };
  const claimA = phonePool.claimForAccount(a);
  assert.strictEqual(claimA.readOnly, false);
  assert.throws(
    () => phonePool.claimForAccount(a),
    (err) => err && err.code === "PHONE_STATE_CONFLICT" && /任务正在提交/.test(err.message),
    "reserved 必须拒绝同账号第二个 runner，不能共享提交权",
  );
  const claimB = phonePool.claimForAccount(b);
  assert.ok(claimA && claimB);
  assert.notStrictEqual(claimA.item.id, claimB.item.id, "不同账号必须领取不同号码");
  assert.strictEqual(phonePool.claimForAccount(c), null, "两个号码均占用后第三账号不能再领取");

  assert.strictEqual(phonePool.release(claimA.item.id, "wrong-lease"), null, "错误 lease 不能释放别人的号码");
  assert.ok(phonePool.release(claimA.item.id, claimA.leaseId), "尚未提交的 reserved 可释放");
  const claimC = phonePool.claimForAccount(c);
  assert.strictEqual(claimC.item.id, claimA.item.id, "释放后可重新领取");
  assert.strictEqual(phonePool.markPending(claimC.item.id, claimA.leaseId), null, "旧 lease 的迟到写入必须失效");
  assert.ok(phonePool.markPending(claimC.item.id, claimC.leaseId));
  const reviewC = phonePool.claimForAccount(c);
  assert.strictEqual(reviewC.item.id, claimC.item.id);
  assert.strictEqual(reviewC.leaseId, claimC.leaseId, "pending 复查保留原 lease，不能使仍在观察成功页的 runner 失效");
  assert.strictEqual(reviewC.readOnly, true, "pending 领取必须显式标记为只读");
  assert.strictEqual(phonePool.release(claimC.item.id, claimC.leaseId), null, "短信已提交的 pending 不能自动释放");
  assert.ok(phonePool.confirmUsed(claimC.item.id, claimC.leaseId));
  assert.ok(phonePool.confirmUsed(claimC.item.id, reviewC.leaseId), "同一完成 lease 的并发成功确认应幂等");
  assert.ok(phonePool.markFailed(claimB.item.id, claimB.leaseId, "测试拒绝"));
});

check("共享号码可依次绑定多个账号，同时始终只有一个 active lease", () => {
  const shared = phonePool.list().find((item) => item.usageMode === "shared" && item.status === "used");
  assert.ok(shared, "前置测试应留下一个已成功绑定的共享号码");
  const initialCount = shared.bindings.length;
  const accountD = { id: "shared-account-d", email: "shared-d@example.com" };
  const accountE = { id: "shared-account-e", email: "shared-e@example.com" };
  const accountF = { id: "shared-account-f", email: "shared-f@example.com" };

  const claimD = phonePool.claimForAccount(accountD, { mode: "shared" });
  assert.strictEqual(claimD.item.id, shared.id, "共享号码用过后仍应再次进入可领取集合");
  assert.strictEqual(claimD.reused, true);
  assert.strictEqual(
    phonePool.claimForAccount(accountE, { mode: "shared" }),
    null,
    "同一个共享号码有 active lease 时不能并发分给另一个账号",
  );
  assert.ok(phonePool.confirmUsed(shared.id, claimD.leaseId));

  let dto = phonePool.toPublic(phonePool.getById(shared.id));
  assert.strictEqual(dto.usageMode, "shared");
  assert.strictEqual(dto.bindingCount, initialCount + 1);
  assert.strictEqual(dto.available, true, "共享号码完成后应立即恢复为共享可用");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(dto, "bindings"), false, "公开 DTO 不得泄露绑定明细");

  const claimE = phonePool.claimForAccount(accountE, { mode: "shared" });
  assert.strictEqual(claimE.item.id, shared.id);
  const lateD = phonePool.confirmUsed(shared.id, claimD.leaseId);
  assert.ok(lateD, "上一个账号的迟到成功确认应幂等返回");
  assert.strictEqual(phonePool.getById(shared.id).leaseId, claimE.leaseId, "迟到确认不能覆盖下一个账号的 active lease");
  assert.strictEqual(phonePool.getById(shared.id).status, "reserved");
  assert.ok(phonePool.confirmUsed(shared.id, claimE.leaseId));
  dto = phonePool.toPublic(phonePool.getById(shared.id));
  assert.strictEqual(dto.bindingCount, initialCount + 2, "同一个共享号码应累计多个不同账号绑定");

  const repeatD = phonePool.claimForAccount(accountD, { mode: "shared" });
  assert.strictEqual(repeatD.alreadyUsed, true, "同账号重复运行应识别已有绑定而不是再次提交");
  assert.strictEqual(repeatD.readOnly, true);
  assert.strictEqual(phonePool.toPublic(phonePool.getById(shared.id)).bindingCount, initialCount + 2);

  const claimF = phonePool.claimForAccount(accountF, { mode: "shared" });
  assert.throws(
    () => phonePool.update(shared.id, { usageMode: "exclusive" }),
    (err) => err && err.code === "PHONE_STATE_CONFLICT",
    "active lease 期间不能切换共享/独享模式",
  );
  assert.ok(phonePool.markFailed(shared.id, claimF.leaseId, "本次绑定被 Google 拒绝"));
  dto = phonePool.toPublic(phonePool.getById(shared.id));
  assert.strictEqual(dto.status, "used", "已有绑定历史时，本次失败不能抹掉既有绑定");
  assert.strictEqual(dto.bindingCount, initialCount + 2);
  assert.strictEqual(dto.available, true);
  assert.deepStrictEqual(dto.allowedStatuses, ["used", "disabled"]);

  const lastOwner = dto.usedBy;
  phonePool.update(shared.id, { status: "disabled" });
  dto = phonePool.toPublic(phonePool.getById(shared.id));
  assert.strictEqual(dto.status, "disabled");
  assert.strictEqual(dto.available, false, "停用后共享号码不能继续被领取");
  assert.strictEqual(dto.bindingCount, initialCount + 2, "停用不能清空既有绑定历史");
  assert.strictEqual(dto.usedBy, lastOwner, "停用后仍应保留最近绑定账号用于管理");
  assert.deepStrictEqual(dto.allowedStatuses, ["disabled", "used"]);
  assert.strictEqual(
    phonePool.claimForAccount({ id: "shared-disabled-miss", email: "shared-disabled-miss@example.com" }, { mode: "shared" }),
    null,
    "停用中的共享号码不能分配给新账号",
  );
  assert.throws(() => phonePool.update(shared.id, { status: "unused" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.throws(() => phonePool.update(shared.id, { status: "failed" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  phonePool.update(shared.id, { status: "used" });
  dto = phonePool.toPublic(phonePool.getById(shared.id));
  assert.strictEqual(dto.available, true, "恢复后共享号码应重新可分配");
  assert.strictEqual(dto.bindingCount, initialCount + 2);
  assert.throws(
    () => phonePool.update(shared.id, { usageMode: "exclusive" }),
    (err) => err && err.code === "PHONE_STATE_CONFLICT",
    "已绑定多个账号的共享号码不能伪装成一号一绑",
  );
});

check("手机号池人工状态转换受约束，used/active 不能删除或重新分配", () => {
  const used = phonePool.list().find((item) => item.status === "used");
  const failed = phonePool.list().find((item) => item.status === "failed");
  assert.ok(used && failed);

  assert.throws(() => phonePool.update(used.id, { status: "unused" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.deepStrictEqual(phonePool.remove([used.id]).blocked, [used.id], "used 默认不可删除");
  const duplicate = phonePool.importText(`${used.number}|不得重新导入`);
  assert.strictEqual(duplicate.added, 0);
  assert.strictEqual(duplicate.dup, 1, "used 号码仍应参与去重，不能重新进入分配池");

  assert.throws(() => phonePool.update(failed.id, { status: "reserved" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.throws(() => phonePool.update(failed.id, { status: "pending" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  phonePool.update(failed.id, { status: "unused", usageMode: "exclusive" });
  const active = phonePool.claimForAccount(
    { id: "account-active", email: "active@example.com" },
    { mode: "exclusive" },
  );
  assert.ok(active && active.item.id === failed.id);
  assert.throws(() => phonePool.update(active.item.id, { status: "unused" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.throws(() => phonePool.update(active.item.id, { status: "failed" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.throws(() => phonePool.update(active.item.id, { status: "disabled" }), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.deepStrictEqual(phonePool.remove([active.item.id]).blocked, [active.item.id], "reserved 不可删除");
  phonePool.markFailed(active.item.id, active.leaseId, "测试收尾");
});

check("人工已完成同步：支持 unused/reserved/pending、同账号幂等，并拒绝跨账号或失败状态", () => {
  const numbers = ["+12025550131", "+12025550132", "+12025550133", "+12025550134"];
  phonePool.importText(numbers.join("\n"), { usageMode: "exclusive" });
  const byNumber = (number) => phonePool.list().find((item) => item.number === number);
  const accountA = { id: "manual-account-a", email: "manual-a@example.com" };
  const accountB = { id: "manual-account-b", email: "manual-b@example.com" };
  const accountC = { id: "manual-account-c", email: "manual-c@example.com" };

  const unused = byNumber(numbers[0]);
  phonePool.update(unused.id, { lastError: "旧失败原因" });
  const usedA = phonePool.confirmManualUsed(unused.id, accountA);
  assert.strictEqual(usedA.status, "used");
  assert.strictEqual(usedA.usedByAccountId, accountA.id);
  assert.strictEqual(usedA.usedBy, accountA.email);
  assert.ok(usedA.usedAt);
  assert.strictEqual(usedA.leaseId, "");
  assert.strictEqual(usedA.lastError, "");
  const firstUsedAt = usedA.usedAt;
  assert.strictEqual(phonePool.confirmManualUsed(unused.id, accountA).usedAt, firstUsedAt, "同账号重复确认应幂等");
  assert.throws(() => phonePool.confirmManualUsed(unused.id, accountB), (err) => err && err.code === "PHONE_STATE_CONFLICT");

  const reservedClaim = phonePool.claimForAccount(accountB, { mode: "exclusive" });
  assert.strictEqual(reservedClaim.item.number, numbers[1]);
  assert.throws(() => phonePool.confirmManualUsed(reservedClaim.item.id, accountA), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.strictEqual(phonePool.confirmManualUsed(reservedClaim.item.id, accountB).status, "used");

  const pendingClaim = phonePool.claimForAccount(accountC, { mode: "exclusive" });
  assert.strictEqual(pendingClaim.item.number, numbers[2]);
  phonePool.markPending(pendingClaim.item.id, pendingClaim.leaseId, "等待生效");
  assert.throws(() => phonePool.confirmManualUsed(pendingClaim.item.id, accountB), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.strictEqual(phonePool.confirmManualUsed(pendingClaim.item.id, accountC).status, "used");

  const failed = byNumber(numbers[3]);
  phonePool.update(failed.id, { status: "failed" });
  assert.throws(() => phonePool.confirmManualUsed(failed.id, accountA), (err) => err && err.code === "PHONE_STATE_CONFLICT");
  assert.strictEqual(phonePool.confirmManualUsed("missing-phone-id", accountA), null);
});

check("未占用号码可在共享与一号一绑之间切换，模式会限制领取池", () => {
  const number = "+12025550136";
  phonePool.importText(number, { usageMode: "exclusive" });
  const item = phonePool.list().find((entry) => entry.number === number);
  assert.ok(item);
  assert.strictEqual(phonePool.toPublic(item).usageMode, "exclusive");
  assert.strictEqual(phonePool.update(item.id, { usageMode: "shared" }).usageMode, "shared");
  assert.strictEqual(phonePool.claimForAccount(
    { id: "mode-exclusive-miss", email: "mode-exclusive-miss@example.com" },
    { mode: "exclusive" },
  ), null, "切成共享后不能被一号一绑任务领取");
  assert.strictEqual(phonePool.update(item.id, { usageMode: "exclusive" }).usageMode, "exclusive");
  assert.deepStrictEqual(phonePool.remove([item.id]).blocked, [], "没有 active lease 或绑定历史时仍可删除");
});

check("已绑号码可明确强制删除本地记录，但 active lease 永远受保护", () => {
  const boundNumber = "+12025550138";
  phonePool.importText(boundNumber, { usageMode: "exclusive" });
  const bound = phonePool.list().find((item) => item.number === boundNumber);
  phonePool.confirmManualUsed(bound.id, { id: "force-bound-account", email: "force-bound@example.com" });
  assert.deepStrictEqual(phonePool.remove([bound.id]).blocked, [bound.id], "未明确强删时仍应保护绑定历史");
  assert.throws(() => phonePool.remove([bound.id], { forceBound: "true" }), /forceBound 必须是布尔值/);
  const forced = phonePool.remove([bound.id], { forceBound: true });
  assert.strictEqual(forced.removed, 1, "明确 forceBound 后应只删除本地记录");
  assert.strictEqual(phonePool.getById(bound.id), null);

  const activeNumber = "+12025550139";
  phonePool.importText(activeNumber, { usageMode: "exclusive" });
  const active = phonePool.claimForAccount(
    { id: "force-active-account", email: "force-active@example.com" },
    { mode: "exclusive" },
  );
  assert.strictEqual(active.item.number, activeNumber);
  assert.deepStrictEqual(
    phonePool.remove([active.item.id], { forceBound: true }).blocked,
    [active.item.id],
    "即使明确强删，进行中的号码也不能删除",
  );
  phonePool.release(active.item.id, active.leaseId, "测试收尾");
  assert.strictEqual(phonePool.remove([active.item.id], { forceBound: true }).removed, 1);
});

check("手机号池 public DTO 不泄露完整号码、raw、lease 或内部账号 id", () => {
  const internal = phonePool.list()[0];
  phonePool.update(internal.id, { notes: `备用联系方式 ${internal.number}` });
  const dto = phonePool.toPublic(internal);
  assert.ok(dto.maskedNumber && dto.last4);
  for (const key of ["number", "raw", "leaseId", "completedLeaseId", "usedByAccountId", "bindings"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(dto, key), false, `public DTO 不应包含 ${key}`);
  }
  assert.ok(["shared", "exclusive"].includes(dto.usageMode));
  assert.ok(Number.isInteger(dto.bindingCount) && dto.bindingCount >= 0);
  assert.strictEqual(typeof dto.available, "boolean");
  assert.ok(!JSON.stringify(dto).includes(internal.number), "public DTO 不应以其它字段回显完整号码");
  if (dto.status === "used" && dto.bindingCount > 0) assert.deepStrictEqual(dto.allowedStatuses, ["used", "disabled"]);
});

check("手机号池任务轮询不会打断备注/状态编辑", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = appSource.indexOf("function isEditingPhonePool");
  const end = appSource.indexOf("function filteredPhones", start);
  assert.ok(start >= 0 && end > start);
  const active = { matches: (selector) => selector.includes("data-phone-status") };
  const rows = { contains: (node) => node === active };
  const detectEditing = new Function("document", "el", `${appSource.slice(start, end)}\nreturn isEditingPhonePool;`)(
    { activeElement: active },
    (id) => (id === "phoneRows" ? rows : null),
  );
  assert.strictEqual(detectEditing(), true);
  const modeActive = { matches: (selector) => selector.includes("data-phone-mode") };
  const modeRows = { contains: (node) => node === modeActive };
  const detectModeEditing = new Function("document", "el", `${appSource.slice(start, end)}\nreturn isEditingPhonePool;`)(
    { activeElement: modeActive },
    (id) => (id === "phoneRows" ? modeRows : null),
  );
  assert.strictEqual(detectModeEditing(), true, "切换共享/独享模式时轮询不能把下拉框重绘掉");
  assert.match(appSource, /loadPhones\(\{\s*skipIfEditing:\s*true\s*\}\)/, "手机号动作轮询必须使用编辑保护");
});

check("手机号 UI/文档以直接添加和稍后生效为默认，验证码仅作条件分支", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const readmeSource = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(htmlSource, /通常会直接添加并提示稍后生效/);
  assert.match(htmlSource, /仅当 Google 另行要求时才需要人工处理验证码/);
  assert.match(appSource, /pending:\s*"待生效 \/ 待确认"/);
  assert.match(readmeSource, /填写号码后点一次 `Next`.*再点一次 `Save`/);
  assert.match(readmeSource, /只有 `Save` 之后 Google 明确显示添加成功、提示 `security delay` \/ 稍后生效/);
  assert.match(readmeSource, /如果 Google 另行要求短信验证码/);
  assert.ok(!readmeSource.includes("再填写号码并请求短信验证码"), "不能把请求短信验证码写成默认流程");
  assert.match(htmlSource, /id="phoneImportMode"[\s\S]*value="shared"[\s\S]*value="exclusive"/);
  assert.match(htmlSource, /id="phoneRunMode"[\s\S]*value="shared"[\s\S]*value="exclusive"/);
  assert.match(appSource, /JSON\.stringify\(\{ text, usageMode \}\)/, "导入请求必须携带手机号分配模式");
  assert.match(appSource, /phoneMode:\s*readPhoneRunMode\(\)/, "自动化任务必须携带本次领取模式");
  assert.match(appSource, /共享可用（已绑 \$\{count\}）/);
  assert.match(appSource, /data-phone-mode/);
  assert.match(appSource, /function phoneIsBusy[\s\S]*reserved[\s\S]*pending/);
  assert.match(appSource, /只会删除本地手机号池记录，不会从 Google 账号解绑手机号/);
  assert.match(appSource, /forceBound:\s*true/, "删除已绑记录必须向后端显式声明强制本地删除");
  assert.match(appSource, /停用复用/);
  assert.match(appSource, /恢复共享可用/);
  assert.match(readmeSource, /本地手机号池不限制共享复用次数/);
  assert.match(readmeSource, /只删除本地手机号池记录，不会从 Google 账号中解绑手机号/);
});

check("添加两步验证手机号已注册为高风险写操作且必须独占、单并发", () => {
  const item = actionsRegistry.list().find((action) => action.id === "add-2fa-phone");
  assert.ok(item);
  assert.strictEqual(item.risk, "high");
  assert.strictEqual(item.readOnly, false);
  assert.strictEqual(item.exclusive, true);
  assert.strictEqual(typeof actionsRegistry.get("add-2fa-phone").run, "function");
  assert.match(actionsRegistry.validateSelection(["add-2fa-phone", "login"]), /必须单独运行/);
  const job = engine.createJob({ mode: "local", envSerials: [], accountIds: [], actionIds: ["add-2fa-phone"], maxConcurrent: 9 });
  assert.strictEqual(job.maxConcurrent, 1, "添加手机号可能需要人工接管，必须强制单并发");
  assert.strictEqual(job.phoneMode, "shared", "未指定时应默认使用可重复绑定的共享号码池");
  assert.strictEqual(engine.publicJob(job).phoneMode, "shared", "公开任务状态应保留手机号分配模式");
  const exclusiveJob = engine.createJob({
    mode: "local", envSerials: [], accountIds: [], actionIds: ["add-2fa-phone"], phoneMode: "exclusive",
  });
  assert.strictEqual(exclusiveJob.phoneMode, "exclusive", "应支持显式的一号一绑模式");
  assert.throws(
    () => engine.createJob({ mode: "local", envSerials: [], accountIds: [], actionIds: ["add-2fa-phone"], phoneMode: "invalid" }),
    /手机号使用模式无效/,
  );
  assert.strictEqual(engine.helpers.shouldKeepTaskOpen(false, true), true);
  assert.strictEqual(engine.helpers.shouldKeepTaskOpen(false, false), false);
});

check("保留窗口会占住浏览器环境；AdsPower 编号去重并跨任务互斥", () => {
  assert.deepStrictEqual(engine.helpers.normalizeAdsSerials([" 4 ", "4", "", 5]), ["4", "5"]);
  assert.strictEqual(engine.helpers.isEnvReusable({ busy: false, retained: false }), true);
  assert.strictEqual(engine.helpers.isEnvReusable({ busy: false, retained: true }), false);
  assert.strictEqual(engine.helpers.isEnvReusable({ busy: true, retained: false }), false);

  const ownerA = { id: "engine-lease-a", mode: "adspower" };
  const ownerB = { id: "engine-lease-b", mode: "adspower" };
  const env = { serial: "__engine-retained-test__", busy: false, retained: false };
  engine.helpers.reserveAdsSerials(ownerA.id, [env.serial]);
  assert.throws(
    () => engine.helpers.reserveAdsSerials(ownerB.id, [env.serial]),
    /正被另一个任务使用或保留/,
  );
  assert.strictEqual(engine.helpers.releaseAdsSerial(ownerA, env, true), true);

  const queued = { status: "queued", error: null, events: [] };
  const blockedJob = { envs: [{ busy: false, retained: true }], tasks: [queued] };
  assert.strictEqual(engine.helpers.finishQueuedWithoutReusableEnv(blockedJob), true);
  assert.strictEqual(queued.status, "error");
  assert.strictEqual(queued.events[0].type, "env_unavailable");

  const waiting = { status: "queued", error: null, events: [] };
  assert.strictEqual(
    engine.helpers.finishQueuedWithoutReusableEnv({ envs: [{ busy: true, retained: false }], tasks: [waiting] }),
    false,
    "仍有运行中环境时不能提前终结排队任务",
  );

  const dedupJob = engine.createJob({
    mode: "adspower",
    envSerials: [" __engine-dedupe__ ", "__engine-dedupe__"],
    accountIds: [],
    actionIds: ["login"],
    maxConcurrent: 1,
  });
  assert.deepStrictEqual(dedupJob.envs.map((item) => item.serial), ["__engine-dedupe__"]);
  assert.strictEqual(dedupJob.status, "done");
});

check("手机号页面按字段语义区分手机号/短信码，且列表成功证据不跨行拼数字", () => {
  const { inspectPhoneDocument } = addPhone._internals;
  const makeNode = ({ text = "", attrs = {}, children = [], input = false } = {}) => {
    const attrMap = { ...attrs };
    const node = {
      textContent: text,
      innerText: text,
      value: "",
      labels: [],
      children,
      childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
      parentElement: null,
      disabled: false,
      getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrMap, name) ? attrMap[name] : null),
      setAttribute: (name, value) => { attrMap[name] = String(value); },
      removeAttribute: (name) => { delete attrMap[name]; },
      getBoundingClientRect: () => ({ width: 180, height: 36 }),
      contains(other) {
        if (other === node) return true;
        return children.some((child) => child === other || (typeof child.contains === "function" && child.contains(other)));
      },
      querySelectorAll: () => [],
    };
    children.forEach((child) => { child.parentElement = node; });
    if (input) node.childNodes = [];
    return node;
  };
  const run = ({ body, inputs = [], dialogs = [], rows = [], live = [], buttons = [], targetNumber = "+12025550126" }) => {
    const oldDocument = global.document;
    const oldStyle = global.getComputedStyle;
    global.document = {
      body: { innerText: body },
      getElementById: () => null,
      querySelectorAll(selector) {
        if (selector === "input") return inputs;
        if (selector === "[role='dialog'], dialog") return dialogs;
        if (selector.includes("role='status'")) return live;
        if (selector.includes("button") && selector.includes("[role='button']")) return buttons;
        if (selector.startsWith("li, tr")) return rows;
        return [];
      },
    };
    global.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    try { return inspectPhoneDocument({ targetNumber }); } finally {
      global.document = oldDocument;
      global.getComputedStyle = oldStyle;
    }
  };

  const phone = makeNode({ attrs: { type: "tel", autocomplete: "tel", "aria-label": "Phone number" }, input: true });
  const phoneDialog = makeNode({ text: "Add a phone number. We'll send a verification code.", children: [phone] });
  let snap = run({ body: phoneDialog.innerText, inputs: [phone], dialogs: [phoneDialog] });
  assert.strictEqual(snap.hasPhoneInput, true, "autocomplete=tel 必须优先识别为手机号框");
  assert.strictEqual(snap.hasCodeInput, false, "说明文案里的 verification code 不能污染手机号字段");

  const code = makeNode({ attrs: { type: "tel", autocomplete: "one-time-code", "aria-label": "Verification code" }, input: true });
  const codeDialog = makeNode({ text: "Enter the 6-digit verification code", children: [code] });
  snap = run({ body: codeDialog.innerText, inputs: [code], dialogs: [codeDialog] });
  assert.strictEqual(snap.hasCodeInput, true);
  assert.strictEqual(snap.hasPhoneInput, false, "type=tel 的短信码框不能冒充手机号框");

  const firstHalf = makeNode({ text: "+1 202 555" });
  const secondHalf = makeNode({ text: "0126" });
  snap = run({ body: "2-Step Verification phone numbers +1 202 555 0126", rows: [firstHalf, secondHalf] });
  assert.strictEqual(snap.listed, false, "不同号码行的数字不得被整页拼接成目标号码");
  const fullRow = makeNode({ text: "Phone +1 (202) 555-0126" });
  snap = run({ body: "2-Step Verification phone numbers Phone +1 (202) 555-0126", rows: [fullRow] });
  assert.strictEqual(snap.listed, true, "单个可见号码行完整出现目标号码才算远端确认");

  const localRow = makeNode({ text: "Phone 5123 4567" });
  snap = run({
    body: "2-Step Verification phone numbers Phone 5123 4567",
    rows: [localRow],
    targetNumber: "+85251234567",
  });
  assert.strictEqual(snap.listed, true, "Google 省略国家码时，应安全匹配同一行内独立的最后 8 位本地号码");
  const longerLocalRow = makeNode({ text: "Phone 95123 4567" });
  snap = run({
    body: "2-Step Verification phone numbers Phone 95123 4567",
    rows: [longerLocalRow],
    targetNumber: "+85251234567",
  });
  assert.strictEqual(snap.listed, false, "本地尾号前后仍连接数字时不得误判为目标号码");

  const confirmDialog = makeNode({ text: "Confirm phone number +852 5123 4567 Save Cancel" });
  snap = run({
    body: confirmDialog.innerText,
    dialogs: [confirmDialog],
    targetNumber: "+85251234567",
  });
  assert.strictEqual(snap.phoneConfirmation, true, "第二弹窗应凭目标号码与确认语义识别为 Save 阶段");

  snap = run({ body: "It may take a week before you can use your new phone number to verify it's you for sensitive actions like changing your password." });
  assert.strictEqual(snap.delayedActivation, true, "Google 英文的一周后可验证提示应识别");
  snap = run({ body: "您可能需要先等待一周的时间，然后才能在执行更改密码等敏感操作时使用新电话号码验证自己的身份。" });
  assert.strictEqual(snap.delayedActivation, true, "Google 简中稍后生效提示应识别");
  snap = run({ body: "新的電話號碼設定完成後，可能需要一週的時間才能在您執行敏感操作時，用來驗證身分。" });
  assert.strictEqual(snap.delayedActivation, true, "Google 繁中稍后生效提示应识别");
  snap = run({ body: "To keep your account safe, there's a security delay before you can use a new phone for 2-Step Verification." });
  assert.strictEqual(snap.delayedActivation, true, "Google 最终列表当前英文 security delay 原文应识别");
  snap = run({ body: "Add a phone number for account recovery" });
  assert.strictEqual(snap.delayedActivation, false, "普通添加说明不能冒充稍后生效成功提示");
});

check("Next/Save 分阶段定位可读 visible text、aria、input value，且不点击 Cancel/Back", () => {
  const { locateScopedButtonDocument, NEXT_TEXT, SAVE_TEXT } = addPhone._internals;
  assert.ok(NEXT_TEXT.some((source) => new RegExp(source, "i").test("Next")), "第一弹窗 Next 必须识别");
  assert.ok(SAVE_TEXT.some((source) => new RegExp(source, "i").test("Save")), "第二弹窗 Save 必须识别");
  const makeNode = (text, attrs = {}, area = 1000) => ({
    textContent: text,
    innerText: text,
    value: attrs.value || "",
    parentElement: null,
    disabled: false,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getBoundingClientRect: () => ({ width: area, height: 1 }),
    scrollIntoView: () => {},
    closest: () => null,
  });
  const backgroundAdd = makeNode("Add a phone number", {}, 10);
  const backgroundNext = makeNode("Next", {}, 10);
  const visibleAndAriaNext = makeNode("Next", { "aria-label": "Next" }, 100);
  const inputValueNext = makeNode("", { type: "submit", value: "Next" }, 100);
  const foregroundSave = makeNode("", { type: "submit", value: "Save", "aria-label": "Save" }, 100);
  const cancel = makeNode("Cancel", { "aria-label": "Cancel" }, 1);
  const back = makeNode("Back", { "aria-label": "Back" }, 1);
  const phoneInput = makeNode("", { autocomplete: "tel", "aria-label": "Phone number" });
  const phoneDialog = makeNode("Add a phone number");
  phoneDialog.contains = (node) => node === phoneInput;
  const confirmDialog = makeNode("Confirm phone number +852 5123 4567");
  confirmDialog.contains = () => false;

  const oldDocument = global.document;
  const oldStyle = global.getComputedStyle;
  const setDocument = ({ dialog = phoneDialog, dialogButtons = [], inputs = [phoneInput] } = {}) => {
    dialog.querySelectorAll = (selector) => (selector.includes("button") ? dialogButtons : []);
    global.document = {
      querySelectorAll(selector) {
        if (selector === "[role='dialog'], dialog") return [dialog];
        if (selector === "input") return inputs;
        if (selector.includes("button") && selector.includes("[role='button']")) return [backgroundAdd, backgroundNext, ...dialogButtons];
        return [];
      },
    };
  };
  global.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  try {
    setDocument({ dialogButtons: [], inputs: [] });
    assert.strictEqual(locateScopedButtonDocument({ sources: ["^Add a phone number$"], kind: "add" }), null, "前景 blocker 存在时不得点背景 Add");
    assert.strictEqual(locateScopedButtonDocument({ sources: NEXT_TEXT, kind: "next" }), null, "前景无手机号框时不得点背景 Next");

    setDocument({ dialogButtons: [cancel, back, visibleAndAriaNext], inputs: [phoneInput] });
    assert.strictEqual(
      locateScopedButtonDocument({ sources: NEXT_TEXT, kind: "next" }),
      visibleAndAriaNext,
      "visible text 与 aria-label 都是 Next 时必须分别匹配，不能拼成 Next Next",
    );

    setDocument({ dialogButtons: [cancel, back, inputValueNext], inputs: [phoneInput, inputValueNext] });
    assert.strictEqual(
      locateScopedButtonDocument({ sources: NEXT_TEXT, kind: "next" }),
      inputValueNext,
      "dialog footer 的 input[type=submit][value=Next] 必须可定位",
    );

    setDocument({ dialog: confirmDialog, dialogButtons: [cancel, back, foregroundSave], inputs: [foregroundSave] });
    assert.strictEqual(
      locateScopedButtonDocument({
        sources: SAVE_TEXT,
        kind: "save",
        targetNumber: "+85251234567",
      }),
      foregroundSave,
      "第二弹窗没有手机号框时，应按确认号码定位 Save",
    );
    assert.strictEqual(
      locateScopedButtonDocument({ sources: [".*"], kind: "save", targetNumber: "+85251234567" }),
      foregroundSave,
      "即使匹配源过宽也必须排除面积更小的 Cancel/Back",
    );
  } finally {
    global.document = oldDocument;
    global.getComputedStyle = oldStyle;
  }
});

(async () => {
  await checkAsync("手机号池 HTTP API 返回脱敏 DTO，并以 409 拒绝非法/危险状态操作", async () => {
    const apiServer = http.createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    await new Promise((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${apiServer.address().port}`;
    const number = "+12025550129";
    const jsonRequest = (pathname, options = {}) => fetch(`${base}${pathname}`, options);
    try {
      let res = await jsonRequest("/api/phones/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${number}|API脱敏测试`, usageMode: "exclusive" }),
      });
      assert.strictEqual(res.status, 200);
      let body = await res.json();
      assert.strictEqual(body.added, 1);
      assert.ok(!JSON.stringify(body).includes(number), "导入响应不能回显完整号码");
      const internal = phonePool.list().find((item) => item.number === number);
      assert.ok(internal);
      assert.strictEqual(internal.usageMode, "exclusive");

      res = await jsonRequest("/api/phones/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "+12025550128", usageMode: "invalid" }),
      });
      assert.strictEqual(res.status, 400, "非法导入模式应返回 400 而不是写入或冒泡成 500");

      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "pending" }),
      });
      assert.strictEqual(res.status, 409, "API 不得人工创建 pending");

      const claim = phonePool.claimForAccount(
        { id: "api-account", email: "api@example.com" },
        { mode: "exclusive" },
      );
      assert.strictEqual(claim.item.id, internal.id);
      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "unused" }),
      });
      assert.strictEqual(res.status, 409, "active 不得直接释放为 unused");
      res = await jsonRequest("/api/phones/delete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [internal.id] }),
      });
      assert.strictEqual(res.status, 409, "active 删除必须返回 409");
      res = await jsonRequest("/api/phones/delete", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [internal.id], forceBound: true }),
      });
      assert.strictEqual(res.status, 409, "active 即使 forceBound=true 也必须受保护");
      res = await jsonRequest("/api/phones/delete", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [internal.id], forceBound: "true" }),
      });
      assert.strictEqual(res.status, 400, "forceBound 必须严格为布尔值");
      res = await jsonRequest("/api/phones/delete", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [internal.id], unexpected: true }),
      });
      assert.strictEqual(res.status, 400, "删除 API 必须拒绝未知字段");

      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "failed" }),
      });
      assert.strictEqual(res.status, 409, "active 状态只能由持有 lease 的自动化动作推进");
      phonePool.markFailed(internal.id, claim.leaseId, "测试收尾");

      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "unused" }),
      });
      assert.strictEqual(res.status, 200, "failed 可由用户显式恢复成 unused");
      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "used" }),
      });
      assert.strictEqual(res.status, 200, "允许用户把外部已消耗号码永久标成 used");
      phonePool.confirmManualUsed(internal.id, { id: "api-account", email: "api@example.com" });
      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "disabled" }),
      });
      assert.strictEqual(res.status, 200, "已绑号码应允许停用");
      body = await res.json();
      assert.strictEqual(body.phone.status, "disabled");
      assert.strictEqual(body.phone.available, false);
      assert.deepStrictEqual(body.phone.allowedStatuses, ["disabled", "used"]);
      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "unused" }),
      });
      assert.strictEqual(res.status, 409, "停用不能清空既有绑定历史");
      res = await jsonRequest(`/api/phones/${internal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "used" }),
      });
      assert.strictEqual(res.status, 200, "停用后应允许恢复已用/共享可用状态");
      res = await jsonRequest("/api/phones/delete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [internal.id] }),
      });
      assert.strictEqual(res.status, 409, "used 删除必须返回 409");
      res = await jsonRequest("/api/phones/delete", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [internal.id], forceBound: true }),
      });
      assert.strictEqual(res.status, 200, "明确 forceBound=true 后应允许删除已绑本地记录");
      body = await res.json();
      assert.strictEqual(body.removed, 1);
      assert.strictEqual(phonePool.getById(internal.id), null);

      res = await jsonRequest("/api/phones");
      assert.strictEqual(res.status, 200);
      body = await res.json();
      assert.ok(!JSON.stringify(body).includes(number), "GET 列表不能泄露完整号码");
      assert.deepStrictEqual(body.usageModes, ["shared", "exclusive"]);
      assert.ok(body.phones.every((item) => !["number", "raw", "leaseId", "usedByAccountId", "bindings"].some((key) => Object.prototype.hasOwnProperty.call(item, key))));
      assert.ok(body.phones.every((item) => ["shared", "exclusive"].includes(item.usageMode)
        && Number.isInteger(item.bindingCount) && typeof item.available === "boolean"));
    } finally {
      await new Promise((resolve) => apiServer.close(resolve));
    }
  });

  await checkAsync("人工完成同步 API：成功与同账号幂等，404/409 和 body 白名单生效", async () => {
    const ownerEmail = "manual-api-owner@example.com";
    const otherEmail = "manual-api-other@example.com";
    accounts.importText([
      `${ownerEmail}|pw|JBSWY3DPEHPK3PXP|2026|US`,
      `${otherEmail}|pw|JBSWY3DPEHPK3PXP|2026|US`,
    ].join("\n"));
    const owner = accounts.list().find((item) => item.email === ownerEmail);
    const other = accounts.list().find((item) => item.email === otherEmail);
    const number = "+12025550135";
    phonePool.importText(number, { usageMode: "exclusive" });
    const phone = phonePool.list().find((item) => item.number === number);
    assert.ok(owner && other && phone);

    const apiServer = http.createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    await new Promise((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${apiServer.address().port}`;
    const post = (id, body) => fetch(`${base}/api/phones/${id}/confirm-used`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      let res = await post("missing-phone", { accountId: owner.id });
      assert.strictEqual(res.status, 404, "手机号不存在应返回 404");
      res = await post(phone.id, { accountId: "missing-account" });
      assert.strictEqual(res.status, 404, "账号不存在应返回 404");
      res = await post(phone.id, { accountId: owner.id, email: owner.email });
      assert.strictEqual(res.status, 400, "请求体只能接受 accountId");

      res = await post(phone.id, { accountId: owner.id });
      assert.strictEqual(res.status, 200);
      let body = await res.json();
      assert.strictEqual(body.phone.status, "used");
      assert.strictEqual(body.phone.usedBy, owner.email);
      assert.strictEqual(body.account.id, owner.id);
      assert.strictEqual(body.account.status.phone, "ok");
      assert.ok(!JSON.stringify(body.phone).includes(number), "响应手机号必须保持脱敏");

      const firstUsedAt = body.phone.usedAt;
      res = await post(phone.id, { accountId: owner.id });
      assert.strictEqual(res.status, 200, "同账号重复同步应幂等");
      body = await res.json();
      assert.strictEqual(body.phone.usedAt, firstUsedAt);

      res = await post(phone.id, { accountId: other.id });
      assert.strictEqual(res.status, 409, "跨账号改绑必须返回 409");
      assert.strictEqual(phonePool.getById(phone.id).usedByAccountId, owner.id);
    } finally {
      await new Promise((resolve) => apiServer.close(resolve));
    }
  });

  await checkAsync("添加手机号动作在手机号池为空时不导航、不误写成功", async () => {
    let drove = false;
    let requestedMode = "";
    const result = await addPhone({}, { id: "acc-empty", email: "empty@example.com" }, {
      phoneMode: "exclusive",
      phonePool: { claimForAccount: (_account, options) => { requestedMode = options && options.mode; return null; } },
      drivePhoneFlow: async () => { drove = true; return { kind: "added", explicitSuccess: true }; },
    });
    assert.strictEqual(drove, false);
    assert.strictEqual(requestedMode, "exclusive", "动作必须只从本次选择的一号一绑池领取");
    assert.strictEqual(result.outcome, "error");
    assert.strictEqual(result.reasonCode, "phone_pool_empty");
    assert.match(result.detail.phoneAdd, /一号一绑池/);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.statusPatch || {}, "phone"), false);
  });

  await checkAsync("Save 点击触发导航异常仍保留 attempted；Next 不锁定，Save 后才 pending", async () => {
    let physicalClicks = 0;
    let disposed = 0;
    const handle = {
      asElement: () => handle,
      click: async () => { physicalClicks += 1; throw new Error("Execution context was destroyed"); },
      dispose: async () => { disposed += 1; },
    };
    const attempt = await addPhone._internals.clickScoped(
      { evaluateHandle: async () => handle },
      ["^Save$"],
      { kind: "save", targetNumber: "+12025550127" },
    );
    assert.deepStrictEqual(attempt, { found: true, attempted: true, confirmed: false });
    assert.strictEqual(physicalClicks, 1);
    assert.strictEqual(disposed, 1);

    let inspectCalls = 0;
    let nextClicks = 0;
    let saveClicks = 0;
    let pendingMarks = 0;
    const snapshots = [
      { hasPhoneInput: true },
      { hasPhoneInput: true },
      { hasPhoneInput: true },
      { phoneConfirmation: true },
      {},
    ];
    const flow = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "attempted-account", email: "attempted@example.com" },
      "+12025550127",
      { actionTimeoutMs: 8, emit: () => {}, onSubmitAttempted: async () => { pendingMarks += 1; } },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => snapshots[Math.min(inspectCalls++, snapshots.length - 1)],
        fillPhone: async () => true,
        clickNext: async () => {
          nextClicks += 1;
          assert.strictEqual(pendingMarks, 0, "Next 仅进入确认弹窗，不能提前 markPending");
          return { found: true, attempted: true, confirmed: true };
        },
        clickSave: async () => {
          saveClicks += 1;
          assert.strictEqual(pendingMarks, 0, "Save click 前仍应是 reserved");
          return { found: true, attempted: true, confirmed: false };
        },
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(flow.kind, "timeout");
    assert.strictEqual(flow.submitted, true, "Save confirmed=false 也必须越过不可逆 submitted 边界");
    assert.strictEqual(nextClicks, 1, "Next 只能点击一次");
    assert.strictEqual(saveClicks, 1, "Save 只能尝试一次，导航异常后绝不能重试");
    assert.strictEqual(pendingMarks, 1, "Save 一旦尝试必须立即锁定 pending");
  });

  await checkAsync("通用成功 toast 必须是本次发送后的新证据，提交前残留 toast 不会误报", async () => {
    let fills = 0;
    let sends = 0;
    const stale = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "toast-account", email: "toast@example.com" },
      "+12025550128",
      { emit: () => {}, onSmsRequested: async () => {}, actionTimeoutMs: 8 },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => ({ explicitSuccess: false, listed: false, successToast: true, hasPhoneInput: true }),
        fillPhone: async () => { fills += 1; return true; },
        clickSend: async () => { sends += 1; return { attempted: true, confirmed: true }; },
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(stale.kind, "before_submit_failure", "提交前就存在且从未消失的旧 toast 不能证明本次成功或越过 Save 边界");
    assert.strictEqual(fills, 1, "残留 toast 不能阻止本次填号");
    assert.strictEqual(sends, 1);

    let inspectCalls = 0;
    const freshSnapshots = [
      { hasPhoneInput: true, successToast: false },
      { hasPhoneInput: true, successToast: false },
      { hasPhoneInput: true, successToast: false },
      { phoneConfirmation: true, hasPhoneInput: false, successToast: false },
      { hasPhoneInput: false, successToast: true },
    ];
    const fresh = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "fresh-toast-account", email: "fresh-toast@example.com" },
      "+12025550131",
      { emit: () => {}, onSmsRequested: async () => {} },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => freshSnapshots[Math.min(inspectCalls++, freshSnapshots.length - 1)],
        fillPhone: async () => true,
        clickNext: async () => ({ attempted: true, confirmed: true }),
        clickSave: async () => ({ attempted: true, confirmed: true }),
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(fresh.kind, "added", "Save 前没有 toast、Save 后新出现时可作为辅助成功证据");
  });

  await checkAsync("添加手机号无需把短信码当必经步骤；Google 提示稍后生效即可完成", async () => {
    let inspectCalls = 0;
    let nextClicks = 0;
    let saveClicks = 0;
    let pendingMarks = 0;
    const snapshots = [
      { hasPhoneInput: true, successToast: false, delayedActivation: false },
      { hasPhoneInput: true, successToast: false, delayedActivation: false },
      { hasPhoneInput: true, successToast: false, delayedActivation: false },
      { phoneConfirmation: true, hasPhoneInput: false, successToast: false, delayedActivation: false },
      { listed: true, hasPhoneInput: false, successToast: false, delayedActivation: true },
    ];
    const flow = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "deferred-account", email: "deferred@example.com" },
      "+12025550132",
      { emit: () => {}, onSubmitAttempted: async () => { pendingMarks += 1; } },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => snapshots[Math.min(inspectCalls++, snapshots.length - 1)],
        fillPhone: async () => true,
        clickNext: async () => {
          nextClicks += 1;
          assert.strictEqual(pendingMarks, 0, "第一弹窗 Next 不能提前锁定号码");
          return { attempted: true, confirmed: true };
        },
        clickSave: async () => {
          saveClicks += 1;
          assert.strictEqual(pendingMarks, 0, "第二弹窗 Save 点击前仍可安全释放");
          return { attempted: true, confirmed: true };
        },
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(flow.kind, "added");
    assert.strictEqual(flow.activationDeferred, true);
    assert.strictEqual(nextClicks, 1);
    assert.strictEqual(saveClicks, 1, "确认弹窗 Save 只能提交一次");
    assert.strictEqual(pendingMarks, 1, "只有 Save attempted 后才锁定 pending");

    let noSaveInspects = 0;
    let noSaveMarks = 0;
    const noSaveSnapshots = [
      { hasPhoneInput: true },
      { hasPhoneInput: true },
      { hasPhoneInput: true },
      { phoneConfirmation: true },
    ];
    const noSave = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "no-save", email: "no-save@example.com" },
      "+12025550135",
      { emit: () => {}, onSubmitAttempted: async () => { noSaveMarks += 1; } },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => noSaveSnapshots[Math.min(noSaveInspects++, noSaveSnapshots.length - 1)],
        fillPhone: async () => true,
        clickNext: async () => ({ attempted: true, confirmed: true }),
        clickSave: async () => ({ attempted: false, confirmed: false }),
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(noSave.kind, "before_submit_failure");
    assert.strictEqual(noSave.submitted, false, "Save 未 attempted 时必须保持可释放");
    assert.strictEqual(noSaveMarks, 0);

    let baselineDelayInspects = 0;
    const baselineDelaySnapshots = [
      { hasPhoneInput: true, delayedActivation: false },
      { hasPhoneInput: true, delayedActivation: false },
      { hasPhoneInput: true, delayedActivation: false },
      { phoneConfirmation: true, delayedActivation: true },
      { phoneConfirmation: true, delayedActivation: true },
    ];
    const baselineDelay = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "baseline-delay", email: "baseline-delay@example.com" },
      "+12025550136",
      { emit: () => {}, actionTimeoutMs: 8, onSubmitAttempted: async () => {} },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => baselineDelaySnapshots[Math.min(baselineDelayInspects++, baselineDelaySnapshots.length - 1)],
        fillPhone: async () => true,
        clickNext: async () => ({ attempted: true, confirmed: true }),
        clickSave: async () => ({ attempted: true, confirmed: true }),
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(baselineDelay.kind, "timeout", "Save 前确认弹窗已有的 delay 文案不能在 Save 后冒充新成功证据");

    const staleDelay = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "stale-delay", email: "stale-delay@example.com" },
      "+12025550133",
      { emit: () => {}, onSmsRequested: async () => {}, actionTimeoutMs: 8 },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => ({ hasPhoneInput: true, delayedActivation: true }),
        fillPhone: async () => true,
        clickSend: async () => ({ attempted: true, confirmed: true }),
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(staleDelay.kind, "before_submit_failure", "Save 前已存在且输入框未消失的帮助文案不能冒充成功");

    let codeInspectCalls = 0;
    const codeSnapshots = [
      { hasPhoneInput: true, delayedActivation: false },
      { hasPhoneInput: true, delayedActivation: false },
      { hasPhoneInput: true, delayedActivation: false },
      { hasCodeInput: true, verificationPrompt: true, delayedActivation: true },
    ];
    const conditionalCode = await addPhone._internals.drivePhoneFlow(
      { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en", evaluate: async () => "" },
      { id: "conditional-code", email: "conditional-code@example.com" },
      "+12025550134",
      { emit: () => {}, onSmsRequested: async () => {}, manualCodeWaitMs: 0 },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => codeSnapshots[Math.min(codeInspectCalls++, codeSnapshots.length - 1)],
        fillPhone: async () => true,
        clickSend: async () => ({ attempted: true, confirmed: true }),
        clickAdd: async () => { throw new Error("已有手机号框，不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(conditionalCode.kind, "code_required", "若 Google 确实显示短信码框，仍应交给用户处理，不能被延迟提示覆盖");

    const item = { id: "phone-deferred", number: "+12025550132", status: "reserved", submittedAt: "" };
    const pool = {
      claimForAccount: () => ({ item, leaseId: "lease-deferred", reused: false, alreadyUsed: false, readOnly: false }),
      markPending: () => { item.status = "pending"; item.submittedAt = new Date().toISOString(); return item; },
      confirmUsed: () => { item.status = "used"; return item; },
      markFailed: () => null,
      release: () => null,
      getById: () => item,
    };
    const result = await addPhone({}, { id: "deferred-account", email: "deferred@example.com" }, {
      phonePool: pool,
      drivePhoneFlow: async (_page, _account, _number, flowCtx) => {
        await flowCtx.onSmsRequested();
        return { kind: "added", submitted: true, explicitSuccess: true, activationDeferred: true };
      },
    });
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "phone_added_pending_activation");
    assert.strictEqual(result.statusPatch.phone, "ok");
    assert.match(result.detail.phoneAdd, /等待一段时间后生效/);
  });

  await checkAsync("目标 URL 仍先检查 blocker，不因地址命中直接放行", async () => {
    let blockers = 0;
    const page = { url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en" };
    const result = await addPhone._internals.navigateToPhonePage(
      page,
      { id: "blocked-account", email: "blocked@example.com" },
      {},
      () => {},
      100,
      {
        now: () => 0,
        safeGoto: async () => {},
        settle: async () => {},
        handleBlockers: async () => {
          blockers += 1;
          return { terminal: true, handled: false, result: { outcome: "need_verify", detail: { phone: "人机验证" } } };
        },
      },
    );
    assert.strictEqual(blockers, 1);
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /人机验证/);
  });

  await checkAsync("手机号池 used 记录必须远端复核；未确认不得直接写 phone=ok", async () => {
    const item = { id: "phone-used", number: "+12025550130", status: "used", submittedAt: "2026-01-01T00:00:00.000Z" };
    let drives = 0;
    const immutablePool = {
      claimForAccount: () => ({ item, leaseId: "", reused: true, alreadyUsed: true, readOnly: true }),
      confirmUsed: () => { throw new Error("used 复核不能拿空 lease 再确认"); },
      markPending: () => { throw new Error("used 复核不能改 pending"); },
      markFailed: () => { throw new Error("used 复核不能改 failed"); },
      release: () => { throw new Error("used 复核不能 release"); },
    };
    const verified = await addPhone({}, { id: "used-account", email: "used@example.com" }, {
      phonePool: immutablePool,
      drivePhoneFlow: async (_page, _account, _number, flowCtx) => {
        drives += 1;
        assert.strictEqual(flowCtx.alreadySubmitted, true);
        assert.strictEqual(flowCtx.readOnly, true);
        return { kind: "already_present", submitted: false, explicitSuccess: true };
      },
    });
    assert.strictEqual(drives, 1, "used 记录不能在打开页面前直接返回成功");
    assert.strictEqual(verified.outcome, "ok");
    assert.strictEqual(verified.statusPatch.phone, "ok");

    const unconfirmed = await addPhone({}, { id: "used-account", email: "used@example.com" }, {
      phonePool: immutablePool,
      drivePhoneFlow: async () => ({ kind: "code_required", submitted: true, detail: "列表没有目标号码" }),
    });
    assert.notStrictEqual(unconfirmed.outcome, "ok");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(unconfirmed.statusPatch || {}, "phone"), false);
    assert.strictEqual(unconfirmed.keepOpen, true);
    assert.strictEqual(unconfirmed.handoff, true);
  });

  await checkAsync("短信验证码页只记 pending 并强制保留窗口，不填 TOTP/不误报成功", async () => {
    let inspectCalls = 0;
    let fills = 0;
    let sends = 0;
    let pendingMarks = 0;
    const snapshots = [
      { explicitSuccess: false, hasPhoneInput: true },
      { explicitSuccess: false, hasPhoneInput: true },
      { explicitSuccess: false, hasPhoneInput: true },
      { explicitSuccess: false, hasPhoneInput: false, hasCodeInput: true, verificationPrompt: true },
    ];
    const page = {
      url: () => "https://myaccount.google.com/two-step-verification/phone-numbers?hl=en",
      evaluate: async () => "",
    };
    const flow = await addPhone._internals.drivePhoneFlow(
      page,
      { id: "acc-code", email: "code@example.com", totpSecret: "SHOULD_NOT_BE_USED" },
      "+12025550125",
      {
        manualCodeWaitMs: 0,
        onSmsRequested: async () => { pendingMarks += 1; },
        emit: () => {},
      },
      {
        navigate: async () => ({ ok: true }),
        inspect: async () => snapshots[Math.min(inspectCalls++, snapshots.length - 1)],
        fillPhone: async () => { fills += 1; return true; },
        clickSend: async () => { sends += 1; return true; },
        clickAdd: async () => { throw new Error("已有输入框时不应点 Add"); },
        sleep: async () => {},
        now: (() => { let value = 0; return () => ++value; })(),
      },
    );
    assert.strictEqual(flow.kind, "code_required");
    assert.strictEqual(flow.explicitSuccess, undefined);
    assert.strictEqual(flow.submitted, true);
    assert.strictEqual(fills, 1, "手机号只填一次");
    assert.strictEqual(sends, 1, "发送短信只点一次");
    assert.strictEqual(pendingMarks, 1, "发送动作发出后必须立即锁定 pending");

    const item = { id: "phone-code", number: "+12025550125", status: "reserved", submittedAt: "" };
    const pool = {
      claimForAccount: () => ({ item, leaseId: "lease-code", reused: false, alreadyUsed: false }),
      markPending: () => { item.status = "pending"; item.submittedAt = new Date().toISOString(); return item; },
      confirmUsed: () => { throw new Error("验证码页绝不能标 used"); },
      markFailed: () => null,
      release: () => { throw new Error("短信已发后绝不能释放"); },
      getById: () => item,
    };
    const result = await addPhone(page, { id: "acc-code", email: "code@example.com" }, {
      phonePool: pool,
      drivePhoneFlow: async (_page, _account, _number, flowCtx) => {
        await flowCtx.onSmsRequested();
        return { kind: "code_required", submitted: true, codePromptVisible: true, detail: "等待短信验证码" };
      },
    });
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "sms_code_required");
    assert.strictEqual(result.statusPatch.phone, "pending");
    assert.strictEqual(result.keepOpen, true);
    assert.strictEqual(result.handoff, true);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(item.status, "pending");
  });

  await checkAsync("pending 的第二 runner 只读复查，任何非成功结果都不得改池或重发", async () => {
    const item = { id: "phone-review", number: "+12025550130", status: "pending", submittedAt: new Date().toISOString() };
    const calls = { pending: 0, failed: 0, released: 0, used: 0 };
    let sawReadOnly = false;
    const pool = {
      claimForAccount: () => ({ item, leaseId: "lease-review", reused: true, alreadyUsed: false, readOnly: true }),
      markPending: () => { calls.pending += 1; return item; },
      markFailed: () => { calls.failed += 1; return item; },
      release: () => { calls.released += 1; return item; },
      confirmUsed: () => { calls.used += 1; return item; },
      getById: () => item,
    };
    const result = await addPhone({}, { id: "acc-review", email: "review@example.com" }, {
      phonePool: pool,
      drivePhoneFlow: async (_page, _account, _number, flowCtx) => {
        sawReadOnly = flowCtx.readOnly === true && flowCtx.alreadySubmitted === true;
        return { kind: "rejected", submitted: true, explicitSuccess: false, detail: "只读页面未确认" };
      },
    });
    assert.strictEqual(sawReadOnly, true);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.statusPatch.phone, "pending");
    assert.deepStrictEqual(calls, { pending: 0, failed: 0, released: 0, used: 0 });
  });

  await checkAsync("添加手机号仅凭明确列表/成功证据才标 used；提交前失败会释放", async () => {
    const makePool = () => {
      const item = { id: "phone-flow", number: "+12025550126", status: "reserved", submittedAt: "" };
      const calls = { used: 0, released: 0, failed: 0 };
      return {
        item,
        calls,
        claimForAccount: () => ({ item, leaseId: "lease-flow", reused: false, alreadyUsed: false }),
        markPending: () => { item.status = "pending"; return item; },
        confirmUsed: () => { calls.used += 1; item.status = "used"; return item; },
        markFailed: () => { calls.failed += 1; item.status = "failed"; return item; },
        release: () => { calls.released += 1; item.status = "unused"; return item; },
        getById: () => item,
      };
    };

    const successPool = makePool();
    const success = await addPhone({}, { id: "acc-ok", email: "ok@example.com" }, {
      phonePool: successPool,
      drivePhoneFlow: async () => ({ kind: "added", submitted: true, explicitSuccess: true }),
    });
    assert.strictEqual(success.outcome, "ok");
    assert.strictEqual(success.statusPatch.phone, "ok");
    assert.strictEqual(successPool.calls.used, 1);

    const uncertainPool = makePool();
    const uncertain = await addPhone({}, { id: "acc-uncertain", email: "uncertain@example.com" }, {
      phonePool: uncertainPool,
      drivePhoneFlow: async () => ({ kind: "timeout", submitted: true, explicitSuccess: false }),
    });
    assert.strictEqual(uncertain.outcome, "need_verify");
    assert.strictEqual(uncertainPool.calls.used, 0, "超时不能猜成功");
    assert.strictEqual(uncertainPool.item.status, "pending");

    const beforePool = makePool();
    const before = await addPhone({}, { id: "acc-before", email: "before@example.com" }, {
      phonePool: beforePool,
      drivePhoneFlow: async () => ({ kind: "before_submit_failure", submitted: false, detail: "没找到输入框" }),
    });
    assert.strictEqual(before.outcome, "error");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(before, "statusPatch"), false, "提交前页面失败不能覆盖账号原有验证电话状态");
    assert.strictEqual(beforePool.calls.released, 1);
    assert.strictEqual(beforePool.item.status, "unused");

    const blockerPool = makePool();
    const blocked = await addPhone({}, { id: "acc-blocked", email: "blocked@example.com" }, {
      phonePool: blockerPool,
      drivePhoneFlow: async () => ({ kind: "blocked", submitted: false, detail: "Google 要求人机验证" }),
    });
    assert.strictEqual(blocked.outcome, "need_verify");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(blocked, "statusPatch"), false);
    assert.strictEqual(blocked.keepOpen, true, "人机验证页应保留给用户自行处理");
    assert.strictEqual(blocked.handoff, true);
    assert.strictEqual(blockerPool.calls.released, 1, "验证码尚未提交时号码应安全释放");
  });

  await checkAsync("仅验证密码不要求账号存在 2FA 密钥", async () => {
    let passwordOnly = false;
    const result = await login.checkPassword({}, { email: "demo@example.com", password: "pw123", totpSecret: "" }, {
      openLoginPage: async (page) => ({ page, error: null }),
      driveAuthFlow: async (_page, _account, _emit, opts) => {
        passwordOnly = opts.passwordOnly === true;
        return { outcome: "ok", reasonCode: "password_correct", detail: { password: "密码正确" } };
      },
    });
    assert.strictEqual(passwordOnly, true);
    assert.strictEqual(result.reasonCode, "password_correct");
    assert.strictEqual(result.stop, true);
  });

  await checkAsync("仅验证密码：提交一次后到 2FA 立即判正确且不继续操作", async () => {
    const { submitPasswordCheck } = login.helpers;
    let currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd?TL=test";
    let clicks = 0;
    const page = { url: () => currentUrl };
    const result = await submitPasswordCheck(page, currentUrl, ["input[name='Passwd']"], "pw123", {
      ensureValue: async () => true,
      clickNext: async () => {
        clicks += 1;
        currentUrl = "https://accounts.google.com/v3/signin/challenge/totp?TL=test";
        return true;
      },
      bodyText: async () => "两步验证 输入 Google 身份验证器应用中的验证码",
      sleep: async () => {},
      totalMs: 50,
      pollMs: 0,
    });
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "password_correct");
    assert.strictEqual(clicks, 1, "密码页下一步只能点击一次");
    assert.match(result.detail.password, /未继续两步验证/);
  });

  await checkAsync("仅验证密码：passwordNext 点击触发导航异常后绝不尝试第二次", async () => {
    const { submitPasswordOnce } = login.helpers;
    let clicks = 0;
    let presses = 0;
    let lookups = 0;
    const button = {
      evaluate: async () => true,
      click: async () => { clicks += 1; throw new Error("Execution context was destroyed"); },
      press: async () => { presses += 1; },
      dispose: async () => {},
    };
    const page = {
      $: async () => { lookups += 1; return button; },
    };
    const submission = await submitPasswordOnce(page, ["input[name='Passwd']"]);
    assert.strictEqual(submission.attempted, true);
    assert.strictEqual(submission.confirmed, false, "导航异常时提交状态应标为不确定，不能据此报密码正确");
    assert.strictEqual(clicks, 1, "即使导航令 click 抛错，也只能发起一次点击");
    assert.strictEqual(presses, 0, "点击后绝不能再按 Enter");
    assert.strictEqual(lookups, 1, "点击后绝不能去后续页面再次查找按钮或输入框");
  });

  await checkAsync("仅验证密码：提交状态不确定时即使跳到 My Account 也不误报正确", async () => {
    const { submitPasswordCheck } = login.helpers;
    let currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd?TL=test";
    const result = await submitPasswordCheck({ url: () => currentUrl }, currentUrl, ["input[name='Passwd']"], "pw123", {
      ensureValue: async () => true,
      submitOnce: async () => {
        currentUrl = "https://myaccount.google.com/";
        return { attempted: true, confirmed: false };
      },
      bodyText: async () => "Google Account",
      sleep: async () => {},
      totalMs: 50,
      pollMs: 0,
    });
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "other");
    assert.match(result.detail.password, /无法可靠确认/);
  });

  await checkAsync("仅验证密码：错误或已更改都只提交一次并给出精确原因", async () => {
    const { submitPasswordCheck } = login.helpers;
    for (const [body, expected] of [["Wrong password. Try again.", "password_wrong"], ["Your password was changed 6 days ago", "password_changed"]]) {
      const currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd?TL=test";
      let clicks = 0;
      const result = await submitPasswordCheck({ url: () => currentUrl }, currentUrl, ["input[name='Passwd']"], "bad-pw", {
        ensureValue: async () => true,
        clickNext: async () => { clicks += 1; return true; },
        bodyText: async () => body,
        sleep: async () => {},
        totalMs: 50,
        pollMs: 0,
      });
      assert.strictEqual(result.outcome, "error");
      assert.strictEqual(result.reasonCode, expected);
      if (expected === "password_changed") assert.strictEqual(result.daysAgo, 6, "应保留 Google 返回的密码更改天数");
      assert.strictEqual(clicks, 1, `${expected} 不得重复提交密码`);
    }
  });

  await checkAsync("仅验证密码：人机验证只写无法确认，不误报密码正确或错误", async () => {
    const { submitPasswordCheck } = login.helpers;
    let currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd?TL=test";
    let clicks = 0;
    const result = await submitPasswordCheck({ url: () => currentUrl }, currentUrl, ["input[name='Passwd']"], "pw123", {
      ensureValue: async () => true,
      clickNext: async () => {
        clicks += 1;
        currentUrl = "https://accounts.google.com/v3/signin/challenge/recaptcha?TL=test";
        return true;
      },
      bodyText: async () => "请完成 reCAPTCHA，证明您不是自动程序",
      sleep: async () => {},
      totalMs: 50,
      pollMs: 0,
    });
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(login.helpers.inferLoginReasonCode(result), "captcha");
    assert.strictEqual(clicks, 1);
  });

  await checkAsync("仅验证密码：成功页的密码历史文案不能误判为密码已更改", async () => {
    const { submitPasswordCheck } = login.helpers;
    let currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd?TL=test";
    const result = await submitPasswordCheck({ url: () => currentUrl }, currentUrl, ["input[name='Passwd']"], "pw123", {
      ensureValue: async () => true,
      submitOnce: async () => {
        currentUrl = "https://myaccount.google.com/security";
        return true;
      },
      bodyText: async () => "Security Your password was changed 6 days ago",
      sleep: async () => {},
      totalMs: 50,
      pollMs: 0,
    });
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "password_correct");
  });

  await checkAsync("IPP URL 即使残留 password/tel 也会快速失败且不写入", async () => {
    let interacted = false;
    const residualHandle = {
      evaluate: async () => true,
      dispose: async () => {},
      click: async () => { interacted = true; },
      type: async () => { interacted = true; },
    };
    const page = {
      url: () => "https://accounts.google.com/v3/signin/challenge/ipp/consent?TL=xxx",
      evaluate: async () => "Verify it’s you Get a verification code Google will send a verification code Send More ways to verify",
      $: async () => residualHandle,
    };
    const result = await login.helpers.driveAuthFlow(
      page,
      { email: "demo@example.com", password: "must-not-be-written", totpSecret: "JBSWY3DPEHPK3PXP" },
      () => {},
      { label: "test", isDone: () => false },
    );
    assert.strictEqual(result.outcome, "need_verify");
    assert.match(Object.values(result.detail).join(" "), /短信验证/);
    assert.strictEqual(interacted, false, "不得点击或写入 SPA 残留输入框");
  });

  await checkAsync("selection URL 先出现时会等待身份验证器选项 hydration", async () => {
    let bodyReads = 0;
    const page = {
      url: () => "https://accounts.google.com/v3/signin/challenge/selection?TL=xxx",
      evaluate: async () => {
        bodyReads += 1;
        return bodyReads >= 3 ? "从 Google 身份验证器应用获取验证码" : "";
      },
    };
    assert.strictEqual(await login.helpers.waitForAuthMethodList(page, 1200), true);
    assert.ok(bodyReads >= 3, "不能一看到 selection URL 就立即返回，必须等选项 DOM 出现");
  });

  await checkAsync("身份验证器物理点击未推进时会校验状态并回退点击", async () => {
    let state = "selection";
    const targetHandle = {
      asElement: () => targetHandle,
      evaluate: async () => true,
      click: async () => true, // 模拟 CDP 点击成功返回，但 Google SPA 没有接受，URL 保持 selection。
      boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 40 }),
      dispose: async () => {},
    };
    const inputHandle = { evaluate: async () => true, dispose: async () => {} };
    const page = {
      url: () => `https://accounts.google.com/v3/signin/challenge/${state}?TL=xxx`,
      evaluateHandle: async () => targetHandle,
      evaluate: async (_fn, arg) => {
        if (Array.isArray(arg)) {
          state = "totp"; // DOM click 兜底真正推进。
          return true;
        }
        return state === "totp" ? "输入 Google 身份验证器应用中的验证码" : "选择验证方式";
      },
      $: async () => inputHandle, // selection 上也模拟一个残留 tel；URL 后置条件必须把它排除。
      mouse: { click: async () => {} },
    };
    assert.strictEqual(await login.helpers.chooseAuthenticatorMethod(page, 80), true);
    assert.strictEqual(state, "totp", "只有真正进入 challenge/totp 才能报告选择成功");
  });

  await checkAsync("设备通知页能点击 jsaction 外层并选择身份验证器", async () => {
    let state = "prompt";
    const makeNode = (text, opts = {}) => {
      const node = {
        textContent: text,
        tagName: opts.tagName || "DIV",
        disabled: false,
        offsetWidth: opts.width || 240,
        offsetHeight: opts.height || 48,
        getAttribute: (name) => (opts.attrs && Object.prototype.hasOwnProperty.call(opts.attrs, name) ? opts.attrs[name] : null),
        getBoundingClientRect: () => ({ x: 0, y: 0, width: opts.width || 240, height: opts.height || 48 }),
        closest(selector) {
          if (selector === "[hidden], [inert]") return null;
          return opts.parent || node;
        },
        scrollIntoView: () => {},
        click: () => { if (opts.onClick) opts.onClick(); },
      };
      return node;
    };

    const currentNodes = () => {
      if (state === "prompt") {
        const parent = makeNode("试试其他方式", {
          attrs: { jsaction: "click:tryAnother", tabindex: "0" },
          onClick: () => { state = "selection"; },
        });
        const leaf = makeNode("试试其他方式", { tagName: "SPAN", parent, width: 112, height: 28 });
        return [parent, leaf];
      }
      if (state === "selection") {
        const parent = makeNode("从 Google 身份验证器应用获取验证码", {
          attrs: { "data-challengetype": "6", jsaction: "click:selectChallenge", tabindex: "0" },
          onClick: () => { state = "totp"; },
        });
        const leaf = makeNode("从 Google 身份验证器应用获取验证码", { tagName: "SPAN", parent, width: 220, height: 28 });
        return [parent, leaf];
      }
      return [];
    };

    const runInFakeDom = (fn, arg) => {
      const oldDocument = global.document;
      const oldGetComputedStyle = global.getComputedStyle;
      global.document = {
        body: { get innerText() { return currentNodes().map((n) => n.textContent).join(" "); } },
        querySelectorAll: () => currentNodes(),
      };
      global.getComputedStyle = () => ({ display: "block", visibility: "visible", pointerEvents: "auto" });
      try { return fn(arg); } finally {
        global.document = oldDocument;
        global.getComputedStyle = oldGetComputedStyle;
      }
    };

    const page = {
      url: () => `https://accounts.google.com/v3/signin/challenge/${state === "selection" ? "selection" : state === "totp" ? "totp" : "dp"}?TL=xxx`,
      evaluate: async (fn, arg) => runInFakeDom(fn, arg),
      evaluateHandle: async (fn, arg) => {
        const target = runInFakeDom(fn, arg);
        const handle = {
          asElement: () => (target ? handle : null),
          evaluate: async (cb) => cb(target),
          click: async () => target.click(),
          boundingBox: async () => target.getBoundingClientRect(),
          dispose: async () => {},
        };
        return handle;
      },
      mouse: { click: async () => {} },
    };

    assert.strictEqual(await login.helpers.openAlternativeMethods(page), true);
    assert.strictEqual(state, "selection", "应从设备通知页真正进入验证方式列表");
    assert.strictEqual(await login.helpers.hasAuthenticatorOption(page), true);
    assert.strictEqual(await login.helpers.realClickByText(page, login.helpers.AUTH_OPTION_RE.source), true);
    assert.strictEqual(state, "totp", "应点击身份验证器选项进入 challenge/totp");
  });

  await checkAsync("challenge 首轮空 DOM 会等待 hydration 后走 Prompt→身份验证器", async () => {
    let state = "dp";
    let dpBodyReads = 0;
    const promptText = "两步验证 查看您的 Vivo X100 Pro Google 已向您的 Vivo X100 Pro 发送了通知 在通知中点按是 然后在您的手机上点按 1 试试其他方式";
    const authText = "选择您想要使用的登录方式 从 Google 身份验证器应用获取验证码";
    const totpText = "输入 Google 身份验证器应用中的验证码";
    const inputHandle = { evaluate: async () => true, dispose: async () => {} };
    const emptyHandle = { asElement: () => null, dispose: async () => {} };
    const clickableHandle = {
      asElement: () => clickableHandle,
      evaluate: async () => true,
      click: async () => {
        if (state === "dp") state = "selection";
        else if (state === "selection") state = "totp";
      },
      boundingBox: async () => ({ x: 0, y: 0, width: 220, height: 42 }),
      dispose: async () => {},
    };
    const page = {
      url: () => `https://accounts.google.com/v3/signin/challenge/${state}?TL=xxx`,
      evaluateHandle: async () => (state === "dp" && dpBodyReads <= 2 ? emptyHandle : clickableHandle),
      evaluate: async (_fn, arg) => {
        if (typeof arg === "string") return state === "selection";
        if (Array.isArray(arg)) return false;
        if (state === "dp") {
          dpBodyReads += 1;
          return dpBodyReads <= 2 ? "" : promptText;
        }
        if (state === "selection") return authText;
        return totpText;
      },
      $: async () => (state === "totp" ? inputHandle : null),
      mouse: { click: async () => {} },
    };
    const result = await login.helpers.driveAuthFlow(
      page,
      { email: "demo@example.com", password: "pw", totpSecret: "JBSWY3DPEHPK3PXP" },
      () => {},
      { label: "test", isDone: (_host, pathName) => pathName.includes("/challenge/totp") },
    );
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(state, "totp");
    assert.ok(dpBodyReads >= 3, "应等待空 challenge 页面完成 hydration，而非首轮退出");
  });

  await checkAsync("fillTotp 在 g.co/sc 安全代码页不会输入账号 TOTP", async () => {
    let typed = false;
    const handle = {
      evaluate: async () => true,
      dispose: async () => {},
      click: async () => { typed = true; },
      type: async () => { typed = true; },
    };
    const securityText = "获取验证码以进行登录 要获取您的验证码，请在新的浏览器窗口中前往 g.co/sc 输入验证码";
    const fakePage = {
      url: () => "https://accounts.google.com/v3/signin/challenge/ootp?TL=xxx",
      evaluate: async () => securityText,
      $: async () => handle,
    };
    const result = await login.helpers.fillTotp(fakePage, "JBSWY3DPEHPK3PXP");
    assert.strictEqual(result, false);
    assert.strictEqual(typed, false, "安全代码输入框不得收到任何 TOTP 输入或点击");
  });

  await checkAsync("本机浏览器冷启动会等到 WebSocket 地址出现后再放行", async () => {
    let probes = 0;
    const server = http.createServer((req, res) => {
      if (req.url !== "/json/version") { res.writeHead(404).end(); return; }
      probes += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(probes === 1
        ? { Browser: "Chrome/151" }
        : { Browser: "Chrome/151", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test-id" }));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = server.address().port;
      const version = await localBrowser.helpers.waitForDevtools(port, 2000);
      assert.ok(version && version.webSocketDebuggerUrl, "应等到 WebSocket 地址出现");
      assert.strictEqual(probes, 2, "仅 Browser 的第一次响应必须继续轮询");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await checkAsync("本机浏览器首次接管失败会在同一进程短退避重试", async () => {
    const env = { serial: "本地#1", local: null };
    const launched = {
      cdpEndpoint: "http://127.0.0.1:10001",
      port: 10001,
      executablePath: "chrome.exe",
      stop: async () => { throw new Error("成功接管前不应关闭浏览器"); },
    };
    let starts = 0;
    let connects = 0;
    const delays = [];
    const session = { page: {} };
    const opened = await engine.helpers.openLocalSession(
      { env, emit: () => {}, clearData: true },
      {
        start: async () => { starts += 1; return launched; },
        connect: async () => {
          connects += 1;
          if (connects === 1) throw new Error("Invalid URL: undefined");
          return session;
        },
        sleep: async (ms) => { delays.push(ms); },
        launchAttempts: 2,
        connectAttempts: 3,
      },
    );
    assert.strictEqual(starts, 1, "短暂接管失败不应立刻重启 Chrome");
    assert.strictEqual(connects, 2);
    assert.deepStrictEqual(delays, [250]);
    assert.strictEqual(opened.local, launched);
    assert.strictEqual(opened.session, session);
    assert.strictEqual(env.local, launched);
  });

  await checkAsync("同一进程接管仍失败时会清理并重启一次", async () => {
    const env = { serial: "本地#1", local: null };
    const stopped = [];
    let starts = 0;
    const makeLocal = (id) => ({
      id,
      cdpEndpoint: `http://127.0.0.1:${11000 + id}`,
      port: 11000 + id,
      executablePath: "chrome.exe",
      stop: async () => { stopped.push(id); },
    });
    const session = { page: {} };
    const opened = await engine.helpers.openLocalSession(
      { env, emit: () => {} },
      {
        start: async () => { starts += 1; return makeLocal(starts); },
        connect: async (endpoint) => {
          if (endpoint.endsWith(":11001")) throw new Error("Target.createTarget is not ready");
          return session;
        },
        sleep: async () => {},
        launchAttempts: 2,
        connectAttempts: 2,
      },
    );
    assert.strictEqual(starts, 2);
    assert.deepStrictEqual(stopped, [1], "失败的第一进程必须先关闭并清理");
    assert.strictEqual(opened.local.id, 2);
    assert.strictEqual(opened.session, session);
    assert.strictEqual(env.local.id, 2);
  });

  accounts.flush();
  cleanupTestData();
  console.log(`\n${passed} 项通过`);
})();
