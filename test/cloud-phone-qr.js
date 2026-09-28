"use strict";

const assert = require("assert");

// Pure, fictional page fixtures: no browser/network and no account store imports.
const EMAIL = "cloud-qr-regression@example.com";
const CHALLENGE_URL = "https://accounts.google.com/v3/signin/challenge/qr?TL=fictional-qr-token";
const QR_ZH = `验证您的信息后才能继续 ${EMAIL} 使用您的手机扫描二维码 打开相机应用 扫描上方二维码 按照手机上的说明操作，然后回到这台电脑继续。`;
const QR_EN = `Verify your info to continue ${EMAIL} Scan the QR code with your phone. Open the camera app on your phone and scan the QR code above. Follow the instructions on your phone, then return to this computer to continue.`;
const SELECTION_TEXT = `验证您的信息后才能继续 ${EMAIL} 选择一种方法进行验证 扫描二维码 验证您的电话号码 使用验证码。需要支付短信费用。`;

function snapshot(text = QR_ZH, extra = {}) {
  return {
    id: "verification", url: CHALLENGE_URL, text,
    hasPhoneInput: false, hasCodeInput: false, hasCaptcha: false,
    controls: [], ...extra,
  };
}

function assertQr(result, message) {
  assert.ok(result, message);
  assert.strictEqual(result.state, "unknown", "扫码页不能证明无手机号、可填新号或需要原号");
  assert.strictEqual(result.reasonCode, "qr_verification_required", message);
  assert.strictEqual(result.outcome, "need_verify");
  assert.strictEqual(result.stop, true);
  assert.ok(result.detail && /二维码|扫码/.test(result.detail), "结果应说明需要扫码验证");
  assert.ok(!JSON.stringify(result).includes("fictional-qr-token"), "结果不能记录验证页令牌");
}

function assertNotQr(result, message) {
  assert.notStrictEqual(result && result.reasonCode, "qr_verification_required", message);
}

function verifyPrompt() {
  return {
    id: "console", url: "https://console.cloud.google.com/welcome/new?hl=zh-CN",
    text: `Verify your account to start using Cloud Shell. ${EMAIL}`,
    controls: [{ id: "verify", label: "Verify", kind: "button" }],
  };
}

function fixtureAdapter(stages, transitions) {
  let stage = 0;
  const calls = [];
  const prohibited = async (action) => {
    calls.push([action]);
    throw new Error(`Forbidden fixture action: ${action}`);
  };
  return {
    calls,
    open: async (url) => { calls.push(["open", url]); },
    snapshots: async () => {
      calls.push(["snapshots", stage]);
      return stages[stage];
    },
    click: async (scopeId, controlId) => {
      const key = `${scopeId}:${controlId}`;
      calls.push(["click", key]);
      assert.ok(Object.prototype.hasOwnProperty.call(transitions, key), `不允许扫码或提交号码：${key}`);
      stage = transitions[key];
      return true;
    },
    localize: async () => prohibited("localize"),
    fill: async () => prohibited("fill"),
    type: async () => prohibited("type"),
    submit: async () => prohibited("submit"),
    scanQr: async () => prohibited("scanQr"),
    wait: async () => { calls.push(["wait"]); },
    emit: () => {},
  };
}

module.exports = async function runCloudPhoneQrTests({ check, checkAsync }) {
  const { classifyPhoneChallenge, runFlow } = require("../src/automation/actions/detect-cloud-phone").helpers;
  const started = { cloudVerificationStarted: true };

  check("Cloud 扫码识别：中英文真扫码页在 Cloud 验证上下文返回待人工", () => {
    for (const text of [QR_ZH, QR_EN]) {
      for (const context of [started, { phoneMethodSelected: true }]) {
        assertQr(classifyPhoneChallenge(snapshot(text), context));
      }
    }
  });

  check("Cloud 扫码识别：challenge 和 uplevelingstep 路径均可识别", () => {
    for (const pathname of [
      "/v3/signin/challenge/qr", "/signin/v2/challenge/qr", "/signin/challenge/qr",
      "/uplevelingstep/qr", "/uplevelingstep/selection",
    ]) {
      assertQr(classifyPhoneChallenge(snapshot(QR_ZH, { url: `https://accounts.google.com${pathname}` }), started), pathname);
    }
  });

  check("Cloud 扫码识别：未开始 Cloud 验证不能从登录页扫码文本推断结果", () => {
    for (const context of [undefined, {}, { cloudVerificationStarted: false, phoneMethodSelected: false }]) {
      assertNotQr(classifyPhoneChallenge(snapshot(), context));
    }
  });

  check("Cloud 扫码识别：严格限制 HTTPS Google Accounts 域名与验证路径", () => {
    for (const url of [
      "http://accounts.google.com/v3/signin/challenge/qr",
      "https://accounts.google.com.example.net/v3/signin/challenge/qr",
      "https://accounts.google.com@example.net/v3/signin/challenge/qr",
      "https://example.net/uplevelingstep/qr",
      "https://myaccount.google.com/uplevelingstep/qr",
      "https://accounts.google.com/security",
      "not-a-url",
    ]) {
      assertNotQr(classifyPhoneChallenge(snapshot(QR_ZH, { url }), started), url);
    }
  });

  check("Cloud 扫码识别：二维码和电话验证的选择列表不能提前停止", () => {
    const choices = [
      SELECTION_TEXT,
      `Verify your info to continue ${EMAIL} Choose a verification method Scan a QR code Verify your phone number`,
    ];
    for (const text of choices) {
      for (const url of [CHALLENGE_URL, "https://accounts.google.com/uplevelingstep/selection"]) {
        assert.strictEqual(classifyPhoneChallenge(snapshot(text, { url }), started), null, text);
      }
    }
  });

  check("Cloud 扫码识别：验证器设置和通行密钥二维码不属于本次手机扫码验证", () => {
    for (const text of [
      `设置身份验证器 ${EMAIL} 打开 Google 身份验证器应用，使用您的手机扫描二维码，然后输入应用中显示的验证码。`,
      `Set up Authenticator ${EMAIL} Scan the QR code with your phone in Google Authenticator and enter the code.`,
      `使用通行密钥 ${EMAIL} 使用您的手机扫描二维码，按照手机上的说明操作，然后回到这台电脑。`,
      `Use a passkey ${EMAIL} Scan the QR code with your phone. Follow the instructions on your phone, then return to this computer.`,
    ]) {
      assertNotQr(classifyPhoneChallenge(snapshot(text), started), text);
    }
  });

  check("Cloud 扫码识别：人机验证优先于扫码说明", () => {
    for (const page of [snapshot(QR_ZH, { hasCaptcha: true }), snapshot(`${QR_EN} Verify you are human`)]) {
      const result = classifyPhoneChallenge(page, started);
      assert.strictEqual(result.reasonCode, "captcha");
      assert.strictEqual(result.state, "unknown");
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(result.stop, true);
    }
  });

  check("Cloud 扫码识别：完整扫码说明也不能覆盖电话选项、活动输入框或验证器设置", () => {
    const choices = [{ id: "phone", label: "验证您的电话号码", kind: "button" }];
    assertNotQr(classifyPhoneChallenge(snapshot(QR_ZH, { controls: choices }), started));
    for (const extra of [{ hasPhoneInput: true }, { hasCodeInput: true }]) {
      assertNotQr(classifyPhoneChallenge(snapshot(QR_ZH, extra), started));
    }
    for (const prefix of ["设置身份验证器", "Google Authenticator", "Use a passkey", "使用通行密钥"]) {
      assertNotQr(classifyPhoneChallenge(snapshot(`${prefix} ${QR_ZH}`), started));
    }
  });

  check("Cloud 扫码识别：明确原号确认说明优先于同页扫码说明", () => {
    const page = snapshot(`${QR_EN} To get a verification code, first confirm the phone number that you added to your account •••48.`);
    const result = classifyPhoneChallenge(page, started);
    assert.strictEqual(result.state, "existing_phone_required");
    assert.strictEqual(result.reasonCode, "existing_phone_required");
  });

  await checkAsync("Cloud 扫码流程：Verify 直达二维码后立即停止，零扫码零号码提交", async () => {
    for (const [text, url] of [
      [QR_ZH, CHALLENGE_URL],
      [QR_EN, "https://accounts.google.com/uplevelingstep/qr"],
      [QR_ZH, "https://accounts.google.com/uplevelingstep/selection"],
    ]) {
      const qr = snapshot(text, { url, controls: [
        { id: "qr", label: "扫描二维码", kind: "button" },
        { id: "next", label: "下一步", kind: "button" },
        { id: "send", label: "Send", kind: "button" },
      ] });
      // The underlying console is deliberately first and ready: the verification
      // popup must win over an unrelated/no-challenge Cloud result.
      const consolePage = { ...verifyPrompt(), terminalReady: true, text: "Welcome to Cloud Shell", controls: [] };
      const adapter = fixtureAdapter([[verifyPrompt()], [consolePage, qr]], { "console:verify": 1 });
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 8 });
      assertQr(result);
      assert.deepStrictEqual(adapter.calls.filter(([action]) => action === "click"), [["click", "console:verify"]]);
      assert.strictEqual(adapter.calls.filter(([action]) => action === "snapshots").length, 2, "到达扫码页首轮观察即停止");
      assert.strictEqual(adapter.calls.filter(([action]) => action === "wait").length, 1, "不能在扫码页轮询至超时");
      assert.deepStrictEqual(adapter.calls.filter(([action]) => ["localize", "fill", "type", "submit", "scanQr"].includes(action)), []);
    }
  });

  await checkAsync("Cloud 扫码流程：混合选择列表继续电话验证，不点击二维码选项", async () => {
    const selection = snapshot(SELECTION_TEXT, {
      id: "selection", url: "https://accounts.google.com/uplevelingstep/selection",
      controls: [
        { id: "qr", label: "扫描二维码", kind: "button" },
        { id: "phone", label: "验证您的电话号码", kind: "button" },
      ],
    });
    for (const [text, expected] of [
      ["请输入电话号码，以便通过短信接收验证码。Google 会存储此号码，但仅将它用于安全用途。", "new_number_allowed"],
      ["To get a verification code, first confirm the phone number that you added to your account •••48.", "existing_phone_required"],
    ]) {
      const phone = snapshot(text, { url: "https://accounts.google.com/v3/signin/challenge/iap", hasPhoneInput: true });
      const adapter = fixtureAdapter([[verifyPrompt()], [selection], [phone]], { "console:verify": 1, "selection:phone": 2 });
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 8 });
      assert.strictEqual(result.state, expected);
      assert.deepStrictEqual(adapter.calls.filter(([action]) => action === "click"), [["click", "console:verify"], ["click", "selection:phone"]]);
      assert.deepStrictEqual(adapter.calls.filter(([action]) => ["fill", "type", "submit", "scanQr"].includes(action)), []);
    }
  });

  await checkAsync("Cloud 扫码流程：扫码页有人机验证时报告 captcha 并停止", async () => {
    const adapter = fixtureAdapter([[verifyPrompt()], [snapshot(QR_ZH, { hasCaptcha: true })]], { "console:verify": 1 });
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 8 });
    assert.strictEqual(result.reasonCode, "captcha");
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.stop, true);
    assert.deepStrictEqual(adapter.calls.filter(([action]) => action === "click"), [["click", "console:verify"]]);
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
    .then(() => console.log(`\n${passed} 项 Cloud 扫码本地回归测试通过`))
    .catch((error) => { process.exitCode = 1; console.error(error); });
}
