"use strict";

const assert = require("node:assert/strict");
const { classifyLoginPhoneChallenge: classify } = require("../src/automation/login-phone-challenge");

const base = "https://accounts.google.com/v3/signin/challenge/";
const add = { kind: "add", reasonCode: "phone_add_required" };
const verify = { kind: "verify", reasonCode: "phone_verification_required" };
const existing = "To get a verification code, first confirm the phone number that you added to your account •••••• •••48";
const newNumber = "Enter a phone number to get a text message with a verification code. Google will store this number and only use it for security purposes.";

module.exports = async function run({ check }) {
  check("登录手机号：IAP 新号表单和未挂载正文立即识别为添加号码", () => {
    for (const text of ["", newNumber, "请输入电话号码，以便通过短信接收验证码。", "인증 코드가 포함된 문자 메시지를 받으려면 전화번호를 입력하세요.", "Google 인증 코드를 문자 메시지로 받으려면 전화번호를 입력하세요."]) {
      assert.deepEqual(classify({ url: `${base}iap`, text, signals: { phoneNumberInput: true } }), add, text);
    }
    for (const prefix of ["/challenge/", "/signin/challenge/", "/signin/v2/challenge/", "/v2/signin/challenge/", "/v3/signin/challenge/"]) {
      assert.deepEqual(classify({ url: `https://accounts.google.com${prefix}iap?continue=private#private` }), add);
    }
  });

  check("登录手机号：IAP 明确原号确认优先于空号码框和新增文案", () => {
    for (const text of [
      existing,
      `${existing} ${newNumber}`,
      "要获取验证码，请先确认您添加到账号中的电话号码 •••••• •••48。",
      "請確認您新增至帳戶的電話號碼。",
      "인증 코드를 받으려면 먼저 계정에 추가한 전화번호 •••••• •••48을 확인하세요.",
      "Enter the recovery phone number associated with your account",
    ]) assert.deepEqual(classify({ url: `${base}iap`, text, signals: { phoneNumberInput: true } }), verify, text);
  });

  check("登录手机号：IPP 确认、发送和收码阶段不受残留输入框影响", () => {
    for (const route of ["ipp", "ipp/", "ipp/consent", "ipp/confirm"]) {
      for (const signals of [{}, { phoneNumberInput: true }, { smsCodeInput: true }, { passwordInput: true, totpInput: true }]) {
        assert.deepEqual(classify({ url: `${base}${route}`, text: "Verify it's you", signals }), verify);
      }
    }
  });

  check("登录手机号：IDVANY 和未知挑战须有明确号码或短信指令", () => {
    for (const route of ["idvany", "idvpin", "new-phone-challenge"]) {
      for (const text of [newNumber, "请输入电话号码，以便通过短信接收验证码。", "인증 코드가 포함된 문자 메시지를 받으려면 전화번호를 입력하세요."]) {
        assert.deepEqual(classify({ url: `${base}${route}`, text }), add, text);
      }
      for (const text of [existing, "Enter the code sent by SMS", "输入收到的短信验证码", "전화번호로 전송된 인증 코드를 입력하세요.", "A verification code was sent to your phone", "Google will send a verification code to •••••• •••48."]) {
        assert.deepEqual(classify({ url: `${base}${route}`, text }), verify, text);
      }
      for (const text of ["", "Verify it's you", "Enter a verification code", "A phone number helps protect your account", "Phone number SMS rates may apply", "Google will store this number"]) {
        assert.equal(classify({ url: `${base}${route}`, text, signals: { phoneNumberInput: true } }), null, text);
      }
    }
  });

  check("登录手机号：显式输入信号只能佐证当前文案，不能单独判短信", () => {
    assert.deepEqual(classify({ url: `${base}idvany`, text: "Enter your phone number", signals: { phoneNumberInput: true } }), add);
    assert.equal(classify({ url: `${base}idvany`, text: "Enter your phone number" }), null);
    assert.deepEqual(classify({ url: `${base}idvpin`, text: "SMS verification code", signals: { smsCodeInput: true } }), verify);
    for (const signals of [{ smsCodeInput: true }, { phoneNumberInput: true }, { phoneNumberInput: "yes", smsCodeInput: "yes" }, null]) {
      assert.equal(classify({ url: `${base}idvany`, text: "Enter a verification code", signals }), null);
    }
  });

  check("登录手机号：身份验证器、辅助邮箱、设备提示和 CAPTCHA 路由优先排除", () => {
    for (const route of ["totp", "ootp", "dp", "ipe", "kpe", "pwd", "sk", "pk", "backupcode", "recaptcha", "captcha", "selection"]) {
      assert.equal(classify({ url: `${base}${route}`, text: `${newNumber} ${existing}`, signals: { phoneNumberInput: true, smsCodeInput: true } }), null, route);
    }
    for (const text of [
      "Enter a code from the Google Authenticator app on your phone",
      "从身份验证器应用获取验证码",
      "Check your phone. Google sent a notification to your device. Tap Yes.",
      "Get your security code at g.co/sc using your phone",
      "Confirm your recovery email address to get a verification code",
      "请输入辅助邮箱地址，以便接收验证码",
      "인증 앱에서 코드를 가져오세요",
      "Verify you are human. Enter a phone number to get a text message with a verification code.",
      "请先完成人机验证，再输入电话号码",
    ]) assert.equal(classify({ url: `${base}idvany`, text, signals: { phoneNumberInput: true, smsCodeInput: true } }), null, text);
  });

  check("登录手机号：选择页和可选添加手机建议不误报强制挑战", () => {
    for (const url of [`${base}selection`, "https://accounts.google.com/uplevelingstep/selection", "https://accounts.google.com/speedbump/phone", "https://accounts.google.com/signin/v2/speedbump/phone", "https://myaccount.google.com/phone"]) {
      assert.equal(classify({ url, text: newNumber, signals: { phoneNumberInput: true } }), null, url);
    }
    for (const text of [
      "Choose how you want to verify. Get a text message with a verification code. Enter a phone number.",
      "选择验证方式 短信验证码 身份验证器",
      "인증 방법 선택 QR 코드 스캔 전화번호 인증 인증 코드를 사용하세요. SMS 요금이 적용됩니다.",
      "Add a recovery phone number to protect your account. Not now",
      "Add a phone number (optional). Skip",
      "添加手机号码以保护账号 稍后再说",
      "전화번호 추가 나중에",
    ]) assert.equal(classify({ url: `${base}iap`, text, signals: { phoneNumberInput: true } }), null, text);
  });

  check("登录手机号：严格校验 HTTPS Google 来源、挑战路径和真实路径段", () => {
    for (const url of [
      "http://accounts.google.com/v3/signin/challenge/iap",
      "https://accounts.google.com.example.net/v3/signin/challenge/iap",
      "https://example.net/v3/signin/challenge/iap",
      "https://accounts.google.com:8443/v3/signin/challenge/iap",
      "https://accounts.google.com@evil.example/v3/signin/challenge/iap",
      "https://user:secret@accounts.google.com/v3/signin/challenge/iap",
      "https://accounts.google.com/ServiceLogin?continue=/v3/signin/challenge/iap",
      "https://accounts.google.com/?path=/v3/signin/challenge/ipp",
      "https://accounts.google.com/not-login/challenge/iap",
      "https://accounts.google.com/v3/signin/challenge/iap-lookalike",
      "https://accounts.google.com/v3/signin/challenge/ipp-lookalike",
      "not-a-url", "", undefined,
    ]) assert.equal(classify({ url, text: "Verify it's you", signals: { phoneNumberInput: true } }), null, String(url));
    assert.equal(classify(), null);
  });

  check("登录手机号：结果不携带号码、邮箱、页面文案或 URL 会话参数", () => {
    const result = classify({ url: `${base}iap?TL=private-query#private-fragment`, text: `${existing} +1 202 555 0199 fixture@example.com` });
    assert.deepEqual(result, verify);
    assert.deepEqual(Object.keys(result).sort(), ["kind", "reasonCode"]);
    assert.equal(classify({ url: `${base}idvany`, text: "xx123@example.com Google will store this number. Get a verification code." }), null);
  });
};
