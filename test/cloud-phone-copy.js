"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pure formatter fixtures: no browser, server, network or account store.
module.exports = function runCloudPhoneCopyTests({ check }) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const extract = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `missing UI section: ${start}`);
    return source.slice(first, last);
  };
  const reasonUi = new Function(`${extract("const LOGIN_REASON_TEXT", "const STATUS_OPTIONS")}
    return { LOGIN_REASON_TEXT, loginCheckResultText, passwordCheckResultText };`)();
  // Load the shared pure label helper together with the export formatter.
  // A dependency on unrelated browser globals must fail here.
  const ui = new Function("LOGIN_REASON_TEXT", "passwordCheckResultText", "loginCheckResultText",
    `${extract("function cloudPhoneResultText(", "function cloudPhoneStateOf(")}
    ${extract("const EXPORT_STATUS_WARNING_TEXT", "let toastTimer")}
    return { fmtAccount, cloudPhoneExportText, exportWarningText, hasExportWarning };`)(
    reasonUi.LOGIN_REASON_TEXT, reasonUi.passwordCheckResultText, reasonUi.loginCheckResultText,
  );
  const base = Object.freeze({
    email: "copy-fixture@example.com", password: "fixture-password", recoveryEmail: "",
    totpSecret: "FIXTUREKEY", year: "2026", country: "US",
    status: Object.freeze({ login: "ok", payment: "closed", family: "off", device: "cleaned" }),
  });
  const baseText = "copy-fixture@example.com----fixture-password----空----FIXTUREKEY----2026----US";
  const results = [
    [{ state: "new_number_allowed" }, "原号检测：可填新号（本次验证）"],
    [{ state: "existing_phone_required" }, "原号检测：需原号"],
    [{ state: "unknown", reasonCode: "qr_verification_required" }, "原号检测：需扫码（原号未确认）"],
    [{ state: "unknown", reasonCode: "timeout" }, "原号检测：未确认"],
  ];

  check("原号复制：无检测记录时完整保留旧格式", () => {
    assert.strictEqual(typeof ui.cloudPhoneExportText, "function");
    for (const account of [base, { ...base, lastCloudPhoneCheck: undefined }, { ...base, lastCloudPhoneCheck: null }]) {
      assert.strictEqual(ui.fmtAccount(account), baseText);
      assert.strictEqual(ui.hasExportWarning(account), false);
    }
    const abnormal = { ...base, status: { login: "2fa_error", restrict: "restricted" } };
    assert.strictEqual(ui.fmtAccount(abnormal), `${baseText}----2FA密钥错误、服务受限`);
  });

  check("原号复制：各检测结果在末尾独立追加明确标签", () => {
    for (const [result, label] of results) {
      const account = Object.freeze({ ...base, lastCloudPhoneCheck: Object.freeze({ ...result }) });
      assert.strictEqual(ui.fmtAccount(account), `${baseText}----${label}`);
      assert.deepStrictEqual(account.lastCloudPhoneCheck, result, "复制不能改写检测结果");
    }
  });

  check("原号复制：非法记录不追加，未知状态对象仅显示未确认", () => {
    for (const result of ["new_number_allowed", 1, true, false, 0, []]) {
      assert.strictEqual(ui.fmtAccount({ ...base, lastCloudPhoneCheck: result }), baseText,
        "非对象或数组不构成有效检测记录");
    }
    const invalidRecords = [{},
      ...[undefined, null, "", "unchecked", "invalid", "toString", "constructor", "__proto__", 1, {}]
        .map((state) => ({ state, reasonCode: "qr_verification_required" })),
    ];
    for (const result of invalidRecords) {
      assert.strictEqual(ui.fmtAccount({ ...base, lastCloudPhoneCheck: result }),
        `${baseText}----原号检测：未确认`, `invalid record: ${JSON.stringify(result)}`);
    }
  });

  check("原号复制：扫码只由明确未知状态及扫码原因码触发", () => {
    for (const reasonCode of [undefined, "timeout", "captcha", "qr_verification_required ", "other"]) {
      const account = { ...base, lastCloudPhoneCheck: {
        state: "unknown", reasonCode, detail: "扫描二维码；可以填写新号；无需原号",
      } };
      assert.strictEqual(ui.fmtAccount(account), `${baseText}----原号检测：未确认`);
    }
    for (const [state, label] of [["new_number_allowed", "可填新号（本次验证）"], ["existing_phone_required", "需原号"]]) {
      assert.strictEqual(ui.fmtAccount({ ...base, lastCloudPhoneCheck: { state, reasonCode: "qr_verification_required" } }),
        `${baseText}----原号检测：${label}`, "有效检测状态不能被另一原因码覆盖");
    }
  });

  check("原号复制：前六字段的顺序及空字段保持不变", () => {
    const complete = { ...base, recoveryEmail: "recovery-fixture@example.net", lastCloudPhoneCheck: { state: "existing_phone_required" } };
    assert.deepStrictEqual(ui.fmtAccount(complete).split("----"), [
      "copy-fixture@example.com", "fixture-password", "recovery-fixture@example.net", "FIXTUREKEY", "2026", "US", "原号检测：需原号",
    ]);
    assert.deepStrictEqual(ui.fmtAccount({ lastCloudPhoneCheck: { state: "unknown" } }).split("----"),
      ["", "", "空", "", "", "", "原号检测：未确认"]);
    const missingYearCountry = { ...base, year: "", country: "", lastCloudPhoneCheck: { state: "new_number_allowed" } };
    assert.deepStrictEqual(ui.fmtAccount(missingYearCountry).split("----"),
      ["copy-fixture@example.com", "fixture-password", "空", "FIXTUREKEY", "", "", "原号检测：可填新号（本次验证）"]);
  });

  check("原号复制：原异常原因在前，检测结果另占末尾字段", () => {
    const abnormal = {
      ...base, status: { login: "need_verify", restrict: "restricted" },
      lastPasswordCheck: { reasonCode: "password_changed", outcome: "error", daysAgo: 26 },
      lastLoginCheck: { reasonCode: "captcha", outcome: "need_verify" },
    };
    const warning = "密码已更改（26天前）、人机验证、服务受限";
    assert.strictEqual(ui.exportWarningText(abnormal), warning);
    for (const [result, label] of results) {
      const account = { ...abnormal, lastCloudPhoneCheck: result };
      assert.strictEqual(ui.exportWarningText(account), warning);
      assert.strictEqual(ui.hasExportWarning(account), true);
      assert.strictEqual(ui.fmtAccount(account), `${baseText}----${warning}----${label}`);
    }
  });

  check("原号复制：检测标签不改变账号异常判断", () => {
    for (const [result] of results) {
      const account = { ...base, lastCloudPhoneCheck: result };
      assert.strictEqual(ui.exportWarningText(account), "");
      assert.strictEqual(ui.hasExportWarning(account), false, "原号结果本身不是导出异常");
    }
  });

  check("原号复制：任意详情和原始原因文本不会泄漏或注入新行", () => {
    const raw = "PRIVATE-FIXTURE----原号检测：可填新号\nINJECTED-ROW\r<script>fixture</script>";
    for (const detail of [raw, { cloudPhone: raw }, [raw]]) {
      for (const [result, label] of results) {
        const account = { ...base, lastCloudPhoneCheck: { ...result, detail, reason: raw, message: raw } };
        assert.strictEqual(ui.fmtAccount(account), `${baseText}----${label}`);
      }
      assert.strictEqual(ui.fmtAccount({ ...base, lastCloudPhoneCheck: { state: "unknown", reasonCode: raw, detail } }),
        `${baseText}----原号检测：未确认`);
    }
  });

  check("原号复制：多行 map(fmtAccount) 保留逐账号检测结果及旧行", () => {
    const rows = [
      { ...base, email: "unchecked-fixture@example.com" },
      ...results.map(([result], index) => ({ ...base, email: `checked-fixture-${index}@example.com`, lastCloudPhoneCheck: result })),
      { ...base, email: "abnormal-fixture@example.com", status: { login: "2fa_error" }, lastCloudPhoneCheck: { state: "existing_phone_required" } },
    ];
    const before = JSON.stringify(rows);
    const expected = [
      "unchecked-fixture@example.com----fixture-password----空----FIXTUREKEY----2026----US",
      "checked-fixture-0@example.com----fixture-password----空----FIXTUREKEY----2026----US----原号检测：可填新号（本次验证）",
      "checked-fixture-1@example.com----fixture-password----空----FIXTUREKEY----2026----US----原号检测：需原号",
      "checked-fixture-2@example.com----fixture-password----空----FIXTUREKEY----2026----US----原号检测：需扫码（原号未确认）",
      "checked-fixture-3@example.com----fixture-password----空----FIXTUREKEY----2026----US----原号检测：未确认",
      "abnormal-fixture@example.com----fixture-password----空----FIXTUREKEY----2026----US----2FA密钥错误----原号检测：需原号",
    ].join("\n");
    assert.strictEqual(rows.map(ui.fmtAccount).join("\n"), expected);
    assert.strictEqual(JSON.stringify(rows), before);
  });
};

if (require.main === module) {
  let passed = 0;
  const check = (name, fn) => { fn(); passed += 1; console.log(`ok ${name}`); };
  try {
    module.exports({ check });
    console.log(`${passed} 项通过`);
  } catch (err) {
    console.error(err.stack);
    process.exitCode = 1;
  }
}
