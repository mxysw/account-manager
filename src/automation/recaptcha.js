"use strict";

const { createHash } = require("crypto");
const { observerIdFor } = require("./recaptcha-observer");

// Bind the exact observation in memory. Do not persist or log challenge data,
// solver responses, iframe URLs, or this private binding.
const observations = new WeakMap();
const checkboxAttempts = new WeakMap();
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Self-contained, serializable DOM adapter. The optional environment is for
 * deterministic fixtures only. It never enters frames or reads browser storage,
 * cookies, password inputs, or Google's private ___grecaptcha_cfg internals.
 */
function inspectRecaptchaDOM(options = {}, environment) {
  const doc = environment ? environment.document : document;
  const win = environment ? environment.window : window;
  const metadata = { callbackSource: "none", hasDataS: false };
  const fail = (reason, present = false) => ({ supported: false, present, reason, ...metadata });
  const submitFail = (reason) => ({ submitted: false, reason, ...metadata });
  const advanceFail = (reason) => ({ advanced: false, reason, ...metadata });
  const isSubmit = options.mode === "submit";
  const isCheckbox = options.mode === "checkbox" || options.mode === "checkboxAdvance";
  const isAdvance = options.mode === "advance" || options.mode === "checkboxAdvance";
  const reject = (reason, present = false) => isSubmit ? submitFail(reason) : isAdvance ? advanceFail(reason) : fail(reason, present);
  if (options.expiresAt && Date.now() >= options.expiresAt) return reject("evaluation_timeout");
  let location;
  try { location = new URL(doc.location.href); } catch (_) { return reject("unsupported_page"); }
  if (location.origin !== "https://accounts.google.com"
      || !/^\/(?:v[23]\/signin|signin(?:\/v[23])?)\/challenge(?:\/|$)/.test(location.pathname)) {
    return reject("unsupported_page");
  }

  const email = typeof options.email === "string" ? options.email.trim() : "";
  const attr = (element, name) => element.getAttribute(name) || "";
  const all = (element, selector) => Array.from(element.querySelectorAll(selector));
  const visible = (element) => {
    if (!element || !element.getBoundingClientRect) return false;
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || attr(current, "aria-hidden") === "true") return false;
      const style = win.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
          || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const parseAnchor = (frame) => {
    let url;
    try { url = new URL(attr(frame, "src"), location.origin); } catch (_) { return null; }
    if (url.protocol !== "https:" || (url.port && url.port !== "443")
        || !["www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/recaptcha\/(api2|enterprise)\/anchor$/);
    return match ? { frame, url, enterprise: match[1] === "enterprise" } : null;
  };
  const frames = all(doc, "iframe");
  const anchors = frames.map(parseAnchor).filter(Boolean);
  const visibleAnchors = anchors.filter((item) => visible(item.frame));
  const configuredRoots = all(doc, "[data-sitekey]");
  const renderedRoots = configuredRoots.filter((element) => visible(element)
    && (all(element, "iframe").some((frame) => parseAnchor(frame) && visible(frame))
      || all(element, "[role='checkbox']").some(visible)));
  const visibleUnknownFrames = frames.filter((frame) => {
    if (!visible(frame) || parseAnchor(frame)) return false;
    try {
      const url = new URL(attr(frame, "src"), location.origin);
      return /^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)$/.test(url.pathname) || /recaptcha/i.test(attr(frame, "title"));
    } catch (_) { return /recaptcha/i.test(attr(frame, "title")); }
  });
  // Presence is independent of account eligibility: a visible challenge must
  // remain actionable even if its account marker has not rendered yet.
  // Conversely, old hidden widgets and bare configuration are not challenges.
  const present = visibleAnchors.length > 0 || renderedRoots.length > 0 || visibleUnknownFrames.length > 0;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reject("account_missing", present);
  const emailMatches = (text) => String(text || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  // Read only visible identity controls. Hidden identifier/password fields can
  // belong to a previous account after a SPA transition and are never evidence.
  let identities = all(doc, "#profileIdentifier, [data-email], [data-identifier], #identifierId, input[type='email']")
    .filter(visible).flatMap((element) => {
      const text = element.tagName === "INPUT" ? element.value : element.innerText;
      return emailMatches(text);
    });
  if (!identities.length) {
    identities = all(doc, "span, div, p").filter((element) => visible(element) && !element.children.length)
      .flatMap((element) => emailMatches(element.innerText));
  }
  // Google may render a different letter case than the imported address.
  // Normalize case only; do not equate dot/plus aliases or different domains.
  identities = [...new Set(identities.map((identity) => identity.toLowerCase()))];
  // The read-only checkbox probe also runs on password/TOTP pages before
  // their identity marker has hydrated. No visible widget or identity is not
  // a CAPTCHA. A clearly different visible identity must still fail closed,
  // and submit/advance retain their full identity and observation checks.
  if (options.mode === "checkbox" && !present && !identities.length) {
    return reject(anchors.length || configuredRoots.length ? "challenge_not_visible" : "challenge_missing", false);
  }
  if (!identities.length) return reject("account_not_visible", present);
  if (identities.length !== 1 || identities[0] !== email.toLowerCase()) return reject("account_mismatch", present);

  const visibleText = String(doc.body && doc.body.innerText || "");
  if (/this browser or app may not be secure|browser.{0,25}(?:not secure|isn't secure)|浏览器或应用可能不安全|浏览器.{0,12}不安全/i.test(visibleText)) {
    return reject("browser_blocked", present);
  }
  if (!visibleAnchors.length) {
    // A data-sitekey alone is configuration, not proof of a rendered challenge.
    const configured = anchors.length > 0 || configuredRoots.length > 0;
    return reject(present ? "widget_unsupported" : configured ? "challenge_not_visible" : "challenge_missing", present);
  }
  if (visibleAnchors.length !== 1 || renderedRoots.length > 1) return reject("multiple_widgets", true);
  const anchor = visibleAnchors[0];
  const root = anchor.frame.closest("[data-sitekey]");
  if (root && !visible(root)) return reject("challenge_not_visible", true);
  if (renderedRoots.some((element) => element !== root && !element.contains(anchor.frame))) return reject("multiple_widgets", true);
  const iframeKey = anchor.url.searchParams.get("k") || "";
  const rootKey = root ? attr(root, "data-sitekey") : "";
  if (iframeKey && rootKey && iframeKey !== rootKey) return reject("widget_data_mismatch", true);
  const websiteKey = iframeKey || rootKey;
  if (!websiteKey || websiteKey.length > 1024 || /\s/.test(websiteKey)) return reject("sitekey_missing", true);

  // v3 often shares the anchor URL; its automatic render script is explicit
  // contrary evidence. Invisible anchors without a rendered v2 declaration are
  // deliberately unsupported rather than guessing the task type.
  const renderModes = all(doc, "script[src]").map((script) => {
    try {
      const url = new URL(attr(script, "src"), location.origin);
      if (url.protocol === "https:" && ["www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net"].includes(url.hostname)
          && /^\/recaptcha\/(?:api|enterprise)\.js$/.test(url.pathname)) return url.searchParams.get("render") || "";
    } catch (_) { /* Ignore unrelated script URLs. */ }
    return "";
  });
  if (renderModes.some((mode) => mode && mode !== "explicit")) return reject("unsupported_v3", true);
  const size = anchor.url.searchParams.get("size") || (root ? attr(root, "data-size") : "");
  if (size === "invisible" && !(root && attr(root, "data-size") === "invisible" && renderModes.includes("explicit"))) {
    return reject("unsupported_invisible", true);
  }
  const iframeS = anchor.url.searchParams.get("s") || "";
  const rootS = root ? attr(root, "data-s") : "";
  if (iframeS && rootS && iframeS !== rootS) return reject("widget_data_mismatch", true);
  const dataS = iframeS || rootS;
  metadata.hasDataS = !!dataS;
  const pageAction = anchor.url.searchParams.get("sa") || "";
  const challenge = {
    type: "recaptcha-v2", websiteURL: `${location.origin}${location.pathname}`,
    websiteKey, enterprise: anchor.enterprise,
  };
  if (dataS) challenge.dataS = dataS;
  if (pageAction) challenge.pageAction = pageAction;
  if (size) challenge.isInvisible = size === "invisible";
  const describeFrame = (frame, url) => ({ url: url.href, name: attr(frame, "name"), path: elementPath(frame) });
  const anchorDescriptor = describeFrame(anchor.frame, anchor.url);
  const checkboxBinding = JSON.stringify({ email, challenge, anchor: anchorDescriptor });

  if (isCheckbox) {
    // Native checkbox interaction needs no response textarea or JavaScript
    // callback. Only public iframe identity is returned to the Node adapter.
    const panels = [];
    for (const frame of frames.filter(visible)) {
      if (frame === anchor.frame) continue;
      let url;
      try { url = new URL(attr(frame, "src"), location.origin); } catch (_) { continue; }
      if (!/^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)$/.test(url.pathname)) continue;
      if (url.protocol !== "https:" || (url.port && url.port !== "443")
          || !["www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net"].includes(url.hostname)
          || url.pathname !== `/recaptcha/${anchor.enterprise ? "enterprise" : "api2"}/bframe`
          || url.searchParams.get("k") !== websiteKey || !anchorDescriptor.name.startsWith("a-")
          || attr(frame, "name") !== `c-${anchorDescriptor.name.slice(2)}`) return reject("frame_ambiguous", true);
      panels.push(describeFrame(frame, url));
    }
    if (panels.length > 1) return reject("frame_ambiguous", true);
    const binding = checkboxBinding;
    if (options.mode === "checkboxAdvance") {
      if (binding !== options.expectedBinding || panels.length || !options.passedUntil || Date.now() >= options.passedUntil) {
        return advanceFail("challenge_changed");
      }
      return clickCaptchaNext(true);
    }
    return { supported: true, present: true, reason: "checkbox_ready", binding, anchor: anchorDescriptor, panel: panels[0] || null };
  }

  const responseSelector = "textarea[name='g-recaptcha-response'], textarea[id='g-recaptcha-response']";
  let scope = root || anchor.frame.parentElement;
  let responses = [];
  // A response must share a narrow widget container. Never select the first
  // response in the document: a hidden orphan can precede the current widget.
  for (let level = 0; scope && scope !== doc.body && level < 6; level += 1, scope = scope.parentElement) {
    responses = all(scope, responseSelector);
    if (responses.length) break;
    if (root) break;
  }
  if (!scope || scope === doc.body || !responses.length) return reject("response_missing", true);
  if (responses.length !== 1 || anchors.filter((item) => scope.contains(item.frame)).length !== 1) {
    return reject("response_ambiguous", true);
  }
  const response = responses[0];
  if (response.disabled) return reject("response_unavailable", true);
  // A callback must be either explicitly declared on this widget or captured
  // prospectively from its public render call. Private registries stay unread.
  const callbackName = root ? attr(root, "data-callback").trim() : "";
  let callback = null;
  let callbackOwner = win;
  let observedRecordId = "";
  let observerBridge = null;
  const resolveExplicitCallback = () => {
    let target = win;
    let owner = win;
    for (const part of callbackName.split(".")) {
      if (!target || (typeof target !== "object" && typeof target !== "function")) return null;
      const descriptor = Object.getOwnPropertyDescriptor(target, part);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return null;
      owner = target;
      target = descriptor.value;
    }
    return typeof target === "function" ? { fn: target, owner } : null;
  };
  if (options.observerId) {
    // The Node-side registration ID prevents calling a coincidentally named
    // page property. The observer exposes no callback or configuration objects.
    const bridgeDescriptor = Object.getOwnPropertyDescriptor(win, "__accountManagerRecaptchaObserverV1");
    const bridge = bridgeDescriptor && bridgeDescriptor.value;
    const bridgeValue = (key) => {
      const descriptor = bridge && Object.getOwnPropertyDescriptor(bridge, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
    };
    if (bridgeValue("version") === 1 && bridgeValue("observerId") === options.observerId
        && typeof bridgeValue("lookup") === "function" && typeof bridgeValue("invoke") === "function") {
      const observed = bridgeValue("lookup").call(bridge, { frame: anchor.frame, response, websiteKey, enterprise: anchor.enterprise });
      if (observed && observed.callbackSource === "observed" && typeof observed.recordId === "string"
          && /^[A-Za-z0-9-]{1,160}$/.test(observed.recordId)) {
        metadata.callbackSource = "observed";
        observedRecordId = observed.recordId;
        observerBridge = bridge;
      }
    }
  }
  // Actual parameters passed to render take precedence over an old HTML
  // data-callback declaration on a reused container.
  if (!observerBridge && callbackName) {
    const parts = callbackName.split(".");
    if (parts.length > 5 || parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part)
        || ["__proto__", "prototype", "constructor"].includes(part))) return reject("callback_unsupported", true);
    const explicit = resolveExplicitCallback();
    if (!explicit) return reject("callback_unavailable", true);
    callback = explicit.fn;
    callbackOwner = explicit.owner;
    metadata.callbackSource = "explicit";
  }
  function elementPath(element) {
    const path = [];
    for (let current = element; current && current !== doc.documentElement; current = current.parentElement) {
      const siblings = current.parentElement ? Array.from(current.parentElement.children) : [];
      path.unshift(`${current.tagName}:${siblings.indexOf(current)}:${attr(current, "id")}`);
    }
    return path.join("/");
  }
  const binding = JSON.stringify({
    email, challenge, anchorURL: anchor.url.href, anchorName: attr(anchor.frame, "name"),
    anchorPath: elementPath(anchor.frame), responsePath: elementPath(response), callbackName,
    callbackSource: metadata.callbackSource, observedRecordId,
  });
  if (!isSubmit && !isAdvance) return { supported: true, present: true, reason: "supported", challenge, binding, checkboxBinding, ...metadata };
  if (binding !== options.expectedBinding) return reject("challenge_changed");
  if (isAdvance) return clickCaptchaNext();
  function clickCaptchaNext(reportAttempt = false) {
    // Verification and the click occur in the same synchronous evaluation, so
    // an asynchronous callback cannot navigate to password/TOTP between them.
    const nextText = /^(?:Next|Continue|Verify|下一步|继续|验证|Siguiente|Continuar|Suivant|Weiter|次へ|다음)$/i;
    const nextFailure = (reason, attempted = true) => ({ ...advanceFail(reason), ...(reportAttempt ? { attempted } : {}) });
    let candidates = all(doc, "button, [role='button'], input[type='submit'], input[type='button']").filter((element) => {
      if (!visible(element) || element.closest("#identifierNext, #passwordNext, #totpNext")) return false;
      const text = String(element.tagName === "INPUT" ? element.value : element.innerText || attr(element, "aria-label")).replace(/\s+/g, " ").trim();
      return nextText.test(text);
    });
    candidates = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
    if (!candidates.length) return nextFailure("next_missing", false);
    if (candidates.length !== 1) return nextFailure("next_ambiguous");
    if (candidates[0].disabled || attr(candidates[0], "aria-disabled") === "true" || candidates[0].closest("fieldset[disabled]")) {
      return nextFailure("next_disabled", false);
    }
    if (options.expiresAt && Date.now() >= options.expiresAt) return nextFailure("evaluation_timeout");
    try {
      candidates[0].click();
      return { advanced: true, reason: "next_clicked", ...metadata, ...(reportAttempt ? { attempted: true } : {}) };
    } catch (_) { return nextFailure("next_failed"); }
  }
  if (typeof options.token !== "string" || !options.token.trim() || options.token.length > 32768) return submitFail("invalid_token");
  if (options.expiresAt && Date.now() >= options.expiresAt) return submitFail("evaluation_timeout");
  try {
    const prototype = win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(response, options.token);
    else response.value = options.token;
    response.dispatchEvent(new win.Event("input", { bubbles: true }));
    response.dispatchEvent(new win.Event("change", { bubbles: true }));
    if (callback || observerBridge) {
      // DOM event handlers run synchronously and can switch the account or
      // replace the widget. Recheck before making the separate callback call.
      const current = inspectRecaptchaDOM({ email, observerId: options.observerId, expiresAt: options.expiresAt }, environment);
      if (!current.supported || current.binding !== binding) return submitFail("challenge_changed");
      if (callback) {
        const explicit = resolveExplicitCallback();
        if (!explicit || explicit.fn !== callback || explicit.owner !== callbackOwner) return submitFail("challenge_changed");
      }
    }
    if (callback) {
      const result = callback.call(callbackOwner, options.token);
      // A declared async callback may continue independently. Suppress rejected
      // promises without returning their possibly sensitive exception content.
      if (result && typeof result.catch === "function") result.catch(() => {});
    } else if (observerBridge) {
      const observed = observerBridge.invoke(observedRecordId,
        { frame: anchor.frame, response, websiteKey, enterprise: anchor.enterprise }, options.token);
      if (!observed || !observed.invoked) return submitFail("observed_callback_stale");
    }
    const invoked = !!callback || !!observerBridge;
    return { submitted: true, reason: invoked ? "callback_invoked" : "response_populated", callbackInvoked: invoked, ...metadata };
  } catch (_) {
    return submitFail("submission_failed");
  }
}

function boundedEvaluate(page, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("evaluation_timeout")), timeoutMs);
    Promise.resolve().then(() => page.evaluate(inspectRecaptchaDOM, { ...options, expiresAt: Date.now() + timeoutMs })).then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); reject(new Error("evaluation_failed")); },
    );
  });
}

function timeoutFor(options) {
  return Math.min(10000, Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
}

async function inspectRecaptcha(page, options = {}) {
  try {
    const result = await boundedEvaluate(page, { email: options.email, observerId: observerIdFor(page) }, timeoutFor(options));
    if (!result || !result.supported || typeof result.binding !== "string") {
      return { supported: false, present: !!(result && result.present), reason: result && result.reason || "evaluation_failed",
        callbackSource: ["explicit", "observed"].includes(result && result.callbackSource) ? result.callbackSource : "none",
        hasDataS: !!(result && result.hasDataS) };
    }
    const { binding, checkboxBinding, ...snapshot } = result;
    snapshot.fingerprint = createHash("sha256").update(binding).digest("hex");
    if (checkboxBinding) snapshot.checkboxFingerprint = createHash("sha256").update(checkboxBinding).digest("hex");
    observations.set(snapshot, {
      binding, page, email: options.email, fingerprint: snapshot.fingerprint,
      challenge: JSON.stringify(snapshot.challenge), submitAttempted: false, submitted: false, advanceAttempted: false,
    });
    return snapshot;
  } catch (error) {
    return { supported: false, present: false, reason: error.message === "evaluation_timeout" ? "evaluation_timeout" : "evaluation_failed",
      callbackSource: "none", hasDataS: false };
  }
}

function boundObservation(page, snapshot, options) {
  const observed = snapshot && observations.get(snapshot);
  if (!observed || observed.page !== page || observed.fingerprint !== snapshot.fingerprint || options.email !== observed.email) return null;
  try { return JSON.stringify(snapshot.challenge) === observed.challenge ? observed : null; }
  catch (_) { return null; }
}

async function submitRecaptcha(page, snapshot, token, options = {}) {
  const observed = boundObservation(page, snapshot, options);
  if (!observed || observed.submitAttempted) return { submitted: false, reason: "snapshot_invalid" };
  if (typeof token !== "string" || !token.trim() || token.length > 32768) return { submitted: false, reason: "invalid_token" };
  // Each observation may be submitted once, including failed or timed-out
  // attempts. Retain its private binding only for one atomic Next operation.
  observed.submitAttempted = true;
  try {
    const result = await boundedEvaluate(page, { mode: "submit", email: options.email, observerId: observerIdFor(page), expectedBinding: observed.binding, token }, timeoutFor(options));
    observed.submitted = !!(result && result.submitted);
    return result;
  } catch (error) {
    return { submitted: false, reason: error.message === "evaluation_timeout" ? "evaluation_timeout" : "evaluation_failed" };
  }
}

async function advanceRecaptcha(page, snapshot, options = {}) {
  const observed = boundObservation(page, snapshot, options);
  if (!observed) return { advanced: false, reason: "snapshot_invalid" };
  if (!observed.submitted) return { advanced: false, reason: "submission_required" };
  if (observed.advanceAttempted) return { advanced: false, reason: "advance_already_attempted" };
  observed.advanceAttempted = true;
  try {
    return await boundedEvaluate(page, { mode: "advance", email: options.email, observerId: observerIdFor(page), expectedBinding: observed.binding }, timeoutFor(options));
  } catch (error) {
    return { advanced: false, reason: error.message === "evaluation_timeout" ? "evaluation_timeout" : "evaluation_failed" };
  }
}

// Public DOM only, evaluated inside one already identified reCAPTCHA frame.
// It never looks at response-token fields, private objects, images, or audio.
function inspectCheckboxFrameDOM(options = {}, environment) {
  const doc = environment ? environment.document : document;
  const win = environment ? environment.window : window;
  const result = (state, reason) => ({ state, reason });
  if (options.expiresAt && Date.now() >= options.expiresAt) return result("error", "evaluation_timeout");
  let url;
  try { url = new URL(doc.location.href); } catch (_) { return result("unsupported", "frame_unsupported"); }
  if (url.href !== options.expectedURL || url.protocol !== "https:" || (url.port && url.port !== "443")
      || !["www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net"].includes(url.hostname)
      || !/^\/recaptcha\/(api2|enterprise)\/(anchor|bframe)$/.test(url.pathname)) return result("unsupported", "frame_changed");
  const attr = (element, name) => element.getAttribute(name) || "";
  const visible = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || attr(current, "aria-hidden") === "true") return false;
      const style = win.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const find = (selector) => Array.from(doc.querySelectorAll(selector)).filter(visible);
  const errors = find("#recaptcha-error-message, .rc-anchor-error-msg-container, .rc-anchor-error-msg, .rc-doscaptcha-header, [role='alert']")
    .filter((element) => String(element.innerText || "").trim());
  if (errors.some((element) => /expired|timed? out|过期|超时/i.test(element.innerText))) return result("error", "checkbox_expired");
  if (errors.length) return result("error", "checkbox_error");
  if (options.kind === "bframe") {
    if (!url.pathname.endsWith("/bframe")) return result("unsupported", "frame_changed");
    return find("#rc-imageselect, .rc-imageselect-challenge, .rc-audiochallenge-controls, #audio-source").length
      ? result("challenge", "additional_challenge") : result("checking", "challenge_loading");
  }
  if (!url.pathname.endsWith("/anchor")) return result("unsupported", "frame_changed");
  const boxes = find("#recaptcha-anchor[role='checkbox']");
  if (boxes.length > 1) return result("unsupported", "checkbox_ambiguous");
  if (!boxes.length) return result("checking", "checkbox_loading");
  const checkbox = boxes[0];
  if (attr(checkbox, "aria-invalid") === "true") return result("error", "checkbox_error");
  if (attr(checkbox, "aria-checked") === "true") return result("passed", "checkbox_passed");
  if (attr(checkbox, "aria-busy") === "true" || checkbox.disabled || attr(checkbox, "aria-disabled") === "true"
      || /(?:^|\s)recaptcha-checkbox-loading(?:\s|$)/.test(attr(checkbox, "class"))
      || find(".recaptcha-checkbox-spinner").length) return result("checking", "checkbox_checking");
  if (attr(checkbox, "aria-checked") !== "false") return result("unsupported", "checkbox_state_unknown");
  return result("unchecked", "checkbox_unchecked");
}

function checkboxAbort(signal) {
  if (signal && signal.aborted) {
    const error = new Error("任务已取消");
    error.name = "AbortError";
    throw error;
  }
}

function checkboxFailure(reason) { return Object.assign(new Error(reason), { code: reason }); }

function checkboxBounded(operation, context) {
  checkboxAbort(context.signal);
  const remaining = context.expiresAt - Date.now();
  if (remaining <= 0) return Promise.reject(checkboxFailure("evaluation_timeout"));
  return new Promise((resolve, reject) => {
    const finish = (handler, value) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      handler(value);
    };
    const abort = () => {
      const error = new Error("任务已取消");
      error.name = "AbortError";
      finish(reject, error);
    };
    const timer = setTimeout(() => finish(reject, checkboxFailure("evaluation_timeout")), remaining);
    context.signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { checkboxAbort(context.signal); return operation(); }).then(
      (value) => { try { checkboxAbort(context.signal); finish(resolve, value); } catch (error) { finish(reject, error); } },
      (error) => finish(reject, error),
    );
  });
}

async function checkboxTop(page, options, context, extra = {}) {
  return checkboxBounded(() => page.evaluate(inspectRecaptchaDOM,
    { email: options.email, mode: "checkbox", expiresAt: context.expiresAt, ...extra }), context);
}

function checkboxStateForTop(page, top) {
  if (top && top.supported) return null;
  const reason = top && top.reason || "evaluation_failed";
  if (["challenge_missing", "challenge_not_visible"].includes(reason) && !top.present) return { state: "absent", present: false, reason };
  if (reason === "unsupported_page") {
    try {
      const url = new URL(page.url());
      if (["https://accounts.google.com", "https://myaccount.google.com"].includes(url.origin)) return { state: "absent", present: false, reason };
    } catch (_) { /* An unreadable URL cannot confirm absence. */ }
  }
  return { state: "unsupported", present: !!(top && top.present), reason };
}

async function checkboxFrame(page, descriptor, context) {
  if (typeof page.frames !== "function") throw checkboxFailure("frame_unavailable");
  const frames = await checkboxBounded(() => page.frames(), context);
  if (!Array.isArray(frames) || frames.length > 64) throw checkboxFailure("frame_ambiguous");
  const main = typeof page.mainFrame === "function" ? page.mainFrame() : null;
  if (!main) throw checkboxFailure("frame_unavailable");
  const candidates = frames.filter((frame) => {
    try {
      return frame !== main && frame.parentFrame() === main && frame.url() === descriptor.url
        && frame.name() === descriptor.name;
    } catch (_) { return false; }
  });
  if (candidates.length !== 1) throw checkboxFailure(candidates.length ? "frame_ambiguous" : "frame_unavailable");
  return candidates[0];
}

async function observeCheckbox(page, options, context) {
  const top = await checkboxTop(page, options, context);
  const unavailable = checkboxStateForTop(page, top);
  if (unavailable) return { public: unavailable, top };
  let frame;
  let state;
  try {
    frame = await checkboxFrame(page, top.anchor, context);
    state = await checkboxBounded(() => frame.evaluate(inspectCheckboxFrameDOM,
      { expectedURL: top.anchor.url, kind: "anchor", expiresAt: context.expiresAt }), context);
    if (top.panel) {
      const panel = await checkboxFrame(page, top.panel, context);
      state = await checkboxBounded(() => panel.evaluate(inspectCheckboxFrameDOM,
        { expectedURL: top.panel.url, kind: "bframe", expiresAt: context.expiresAt }), context);
    }
  } catch (error) {
    if (error.name === "AbortError" || error.code === "evaluation_timeout") throw error;
    const latest = await checkboxTop(page, options, context);
    const destination = checkboxStateForTop(page, latest);
    // A natural callback can destroy its frame during navigation. Only the
    // parent orchestrator decides whether this absent destination is accepted.
    if (destination && destination.state === "absent") return { public: destination, top: latest };
    if (error.code === "frame_unavailable" && latest.supported && latest.binding === top.binding
        && JSON.stringify(latest.panel) === JSON.stringify(top.panel)) {
      return { public: { state: "checking", present: true, reason: "frame_loading",
        fingerprint: createHash("sha256").update(top.binding).digest("hex") }, top };
    }
    throw error;
  }
  // Recheck the parent after crossing process/frame boundaries. An old frame
  // reading must never be combined with a new account or page observation.
  const latest = await checkboxTop(page, options, context);
  const destination = checkboxStateForTop(page, latest);
  if (destination && destination.state === "absent") return { public: destination, top: latest };
  if (!latest.supported || latest.binding !== top.binding || JSON.stringify(latest.panel) !== JSON.stringify(top.panel)) {
    return { public: { state: "unsupported", present: !!latest.present, reason: "challenge_changed" }, top: latest };
  }
  const allowed = ["unchecked", "checking", "passed", "challenge", "error", "unsupported"];
  if (!state || !allowed.includes(state.state)) throw checkboxFailure("evaluation_failed");
  return { public: { state: state.state, present: true, reason: state.reason,
    fingerprint: createHash("sha256").update(top.binding).digest("hex") }, top, frame };
}

function checkboxErrorResult(error, kind) {
  if (error && error.name === "AbortError") throw error;
  const reason = ["evaluation_timeout", "frame_unavailable", "frame_ambiguous"].includes(error && error.code) ? error.code : "evaluation_failed";
  return kind === "inspect" ? { state: "error", present: false, reason } : { [kind]: false, reason };
}

function checkboxAttempt(page, binding, operation, release = false) {
  let attempts = checkboxAttempts.get(page);
  if (!attempts) { attempts = new Set(); checkboxAttempts.set(page, attempts); }
  const key = `${operation}:${createHash("sha256").update(binding).digest("hex")}`;
  if (release) { attempts.delete(key); return true; }
  if (attempts.has(key) || attempts.size >= 128) return false;
  attempts.add(key);
  return true;
}

async function inspectCheckbox(page, options = {}) {
  const context = { signal: options.signal, expiresAt: Date.now() + timeoutFor(options) };
  try { return (await observeCheckbox(page, options, context)).public; }
  catch (error) { return checkboxErrorResult(error, "inspect"); }
}

async function clickCheckbox(page, options = {}) {
  const context = { signal: options.signal, expiresAt: Date.now() + timeoutFor(options) };
  let handle = null;
  try {
    const before = await observeCheckbox(page, options, context);
    if (before.public.state !== "unchecked") return { clicked: false, reason: before.public.reason };
    handle = await checkboxBounded(() => before.frame.$("#recaptcha-anchor"), context);
    if (!handle || typeof handle.click !== "function") return { clicked: false, reason: "checkbox_unavailable" };
    const current = await observeCheckbox(page, options, context);
    if (current.public.state !== "unchecked" || current.frame !== before.frame || current.top.binding !== before.top.binding) {
      return { clicked: false, reason: "challenge_changed" };
    }
    const targetMatches = await checkboxBounded(() => handle.evaluate((element) => {
      const doc = element.ownerDocument;
      return element.isConnected && doc.querySelectorAll("#recaptcha-anchor[role='checkbox']").length === 1
        && doc.querySelectorAll("#recaptcha-anchor[role='checkbox']")[0] === element
        && element.getAttribute("aria-checked") === "false" && element.getAttribute("aria-busy") !== "true"
        && element.getAttribute("aria-disabled") !== "true";
    }), context);
    const latest = await checkboxTop(page, options, context);
    if (!targetMatches || !latest.supported || latest.binding !== before.top.binding || latest.panel) return { clicked: false, reason: "challenge_changed" };
    checkboxAbort(context.signal);
    if (!checkboxAttempt(page, before.top.binding, "click")) return { clicked: false, reason: "checkbox_already_attempted" };
    // A bound native ElementHandle click supplies ordinary browser input. It
    // can only target this checkbox; image grids and phone controls are unused.
    await checkboxBounded(() => handle.click(), context);
    return { clicked: true, reason: "checkbox_clicked" };
  } catch (error) { return checkboxErrorResult(error, "clicked"); }
  finally { if (handle) void Promise.resolve().then(() => handle.dispose()).catch(() => {}); }
}

async function advanceCheckbox(page, options = {}) {
  const context = { signal: options.signal, expiresAt: Date.now() + timeoutFor(options) };
  try {
    const observed = await observeCheckbox(page, options, context);
    if (observed.public.state !== "passed") return { advanced: false, attempted: false, reason: observed.public.reason };
    const confirmed = await checkboxBounded(() => observed.frame.evaluate(inspectCheckboxFrameDOM,
      { expectedURL: observed.top.anchor.url, kind: "anchor", expiresAt: context.expiresAt }), context);
    if (confirmed.state !== "passed") return { advanced: false, attempted: true, reason: "checkbox_not_passed" };
    checkboxAbort(context.signal);
    if (!checkboxAttempt(page, observed.top.binding, "advance")) return { advanced: false, attempted: true, reason: "advance_already_attempted" };
    const result = await checkboxTop(page, options, context, {
      mode: "checkboxAdvance", expectedBinding: observed.top.binding, passedUntil: Date.now() + 500,
    });
    if (!result.advanced && result.attempted === false && ["next_missing", "next_disabled"].includes(result.reason)) {
      checkboxAttempt(page, observed.top.binding, "advance", true);
    }
    return { advanced: !!result.advanced, attempted: result.attempted !== false, reason: result.reason };
  } catch (error) { return checkboxErrorResult(error, "advanced"); }
}

module.exports = {
  inspectRecaptcha, submitRecaptcha, advanceRecaptcha, inspectCheckbox, clickCheckbox, advanceCheckbox,
  helpers: { inspectRecaptchaDOM, inspectCheckboxFrameDOM },
};
