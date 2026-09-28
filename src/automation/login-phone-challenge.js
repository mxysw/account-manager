"use strict";

// Pure, login-only classification. Callers must stop before filling or clicking;
// no input value, phone number, URL parameter, or page text leaves this function.
const NON_PHONE_ROUTES = new Set([
  "pwd", "totp", "ootp", "dp", "sk", "pk", "webauthn", "backupcode", "bc",
  "ipe", "kpe", "selection", "recaptcha", "captcha", "recoveryemail",
]);

const SELECTION_RE = /choose (?:a |your |another )?(?:verification|sign.in) method|choose how (?:you want )?to (?:sign in|verify)|select (?:a |your )?verification method|选择.{0,8}(?:验证方式|验证方法)|選擇.{0,8}(?:驗證方式|驗證方法)|인증\s*방법\s*선택/i;
const CAPTCHA_RE = /(?:verify|confirm|prove).{0,16}(?:you(?:'re| are)? (?:a )?human|not a robot)|reCAPTCHA|人机验证|人機驗證|证明您不是自动程序|验证您不是机器人|로봇이\s*아님|자동입력\s*방지|사람인지\s*확인/i;
const OTHER_METHOD_RE = /Google\s*Authenticator|Authenticator app|authentication app|身份验证器|身分驗證器|驗證器應用|인증\s*앱|g\.co\/sc|check your (?:phone|device|tablet)|Google sent (?:a|you a) notification|tap (?:yes|the number)|open the Google app|查看您的设备|查看你的设备|檢查您的裝置|在通知中.{0,8}(?:点按|點按)|기기.{0,12}(?:알림|확인)|(?:confirm|enter|check).{0,25}(?:recovery |backup )?e-?mail|(?:确认|確認|输入|輸入|查收).{0,20}(?:辅助|恢复|备用|備援|復原)?(?:邮箱|邮件|郵件)|복구\s*이메일/i;
const OPTIONAL_PHONE_RE = /(?:add|update).{0,16}(?:recovery )?phone number.{0,140}(?:optional|not now|skip|maybe later)|(?:添加|新增|更新).{0,15}(?:手机|電話|电话).{0,140}(?:可选|選填|稍后|稍後|跳过|略過)|(?:전화번호|휴대전화).{0,140}(?:선택사항|선택 사항|건너뛰기|나중에)/i;

const EXISTING_PHONE_RE = /(?:confirm|enter|verify).{0,20}(?:phone|mobile) number.{0,45}(?:you (?:previously )?(?:added|provided)|associated with|registered (?:on|with)|linked to)|(?:confirm|enter|verify).{0,20}(?:existing|recovery|registered) (?:phone|mobile) number|(?:确认|確認|输入|輸入|验证|驗證).{0,35}(?:您|你).{0,15}(?:添加|新增|绑定|綁定|关联|關聯).{0,20}(?:电话|手機|手机|電話)|(?:确认|確認|输入|輸入|验证|驗證).{0,15}(?:原来|原來|原先|已绑定|已綁定|恢复|復原|備援).{0,12}(?:手机|手機|电话|電話)|계정에.{0,15}(?:추가한|등록한|연결된).{0,15}(?:전화번호|휴대전화)|(?:기존|복구)\s*(?:전화번호|휴대전화).{0,15}(?:확인|입력)/i;
const ADD_PHONE_RE = /(?:add|provide|enter) (?:a |your |new |a new )?(?:phone|mobile) number|(?:添加|新增|提供|输入|輸入).{0,8}(?:电话|電話|手机|手機)号码|(?:添加|新增|提供|输入|輸入).{0,8}(?:電話|手機)號碼|(?:전화번호|휴대전화\s*번호)(?:를|을).{0,12}(?:입력|추가)/i;
const SMS_RE = /\bSMS\b|\btext message\b|短信|簡訊|문자\s*메시지/i;
const CODE_RE = /\b(?:verification )?code\b|验证码|驗證碼|인증\s*코드/i;
const PHONE_RE = /\b(?:phone|mobile)\b|电话|電話|手机|手機|전화번호|휴대전화/i;
const PHONE_CODE_RE = /(?:send|sent|text|texted).{0,55}(?:code|message).{0,40}(?:to|at).{0,25}(?:phone|mobile)|(?:code|message).{0,35}(?:sent|texted).{0,25}(?:phone|mobile)|(?:向|给|給).{0,25}(?:手机|手機|电话|電話).{0,25}(?:发送|發送).{0,12}(?:验证码|驗證碼)|(?:验证码|驗證碼).{0,25}(?:发送|發送).{0,25}(?:手机|手機|电话|電話)|(?:전화번호|휴대전화).{0,25}(?:전송|발송).{0,20}(?:인증\s*)?코드/i;
const SMS_ACTION_RE = /(?:enter|send|sent|receive|get|texted).{0,60}(?:verification code|code|text message|SMS)|(?:code|SMS|text message).{0,45}(?:sent|texted|enter)|(?:输入|輸入|接收|获取|取得|发送|發送).{0,35}(?:短信|簡訊|验证码|驗證碼)|(?:短信|簡訊|验证码|驗證碼).{0,35}(?:输入|輸入|发送|發送)|(?:인증\s*코드|문자\s*메시지).{0,40}(?:입력|받|전송|발송)|(?:전송|발송).{0,20}인증\s*코드/i;
const MASKED_PHONE_RE = /[•●*·xX]{2,}[\s\-().•●*·xX]*\d{2,4}(?!\d)/;
const SEND_TO_RE = /\b(?:send|sent|text|texted)\b.{0,55}\b(?:code|message|SMS)\b.{0,55}\b(?:to|at)\b|\b(?:code|message)\b.{0,35}\b(?:sent|texted)\b.{0,25}\bto\b|(?:向|给|給|發送至|发送至).{0,45}(?:发送|發送|短信|簡訊|验证码|驗證碼)|(?:验证码|驗證碼|短信|簡訊).{0,35}(?:发送|發送).{0,15}(?:至|到)|(?:전송|발송).{0,20}인증\s*코드|인증\s*코드.{0,25}(?:전송|발송)/i;

function result(kind) {
  return { kind, reasonCode: kind === "add" ? "phone_add_required" : "phone_verification_required" };
}

function classifyLoginPhoneChallenge({ url, text, signals = {} } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.origin !== "https://accounts.google.com" || parsed.username || parsed.password) return null;
  const match = parsed.pathname.match(/^\/(?:v[23]\/signin\/|signin\/v[23]\/|signin\/)?challenge\/([^/]+)(?:\/|$)/i);
  if (!match) return null;
  const route = match[1].toLowerCase();
  if (NON_PHONE_ROUTES.has(route)) return null;

  // Addresses may themselves contain phone/SMS-looking words or masked digits.
  const value = String(text || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ")
    .replace(/\s+/g, " ").trim();
  if (SELECTION_RE.test(value) || CAPTCHA_RE.test(value) || OPTIONAL_PHONE_RE.test(value)) return null;

  // IPP is phone confirmation even while stale password/TOTP inputs remain.
  if (route === "ipp") return result("verify");
  if (OTHER_METHOD_RE.test(value)) return null;

  // This wins over a blank phone input and over IAP's new-number default.
  if (EXISTING_PHONE_RE.test(value)
      || (MASKED_PHONE_RE.test(value) && SEND_TO_RE.test(value))) return result("verify");

  const asksForNumber = ADD_PHONE_RE.test(value);
  const sms = SMS_RE.test(value);
  const code = CODE_RE.test(value);
  // IAP is Google's phone-number collection route. Other routes need explicit
  // current instructions; input[type=tel] and generic "verification code" do not
  // establish a phone challenge. Signals must describe the visible active form.
  if (asksForNumber && (route === "iap" || (sms && code)
      || (signals?.phoneNumberInput === true && PHONE_RE.test(value)))) return result("add");
  if (PHONE_CODE_RE.test(value) || (sms && code && SMS_ACTION_RE.test(value))) return result("verify");
  if (signals?.smsCodeInput === true && sms && code) return result("verify");
  if (route === "iap") return result("add");
  return null;
}

module.exports = { classifyLoginPhoneChallenge };
