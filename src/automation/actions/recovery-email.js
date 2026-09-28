"use strict";

// Confirming an already configured address is not reading an inbox or entering
// an email verification code. Only the former is automated by this module.
const RECOVERY_OPTION_RE = /^(?:confirm (?:(?:your|the) )?recovery email(?: address)?(?: (?:you |that you )?added to your account)?|确认(?:(?:您|你)的?)?(?:辅助|恢复|备用)(?:电子邮件地址|邮箱|电子邮箱)(?:地址)?|確認(?:(?:您|你)的?)?(?:備援|復原)(?:電子郵件|電子郵件地址))$/i;
const RECOVERY_EMAIL_SELECTORS = [
  "input[name='knowledgePreregisteredEmailResponse']", "#knowledge-preregistered-email-response",
  "input[name='recoveryEmail']", "input[autocomplete='email']:not(#identifierId):not([name='identifier'])",
  "input[type='email']:not(#identifierId):not([name='identifier'])",
];
const WRONG_EMAIL_RE = /(?:wrong|incorrect) (?:recovery )?email|(?:email|address).{0,30}(?:doesn.t match|is incorrect|is wrong)|(?:辅助|恢复|备用|備援|復原)(?:电子)?(?:邮箱|邮件|電子郵件).{0,20}(?:错误|不正确|不匹配|錯誤|不正確)|(?:邮箱|邮件地址|電子郵件地址).{0,20}(?:不匹配|不正确|不正確)|(?:isn.t|is not) the (?:recovery )?email/i;

function classifyRecoveryEmail(text, url, signals) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return ""; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") return "";
  const challenge = parsed.pathname.match(/\/challenge\/([^/]+)/i)?.[1]?.toLowerCase();
  if (!challenge || /^(?:pwd|totp|ipp|idvpin|dp|ootp|selection|recaptcha)$/.test(challenge)) return "";
  // Usernames are data, not instructions (e.g. code123@example.com). Ignore
  // addresses before classifying prose to avoid turning confirmation into OTP.
  const value = String(text || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ").replace(/\s+/g, " ");
  const emailContext = /email|e-mail|邮箱|邮件|郵件/i.test(value);
  const codeContext = /\b(?:enter|check|sent|send|receive|get)\b.{0,40}\b(?:verification )?code\b|\bcode\b.{0,40}\b(?:sent|email)\b|(?:输入|输入您收到的|輸入|发送|發送|查收|接收|获取|取得).{0,20}(?:验证码|驗證碼)|验证码.{0,20}(?:发送|发到|邮箱)|驗證碼.{0,20}(?:傳送|郵件)/i.test(value);
  if (signals) {
    // A whole-page mention of codes can belong to a different method or the
    // previous SPA screen. The active input's purpose is the stronger evidence.
    if (signals.addressInput && signals.codeInput) return "pending";
    if (signals.addressInput) return "confirm";
    if (signals.codeInput && emailContext) return "code";
    if (challenge === "kpe" || emailContext) return "pending";
    return "";
  }
  if (emailContext && codeContext) return "code";
  if (challenge === "kpe") return "confirm";
  if (/(?:confirm|enter).{0,30}(?:your |the )?recovery (?:email|e-mail)(?: address)?|(?:确认|輸入|输入|確認).{0,20}(?:辅助|恢复|备用|備援|復原).{0,12}(?:邮箱|邮件|郵件)/i.test(value)) return "confirm";
  return "";
}

// Read URL, prose and visible control semantics together, without collecting
// input values. Self-contained for Puppeteer and deterministic DOM fixtures.
function inspectRecoveryEmailPage(doc = document, styleOf = getComputedStyle) {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = styleOf(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      && !node.closest("[hidden], [inert], [aria-hidden='true']") && !node.disabled;
  };
  let addressInput = false;
  let codeInput = false;
  const addressNodes = [];
  for (const input of doc.querySelectorAll("input")) {
    if (!visible(input) || /^(?:hidden|password|checkbox|radio|submit|button)$/i.test(input.type || "")) continue;
    if (input.id === "identifierId" || input.name === "identifier") continue;
    const labels = [...(input.labels || [])].map((label) => label.innerText || label.textContent || "");
    for (const id of (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
      const label = doc.getElementById(id);
      if (label) labels.push(label.innerText || label.textContent || "");
    }
    const description = [input.getAttribute("aria-label"), input.getAttribute("placeholder"), ...labels].filter(Boolean).join(" ");
    const isCode = /(?:pin|verification.?code|email.?code|otp)/i.test(`${input.name || ""} ${input.id || ""}`)
      || input.getAttribute("autocomplete") === "one-time-code"
      || /(?:verification|security) code|验证码|驗證碼/i.test(description)
      || (input.getAttribute("inputmode") === "numeric" && Number(input.getAttribute("maxlength")) === 6);
    const isAddress = /^(?:knowledgePreregisteredEmailResponse|recoveryEmail)$/i.test(input.name || "")
      || input.id === "knowledge-preregistered-email-response"
      || (!isCode && /recovery (?:email|e-mail)(?: address)?|(?:辅助|恢复|备用|備援|復原).{0,8}(?:邮箱|邮件|郵件)/i.test(description));
    if (isCode) codeInput = true;
    if (isAddress) { addressInput = true; addressNodes.push(input); }
  }
  // Use the very control whose purpose we inspected, including labelled text
  // inputs without Google's known name/id. Never fall back to another email box.
  let addressSelector = "";
  if (addressNodes.length === 1 && !codeInput) {
    const path = [];
    for (let node = addressNodes[0]; node && node.parentElement; node = node.parentElement) {
      path.unshift(`${node.tagName.toLowerCase()}:nth-child(${Array.from(node.parentElement.children).indexOf(node) + 1})`);
    }
    if (path.length) addressSelector = `html > ${path.join(" > ")}`;
  }
  if (addressNodes.length > 1) codeInput = true; // ambiguous form, wait without typing
  return { url: doc.location.href, text: doc.body ? doc.body.innerText : "", signals: { addressInput, codeInput }, addressSelector };
}

// Self-contained so Puppeteer can evaluate the same selector logic in the page.
// Selector lists are DOM-ordered: explicitly prefer the recovery-specific host
// over unrelated Next buttons left behind by Google's login SPA.
function findRecoveryEmailNext(doc = document, styleOf = getComputedStyle, addressSelector = "") {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = styleOf(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      && style.pointerEvents !== "none" && !node.closest("[hidden], [inert]");
  };
  const eligible = (node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true"
    && /^(?:Next|Continue|Verify|下一步|继续|验证|繼續|驗證|Siguiente|Continuar|Suivant|Weiter|次へ|다음)$/i
      .test((node.innerText || node.textContent || node.getAttribute("aria-label") || "").trim());
  const host = doc.querySelector("#knowledgePreregisteredEmailNext");
  if (host && visible(host)) {
    const buttons = [...host.querySelectorAll("button,[role='button']")];
    if (host.matches("button,[role='button']")) buttons.unshift(host);
    if (buttons.length) return buttons.find(eligible) || null;
    return eligible(host) ? host : null;
  }
  const inputs = [...doc.querySelectorAll("input[name='knowledgePreregisteredEmailResponse'],#knowledge-preregistered-email-response,input[name='recoveryEmail'],input[type='email']:not(#identifierId):not([name='identifier'])")];
  const input = addressSelector ? doc.querySelector(addressSelector) : inputs.find(visible);
  if (!input || !visible(input)) return null;
  const candidatesIn = (scope) => [...scope.querySelectorAll("button,[role='button']")]
    .filter((node) => eligible(node) && !node.closest("#identifierNext,#passwordNext,#totpNext"));
  const scope = input && input.closest("form,[role='dialog']");
  if (scope) {
    const buttons = candidatesIn(scope);
    return buttons.length === 1 ? buttons[0] : null;
  }
  // Current Google sign-in cards need not use <form> or role=dialog. Walk only
  // this input's ancestors to find its own unique button, never the whole page.
  for (let card = input.parentElement; card && card !== doc.body && card !== doc.documentElement; card = card.parentElement) {
    const buttons = candidatesIn(card);
    if (buttons.length > 1) return null;
    if (buttons.length === 1) return buttons[0];
  }
  return null;
}

async function submitRecoveryEmail(page, account, deps = {}) {
  const label = deps.label || "login";
  const result = (reasonCode, detail, outcome = "need_verify") => ({ outcome, reasonCode, detail: { [label]: detail } });
  const read = deps.bodyText;
  const wait = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const observe = deps.observe || (async () => ({ url: page.url(), text: await read(page) }));
  const phaseOf = (snapshot) => classifyRecoveryEmail(snapshot.text, snapshot.url, snapshot.signals);
  // URL can switch before the new form hydrates. Wait for the current input,
  // and require stable reads instead of immediately stopping on stale code prose.
  let snapshot;
  let phase = "pending";
  let stable = 0;
  let lastState = "";
  const readyDeadline = Date.now() + (deps.readyTimeoutMs ?? 10000);
  for (let poll = 0; poll < Math.max(1, deps.readyPolls ?? 20); poll += 1) {
    snapshot = await observe(page);
    phase = phaseOf(snapshot);
    const state = `${snapshot.url.split("?")[0]}:${phase}`;
    stable = state === lastState ? stable + 1 : 1;
    lastState = state;
    if (deps.emit) deps.emit("recovery_email_state", { phase, addressInput: !!snapshot.signals?.addressInput, codeInput: !!snapshot.signals?.codeInput });
    if (!snapshot.signals || !phase || (phase === "confirm" && stable >= 2) || (phase === "code" && stable >= 3)) break;
    if (Date.now() >= readyDeadline) break;
    await wait(deps.pollMs ?? 300);
  }
  if (snapshot.signals && ((phase === "confirm" && stable < 2) || (phase === "code" && stable < 3))) phase = "pending";
  const before = snapshot.url;
  const text = snapshot.text;
  if (phase === "code") return result("recovery_email_code_required", "Google 要求到辅助邮箱查收验证码，需要人工收码；未填写邮箱地址或验证码");
  if (phase === "pending") return result("unknown_challenge", "辅助邮箱验证页尚未就绪或同时显示多种输入框，未填写或提交");
  if (phase !== "confirm") return result("unknown_challenge", "当前不是确认辅助邮箱地址的页面，已停止");
  const email = String(account.recoveryEmail || "").replace(/\\@/g, "@").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return result("recovery_email_missing", "Google 要求确认辅助邮箱，但账号未提供有效辅助邮箱地址");
  const accountEmails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  if (accountEmails.length && account.email && !accountEmails.some((v) => v.toLowerCase() === account.email.toLowerCase())) {
    return result("unknown_challenge", "验证页显示的账号与当前账号不一致，未填写辅助邮箱");
  }
  const selectors = snapshot.addressSelector ? [snapshot.addressSelector] : RECOVERY_EMAIL_SELECTORS;
  if (!await deps.fillField(page, selectors, email)
      || !await deps.ensureValue(page, selectors, email, { force: true })) {
    return result("unknown_challenge", "辅助邮箱输入框尚未就绪或无法填写，未提交");
  }
  // Recheck after filling/hydration. The page could have changed to an inbox-code
  // challenge; an address must never be submitted to that challenge's Next button.
  const ready = await observe(page);
  const readyPhase = phaseOf(ready);
  if (ready.url.split("?")[0] !== before.split("?")[0] || readyPhase !== "confirm") {
    return readyPhase === "code" ? result("recovery_email_code_required", "Google 已转到邮箱验证码验证，需人工收码；未继续提交")
      : result("unknown_challenge", "填写过程中页面已变化，未提交辅助邮箱");
  }
  let dispatched = false;
  try { dispatched = await deps.clickNext(page); } catch (_) {
    // Navigation can invalidate the click response after dispatch. Only observe;
    // never retry the submission or risk locking the account with repeated input.
    dispatched = true;
  }
  if (!dispatched) return result("unknown_challenge", "未找到辅助邮箱确认按钮，未重复提交");
  const deadline = Date.now() + (deps.totalMs ?? 12000);
  for (let poll = 0; poll < 30 && Date.now() <= deadline; poll += 1) {
    const current = await observe(page);
    const currentPhase = phaseOf(current);
    if (currentPhase === "code") return result("recovery_email_code_required", "确认邮箱后，Google 仍要求邮箱验证码，需人工收码");
    if (currentPhase === "confirm" && WRONG_EMAIL_RE.test(current.text)) return result("recovery_email_wrong", "辅助邮箱不匹配，已停止重试，请核对账号资料", "error");
    if (current.url.split("?")[0] !== before.split("?")[0]) return { advanced: true };
    await wait(deps.pollMs ?? 400);
  }
  return result("timeout", "辅助邮箱已提交一次，但未确认通过；已停止重复提交");
}

module.exports = { classifyRecoveryEmail, submitRecoveryEmail, inspectRecoveryEmailPage, findRecoveryEmailNext, RECOVERY_OPTION_RE, RECOVERY_EMAIL_SELECTORS, WRONG_EMAIL_RE };
