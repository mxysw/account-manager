"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Render fixtures only: no browser, credentials, network or live account store.
module.exports = function runAdd2faUiTests({ check }) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const extract = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `missing renderer: ${start}`);
    return source.slice(first, last);
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const { badge, setupResultText } = new Function("escapeHtml", "fmtTime",
    `${extract("function totpSetupStateInfo(", "const STATUS_FIELD_LABEL")}\nreturn {badge: totpSetupBadge, setupResultText: totpSetupResultText};`)(escapeHtml, (value) => value);

  check("添加验证器界面：五种结果短标签、详情和时间", () => {
    for (const [state, text, cls] of [
      ["added", "已添加", "ok"],
      ["pending_activation", "密钥已保存·开启待确认", "warn"],
      ["already_configured", "已有验证器", "known"],
      ["needs_attention", "设置需处理", "warn"],
      ["failed", "添加失败", "bad"],
    ]) {
      const html = badge({ lastTotpSetup: { state, detail: "fixture-detail", checkedAt: "2026-09-12T00:00:00Z" } });
      assert.ok(html.includes(`totp-setup-badge ${cls}`));
      assert.ok(html.includes(`>${text}</span>`));
      assert.ok(html.includes("fixture-detail"));
      assert.ok(html.includes("2026-09-12T00:00:00Z"));
      assert.ok(!html.includes("totp-secret"));
    }
  });

  check("添加验证器界面：缺少结果不冒报，悬停详情转义", () => {
    for (const account of [null, {}, { lastTotpSetup: {} }, { lastTotpSetup: { state: "future" } }, { lastTotpSetup: { state: "__proto__" } }]) {
      assert.strictEqual(badge(account), "");
    }
    const html = badge({ lastTotpSetup: { state: "failed", detail: '"><script>fixture</script>' } });
    assert.ok(html.includes("&quot;&gt;&lt;script&gt;fixture&lt;/script&gt;"));
    assert.ok(!html.includes("<script>"));
  });

  check("添加验证器界面：密钥保存与开启确认分阶段，需处理不暗示已添加密钥", () => {
    const pending = badge({ lastTotpSetup: { state: "pending_activation", detail: "设置页要求再次确认身份" } });
    assert.ok(pending.includes(">密钥已保存·开启待确认</span>"));
    assert.ok(pending.includes("设置页要求再次确认身份"));
    assert.ok(!pending.includes(">待开启</span>"));
    const attention = badge({ lastTotpSetup: { state: "needs_attention", detail: "未确认首次设置入口" } });
    assert.ok(attention.includes(">设置需处理</span>"));
    assert.ok(attention.includes("未确认首次设置入口"));
    assert.ok(!attention.includes("密钥已保存"));
    assert.ok(!attention.includes("已添加"));
  });

  check("添加验证器界面：只有真实本地密钥才展示取码/复制，已有验证器不伪造密钥", () => {
    const helpers = {
      saleOf: () => "instock", isAbnormal: () => false, selected: new Set(),
      editCell: () => "", passwordCheckBadge: () => "", twoStepPhoneCellHtml: () => "",
      cloudPhoneCellHtml: () => "", categoryCell: () => "", sourceOf: () => "", saleCell: () => "",
      statusCell: () => "", fmtTime: () => "", maskSecret: () => "••••fixture", escapeHtml, totpSetupBadge: badge,
    };
    const render = new Function(...Object.keys(helpers),
      `${extract("function accountRowHtml(", "function render()")}\nreturn accountRowHtml;`)(...Object.values(helpers));
    const account = { id: "fixture", email: "fixture@example.com", status: {}, lastTotpSetup: { state: "already_configured" }, pendingTotpSetup: { secret: "PENDING-FIXTURE-NOT-TO-RENDER" } };
    const noSecret = render(account, 0);
    assert.ok(noSecret.includes("已有验证器"));
    assert.ok(noSecret.includes("无密钥"));
    assert.ok(noSecret.includes("不代表 Google 账号未设置验证器"));
    assert.ok(!noSecret.includes('class="totp-secret"'));
    assert.ok(!noSecret.includes("totp-btn"));
    assert.ok(!noSecret.includes("PENDING-FIXTURE-NOT-TO-RENDER"));
    const added = render({ ...account, totpSecret: "FIXTURE-NOT-A-REAL-SECRET", lastTotpSetup: { state: "added" } }, 0);
    assert.ok(added.includes('class="totp-secret"'));
    assert.ok(added.includes("totp-btn"));
    assert.ok(added.includes("已添加"));
    assert.ok(!added.includes("FIXTURE-NOT-A-REAL-SECRET"), "完整密钥不得出现在结果标签、HTML 属性或文本中");
  });

  check("添加验证器任务：设置结果优先显示，不被前置登录正常掩盖", () => {
    const board = { innerHTML: "" };
    const { render, completed } = new Function("el", "loadJobOnlyAbnormal", "escapeHtml",
      "passwordCheckResultText", "loginCheckResultText", "totpSetupResultText",
      `let lastJob = null; const jobManualExpand = new Map();
      ${extract("function cloudPhoneResultText(", "function cloudPhoneStateOf(")}
      ${extract("const ATTENTION_DETAIL_KEYWORDS =", "function clearJobBoard()")}
      ${extract("function completedJobText(", "async function pollJob()")}
      return {render: renderJob, completed: completedJobText};`)(
      () => board, () => false, escapeHtml, () => "密码正确", () => "正常", setupResultText);
    for (const [state, text, outcome] of [
      ["added", "已添加", "ok"], ["pending_activation", "密钥已保存·开启待确认", "need_verify"],
      ["already_configured", "已有验证器", "ok"], ["needs_attention", "设置需处理", "need_verify"],
      ["failed", "添加失败", "error"],
    ]) {
      const setup = { action: "add-2fa", outcome, detail: { add2fa: "fixture-setup-stage" }, fieldPatch: { lastTotpSetup: { state } } };
      const job = { status: "done", tasks: [{ email: "fixture@example.com", status: "done", results: [
        { action: "login", outcome: "ok", reasonCode: "ok" }, setup,
      ] }] };
      const summary = completed(job);
      assert.ok(summary.endsWith(`身份验证器：${text}`));
      assert.ok(!summary.includes("登录：正常"));
      render(job);
      assert.ok(board.innerHTML.includes(`添加身份验证器：${text}`));
      assert.ok(board.innerHTML.includes("登录：正常"), "设置阶段的待确认不能遮盖此前的登录成功");
      assert.ok(board.innerHTML.includes("fixture-setup-stage"), "日志保留具体设置阶段详情");
    }
    assert.strictEqual(setupResultText({ action: "add-2fa", outcome: "ok" }), "未确认",
      "缺少可信状态不能把执行 ok 直接渲染为已添加");
    const loginOnly = { status: "done", tasks: [{ email: "fixture@example.com", results: [{ action: "login", outcome: "ok", reasonCode: "ok" }] }] };
    assert.ok(completed(loginOnly).endsWith("登录：正常"), "普通登录任务摘要不变");
    assert.strictEqual(completed({ ...loginOnly, status: "cancelled" }), "已停止");
  });
};
