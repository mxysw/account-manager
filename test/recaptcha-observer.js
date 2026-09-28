"use strict";

const assert = require("assert");
const observer = require("../src/automation/recaptcha-observer");
const adapter = require("../src/automation/recaptcha");
const { fixture, widget, EMAIL, ANCHOR } = require("./recaptcha").fixtures;

// Offline public-API/DOM fixtures. No browser, provider, credentials, or data.
function observerFixture(options = {}) {
  const f = fixture({ attrs: { id: "render-container" }, ...(options.fixture || {}) });
  const calls = [];
  let widgetId = 0;
  const attach = (container, sitekey = "fixture-sitekey", enterprise = false) => {
    const fresh = widget({ anchor: ANCHOR.replace("fixture-sitekey", encodeURIComponent(sitekey)).replace("api2", enterprise ? "enterprise" : "api2") });
    for (const child of container.children) child.parentElement = null;
    const content = fresh.root.children[0];
    container.children.splice(0, container.children.length, content);
    content.parentElement = container;
    for (const element of [content, ...content.querySelectorAll("*")]) element.ownerDocument = f.environment.document;
    f.frame = fresh.frame;
    f.response = fresh.response;
    return fresh;
  };
  const makeRender = (enterprise = false) => {
    const render = function renderFixture(container, parameters) {
      calls.push({ receiver: this, args: Array.from(arguments) });
      const element = typeof container === "string" ? f.environment.document.getElementById(container) : container;
      attach(element, parameters.sitekey, enterprise);
      return widgetId++;
    };
    render.fixtureProperty = { preserved: true };
    return render;
  };
  const rawRender = makeRender(false);
  const rawEnterpriseRender = makeRender(true);
  const registered = [];
  f.page.evaluateOnNewDocument = async (fn, args) => { registered.push({ fn, args }); return { identifier: "fixture-script" }; };
  const startDocument = () => registered.map(({ fn, args }) => fn(args, f.environment));
  const install = () => observer.helpers.installRecaptchaObserverDOM({ observerId: "fixture-observer" }, f.environment);
  const bridge = () => Object.getOwnPropertyDescriptor(f.environment.window, observer.BRIDGE_KEY).value;
  const target = (enterprise = false) => ({ frame: f.frame, response: f.response, websiteKey: "fixture-sitekey", enterprise });
  return Object.assign(f, { calls, attach, rawRender, rawEnterpriseRender, registered, startDocument, install, bridge, target });
}

module.exports = async function runRecaptchaObserverTests({ check, checkAsync }) {
  check("reCAPTCHA observer: captures late public API initialization and preserves render arguments, receiver, return, and properties", () => {
    const f = observerFixture();
    assert.strictEqual(f.install(), true);
    const received = [];
    const parameters = { sitekey: "fixture-sitekey", callback: (token) => received.push(token) };
    f.environment.window.grecaptcha = {};
    f.environment.window.grecaptcha.render = f.rawRender;
    const renderer = f.environment.window.grecaptcha.render;
    const receiver = { arbitrary: "public-call-receiver" };
    assert.strictEqual(renderer.call(receiver, f.root, parameters, "extra-argument"), 0);
    assert.strictEqual(f.calls[0].receiver, receiver);
    assert.strictEqual(f.calls[0].args[0], f.root);
    assert.strictEqual(f.calls[0].args[1], parameters);
    assert.strictEqual(f.calls[0].args[2], "extra-argument");
    assert.strictEqual(renderer.fixtureProperty, f.rawRender.fixtureProperty);
    assert.strictEqual(renderer.name, f.rawRender.name);
    assert.strictEqual(renderer.length, f.rawRender.length);
    const metadata = f.bridge().lookup(f.target());
    assert.strictEqual(metadata.callbackSource, "observed");
    assert.deepStrictEqual(Object.keys(metadata).sort(), ["callbackSource", "recordId"]);
    assert.strictEqual(f.bridge().invoke(metadata.recordId, f.target(), "fixture-token").invoked, true);
    assert.deepStrictEqual(received, ["fixture-token"]);
    assert.strictEqual(f.bridge().invoke(metadata.recordId, f.target(), "fixture-token").invoked, false);
    assert.deepStrictEqual(received, ["fixture-token"]);
    assert.strictEqual(f.bridge().lookup(f.target()).recordId, metadata.recordId, "Consumed metadata remains stable for the existing Next check");
  });

  check("reCAPTCHA observer: captures a public string callback and refuses its replacement", () => {
    const f = observerFixture();
    f.install();
    const received = [];
    const callbackOwner = { done(token) { assert.strictEqual(this, callbackOwner); received.push(token); } };
    f.environment.window.captcha = callbackOwner;
    f.environment.window.grecaptcha = { render: f.rawRender };
    f.environment.window.grecaptcha.render("render-container", { sitekey: "fixture-sitekey", callback: "captcha.done" });
    const first = f.bridge().lookup(f.target());
    assert.strictEqual(f.bridge().invoke(first.recordId, f.target(), "fixture-string-token").invoked, true);
    assert.deepStrictEqual(received, ["fixture-string-token"]);
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: "captcha.done" });
    const second = f.bridge().lookup(f.target());
    callbackOwner.done = () => { throw new Error("Replaced callback must not run"); };
    assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    assert.strictEqual(f.bridge().invoke(second.recordId, f.target(), "fixture-token").invoked, false);
  });

  check("reCAPTCHA observer: enterprise render is bound separately to its observed frame type", () => {
    const f = observerFixture();
    f.install();
    const received = [];
    f.environment.window.grecaptcha = {};
    f.environment.window.grecaptcha.enterprise = {};
    f.environment.window.grecaptcha.enterprise.render = f.rawEnterpriseRender;
    assert.strictEqual(f.environment.window.grecaptcha.enterprise.render(f.root, {
      sitekey: "fixture-sitekey", callback: (token) => received.push(token),
    }), 0);
    assert.strictEqual(f.bridge().lookup(f.target(false)).callbackSource, "none");
    const metadata = f.bridge().lookup(f.target(true));
    assert.strictEqual(metadata.callbackSource, "observed");
    assert.strictEqual(f.bridge().invoke(metadata.recordId, f.target(true), "enterprise-fixture-token").invoked, true);
    assert.deepStrictEqual(received, ["enterprise-fixture-token"]);
  });

  check("reCAPTCHA observer: same sitekey cannot associate a different container or detached/replaced widget", () => {
    const f = observerFixture();
    f.install();
    f.environment.window.grecaptcha = { render: f.rawRender };
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => { throw new Error("Must not call"); } });
    const metadata = f.bridge().lookup(f.target());
    assert.strictEqual(f.bridge().lookup({ ...f.target(), websiteKey: "different-key" }).callbackSource, "none");
    const other = fixture();
    assert.strictEqual(f.bridge().lookup({ ...f.target(), frame: other.frame, response: other.response }).callbackSource, "none");
    f.attach(f.root);
    assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    assert.strictEqual(f.bridge().invoke(metadata.recordId, f.target(), "fixture-token").invoked, false);
  });

  check("reCAPTCHA observer: re-render and public property replacement invalidate old records", () => {
    const f = observerFixture();
    f.install();
    f.environment.window.grecaptcha = { render: f.rawRender };
    const received = [];
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => received.push("old") });
    const first = f.bridge().lookup(f.target());
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => received.push("new") });
    const second = f.bridge().lookup(f.target());
    assert.notStrictEqual(second.recordId, first.recordId);
    assert.strictEqual(f.bridge().invoke(first.recordId, f.target(), "fixture-token").invoked, false);
    Object.defineProperty(f.environment.window.grecaptcha, "render", { value: f.rawRender, configurable: true, writable: true });
    assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    assert.strictEqual(f.bridge().invoke(second.recordId, f.target(), "fixture-token").invoked, false);
    assert.deepStrictEqual(received, []);
  });

  check("reCAPTCHA observer: missing callbacks, config getters, and public API getters are never guessed or proactively read", () => {
    const f = observerFixture();
    f.install();
    f.environment.window.grecaptcha = { render: f.rawRender };
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey" });
    assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    const parameters = { sitekey: "fixture-sitekey" };
    Object.defineProperty(parameters, "callback", { get() { throw new Error("Config getter must not run"); } });
    f.environment.window.grecaptcha.render(f.root, parameters);
    assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    const guarded = observerFixture();
    let reads = 0;
    Object.defineProperty(guarded.environment.window, "grecaptcha", {
      configurable: true, get() { reads += 1; throw new Error("Public API getter must not run"); },
    });
    assert.strictEqual(guarded.install(), false);
    assert.strictEqual(reads, 0);
    assert.strictEqual(guarded.bridge().lookup(guarded.target()).callbackSource, "none");
    const api = {};
    Object.defineProperty(api, "render", { configurable: true, get() { reads += 1; throw new Error("render getter must not run"); } });
    f.environment.window.grecaptcha = api;
    assert.strictEqual(reads, 0);
  });

  check("reCAPTCHA observer: nonconfigurable/nonwritable methods and already rendered widgets remain unobserved", () => {
    for (const property of [{ configurable: false, writable: true }, { configurable: true, writable: false }]) {
      const f = observerFixture();
      f.install();
      const api = {};
      Object.defineProperty(api, "render", { value: f.rawRender, ...property });
      f.environment.window.grecaptcha = api;
      assert.strictEqual(api.render, f.rawRender);
      api.render(f.root, { sitekey: "fixture-sitekey", callback: () => {} });
      assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    }
    const existing = observerFixture();
    existing.environment.window.grecaptcha = { render: existing.rawRender };
    existing.environment.window.grecaptcha.render(existing.root, { sitekey: "fixture-sitekey", callback: () => {} });
    assert.strictEqual(existing.install(), true);
    assert.strictEqual(existing.bridge().lookup(existing.target()).callbackSource, "none");
  });

  check("reCAPTCHA observer: render exceptions are preserved and bridge metadata leaks neither callbacks nor tokens", () => {
    const f = observerFixture();
    f.install();
    const expectedError = new Error("fixture-render-error");
    f.environment.window.grecaptcha = { render() { throw expectedError; } };
    assert.throws(() => f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => {} }), (error) => error === expectedError);
    assert.strictEqual(f.bridge().lookup(f.target()).callbackSource, "none");
    assert.strictEqual(Object.keys(f.environment.window).includes(observer.BRIDGE_KEY), false);
    assert.deepStrictEqual(Object.keys(f.bridge()).sort(), ["invoke", "lookup", "observerId", "version"]);
    assert.ok(!JSON.stringify(f.bridge()).includes("fixture-token"));
    assert.ok(!JSON.stringify(f.bridge()).includes("callback"));
    assert.ok(!JSON.stringify(f.bridge()).includes("sitekey"));
    assert.strictEqual(observer.helpers.installRecaptchaObserverDOM({ observerId: "fixture-observer" }, fixture({ url: "https://other.example/" }).environment), false);
  });

  await checkAsync("reCAPTCHA observer integration: register once before navigation and invoke the bound observed callback through adapter", async () => {
    const f = observerFixture();
    assert.deepStrictEqual(await observer.installRecaptchaObserver(f.page), { installed: true });
    assert.deepStrictEqual(await observer.installRecaptchaObserver(f.page), { installed: true });
    assert.strictEqual(f.registered.length, 1);
    assert.strictEqual(Object.getOwnPropertyDescriptor(f.environment.window, observer.BRIDGE_KEY), undefined, "Registration must not mutate the old document");
    assert.deepStrictEqual(f.startDocument(), [true]);
    const received = [];
    f.environment.window.grecaptcha = { render: f.rawRender };
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: (token) => received.push(token) });
    f.root.attrs["data-s"] = "fixture-s-value";
    const snapshot = await adapter.inspectRecaptcha(f.page, { email: EMAIL });
    assert.strictEqual(snapshot.supported, true);
    assert.strictEqual(snapshot.callbackSource, "observed");
    assert.strictEqual(snapshot.hasDataS, true);
    const result = await adapter.submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
    assert.deepStrictEqual(result, { submitted: true, reason: "callback_invoked", callbackInvoked: true, callbackSource: "observed", hasDataS: true });
    assert.deepStrictEqual(received, ["fixture-token"]);
    assert.deepStrictEqual(f.response.events, ["input", "change"]);
    assert.ok(!JSON.stringify(result).includes("fixture-token"));
    assert.ok(!JSON.stringify(result).includes("fixture-s-value"));
    const after = await adapter.inspectRecaptcha(f.page, { email: EMAIL });
    assert.strictEqual(after.fingerprint, snapshot.fingerprint);
  });

  await checkAsync("reCAPTCHA observer integration: mismatched observer IDs, a re-render, or a replacement callback cannot be invoked", async () => {
    const f = observerFixture();
    await observer.installRecaptchaObserver(f.page);
    f.startDocument();
    f.environment.window.grecaptcha = { render: f.rawRender };
    const received = [];
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: (token) => received.push(token) });
    assert.strictEqual(adapter.helpers.inspectRecaptchaDOM({ email: EMAIL, observerId: "wrong-observer" }, f.environment).callbackSource, "none");
    const snapshot = await adapter.inspectRecaptcha(f.page, { email: EMAIL });
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => { throw new Error("Replacement callback must not run"); } });
    const result = await adapter.submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
    assert.strictEqual(result.submitted, false);
    assert.strictEqual(result.reason, "challenge_changed");
    assert.strictEqual(f.response.value, "");
    assert.deepStrictEqual(received, []);
  });

  await checkAsync("reCAPTCHA observer integration: the actual render callback overrides a stale data-callback declaration", async () => {
    const f = observerFixture({ fixture: { attrs: { id: "render-container", "data-callback": "oldDeclared" } } });
    await observer.installRecaptchaObserver(f.page);
    f.startDocument();
    const called = [];
    f.environment.window.oldDeclared = () => called.push("old");
    f.environment.window.grecaptcha = { render: f.rawRender };
    f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => called.push("observed") });
    const snapshot = await adapter.inspectRecaptcha(f.page, { email: EMAIL });
    assert.strictEqual(snapshot.callbackSource, "observed");
    const result = await adapter.submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
    assert.strictEqual(result.submitted, true);
    assert.deepStrictEqual(called, ["observed"]);
  });

  await checkAsync("reCAPTCHA observer integration: synchronous response events cannot switch identity or widget before callback", async () => {
    for (const mutate of [
      (f) => Object.defineProperty(f.account, "innerText", { get: () => "other@example.com", configurable: true }),
      (f) => { f.frame.attrs.name = "a-replaced-widget"; },
    ]) {
      const f = observerFixture();
      await observer.installRecaptchaObserver(f.page);
      f.startDocument();
      const called = [];
      f.environment.window.grecaptcha = { render: f.rawRender };
      f.environment.window.grecaptcha.render(f.root, { sitekey: "fixture-sitekey", callback: () => called.push("unsafe") });
      const snapshot = await adapter.inspectRecaptcha(f.page, { email: EMAIL });
      f.response.dispatchEvent = () => { mutate(f); return true; };
      const result = await adapter.submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
      assert.strictEqual(result.submitted, false);
      assert.strictEqual(result.reason, "challenge_changed");
      assert.deepStrictEqual(called, []);
    }
  });
};

if (require.main === module) {
  let passed = 0;
  const check = (name, run) => { run(); passed += 1; console.log(`ok ${name}`); };
  const checkAsync = async (name, run) => { await run(); passed += 1; console.log(`ok ${name}`); };
  module.exports({ check, checkAsync }).then(() => console.log(`${passed} recaptcha observer fixture groups passed`))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
