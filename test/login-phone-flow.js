"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../src/automation/actions/login.js"), "utf8");
const EMAIL = "login-phone-fixture@example.com";
const PASSWORD = "fixture-only-password";
const SECRET = "JBSWY3DPEHPK3PXP";
const URLS = {
  captcha: "https://accounts.google.com/v3/signin/challenge/recaptcha?TL=private-fixture",
  rejected: "https://accounts.google.com/v3/signin/challenge/recaptcha?TL=private-fixture",
  email: "https://accounts.google.com/v3/signin/identifier",
  password: "https://accounts.google.com/v3/signin/challenge/pwd",
  totp: "https://accounts.google.com/v3/signin/challenge/totp",
  add: "https://accounts.google.com/v3/signin/challenge/iap",
  verify: "https://accounts.google.com/v3/signin/challenge/ipp/consent",
  done: "https://myaccount.google.com/",
};
const TEXT = {
  captcha: "Verify you are not a robot reCAPTCHA",
  rejected: "We couldn’t verify it’s you reCAPTCHA",
  email: "Sign in with your Google Account",
  password: "Enter your password",
  totp: "Enter a code from Google Authenticator",
  add: "Add a phone number Google needs to verify your phone number before you can continue. Phone number Next",
  verify: "Verify it's you Get a verification code sent to your phone number ending in 12. Send Try another way",
  done: "Google Account",
};

// The real login dispatcher, input helpers, TOTP generator, and phone classifier
// run against inert DOM handles. The CAPTCHA provider and time sync are fakes;
// no account store, browser, network, or real credentials are accessed.
function fixture(stages, { solverEnabled = true, preferAuthenticator = false, freeCaptcha = false, captchaResult } = {}) {
  const state = { index: 0, events: [], writes: [], clicks: [], solves: 0, captchaChecks: [], syncs: 0 };
  const stage = () => stages[state.index];
  const next = () => { if (state.index < stages.length - 1) state.index += 1; };
  const nodes = new Map();
  let sandbox;

  class Input {
    constructor(name, type, id = "") {
      this.name = name; this.type = type; this.id = id; this.tagName = "INPUT"; this._value = "";
    }
    get value() { return this._value; }
    set value(value) { this._value = value; state.writes.push({ stage: stage(), name: this.name, value }); }
    getBoundingClientRect() { return { width: 180, height: 32 }; }
    getAttribute(name) { return this[name] || null; }
    dispatchEvent() { return true; }
    closest() { return null; }
    click() { state.clicks.push({ stage: stage(), target: this.name }); }
  }
  function button(id, text, advance = true) {
    return {
      id, tagName: "BUTTON", textContent: text, innerText: text, disabled: false,
      getBoundingClientRect: () => ({ width: 90, height: 32 }),
      getAttribute: (name) => name === "role" ? "button" : null,
      querySelector: () => null, closest: () => null, scrollIntoView: () => {},
      click: () => { state.clicks.push({ stage: stage(), target: text }); if (advance) next(); },
    };
  }
  nodes.set("email", [new Input("identifier", "email", "identifierId"), button("identifierNext", "Next")]);
  nodes.set("password", [new Input("Passwd", "password"), button("passwordNext", "Next")]);
  nodes.set("totp", [new Input("totpPin", "tel"), button("totpNext", "Next")]);
  // Stale credential/TOTP controls and active phone actions are intentional:
  // early phone detection must stop before any of these can be used.
  for (const kind of ["add", "verify"]) nodes.set(kind, [
    new Input("phoneNumber", "tel"), new Input("idvPin", "tel"),
    new Input("Passwd", "password"), button("passwordNext", "Next", false),
    button("send", "Send", false), button("other", "Try another way", false),
  ]);
  function matches(node, selector) {
    return selector.split(",").some((part) => {
      const sel = part.trim();
      if (sel.startsWith("#")) return node.id === sel.slice(1);
      const tag = sel.match(/^[a-z]+/i);
      if (tag && node.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
      for (const attr of sel.matchAll(/\[([\w-]+)\s*(\*?=)\s*['"]([^'"]+)['"](?:\s+i)?\]/g)) {
        const actual = String(node.getAttribute(attr[1]) || "");
        if (attr[2] === "=" ? actual !== attr[3] : !actual.toLowerCase().includes(attr[3].toLowerCase())) return false;
      }
      return !!tag || sel === "[role='button']" && node.tagName === "BUTTON";
    });
  }
  function documentForStage() {
    const current = nodes.get(stage()) || [];
    return {
      body: { innerText: TEXT[stage()] },
      location: { href: URLS[stage()] },
      querySelector: (selector) => current.find((node) => matches(node, selector)) || null,
      querySelectorAll: (selector) => current.filter((node) => matches(node, selector)),
    };
  }
  function evaluate(fn, ...args) {
    sandbox.document = documentForStage();
    return fn(...args);
  }
  function handle(node) {
    if (!node) return { asElement: () => null, dispose: async () => {} };
    const result = {
      asElement: () => result,
      evaluate: async (fn, ...args) => evaluate(fn, node, ...args),
      click: async () => node.click(),
      type: async (value) => { node.value = String(value); },
      press: async (key) => { state.clicks.push({ stage: stage(), target: key }); next(); },
      dispose: async () => {},
    };
    return result;
  }
  const page = {
    url: () => URLS[stage()],
    evaluate: async (fn, ...args) => evaluate(fn, ...args),
    evaluateHandle: async (fn, ...args) => handle(evaluate(fn, ...args)),
    $: async (selector) => { const node = documentForStage().querySelector(selector); return node ? handle(node) : null; },
    waitForSelector: async (selector) => handle(documentForStage().querySelector(selector)),
  };
  const solver = {
    maxAttemptsPerAccount: 3,
    getAttemptCount: () => state.solves,
    solve: async () => {
      assert.ok(state.solves < solver.maxAttemptsPerAccount, "账号级尝试次数不得超过上限");
      state.solves += 1;
      return { token: "fixture-only-captcha-token" };
    },
  };
  const dependencies = {
    "../../totp": require("../src/totp"),
    "../time-sync": { syncTime: async () => { state.syncs += 1; }, accurateNow: () => 6000 },
    "./recovery-email": require("../src/automation/actions/recovery-email"),
    "../login-phone-challenge": require("../src/automation/login-phone-challenge"),
    "../recaptcha-observer": { installRecaptchaObserver: async () => {} },
    "../login-captcha": {
      checkCancelled: require("../src/automation/login-captcha").checkCancelled,
      hasGoogleRejectionText: require("../src/automation/login-captcha").hasGoogleRejectionText,
      handleLoginCaptcha: async (_page, _account, options) => {
        state.captchaChecks.push({ stage: stage(), attempts: options.attempts });
        assert.strictEqual(options.solver, solver, "登录各个阶段必须复用同一账号级解题器");
        assert.strictEqual(options.attempts, solver.getAttemptCount(), "登录阶段切换必须保留累计付费次数");
        if (captchaResult !== undefined) return typeof captchaResult === "function"
          ? captchaResult({ stage: stage(), options }) : captchaResult;
        if (stage() !== "captcha") return { handled: false };
        if (!freeCaptcha) {
          if (options.solver.getAttemptCount() >= options.solver.maxAttemptsPerAccount) {
            return { handled: true, resumed: false, message: "本账号已用完打码次数" };
          }
          await options.solver.solve({ type: "fixture-only" });
          options.onAttempt(solver.getAttemptCount());
        }
        options.emit("captcha_accepted", {});
        if (freeCaptcha) options.emit("captcha_free_accepted", {});
        next();
        return { handled: true, resumed: true };
      },
    },
  };
  const module = { exports: {} };
  sandbox = {
    module, exports: module.exports, URL, Date, console,
    window: { HTMLInputElement: Input, HTMLTextAreaElement: class TextArea {} },
    Event: class Event {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
    setTimeout: (fn, _ms, ...args) => setImmediate(fn, ...args), clearTimeout: clearImmediate,
    require: (name) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Fixture forbids dependency: ${name}`);
      return dependencies[name];
    },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "login-phone-flow-fixture.js" });
  const login = module.exports;
  const account = { email: EMAIL, password: PASSWORD, totpSecret: SECRET };
  const emit = (type, data) => state.events.push({ type, data });
  const run = () => login.helpers.driveAuthFlow(page, account, emit,
    { label: "login", captchaSolver: solverEnabled ? solver : null, preferAuthenticator });
  const reauth = (signal) => login.reauth(page, account,
    { emit, captchaSolver: solverEnabled ? solver : null, preferAuthenticator, signal });
  return { state, run, reauth, next, stage, login };
}

function assertPhoneStopped(f, result, kind, afterCaptcha) {
  const reason = `${afterCaptcha ? "captcha_" : ""}phone_${kind === "add" ? "add" : "verification"}_required`;
  assert.strictEqual(result.outcome, "need_verify");
  assert.strictEqual(result.reasonCode, reason);
  assert.strictEqual(f.state.writes.filter(({ stage }) => stage === "add" || stage === "verify").length, 0,
    "手机号页面不能填写电话、短信码、TOTP 或残留凭据框");
  assert.strictEqual(f.state.clicks.filter(({ stage }) => stage === "add" || stage === "verify").length, 0,
    "手机号页面不能点击 Send、Next 或试试其他方式");
  const events = f.state.events.filter(({ type }) => type === "login_phone_required");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].data.kind, kind);
  assert.strictEqual(events[0].data.afterCaptcha, afterCaptcha);
  assert.strictEqual(f.state.events.some(({ type }) => type === "login_done"), false);
  const tagged = f.login.helpers.tagLogin(result);
  assert.strictEqual(tagged.stop, true);
  assert.strictEqual(tagged.statusPatch.login, "need_verify");
  assert.strictEqual(tagged.fieldPatch.lastLoginCheck.reasonCode, reason, "精确原因必须保留到账号结果");
}

module.exports = async function runLoginPhoneFlowTests({ checkAsync }) {
  await checkAsync("登录 CAPTCHA 预检未发现控件时普通密码页继续，零付费完成", async () => {
    const f = fixture(["password", "done"], { captchaResult: { handled: false } });
    const result = await f.run();
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "ok");
    assert.strictEqual(f.stage(), "done");
    assert.deepStrictEqual(f.state.captchaChecks.map(({ stage }) => stage), ["password"]);
    assert.ok(f.state.writes.some(({ stage, value }) => stage === "password" && value === PASSWORD));
    assert.strictEqual(f.state.solves, 0);
    assert.strictEqual(f.state.events.some(({ type }) => type === "captcha_accepted" || type === "captcha_failed"), false);
    assert.strictEqual(f.state.events.some(({ type }) => type === "login_done"), true);
  });

  await checkAsync("登录 CAPTCHA 检测异常保留窗口并立即停止，不填写密码或误标人机验证", async () => {
    const f = fixture(["password", "done"], { captchaResult: {
      handled: true, resumed: false, reasonCode: "captcha_detection_failed",
      message: "验证页面检测异常：当前页面账号与所选账号不一致，已停止且本轮未调用打码",
    } });
    const result = await f.run();
    assert.strictEqual(result.outcome, "error");
    assert.strictEqual(result.reasonCode, "captcha_detection_failed");
    assert.strictEqual(result.keepOpen, true);
    assert.strictEqual(result.handoff, true);
    assert.strictEqual(f.stage(), "password");
    assert.strictEqual(f.state.captchaChecks.length, 1);
    assert.strictEqual(f.state.writes.length, 0);
    assert.strictEqual(f.state.clicks.length, 0);
    assert.strictEqual(f.state.solves, 0);
    assert.strictEqual(f.state.events.some(({ type }) => type === "login_done"), false);
  });

  await checkAsync("登录真实可见 CAPTCHA 无法处理仍保留人机验证分类并停止", async () => {
    const f = fixture(["captcha", "password", "done"], { captchaResult: {
      handled: true, resumed: false,
      message: "已发现人机验证控件，但无法安全操作；已停止且本轮未调用打码",
    } });
    const result = await f.run();
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "captcha");
    assert.strictEqual(f.stage(), "captcha");
    assert.strictEqual(f.state.captchaChecks.length, 1);
    assert.strictEqual(f.state.writes.length, 0);
    assert.strictEqual(f.state.clicks.length, 0);
    assert.strictEqual(f.state.solves, 0);
    const tagged = f.login.helpers.tagLogin(result);
    assert.strictEqual(tagged.statusPatch.login, "need_verify");
    assert.strictEqual(tagged.fieldPatch.lastLoginCheck.reasonCode, "captcha");
    assert.strictEqual(tagged.stop, true);
  });

  await checkAsync("登录检测异常持久化为未知并停止，不清空独立密码检测结论", async () => {
    const f = fixture(["password"], { captchaResult: {
      handled: true, resumed: false, reasonCode: "captcha_detection_failed",
      message: "验证页面检测异常：未能可靠读取当前页面状态，已停止且本轮未调用打码",
    } });
    const result = await f.run();
    for (const passwordSubmitted of [false, true]) {
      const tagged = f.login.helpers.tagLogin({ ...result, passwordSubmitted });
      assert.strictEqual(tagged.reasonCode, "captcha_detection_failed");
      assert.strictEqual(tagged.fieldPatch.lastLoginCheck.reasonCode, "captcha_detection_failed");
      assert.strictEqual(tagged.fieldPatch.lastLoginCheck.outcome, "error");
      assert.strictEqual(tagged.fieldPatch.lastLoginCheck.detail, result.detail.login);
      assert.strictEqual(tagged.statusPatch.login, "unknown");
      assert.strictEqual(tagged.stop, true);
      assert.strictEqual(tagged.keepOpen, true);
      assert.strictEqual(tagged.handoff, true);
      assert.strictEqual(Object.hasOwn(tagged.fieldPatch, "lastPasswordCheck"), false,
        "检测异常未证明密码对错，不能产生 lastPasswordCheck:null 清空旧结论");
    }
    assert.strictEqual(f.state.solves, 0);
    assert.strictEqual(f.state.writes.length, 0);
  });

  await checkAsync("登录明确拒绝文字优先于同路径残留人机验证，零付费停止", async () => {
    const f = fixture(["rejected"]);
    const result = await f.run();
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.reasonCode, "risk_verification");
    assert.strictEqual(f.state.solves, 0);
    assert.strictEqual(f.state.captchaChecks.length, 0, "拒绝页不能进入 CAPTCHA 解题流程");
    assert.strictEqual(f.state.writes.length, 0);
  });
  await checkAsync("登录免费人机通过后仍正常登录或停止手机号关卡，且付费次数保持零", async () => {
    for (const kind of ["add", "verify", "done"]) {
      const f = fixture(["captcha", "totp", kind], { freeCaptcha: true });
      const result = await f.run();
      if (kind === "done") assert.strictEqual(result.outcome, "ok");
      else assertPhoneStopped(f, result, kind, true);
      assert.strictEqual(f.state.solves, 0);
      assert.strictEqual(f.state.syncs, 1);
      assert.ok(f.state.captchaChecks.filter(({ stage }) => stage !== "captcha")
        .every(({ attempts }) => attempts === 0));
      assert.ok(f.state.events.some(({ type }) => type === "captcha_free_accepted"));
    }
  });
  await checkAsync("登录手机号关卡：CAPTCHA→TOTP→添加手机号立即停止，绝不填写电话或点击发送", async () => {
    const f = fixture(["captcha", "totp", "add"]);
    const result = await f.run();
    assertPhoneStopped(f, result, "add", true);
    assert.strictEqual(f.state.solves, 1);
    assert.strictEqual(f.state.syncs, 1);
    assert.ok(f.state.writes.some(({ stage, name, value }) => stage === "totp" && name === "totpPin" && /^\d{6}$/.test(value)));
    assert.strictEqual(f.state.clicks.filter(({ stage, target }) => stage === "totp" && target === "Next").length, 1);
    assert.ok(f.state.captchaChecks.filter(({ stage }) => stage !== "captcha").every(({ attempts }) => attempts === 1));
  });

  await checkAsync("登录手机号关卡：CAPTCHA→TOTP→已有手机短信确认不再切换验证方式或重复解题", async () => {
    const f = fixture(["captcha", "totp", "verify"], { preferAuthenticator: true });
    assertPhoneStopped(f, await f.run(), "verify", true);
    assert.strictEqual(f.state.solves, 1);
    assert.strictEqual(f.state.syncs, 1);
    assert.strictEqual(f.state.events.some(({ type }) => type === "sms_consent_switch_authenticator"), false);
  });

  await checkAsync("登录手机号关卡：CAPTCHA 直接进入添加或验证手机号时保留通过后的精确原因", async () => {
    for (const kind of ["add", "verify"]) {
      const f = fixture(["captcha", kind]);
      assertPhoneStopped(f, await f.run(), kind, true);
      assert.strictEqual(f.state.solves, 1);
      assert.strictEqual(f.state.syncs, 0);
    }
  });

  await checkAsync("登录手机号关卡：直接遇到手机号不误标为 CAPTCHA 通过后，启用解题器也不收费", async () => {
    for (const solverEnabled of [false, true]) {
      for (const kind of ["add", "verify"]) {
        const f = fixture([kind], { solverEnabled });
        assertPhoneStopped(f, await f.run(), kind, false);
        assert.strictEqual(f.state.solves, 0);
        assert.strictEqual(f.state.syncs, 0);
      }
    }
  });

  await checkAsync("登录手机号关卡：CAPTCHA 后普通邮箱密码和 TOTP 登录继续完成", async () => {
    const f = fixture(["captcha", "email", "password", "totp", "done"]);
    const result = await f.run();
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "ok");
    assert.strictEqual(f.state.solves, 1);
    assert.strictEqual(f.state.syncs, 1);
    assert.ok(f.state.writes.some(({ stage, value }) => stage === "email" && value === EMAIL));
    assert.ok(f.state.writes.some(({ stage, value }) => stage === "password" && value === PASSWORD));
    assert.deepStrictEqual(f.state.clicks.filter(({ target }) => target === "Next").map(({ stage }) => stage),
      ["email", "password", "totp"]);
    assert.strictEqual(f.state.events.some(({ type }) => type === "login_phone_required"), false);
  });

  await checkAsync("登录 CAPTCHA→TOTP→CAPTCHA 复用账号累计次数，第二个挑战仍可继续", async () => {
    const f = fixture(["captcha", "totp", "captcha", "done"]);
    const result = await f.run();
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(result.reasonCode, "ok");
    assert.strictEqual(f.state.solves, 2);
    assert.strictEqual(f.state.syncs, 1);
    assert.deepStrictEqual(f.state.captchaChecks.filter(({ stage }) => stage === "captcha").map(({ attempts }) => attempts),
      [0, 1], "第二个挑战应继承第一次付费调用，不能被布尔锁拦截或重新计数");
    assert.strictEqual(f.state.events.filter(({ type }) => type === "captcha_accepted").length, 2);
    assert.strictEqual(f.state.clicks.filter(({ stage, target }) => stage === "totp" && target === "Next").length, 1);
  });

  await checkAsync("添加验证器重新验证：沿用登录时同一账号解题器和累计次数", async () => {
    const f = fixture(["captcha", "done", "captcha", "totp", "done"]);
    assert.strictEqual((await f.run()).outcome, "ok");
    f.next();
    assert.strictEqual((await f.reauth()).outcome, "ok");
    assert.strictEqual(f.state.solves, 2);
    assert.deepStrictEqual(f.state.captchaChecks.filter(({ stage }) => stage === "captcha").map(({ attempts }) => attempts), [0, 1]);
    assert.strictEqual(f.state.syncs, 1);
    assert.ok(f.state.events.some(({ type }) => type === "reauth_done"));
  });

  await checkAsync("添加验证器重新验证：账号三次预算不会在重新验证时重置", async () => {
    const f = fixture(["captcha", "captcha", "done", "captcha", "captcha", "done"]);
    assert.strictEqual((await f.run()).outcome, "ok");
    assert.strictEqual(f.state.solves, 2);
    f.next();
    assert.strictEqual((await f.reauth()).outcome, "need_verify");
    assert.strictEqual(f.state.solves, 3);
    assert.strictEqual(f.stage(), "captcha");
    assert.deepStrictEqual(f.state.captchaChecks.filter(({ stage }) => stage === "captcha").map(({ attempts }) => attempts), [0, 1, 2, 3]);
    assert.ok(!f.state.events.some(({ type }) => type === "reauth_done"));
  });

  await checkAsync("添加验证器重新验证：打码后需手机号仍停止，无解题器时不付费", async () => {
    for (const kind of ["add", "verify"]) {
      const f = fixture(["captcha", kind]);
      assertPhoneStopped(f, await f.reauth(), kind, true);
      assert.strictEqual(f.state.solves, 1);
    }
    const f = fixture(["captcha", "done"], { solverEnabled: false });
    assert.strictEqual((await f.reauth()).outcome, "need_verify");
    assert.strictEqual(f.state.solves, 0);
    assert.strictEqual(f.stage(), "captcha");
  });

  await checkAsync("添加验证器重新验证：取消信号传到认证流程，取消后零付费", async () => {
    const f = fixture(["captcha", "done"]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.reauth(controller.signal), { name: "AbortError" });
    assert.strictEqual(f.state.solves, 0);
    assert.strictEqual(f.state.captchaChecks.length, 0);
    assert.strictEqual(f.state.writes.length, 0);
  });

  await checkAsync("登录手机号关卡：无 CAPTCHA 的正常邮箱密码和 TOTP 流程保持完成", async () => {
    for (const solverEnabled of [false, true]) {
      const f = fixture(["email", "password", "totp", "done"], { solverEnabled });
      const result = await f.run();
      assert.strictEqual(result.outcome, "ok");
      assert.strictEqual(result.reasonCode, "ok");
      assert.strictEqual(f.state.solves, 0);
      assert.strictEqual(f.state.syncs, 1);
      assert.deepStrictEqual(f.state.clicks.filter(({ target }) => target === "Next").map(({ stage }) => stage),
        ["email", "password", "totp"]);
      assert.strictEqual(f.state.events.some(({ type }) => type === "login_phone_required"), false);
    }
  });
};
