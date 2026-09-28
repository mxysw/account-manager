"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");

const REASON = "captcha_detection_failed";
const WHEN = "2026-09-28T00:00:00.000Z";

// Load a fresh account store against the explicit fixture directory. Do not
// change process.env, require.cache, or open the application's account store.
function loadFixtureAccounts(directory) {
  const filename = path.join(__dirname, "../src/accounts.js");
  const fixtureModule = { exports: {} };
  new Function("require", "module", "__dirname", "process", fs.readFileSync(filename, "utf8"))(
    createRequire(filename), fixtureModule, path.dirname(filename),
    { env: { ACCOUNT_MANAGER_DATA_DIR: directory } },
  );
  assert.strictEqual(fixtureModule.exports._db.file, path.join(directory, "accounts.json"));
  return fixtureModule.exports;
}

function renderingFixture() {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const extract = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `missing UI section: ${start}`);
    return source.slice(first, last);
  };
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const reasonUi = new Function(`${extract("const LOGIN_REASON_TEXT", "const STATUS_OPTIONS")}
    return { LOGIN_REASON_TEXT, PASSWORD_CHECK_REASON_TEXT, loginCheckResultText, passwordCheckResultText };`)();
  const cloudPhoneResultText = new Function(`${extract("function cloudPhoneResultText(", "function cloudPhoneStateOf(")}
    return cloudPhoneResultText;`)();
  const exportUi = new Function("LOGIN_REASON_TEXT", "passwordCheckResultText", "loginCheckResultText", "cloudPhoneResultText",
    `${extract("const EXPORT_STATUS_WARNING_TEXT", "let toastTimer")}
    return { fmtAccount, exportWarningText };`)(
    reasonUi.LOGIN_REASON_TEXT, reasonUi.passwordCheckResultText, reasonUi.loginCheckResultText, cloudPhoneResultText,
  );
  const statusCell = new Function("STATUS_OPTIONS", "STATUS_TEXT", "STATUS_CLASS", "loginCheckResultText", "escapeHtml",
    `${extract("const STATUS_FIELD_LABEL", "function editCell")}\nreturn statusCell;`)(
    { login: ["unknown", "ok", "2fa_error", "need_verify", "failed"] },
    { unknown: "未检测", ok: "正常", "2fa_error": "2FA密钥错", need_verify: "待人工", failed: "失败" },
    { unknown: "s-unknown", ok: "s-ok", "2fa_error": "s-bad", need_verify: "s-bad", failed: "s-bad" },
    reasonUi.loginCheckResultText, escapeHtml,
  );
  const board = { innerHTML: "" };
  const renderJob = new Function("el", "loadJobOnlyAbnormal", "escapeHtml", "cloudPhoneResultText",
    "passwordCheckResultText", "loginCheckResultText", "totpSetupResultText",
    `let lastJob = null; const jobManualExpand = new Map();
    ${extract("const ATTENTION_DETAIL_KEYWORDS =", "function clearJobBoard()")}
    return renderJob;`)(
    () => board, () => false, escapeHtml, cloudPhoneResultText, reasonUi.passwordCheckResultText,
    reasonUi.loginCheckResultText, () => "",
  );
  return { ...reasonUi, ...exportUi, statusCell, board, renderJob };
}

module.exports = async function run({ checkAsync }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "account-manager-captcha-detection-test-"));
  const stores = [];
  try {
    const accounts = loadFixtureAccounts(directory);
    stores.push(accounts);
    accounts.importText("detection-fixture@example.com|fixture-password");
    const account = accounts.list()[0];
    const checkResult = { reasonCode: REASON, outcome: "error", detail: "页面检测异常，尚未确认验证控件", checkedAt: WHEN };

    await checkAsync("人机检测异常：精确原因持久化并可重载，不污染独立密码结论", async () => {
      accounts.update(account.id, {
        lastPasswordCheck: { reasonCode: "password_correct", outcome: "ok", detail: "fixture", checkedAt: WHEN },
      });
      accounts.update(account.id, { status: { login: "unknown" }, lastLoginCheck: checkResult });
      accounts.flush();
      const saved = JSON.parse(fs.readFileSync(accounts._db.file, "utf8")).accounts[0];
      assert.strictEqual(accounts.LOGIN_REASON_CODES.has(REASON), true);
      assert.strictEqual(saved.lastLoginCheck.reasonCode, REASON);
      assert.strictEqual(saved.lastLoginCheck.outcome, "error");
      assert.strictEqual(saved.status.login, "unknown");
      assert.strictEqual(saved.lastPasswordCheck.reasonCode, "password_correct");
      const reloaded = loadFixtureAccounts(directory);
      stores.push(reloaded);
      assert.strictEqual(reloaded.getById(account.id).lastLoginCheck.reasonCode, REASON);
      reloaded.update(account.id, { lastPasswordCheck: { ...checkResult } });
      assert.strictEqual(reloaded.getById(account.id).lastPasswordCheck.reasonCode, "other",
        "仅用于完整登录的检测诊断不能扩充密码检测白名单");
      reloaded.flush();
    });

    await checkAsync("人机检测异常：账号行、日志和复制导出均写检测异常，不写人机验证", async () => {
      const ui = renderingFixture();
      assert.strictEqual(ui.LOGIN_REASON_TEXT[REASON], "检测异常");
      assert.strictEqual(Object.hasOwn(ui.PASSWORD_CHECK_REASON_TEXT, REASON), false);
      assert.strictEqual(ui.loginCheckResultText(checkResult), "检测异常");
      const row = ui.statusCell(account, "login");
      assert.ok(row.includes('<option value="unknown" selected>检测异常</option>'));
      assert.ok(row.includes('title="登录（检测异常）'));
      assert.ok(!row.includes("人机验证"));
      assert.strictEqual(ui.exportWarningText(account), "检测异常");
      assert.ok(ui.fmtAccount(account).endsWith("----检测异常"));
      ui.renderJob({ status: "done", tasks: [{
        email: account.email, status: "done", results: [{ action: "login", ...checkResult, detail: { login: checkResult.detail } }],
      }] });
      assert.ok(ui.board.innerHTML.includes("登录：检测异常"));
      assert.ok(ui.board.innerHTML.includes(checkResult.detail));
      assert.ok(!ui.board.innerHTML.includes("登录：人机验证"));
      assert.ok(!ui.board.innerHTML.includes("CAPSOLVER · 未完成"));
    });

    await checkAsync("人机检测异常：自动归位留在检测库，明确人机验证仍进入待人工", async () => {
      accounts.importText("confirmed-captcha-fixture@example.com|fixture-password");
      const confirmed = accounts.list().find((item) => item.email === "confirmed-captcha-fixture@example.com");
      accounts.update(confirmed.id, {
        status: { login: "need_verify" },
        lastLoginCheck: { ...checkResult, reasonCode: "captcha", outcome: "need_verify", detail: "已确认可见人机验证" },
      });
      const sorted = accounts.autoSort([account.id, confirmed.id]);
      assert.strictEqual(sorted.moved.failed, 0);
      assert.strictEqual(sorted.moved.needVerify, 1);
      assert.strictEqual(sorted.stayed, 1);
      const unchanged = accounts.getById(account.id);
      assert.strictEqual(unchanged.inFailed, false);
      assert.strictEqual(unchanged.inNeedVerify, false);
      assert.strictEqual(unchanged.status.login, "unknown");
      assert.strictEqual(unchanged.lastLoginCheck.reasonCode, REASON);
      assert.strictEqual(accounts.getById(confirmed.id).inNeedVerify, true);
    });
  } finally {
    for (const store of stores) store.flush();
    assert.strictEqual(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("account-manager-captcha-detection-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} 项通过；仅临时数据与渲染测试`))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
