"use strict";

const assert = require("assert");

// Pure page fixtures only: no browser, network, account-store, or real accounts.
const EMAIL = "cloud-locales-fixture@example.com";
const CLOUD_URL = "https://console.cloud.google.com/welcome/new?hl=zh-CN";
const CHALLENGE_URL = "https://accounts.google.com/v3/signin/challenge/fixture?hl=zh-CN";
const AUTHORIZATION_ZH = "为 Cloud Shell 提供授权 Cloud Shell 需要获得相关权限才能使用您的凭证进行 Google Cloud API 调用。点击“授权”以向本次调用和未来的调用授予权限。拒绝 授权";
const DISABLED_ZH = "账号已停用 Google Cloud Shell 由于违反了我们的服务条款，您的账号已停用 Google Cloud Shell。";
const BACKGROUND_CONTROLS = [
  { id: "shell", label: "Activate Cloud Shell", kind: "button" },
  { id: "continue", label: "Continue", kind: "button" },
  { id: "send", label: "Send code", kind: "button" },
];

function cloud(text, extra = {}) {
  return { id: "cloud", url: CLOUD_URL, text, controls: [], ...extra };
}

function authorization(text = AUTHORIZATION_ZH) {
  return cloud(text, {
    id: "authorization",
    controls: [
      { id: "deny", label: "拒绝", kind: "button" },
      { id: "authorize", label: "授权", kind: "button" },
    ],
  });
}

function permutations(items) {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]));
}

async function runFixture(stages, transitions = {}, options = {}) {
  const { runFlow } = require("../src/automation/actions/detect-cloud-phone").helpers;
  const { advanceOnSnapshot = false, ...flowOptions } = options;
  const calls = [];
  let stage = 0;
  const prohibited = (action) => async () => {
    calls.push([action]);
    throw new Error(`Forbidden fixture action: ${action}`);
  };
  const result = await runFlow({
    open: async (url) => { calls.push(["open", url]); },
    snapshots: async () => {
      calls.push(["snapshots", stage]);
      const pages = [...stages[stage]];
      if (advanceOnSnapshot) stage = Math.min(stage + 1, stages.length - 1);
      return pages;
    },
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
  }, { accountEmail: EMAIL, maxPolls: 4, ...flowOptions });
  // runFlow catches adapter errors; forbidden attempts must still fail the test.
  assert.deepStrictEqual(calls.filter(([action]) => ["localize", "fill", "type", "submit", "scanQr"].includes(action)), []);
  assert.deepStrictEqual(calls.filter(([action]) => action === "click").map(([, key]) => key), Object.keys(transitions));
  return { result, calls };
}

function assertUnknown(result, reasonCode, outcome = "error") {
  assert.strictEqual(result.state, "unknown", "Cloud 服务或授权状态不能证明原号绑定情况");
  assert.strictEqual(result.reasonCode, reasonCode);
  assert.strictEqual(result.outcome, outcome);
  assert.strictEqual(result.stop, true);
}

function assertImmediate(calls) {
  assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 1);
  assert.strictEqual(calls.filter(([action]) => action === "wait").length, 0, "明确结果必须立即停止，不能进入等待循环");
  assert.strictEqual(calls.filter(([action]) => action === "click").length, 0, "不得授权或点击背景按钮");
}

module.exports = async function runCloudShellLocaleTests({ check, checkAsync }) {
  check("Cloud 多语言 fixture：沿用纯 runFlow 测试入口", () => {
    assert.strictEqual(typeof require("../src/automation/actions/detect-cloud-phone").helpers.runFlow, "function");
  });

  await checkAsync("Cloud 中文授权：截图原文立即停止，不能耗尽 90 次轮询", async () => {
    const { result, calls } = await runFixture([[authorization()]], {}, { maxPolls: 90 });
    assertUnknown(result, "cloud_authorization_required", "ok");
    assert.match(result.detail, /原号未确认/);
    assert.match(result.detail, /未授权/);
    assertImmediate(calls);
  });

  await checkAsync("Cloud 授权：简体、繁体和英文均立即停止且不点击授权", async () => {
    for (const text of [
      "为 Cloud Shell 授权 Cloud Shell 需要获得权限才能使用您的凭据进行 Google Cloud API 调用。拒绝 授权",
      "為 Cloud Shell 提供授權 Cloud Shell 需要取得相關權限，才能使用您的憑證進行 Google Cloud API 呼叫。點選「授權」即可為這次和日後的呼叫授予權限。拒絕 授權",
      "授權 Cloud Shell Cloud Shell 需要權限才能使用您的憑證進行 Google Cloud API 呼叫。拒絕 授權",
      "Authorize Cloud Shell. Cloud Shell needs permission to use your credentials to call Google Cloud APIs. Deny Authorize",
    ]) {
      const { result, calls } = await runFixture([[authorization(text)]]);
      assertUnknown(result, "cloud_authorization_required", "ok");
      assertImmediate(calls);
    }
  });

  await checkAsync("Cloud 已停用：截图中的账号已停用 Cloud Shell 不能降级为泛不可用", async () => {
    const { result, calls } = await runFixture([[cloud(DISABLED_ZH, { controls: BACKGROUND_CONTROLS })]]);
    assertUnknown(result, "cloud_disabled");
    assert.match(result.detail, /已停用/);
    assert.match(result.detail, /原号未确认/);
    assertImmediate(calls);
  });

  await checkAsync("Cloud 已停用：简繁中文和英文明确服务停用均保留独立状态", async () => {
    for (const text of [
      "由于违反了我们的服务条款，您的账号已停用 Google Cloud Shell。",
      "帳戶已停用 Google Cloud Shell 由於違反了我們的服務條款，您的帳戶已停用 Google Cloud Shell。",
      "您的 Cloud Shell 服务已被停用。",
      "您的 Cloud Shell 服務已暫停。",
      "Cloud Shell has been disabled for your account due to a violation of our terms of service.",
      "Your access to Cloud Shell has been suspended.",
    ]) {
      const { result, calls } = await runFixture([[cloud(text, { controls: BACKGROUND_CONTROLS })]]);
      assertUnknown(result, "cloud_disabled");
      assertImmediate(calls);
    }
  });

  await checkAsync("Cloud 状态边界：项目停用、否定和可能性描述不能认定 Cloud Shell 已停用", async () => {
    for (const text of [
      "Cloud Shell: Your project has been disabled.",
      "Cloud Shell connection has been disabled.",
      "Cloud Shell 您的项目已停用。",
      "Cloud Shell 您的專案已停用。",
      "Cloud Shell is not disabled.",
      "Cloud Shell might be disabled.",
      "Cloud Shell service could be suspended.",
      "Cloud Shell 尚未停用。",
      "您的账号尚未停用 Google Cloud Shell。",
      "您的账号可能会停用 Google Cloud Shell。",
      "您的帳戶可能會停用 Google Cloud Shell。",
    ]) {
      const { result } = await runFixture([[cloud(text)]]);
      assertUnknown(result, "timeout", "need_verify");
    }
  });

  await checkAsync("Cloud 不符合资格：保留不可用，不能认定停用", async () => {
    for (const text of [
      "Cloud Shell: This account is not eligible.",
      "You are not eligible to use Cloud Shell.",
      "您的账号不符合资格，无法使用 Cloud Shell。",
    ]) {
      const { result, calls } = await runFixture([[cloud(text, { controls: BACKGROUND_CONTROLS })]]);
      assertUnknown(result, "cloud_unavailable");
      assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 3, "泛不可用需连续三次稳定观察");
      assert.strictEqual(calls.filter(([action]) => action === "wait").length, 2);
      assert.strictEqual(calls.filter(([action]) => action === "click").length, 0);
    }
  });

  await checkAsync("Cloud 授权优先：独立授权弹页覆盖背景终端和不可用，快照顺序无关", async () => {
    const backgrounds = [
      cloud("Cloud Shell $", { id: "terminal", terminalReady: true, controls: BACKGROUND_CONTROLS }),
      cloud("Cloud Shell is not available for this account.", { id: "unavailable", controls: BACKGROUND_CONTROLS }),
    ];
    for (const background of backgrounds) {
      for (const pages of permutations([authorization(), background])) {
        const { result, calls } = await runFixture([pages]);
        assertUnknown(result, "cloud_authorization_required", "ok");
        assertImmediate(calls);
      }
    }
  });

  await checkAsync("Cloud 身份验证优先：独立验证弹页覆盖背景终端和不可用", async () => {
    const prompt = cloud(`Verify your account to start using Cloud Shell. ${EMAIL}`, {
      id: "verification",
      controls: [{ id: "verify", label: "Verify", kind: "button" }],
    });
    for (const background of [
      cloud("Cloud Shell $", { id: "terminal", terminalReady: true, controls: BACKGROUND_CONTROLS }),
      cloud("Cloud Shell is not available for this account.", { id: "unavailable", controls: BACKGROUND_CONTROLS }),
    ]) {
      for (const pages of permutations([prompt, background])) {
        const { result, calls } = await runFixture([
          pages,
          [background, { id: "challenge", url: CHALLENGE_URL, text: "Enter the verification code", hasCodeInput: true, controls: BACKGROUND_CONTROLS }],
        ], { "verification:verify": 1 });
        assertUnknown(result, "verification_code_required", "need_verify");
        assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 2);
      }
    }
  });

  await checkAsync("Cloud 加载顺序：不可用先出现一帧，随后授权弹页仍立即取得优先级", async () => {
    const background = cloud("Cloud Shell is not available for this account.", { id: "unavailable", controls: BACKGROUND_CONTROLS });
    for (const pages of permutations([authorization(), background])) {
      const { result, calls } = await runFixture([[background], pages], {}, { advanceOnSnapshot: true });
      assertUnknown(result, "cloud_authorization_required", "ok");
      assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 2);
      assert.strictEqual(calls.filter(([action]) => action === "wait").length, 1);
      assert.strictEqual(calls.filter(([action]) => action === "click").length, 0);
    }
  });

  await checkAsync("Cloud 加载顺序：不可用先出现一帧，随后验证弹页仍可取得明确验证结果", async () => {
    const background = cloud("Cloud Shell is not available for this account.", { id: "unavailable", controls: BACKGROUND_CONTROLS });
    const prompt = cloud(`Verify your account to start using Cloud Shell. ${EMAIL}`, {
      id: "verification",
      controls: [{ id: "verify", label: "Verify", kind: "button" }],
    });
    for (const pages of permutations([prompt, background])) {
      const { result, calls } = await runFixture([
        [background],
        pages,
        [background, { id: "challenge", url: CHALLENGE_URL, text: "Enter the verification code", hasCodeInput: true, controls: [] }],
      ], { "verification:verify": 2 }, { advanceOnSnapshot: true });
      assertUnknown(result, "verification_code_required", "need_verify");
      assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 3);
      assert.strictEqual(calls.filter(([action]) => action === "wait").length, 2);
    }
  });

  await checkAsync("Cloud 验证未加载完：缺少验证按钮仍阻止背景终端和不可用提前结束", async () => {
    const prompt = cloud("Verify your account to start using Cloud Shell.", { id: "verification" });
    for (const background of [
      cloud("Cloud Shell $", { id: "terminal", terminalReady: true, controls: BACKGROUND_CONTROLS }),
      cloud("Cloud Shell is not available for this account.", { id: "unavailable", controls: BACKGROUND_CONTROLS }),
    ]) {
      for (const pages of permutations([prompt, background])) {
        const { result, calls } = await runFixture([pages]);
        assertUnknown(result, "timeout", "need_verify");
        assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 4);
        assert.strictEqual(calls.filter(([action]) => action === "click").length, 0);
      }
    }
  });

  await checkAsync("Cloud 验证高于授权：缺少 Verify 按钮也必须等待，不能按授权状态提前结束", async () => {
    const prompt = cloud("Verify your account to start using Cloud Shell.", { id: "verification" });
    for (const pages of permutations([prompt, authorization()])) {
      const { result, calls } = await runFixture([pages]);
      assertUnknown(result, "timeout", "need_verify");
      assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 4);
      assert.strictEqual(calls.filter(([action]) => action === "wait").length, 4);
      assert.strictEqual(calls.filter(([action]) => action === "click").length, 0);
    }
  });

  await checkAsync("Cloud 验证同优先级：前一个 scope 无按钮，仍可点击后一个 scope 的 Verify", async () => {
    const pending = cloud("Verify your account to start using Cloud Shell.", { id: "pending-verification" });
    const ready = cloud("Verify your account to start using Cloud Shell.", {
      id: "ready-verification",
      controls: [{ id: "verify", label: "Verify", kind: "button" }],
    });
    for (const pages of permutations([pending, ready, authorization()])) {
      const { result, calls } = await runFixture([
        pages,
        [authorization(), { id: "challenge", url: CHALLENGE_URL, text: "Enter the verification code", hasCodeInput: true, controls: [] }],
      ], { "ready-verification:verify": 1 });
      assertUnknown(result, "verification_code_required", "need_verify");
      assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 2);
    }
  });

  await checkAsync("Cloud 验证跳转延迟：只点击一次，残留提示及授权页不能覆盖稍后出现的验证码或新号结果", async () => {
    const prompt = cloud(`Verify your account to start using Cloud Shell. ${EMAIL}`, {
      id: "verification",
      controls: [{ id: "verify", label: "Verify", kind: "button" }],
    });
    for (const pages of permutations([prompt, authorization()])) {
      const codeChallenge = { id: "challenge", url: CHALLENGE_URL, text: "Enter the verification code", hasCodeInput: true, controls: [] };
      const codeFixture = await runFixture([
        pages,
        pages,
        [...pages, codeChallenge],
      ], { "verification:verify": 1 }, { advanceOnSnapshot: true });
      assertUnknown(codeFixture.result, "verification_code_required", "need_verify");
      assert.strictEqual(codeFixture.calls.filter(([action]) => action === "snapshots").length, 3);
      assert.strictEqual(codeFixture.calls.filter(([action]) => action === "wait").length, 2);

      const selection = {
        id: "selection", url: "https://accounts.google.com/uplevelingstep/selection?hl=zh-CN",
        text: "Choose a verification method", controls: [{ id: "phone", label: "Verify your phone number", kind: "button" }],
      };
      const newNumber = {
        id: "challenge", url: CHALLENGE_URL,
        text: "Enter a phone number to receive a verification code. Google will store this phone number.",
        hasPhoneInput: true, controls: [],
      };
      const newNumberFixture = await runFixture([
        pages,
        pages,
        [...pages, selection],
        [...pages, newNumber],
      ], { "verification:verify": 1, "selection:phone": 3 }, { advanceOnSnapshot: true, maxPolls: 6 });
      assert.strictEqual(newNumberFixture.result.state, "new_number_allowed");
      assert.strictEqual(newNumberFixture.result.reasonCode, "new_number_allowed");
      assert.strictEqual(newNumberFixture.result.outcome, "ok");
      assert.strictEqual(newNumberFixture.result.stop, true);
      assert.strictEqual(newNumberFixture.calls.filter(([action]) => action === "snapshots").length, 4);
      assert.strictEqual(newNumberFixture.calls.filter(([action]) => action === "wait").length, 3);
    }
  });

  await checkAsync("Google 验证优先：未解决验证页继续阻止授权弹页和背景状态", async () => {
    for (const url of [CHALLENGE_URL, "https://accounts.google.com/uplevelingstep/selection?hl=zh-CN"]) {
      const challenge = { id: "challenge", url, text: "Loading verification", controls: [] };
      for (const background of [
        cloud("Cloud Shell $", { id: "terminal", terminalReady: true, controls: BACKGROUND_CONTROLS }),
        cloud("Cloud Shell is not available for this account.", { id: "unavailable", controls: BACKGROUND_CONTROLS }),
      ]) {
        for (const pages of permutations([challenge, authorization(), background])) {
          const { result, calls } = await runFixture([pages]);
          assertUnknown(result, "timeout", "need_verify");
          assert.strictEqual(calls.filter(([action]) => action === "snapshots").length, 4);
          assert.strictEqual(calls.filter(([action]) => action === "click").length, 0);
        }
      }
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
    .then(() => console.log(`\n${passed} 项 Cloud Shell 多语言本地回归测试通过`))
    .catch((error) => { process.exitCode = 1; console.error(error); });
}
