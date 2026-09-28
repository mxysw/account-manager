"use strict";

const assert = require("assert");
const { inspectRecaptcha, submitRecaptcha, advanceRecaptcha, inspectCheckbox, clickCheckbox, advanceCheckbox,
  helpers: { inspectRecaptchaDOM } } = require("../src/automation/recaptcha");

// Synthetic DOM fixtures only: no accounts module, browser, API, or real data.
const EMAIL = "fixture@example.com";
const PAGE = "https://accounts.google.com/v3/signin/challenge/recaptcha?TL=not-for-provider#fixture";
const ANCHOR = "https://www.google.com/recaptcha/api2/anchor?k=fixture-sitekey&size=normal&cb=fixture-widget";

function node(tag, attrs = {}, children = [], text = "") {
  const element = {
    tagName: tag.toUpperCase(), nodeType: 1, children, parentElement: null, ownerDocument: null,
    hidden: !!attrs.hidden, disabled: !!attrs.disabled, value: attrs.value || "", events: [], clicks: 0, attrs,
    getAttribute: (name) => Object.hasOwn(attrs, name) ? String(attrs[name]) : null,
    setAttribute: (name, value) => { attrs[name] = String(value); },
    getBoundingClientRect: () => ({ width: element.hidden ? 0 : 300, height: element.hidden ? 0 : 80 }),
    get innerText() { return [text, ...children.filter((child) => !child.hidden).map((child) => child.innerText)].filter(Boolean).join(" "); },
    get isConnected() { return !!element.ownerDocument && element.ownerDocument.documentElement.contains(element); },
    matches(selector) {
      return selector.split(",").some((part) => {
        const source = part.trim();
        const tagMatch = source.match(/^[a-z][a-z0-9-]*/i);
        if (tagMatch && tagMatch[0].toUpperCase() !== element.tagName) return false;
        const idMatch = source.match(/#([\w-]+)/);
        if (idMatch && attrs.id !== idMatch[1]) return false;
        for (const match of source.replace(/\[[^\]]*\]/g, "").matchAll(/\.([\w-]+)/g)) {
          if (!String(attrs.class || "").split(/\s+/).includes(match[1])) return false;
        }
        for (const match of source.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
          if (!Object.hasOwn(attrs, match[1]) || (match[2] != null && String(attrs[match[1]]) !== match[2])) return false;
        }
        return true;
      });
    },
    querySelectorAll(selector) {
      return children.flatMap((child) => [child, ...child.querySelectorAll("*")]).filter((child) => child.matches(selector));
    },
    closest(selector) {
      for (let current = element; current; current = current.parentElement) if (current.matches(selector)) return current;
      return null;
    },
    contains(other) {
      for (let current = other; current; current = current.parentElement) if (current === element) return true;
      return false;
    },
    dispatchEvent(event) { element.events.push(event.type); return true; },
    click() { element.clicks += 1; },
  };
  for (const child of children) child.parentElement = element;
  if (tag.toLowerCase() === "iframe") {
    Object.defineProperty(element, "contentDocument", { get() { throw new Error("Must never enter any frame"); } });
  }
  return element;
}

function widget(options = {}) {
  const frame = node("iframe", { src: options.anchor || ANCHOR, name: "a-fixture", hidden: !!options.hidden });
  const response = node("textarea", { name: "g-recaptcha-response", id: options.responseId || "g-recaptcha-response", hidden: true });
  const inner = node("div", {}, [frame, ...(options.noResponse ? [] : [response])]);
  const root = node("div", { "data-sitekey": "fixture-sitekey", ...(options.attrs || {}) }, [inner]);
  return { root, frame, response };
}

function fixture(options = {}) {
  const current = widget(options);
  const account = node(options.accountTag || "div", options.accountAttrs || { id: "profileIdentifier" }, [],
    options.account === undefined ? EMAIL : options.account);
  const body = node("body", {}, [account, ...(options.before || []), current.root, ...(options.after || [])]);
  const html = node("html", {}, [body]);
  const document = {
    body, documentElement: html, location: { href: options.url || PAGE },
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    getElementById: (id) => html.querySelectorAll("*").find((element) => element.getAttribute("id") === id) || null,
  };
  for (const element of [html, ...html.querySelectorAll("*")]) element.ownerDocument = document;
  Object.defineProperty(document, "cookie", { get() { throw new Error("Must never read cookies"); } });
  const window = {
    getComputedStyle: (element) => ({ display: element.attrs.display || "block", visibility: element.attrs.visibility || "visible", opacity: element.attrs.opacity || "1" }),
    Event: class FixtureEvent { constructor(type) { this.type = type; } },
    ...(options.window || {}),
  };
  Object.defineProperty(window, "localStorage", { get() { throw new Error("Must never read storage"); } });
  Object.defineProperty(window, "___grecaptcha_cfg", { get() { throw new Error("Must never read internal callbacks"); } });
  const environment = { document, window };
  const page = { evaluate: async (fn, args) => fn(args, environment) };
  return { ...current, account, environment, page, inspect: () => inspectRecaptchaDOM({ email: EMAIL }, environment) };
}

function checkboxFixture(options = {}) {
  const f = fixture(options.top || {});
  f.page.url = () => f.environment.document.location.href;
  const main = { url: f.page.url };
  const frames = [main];
  const checkbox = node("span", { id: "recaptcha-anchor", role: "checkbox", "aria-checked": options.checked || "false" });
  const environmentFor = (url, children) => {
    const body = node("body", {}, children);
    const html = node("html", {}, [body]);
    const document = { body, documentElement: html, location: { href: url }, querySelectorAll: (selector) => html.querySelectorAll(selector) };
    for (const element of [html, ...html.querySelectorAll("*")]) element.ownerDocument = document;
    Object.defineProperty(document, "cookie", { get() { throw new Error("Must not read frame cookies"); } });
    return { document, window: f.environment.window };
  };
  const anchorEnvironment = environmentFor(f.frame.attrs.src, [checkbox]);
  const handle = {
    evaluate: async (fn) => fn(checkbox),
    click: async () => { checkbox.click(); options.onClick?.(f); },
    dispose: async () => {},
  };
  const anchor = {
    url: () => anchorEnvironment.document.location.href, name: () => f.frame.attrs.name,
    parentFrame: () => main,
    evaluate: async (fn, args) => fn(args, anchorEnvironment),
    $: async (selector) => selector === "#recaptcha-anchor" ? handle : null,
  };
  frames.push(anchor);
  f.page.frames = () => frames;
  f.page.mainFrame = () => main;
  const showPanel = (kind = "image") => {
    const iframe = node("iframe", { src: f.frame.attrs.src.replace("/anchor", "/bframe"), name: "c-fixture" });
    iframe.parentElement = f.environment.document.body;
    iframe.ownerDocument = f.environment.document;
    f.environment.document.body.children.push(iframe);
    const content = kind === "image" ? node("div", { id: "rc-imageselect" })
      : kind === "audio" ? node("div", { class: "rc-audiochallenge-controls" })
        : kind === "error" ? node("div", { class: "rc-doscaptcha-header" }, [], "Try again later") : node("div");
    const environment = environmentFor(iframe.attrs.src, [content]);
    const panel = {
      url: () => environment.document.location.href, name: () => iframe.attrs.name,
      parentFrame: () => main, evaluate: async (fn, args) => fn(args, environment),
    };
    frames.push(panel);
    return { iframe, panel, content, environment };
  };
  return Object.assign(f, { checkbox, anchor, anchorEnvironment, frames, handle, showPanel });
}

module.exports = async function runRecaptchaTests({ check, checkAsync }) {
  check("reCAPTCHA DOM: standard v2 and enterprise derive only observed widget values", () => {
    const regular = fixture().inspect();
    assert.strictEqual(regular.supported, true);
    assert.deepStrictEqual(regular.challenge, {
      type: "recaptcha-v2", websiteURL: "https://accounts.google.com/v3/signin/challenge/recaptcha",
      websiteKey: "fixture-sitekey", enterprise: false, isInvisible: false,
    });
    const enterprise = fixture({ anchor: ANCHOR.replace("api2", "enterprise") + "&s=fixture-data-s&sa=fixture-action" }).inspect();
    assert.strictEqual(enterprise.challenge.enterprise, true);
    assert.strictEqual(enterprise.challenge.dataS, "fixture-data-s");
    assert.strictEqual(enterprise.challenge.pageAction, "fixture-action");
    assert.ok(!enterprise.challenge.websiteURL.includes("TL="));
    assert.ok(!enterprise.challenge.websiteURL.includes("#"));
    const dataS = fixture({ attrs: { "data-s": "fixture-attribute-s" } }).inspect();
    assert.strictEqual(dataS.challenge.dataS, "fixture-attribute-s");
  });

  check("reCAPTCHA DOM: missing, mismatched, ambiguous, or hidden account blocks solving", () => {
    assert.strictEqual(fixture({ account: "" }).inspect().reason, "account_not_visible");
    assert.strictEqual(fixture({ account: "" }).inspect().present, true);
    assert.strictEqual(fixture({ account: "other@example.com" }).inspect().reason, "account_mismatch");
    assert.strictEqual(fixture({ account: "other@example.com" }).inspect().present, true);
    assert.strictEqual(fixture({ accountAttrs: { id: "profileIdentifier", hidden: true } }).inspect().reason, "account_not_visible");
    assert.strictEqual(fixture({ before: [node("div", { "data-email": "other@example.com" }, [], "other@example.com")] }).inspect().reason, "account_mismatch");
    assert.strictEqual(fixture({ accountAttrs: { "data-identifier": EMAIL } }).inspect().supported, true);
    assert.strictEqual(fixture({ accountAttrs: {}, accountTag: "span" }).inspect().supported, true);
    assert.strictEqual(fixture({ account: "", before: [node("input", { type: "password", value: EMAIL })] }).inspect().reason, "account_not_visible");
    assert.strictEqual(fixture({ account: "", before: [node("input", { type: "email", value: EMAIL, hidden: true })] }).inspect().reason, "account_not_visible");
  });

  check("reCAPTCHA DOM: account comparison ignores letter case but not distinct identities or aliases", () => {
    assert.strictEqual(fixture({ account: "Fixture@EXAMPLE.COM" }).inspect().supported, true);
    const duplicate = fixture({ before: [node("div", { "data-email": "Fixture@EXAMPLE.COM" }, [], "Fixture@EXAMPLE.COM")] });
    assert.strictEqual(duplicate.inspect().supported, true);
    for (const different of ["other@example.com", "fix.ture@example.com", "fixture+tag@example.com", "fixture@different.example"]) {
      assert.strictEqual(fixture({ account: different }).inspect().reason, "account_mismatch");
      assert.strictEqual(fixture({ before: [node("div", { "data-email": different }, [], different)] }).inspect().reason, "account_mismatch");
    }
  });

  check("reCAPTCHA DOM: only the exact secure Google login challenge origin is allowed", () => {
    for (const url of ["http://accounts.google.com/v3/signin/challenge/recaptcha", "https://accounts.google.com.evil.test/v3/signin/challenge/recaptcha",
      "https://myaccount.google.com/v3/signin/challenge/recaptcha", "https://accounts.google.com:444/v3/signin/challenge/recaptcha", "https://accounts.google.com/v3/signin/identifier"]) {
      assert.strictEqual(fixture({ url }).inspect().reason, "unsupported_page");
    }
    assert.strictEqual(fixture({ after: [node("p", {}, [], "This browser or app may not be secure")] }).inspect().reason, "browser_blocked");
    assert.strictEqual(fixture({ anchor: ANCHOR.replace("www.google.com", "www.google.com.evil.test") }).inspect().supported, false);
    assert.strictEqual(fixture({ anchor: ANCHOR.replace("www.google.com", "www.google.com.evil.test") }).inspect().present, true);
    assert.strictEqual(fixture({ anchor: ANCHOR.replace("www.google.com", "www.recaptcha.net") }).inspect().supported, true);
  });

  check("reCAPTCHA DOM: hidden, orphan, multiple, and unrendered widgets fail closed", () => {
    assert.strictEqual(fixture({ hidden: true }).inspect().reason, "challenge_not_visible");
    assert.strictEqual(fixture({ hidden: true }).inspect().present, false);
    assert.strictEqual(fixture({ attrs: { display: "none" } }).inspect().reason, "challenge_not_visible");
    assert.strictEqual(fixture({ attrs: { display: "none" } }).inspect().present, false);
    assert.strictEqual(fixture({ hidden: true, account: "" }).inspect().present, false);
    const bare = fixture();
    bare.root.children.splice(0);
    assert.strictEqual(bare.inspect().reason, "challenge_not_visible");
    assert.strictEqual(bare.inspect().present, false);
    assert.strictEqual(fixture({ after: [widget().root] }).inspect().reason, "multiple_widgets");
    assert.strictEqual(fixture({ noResponse: true }).inspect().reason, "response_missing");
    const extra = fixture();
    const response = node("textarea", { name: "g-recaptcha-response", hidden: true });
    response.parentElement = extra.root;
    extra.root.children.push(response);
    assert.strictEqual(extra.inspect().reason, "response_ambiguous");
    assert.strictEqual(fixture({ attrs: { "data-sitekey": "different-sitekey" } }).inspect().reason, "widget_data_mismatch");
    assert.strictEqual(fixture({ anchor: ANCHOR.replace("fixture-sitekey", ""), attrs: { "data-sitekey": "" } }).inspect().reason, "sitekey_missing");
  });

  check("reCAPTCHA DOM: v3 and unproven invisible task types are rejected", () => {
    const script = node("script", { src: "https://www.google.com/recaptcha/api.js?render=fixture-sitekey" });
    assert.strictEqual(fixture({ after: [script] }).inspect().reason, "unsupported_v3");
    assert.strictEqual(fixture({ anchor: ANCHOR.replace("size=normal", "size=invisible") }).inspect().reason, "unsupported_invisible");
    assert.strictEqual(fixture({ anchor: ANCHOR + "&s=anchor-value", attrs: { "data-s": "other-value" } }).inspect().reason, "widget_data_mismatch");
  });

  check("reCAPTCHA DOM: callbacks must be explicit callable properties without getters or private traversal", () => {
    assert.strictEqual(fixture({ attrs: { "data-callback": "missing" } }).inspect().reason, "callback_unavailable");
    assert.strictEqual(fixture({ attrs: { "data-callback": "constructor.constructor" } }).inspect().reason, "callback_unsupported");
    const state = fixture({ attrs: { "data-callback": "trap" } });
    Object.defineProperty(state.environment.window, "trap", { get() { throw new Error("getter must not run"); } });
    assert.strictEqual(state.inspect().reason, "callback_unavailable");
  });

  await checkAsync("reCAPTCHA submission: write only the bound response, emit events, and invoke only its declared callback", async () => {
    const calls = [];
    const orphan = widget({ hidden: true });
    const f = fixture({ before: [orphan.root], attrs: { "data-callback": "captcha.done" }, window: {
      captcha: { done(token) { calls.push(token); } }, otherCallback() { throw new Error("must not call"); },
    } });
    const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
    assert.strictEqual(snapshot.supported, true);
    assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
    assert.strictEqual(Object.hasOwn(snapshot, "binding"), false);
    const result = await submitRecaptcha(f.page, snapshot, "fixture-response-token", { email: EMAIL });
    assert.deepStrictEqual(result, { submitted: true, reason: "callback_invoked", callbackInvoked: true, callbackSource: "explicit", hasDataS: false });
    assert.strictEqual(f.response.value, "fixture-response-token");
    assert.deepStrictEqual(f.response.events, ["input", "change"]);
    assert.deepStrictEqual(calls, ["fixture-response-token"]);
    assert.strictEqual(orphan.response.value, "");
    assert.deepStrictEqual(orphan.response.events, []);
    assert.ok(!JSON.stringify(result).includes("fixture-response-token"));
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-response-token", { email: EMAIL })).reason, "snapshot_invalid");
  });

  await checkAsync("reCAPTCHA submission: plain response works without inspecting internal callback registries or clicking", async () => {
    const f = fixture();
    const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
    const result = await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
    assert.deepStrictEqual(result, { submitted: true, reason: "response_populated", callbackInvoked: false, callbackSource: "none", hasDataS: false });
    assert.strictEqual(f.response.value, "fixture-token");
  });

  await checkAsync("reCAPTCHA submission: case-insensitive page identity preserves exact caller and snapshot bindings", async () => {
    const mixedEmail = "Fixture@EXAMPLE.COM";
    const next = node("button", {}, [], "Next");
    const f = fixture({ after: [next] });
    const snapshot = await inspectRecaptcha(f.page, { email: mixedEmail });
    assert.strictEqual(snapshot.supported, true);
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL })).reason, "snapshot_invalid");
    assert.strictEqual(f.response.value, "");
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: mixedEmail })).submitted, true);
    assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).reason, "snapshot_invalid");
    assert.strictEqual(next.clicks, 0);
    assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: mixedEmail })).advanced, true);
    assert.strictEqual(next.clicks, 1);

    const changed = fixture();
    const original = await inspectRecaptcha(changed.page, { email: mixedEmail });
    Object.defineProperty(changed.account, "innerText", { get: () => "other@example.com" });
    assert.strictEqual((await submitRecaptcha(changed.page, original, "fixture-token", { email: mixedEmail })).reason, "account_mismatch");
    assert.strictEqual(changed.response.value, "");
  });

  await checkAsync("reCAPTCHA submission: page, account, widget, response, callback, and visibility changes invalidate the observation", async () => {
    for (const mutate of [
      (f) => { f.environment.document.location.href = "https://other.example/v3/signin/challenge/recaptcha"; },
      (f) => { f.environment.document.location.href = PAGE.replace("challenge/recaptcha", "challenge/pwd"); },
      (f) => { f.account.hidden = true; },
      (f) => { f.frame.hidden = true; },
      (f) => { f.frame.attrs.src += "&s=changed-challenge"; },
      (f) => { f.frame.attrs.name = "a-different-widget"; },
      (f) => { f.response.attrs.id = "changed-response"; },
      (f) => { f.root.attrs["data-callback"] = "newCallback"; f.environment.window.newCallback = () => {}; },
    ]) {
      const f = fixture();
      const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
      mutate(f);
      assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL })).submitted, false);
      assert.strictEqual(f.response.value, "");
      assert.deepStrictEqual(f.response.events, []);
    }
    const f = fixture();
    const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
    assert.strictEqual((await submitRecaptcha(f.page, { ...snapshot }, "fixture-token", { email: EMAIL })).reason, "snapshot_invalid");
    assert.strictEqual((await submitRecaptcha(fixture().page, snapshot, "fixture-token", { email: EMAIL })).reason, "snapshot_invalid");
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: "other@example.com" })).reason, "snapshot_invalid");
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "", { email: EMAIL })).reason, "invalid_token");
    snapshot.challenge.websiteKey = "tampered-key";
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL })).reason, "snapshot_invalid");
    assert.strictEqual(f.response.value, "");
  });

  await checkAsync("reCAPTCHA evaluation: hung and failed evaluations are bounded and redact error details", async () => {
    const hanging = { evaluate: () => new Promise(() => {}) };
    assert.strictEqual((await inspectRecaptcha(hanging, { email: EMAIL, timeoutMs: 5 })).reason, "evaluation_timeout");
    const throwing = { evaluate: async () => { throw new Error("fixture-sensitive-detail"); } };
    assert.deepStrictEqual(await inspectRecaptcha(throwing, { email: EMAIL }), {
      supported: false, present: false, reason: "evaluation_failed", callbackSource: "none", hasDataS: false,
    });
    const f = fixture();
    const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
    f.page.evaluate = hanging.evaluate;
    assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL, timeoutMs: 5 })).reason, "evaluation_timeout");
    const expired = inspectRecaptchaDOM({ mode: "submit", email: EMAIL, token: "fixture-token", expiresAt: Date.now() - 1 }, f.environment);
    assert.strictEqual(expired.reason, "evaluation_timeout");
    assert.strictEqual(f.response.value, "");
  });

  await checkAsync("reCAPTCHA Next: requires a successful submission and clicks the same challenge only once", async () => {
    for (const label of ["Next", "下一步", "Suivant", "Weiter", "次へ", "다음"]) {
      const next = node("button", {}, [], label);
      const f = fixture({ after: [next] });
      const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
      assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).reason, "submission_required");
      await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
      assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).advanced, true);
      assert.strictEqual(next.clicks, 1);
      assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).reason, "advance_already_attempted");
      assert.strictEqual((await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL })).submitted, false);
      assert.strictEqual(next.clicks, 1);
    }
  });

  await checkAsync("reCAPTCHA Next: navigation between observation and click never clicks password/TOTP", async () => {
    for (const path of ["pwd", "totp"]) {
      const next = node("button", {}, [], "Next");
      const f = fixture({ after: [next] });
      const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
      await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
      assert.strictEqual((await inspectRecaptcha(f.page, { email: EMAIL })).fingerprint, snapshot.fingerprint);
      const evaluate = f.page.evaluate;
      f.page.evaluate = async (fn, args) => {
        if (args.mode === "advance") f.environment.document.location.href = PAGE.replace("challenge/recaptcha", `challenge/${path}`);
        return evaluate(fn, args);
      };
      assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).advanced, false);
      assert.strictEqual(next.clicks, 0);
    }
  });

  await checkAsync("reCAPTCHA Next: rejects unrelated step IDs, ambiguous buttons, disabled buttons, and unknown labels", async () => {
    const cases = [
      [node("div", { id: "passwordNext" }, [node("button", {}, [], "Next")])],
      [node("div", { id: "totpNext" }, [node("button", {}, [], "下一步")])],
      [node("button", {}, [], "Next"), node("button", {}, [], "Continue")],
      [node("button", { disabled: true }, [], "Next")],
      [node("button", { hidden: true }, [], "Next")],
      [node("button", {}, [], "Approve")],
    ];
    for (const buttons of cases) {
      const f = fixture({ after: buttons });
      const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
      await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
      assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).advanced, false);
      assert.ok(buttons.flatMap((button) => [button, ...button.querySelectorAll("*")]).every((button) => button.clicks === 0));
    }
  });

  await checkAsync("reCAPTCHA Next: a changed widget and a delayed expired evaluation cannot click", async () => {
    const next = node("button", {}, [], "Next");
    const f = fixture({ after: [next] });
    const snapshot = await inspectRecaptcha(f.page, { email: EMAIL });
    await submitRecaptcha(f.page, snapshot, "fixture-token", { email: EMAIL });
    f.frame.attrs.name = "a-changed-widget";
    assert.strictEqual((await advanceRecaptcha(f.page, snapshot, { email: EMAIL })).reason, "challenge_changed");
    assert.strictEqual(next.clicks, 0);
    const fresh = fixture({ after: [node("button", {}, [], "Next")] });
    const bound = await inspectRecaptcha(fresh.page, { email: EMAIL });
    await submitRecaptcha(fresh.page, bound, "fixture-token", { email: EMAIL });
    let late;
    fresh.page.evaluate = (fn, args) => new Promise((resolve) => { late = () => resolve(fn(args, fresh.environment)); });
    assert.strictEqual((await advanceRecaptcha(fresh.page, bound, { email: EMAIL, timeoutMs: 5 })).reason, "evaluation_timeout");
    late();
    assert.strictEqual(fresh.environment.document.querySelectorAll("button")[0].clicks, 0);
  });

  await checkAsync("checkbox preflight: reads public unchecked/checking/passed states without a response or callback", async () => {
    const f = checkboxFixture({ top: { noResponse: true, attrs: { "data-callback": "notAvailable" } } });
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "unchecked");
    f.checkbox.attrs["aria-busy"] = "true";
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "checking");
    delete f.checkbox.attrs["aria-busy"];
    f.checkbox.attrs["aria-checked"] = "true";
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "passed");
    assert.strictEqual(f.checkbox.clicks, 0);
  });

  await checkAsync("checkbox preflight: hidden/no widgets on ordinary challenge pages are absent even before account hydration", async () => {
    for (const path of ["pwd", "totp", "iap"]) {
      const f = checkboxFixture({ top: { account: "", hidden: true, url: PAGE.replace("recaptcha?", `${path}?`) } });
      assert.deepStrictEqual(await inspectCheckbox(f.page, { email: EMAIL }), { state: "absent", present: false, reason: "challenge_not_visible" });
      f.root.children.splice(0);
      delete f.root.attrs["data-sitekey"];
      assert.deepStrictEqual(await inspectCheckbox(f.page, { email: EMAIL }), { state: "absent", present: false, reason: "challenge_missing" });
    }
    const next = checkboxFixture({ top: { url: "https://myaccount.google.com/" } });
    assert.deepStrictEqual(await inspectCheckbox(next.page, { email: EMAIL }), { state: "absent", present: false, reason: "unsupported_page" });
  });

  await checkAsync("checkbox preflight: no visible CAPTCHA stays absent with mixed-case or missing page identity", async () => {
    for (const account of [EMAIL, "Fixture@EXAMPLE.COM", ""]) {
      const f = checkboxFixture({ top: { account, hidden: true, url: PAGE.replace("recaptcha?", "pwd?") } });
      const options = { email: "Fixture@example.com" };
      assert.deepStrictEqual(await inspectCheckbox(f.page, options), { state: "absent", present: false, reason: "challenge_not_visible" });
      assert.strictEqual((await clickCheckbox(f.page, options)).clicked, false);
      assert.strictEqual(f.checkbox.clicks, 0);
      f.root.children.splice(0);
      assert.deepStrictEqual(await inspectCheckbox(f.page, options), { state: "absent", present: false, reason: "challenge_not_visible" });
      delete f.root.attrs["data-sitekey"];
      assert.deepStrictEqual(await inspectCheckbox(f.page, options), { state: "absent", present: false, reason: "challenge_missing" });
    }
  });

  await checkAsync("checkbox preflight: distinct or multiple visible identities stop even without a CAPTCHA", async () => {
    for (const top of [
      { account: "other@example.com" },
      { account: EMAIL, before: [node("div", { "data-email": "other@example.com" }, [], "other@example.com")] },
    ]) {
      const f = checkboxFixture({ top: { ...top, hidden: true, url: PAGE.replace("recaptcha?", "pwd?") } });
      const options = { email: "Fixture@example.com" };
      assert.deepStrictEqual(await inspectCheckbox(f.page, options), { state: "unsupported", present: false, reason: "account_mismatch" });
      f.root.children.splice(0);
      delete f.root.attrs["data-sitekey"];
      assert.deepStrictEqual(await inspectCheckbox(f.page, options), { state: "unsupported", present: false, reason: "account_mismatch" });
      assert.strictEqual((await clickCheckbox(f.page, options)).clicked, false);
      assert.strictEqual((await advanceCheckbox(f.page, options)).advanced, false);
      assert.strictEqual(f.checkbox.clicks, 0);
    }
  });

  await checkAsync("checkbox preflight: visible widget accepts the same mixed-case account but protects different/multiple identities", async () => {
    const options = { email: "Fixture@example.com" };
    for (const account of [EMAIL, "Fixture@EXAMPLE.COM"]) {
      const f = checkboxFixture({ top: { account } });
      assert.strictEqual((await inspectCheckbox(f.page, options)).state, "unchecked");
      assert.strictEqual((await clickCheckbox(f.page, options)).clicked, true);
      assert.strictEqual(f.checkbox.clicks, 1);
    }
    for (const top of [
      { account: "other@example.com" },
      { account: EMAIL, before: [node("div", { "data-email": "other@example.com" }, [], "other@example.com")] },
      { account: "" },
      { accountAttrs: { id: "profileIdentifier", hidden: true } },
    ]) {
      const f = checkboxFixture({ top });
      const observed = await inspectCheckbox(f.page, options);
      assert.strictEqual(observed.state, "unsupported");
      assert.strictEqual(observed.present, true);
      assert.ok(["account_mismatch", "account_not_visible"].includes(observed.reason));
      assert.strictEqual((await clickCheckbox(f.page, options)).clicked, false);
      assert.strictEqual((await advanceCheckbox(f.page, options)).advanced, false);
      assert.strictEqual(f.checkbox.clicks, 0);
    }
  });

  await checkAsync("checkbox preflight: wrong account, foreign host, hidden identity, and multiple visible widgets fail closed", async () => {
    for (const top of [{ account: "other@example.com" }, { account: "" }, { url: "https://evil.example/v3/signin/challenge/recaptcha" }, { after: [widget().root] }]) {
      const f = checkboxFixture({ top });
      assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "unsupported");
      assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, false);
      assert.strictEqual(f.checkbox.clicks, 0);
    }
  });

  await checkAsync("checkbox preflight: reads only matching known frames and distinguishes visible image/audio challenges and errors", async () => {
    for (const kind of ["image", "audio", "loading", "error"]) {
      const f = checkboxFixture();
      f.frames.push({ url: () => "https://unknown.example/recaptcha/api2/anchor", name: () => "unknown", parentFrame: () => f.page.mainFrame(),
        evaluate: () => { throw new Error("Unknown frame must never be inspected"); } });
      f.showPanel(kind);
      const expected = kind === "loading" ? "checking" : kind === "error" ? "error" : "challenge";
      assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, expected);
      assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, false);
      assert.strictEqual(f.checkbox.clicks, 0);
    }
    const expired = checkboxFixture();
    const message = node("div", { id: "recaptcha-error-message" }, [], "Verification expired");
    message.parentElement = expired.anchorEnvironment.document.body;
    expired.anchorEnvironment.document.body.children.push(message);
    assert.strictEqual((await inspectCheckbox(expired.page, { email: EMAIL })).reason, "checkbox_expired");
  });

  await checkAsync("checkbox preflight: rejects ambiguous iframe ownership and changing account during frame reads", async () => {
    const f = checkboxFixture();
    const panel = f.showPanel();
    panel.iframe.attrs.name = "c-some-other-widget";
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).reason, "frame_ambiguous");
    const duplicated = checkboxFixture();
    duplicated.frames.push({ ...duplicated.anchor });
    assert.strictEqual((await inspectCheckbox(duplicated.page, { email: EMAIL })).reason, "frame_ambiguous");
    const changing = checkboxFixture();
    const evaluate = changing.anchor.evaluate;
    changing.anchor.evaluate = async (fn, args) => {
      const result = await evaluate(fn, args);
      Object.defineProperty(changing.account, "innerText", { get: () => "other@example.com" });
      return result;
    };
    assert.strictEqual((await inspectCheckbox(changing.page, { email: EMAIL })).reason, "challenge_changed");
  });

  await checkAsync("checkbox preflight: native checkbox click happens once and can pass without a provider or token", async () => {
    const next = node("button", {}, [], "Next");
    const f = checkboxFixture({ top: { after: [next] }, onClick: (state) => { state.checkbox.attrs["aria-checked"] = "true"; } });
    Object.defineProperty(f.response, "value", { get() { throw new Error("Must not read response token"); }, set() { throw new Error("Must not write response token"); } });
    assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, true);
    assert.strictEqual(f.checkbox.clicks, 1);
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "passed");
    assert.strictEqual((await advanceCheckbox(f.page, { email: EMAIL })).advanced, true);
    assert.strictEqual(next.clicks, 1);
    assert.strictEqual((await advanceCheckbox(f.page, { email: EMAIL })).advanced, false);
    assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, false);
    assert.strictEqual(f.checkbox.clicks, 1);
    assert.deepStrictEqual(f.response.events, []);
  });

  await checkAsync("checkbox preflight: one native click can expose an additional challenge and cannot be repeated", async () => {
    const f = checkboxFixture({ onClick: (state) => state.showPanel() });
    assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, true);
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "challenge");
    assert.strictEqual((await advanceCheckbox(f.page, { email: EMAIL })).advanced, false);
    assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, false);
    const unchanged = checkboxFixture();
    assert.strictEqual((await clickCheckbox(unchanged.page, { email: EMAIL })).clicked, true);
    assert.strictEqual((await clickCheckbox(unchanged.page, { email: EMAIL })).reason, "checkbox_already_attempted");
    assert.strictEqual(unchanged.checkbox.clicks, 1);
  });

  await checkAsync("checkbox preflight: native click refuses account changes after obtaining the checkbox handle", async () => {
    const f = checkboxFixture();
    f.anchor.$ = async () => {
      Object.defineProperty(f.account, "innerText", { get: () => "other@example.com" });
      return f.handle;
    };
    assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, false);
    assert.strictEqual(f.checkbox.clicks, 0);
  });

  await checkAsync("checkbox preflight: a passed checkbox may wait for a missing/disabled Next without consuming the click", async () => {
    const f = checkboxFixture({ checked: "true" });
    assert.deepStrictEqual(await advanceCheckbox(f.page, { email: EMAIL }), { advanced: false, attempted: false, reason: "next_missing" });
    const next = node("button", { disabled: true }, [], "下一步");
    next.parentElement = f.environment.document.body;
    next.ownerDocument = f.environment.document;
    f.environment.document.body.children.push(next);
    assert.deepStrictEqual(await advanceCheckbox(f.page, { email: EMAIL }), { advanced: false, attempted: false, reason: "next_disabled" });
    next.disabled = false;
    assert.deepStrictEqual(await advanceCheckbox(f.page, { email: EMAIL }), { advanced: true, attempted: true, reason: "next_clicked" });
    assert.strictEqual(next.clicks, 1);
  });

  await checkAsync("checkbox preflight: Next refuses an unchecked box, changed account, and password/TOTP buttons", async () => {
    const next = node("button", {}, [], "Next");
    const unchecked = checkboxFixture({ top: { after: [next] } });
    assert.strictEqual((await advanceCheckbox(unchecked.page, { email: EMAIL })).advanced, false);
    for (const id of ["passwordNext", "totpNext"]) {
      const wrong = node("button", { id }, [], "Next");
      const f = checkboxFixture({ checked: "true", top: { after: [wrong] } });
      assert.strictEqual((await advanceCheckbox(f.page, { email: EMAIL })).advanced, false);
      assert.strictEqual(wrong.clicks, 0);
    }
    const moving = checkboxFixture({ checked: "true", top: { after: [next] } });
    const evaluate = moving.page.evaluate;
    moving.page.evaluate = (fn, args) => {
      if (args.mode === "checkboxAdvance") moving.environment.document.location.href = PAGE.replace("recaptcha?", "totp?");
      return evaluate(fn, args);
    };
    assert.strictEqual((await advanceCheckbox(moving.page, { email: EMAIL })).advanced, false);
    assert.strictEqual(next.clicks, 0);
  });

  await checkAsync("checkbox preflight: its fingerprint matches solver inspection and never includes account or iframe parameters", async () => {
    const f = checkboxFixture();
    const first = await inspectCheckbox(f.page, { email: EMAIL });
    const paid = await inspectRecaptcha(f.page, { email: EMAIL });
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    assert.strictEqual(first.fingerprint, paid.checkboxFingerprint);
    assert.ok(!JSON.stringify(first).includes(EMAIL));
    assert.ok(!JSON.stringify(first).includes("fixture-sitekey"));
    assert.ok(!JSON.stringify(first).includes("not-for-provider"));
    f.frame.attrs.name = "a-replacement";
    assert.notStrictEqual((await inspectCheckbox(f.page, { email: EMAIL })).fingerprint, first.fingerprint);
  });

  await checkAsync("checkbox preflight: slow frame reads time out and cancellation prevents native input", async () => {
    const f = checkboxFixture();
    f.anchor.evaluate = () => new Promise(() => {});
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL, timeoutMs: 5 })).reason, "evaluation_timeout");
    const cancelled = checkboxFixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(clickCheckbox(cancelled.page, { email: EMAIL, signal: controller.signal }), { name: "AbortError" });
    assert.strictEqual(cancelled.checkbox.clicks, 0);
    const pending = checkboxFixture();
    const abort = new AbortController();
    pending.anchor.$ = async () => { abort.abort(); return pending.handle; };
    await assert.rejects(clickCheckbox(pending.page, { email: EMAIL, signal: abort.signal }), { name: "AbortError" });
    assert.strictEqual(pending.checkbox.clicks, 0);
  });

  await checkAsync("checkbox preflight: natural callback navigation during a frame read returns parent absence", async () => {
    for (const detach of [false, true]) {
      const f = checkboxFixture();
      const evaluate = f.anchor.evaluate;
      f.anchor.evaluate = async (fn, args) => {
        const state = await evaluate(fn, args);
        f.environment.document.location.href = "https://myaccount.google.com/";
        if (detach) throw new Error("Execution context was destroyed");
        return state;
      };
      assert.deepStrictEqual(await inspectCheckbox(f.page, { email: EMAIL }), { state: "absent", present: false, reason: "unsupported_page" });
      assert.strictEqual(f.checkbox.clicks, 0);
    }
  });

  await checkAsync("checkbox preflight: an eligible iframe not attached yet remains checking for bounded outer polling", async () => {
    const f = checkboxFixture();
    f.frames.splice(f.frames.indexOf(f.anchor), 1);
    const loading = await inspectCheckbox(f.page, { email: EMAIL });
    assert.strictEqual(loading.state, "checking");
    assert.strictEqual(loading.present, true);
    assert.strictEqual(loading.reason, "frame_loading");
    assert.strictEqual((await clickCheckbox(f.page, { email: EMAIL })).clicked, false);
    f.frames.push(f.anchor);
    assert.strictEqual((await inspectCheckbox(f.page, { email: EMAIL })).state, "unchecked");
  });
};

module.exports.fixtures = { node, widget, fixture, EMAIL, PAGE, ANCHOR };

if (require.main === module) {
  let passed = 0;
  const check = (name, run) => { run(); passed += 1; console.log(`ok ${name}`); };
  const checkAsync = async (name, run) => { await run(); passed += 1; console.log(`ok ${name}`); };
  module.exports({ check, checkAsync }).then(() => console.log(`${passed} recaptcha fixture groups passed`))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
