"use strict";

const assert = require("assert");

// Pure page fixtures: no browser, network, account-store reads, or real accounts.
const EMAIL = "cloud-status-fixture@example.com";
const CLOUD_URL = "https://console.cloud.google.com/welcome/new?hl=zh-CN";
const CHALLENGE_URL = "https://accounts.google.com/v3/signin/challenge/fixture?hl=zh-CN";
const BUTTONS = [
  { id: "shell", label: "Activate Cloud Shell", kind: "button" },
  { id: "continue", label: "Continue", kind: "button" },
  { id: "send", label: "Send code", kind: "button" },
];

function cloud(text, extra = {}) {
  return { id: "cloud", url: CLOUD_URL, text, controls: [], ...extra };
}

async function runFixture(stages, transitions = {}, options = {}) {
  const { runFlow } = require("../src/automation/actions/detect-cloud-phone").helpers;
  const calls = [];
  let stage = 0;
  const prohibited = (action) => async () => {
    calls.push([action]);
    throw new Error(`Forbidden fixture action: ${action}`);
  };
  const result = await runFlow({
    open: async (url) => { calls.push(["open", url]); },
    snapshots: async () => { calls.push(["snapshots", stage]); return stages[stage]; },
    click: async (scopeId, controlId) => {
      const key = `${scopeId}:${controlId}`;
      calls.push(["click", key]);
      assert.ok(Object.prototype.hasOwnProperty.call(transitions, key), `禁止额外点击 ${key}`);
      stage = transitions[key];
      return true;
    },
    wait: async () => { calls.push(["wait"]); },
    localize: prohibited("localize"),
    fill: prohibited("fill"),
    type: prohibited("type"),
    submit: prohibited("submit"),
    scanQr: prohibited("scanQr"),
  }, { accountEmail: EMAIL, maxPolls: 6, ...options });
  // runFlow intentionally catches adapter errors, so assert attempts afterwards.
  assert.deepStrictEqual(calls.filter(([action]) => ["localize", "fill", "type", "submit", "scanQr"].includes(action)), []);
  const clicks = calls.filter(([action]) => action === "click").map(([, key]) => key);
  assert.deepStrictEqual(clicks, Object.keys(transitions), "只允许 fixture 声明的一次性导航点击");
  return { result, calls };
}

function assertUnknown(result, reasonCode, outcome = "error") {
  assert.strictEqual(result.state, "unknown", "Cloud 服务状态不能证明原号绑定情况");
  assert.strictEqual(result.reasonCode, reasonCode);
  assert.strictEqual(result.outcome, outcome);
  assert.strictEqual(result.stop, true);
}

module.exports = async function runCloudShellStatusTests({ check, checkAsync }) {
  check("Cloud 状态 fixture：导出纯 runFlow 测试入口", () => {
    assert.strictEqual(typeof require("../src/automation/actions/detect-cloud-phone").helpers.runFlow, "function");
  });

  await checkAsync("Cloud 直接可用：真实 terminalReady 信号保留 no_challenge，原号仍未确认", async () => {
    const { result, calls } = await runFixture([[cloud(`Welcome to Cloud Shell! ${EMAIL} $`, { terminalReady: true })]]);
    assertUnknown(result, "no_challenge", "ok");
    assert.match(result.detail, /^Cloud Shell 可直接使用，本次无需电话验证；原号未确认/);
    assert.match(result.detail, /不能据此判断是否绑定手机号/);
    assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 1);
  });

  await checkAsync("Cloud 直接可用：打开终端后不再点击介绍页继续、发送验证码等按钮", async () => {
    const { result } = await runFixture([
      [cloud("Google Cloud", { controls: BUTTONS })],
      [cloud("Welcome to Cloud Shell. Cloud Shell is free. $", { terminalReady: true, controls: BUTTONS })],
    ], { "cloud:shell": 1 });
    assertUnknown(result, "no_challenge", "ok");
  });

  await checkAsync("Cloud 直接可用：只有欢迎语而无终端就绪不能报告无需电话验证", async () => {
    const { result } = await runFixture([[cloud("Welcome to Cloud Shell! Type help to get started.")]]);
    assertUnknown(result, "timeout", "need_verify");
  });

  await checkAsync("Cloud 已停用：明确英文停用、暂停和封禁与不可用分开", async () => {
    for (const text of [
      "Cloud Shell is disabled for your account.",
      "Cloud Shell has been disabled due to suspicious activity.",
      "Your access to Cloud Shell has been suspended.",
      "Your Cloud Shell access is temporarily suspended.",
      "Cloud Shell is permanently banned for this account.",
      "Cloud Shell disabled",
    ]) {
      const { result } = await runFixture([[cloud(`${text} Cloud Shell is free.`, { controls: BUTTONS })]]);
      assertUnknown(result, "cloud_disabled");
      assert.match(result.detail, /原号未确认/);
    }
  });

  await checkAsync("Cloud 已停用：明确简繁中文停用、暂停和封禁不触发任何点击", async () => {
    for (const text of [
      "Cloud Shell 已停用。",
      "您的 Cloud Shell 已被封禁。",
      "Cloud Shell 服务现已暂停。",
      "Cloud Shell 访问权限已经被停用。",
      "Cloud Shell 服務已暫停。",
      "已停用您的 Cloud Shell。",
    ]) {
      const { result } = await runFixture([[cloud(text, { controls: BUTTONS })]]);
      assertUnknown(result, "cloud_disabled");
    }
  });

  await checkAsync("Cloud 不可用：不符合资格和泛不可用保留 cloud_unavailable，不能升级封禁", async () => {
    for (const text of [
      "Cloud Shell is not available for this account.",
      "Cloud Shell: This account is not eligible.",
      "You are not eligible to use Cloud Shell.",
      "无法使用 Cloud Shell。",
      "您的账号不符合资格，无法使用 Cloud Shell。",
      "Cloud Shell is temporarily not available. Please try again later.",
    ]) {
      const { result } = await runFixture([[cloud(text, { controls: BUTTONS })]]);
      assertUnknown(result, "cloud_unavailable");
      assert.doesNotMatch(result.detail, /封禁|已停用/);
    }
  });

  await checkAsync("Cloud 状态保守识别：连接超时、否定、可能性和其他服务停用都不能报告封禁", async () => {
    for (const text of [
      "Cloud Shell 暂时无法连接，请稍后重试。",
      "Cloud Shell 连接超时。",
      "Cloud Shell connection timed out.",
      "Cloud Shell is not disabled.",
      "Cloud Shell might be disabled.",
      "Cloud Shell service could be suspended.",
      "Cloud Shell 尚未停用。",
      "Cloud Shell: Your project has been disabled.",
      "Cloud Shell connection has been disabled.",
    ]) {
      const { result } = await runFixture([[cloud(text)]]);
      assert.strictEqual(result.state, "unknown", text);
      assert.notStrictEqual(result.reasonCode, "cloud_disabled", text);
      assert.notStrictEqual(result.reasonCode, "no_challenge", text);
    }
  });

  await checkAsync("Cloud 验证优先：未知验证弹页阻止背景终端误报直接可用和背景点击", async () => {
    for (const url of [CHALLENGE_URL, "https://accounts.google.com/uplevelingstep/selection?hl=zh-CN"]) {
      const { result } = await runFixture([[
        cloud("Cloud Shell is free. $", { terminalReady: true, controls: BUTTONS }),
        { id: "challenge", url, text: "Loading verification", controls: [] },
      ]]);
      assertUnknown(result, "timeout", "need_verify");
    }
  });

  await checkAsync("Cloud 验证优先：人机验证、未接受条款和 API 授权都不能被终端就绪跳过", async () => {
    for (const [page, reasonCode, outcome] of [
      [cloud("Cloud Shell", { hasCaptcha: true, controls: BUTTONS }), "captcha", "need_verify"],
      [cloud(`Google Cloud Country/region Terms of Service ${EMAIL}`, { controls: [
        { id: "terms", label: "Google Cloud Terms of Service", kind: "checkbox", checked: false },
        { id: "agree", label: "Agree and continue", kind: "button" },
      ] }), "cloud_setup_required", "need_verify"],
      [cloud("Authorize Cloud Shell. Cloud Shell needs permission to use your credentials. Cloud Shell is free.", { controls: [
        { id: "authorize", label: "Authorize", kind: "button" }, ...BUTTONS,
      ] }), "cloud_authorization_required", "ok"],
    ]) {
      const { result } = await runFixture([[{ ...page, terminalReady: true }]]);
      assertUnknown(result, reasonCode, outcome);
    }
  });

  await checkAsync("Cloud 验证优先：验证码和扫码页立即停止，背景终端不覆盖验证结果", async () => {
    const prompt = cloud(`Verify your account to start using Cloud Shell. ${EMAIL}`, {
      controls: [{ id: "verify", label: "Verify", kind: "button" }],
    });
    for (const [text, extra, reasonCode] of [
      ["Enter the verification code", { hasCodeInput: true }, "verification_code_required"],
      ["Scan the QR code with your phone. Return to this computer to continue.", {}, "qr_verification_required"],
    ]) {
      const { result, calls } = await runFixture([
        [prompt],
        [cloud("Cloud Shell $", { terminalReady: true, controls: BUTTONS }), {
          id: "challenge", url: CHALLENGE_URL, text, ...extra, controls: BUTTONS,
        }],
      ], { "cloud:verify": 1 });
      assertUnknown(result, reasonCode, "need_verify");
      assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 2);
    }
  });
};

if (require.main === module) {
  let passed = 0;
  const check = (name, fn) => {
    try { fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`FAIL  ${name}: ${error.message}`); }
  };
  const checkAsync = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`FAIL  ${name}: ${error.message}`); }
  };
  module.exports({ check, checkAsync })
    .then(() => console.log(`\n${passed} 项 Cloud Shell 状态本地回归测试通过`))
    .catch((error) => { process.exitCode = 1; console.error(error); });
}
