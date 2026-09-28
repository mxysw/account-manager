"use strict";

const assert = require("assert");

// Deterministic fixtures only. No real credentials, browsers, network, or inboxes.
const EMAIL = "fixture@example.com";
const RECOVERY = "backup@example.net";
const KPE = "https://accounts.google.com/v3/signin/challenge/kpe?TL=fixture";
const CONFIRM = "Confirm your recovery email To help keep your account safe, Google wants to make sure it's really you trying to sign in. Confirm the recovery email you added to your account.";
const CODE = "Check your recovery email Google sent a verification code to b•••••@example.net. Enter the verification code.";
const CONFIRM_ZH = `验证身份 为了保障您的账号安全，Google 希望确认是您本人在尝试登录。 ${EMAIL} 确认您添加到自己账号的辅助邮箱地址：76m••••••@ma••••.com 输入辅助邮箱地址 试试其他方式 下一步`;

function fixture(overrides = {}) {
  const state = { url: KPE, text: CONFIRM, filled: [], checks: [], clicks: 0, sleeps: 0, ...overrides };
  const page = { url: () => state.url };
  const deps = {
    bodyText: async () => state.text,
    fillField: async (_page, selectors, value) => { state.filled.push({ selectors, value }); return true; },
    ensureValue: async (_page, selectors, value) => { state.checks.push({ selectors, value }); return true; },
    clickNext: async () => { state.clicks += 1; state.url = "https://myaccount.google.com/"; state.text = "Google Account"; return true; },
    sleep: async () => { state.sleeps += 1; },
    totalMs: 30,
    pollMs: 0,
  };
  return { state, page, deps, account: { email: EMAIL, password: "fixture-password", recoveryEmail: RECOVERY, totpSecret: "" } };
}

// Minimal selector-aware DOM: nodes are traversed in document order, so stale
// preceding form controls can expose an accidentally global Next-button search.
function domNode(tag, text = "", attrs = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), parentElement: null, children,
    id: attrs.id || "", name: attrs.name || "", value: attrs.value || "", type: attrs.type || "",
    disabled: !!attrs.disabled, hidden: !!attrs.hidden,
    get textContent() { return [text, ...children.map((child) => child.textContent)].filter(Boolean).join(" "); },
    get innerText() { return node.textContent; },
    getAttribute: (name) => Object.hasOwn(attrs, name) ? String(attrs[name]) : null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: node.hidden ? 0 : 180, height: node.hidden ? 0 : 36 }),
    getClientRects: () => node.hidden ? [] : [node.getBoundingClientRect()],
    matches(selector) {
      return selector.split(",").some((part) => {
        const raw = part.trim();
        const excluded = [...raw.matchAll(/:not\(([^)]+)\)/g)].map((match) => match[1]);
        if (excluded.some((item) => node.matches(item))) return false;
        const nth = raw.match(/:nth-child\((\d+)\)/);
        if (nth && (!node.parentElement || node.parentElement.children.indexOf(node) + 1 !== Number(nth[1]))) return false;
        const source = raw.replace(/:not\([^)]+\)/g, "").replace(/:nth-child\(\d+\)/g, "");
        const tagMatch = source.match(/^[a-z][a-z0-9-]*/i);
        if (tagMatch && tagMatch[0].toLowerCase() !== tag.toLowerCase()) return false;
        const idMatch = source.match(/#([\w-]+)/);
        if (idMatch && node.id !== idMatch[1]) return false;
        for (const attr of source.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
          const value = node.getAttribute(attr[1]);
          if (value === null || (attr[2] != null && value !== attr[2])) return false;
        }
        return true;
      });
    },
    closest(selector) {
      for (let current = node; current; current = current.parentElement) if (current.matches(selector)) return current;
      return null;
    },
    querySelectorAll(selector) {
      const descendants = children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      return descendants.filter((child) => selector.split(",").some((part) => {
        const chain = part.trim().split(/\s+(?![^\[]*\])/);
        if (!child.matches(chain.pop())) return false;
        let current = child;
        while (chain.length) {
          const token = chain.pop();
          const direct = token === ">";
          const ancestor = direct ? chain.pop() : token;
          let parent = current.parentElement;
          if (direct) { if (!parent || !parent.matches(ancestor)) return false; }
          else while (parent && !parent.matches(ancestor)) parent = parent.parentElement;
          if (!parent) return false;
          current = parent;
        }
        return true;
      }));
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    contains(other) { for (let current = other; current; current = current.parentElement) if (current === node) return true; return false; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function domDocument(children) {
  const body = domNode("body", "", {}, children);
  const documentElement = domNode("html", "", {}, [body]);
  return {
    body,
    documentElement,
    location: { href: KPE },
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    getElementById: (id) => documentElement.querySelector(`#${id}`),
  };
}
const visibleStyle = (node) => ({ display: node.hidden ? "none" : "block", visibility: "visible", opacity: "1" });

// Exercise the production login dispatcher and its real locator callbacks with
// inert DOM fixtures. No network/browser/inbox is used by this adapter.
function methodFixture(options = {}) {
  const state = { stage: options.initialStage || "selection", choices: [], filled: [], submissions: 0, reads: 0, physicalRecoveryClicks: 0, ...options.state };
  const urls = {
    selection: "https://accounts.google.com/v3/signin/challenge/selection?TL=fixture",
    totp: "https://accounts.google.com/v3/signin/challenge/totp?TL=fixture",
    confirm: KPE, code: KPE, done: "https://myaccount.google.com/", ...options.urls,
  };
  const button = (text, action, attrs = {}) => {
    const node = domNode("button", text, attrs);
    node.click = action;
    node.scrollIntoView = () => {};
    return node;
  };
  const chooseRecovery = () => {
    state.choices.push("recovery");
    if (!options.stuck) state.stage = options.destination || "confirm";
    if (options.clickNavigationError) throw new Error("Execution context was destroyed during navigation");
  };
  const recoveryLabel = options.label || "确认辅助邮箱";
  const recoveryButton = button(recoveryLabel, chooseRecovery, options.duplicateAria ? { "aria-label": recoveryLabel } : {});
  recoveryButton.fixtureKind = "recovery";
  const staleRecovery = button(recoveryLabel, () => { state.choices.push("hidden"); }, { "aria-hidden": "true" });
  const address = domNode("input", "", { type: "email", name: "knowledgePreregisteredEmailResponse" });
  address.dispatchEvent = () => true;
  const docs = {
    selection: domDocument([
      domNode("div", "Choose how you want to sign in"),
      button("Get a verification code from the Google Authenticator app", () => { state.choices.push("authenticator"); state.stage = "totp"; }),
      ...(options.hiddenOldOption ? [staleRecovery] : []),
      recoveryButton,
    ]),
    totp: domDocument([
      domNode("div", "Enter a code from Google Authenticator"),
      domNode("input", "", { type: "tel", name: "totpPin" }),
      button("Try another way", () => { state.choices.push("other"); state.stage = "selection"; }),
    ]),
    confirm: domDocument([domNode("form", `${EMAIL} ${CONFIRM}`, {}, [address, button("Next", () => { state.submissions += 1; state.stage = "done"; })])]),
    code: domDocument([domNode("div", CODE), domNode("input", "", { name: "emailCode", autocomplete: "one-time-code" })]),
    done: domDocument([domNode("div", "Google Account")]),
  };
  function evaluate(fn, ...args) {
    state.reads += 1;
    const doc = docs[state.stage];
    doc.location.href = urls[state.stage];
    const previous = ["document", "getComputedStyle", "window"].map((name) => ({ name, existed: Object.hasOwn(global, name), value: global[name] }));
    function Input() {}
    Object.defineProperty(Input.prototype, "value", { set(value) { this.value = value; } });
    global.document = doc;
    global.getComputedStyle = visibleStyle;
    global.window = { HTMLInputElement: Input, HTMLTextAreaElement: class TextArea {} };
    try { return fn(...args); }
    finally {
      for (const entry of previous) {
        if (entry.existed) global[entry.name] = entry.value;
        else delete global[entry.name];
      }
    }
  }
  function handle(node) {
    if (!node) return { asElement: () => null, dispose: async () => {} };
    const wrapped = {
      asElement: () => wrapped,
      evaluate: async (fn, ...args) => evaluate(fn, node, ...args),
      click: async () => {
        if (node.fixtureKind === "recovery") {
          state.physicalRecoveryClicks += 1;
          if (options.syntheticOnly) return;
        }
        if (node.click) node.click();
      },
      type: async (value) => { state.filled.push(value); node.value = value; },
      boundingBox: async () => null, // Navigation errors must not fall back to a stale coordinate.
      dispose: async () => {},
    };
    return wrapped;
  }
  const page = {
    url: () => urls[state.stage],
    evaluate: async (fn, ...args) => evaluate(fn, ...args),
    evaluateHandle: async (fn, ...args) => handle(evaluate(fn, ...args)),
    $: async (selector) => { const node = docs[state.stage].querySelector(selector); return node ? handle(node) : null; },
    mouse: { click: async () => { throw new Error("fixture forbids unobserved coordinate clicks"); } },
  };
  return { page, state, account: { email: EMAIL, password: "00123456789", recoveryEmail: RECOVERY, totpSecret: "" } };
}

module.exports = async function runRecoveryEmailTests({ check, checkAsync, accounts }) {
  const { classifyRecoveryEmail, submitRecoveryEmail, inspectRecoveryEmailPage, findRecoveryEmailNext, RECOVERY_OPTION_RE } = require("../src/automation/actions/recovery-email");
  const login = require("../src/automation/actions/login");

  check("辅助邮箱导入：三字段、末尾 FA、Markdown 邮箱转义均保留正确字段", () => {
    for (const delimiter of ["|", "----"]) {
      for (const suffix of ["", `${delimiter}FA`, `${delimiter}fa`]) {
        const parsed = accounts.parseLine(`fixture\\@example.com${delimiter}literal\\@password${delimiter}backup\\@example.net${suffix}`);
        assert.strictEqual(parsed.email, EMAIL);
        assert.strictEqual(parsed.password, "literal\\@password", "邮箱规范化不能修改密码");
        assert.strictEqual(parsed.recoveryEmail, RECOVERY);
        assert.strictEqual(parsed.totpSecret, "", "FA 不能被当作 2FA 密钥");
        assert.strictEqual(parsed.country, "", "FA 不能被当作国家");
      }
    }
    const original = accounts.parseLine(`${EMAIL}|password|${RECOVERY}|2026|US`);
    assert.strictEqual(original.year, "2026");
    assert.strictEqual(original.country, "US", "真实年份/国家兼容性不能破坏");
  });

  check("辅助邮箱导入：数字密码前导零原样保留，FA 仅作无效尾标记", () => {
    for (const suffix of ["", "|FA", "|fa"]) {
      const parsed = accounts.parseLine(`${EMAIL}|00123456789|${RECOVERY}${suffix}`);
      assert.strictEqual(parsed.password, "00123456789");
      assert.strictEqual(typeof parsed.password, "string");
      assert.strictEqual(parsed.recoveryEmail, RECOVERY);
      assert.strictEqual(parsed.totpSecret, "");
    }
  });

  check("辅助邮箱方式：无代词的确认选项可识别，收码和新增地址选项不匹配", () => {
    for (const label of ["确认辅助邮箱", "确认辅助邮箱地址", "确认您的辅助邮箱", "确认你的恢复邮箱", "Confirm your recovery email", "Confirm the recovery email address"]) {
      assert.ok(RECOVERY_OPTION_RE.test(label), label);
    }
    for (const label of ["查收辅助邮箱", "发送验证码至辅助邮箱", "输入辅助邮箱验证码", "添加辅助邮箱", "Change your recovery email", "Get a verification code from your recovery email"]) {
      assert.strictEqual(RECOVERY_OPTION_RE.test(label), false, label);
    }
  });

  check("辅助邮箱识别：明确的确认地址页与邮箱收码页必须分开", () => {
    assert.strictEqual(classifyRecoveryEmail(CONFIRM, KPE), "confirm");
    assert.strictEqual(classifyRecoveryEmail("确认您的辅助邮箱 输入您为此账号添加的辅助邮箱", KPE), "confirm");
    assert.strictEqual(classifyRecoveryEmail(CONFIRM, "https://accounts.google.com/v3/signin/challenge/unknown"), "confirm");
    assert.strictEqual(classifyRecoveryEmail(CODE, KPE), "code", "验证码文案优先于 kpe 路径");
  });

  check("辅助邮箱识别：邮箱用户名中的 code/enter/send 不得伪造验证码语义", () => {
    for (const email of ["code123@example.com", "entered@example.com", "sendcode@example.com", "getcode@example.com", "verification-code@example.com"]) {
      for (const prompt of ["Confirm your recovery email", "Enter your recovery email"]) {
        assert.strictEqual(classifyRecoveryEmail(`${prompt} ${email}`, KPE), "confirm", `${prompt}: ${email}`);
      }
    }
    for (const text of [
      "Check your recovery email. Enter the verification code sent to you.",
      "Get a verification code. Google will send a verification code to your recovery email.",
      "Enter the verification code from your recovery email code123@example.com",
      "查收辅助邮箱 输入已发送至您邮箱的验证码",
    ]) assert.strictEqual(classifyRecoveryEmail(text, KPE), "code", text);
  });

  check("辅助邮箱 DOM 信号：活动地址输入框优先于前后无关验证码文案", () => {
    for (const prefix of ["", "获取验证码 ", "Enter a code "]) {
      for (const suffix of ["", " 获取验证码", " Enter a code"]) {
        const text = `${prefix}确认您的辅助邮箱 ${EMAIL} 请输入您为此账号添加的辅助邮箱 b•••••@example.net${suffix}`;
        assert.strictEqual(classifyRecoveryEmail(text, KPE, { addressInput: true, codeInput: false }), "confirm", text);
      }
    }
    assert.strictEqual(classifyRecoveryEmail(CODE, KPE, { addressInput: true, codeInput: false }), "confirm", "当前活动表单是地址确认时不能凭全页残留收码文案误判");
  });

  check("辅助邮箱 DOM 信号：用户实际中文确认页及掩码提示不得误报邮箱收码", () => {
    assert.strictEqual(classifyRecoveryEmail(CONFIRM_ZH, KPE), "confirm");
    for (const text of [CONFIRM_ZH, `获取验证码 ${CONFIRM_ZH}`, `${CONFIRM_ZH} Enter a code`, `Enter a code ${CONFIRM_ZH} 获取验证码`]) {
      assert.strictEqual(classifyRecoveryEmail(text, KPE, { addressInput: true, codeInput: false }), "confirm", text);
    }
  });

  check("辅助邮箱 DOM 信号：收码、表单过渡和空白 hydration 分开处理", () => {
    assert.strictEqual(classifyRecoveryEmail(CODE, KPE, { addressInput: false, codeInput: true }), "code");
    assert.strictEqual(classifyRecoveryEmail(CONFIRM, KPE, { addressInput: true, codeInput: true }), "pending", "两个输入同时活动时先等待，不允许写入任何一个");
    assert.strictEqual(classifyRecoveryEmail(CODE, KPE, { addressInput: true, codeInput: true }), "pending");
    assert.strictEqual(classifyRecoveryEmail("", KPE, { addressInput: false, codeInput: false }), "pending");
    assert.strictEqual(classifyRecoveryEmail("Google 正在加载", KPE, {}), "pending", "kpe URL 已改变但输入未出现时不能立刻假定可填");
    assert.strictEqual(classifyRecoveryEmail("获取验证码", KPE, { addressInput: false, codeInput: false }), "pending", "尚未加载输入框时残留收码文案不能触发需收码结果");
    assert.strictEqual(classifyRecoveryEmail(CODE, KPE, { addressInput: false, codeInput: false }), "pending", "生产 DOM 信号优先于正文中的旧收码信息");
    assert.strictEqual(classifyRecoveryEmail(CODE, KPE), "code", "缺少 DOM 信号时仍保留明确收码文案的兼容识别");
  });

  check("辅助邮箱 DOM 信号：活动输入也不得越过可信来源和验证类型边界", () => {
    for (const url of [
      "https://accounts.google.com.evil.example/v3/signin/challenge/kpe",
      "http://accounts.google.com/v3/signin/challenge/kpe",
      "https://accounts.google.com/v3/signin/challenge/pwd",
      "https://accounts.google.com/v3/signin/challenge/totp",
      "https://accounts.google.com/v3/signin/challenge/ipp",
    ]) {
      assert.strictEqual(classifyRecoveryEmail(CONFIRM, url, { addressInput: true, codeInput: false }), "", url);
      assert.strictEqual(classifyRecoveryEmail(CODE, url, { addressInput: false, codeInput: true }), "", url);
    }
  });

  check("辅助邮箱 DOM 快照：专用地址控件及中文关联标签都识别，且不读取输入值", () => {
    for (const kind of ["known", "placeholder", "labelledby"]) {
      const attrs = kind === "known" ? { name: "knowledgePreregisteredEmailResponse" }
        : kind === "placeholder" ? { placeholder: "输入辅助邮箱地址" }
          : { "aria-labelledby": "recovery-label" };
      const input = domNode("input", "", { type: "text", ...attrs });
      Object.defineProperty(input, "value", { get() { throw new Error("快照不得读取邮箱或其它输入值"); } });
      const doc = domDocument([domNode("div", CONFIRM_ZH), domNode("label", "输入辅助邮箱地址", { id: "recovery-label" }), input]);
      const snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
      assert.strictEqual(snapshot.url, KPE);
      assert.ok(snapshot.text.includes("确认您添加到自己账号的辅助邮箱地址"));
      assert.deepStrictEqual(snapshot.signals, { addressInput: true, codeInput: false }, kind);
    }
  });

  check("辅助邮箱 DOM 快照：验证码输入的语义不能当作地址输入", () => {
    for (const attrs of [
      { name: "emailCode" }, { autocomplete: "one-time-code" },
      { "aria-label": "Enter the verification code from your recovery email" },
      { placeholder: "请输入辅助邮箱收到的验证码" },
      { inputmode: "numeric", maxlength: "6" },
    ]) {
      const snapshot = inspectRecoveryEmailPage(domDocument([domNode("div", CODE), domNode("input", "", { type: "text", ...attrs })]), visibleStyle);
      assert.deepStrictEqual(snapshot.signals, { addressInput: false, codeInput: true }, JSON.stringify(attrs));
    }
  });

  check("辅助邮箱 DOM 快照：忽略残留 identifier、隐藏、inert、aria-hidden 和禁用输入", () => {
    const input = (attrs = {}) => domNode("input", "", { type: "text", name: "knowledgePreregisteredEmailResponse", ...attrs });
    const doc = domDocument([
      domNode("input", "", { id: "identifierId", type: "email", "aria-label": "Recovery email" }),
      domNode("input", "", { name: "identifier", type: "email", placeholder: "输入辅助邮箱地址" }),
      input({ hidden: true }), input({ disabled: true }),
      domNode("div", "", { hidden: true }, [input()]),
      domNode("div", "", { inert: true }, [input()]),
      domNode("div", "", { "aria-hidden": "true" }, [input()]),
      domNode("div", "", { hidden: true }, [domNode("input", "", { name: "emailCode" })]),
    ]);
    assert.deepStrictEqual(inspectRecoveryEmailPage(doc, visibleStyle).signals, { addressInput: false, codeInput: false });
  });

  check("辅助邮箱 DOM 快照：地址和收码同时可见标为过渡，残留正文不改变地址语义", () => {
    const address = domNode("input", "", { name: "knowledgePreregisteredEmailResponse" });
    const doc = domDocument([domNode("div", `${CODE} ${CONFIRM_ZH}`), address]);
    let snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
    assert.strictEqual(classifyRecoveryEmail(snapshot.text, snapshot.url, snapshot.signals), "confirm");
    const both = domDocument([domNode("div", `${CODE} ${CONFIRM_ZH}`), address, domNode("input", "", { name: "emailCode" })]);
    snapshot = inspectRecoveryEmailPage(both, visibleStyle);
    assert.deepStrictEqual(snapshot.signals, { addressInput: true, codeInput: true });
    assert.strictEqual(classifyRecoveryEmail(snapshot.text, snapshot.url, snapshot.signals), "pending");
  });

  check("辅助邮箱 DOM 定位：只有中文标签的文本框生成精确定位，并关联自身 Next", () => {
    const staleInput = domNode("input", "", { type: "email" });
    const staleNext = domNode("button", "Next");
    const targetInput = domNode("input", "", { type: "text", "aria-label": "输入辅助邮箱地址" });
    const targetNext = domNode("button", "下一步");
    const doc = domDocument([
      domNode("form", "", {}, [staleInput, staleNext]),
      domNode("form", "", {}, [domNode("div", CONFIRM_ZH), targetInput, targetNext]),
    ]);
    const snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
    assert.ok(snapshot.addressSelector.startsWith("html > "));
    assert.strictEqual(doc.querySelector(snapshot.addressSelector), targetInput, "定位必须指向被识别的文本框而不是前面的邮箱框");
    assert.strictEqual(findRecoveryEmailNext(doc, visibleStyle, snapshot.addressSelector), targetNext);
  });

  check("辅助邮箱 DOM 定位：同时存在两个地址控件不生成定位、不允许填写", () => {
    const doc = domDocument([
      domNode("div", CONFIRM_ZH),
      domNode("input", "", { type: "text", name: "knowledgePreregisteredEmailResponse" }),
      domNode("input", "", { type: "text", "aria-label": "输入辅助邮箱地址" }),
    ]);
    const snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
    assert.strictEqual(snapshot.addressSelector, "");
    assert.strictEqual(classifyRecoveryEmail(snapshot.text, snapshot.url, snapshot.signals), "pending");
  });

  check("辅助邮箱 Next：专用按钮优先于文档前方残留密码页 Next", () => {
    const staleNext = domNode("button", "Next", { type: "submit" });
    const activeNext = domNode("button", "Next", { type: "button" });
    const staleForm = domNode("form", "", {}, [domNode("input", "", { name: "Passwd", type: "password" }), staleNext]);
    const currentForm = domNode("form", "", {}, [
      domNode("input", "", { name: "knowledgePreregisteredEmailResponse", type: "email" }),
      domNode("div", "", { id: "knowledgePreregisteredEmailNext" }, [activeNext]),
    ]);
    assert.strictEqual(findRecoveryEmailNext(domDocument([staleForm, currentForm]), visibleStyle), activeNext);
  });

  check("辅助邮箱 Next：无专用按钮时只在关联表单或弹窗中寻找", () => {
    for (const useDialog of [false, true]) {
      const staleNext = domNode("button", "Next");
      const activeNext = domNode("button", "下一步");
      const input = domNode("input", "", { name: "knowledgePreregisteredEmailResponse", type: "email" });
      const container = domNode(useDialog ? "div" : "form", "", useDialog ? { role: "dialog" } : {}, [input, activeNext]);
      assert.strictEqual(findRecoveryEmailNext(domDocument([staleNext, container]), visibleStyle), activeNext);
    }
  });

  check("辅助邮箱 Next：无 form 的 div 卡片能找到同卡片另一子容器中的下一步", () => {
    const unrelatedNext = domNode("button", "Next");
    const input = domNode("input", "", { type: "text", "aria-label": "输入辅助邮箱地址" });
    const ownNext = domNode("button", "下一步");
    const card = domNode("div", "", {}, [
      domNode("div", CONFIRM_ZH, {}, [domNode("div", "", {}, [input])]),
      domNode("div", "", { id: "passwordNext" }, [domNode("button", "Next")]),
      domNode("div", "", {}, [ownNext]),
    ]);
    const doc = domDocument([domNode("div", "", {}, [unrelatedNext]), card]);
    const snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
    assert.strictEqual(findRecoveryEmailNext(doc, visibleStyle, snapshot.addressSelector), ownNext, "必须选择地址输入所在卡片，不是文档前方或残留密码步骤按钮");
  });

  check("辅助邮箱 Next：无 form 的卡片没有按钮时不得扩大到 body 中的无关按钮", () => {
    const input = domNode("input", "", { type: "text", "aria-label": "输入辅助邮箱地址" });
    const card = domNode("div", "", {}, [domNode("div", "", {}, [input])]);
    const doc = domDocument([card, domNode("button", "Next")]);
    const snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
    assert.strictEqual(findRecoveryEmailNext(doc, visibleStyle, snapshot.addressSelector), null);
  });

  check("辅助邮箱 Next：最近卡片出现两个有效按钮即停止，不再向上扩大范围", () => {
    const input = domNode("input", "", { name: "knowledgePreregisteredEmailResponse", type: "text" });
    const card = domNode("div", "", {}, [
      domNode("div", "", {}, [input]),
      domNode("div", "", {}, [domNode("button", "Next"), domNode("button", "Continue")]),
    ]);
    const outer = domNode("div", "", {}, [card, domNode("button", "Next")]);
    const originalQuery = outer.querySelectorAll.bind(outer);
    outer.querySelectorAll = (selector) => {
      assert.notStrictEqual(selector, "button,[role='button']", "最近祖先已经歧义时不应再搜索外层卡片");
      return originalQuery(selector);
    };
    const doc = domDocument([outer]);
    const snapshot = inspectRecoveryEmailPage(doc, visibleStyle);
    assert.strictEqual(findRecoveryEmailNext(doc, visibleStyle, snapshot.addressSelector), null);
  });

  check("辅助邮箱 Next：关联表单无按钮时不回退到无关全局 Next", () => {
    const staleNext = domNode("button", "Next");
    const input = domNode("input", "", { name: "knowledgePreregisteredEmailResponse", type: "email" });
    const noButtonForm = domNode("form", "", {}, [input]);
    assert.strictEqual(findRecoveryEmailNext(domDocument([staleNext, noButtonForm]), visibleStyle), null);
    const detachedInput = domNode("input", "", { name: "knowledgePreregisteredEmailResponse", type: "email" });
    assert.strictEqual(findRecoveryEmailNext(domDocument([detachedInput, staleNext]), visibleStyle), null);
  });

  check("辅助邮箱 Next：残留账号输入框不得关联旧表单，多个候选按钮不盲点", () => {
    const staleNext = domNode("button", "Next");
    const staleForm = domNode("form", "", {}, [domNode("input", "", { id: "identifierId", name: "identifier", type: "email" }), staleNext]);
    const activeNext = domNode("button", "Next");
    const activeForm = domNode("form", "", {}, [domNode("input", "", { type: "email" }), activeNext]);
    assert.strictEqual(findRecoveryEmailNext(domDocument([staleForm, activeForm]), visibleStyle), activeNext);
    const ambiguousForm = domNode("form", "", {}, [
      domNode("input", "", { name: "knowledgePreregisteredEmailResponse", type: "email" }),
      domNode("button", "Next"), domNode("button", "Continue"),
    ]);
    assert.strictEqual(findRecoveryEmailNext(domDocument([ambiguousForm]), visibleStyle), null);
  });

  check("辅助邮箱识别：拒绝不可信来源和其它登录、安全设置输入框", () => {
    for (const url of [
      "http://accounts.google.com/v3/signin/challenge/kpe",
      "https://accounts.google.com.evil.example/v3/signin/challenge/kpe",
      "https://evil.example/v3/signin/challenge/kpe",
      "https://myaccount.google.com/recovery/email",
      "https://accounts.google.com/v3/signin/identifier",
      "https://accounts.google.com/v3/signin/challenge/pwd",
      "https://accounts.google.com/v3/signin/challenge/totp",
      "https://accounts.google.com/v3/signin/challenge/ipp",
    ]) assert.strictEqual(classifyRecoveryEmail(CONFIRM, url), "", url);
    assert.strictEqual(classifyRecoveryEmail("Add a recovery email to keep your account safe", "https://accounts.google.com/v3/signin/challenge/unknown"), "");
    assert.strictEqual(classifyRecoveryEmail("Enter your email or phone", "https://accounts.google.com/v3/signin/challenge/unknown"), "");
  });

  await checkAsync("辅助邮箱确认：无 TOTP 密钥也只填辅助邮箱、提交一次并确认推进", async () => {
    const f = fixture();
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(f.state.clicks, 1);
    assert.strictEqual(f.state.filled.length, 1);
    assert.strictEqual(f.state.filled[0].value, RECOVERY);
    for (const entry of [...f.state.filled, ...f.state.checks]) assert.strictEqual(entry.value, RECOVERY);
  });

  await checkAsync("辅助邮箱 hydration：空白或双输入过渡后进入实际中文地址页再填写", async () => {
    for (const ambiguous of [false, true]) {
      const f = fixture({ text: `${CONFIRM_ZH} 获取验证码`, observations: 0 });
      f.deps.readyPolls = 12;
      f.deps.observe = async () => {
        f.state.observations += 1;
        if (f.state.observations <= 3) return {
          url: KPE, text: ambiguous ? `${CODE} ${CONFIRM_ZH}` : "获取验证码",
          signals: { addressInput: ambiguous, codeInput: ambiguous },
        };
        return {
          url: f.state.url, text: f.state.text,
          signals: { addressInput: f.state.url === KPE, codeInput: false },
        };
      };
      const fill = f.deps.fillField;
      f.deps.fillField = async (...args) => {
        assert.ok(f.state.observations > 3, "表单未就绪或同时有两种输入时不能填写");
        return fill(...args);
      };
      const result = await submitRecoveryEmail(f.page, f.account, f.deps);
      assert.strictEqual(result.advanced, true);
      assert.strictEqual(f.state.filled.length, 1);
      assert.strictEqual(f.state.filled[0].value, RECOVERY);
      assert.strictEqual(f.state.clicks, 1);
    }
  });

  await checkAsync("辅助邮箱 hydration：持续活动收码输入确认三次后需人工，绝不填地址", async () => {
    const f = fixture({ observations: 0, codeObservations: 0 });
    f.deps.readyPolls = 12;
    f.deps.observe = async () => {
      f.state.observations += 1;
      if (f.state.observations <= 2) return { url: KPE, text: "Google 正在加载", signals: { addressInput: false, codeInput: false } };
      f.state.codeObservations += 1;
      return { url: KPE, text: CODE, signals: { addressInput: false, codeInput: true } };
    };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "recovery_email_code_required");
    assert.ok(f.state.codeObservations >= 3, "不能把一次过渡快照直接判为收码页");
    assert.strictEqual(f.state.filled.length, 0);
    assert.strictEqual(f.state.clicks, 0);
  });

  await checkAsync("辅助邮箱 hydration：一次短暂收码快照后转地址确认，不提前退出", async () => {
    const f = fixture({ text: CONFIRM_ZH, observations: 0 });
    f.deps.readyPolls = 12;
    f.deps.observe = async () => {
      f.state.observations += 1;
      if (f.state.observations === 1) return { url: KPE, text: CODE, signals: { addressInput: false, codeInput: true } };
      return { url: f.state.url, text: f.state.text, signals: { addressInput: f.state.url === KPE, codeInput: false } };
    };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(f.state.filled.length, 1);
    assert.strictEqual(f.state.clicks, 1);
  });

  await checkAsync("辅助邮箱 hydration：始终没有活动输入框则有限等待、无填写提交", async () => {
    const f = fixture({ observations: 0 });
    f.deps.readyPolls = 4;
    f.deps.observe = async () => {
      f.state.observations += 1;
      return { url: KPE, text: `${CONFIRM_ZH} 获取验证码`, signals: { addressInput: false, codeInput: false } };
    };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "unknown_challenge");
    assert.ok(f.state.observations <= 8, "等待应受 readyPolls 限制");
    assert.strictEqual(f.state.filled.length, 0);
    assert.strictEqual(f.state.clicks, 0);
  });

  await checkAsync("辅助邮箱 hydration：等待预算最后才出现的不稳定地址/收码均不操作", async () => {
    for (const code of [false, true]) {
      const f = fixture({ observations: 0 });
      f.deps.readyPolls = 4;
      f.deps.observe = async () => {
        f.state.observations += 1;
        const last = f.state.observations >= 4;
        return {
          url: KPE, text: last ? (code ? CODE : CONFIRM_ZH) : "正在加载",
          signals: { addressInput: last && !code, codeInput: last && code },
        };
      };
      const result = await submitRecoveryEmail(f.page, f.account, f.deps);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(result.reasonCode, "unknown_challenge", "不足稳定读取次数不能提前判收码或尝试填写");
      assert.strictEqual(f.state.filled.length, 0);
      assert.strictEqual(f.state.clicks, 0);
    }
  });

  await checkAsync("辅助邮箱填写：fill/ensure 仅接收已观察到的精确定位", async () => {
    const f = fixture({ text: CONFIRM_ZH });
    const selector = "html > body:nth-child(1) > form:nth-child(2) > input:nth-child(2)";
    f.deps.observe = async () => ({ url: f.state.url, text: f.state.text, signals: { addressInput: f.state.url === KPE, codeInput: false }, addressSelector: selector });
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(f.state.filled.length, 1);
    assert.strictEqual(f.state.checks.length, 1);
    for (const entry of [...f.state.filled, ...f.state.checks]) assert.deepStrictEqual(entry.selectors, [selector], "不能回退到通用邮箱选择器");
  });

  await checkAsync("辅助邮箱 Next：使用再次观察的精确地址定位，仅实际点击一次", async () => {
    const selector = "html > body:nth-child(1) > form:nth-child(2) > input:nth-child(2)";
    let clicked = 0;
    let disposed = 0;
    const page = {
      url: () => KPE,
      evaluate: async () => ({ url: KPE, text: CONFIRM_ZH, signals: { addressInput: true, codeInput: false }, addressSelector: selector }),
      evaluateHandle: async (fn, doc, style, observedSelector) => {
        assert.strictEqual(fn, findRecoveryEmailNext);
        assert.strictEqual(observedSelector, selector);
        return { asElement: () => ({ click: async () => { clicked += 1; } }), dispose: async () => { disposed += 1; } };
      },
    };
    assert.strictEqual(await login.helpers.clickRecoveryEmailNext(page), true);
    assert.strictEqual(clicked, 1);
    assert.strictEqual(disposed, 1);
  });

  await checkAsync("辅助邮箱最后检查：填写后或点击前刚变成收码页都不能点 Next", async () => {
    for (const changeAtClick of [false, true]) {
      const f = fixture({ text: CONFIRM_ZH });
      const selector = "html > body:nth-child(1) > input:nth-child(1)";
      f.deps.observe = async () => {
        const code = !changeAtClick && f.state.filled.length > 0;
        return { url: KPE, text: code ? CODE : CONFIRM_ZH, signals: { addressInput: !code, codeInput: code }, addressSelector: code ? "" : selector };
      };
      f.page.evaluate = async () => ({ url: KPE, text: CODE, signals: { addressInput: false, codeInput: true } });
      f.page.evaluateHandle = async () => { throw new Error("收码页不得查找或点击地址确认 Next"); };
      f.deps.clickNext = async (page) => {
        assert.strictEqual(changeAtClick, true, "最终检查发现收码时不能进入点击函数");
        return login.helpers.clickRecoveryEmailNext(page);
      };
      const result = await submitRecoveryEmail(f.page, f.account, f.deps);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(result.reasonCode, changeAtClick ? "unknown_challenge" : "recovery_email_code_required");
      assert.strictEqual(f.state.filled.length, 1);
      assert.strictEqual(f.state.clicks, 0);
    }
  });

  await checkAsync("辅助邮箱确认：缺地址立即停止，不点击也不猜测", async () => {
    const f = fixture();
    f.account.recoveryEmail = "";
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "recovery_email_missing");
    assert.strictEqual(f.state.filled.length, 0);
    assert.strictEqual(f.state.clicks, 0);
  });

  await checkAsync("辅助邮箱确认：无效地址和其它账号的验证页不填写", async () => {
    for (const mismatch of [false, true]) {
      const f = fixture();
      if (mismatch) f.state.text = `${CONFIRM} another-user@example.org`;
      else f.account.recoveryEmail = "not-an-email";
      const result = await submitRecoveryEmail(f.page, f.account, f.deps);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(result.reasonCode, mismatch ? "unknown_challenge" : "recovery_email_missing");
      assert.strictEqual(f.state.filled.length, 0);
      assert.strictEqual(f.state.clicks, 0);
    }
  });

  await checkAsync("辅助邮箱确认：错误主账号同页出现预期辅助邮箱仍不得填写", async () => {
    const f = fixture({ text: `another-user@example.org ${CONFIRM} ${RECOVERY}` });
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "unknown_challenge");
    assert.strictEqual(f.state.filled.length, 0, "匹配辅助邮箱不等于匹配登录主账号");
    assert.strictEqual(f.state.clicks, 0);
  });

  await checkAsync("辅助邮箱确认：输入框未就绪或填写期间转为收码页均不提交", async () => {
    for (const codeRace of [false, true]) {
      const f = fixture();
      f.deps.fillField = async () => {
        if (codeRace) f.state.text = CODE;
        return codeRace;
      };
      const result = await submitRecoveryEmail(f.page, f.account, f.deps);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(result.reasonCode, codeRace ? "recovery_email_code_required" : "unknown_challenge");
      assert.strictEqual(f.state.clicks, 0);
    }
  });

  await checkAsync("辅助邮箱确认：地址错误立即停止，不重试", async () => {
    const f = fixture();
    f.deps.clickNext = async () => { f.state.clicks += 1; f.state.text = `${CONFIRM} The email address you entered is incorrect. Try again.`; return true; };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.reasonCode, "recovery_email_wrong");
    assert.ok(["need_verify", "error"].includes(result.outcome));
    assert.strictEqual(f.state.clicks, 1);
    assert.strictEqual(f.state.filled.length, 1);
  });

  await checkAsync("辅助邮箱收码：人工收码状态绝不填辅助地址或 TOTP", async () => {
    const f = fixture({ text: CODE });
    f.account.totpSecret = "JBSWY3DPEHPK3PXP";
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "recovery_email_code_required");
    assert.strictEqual(f.state.filled.length, 0);
    assert.strictEqual(f.state.clicks, 0);
  });

  await checkAsync("辅助邮箱确认后要求收码：不误报已通过，也不重复提交", async () => {
    const f = fixture();
    f.deps.clickNext = async () => { f.state.clicks += 1; f.state.text = CODE; return true; };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "recovery_email_code_required");
    assert.strictEqual(f.state.clicks, 1);
    assert.strictEqual(f.state.filled.length, 1);
  });

  await checkAsync("辅助邮箱提交：页面延迟推进只观察、不再次点击", async () => {
    const f = fixture();
    f.deps.clickNext = async () => { f.state.clicks += 1; return true; };
    f.deps.sleep = async () => {
      f.state.sleeps += 1;
      if (f.state.sleeps >= 3) { f.state.url = "https://myaccount.google.com/"; f.state.text = "Google Account"; }
    };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(f.state.clicks, 1);
    assert.strictEqual(f.state.filled.length, 1);
    assert.ok(f.state.sleeps >= 3);
  });

  await checkAsync("辅助邮箱提交：点击遇到导航销毁仍检查页面、不重提", async () => {
    const f = fixture();
    f.deps.clickNext = async () => {
      f.state.clicks += 1;
      f.state.url = "https://myaccount.google.com/";
      f.state.text = "Google Account";
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    };
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(f.state.clicks, 1);
    assert.strictEqual(f.state.filled.length, 1);
  });

  await checkAsync("辅助邮箱提交：无反馈只提交一次后报需人工，不假报成功", async () => {
    const f = fixture();
    f.deps.clickNext = async () => { f.state.clicks += 1; return true; };
    f.deps.totalMs = 5;
    const result = await submitRecoveryEmail(f.page, f.account, f.deps);
    assert.strictEqual(result.outcome, "need_verify");
    assert.notStrictEqual(result.advanced, true);
    assert.strictEqual(f.state.clicks, 1);
    assert.strictEqual(f.state.filled.length, 1);
  });

  await checkAsync("完整登录：未配置 2FA 的辅助邮箱账号不会在开页前被拒绝", async () => {
    let navigated = false;
    const page = {
      goto: async () => { navigated = true; },
      url: () => "https://myaccount.google.com/",
      evaluate: async () => "Google Account",
    };
    const result = await login(page, { email: EMAIL, password: "fixture-password", recoveryEmail: RECOVERY, totpSecret: "" }, {});
    assert.strictEqual(navigated, true);
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "ok");
  });

  await checkAsync("完整登录：无密钥时两种方式并列，只选确认辅助邮箱并提交地址一次", async () => {
    const f = methodFixture();
    const result = await login.helpers.driveAuthFlow(f.page, f.account, () => {}, { label: "login" });
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(f.state.choices, ["recovery"], "不能先试未配置的身份验证器");
    assert.deepStrictEqual(f.state.filled, [RECOVERY]);
    assert.strictEqual(f.state.submissions, 1);
    assert.match(result.detail.login, /已确认辅助邮箱/);
  });

  await checkAsync("完整登录：选择辅助邮箱后要求收码则需人工，不把地址填写为验证码", async () => {
    const f = methodFixture({ label: "Confirm your recovery email", destination: "code" });
    const result = await login.helpers.driveAuthFlow(f.page, f.account, () => {}, { label: "login" });
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "recovery_email_code_required");
    assert.deepStrictEqual(f.state.choices, ["recovery"]);
    assert.deepStrictEqual(f.state.filled, []);
    assert.strictEqual(f.state.submissions, 0);
  });

  await checkAsync("辅助邮箱方式：点击成功但页面未推进，不假报已选择且重试有界", async () => {
    const f = methodFixture({ label: "Confirm your recovery email", stuck: true });
    assert.strictEqual(await login.helpers.chooseRecoveryEmailMethod(f.page, 20), false);
    assert.strictEqual(f.state.stage, "selection");
    assert.ok(f.state.choices.length >= 1 && f.state.choices.length <= 2, "只允许物理点击及仍在原选择页时的一次回退");
    assert.deepStrictEqual(f.state.filled, []);
    assert.strictEqual(f.state.submissions, 0);
    assert.ok(f.state.reads < 100, "选择后的观察必须有界");
  });

  await checkAsync("辅助邮箱方式：点击导航抛错但已到确认页，不重复点旧选项", async () => {
    const f = methodFixture({ label: "Confirm your recovery email", clickNavigationError: true });
    assert.strictEqual(await login.helpers.chooseRecoveryEmailMethod(f.page, 20), true);
    assert.strictEqual(f.state.stage, "confirm");
    assert.deepStrictEqual(f.state.choices, ["recovery"]);
    assert.deepStrictEqual(f.state.filled, [], "方式选择只观察页面，地址应由独立确认流程填写");
    assert.strictEqual(f.state.submissions, 0);
  });

  await checkAsync("辅助邮箱方式：按钮正文与 aria-label 相同也能真实点击", async () => {
    const f = methodFixture({ duplicateAria: true });
    assert.strictEqual(await login.helpers.hasRecoveryEmailOption(f.page), true);
    assert.strictEqual(await login.helpers.chooseRecoveryEmailMethod(f.page, 20), true);
    assert.strictEqual(f.state.physicalRecoveryClicks, 1);
    assert.deepStrictEqual(f.state.choices, ["recovery"]);
  });

  await checkAsync("辅助邮箱方式：忽略 aria-hidden 的旧选项，始终点当前可见选项", async () => {
    for (const syntheticOnly of [false, true]) {
      const f = methodFixture({ hiddenOldOption: true, syntheticOnly });
      assert.strictEqual(await login.helpers.chooseRecoveryEmailMethod(f.page, 20), true);
      assert.deepStrictEqual(f.state.choices, ["recovery"]);
      assert.strictEqual(f.state.physicalRecoveryClicks, 1);
    }
  });

  await checkAsync("辅助邮箱方式：物理点击被忽略时仅回退一次，并确认已经推进", async () => {
    const f = methodFixture({ syntheticOnly: true, duplicateAria: true });
    assert.strictEqual(await login.helpers.chooseRecoveryEmailMethod(f.page, 20), true);
    assert.strictEqual(f.state.physicalRecoveryClicks, 1);
    assert.deepStrictEqual(f.state.choices, ["recovery"]);
    assert.strictEqual(f.state.stage, "confirm");
    assert.deepStrictEqual(f.state.filled, []);
    assert.strictEqual(f.state.submissions, 0);
  });

  await checkAsync("辅助邮箱方式：不可信来源及非选择页不点击或填写", async () => {
    for (const url of [
      "", "not-a-url",
      "http://accounts.google.com/v3/signin/challenge/selection",
      "https://accounts.google.com.evil.example/v3/signin/challenge/selection",
      "https://example.org/v3/signin/challenge/selection",
      "https://accounts.google.com/v3/signin/challenge/totp",
      "https://myaccount.google.com/recovery/email",
    ]) {
      const f = methodFixture({ urls: { selection: url } });
      assert.strictEqual(await login.helpers.chooseRecoveryEmailMethod(f.page, 20), false, url);
      assert.deepStrictEqual(f.state.choices, []);
      assert.deepStrictEqual(f.state.filled, []);
      assert.strictEqual(f.state.submissions, 0);
      assert.strictEqual(f.state.reads, 0, "未通过 URL 门槛不能搜索页面控件");
    }
  });

  await checkAsync("完整登录：无密钥默认进入验证器时，经其它方式切回辅助邮箱", async () => {
    const f = methodFixture({ initialStage: "totp" });
    const result = await login.helpers.driveAuthFlow(f.page, f.account, () => {}, { label: "login" });
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(f.state.choices, ["other", "recovery"]);
    assert.deepStrictEqual(f.state.filled, [RECOVERY], "不得填写 TOTP、密码或主邮箱到验证器框");
    assert.strictEqual(f.state.submissions, 1);
  });

  await checkAsync("登录与重新验证：辅助邮箱缺失/收码诊断优先于旧密码和 TOTP 输入框", async () => {
    for (const text of [CONFIRM, CODE]) {
      for (const reauth of [false, true]) {
        const page = {
          url: () => KPE,
          evaluate: async (fn) => fn.name === "inspectRecoveryEmailPage"
            ? { url: KPE, text, signals: { addressInput: text === CONFIRM, codeInput: text === CODE } }
            : text,
          $: async () => { throw new Error("不得寻找或填写其它验证输入框"); },
        };
        const account = { email: EMAIL, password: "not-to-be-typed", recoveryEmail: "", totpSecret: "JBSWY3DPEHPK3PXP" };
        const result = reauth
          ? await login.reauth(page, account, {})
          : await login.helpers.driveAuthFlow(page, account, () => {}, { label: "login", isDone: () => false });
        assert.strictEqual(result.outcome, "need_verify");
        assert.strictEqual(result.reasonCode, text === CODE ? "recovery_email_code_required" : "recovery_email_missing");
      }
    }
  });

  await checkAsync("仅检测密码：辅助邮箱分支不执行额外确认", async () => {
    const page = {
      url: () => KPE,
      evaluate: async () => CONFIRM,
      $: async () => { throw new Error("密码检测不得进入辅助邮箱流程"); },
    };
    const result = await login.helpers.driveAuthFlow(page,
      { email: EMAIL, password: "not-to-be-typed", recoveryEmail: RECOVERY, totpSecret: "" },
      () => {}, { passwordOnly: true, isDone: () => false });
    assert.strictEqual(result.outcome, "need_verify");
    assert.match(Object.values(result.detail).join(" "), /未点击任何验证方式/);
  });

  check("辅助邮箱诊断：持久化白名单保留缺失、错误和需收码原因", () => {
    for (const reasonCode of ["recovery_email_missing", "recovery_email_wrong", "recovery_email_code_required"]) {
      const result = login.helpers.tagLogin({ outcome: "need_verify", reasonCode, detail: { login: "fixture" } });
      assert.strictEqual(result.fieldPatch.lastLoginCheck.reasonCode, reasonCode);
      assert.strictEqual(result.statusPatch.login, "need_verify");
    }
  });
};
