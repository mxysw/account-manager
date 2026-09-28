"use strict";

const assert = require("assert");

// Pure fixtures only: this suite never opens Google, sends SMS, or reads real accounts.
const EMAIL = "cloud-fixture@example.com";
const CHALLENGE_URL = "https://accounts.google.com/v3/signin/challenge/iap?TL=fixture-only";
const EXISTING_TEXT = "Get a verification code To get a verification code, first confirm the phone number that you added to your account •••••• •••48. Standard message and data rates may apply.";
const NEW_TEXT = "接收短信验证码 请输入电话号码，以便通过短信接收验证码。 Google 会存储此号码，但仅将它用于安全用途。您可能需要支付标准短信费和流量费。";
const NEW_ENGLISH_TEXT = "Receive an SMS code Enter a phone number to get a text message with a verification code. Phone number Google will store this number and only use it for security purposes. Standard message and data rates may apply.";
const KOREAN_SELECTION_TEXT = "계속하려면 정보를 확인하세요 인증 방법 선택 QR 코드 스캔 전화번호 인증 인증 코드를 사용하세요. SMS 요금이 적용됩니다.";
const KOREAN_EXISTING_TEXT = "인증 코드 받기 인증 코드를 받으려면 먼저 계정에 추가한 전화번호 •••••• •••48을 확인하세요. 일반 메시지 및 데이터 요금이 적용될 수 있습니다.";
const KOREAN_NEW_TEXT = "SMS 인증 코드 받기 인증 코드가 포함된 문자 메시지를 받으려면 전화번호를 입력하세요. Google은 이 번호를 저장하고 보안 목적으로만 사용합니다. 일반 메시지 및 데이터 요금이 적용될 수 있습니다.";
const CLOUD_CALLOUT_TEXT = "从上次停下的地方继续 使用新的“近期查看过”功能返回到以前访问过的页面和产品，从而节省时间。";
function phoneSnapshot(text = NEW_TEXT, extra = {}) {
  return { id: "challenge", url: CHALLENGE_URL, text, hasPhoneInput: true, hasCodeInput: false, hasCaptcha: false, controls: [], ...extra };
}
function assertNotNew(result, message) {
  assert.notStrictEqual(result && result.state, "new_number_allowed", message);
}

// Small DOM fixture in the same style as test/run.js's inspectPhoneDocument
// tests. It models document order and real selector-based lookup, including the
// stale transient attributes which previously redirected clicks behind dialogs.
function makeDomNode(tag = "div", text = "", attrs = {}, children = []) {
  const attributes = { ...attrs };
  const node = {
    tagName: tag.toUpperCase(), children, hidden: false, parentElement: null,
    value: attrs.value || "", labels: [], checked: false, disabled: false,
    type: attrs.type || "", name: attrs.name || "", id: attrs.id || "",
    autocomplete: attrs.autocomplete || "", placeholder: attrs.placeholder || "",
    selectedOptions: [],
    get innerText() { return [text, ...children.filter((child) => !child.hidden).map((child) => child.innerText)].filter(Boolean).join(" "); },
    get textContent() { return this.innerText; },
    getAttribute: (name) => Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null,
    setAttribute: (name, value) => { attributes[name] = String(value); },
    removeAttribute: (name) => { delete attributes[name]; },
    getBoundingClientRect: () => {
      let current = node;
      while (current) { if (current.hidden) return { width: 0, height: 0 }; current = current.parentElement; }
      return { width: 180, height: 36 };
    },
    matches(selector) {
      return selector.split(",").some((part) => {
        const source = part.trim();
        const tagMatch = source.match(/^[a-z][a-z0-9-]*/i);
        if (tagMatch && tagMatch[0].toLowerCase() !== tag.toLowerCase()) return false;
        const idMatch = source.match(/^#([\w-]+)/);
        if (idMatch && node.id !== idMatch[1]) return false;
        const classMatch = source.match(/^\.([\w-]+)/);
        if (classMatch && !String(attributes.class || "").split(/\s+/).includes(classMatch[1])) return false;
        for (const attr of source.matchAll(/\[([^\]=*]+)(?:(\*?=)["']?([^\]"']*)["']?)?\]/g)) {
          const value = node.getAttribute(attr[1]);
          if (value === null) return false;
          if (attr[2] === "=" && value !== attr[3]) return false;
          if (attr[2] === "*=" && !value.includes(attr[3])) return false;
        }
        return true;
      });
    },
    querySelectorAll(selector) {
      return children.flatMap((child) => [child, ...child.querySelectorAll("*")]).filter((child) => child.matches(selector));
    },
  };
  children.forEach((child) => { child.parentElement = node; });
  return node;
}
function withDom(body, fn, url = "https://console.cloud.google.com/welcome/new") {
  const oldDocument = global.document;
  const oldStyle = global.getComputedStyle;
  const document = { body, location: new URL(url), querySelectorAll: (selector) => body.querySelectorAll(selector) };
  global.document = document;
  global.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  try { return fn(document); } finally {
    global.document = oldDocument;
    global.getComputedStyle = oldStyle;
  }
}

module.exports = async function runCloudPhoneTests({ check, checkAsync, accounts }) {
  const detector = require("../src/automation/actions/detect-cloud-phone");
  const { classifyPhoneChallenge, runFlow, inspectDocument, createAdapter, localizedChallengeUrl } = detector.helpers;
  const selected = { phoneMethodSelected: true };

  check("Cloud 手机信号：用户提供的原号码确认文案命中需原号", () => {
    const result = classifyPhoneChallenge(phoneSnapshot(EXISTING_TEXT), selected);
    assert.strictEqual(result.state, "existing_phone_required");
    assert.ok(result.reasonCode);
    assert.ok(result.detail);
  });

  check("Cloud 手机信号：原号码证据优先于同页空手机号输入框", () => {
    const result = classifyPhoneChallenge(phoneSnapshot(`${EXISTING_TEXT} ${NEW_TEXT}`), selected);
    assert.strictEqual(result.state, "existing_phone_required");
  });

  check("Cloud 手机信号：已有号码收码和中文原号确认均属于需原号", () => {
    for (const text of [
      "Get a verification code Google will send a verification code to •••••• •••48.",
      "获取验证码 要获取验证码，请先确认您添加到账号中的电话号码 •••••• •••48。",
    ]) {
      assert.strictEqual(classifyPhoneChallenge(phoneSnapshot(text), selected).state, "existing_phone_required", text);
    }
  });

  check("Cloud 手机信号：明确的新号入口只标可填新号，不推断从未绑定", () => {
    const result = classifyPhoneChallenge(phoneSnapshot(), selected);
    assert.strictEqual(result.state, "new_number_allowed");
    assert.ok(/本次/.test(result.detail));
    assert.ok(/不代表|不能证明|无法证明/.test(result.detail), "本次允许输入新号码并不是历史绑定证明，应保留判断边界");
  });

  check("Cloud 手机信号：英文 Receive an SMS code 新号表单能识别", () => {
    const result = classifyPhoneChallenge(phoneSnapshot(NEW_ENGLISH_TEXT), selected);
    assert.strictEqual(result.state, "new_number_allowed");
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.stop, true);
  });

  check("Cloud 手机信号：账号邮箱中的 xx123 与 store 文案不能伪装成原号收码证据", () => {
    const result = classifyPhoneChallenge(phoneSnapshot(`xx123@example.com ${NEW_ENGLISH_TEXT}`), selected);
    assert.strictEqual(result.state, "new_number_allowed", "邮箱用户名不是掩码手机号，store 也不是短信发送目的地");
    assert.strictEqual(result.reasonCode, "new_number_allowed");
  });

  check("Cloud 手机信号：未确认的韩文表单不能仅凭号码输入框判断新号或原号", () => {
    for (const text of [
      KOREAN_EXISTING_TEXT,
      KOREAN_NEW_TEXT,
      "전화번호를 입력하세요.",
      "인증 코드가 포함된 문자 메시지를 받으려면 전화번호를 입력하세요.",
      "전화번호 Google은 이 번호를 저장하고 보안 목적으로만 사용합니다.",
      "Telefon numarası girin. Google bu numarayı saklar.",
    ]) {
      const ambiguous = classifyPhoneChallenge(phoneSnapshot(text), selected);
      assert.strictEqual(ambiguous.state, "unknown", text);
      assert.strictEqual(ambiguous.reasonCode, "ambiguous_phone_input", text);
    }
    assertNotNew(classifyPhoneChallenge(phoneSnapshot(KOREAN_NEW_TEXT), {}));
    assertNotNew(classifyPhoneChallenge(phoneSnapshot(KOREAN_NEW_TEXT, { hasPhoneInput: false }), selected));
    assertNotNew(classifyPhoneChallenge(phoneSnapshot(KOREAN_NEW_TEXT, { url: "https://accounts.google.com.example.net/v3/signin/challenge/iap" }), selected));
  });

  check("Cloud 本地化：仅修改可信挑战页的 hl，保留会话参数、目标与片段", () => {
    for (const path of ["/v3/signin/challenge/iap", "/uplevelingstep/selection"]) {
      const original = `https://accounts.google.com${path}?TL=fixture%2Btoken&continue=https%3A%2F%2Fconsole.cloud.google.com%2Fwelcome%3Fa%3D1&authuser=2&hl=ko&x=1&x=2#fixture-hash`;
      const result = localizedChallengeUrl(original);
      assert.ok(result);
      const before = new URL(original);
      const after = new URL(result);
      assert.strictEqual(after.origin, before.origin);
      assert.strictEqual(after.pathname, before.pathname);
      assert.strictEqual(after.hash, before.hash);
      assert.strictEqual(after.searchParams.get("hl"), "zh-CN");
      before.searchParams.delete("hl");
      after.searchParams.delete("hl");
      assert.deepStrictEqual([...after.searchParams], [...before.searchParams]);
    }
    for (const url of [
      `${CHALLENGE_URL}&hl=zh-CN`,
      "https://accounts.google.com.example.net/v3/signin/challenge/iap?hl=ko",
      "http://accounts.google.com/v3/signin/challenge/iap?hl=ko",
      "https://accounts.google.com/ServiceLogin?hl=ko",
      "https://myaccount.google.com/two-step-verification?hl=ko",
      "not-a-url",
    ]) assert.strictEqual(localizedChallengeUrl(url), "", url);
  });

  check("Cloud 手机信号：新号结论必须有已选择电话方式和真实输入框", () => {
    assertNotNew(classifyPhoneChallenge(phoneSnapshot(), {}), "尚未选择电话验证不能推出可填新号");
    assertNotNew(classifyPhoneChallenge(phoneSnapshot(NEW_TEXT, { hasPhoneInput: false }), selected), "页面文案而无实际输入框不能推出可填新号");
    assertNotNew(classifyPhoneChallenge(phoneSnapshot("接收短信验证码 电话号码"), selected), "通用输入框不能证明允许新号");
  });

  check("Cloud 手机信号：只接受可信 Google 账号挑战页", () => {
    for (const url of [
      "https://accounts.google.com.example.net/v3/signin/challenge/iap",
      "https://example.net/v3/signin/challenge/iap",
      "https://myaccount.google.com/phone",
      "https://console.cloud.google.com/welcome/new",
      "https://accounts.google.com/ServiceLogin",
      "http://accounts.google.com/v3/signin/challenge/iap",
      "not-a-url",
    ]) {
      assertNotNew(classifyPhoneChallenge(phoneSnapshot(NEW_TEXT, { url }), selected), url);
      const existing = classifyPhoneChallenge(phoneSnapshot(EXISTING_TEXT, { url }), selected);
      assert.notStrictEqual(existing && existing.state, "existing_phone_required", url);
    }
  });

  check("Cloud 手机信号：人机、验证码和设备提示不误报可填新号", () => {
    const captcha = classifyPhoneChallenge(phoneSnapshot(NEW_TEXT, { hasCaptcha: true }), selected);
    assert.strictEqual(captcha.state, "unknown");
    assert.strictEqual(captcha.reasonCode, "captcha");
    const code = classifyPhoneChallenge(phoneSnapshot(NEW_TEXT, { hasCodeInput: true }), selected);
    assert.strictEqual(code.state, "unknown");
    assert.strictEqual(code.reasonCode, "verification_code_required");
    assertNotNew(classifyPhoneChallenge(phoneSnapshot("Check your phone Google sent a notification to your device. Tap Yes to verify it's you.", { hasPhoneInput: false }), selected));
    assertNotNew(classifyPhoneChallenge(phoneSnapshot("", { hasPhoneInput: false }), selected));
  });

  check("Cloud DOM：电话字段与验证码字段按输入语义区分，不受正文收码说明污染", () => {
    const phone = makeDomNode("input", "", { type: "tel", id: "phoneNumberId", autocomplete: "tel", "aria-label": "Phone number" });
    let body = makeDomNode("body", "Enter a phone number to receive a verification code by SMS", {}, [phone]);
    let snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.hasPhoneInput, true);
    assert.strictEqual(snapshot.hasCodeInput, false);
    const code = makeDomNode("input", "", { type: "tel", id: "idvAnyPhonePin", autocomplete: "one-time-code", "aria-label": "Verification code" });
    body = makeDomNode("body", "Enter the verification code", {}, [code]);
    snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.hasCodeInput, true);
    assert.strictEqual(snapshot.hasPhoneInput, false, "验证码使用 type=tel 也不能被认作号码输入框");
    phone.hidden = true;
    body = makeDomNode("body", "Loading", {}, [phone]);
    snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.hasPhoneInput, false, "隐藏的旧手机号输入框不算当前页面证据");
  });

  check("Cloud DOM：韩文电话字段与验证码字段互斥，正文验证码不污染电话字段", () => {
    const phone = makeDomNode("input", "", { type: "text", "aria-label": "전화번호" });
    let snapshot = withDom(makeDomNode("body", KOREAN_NEW_TEXT, {}, [phone]), inspectDocument);
    assert.strictEqual(snapshot.hasPhoneInput, true);
    assert.strictEqual(snapshot.hasCodeInput, false);
    const code = makeDomNode("input", "", { type: "tel", "aria-label": "인증 코드" });
    snapshot = withDom(makeDomNode("body", "전화번호로 전송된 인증 코드를 입력하세요.", {}, [code]), inspectDocument);
    assert.strictEqual(snapshot.hasCodeInput, true);
    assert.strictEqual(snapshot.hasPhoneInput, false);
    const result = classifyPhoneChallenge({ ...phoneSnapshot(KOREAN_NEW_TEXT), ...snapshot }, selected);
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "verification_code_required");
    code.hidden = true;
    snapshot = withDom(makeDomNode("body", KOREAN_NEW_TEXT, {}, [phone, code]), inspectDocument);
    assert.strictEqual(snapshot.hasPhoneInput, true);
    assert.strictEqual(snapshot.hasCodeInput, false, "隐藏的旧验证码输入框不能阻塞当前号码页");
  });

  check("Cloud DOM：地区字段的 aria-label 是标题，实际选择值独立读取", () => {
    const country = makeDomNode("div", "United States", { role: "combobox", "aria-label": "Country/region" });
    let body = makeDomNode("body", "Country/region Terms of Service", {}, [country]);
    let snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.controls[0].kind, "country");
    assert.strictEqual(snapshot.controls[0].label, "Country/region");
    assert.strictEqual(snapshot.controls[0].value, "United States");
    const empty = makeDomNode("div", "", { role: "combobox", "aria-label": "Country/region" });
    body = makeDomNode("body", "Country/region Terms of Service", {}, [empty]);
    snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.controls[0].value, "", "仅字段标题存在不能伪装已选地区");
    const select = makeDomNode("select", "", { "aria-label": "国家/地区" });
    select.selectedOptions = [{ textContent: "香港" }];
    body = makeDomNode("body", "国家/地区 服务条款", {}, [select]);
    snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.controls[0].value, "香港");
  });

  function calloutDocument(options = {}) {
    const { text = CLOUD_CALLOUT_TEXT, attrs = {}, closeLabels = ["关闭标注"], extraChildren = [], otherDialogs = [], disabled = false } = options;
    const closeButtons = closeLabels.map((label) => makeDomNode("button", "", { "aria-label": label, ...(disabled ? { "aria-disabled": "true" } : {}) }));
    const dialog = makeDomNode("div", text, { class: "cfc-callout", role: "dialog", "aria-modal": "false", ...attrs }, [...closeButtons, ...extraChildren]);
    return makeDomNode("body", "Google Cloud", {}, [makeDomNode("button", "Activate Cloud Shell"), ...otherDialogs, dialog]);
  }

  check("Cloud 提示 DOM：可信控制台的已知非模态引导只关联唯一精确关闭按钮", () => {
    for (const label of ["关闭标注", "Close callout", "關閉標註"]) {
      const snapshot = withDom(calloutDocument({ closeLabels: [label] }), inspectDocument);
      assert.ok(snapshot.cloudCallout);
      assert.strictEqual(snapshot.cloudCallout.key, CLOUD_CALLOUT_TEXT);
      assert.ok(snapshot.cloudCallout.closeControlId);
      assert.deepStrictEqual(snapshot.controls.map((control) => control.label), [label], "提示在前景时不能暴露背景 Cloud Shell 按钮");
      assert.strictEqual(snapshot.cloudCallout.closeControlId, snapshot.controls[0].id);
    }
    const production = withDom(calloutDocument({ text: "这是生产环境吗 请标记生产环境，以便保护重要资源。" }), inspectDocument);
    assert.ok(production.cloudCallout, "第二个已观察到的生产环境提示也可关闭");
  });

  check("Cloud 提示 DOM：多个关闭候选、禁用或非精确标签均不能猜测按钮", () => {
    for (const options of [
      { closeLabels: ["关闭标注", "Close callout"] },
      { closeLabels: ["关闭标注"], disabled: true },
      { closeLabels: ["关闭"] },
      { closeLabels: ["关闭标注并继续"] },
      { closeLabels: [] },
    ]) {
      const snapshot = withDom(calloutDocument(options), inspectDocument);
      assert.ok(snapshot.cloudCallout);
      assert.strictEqual(snapshot.cloudCallout.closeControlId, "", JSON.stringify(options));
    }
  });

  check("Cloud 提示 DOM：未知、条款、授权、输入表单及真实模态框均不可当作引导关闭", () => {
    for (const options of [
      { text: "未知功能引导" },
      { text: "服务条款 同意并继续" },
      { text: "Authorize Cloud Shell Cloud Shell needs permission to use your credentials" },
      { attrs: { class: "generic-dialog" } },
      { attrs: { "aria-modal": "true" } },
      { extraChildren: [makeDomNode("input", "", { type: "text" })] },
      { otherDialogs: [makeDomNode("div", "服务条款", { role: "dialog", "aria-modal": "true" })] },
      { otherDialogs: [makeDomNode("div", "未知验证", { role: "dialog", "aria-modal": "false" })] },
    ]) assert.ok(!withDom(calloutDocument(options), inspectDocument).cloudCallout, JSON.stringify(options.text || options.attrs || "blocking form/dialog"));
    for (const url of [
      "https://accounts.google.com/v3/signin/challenge/iap",
      "https://console.cloud.google.com.example.net/welcome/new",
      "http://console.cloud.google.com/welcome/new",
      "https://shell.cloud.google.com/",
    ]) assert.ok(!withDom(calloutDocument(), inspectDocument, url).cloudCallout, url);
  });

  await checkAsync("Cloud DOM：出现对话框后清除旧控制标识，实际点击不能落在背景按钮", async () => {
    const shell = makeDomNode("button", "Activate Cloud Shell");
    const continueButton = makeDomNode("button", "Continue");
    const dialog = makeDomNode("div", "Cloud Shell is free for all users.", { role: "dialog" }, [continueButton]);
    dialog.hidden = true;
    const body = makeDomNode("body", "Google Cloud", {}, [shell, dialog]);
    const clicked = [];
    const frame = {
      url: () => "https://console.cloud.google.com/welcome/new",
      evaluate: async (fn) => withDom(body, fn),
      $: async (selector) => {
        const match = body.querySelectorAll(selector)[0];
        return match ? { click: async () => { clicked.push(match); }, dispose: async () => {} } : null;
      },
    };
    const page = { on: () => {}, off: () => {}, isClosed: () => false, frames: () => [frame] };
    const adapter = createAdapter(page, {});
    try {
      const first = await adapter.snapshots();
      assert.strictEqual(first[0].controls[0].label, "Activate Cloud Shell");
      const firstId = shell.getAttribute("data-cloud-phone-control");
      assert.ok(firstId);
      dialog.hidden = false;
      const second = await adapter.snapshots();
      assert.strictEqual(second[0].controls.length, 1);
      assert.strictEqual(second[0].controls[0].label, "Continue");
      assert.strictEqual(shell.getAttribute("data-cloud-phone-control"), null, "背景按钮遗留标识必须撤销");
      assert.ok(await adapter.click(second[0].id, second[0].controls[0].id));
      assert.deepStrictEqual(clicked, [continueButton], "frame.$ 应唯一选中前景按钮，即使编号复用");
    } finally { adapter.dispose(); }
  });

  check("Cloud 手机检测数据：未知状态降级、保留证据时间并脱敏", () => {
    assert.strictEqual(accounts.normalizeCloudPhoneCheck(null), null);
    assert.strictEqual(accounts.normalizeCloudPhoneCheck([]), null);
    const normalized = accounts.normalizeCloudPhoneCheck({
      state: "existing_phone_required", reasonCode: "existing_phone_required",
      detail: "确认号码 +1 202 555 0123 https://accounts.google.com/v3/signin/challenge/iap?TL=secret-token#fragment",
      checkedAt: "2026-09-08T01:02:03.000Z", arbitraryField: "must-not-persist",
    });
    assert.strictEqual(normalized.state, "existing_phone_required");
    assert.strictEqual(normalized.checkedAt, "2026-09-08T01:02:03.000Z");
    assert.ok(!normalized.detail.includes("secret-token"));
    assert.ok(!normalized.detail.includes("202 555"));
    assert.strictEqual(normalized.arbitraryField, undefined);
    assert.strictEqual(accounts.normalizeCloudPhoneCheck({ state: "never_bound" }).state, "unknown");
    assert.ok(accounts.normalizeCloudPhoneCheck({ checkedAt: "invalid" }).checkedAt);
  });

  check("Cloud 手机检测数据：结果持久化且复原检测后清空", () => {
    const imported = accounts.importText(`${EMAIL}----fixture-password`);
    const account = accounts.list().find((item) => item.email === EMAIL);
    assert.ok(imported.added > 0 && account);
    try {
      assert.strictEqual(account.lastCloudPhoneCheck, null);
      accounts.update(account.id, { lastCloudPhoneCheck: { state: "existing_phone_required", reasonCode: "existing_phone_required", detail: "要求原号码" } });
      assert.strictEqual(accounts.getById(account.id).lastCloudPhoneCheck.state, "existing_phone_required");
      accounts.update(account.id, { lastCloudPhoneCheck: { state: "unknown", reasonCode: "captcha", detail: "人机验证" } });
      assert.strictEqual(accounts.getById(account.id).lastCloudPhoneCheck.state, "unknown", "重测未确认不能沿用上一次确定结果");
      accounts.update(account.id, { lastCloudPhoneCheck: { state: "unknown", reasonCode: "qr_verification_required", detail: "需扫码验证；原号未确认" } });
      assert.strictEqual(accounts.getById(account.id).lastCloudPhoneCheck.state, "unknown");
      assert.strictEqual(accounts.getById(account.id).lastCloudPhoneCheck.reasonCode, "qr_verification_required", "扫码原因必须保留供账号库和日志显示");
      accounts.resetStatus([account.id]);
      assert.strictEqual(accounts.getById(account.id).lastCloudPhoneCheck, null);
    } finally {
      accounts.remove([account.id]);
    }
  });

  function fixtureAdapter(stages, transitions, delayed = {}, localizations) {
    let stage = 0;
    let pending = null;
    const calls = [];
    return {
      calls,
      open: async (url) => { calls.push(["open", url]); },
      snapshots: async () => stages[stage],
      click: async (scopeId, controlId) => {
        const key = `${scopeId}:${controlId}`;
        calls.push(["click", key]);
        assert.ok(Object.prototype.hasOwnProperty.call(transitions, key), `意外点击 ${key}：不得提交号码、发送短信或点击免费试用`);
        if (delayed[key]) pending = { stage: transitions[key], waits: delayed[key] };
        else stage = transitions[key];
        return true;
      },
      localize: localizations ? async (scopeId) => {
        calls.push(["localize", scopeId]);
        assert.ok(Object.prototype.hasOwnProperty.call(localizations, scopeId), `意外本地化 ${scopeId}`);
        stage = localizations[scopeId];
        return true;
      } : undefined,
      wait: async () => {
        if (pending && --pending.waits <= 0) { stage = pending.stage; pending = null; }
      },
      emit: () => {},
    };
  }
  function workflow(finalSnapshot) {
    const consoleBase = { id: "console", url: "https://console.cloud.google.com/welcome/new?hl=zh-CN", hasPhoneInput: false, hasCodeInput: false, hasCaptcha: false };
    return [
      [{ ...consoleBase, text: `Google Cloud ${EMAIL}`, controls: [{ id: "shell", label: "Activate Cloud Shell", kind: "button" }, { id: "trial", label: "Start free", kind: "button" }] }],
      [{ ...consoleBase, text: "Cloud Shell Manage your infrastructure and develop your applications from any browser with Cloud Shell. Cloud Shell is free for all users.", controls: [{ id: "continue", label: "Continue", kind: "button" }] }],
      [{ ...consoleBase, text: "Verify your account Verify your account to start using Cloud Shell. Click refresh after verification to proceed.", controls: [{ id: "verify", label: "Verify", kind: "button" }, { id: "refresh", label: "Refresh", kind: "button", disabled: true }] }],
      [{ id: "selection", url: "https://accounts.google.com/uplevelingstep/selection?TL=fixture", text: `验证您的信息后才能继续 ${EMAIL} 选择一种方法进行验证 扫描二维码 验证您的电话号码 使用验证码。需要支付短信费用。`, controls: [{ id: "phone", label: "验证您的电话号码", kind: "button" }, { id: "qr", label: "扫描二维码", kind: "button" }] }],
      [{ ...finalSnapshot, controls: [{ id: "next", label: "下一步", kind: "button" }, { id: "send", label: "Send", kind: "button" }] }],
    ];
  }
  const transitions = { "console:shell": 1, "console:continue": 2, "console:verify": 3, "selection:phone": 4 };

  function calloutSnapshot(key = CLOUD_CALLOUT_TEXT, closeControlId = "close-callout") {
    return {
      id: "console", url: "https://console.cloud.google.com/welcome/new?hl=zh-CN", text: key,
      cloudCallout: { key, closeControlId },
      controls: closeControlId ? [{ id: closeControlId, label: "关闭标注", kind: "button" }] : [],
    };
  }

  await checkAsync("Cloud 提示流程：关闭已知引导后重新观察，再进入正常 Cloud Shell 检测", async () => {
    const stages = [[calloutSnapshot()], ...workflow(phoneSnapshot())];
    const shifted = Object.fromEntries(Object.entries(transitions).map(([key, stage]) => [key, stage + 1]));
    const allowed = { "console:close-callout": 1, ...shifted };
    const adapter = fixtureAdapter(stages, allowed);
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click").map((call) => call[1]), Object.keys(allowed));
  });

  await checkAsync("Cloud 提示流程：连续不同引导各关闭一次，最多处理五个", async () => {
    for (const count of [2, 6]) {
      const hints = Array.from({ length: count }, (_, index) => [calloutSnapshot(`${CLOUD_CALLOUT_TEXT} 提示 ${index + 1}`, `close-callout-${index + 1}`)]);
      const shifted = Object.fromEntries(Object.entries(transitions).map(([key, stage]) => [key, stage + count]));
      const closeTransitions = Object.fromEntries(hints.map((_, index) => [`console:close-callout-${index + 1}`, index + 1]));
      const adapter = fixtureAdapter([...hints, ...workflow(phoneSnapshot())], { ...closeTransitions, ...shifted });
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
      assert.strictEqual(result.state, count === 2 ? "new_number_allowed" : "unknown");
      if (count === 6) assert.strictEqual(result.reasonCode, "cloud_callout_blocked");
      const closeCalls = adapter.calls.filter((call) => String(call[1]).includes("close-callout-"));
      assert.strictEqual(closeCalls.length, Math.min(count, 5));
      assert.strictEqual(new Set(closeCalls.map((call) => call[1])).size, closeCalls.length);
    }
  });

  await checkAsync("Cloud 提示流程：关闭后一直无反馈不重复点击，缺关闭按钮时也不猜测", async () => {
    for (const closeId of ["close-callout", ""]) {
      const adapter = fixtureAdapter([[calloutSnapshot(CLOUD_CALLOUT_TEXT, closeId)]], closeId ? { "console:close-callout": 0 } : {});
      let reads = 0;
      const read = adapter.snapshots;
      adapter.snapshots = async () => { reads += 1; return read(); };
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
      assert.strictEqual(result.state, "unknown");
      assert.strictEqual(result.reasonCode, "cloud_callout_blocked");
      assert.ok(reads <= 9, "同一引导不得占满整个任务观察预算");
      assert.strictEqual(adapter.calls.filter((call) => call[0] === "click").length, closeId ? 1 : 0);
    }
  });

  await checkAsync("Cloud 流程：控制台至新号入口即停止，绝不提交号码或发送短信", async () => {
    const adapter = fixtureAdapter(workflow(phoneSnapshot()), transitions);
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click").map((call) => call[1]), Object.keys(transitions));
    assert.strictEqual(adapter.calls.filter((call) => call[0] === "open").length, 1);
  });

  function koreanWorkflow(finalSnapshot) {
    const stages = workflow(finalSnapshot);
    stages[3][0] = {
      ...stages[3][0], text: `${KOREAN_SELECTION_TEXT} ${EMAIL}`,
      controls: [
        { id: "qr", label: "QR 코드 스캔 휴대전화를 사용하여 코드를 스캔하세요.", kind: "button" },
        { id: "phone", label: "전화번호 인증 인증 코드를 사용하세요. SMS 요금이 적용됩니다.", kind: "button" },
      ],
    };
    stages[4][0].controls = [
      { id: "next", label: "다음", kind: "button" },
      { id: "send", label: "보내기", kind: "button" },
    ];
    return stages;
  }

  await checkAsync("Cloud 流程：韩文选电话验证一次，表单本地化后识别结果且不提交号码", async () => {
    for (const [before, after, expected] of [[KOREAN_NEW_TEXT, NEW_TEXT, "new_number_allowed"], [KOREAN_EXISTING_TEXT, EXISTING_TEXT, "existing_phone_required"]]) {
      const stages = koreanWorkflow(phoneSnapshot(before, { url: `${CHALLENGE_URL}&hl=ko` }));
      stages.push([phoneSnapshot(after, { url: `${CHALLENGE_URL}&hl=zh-CN`, controls: stages[4][0].controls })]);
      const adapter = fixtureAdapter(stages, transitions, { "selection:phone": 3 }, { challenge: 5 });
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
      assert.strictEqual(result.state, expected);
      assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click").map((call) => call[1]), Object.keys(transitions));
      assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 1);
      assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "localize"), [["localize", "challenge"]]);
    }
  });

  await checkAsync("Cloud 流程：本地化后的韩文旧 DOM 延迟两轮再翻译，只观察不重复导航点击", async () => {
    for (const [translatedText, expected] of [[NEW_TEXT, "new_number_allowed"], [EXISTING_TEXT, "existing_phone_required"]]) {
      const translatedUrl = `${CHALLENGE_URL}&hl=zh-CN`;
      const stages = koreanWorkflow(phoneSnapshot(KOREAN_NEW_TEXT, { url: `${CHALLENGE_URL}&hl=ko` }));
      stages.push([phoneSnapshot(translatedText, { url: translatedUrl, controls: stages[4][0].controls })]);
      const adapter = fixtureAdapter(stages, transitions, {}, { challenge: 5 });
      const read = adapter.snapshots;
      const localize = adapter.localize;
      let localized = false;
      let readsAfterLocalization = 0;
      adapter.localize = async (scopeId) => {
        const result = await localize(scopeId);
        localized = true;
        return result;
      };
      adapter.snapshots = async () => {
        // Navigation completed and hl changed, but the rendered form is still
        // Korean for two observations while Google's client hydrates the page.
        if (localized && ++readsAfterLocalization <= 2) return [{ ...stages[4][0], url: translatedUrl }];
        return read();
      };
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
      assert.strictEqual(result.state, expected);
      assert.ok(readsAfterLocalization >= 3, "不能看到本地化后的首轮旧 DOM 就提前退出");
      assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "localize"), [["localize", "challenge"]]);
      assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click").map((call) => call[1]), Object.keys(transitions));
    }
  });

  await checkAsync("Cloud 流程：韩文选择页如账号不符则不点电话验证", async () => {
    const stages = koreanWorkflow(phoneSnapshot(KOREAN_NEW_TEXT));
    stages[3][0].text = stages[3][0].text.replace(EMAIL, "other-locale-fixture@example.com");
    const adapter = fixtureAdapter(stages, transitions);
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "account_mismatch");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 0);
  });

  await checkAsync("Cloud 流程：未知语言验证选项不能猜位置点击或推断未绑定", async () => {
    const stages = koreanWorkflow(phoneSnapshot(KOREAN_NEW_TEXT));
    stages[3][0].controls[1].label = "Méthode de vérification inconnue";
    const adapter = fixtureAdapter(stages, transitions);
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 15 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone" || call[1] === "selection:qr").length, 0);
  });

  await checkAsync("Cloud 流程：未知语言选项本地化为中文后才选择电话验证", async () => {
    const stages = workflow(phoneSnapshot());
    const original = stages[3][0];
    stages[3] = [{ ...original, url: `${original.url}&hl=de`, text: `Unbekannte Bestätigungsmethode ${EMAIL}`, controls: [{ id: "qr", label: "QR-Code scannen", kind: "button" }, { id: "phone", label: "Unbekannte Methode", kind: "button" }] }];
    stages.push([{ ...original, url: `${original.url}&hl=zh-CN` }]);
    const adapter = fixtureAdapter(stages, transitions, {}, { selection: 5 });
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "localize"), [["localize", "selection"]]);
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 1);
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:qr").length, 0);
  });

  await checkAsync("Cloud 流程：本地化未生效仅尝试一次，仍未确认不推断可填新号", async () => {
    const stages = koreanWorkflow(phoneSnapshot(KOREAN_NEW_TEXT, { url: `${CHALLENGE_URL}&hl=ko` }));
    const adapter = fixtureAdapter(stages, transitions, {}, { challenge: 4 });
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "ambiguous_phone_input");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "localize"), [["localize", "challenge"]]);
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 1);
  });

  await checkAsync("Cloud 流程：人机、验证码、账号不符均不得触发语言重试", async () => {
    for (const [extra, expected] of [[{ hasCaptcha: true }, "captcha"], [{ hasCodeInput: true }, "verification_code_required"], [{ text: "other-localization-account@example.com" }, "account_mismatch"]]) {
      const stages = koreanWorkflow(phoneSnapshot(KOREAN_NEW_TEXT, { url: `${CHALLENGE_URL}&hl=ko`, ...extra }));
      const adapter = fixtureAdapter(stages, transitions, {}, {});
      const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
      assert.strictEqual(result.state, "unknown");
      assert.strictEqual(result.reasonCode, expected);
      assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "localize"), []);
    }
  });

  await checkAsync("Cloud 流程：激活按钮带键盘快捷键后缀也能打开终端", async () => {
    const stages = workflow(phoneSnapshot(NEW_ENGLISH_TEXT));
    stages[0][0].controls[0].label = "激活 Cloud Shell (G then S)";
    const adapter = fixtureAdapter(stages, transitions);
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "console:shell").length, 1);
  });

  await checkAsync("Cloud 流程：点击前元素替换返回 false 时重新观察后有限重试", async () => {
    const adapter = fixtureAdapter(workflow(phoneSnapshot()), transitions);
    const inspect = adapter.snapshots;
    const click = adapter.click;
    let reads = 0;
    const attempts = [];
    adapter.snapshots = async () => {
      reads += 1;
      return (await inspect()).map((scope) => ({ ...scope, controls: (scope.controls || []).map((control) => control.id === "shell" ? { ...control, id: `shell-fresh-${reads}` } : control) }));
    };
    adapter.click = async (scopeId, controlId) => {
      if (controlId.startsWith("shell-fresh-")) {
        attempts.push({ controlId, reads });
        if (attempts.length === 1) return false; // Nothing was dispatched.
        return click(scopeId, "shell");
      }
      return click(scopeId, controlId);
    };
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.strictEqual(attempts.length, 2);
    assert.ok(attempts[1].reads > attempts[0].reads, "重试前必须刷新页面快照");
    assert.notStrictEqual(attempts[1].controlId, attempts[0].controlId, "不能盲目重复旧元素标识");

    const absent = fixtureAdapter(workflow(phoneSnapshot()), transitions);
    let missingAttempts = 0;
    absent.click = async () => { missingAttempts += 1; return false; };
    const exhausted = await runFlow(absent, { accountEmail: EMAIL, maxPolls: 20 });
    assert.strictEqual(exhausted.state, "unknown");
    assert.strictEqual(exhausted.reasonCode, "timeout");
    assert.strictEqual(missingAttempts, 3, "元素持续缺失最多尝试 3 次，不能无限点击");
  });

  await checkAsync("Cloud 流程：点击已推进页面后抛导航异常，只观察结果不再次点击", async () => {
    const adapter = fixtureAdapter(workflow(phoneSnapshot(EXISTING_TEXT)), transitions);
    const click = adapter.click;
    adapter.click = async (scopeId, controlId) => {
      const result = await click(scopeId, controlId);
      if (scopeId === "selection" && controlId === "phone") throw new Error("Execution context was destroyed after navigation");
      return result;
    };
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "existing_phone_required");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 1, "可能已派发的点击不能重试");
  });

  await checkAsync("Cloud 流程：API 凭据授权不是电话检测，标未确认并零授权点击", async () => {
    const adapter = fixtureAdapter([[{
      id: "authorization", url: "https://shell.cloud.google.com/", text: "Authorize Cloud Shell Cloud Shell needs permission to use your credentials to make Google Cloud API calls. Click Authorize to grant permission to this and future calls.",
      controls: [{ id: "authorize", label: "Authorize", kind: "button" }, { id: "cancel", label: "Cancel", kind: "button" }],
    }]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 5 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "cloud_authorization_required");
    assert.strictEqual(result.outcome, "ok", "未出现电话验证不是登录失败，也不需要人工接管 API 授权");
    assert.strictEqual(result.stop, true);
    assert.strictEqual(adapter.calls.filter((call) => call[0] === "click").length, 0);
  });

  await checkAsync("Cloud 流程：页面异常保存简短未确认结果，不泄露异常 URL 令牌", async () => {
    const adapter = fixtureAdapter([], {});
    adapter.open = async () => { throw new Error("Navigation failed https://accounts.google.com/ServiceLogin?TL=secret-fixture-token"); };
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 5 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "page_error");
    assert.ok(!JSON.stringify(result).includes("secret-fixture-token"));
  });

  await checkAsync("Cloud 流程：旧号确认页只记录需原号，延迟跳转不重复点电话验证", async () => {
    const adapter = fixtureAdapter(workflow(phoneSnapshot(EXISTING_TEXT)), transitions, { "selection:phone": 3 });
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "existing_phone_required");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 1);
  });

  await checkAsync("Cloud 流程：未同意首次开通条款时停在未确认，不擅自勾选", async () => {
    const adapter = fixtureAdapter([[{
      id: "console", url: "https://console.cloud.google.com/welcome/new", text: `Google Cloud 欢迎使用 国家/地区 服务条款 ${EMAIL}`,
      controls: [{ id: "country", label: "国家/地区", kind: "country" }, { id: "terms", label: "我同意 Google Cloud Platform 服务条款", kind: "checkbox", checked: false }, { id: "agree", label: "同意并继续", kind: "button", disabled: true }],
    }]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: false, maxPolls: 5 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(adapter.calls.filter((call) => call[0] === "click").length, 0);
  });

  function onboardingSnapshot(email, countryText, extras = {}) {
    const country = makeDomNode("div", countryText, { role: "combobox", "aria-label": extras.countryLabel || "Country/region" });
    const language = extras.languageText === undefined ? []
      : [makeDomNode("div", extras.languageText, { role: "combobox", "aria-label": "Language" })];
    const checkbox = makeDomNode("input", "", { type: "checkbox", "aria-label": "I agree to Google Cloud Terms of Service" });
    const agree = makeDomNode("button", "Agree and continue");
    const dialog = makeDomNode("div", `Welcome ${email} Country/region Terms of Service`, { role: "dialog" }, [...language, country, checkbox, agree]);
    const body = makeDomNode("body", "Google Cloud", {}, [dialog]);
    return { id: "welcome", url: "https://console.cloud.google.com/welcome/new", ...withDom(body, inspectDocument) };
  }

  await checkAsync("Cloud 首页：正文提到地区和条款但终端已就绪时不误报需选地区", async () => {
    const terminal = makeDomNode("div", "Welcome to Cloud Shell. Type help to get started. $", { class: "xterm-screen" });
    const body = makeDomNode("body", `Google Cloud ${EMAIL} Country/region Terms of Service`, {}, [terminal]);
    const snapshot = { id: "console", url: "https://console.cloud.google.com/welcome/new?cloudshell=true", ...withDom(body, inspectDocument) };
    assert.strictEqual(snapshot.terminalReady, true);
    const adapter = fixtureAdapter([[snapshot]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 5 });
    assert.strictEqual(result.reasonCode, "no_challenge", "普通首页全文不能当作首次设置弹窗");
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click"), []);
  });

  await checkAsync("Cloud 首页：未弹设置框但正文含地区和条款时仍能打开终端", async () => {
    const shell = makeDomNode("button", "Activate Cloud Shell");
    const body = makeDomNode("body", `Google Cloud ${EMAIL} Country/region Terms of Service`, {}, [shell]);
    const first = { id: "console", url: "https://console.cloud.google.com/welcome/new", ...withDom(body, inspectDocument) };
    const stages = workflow(phoneSnapshot());
    stages[0] = [first];
    const adapter = fixtureAdapter(stages, { "console:cloud-phone-0": 1, ...transitions });
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed", "无首次设置控件时不应阻塞 Cloud Shell");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "console:cloud-phone-0").length, 1);
  });

  await checkAsync("Cloud 首次设置：地区默认值稍后加载时等待已选值再继续", async () => {
    const empty = onboardingSnapshot(EMAIL, "");
    const selected = onboardingSnapshot(EMAIL, "United States");
    const checked = { ...selected, controls: selected.controls.map((control) => control.kind === "checkbox"
      ? { ...control, checked: true } : control.label === "Agree and continue" ? { ...control, disabled: false } : control) };
    const stages = [[selected], [checked], ...workflow(phoneSnapshot())];
    const adapter = fixtureAdapter(stages, {
      "welcome:cloud-phone-1": 1, "welcome:cloud-phone-2": 2,
      "console:shell": 3, "console:continue": 4, "console:verify": 5, "selection:phone": 6,
    });
    const snapshots = adapter.snapshots;
    let reads = 0;
    adapter.snapshots = async () => (++reads <= 2 ? [empty] : snapshots());
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.ok(reads >= 3, "未选地区的瞬时页面应重新观察");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click").map((call) => call[1]).slice(0, 2),
      ["welcome:cloud-phone-1", "welcome:cloud-phone-2"], "仅已选地区加载后才可碰条款，绝不代选地区");
  });

  await checkAsync("Cloud 首次设置：地区一直为空时有限等待且绝不碰条款", async () => {
    const adapter = fixtureAdapter([[onboardingSnapshot(EMAIL, "")]], {});
    let reads = 0;
    const snapshots = adapter.snapshots;
    adapter.snapshots = async () => { reads += 1; return snapshots(); };
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 8 });
    assert.strictEqual(result.reasonCode, "country_required");
    assert.ok(reads > 1 && reads <= 8, "空值应有限重读，不能瞬断或无限等候");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click"), []);
  });

  check("Cloud 首次设置 DOM：Country/region United States 混合文本仍读出已选地区", () => {
    const snapshot = onboardingSnapshot(EMAIL, "Country/region United States");
    const country = snapshot.controls.find((control) => control.kind === "country");
    assert.ok(country);
    assert.strictEqual(country.value, "United States");
  });

  check("Cloud 首次设置 DOM：实际 cfc-select 已显示美国但 value 为空仍读出地区", () => {
    const country = makeDomNode("div", "美国", {
      class: "cfc-select", role: "combobox", "aria-labelledby": "tos-country-of-residence", value: "",
    });
    const dialog = makeDomNode("div", `Welcome ${EMAIL} Country/region Terms of Service`, { role: "dialog" }, [country]);
    const body = makeDomNode("body", "Google Cloud", {}, [dialog]);
    const snapshot = withDom(body, inspectDocument);
    assert.strictEqual(snapshot.controls.length, 1);
    assert.strictEqual(snapshot.controls[0].kind, "country");
    assert.strictEqual(snapshot.controls[0].value, "美国", "空 value 属性不能盖掉已渲染的国家文本");
  });

  await checkAsync("Cloud 首次设置：两个同名条款勾选框不能猜选其一", async () => {
    const country = makeDomNode("div", "United States", { role: "combobox", "aria-label": "Country/region" });
    const termsA = makeDomNode("input", "", { type: "checkbox", "aria-label": "I agree to Google Cloud Terms of Service" });
    const termsB = makeDomNode("input", "", { type: "checkbox", "aria-label": "I agree to Google Cloud Terms of Service" });
    const agree = makeDomNode("button", "Agree and continue");
    const dialog = makeDomNode("div", `Welcome ${EMAIL} Country/region Terms of Service`, { role: "dialog" }, [country, termsA, termsB, agree]);
    const body = makeDomNode("body", "Google Cloud", {}, [dialog]);
    const snapshot = { id: "welcome", url: "https://console.cloud.google.com/welcome/new", ...withDom(body, inspectDocument) };
    assert.strictEqual(snapshot.controls.filter((control) => control.kind === "country").length, 1);
    assert.strictEqual(snapshot.controls.filter((control) => control.kind === "checkbox").length, 2);
    const adapter = fixtureAdapter([[snapshot]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 8 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "cloud_setup_required");
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.stop, true);
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click"), []);
  });

  await checkAsync("Cloud 首次设置：Language=English 不伪装国家/地区空值或触发条款", async () => {
    const snapshot = onboardingSnapshot(EMAIL, "", { languageText: "English" });
    assert.strictEqual(snapshot.controls.filter((control) => control.kind === "country").length, 1);
    assert.strictEqual(snapshot.controls.find((control) => control.kind === "country").value, "");
    const adapter = fixtureAdapter([[snapshot]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 8 });
    assert.strictEqual(result.reasonCode, "country_required");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click"), []);
  });

  await checkAsync("Cloud 首次设置：Language=English 与真正已选美国同时出现可继续", async () => {
    const selected = onboardingSnapshot(EMAIL, "United States", { languageText: "English" });
    assert.strictEqual(selected.controls.filter((control) => control.kind === "country").length, 1);
    assert.strictEqual(selected.controls.find((control) => control.kind === "country").value, "United States");
    const checked = { ...selected, controls: selected.controls.map((control) => control.kind === "checkbox"
      ? { ...control, checked: true } : control) };
    const adapter = fixtureAdapter([[selected], [checked], ...workflow(phoneSnapshot())], {
      "welcome:cloud-phone-2": 1, "welcome:cloud-phone-3": 2,
      "console:shell": 3, "console:continue": 4, "console:verify": 5, "selection:phone": 6,
    });
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click").map((call) => call[1]).slice(0, 2),
      ["welcome:cloud-phone-2", "welcome:cloud-phone-3"]);
  });

  await checkAsync("Cloud 首次设置 DOM：条款页账号不是目标时禁止同意", async () => {
    const adapter = fixtureAdapter([[onboardingSnapshot("other-consent@example.com", "United States")]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 3 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "account_mismatch");
    assert.strictEqual(adapter.calls.filter((call) => call[0] === "click").length, 0);
  });

  await checkAsync("Cloud 首次设置 DOM：有地区标题但未选择国家时禁止同意", async () => {
    const adapter = fixtureAdapter([[onboardingSnapshot(EMAIL, "")]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 3 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "country_required");
    assert.strictEqual(adapter.calls.filter((call) => call[0] === "click").length, 0);
  });

  await checkAsync("Cloud 流程：终端直接可用不能推断账号没有旧手机号", async () => {
    const adapter = fixtureAdapter([[{
      id: "console", url: "https://console.cloud.google.com/welcome/new?cloudshell=true", text: `Welcome to Cloud Shell! ${EMAIL} Type help to get started.`, controls: [], terminalReady: true,
    }]], {});
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 3 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "no_challenge");
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(adapter.calls.filter((call) => call[0] === "click").length, 0);
  });

  await checkAsync("Cloud 流程：明确允许首次设置时只接受现有地区和条款", async () => {
    const welcome = {
      id: "welcome", url: "https://console.cloud.google.com/welcome/new", text: `Google Cloud 欢迎使用 国家/地区 服务条款 ${EMAIL}`,
      controls: [{ id: "country", label: "United States", kind: "country" }, { id: "terms", label: "我同意 Google Cloud Platform 服务条款", kind: "checkbox", checked: false }, { id: "agree", label: "同意并继续", kind: "button", disabled: true }],
    };
    const checked = { ...welcome, controls: welcome.controls.map((control) => control.id === "terms" ? { ...control, checked: true } : control.id === "agree" ? { ...control, disabled: false } : control) };
    const adapter = fixtureAdapter([[welcome], [checked], ...workflow(phoneSnapshot())], {
      "welcome:terms": 1, "welcome:agree": 2,
      "console:shell": 3, "console:continue": 4, "console:verify": 5, "selection:phone": 6,
    });
    const result = await runFlow(adapter, { accountEmail: EMAIL, acceptTerms: true, maxPolls: 30 });
    assert.strictEqual(result.state, "new_number_allowed");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "welcome:terms").length, 1);
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "welcome:agree").length, 1);
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "welcome:country").length, 0);
  });

  await checkAsync("Cloud 流程：验证新标签显示其他账号立即停止且不请求验证码", async () => {
    const stages = workflow(phoneSnapshot());
    stages[3] = [{ ...stages[3][0], text: stages[3][0].text.replace(EMAIL, "other-account@example.com") }];
    const adapter = fixtureAdapter(stages, transitions);
    const result = await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 30 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(result.reasonCode, "account_mismatch");
    assert.strictEqual(adapter.calls.filter((call) => call[1] === "selection:phone").length, 0);
  });

  await checkAsync("Cloud 流程：帐号选择器只选目标帐号，缺目标时不误选他人", async () => {
    const chooser = { id: "chooser", url: "https://accounts.google.com/AccountChooser", text: "Choose an account", controls: [{ id: "other", label: "someone-else@example.com", kind: "account" }, { id: "target", label: EMAIL, kind: "account" }] };
    const adapter = fixtureAdapter([[chooser], [phoneSnapshot(EXISTING_TEXT)]], { "chooser:target": 1 });
    await runFlow(adapter, { accountEmail: EMAIL, maxPolls: 3 });
    assert.deepStrictEqual(adapter.calls.filter((call) => call[0] === "click"), [["click", "chooser:target"]]);
    const absent = fixtureAdapter([[{ ...chooser, controls: [chooser.controls[0]] }]], {});
    const result = await runFlow(absent, { accountEmail: EMAIL, maxPolls: 3 });
    assert.strictEqual(result.state, "unknown");
    assert.strictEqual(absent.calls.filter((call) => call[0] === "click").length, 0);
  });
};
