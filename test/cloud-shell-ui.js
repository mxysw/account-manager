"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pure in-memory fixtures: no account store, browser, clipboard or network access.
module.exports = function runCloudShellUiTests({ check }) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const extract = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `missing UI section: ${start}`);
    return source.slice(first, last);
  };
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const board = { innerHTML: "" };
  let onlyAbnormal = false;
  const ui = new Function("escapeHtml", "fmtTime", "el", "loadJobOnlyAbnormal", "totpSetupResultText", `
    let lastJob = null; const jobManualExpand = new Map();
    ${extract("const STATUS_KEYS =", "const STATUS_TEXT =")}
    ${extract("const LOGIN_REASON_TEXT", "const STATUS_OPTIONS")}
    ${extract("const hasPasswordCheckIssue =", "async function api(")}
    ${extract("const EXPORT_STATUS_WARNING_TEXT", "let toastTimer")}
    ${extract("const ATTENTION_DETAIL_KEYWORDS =", "function clearJobBoard()")}
    return { stateOf: cloudPhoneStateOf, cell: cloudPhoneCellHtml, resultText: cloudPhoneResultText,
      fmtAccount, exportWarningText, hasExportWarning, isAbnormal, isUnchecked,
      renderJob, needsAttention: taskNeedsAttention };
  `)(escapeHtml, (value) => value || "", () => board, () => onlyAbnormal, () => "");
  const rowHelpers = {
    saleOf: () => "instock", isAbnormal: ui.isAbnormal, selected: new Set(),
    editCell: () => "", passwordCheckBadge: () => "", twoStepPhoneCellHtml: () => "",
    cloudPhoneCellHtml: ui.cell, categoryCell: () => "", sourceOf: () => "", saleCell: () => "",
    statusCell: () => "", fmtTime: () => "", maskSecret: () => "fixture-mask", escapeHtml,
    totpSetupBadge: () => "",
  };
  const rowHtml = new Function(...Object.keys(rowHelpers),
    `${extract("function accountRowHtml(", "function render()")} return accountRowHtml;`)(...Object.values(rowHelpers));
  const base = Object.freeze({
    id: "fixture-account", email: "shell-fixture@example.com", password: "fixture-password",
    recoveryEmail: "recovery-fixture@example.net", totpSecret: "FIXTUREKEY", year: "2026", country: "US",
    status: Object.freeze({ login: "ok", payment: "closed", family: "off", device: "cleaned" }),
  });
  const baseFields = [base.email, base.password, base.recoveryEmail, base.totpSecret, base.year, base.country];
  const cases = [
    ["no_challenge", "Shell 可用", "Shell 可用：已直接进入终端，本次无需手机号验证；未触发原号核验，无法判断是否绑定原号", "本次无需手机验证；原号未知"],
    ["cloud_unavailable", "Shell 不可用", "Shell 不可用：服务不可用或账号不符合使用资格，原号检测受阻；手机号状态未知，不能据此认定账号被封禁", "检测受阻；手机号状态未知"],
    ["cloud_disabled", "Shell 已停用", "Shell 已停用：服务明确被停用、暂停或封禁，无法通过此入口检测原号；手机号状态未知，不代表整个 Google 账号被封禁", "服务已停用；原号检测受阻"],
    ["cloud_authorization_required", "Shell 待授权", "Shell 待授权：需要 API 授权，检测未继续，也未授予权限；无法判断是否绑定原号", "授权未完成；原号未知"],
  ];
  const taskFor = (result, outcome = "ok") => ({
    email: base.email, status: "done", results: [{ action: "detect-cloud-phone", outcome,
      reasonCode: result.reasonCode, detail: { cloudPhone: result.detail },
      fieldPatch: { lastCloudPhoneCheck: result } }],
  });

  check("Shell 提示：四种原因在账号行、日志和复制中一致且保持未知状态", () => {
    for (const [reasonCode, label, expanded] of cases) {
      const result = Object.freeze({ state: "unknown", reasonCode,
        detail: "fixture Shell detail", checkedAt: "2026-09-26T00:00:00.000Z" });
      const account = Object.freeze({ ...base, lastCloudPhoneCheck: result });
      const task = taskFor(result);
      const before = JSON.stringify({ account, task });
      const row = rowHtml(account, 0);
      assert.ok(row.includes(`>${label}</span>`));
      assert.ok(row.includes('class="cloud-phone-badge unknown"'));
      assert.ok(row.includes(expanded));
      assert.ok(row.includes(result.detail));
      assert.ok(row.includes(result.checkedAt));
      assert.strictEqual(ui.stateOf(account), "unknown");
      assert.strictEqual(ui.isUnchecked(account), false);
      assert.strictEqual(ui.isAbnormal(account), false);
      assert.strictEqual(ui.hasExportWarning(account), false);
      assert.deepStrictEqual(ui.fmtAccount(account).split("----"), [...baseFields, `原号检测：${expanded}`]);
      ui.renderJob({ tasks: [task] });
      assert.ok(board.innerHTML.includes(`原号检测：${expanded} — `));
      assert.ok(board.innerHTML.includes(result.detail));
      assert.ok(board.innerHTML.includes('class="job-line out-neutral"'));
      assert.strictEqual(ui.needsAttention(task), false);
      assert.strictEqual(JSON.stringify({ account, task }), before, "展示不能改写未知状态或检测记录");
    }
  });

  check("Shell 提示：历史原因立即显示新标签，不用详情推断停用、封禁或新号", () => {
    for (const [reasonCode, label, expanded] of cases) {
      const account = { ...base, lastCloudPhoneCheck: {
        state: "unknown", reasonCode, checkedAt: "2025-01-01T00:00:00.000Z",
        detail: "旧详情：Cloud Shell has been disabled；账号封禁；可填新号；扫码验证", extraLegacyField: "keep",
      } };
      const before = JSON.stringify(account);
      assert.ok(rowHtml(account, 0).includes(`>${label}</span>`));
      assert.strictEqual(ui.fmtAccount(account), `${baseFields.join("----")}----原号检测：${expanded}`);
      ui.renderJob({ tasks: [taskFor(account.lastCloudPhoneCheck)] });
      assert.ok(board.innerHTML.includes(`原号检测：${expanded} — `));
      assert.strictEqual(ui.hasExportWarning(account), false);
      assert.strictEqual(JSON.stringify(account), before);
    }
    const unknown = { ...base, lastCloudPhoneCheck: { state: "unknown", reasonCode: "timeout",
      detail: "Cloud Shell has been disabled；Shell 不可用；Shell 待授权；账号封禁；无需电话验证" } };
    assert.ok(rowHtml(unknown, 0).includes(">未确认</span>"));
    assert.strictEqual(ui.fmtAccount(unknown), `${baseFields.join("----")}----原号检测：未确认`);
    assert.strictEqual(ui.isAbnormal(unknown), false);
    ui.renderJob({ tasks: [taskFor(unknown.lastCloudPhoneCheck)] });
    assert.ok(board.innerHTML.includes("原号检测：未确认 — "));
    const escaped = ui.cell({ lastCloudPhoneCheck: { state: "unknown", reasonCode: "cloud_disabled",
      detail: '\"><script>fixture</script>' } });
    assert.ok(escaped.includes("&quot;&gt;&lt;script&gt;fixture&lt;/script&gt;"));
    assert.ok(!escaped.includes("<script>"));
  });

  check("Shell 提示：账号行直接说明检测含义，日志和复制给出完整解释", () => {
    for (const [reasonCode, label, expanded, note] of cases) {
      const result = Object.freeze({ state: "unknown", reasonCode });
      const account = Object.freeze({ ...base, lastCloudPhoneCheck: result });
      const task = taskFor(result);
      const before = JSON.stringify({ account, task });
      const cell = ui.cell(account);
      const visible = cell.replace(/<[^>]*>/g, "");
      assert.ok(cell.includes(`<span class="cloud-phone-note">${note}</span>`), "说明必须位于可见文本节点，不能只有悬浮提示");
      assert.strictEqual(visible, `${label}${note}`);
      assert.strictEqual(ui.resultText(result), label);
      assert.strictEqual(ui.resultText(result, true), expanded);
      assert.strictEqual(ui.fmtAccount(account), `${baseFields.join("----")}----原号检测：${expanded}`);
      ui.renderJob({ tasks: [task] });
      assert.ok(board.innerHTML.replace(/<[^>]*>/g, "").includes(`原号检测：${expanded}`));
      assert.strictEqual(JSON.stringify({ account, task }), before);
    }
  });

  check("Shell 提示：仍归未确认筛选，未检测、新号、原号筛选不变", () => {
    const accounts = [
      ...cases.map(([reasonCode]) => ({ ...base, id: reasonCode, lastCloudPhoneCheck: { state: "unknown", reasonCode } })),
      { ...base, id: "unknown", lastCloudPhoneCheck: { state: "unknown", reasonCode: "timeout" } },
      { ...base, id: "qr", lastCloudPhoneCheck: { state: "unknown", reasonCode: "qr_verification_required" } },
      { ...base, id: "new", lastCloudPhoneCheck: { state: "new_number_allowed" } },
      { ...base, id: "existing", lastCloudPhoneCheck: { state: "existing_phone_required" } },
      { ...base, id: "unchecked" },
    ];
    const inputs = { search: { value: "" }, filterStatus: { value: "" },
      filterCategory: { value: "" }, filterCloudPhone: { value: "unknown" } };
    const helpers = { el: (id) => inputs[id], accounts, cloudPhoneStateOf: ui.stateOf,
      inNurtureOf: () => false, inScrapOf: () => false, inFailedOf: () => false,
      inNeedVerifyOf: () => false, in2faErrorOf: () => false, saleOf: () => "instock" };
    const filtered = new Function(...Object.keys(helpers),
      `${extract("function filtered()", "function filteredSales()")} return filtered;`)(...Object.values(helpers));
    const before = JSON.stringify(accounts);
    assert.deepStrictEqual(filtered().map((account) => account.id), [...cases.map(([reason]) => reason), "unknown", "qr"]);
    for (const [filter, id] of [["new_number_allowed", "new"], ["existing_phone_required", "existing"], ["unchecked", "unchecked"]]) {
      inputs.filterCloudPhone.value = filter;
      assert.deepStrictEqual(filtered().map((account) => account.id), [id]);
    }
    assert.strictEqual(JSON.stringify(accounts), before);
  });

  check("Shell 提示：扫码、新号、原号、普通未知及未检测文案保持", () => {
    for (const [state, reasonCode, label, expanded] of [
      ["unknown", "qr_verification_required", "需扫码", "需扫码（原号未确认）"],
      ["unknown", "timeout", "未确认", "未确认"],
      ["new_number_allowed", "cloud_disabled", "可填新号", "可填新号（本次验证）"],
      ["existing_phone_required", "no_challenge", "需原号", "需原号"],
    ]) {
      const account = { ...base, lastCloudPhoneCheck: { state, reasonCode } };
      assert.ok(rowHtml(account, 0).includes(`>${label}</span>`));
      assert.ok(!ui.cell(account).includes('class="cloud-phone-note"'));
      assert.strictEqual(ui.fmtAccount(account), `${baseFields.join("----")}----原号检测：${expanded}`);
      ui.renderJob({ tasks: [taskFor(account.lastCloudPhoneCheck)] });
      assert.ok(board.innerHTML.includes(`原号检测：${label}`));
    }
    assert.ok(rowHtml(base, 0).includes(">未检测</span>"));
    assert.ok(!ui.cell(base).includes('class="cloud-phone-note"'));
    assert.strictEqual(ui.fmtAccount(base), baseFields.join("----"));
    for (const state of [undefined, "unchecked", "invalid", "__proto__"]) {
      assert.strictEqual(ui.resultText({ state, reasonCode: "cloud_disabled" }), "未确认");
    }
  });

  check("Shell 提示：原字段和异常告警保留，日志失败及待人工不被中性标签掩盖", () => {
    for (const [reasonCode, label, expanded] of cases) {
      const result = { state: "unknown", reasonCode };
      const account = { ...base, status: { ...base.status, login: "2fa_error", restrict: "restricted" },
        lastCloudPhoneCheck: result };
      assert.strictEqual(ui.isAbnormal(account), true);
      assert.ok(rowHtml(account, 0).includes('class="row-bad"'));
      assert.strictEqual(ui.exportWarningText(account), "2FA密钥错误、服务受限");
      assert.deepStrictEqual(ui.fmtAccount(account).split("----"),
        [...baseFields, "2FA密钥错误、服务受限", `原号检测：${expanded}`]);
      for (const outcome of ["error", "need_verify"]) {
        const task = taskFor(result, outcome);
        onlyAbnormal = true;
        ui.renderJob({ tasks: [task] });
        assert.strictEqual(ui.needsAttention(task), true);
        assert.ok(board.innerHTML.includes(`原号检测：${expanded}`));
        assert.ok(board.innerHTML.includes(`class="job-line out-${outcome}"`));
        assert.ok(board.innerHTML.includes("needs-attn"));
      }
    }
    onlyAbnormal = false;
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
