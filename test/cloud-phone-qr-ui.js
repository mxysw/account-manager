"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pure renderer fixtures only: no browser, server, network or account store.
module.exports = function runCloudPhoneQrUiTests({ check }) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const extract = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `missing UI section: ${start}`);
    return source.slice(first, last);
  };
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const ui = new Function("escapeHtml", "fmtTime", `
    ${extract("function diagnosticDetailText(", "function passwordChangedDaysAgo(")}
    ${extract("const CLOUD_PHONE_STATE_TEXT =", "async function api(")}
    return { stateOf: cloudPhoneStateOf, cell: cloudPhoneCellHtml, resultText: cloudPhoneResultText };
  `)(escapeHtml, (value) => value || "");
  const qrCheck = {
    state: "unknown", reasonCode: "qr_verification_required",
    detail: "需扫码验证：Google 要求使用手机扫码，原号未确认。", checkedAt: "2026-09-26T00:00:00.000Z",
  };

  check("原号扫码界面：短标签保留未知状态、解释和时间", () => {
    for (const email of ["fixture-one@example.com", "fixture-two@example.net", ""]) {
      const account = { email, lastCloudPhoneCheck: { ...qrCheck } };
      const html = ui.cell(account);
      assert.strictEqual(ui.stateOf(account), "unknown");
      assert.ok(html.includes('class="cloud-phone-badge unknown"'));
      assert.ok(html.includes(">需扫码</span>"));
      assert.ok(html.includes("原号未确认"));
      assert.ok(html.includes("扫码页不能证明未绑定手机号"));
      assert.ok(html.includes(qrCheck.checkedAt));
      assert.ok(!html.includes("new_number_allowed"));
      assert.ok(!html.includes(">可填新号</span>"));
      assert.deepStrictEqual(account.lastCloudPhoneCheck, qrCheck, "渲染不能改写检测结果");
    }
    const escaped = ui.cell({ lastCloudPhoneCheck: { ...qrCheck, detail: '\"><script>fixture</script>' } });
    assert.ok(escaped.includes("&quot;&gt;&lt;script&gt;fixture&lt;/script&gt;"));
    assert.ok(!escaped.includes("<script>"));
  });

  check("原号扫码界面：仍归未确认筛选，不归可填新号或未检测", () => {
    const fixtureAccounts = [
      { id: "qr", lastCloudPhoneCheck: { ...qrCheck } },
      { id: "other-unknown", lastCloudPhoneCheck: { state: "unknown", reasonCode: "timeout" } },
      { id: "new", lastCloudPhoneCheck: { state: "new_number_allowed" } },
      { id: "existing", lastCloudPhoneCheck: { state: "existing_phone_required" } },
      { id: "unchecked" },
    ];
    const inputs = { search: { value: "" }, filterStatus: { value: "" }, filterCategory: { value: "" }, filterCloudPhone: { value: "unknown" } };
    const helpers = {
      el: (id) => inputs[id], accounts: fixtureAccounts, cloudPhoneStateOf: ui.stateOf,
      inNurtureOf: () => false, inScrapOf: () => false, inFailedOf: () => false,
      inNeedVerifyOf: () => false, in2faErrorOf: () => false, saleOf: () => "instock",
    };
    const filtered = new Function(...Object.keys(helpers), `${extract("function filtered()", "function filteredSales()")}
      return filtered;`)(...Object.values(helpers));
    assert.deepStrictEqual(filtered().map((item) => item.id), ["qr", "other-unknown"]);
    inputs.filterCloudPhone.value = "new_number_allowed";
    assert.deepStrictEqual(filtered().map((item) => item.id), ["new"]);
    inputs.filterCloudPhone.value = "unchecked";
    assert.deepStrictEqual(filtered().map((item) => item.id), ["unchecked"]);
  });

  check("原号扫码界面：普通未确认、新号和原号结果标签不变", () => {
    for (const [state, text] of [["unknown", "未确认"], ["new_number_allowed", "可填新号"], ["existing_phone_required", "需原号"]]) {
      const html = ui.cell({ lastCloudPhoneCheck: { state, reasonCode: "fixture", detail: "普通页面" } });
      assert.ok(html.includes(`>${text}</span>`));
      assert.ok(!html.includes(">需扫码</span>"));
    }
    assert.ok(ui.cell({}).includes(">未检测</span>"));
    assert.ok(ui.cell({ lastCloudPhoneCheck: { state: "unknown", reasonCode: "timeout", detail: "扫描二维码" } }).includes(">未确认</span>"),
      "只有明确扫码原因码才能显示需扫码，详情提及二维码不算检测结果");
  });

  check("原号扫码日志：显示需扫码、保留详情和人工异常归类", () => {
    const board = { innerHTML: "" };
    const uiJob = new Function("el", "loadJobOnlyAbnormal", "escapeHtml", "cloudPhoneResultText",
      "passwordCheckResultText", "loginCheckResultText", "totpSetupResultText", `
      let lastJob = null; const jobManualExpand = new Map();
      ${extract("const ATTENTION_DETAIL_KEYWORDS =", "function clearJobBoard()")}
      return { render: renderJob, needsAttention: taskNeedsAttention };
    `)(() => board, () => true, escapeHtml, ui.resultText, () => "", () => "", () => "");
    const qrTask = {
      email: "qr-fixture@example.com", status: "done",
      results: [{ action: "detect-cloud-phone", outcome: "need_verify", reasonCode: "qr_verification_required",
        detail: { cloudPhone: qrCheck.detail }, fieldPatch: { lastCloudPhoneCheck: { ...qrCheck } } }],
    };
    uiJob.render({ tasks: [qrTask] });
    assert.strictEqual(uiJob.needsAttention(qrTask), true);
    assert.ok(board.innerHTML.includes("原号检测：需扫码"));
    assert.ok(board.innerHTML.includes(qrCheck.detail));
    assert.ok(board.innerHTML.includes('class="job-line out-need_verify"'));
    assert.ok(board.innerHTML.includes("needs-attn"));
    assert.ok(!board.innerHTML.includes("原号检测：可填新号"));
    const otherTask = { ...qrTask, results: [{ ...qrTask.results[0], reasonCode: "timeout",
      fieldPatch: { lastCloudPhoneCheck: { ...qrCheck, reasonCode: "timeout" } } }] };
    uiJob.render({ tasks: [otherTask] });
    assert.ok(board.innerHTML.includes("原号检测：未确认"));
    assert.ok(!board.innerHTML.includes("原号检测：需扫码"));
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
