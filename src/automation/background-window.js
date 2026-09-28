"use strict";

// Only the dedicated browser connection supplied by the current task is touched.
// No OS window enumeration, headless mode, or taskbar hiding is involved.
const BACKGROUND_WARNING = "浏览器最小化未成功或当前内核不支持，本次窗口可能仍显示在前台。";

function createBackgroundWindowController(browser, options = {}) {
  const timeoutMs = Math.min(3000, Math.max(1, Number(options.timeoutMs) || 1200));
  const pending = new Set();
  const clients = new Set();
  const inFlight = new WeakMap();
  let active = true;
  let warned = false;
  const stopped = () => Object.assign(new Error("后台窗口控制已停止"), { stopped: true });
  const detach = (client) => {
    if (!client) return;
    clients.delete(client);
    // Detach must never delay stop/close, even if the connection has gone away.
    void Promise.resolve().then(() => client.detach()).catch(() => {});
  };
  const warn = () => {
    if (!active || warned) return;
    warned = true;
    if (typeof options.onWarning === "function") {
      void Promise.resolve().then(() => options.onWarning(BACKGROUND_WARNING)).catch(() => {});
    }
  };
  const bounded = (operation, disposeLate = () => {}) => new Promise((resolve, reject) => {
    if (!active) { reject(stopped()); return; }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(stopped());
    const timer = setTimeout(() => finish(new Error("最小化窗口超时")), timeoutMs);
    pending.add(cancel);
    Promise.resolve().then(() => {
      if (!active) throw stopped();
      return operation();
    }).then((value) => {
      if (settled) {
        void Promise.resolve().then(() => disposeLate(value)).catch(() => {});
      } else finish(null, value);
    }, (error) => finish(error));
  });
  const minimize = (target) => {
    if (!active || !target || typeof target !== "object") return Promise.resolve(false);
    if (inFlight.has(target)) return inFlight.get(target);
    const work = (async () => {
      let client;
      try {
        if ((typeof target.type === "function" ? target.type() : target.type) !== "page") return false;
        client = await bounded(() => target.createCDPSession(), detach);
        if (!active) { detach(client); return false; }
        clients.add(client);
        // Omitting targetId scopes the request to this CDP session's own target.
        const result = await bounded(() => client.send("Browser.getWindowForTarget"));
        if (!result || !Number.isInteger(result.windowId)) throw new Error("窗口不可用");
        await bounded(() => client.send("Browser.setWindowBounds", {
          windowId: result.windowId, bounds: { windowState: "minimized" },
        }));
        const confirmed = await bounded(() => client.send("Browser.getWindowBounds", { windowId: result.windowId }));
        if (!confirmed || !confirmed.bounds || confirmed.bounds.windowState !== "minimized") {
          throw new Error("窗口最小化未确认");
        }
        return true;
      } catch (_) {
        warn();
        return false;
      } finally {
        if (client && clients.has(client)) detach(client);
      }
    })();
    inFlight.set(target, work);
    void work.finally(() => inFlight.delete(target));
    return work;
  };
  const onTarget = (target) => { void minimize(target); };
  const remove = (event, handler) => {
    if (typeof browser.off === "function") browser.off(event, handler);
    else if (typeof browser.removeListener === "function") browser.removeListener(event, handler);
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    remove("targetcreated", onTarget);
    remove("targetchanged", onTarget);
    remove("disconnected", dispose);
    if (options.signal) options.signal.removeEventListener("abort", dispose);
    for (const cancel of [...pending]) cancel();
    for (const client of [...clients]) detach(client);
  };
  browser.on("targetcreated", onTarget);
  // Navigation may restore a native window even when launch was minimized.
  browser.on("targetchanged", onTarget);
  browser.on("disconnected", dispose);
  if (options.signal) {
    options.signal.addEventListener("abort", dispose, { once: true });
    if (options.signal.aborted) dispose();
  }
  return { minimize, dispose };
}

module.exports = { createBackgroundWindowController, BACKGROUND_WARNING };
