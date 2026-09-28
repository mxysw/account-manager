"use strict";

const { randomUUID } = require("crypto");

const BRIDGE_KEY = "__accountManagerRecaptchaObserverV1";
const pageObservers = new WeakMap();

/**
 * Document-start observer for public render calls only. Callbacks and container
 * references stay in this closure; the bridge exposes only opaque record IDs.
 * This intentionally cannot recover callbacks from already rendered widgets.
 */
function installRecaptchaObserverDOM(configuration = {}, environment) {
  const win = environment ? environment.window : window;
  const doc = environment ? environment.document : document;
  const bridgeKey = "__accountManagerRecaptchaObserverV1";
  const observerId = configuration.observerId;
  if (typeof observerId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(observerId)) return false;
  try {
    if (new URL(doc.location.href).origin !== "https://accounts.google.com" || (win.top && win.top !== win)) return false;
  } catch (_) { return false; }
  if (Object.getOwnPropertyDescriptor(win, bridgeKey)) return false;

  const records = new Map();
  const containerRecords = new WeakMap();
  const namespaces = new WeakMap();
  let sequence = 0;
  let namespaceCount = 0;
  let rootCell = null;
  // A new document gets a new epoch even when its page registration is reused.
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const ownValue = (object, key) => {
    if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
  };
  const isObject = (value) => !!value && (typeof value === "object" || typeof value === "function");
  const clearRecords = () => { records.clear(); };
  const attribute = (element, name) => element.getAttribute(name) || "";
  const all = (element, selector) => Array.from(element.querySelectorAll(selector));
  const resolveContainer = (container) => {
    const element = typeof container === "string" ? doc.getElementById(container) : container;
    return element && element.nodeType === 1 && element.ownerDocument === doc
      && element !== doc.body && element !== doc.documentElement ? element : null;
  };
  const resolveCallback = (value) => {
    if (typeof value === "function") return { fn: value, owner: undefined, name: "" };
    if (typeof value !== "string" || value.length > 256) return null;
    const parts = value.split(".");
    if (parts.length > 5 || parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part)
        || ["__proto__", "prototype", "constructor"].includes(part))) return null;
    let target = win;
    let owner = win;
    for (const part of parts) {
      owner = target;
      target = ownValue(target, part);
      if (target === undefined) return null;
    }
    return typeof target === "function" ? { fn: target, owner, name: value } : null;
  };
  const callbackCurrent = (record) => {
    if (ownValue(record.parameters, "sitekey") !== record.sitekey
        || ownValue(record.parameters, "callback") !== record.callbackParameter) return false;
    if (!record.callback.name) return true;
    const current = resolveCallback(record.callback.name);
    return current && current.fn === record.callback.fn && current.owner === record.callback.owner;
  };

  // Known writable data properties only. Accessors/nonconfigurable properties
  // are left untouched. defineProperty replacement bypasses this watcher; the
  // descriptor identity checks below then invalidate every affected record.
  const watchProperty = (owner, name, transform) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor && (!Object.prototype.hasOwnProperty.call(descriptor, "value")
          || !descriptor.configurable || !descriptor.writable)) return null;
      if (!descriptor && (name in owner || !Object.isExtensible(owner))) return null;
      let current;
      const apply = (value) => {
        try { return transform(value); } catch (_) { clearRecords(); return value; }
      };
      const get = function getObservedPublicProperty() { return current; };
      const set = function setObservedPublicProperty(value) {
        if (this !== owner) {
          Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
          return;
        }
        current = apply(value);
      };
      Object.defineProperty(owner, name, {
        get, set, configurable: true, enumerable: descriptor ? descriptor.enumerable : true,
      });
      current = apply(descriptor ? descriptor.value : undefined);
      return {
        value: () => current,
        intact: () => {
          const now = Object.getOwnPropertyDescriptor(owner, name);
          return !!now && now.get === get && now.set === set;
        },
      };
    } catch (_) { return null; }
  };

  const installNamespace = (api, enterprise, namespaceCurrent) => {
    if (!isObject(api)) return;
    const previous = namespaces.get(api);
    if (previous) return;
    // Bound both retained records and the number of objects we instrument.
    if (++namespaceCount > 16) return;
    const state = { renderCell: null, enterpriseCell: null };
    namespaces.set(api, state);
    state.renderCell = watchProperty(api, "render", (original) => {
      clearRecords();
      if (typeof original !== "function") return original;
      let wrapped;
      wrapped = new Proxy(original, {
        apply(target, thisArg, args) {
          let captured = null;
          let container = null;
          try {
            container = resolveContainer(args[0]);
            if (container) {
              const previousId = containerRecords.get(container);
              if (previousId) records.delete(previousId);
            }
            const parameters = args[1];
            const sitekey = ownValue(parameters, "sitekey");
            const callbackParameter = ownValue(parameters, "callback");
            const callback = resolveCallback(callbackParameter);
            if (container && typeof sitekey === "string" && sitekey && sitekey.length <= 1024 && callback) {
              captured = { container, parameters, sitekey, callbackParameter, callback };
            }
          } catch (_) { /* Observation must never prevent the original call. */ }
          const widgetId = Reflect.apply(target, thisArg, args);
          try {
            if (captured && Number.isSafeInteger(widgetId) && widgetId >= 0 && records.size < 32) {
              const id = `${epoch}-${++sequence}`;
              records.set(id, {
                ...captured, id, widgetId, enterprise, used: false, frame: null, response: null,
                methodCurrent: () => namespaceCurrent() && state.renderCell && state.renderCell.intact()
                  && state.renderCell.value() === wrapped,
              });
              containerRecords.set(container, id);
            }
          } catch (_) { /* Keep the public render return value unchanged. */ }
          return widgetId;
        },
      });
      return wrapped;
    });
    if (!enterprise) {
      state.enterpriseCell = watchProperty(api, "enterprise", (value) => {
        clearRecords();
        installNamespace(value, true, () => namespaceCurrent() && state.enterpriseCell
          && state.enterpriseCell.intact() && state.enterpriseCell.value() === value);
        return value;
      });
    }
  };

  const visible = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || attribute(current, "aria-hidden") === "true") return false;
      const style = win.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const anchorInfo = (frame) => {
    if (!frame || frame.tagName !== "IFRAME") return null;
    try {
      const url = new URL(attribute(frame, "src"));
      const match = url.pathname.match(/^\/recaptcha\/(api2|enterprise)\/anchor$/);
      if (url.protocol !== "https:" || (url.port && url.port !== "443") || !match
          || !["www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net"].includes(url.hostname)) return null;
      return { sitekey: url.searchParams.get("k") || "", enterprise: match[1] === "enterprise" };
    } catch (_) { return null; }
  };
  const matches = (record, target, bind) => {
    if (!target || !record || containerRecords.get(record.container) !== record.id
        || !record.methodCurrent() || !callbackCurrent(record)) return false;
    const location = new URL(doc.location.href);
    if (location.origin !== "https://accounts.google.com"
        || !/^\/(?:v[23]\/signin|signin(?:\/v[23])?)\/challenge(?:\/|$)/.test(location.pathname)) return false;
    const { frame, response } = target;
    if (!frame || !response || frame.ownerDocument !== doc || response.ownerDocument !== doc
        || response.tagName !== "TEXTAREA" || response.disabled
        || !doc.documentElement.contains(record.container) || !record.container.contains(frame)
        || !record.container.contains(response) || !visible(frame)) return false;
    const info = anchorInfo(frame);
    if (!info || target.websiteKey !== record.sitekey || info.sitekey !== record.sitekey
        || target.enterprise !== record.enterprise || info.enterprise !== record.enterprise) return false;
    const frames = all(record.container, "iframe").filter((item) => anchorInfo(item));
    const responses = all(record.container, "textarea[name='g-recaptcha-response'], textarea[id='g-recaptcha-response']");
    if (frames.length !== 1 || frames[0] !== frame || responses.length !== 1 || responses[0] !== response) return false;
    if (record.frame && (record.frame !== frame || record.response !== response)) return false;
    if (bind) { record.frame = frame; record.response = response; }
    return true;
  };
  const bridge = Object.freeze({
    version: 1,
    observerId,
    lookup(target) {
      try {
        const found = Array.from(records.values()).filter((record) => matches(record, target, false));
        if (found.length !== 1 || !matches(found[0], target, true)) return { callbackSource: "none" };
        return { callbackSource: "observed", recordId: found[0].id };
      } catch (_) { return { callbackSource: "none" }; }
    },
    invoke(recordId, target, token) {
      try {
        const record = records.get(recordId);
        if (!record || record.used || !record.frame || typeof token !== "string" || !token.trim()
            || token.length > 32768 || !matches(record, target, false)) {
          return { invoked: false, reason: "observed_callback_stale" };
        }
        record.used = true;
        const result = Reflect.apply(record.callback.fn, record.callback.owner, [token]);
        if (result && typeof result.catch === "function") result.catch(() => {});
        return { invoked: true, reason: "observed_callback_invoked" };
      } catch (_) { return { invoked: false, reason: "observed_callback_failed" }; }
    },
  });
  try {
    Object.defineProperty(win, bridgeKey, { value: bridge, configurable: false, enumerable: false, writable: false });
    rootCell = watchProperty(win, "grecaptcha", (value) => {
      clearRecords();
      installNamespace(value, false, () => rootCell && rootCell.intact() && rootCell.value() === value);
      return value;
    });
    return !!rootCell;
  } catch (_) { return false; }
}

// Register once before navigation. Registration does not inspect or mutate the
// already open document; the script runs only in future Google login documents.
async function installRecaptchaObserver(page) {
  const previous = pageObservers.get(page);
  if (previous) return previous.promise;
  if (!page || typeof page.evaluateOnNewDocument !== "function") return { installed: false, reason: "observer_unavailable" };
  const state = { id: randomUUID(), installed: false, promise: null };
  pageObservers.set(page, state);
  state.promise = (async () => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => page.evaluateOnNewDocument(installRecaptchaObserverDOM, { observerId: state.id })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("observer_timeout")), 4000); }),
      ]);
      state.installed = true;
      return { installed: true };
    } catch (_) {
      return { installed: false, reason: "observer_unavailable" };
    } finally { clearTimeout(timer); }
  })();
  return state.promise;
}

function observerIdFor(page) {
  const state = pageObservers.get(page);
  return state && state.installed ? state.id : "";
}

module.exports = { BRIDGE_KEY, installRecaptchaObserver, observerIdFor, helpers: { installRecaptchaObserverDOM } };
