"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pure storage/render fixtures. No browser, server, Google page or paid provider is used.
const WHEN = "2026-09-26T00:00:00.000Z";
const REASONS = [
  ["phone_add_required", "需添加手机号"],
  ["phone_verification_required", "需手机短信验证"],
  ["captcha_phone_add_required", "人机后需添加手机号"],
  ["captcha_phone_verification_required", "人机后需手机验证"],
];

module.exports = function runPhoneBlockerUiStorageTests({ check, accounts }) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const extract = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
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
    `${extract("const STATUS_FIELD_LABEL", "function editCell")}
    return statusCell;`)(
    { login: ["unknown", "ok", "2fa_error", "need_verify", "failed"] },
    { unknown: "未检测", ok: "正常", "2fa_error": "2FA密钥错", need_verify: "待人工", failed: "失败" },
    { unknown: "s-unknown", ok: "s-ok", "2fa_error": "s-bad", need_verify: "s-bad", failed: "s-bad" },
    reasonUi.loginCheckResultText,
    escapeHtml,
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

  const created = [];
  try {
    check("手机号登录阻断原因：只进入完整登录白名单并原样持久化", () => {
      const email = `__phone_blocker_${Date.now()}@example.com`;
      accounts.importText(`${email}|fixture-password`);
      const account = accounts.list().find((item) => item.email === email);
      assert.ok(account);
      created.push(account.id);
      accounts.update(account.id, {
        lastPasswordCheck: { reasonCode: "password_correct", outcome: "ok", detail: "fixture", checkedAt: WHEN },
      });

      for (const [reasonCode] of REASONS) {
        assert.strictEqual(accounts.LOGIN_REASON_CODES.has(reasonCode), true);
        accounts.update(account.id, {
          status: { login: "need_verify" },
          lastLoginCheck: { reasonCode, outcome: "need_verify", detail: "fixture phone blocker", checkedAt: WHEN },
        });
        accounts.flush();
        const saved = JSON.parse(fs.readFileSync(accounts._db.file, "utf8")).accounts
          .find((item) => item.id === account.id);
        assert.strictEqual(saved.status.login, "need_verify");
        assert.strictEqual(saved.lastLoginCheck.reasonCode, reasonCode);
        assert.strictEqual(saved.lastLoginCheck.outcome, "need_verify");
        assert.strictEqual(saved.lastPasswordCheck.reasonCode, "password_correct",
          "完整登录的手机阻断原因不能污染独立密码检测");
      }

      accounts.update(account.id, {
        lastPasswordCheck: { reasonCode: "phone_add_required", outcome: "need_verify", detail: "fixture", checkedAt: WHEN },
      });
      assert.strictEqual(account.lastPasswordCheck.reasonCode, "other",
        "手机阻断原因不能进入仅验证密码白名单");
      assert.strictEqual(account.lastLoginCheck.reasonCode, "captcha_phone_verification_required");
      assert.strictEqual(account.status.login, "need_verify");
    });

    check("手机号登录阻断原因：账号行、任务日志和导出均显示明确红色原因", () => {
      const normal = {
        id: "fixture-account", email: "fixture@example.com", password: "pw", recoveryEmail: "",
        totpSecret: "KEY", year: "2026", country: "US", status: { login: "need_verify" },
      };
      const tasks = [];
      for (const [reasonCode, label] of REASONS) {
        assert.strictEqual(reasonUi.LOGIN_REASON_TEXT[reasonCode], label);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(reasonUi.PASSWORD_CHECK_REASON_TEXT, reasonCode), false,
          "密码检测文案不能复用完整登录的手机阻断原因");
        const checkResult = { reasonCode, outcome: "need_verify", detail: { login: "fixture detail" } };
        assert.strictEqual(reasonUi.loginCheckResultText(checkResult), label);

        const account = { ...normal, lastLoginCheck: checkResult };
        const rowHtml = statusCell(account, "login");
        assert.ok(rowHtml.includes('class="st s-bad"'));
        assert.ok(rowHtml.includes(`<option value="need_verify" selected>${label}</option>`));
        assert.ok(rowHtml.includes(`title="登录（${label}）`));
        assert.strictEqual(exportUi.exportWarningText(account), label);
        assert.ok(exportUi.fmtAccount(account).endsWith(`----${label}`));

        tasks.push({
          email: `${reasonCode}@example.com`, status: "done",
          results: [{ action: "login", outcome: "need_verify", reasonCode, detail: { login: "fixture detail" } }],
        });
      }
      renderJob({ status: "done", tasks });
      for (const [, label] of REASONS) assert.ok(board.innerHTML.includes(`登录：${label}`));
      assert.strictEqual((board.innerHTML.match(/out-need_verify/g) || []).length, REASONS.length);
      assert.strictEqual((board.innerHTML.match(/needs-attn/g) || []).length, REASONS.length);
    });
  } finally {
    accounts.remove(created);
    accounts.flush();
  }
};

if (require.main === module) {
  const os = require("os");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-manager-phone-blocker-test-"));
  process.env.ACCOUNT_MANAGER_DATA_DIR = dataDir;
  const accounts = require("../src/accounts");
  let passed = 0;
  const check = (name, fn) => { fn(); passed += 1; console.log(`ok ${name}`); };
  try {
    module.exports({ check, accounts });
    console.log(`${passed} 项通过`);
  } catch (err) {
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    accounts.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
