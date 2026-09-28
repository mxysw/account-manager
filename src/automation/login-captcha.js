"use strict";

const recaptcha = require("./recaptcha");

const GOOGLE_REJECTION_TEXT = /couldn['’]?t verify it['’]?s you|无法验证是[你您]本人|未能验证是[你您]本人/i;
const DETECTION_FAILURE_REASONS = new Set([
  "account_missing", "account_not_visible", "account_mismatch",
  "evaluation_failed", "evaluation_timeout", "unsupported_page",
  "challenge_missing", "challenge_not_visible",
]);

// A failed page/identity inspection is not evidence of a CAPTCHA. Keep its
// classification separate, and expose only fixed reason codes (never DOM data).
function detectionFailure(reason) {
  const diagnosticReason = DETECTION_FAILURE_REASONS.has(reason) ? reason : "observation_failed";
  const detail = diagnosticReason === "account_mismatch" ? "当前页面账号与所选账号不一致"
    : diagnosticReason === "account_not_visible" ? "尚未确认当前页面账号身份"
      : ["challenge_missing", "challenge_not_visible"].includes(diagnosticReason)
        ? "尚未发现可见的人机验证控件" : "未能可靠读取当前页面状态";
  return { handled: true, resumed: false, reasonCode: "captcha_detection_failed", diagnosticReason,
    message: `验证页面检测异常：${detail}，已停止且未调用打码` };
}

function hasGoogleRejectionText(text, address) {
  try {
    const url = new URL(address);
    return url.origin === "https://accounts.google.com" && !url.username && !url.password
      && GOOGLE_REJECTION_TEXT.test(String(text || ""));
  } catch (_) { return false; }
}

// Return only a fixed boolean from the trusted page. Rejection copy can appear
// without changing the challenge URL, and must stop before another paid call.
async function inspectGoogleRejection(page, { signal } = {}) {
  checkCancelled(signal);
  let url;
  try { url = new URL(page.url()); } catch (_) { return null; }
  if (url.origin !== "https://accounts.google.com" || url.username || url.password) return false;
  const result = await new Promise((resolve, reject) => {
    const finish = (handler, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      handler(value);
    };
    const abort = () => {
      const error = new Error("任务已取消");
      error.name = "AbortError";
      finish(reject, error);
    };
    const timer = setTimeout(() => finish(resolve, null), 4000);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      checkCancelled(signal);
      return page.evaluate((source) => {
        const current = new URL(document.location.href);
        if (current.origin !== "https://accounts.google.com" || current.username || current.password) return false;
        return new RegExp(source, "i").test(String(document.body?.innerText || ""));
      }, GOOGLE_REJECTION_TEXT.source);
    }).then(value => finish(resolve, value), () => finish(resolve, null));
  });
  checkCancelled(signal);
  return typeof result === "boolean" ? result : null;
}

function checkCancelled(signal) {
  if (signal && signal.aborted) {
    const error = new Error("任务已取消");
    error.name = "AbortError";
    throw error;
  }
}

function pause(ms, signal) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const error = new Error("任务已取消");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function confirmedNextPath(page, initialPath, absent) {
  let url;
  try { url = new URL(page.url()); } catch (_) { return ""; }
  if (url.username || url.password) return "";
  const path = `${url.origin}${url.pathname}`;
  const knownNext = url.origin === "https://myaccount.google.com"
    || url.origin === "https://accounts.google.com"
      && /^\/(?:v[23]\/signin|signin(?:\/v[23])?)\/(?:identifier|challenge\/(?:pwd|totp|selection|ipe|kpe|recoveryemail|iap|ipp(?:\/consent)?|idvpin|idvany|dp|ootp|sk))\/?$/i.test(url.pathname);
  return absent && path !== initialPath && knownNext ? path : "";
}

// Checkbox interaction is not a paid attempt. Only a visible, still-current
// follow-up challenge may cross the solver boundary; errors and waiting never do.
async function preflightCaptcha(page, account, options, deps) {
  const inspect = deps.inspectCheckbox || recaptcha.inspectCheckbox;
  const click = deps.clickCheckbox || recaptcha.clickCheckbox;
  const advance = deps.advanceCheckbox || recaptcha.advanceCheckbox;
  const inspectSolver = deps.inspect || recaptcha.inspectRecaptcha;
  const wait = deps.sleep || pause;
  const emit = options.emit || (() => {});
  const signal = options.signal;
  const args = { email: account.email, signal };
  const fail = (message) => ({ handled: true, resumed: false, message });
  let challengeSeen = false;
  let initialPath;
  try { const url = new URL(options.initialPath || page.url()); initialPath = `${url.origin}${url.pathname}`; }
  catch (_) { return detectionFailure("unsupported_page"); }
  const read = async () => {
    checkCancelled(signal);
    try {
      const result = await inspect(page, args);
      checkCancelled(signal);
      if (result?.present === true) challengeSeen = true;
      return result || { state: "unsupported", reason: "evaluation_failed" };
    } catch (_) {
      checkCancelled(signal);
      return { state: "unsupported", reason: "evaluation_failed" };
    }
  };
  const settling = new Set(["account_not_visible", "challenge_missing", "challenge_not_visible", "evaluation_failed", "frame_missing", "checkbox_missing"]);
  let observed = await read();
  for (let settle = 0; options.forceCaptcha && ["absent", "unsupported"].includes(observed.state)
    && settling.has(observed.reason) && settle < 5; settle += 1) {
    await wait(600, signal);
    observed = await read();
  }
  const absent = observed.state === "absent"
    && ["unsupported_page", "challenge_missing", "challenge_not_visible"].includes(observed.reason);
  if (absent && !options.forceCaptcha) return { handled: false };
  // Ordinary password/TOTP pages pass through without creating a CAPTCHA
  // status. An unreadable or mismatched page stops as a detection error.
  if (["unsupported", "error"].includes(observed.state) && (!challengeSeen
    || DETECTION_FAILURE_REASONS.has(observed.reason))) return detectionFailure(observed.reason);
  if (observed.state === "absent" && (!absent || !confirmedNextPath(page, initialPath, absent))) {
    return detectionFailure(observed.reason);
  }
  // Re-enter for each fresh challenge. The DOM adapter latches actual checkbox
  // clicks per widget; an account-wide boolean would block later challenges.
  options.onPreflightAttempt?.();
  emit("captcha_checkbox_checking", {});
  let clicked = false;
  let nextAttempted = false;
  let passedEmitted = false;
  let stablePath = "";
  let stableReads = 0;
  let solverSettles = 0;
  for (let poll = 0; poll < 30; poll += 1) {
    checkCancelled(signal);
    const currentURL = new URL(page.url());
    if (currentURL.origin === "https://accounts.google.com" && /rejected|disabled|deniedsignin/i.test(currentURL.pathname)) {
      return fail("Google 拒绝了当前验证或登录，已停止");
    }
    const rejected = await inspectGoogleRejection(page, { signal });
    if (rejected) return fail("Google 拒绝了当前验证或登录，已停止");
    if (rejected === null) return detectionFailure("evaluation_failed");
    const absent = observed.state === "absent"
      && ["unsupported_page", "challenge_missing", "challenge_not_visible"].includes(observed.reason);
    const path = confirmedNextPath(page, initialPath, absent);
    stableReads = path ? (stablePath === path ? stableReads + 1 : 1) : 0;
    stablePath = path;
    if (stableReads >= 2) {
      emit("captcha_accepted", {});
      if (!options.paidAttempts) emit("captcha_free_accepted", {});
      return { handled: true, resumed: true };
    }
    if (observed.state === "error") return !challengeSeen || DETECTION_FAILURE_REASONS.has(observed.reason)
      ? detectionFailure(observed.reason) : fail("人机验证显示错误或已过期，已停止且未调用打码");
    if (observed.state === "unsupported") return !challengeSeen || DETECTION_FAILURE_REASONS.has(observed.reason)
      ? detectionFailure(observed.reason) : fail("已发现人机验证控件，但无法安全操作；已停止且未调用打码");
    if (observed.state === "unchecked" && !clicked) {
      // Latch before awaiting: a detached handle or late response must not
      // cause a second click against a replacement challenge.
      clicked = true;
      try {
        const result = await click(page, args);
        checkCancelled(signal);
        if (result?.clicked) emit("captcha_checkbox_clicked", {});
      } catch (_) {
        checkCancelled(signal);
        return fail("人机复选框点击中断，已停止且未调用打码");
      }
    } else if (observed.state === "passed") {
      if (!passedEmitted) { emit("captcha_checkbox_passed", {}); passedEmitted = true; }
      if (!nextAttempted) {
        try {
          const result = await advance(page, args);
          checkCancelled(signal);
          // Only a clearly not-yet-rendered/disabled button can be checked
          // again. Uncertain click outcomes must never be repeated.
          nextAttempted = !(result?.advanced === false && result.attempted === false
            && ["next_missing", "next_disabled"].includes(result.reason));
        }
        catch (_) { checkCancelled(signal); return fail("人机验证下一步确认中断，已停止且未调用打码"); }
      }
    } else if (observed.state === "challenge") {
      // Refresh solver metadata only now, then recheck the visible challenge.
      // A delayed free pass must not turn into an unnecessary paid request.
      const checkboxFingerprint = observed.fingerprint;
      let snapshot;
      try { snapshot = await inspectSolver(page, { email: account.email }); }
      catch (_) { checkCancelled(signal); return fail("人机验证页面读取失败，已停止且未调用打码"); }
      checkCancelled(signal);
      observed = await read();
      if (observed.state !== "challenge") continue;
      if (!checkboxFingerprint || observed.fingerprint !== checkboxFingerprint) {
        return fail("人机挑战已变化，已停止且未调用打码，请重新检测");
      }
      if (snapshot?.supported) {
        if (snapshot.checkboxFingerprint !== observed.fingerprint) {
          return fail("人机挑战数据已变化，已停止且未调用打码，请重新检测");
        }
        emit("captcha_checkbox_challenge", {});
        return { handled: true, needsSolver: true, snapshot };
      }
      const recoverable = new Set(["response_missing", "challenge_missing", "challenge_not_visible", "evaluation_failed"]);
      if (!recoverable.has(snapshot?.reason) || solverSettles++ >= 5) {
        return fail("当前人机挑战不支持安全自动处理，已停止且未调用打码");
      }
    }
    await wait(500, signal);
    observed = await read();
  }
  return challengeSeen ? fail("人机验证等待超时，Google 未确认通过；已停止且未调用打码")
    : detectionFailure(observed.reason);
}

// These failures can consume another configured attempt, but only after a
// fresh preflight confirms that the same account still has a visible challenge.
// Unknown createTask outcomes, invalid configuration, balance/rate limits and
// Google login rejection are terminal rather than reasons to create more tasks.
const RETRYABLE_SOLVER_ERRORS = new Set([
  "ERROR_CAPTCHA_UNSOLVABLE", "ERROR_TASK_TIMEOUT", "ERROR_UNKNOWN_QUESTION",
  "ERROR_SERVICE_UNAVALIABLE", "CAPSOLVER_HTTP_RETRYABLE", "CAPSOLVER_TIMEOUT",
  "CAPSOLVER_TOKEN_INVALID",
]);

async function solveCaptchaAttempt(page, account, snapshot, options, deps) {
  const inspect = deps.inspect || recaptcha.inspectRecaptcha;
  const submit = deps.submit || recaptcha.submitRecaptcha;
  const advance = deps.advance || recaptcha.advanceRecaptcha;
  const wait = deps.sleep || pause;
  const emit = options.emit || (() => {});
  const signal = options.signal;
  const fail = (message, retryable = false, code = "") => ({ message, retryable, code });
  const callbackSource = ["explicit", "observed", "none"].includes(snapshot.callbackSource)
    ? snapshot.callbackSource : "none";
  emit("captcha_inspecting", { callbackSource, hasDataS: !!snapshot.challenge?.dataS });
  let solution;
  try {
    const rejected = await inspectGoogleRejection(page, { signal });
    if (rejected) return fail("Google 拒绝了当前验证或登录，已停止且不自动重试");
    if (rejected === null) return fail("无法确认 Google 登录状态，已停止且不自动重试");
    emit("captcha_solving", {});
    try {
      solution = await options.solver.solve(snapshot.challenge);
      checkCancelled(signal);
    } catch (error) {
      checkCancelled(signal);
      const code = /^[A-Z0-9_]{1,60}$/.test(error && error.code || "") ? error.code : "";
      return fail(`CAPSOLVER 未完成${code ? `（${code}）` : ""}`, RETRYABLE_SOLVER_ERRORS.has(code), code);
    } finally {
      options.recordAttempt();
    }
    checkCancelled(signal);
    const result = await submit(page, snapshot, solution.token, { email: account.email });
    solution.token = "";
    checkCancelled(signal);
    if (!result.submitted) return fail("验证码结果未提交：页面或账号已变化，或无法可靠填写");
    emit("captcha_submitted", { callbackSource, callbackInvoked: result.callbackInvoked === true });
    await wait(500, signal);
    // 回调可能已经推进页面，只在仍是完全相同的 CAPTCHA 时点一次“下一步”。
    const current = await inspect(page, { email: account.email });
    checkCancelled(signal);
    const rejectedAfterSubmit = await inspectGoogleRejection(page, { signal });
    if (rejectedAfterSubmit) return fail("Google 拒绝了当前验证或登录，已停止且不自动重试");
    if (rejectedAfterSubmit === null) return fail("无法确认 Google 登录状态，已停止且不自动重试");
    if (current.supported && current.fingerprint === snapshot.fingerprint) {
      // 再检查绑定与点击在同一次页面执行中完成。异步回调已经导航时不碰新页。
      // 点击无反馈也只观察，不重提，不把“已点击”当作 Google 已接受。
      await advance(page, snapshot, { email: account.email });
      checkCancelled(signal);
    }
    let stableNextPath = "";
    let stableNextReads = 0;
    for (let poll = 0; poll < 30; poll += 1) {
      checkCancelled(signal);
      const observed = await inspect(page, { email: account.email });
      checkCancelled(signal);
      const url = new URL(page.url());
      const absenceConfirmed = !observed.present &&
        ["unsupported_page", "challenge_missing", "challenge_not_visible"].includes(observed.reason);
      if (url.origin === "https://accounts.google.com" && /rejected|disabled|deniedsignin/i.test(url.pathname)) {
        return fail("Google 拒绝了当前验证或登录，已停止且不自动重试");
      }
      const rejected = await inspectGoogleRejection(page, { signal });
      if (rejected) return fail("Google 拒绝了当前验证或登录，已停止且不自动重试");
      if (rejected === null) return fail("无法确认 Google 登录状态，已停止且不自动重试");
      const observedPath = confirmedNextPath(page, snapshot.challenge.websiteURL, absenceConfirmed);
      if (observedPath) {
        stableNextReads = stableNextPath === observedPath ? stableNextReads + 1 : 1;
        stableNextPath = observedPath;
      } else {
        stableNextPath = "";
        stableNextReads = 0;
      }
      if (stableNextReads >= 2) {
        emit("captcha_accepted", {});
        return { handled: true, resumed: true };
      }
      await wait(500, signal);
    }
    return fail("CAPSOLVER 已返回结果，但 Google 未确认通过", true, "GOOGLE_NOT_CONFIRMED");
  } catch (_) {
    checkCancelled(signal);
    return fail("验证码提交或页面确认中断，已停止且不自动重试");
  } finally {
    if (solution) solution.token = "";
  }
}

// Per-account scope lives in the job's solver, so CAPTCHA → TOTP → CAPTCHA
// shares one budget. A successful checkbox pass never spends that budget.
async function handleLoginCaptcha(page, account, options = {}, deps = {}) {
  const emit = options.emit || (() => {});
  const wait = deps.sleep || pause;
  const configured = options.solver?.maxAttemptsPerAccount;
  const limit = Number.isInteger(configured) && configured >= 1 && configured <= 10 ? configured : 1;
  const scopedCount = () => typeof options.solver?.getAttemptCount === "function"
    ? options.solver.getAttemptCount() : null;
  let attempts = scopedCount() ?? (Number.isInteger(options.attempts) ? options.attempts : options.attempted ? 1 : 0);
  let initialPath = "";
  let lastFailure = "";
  const fail = (message, diagnosis) => {
    const detectionError = diagnosis?.reasonCode === "captcha_detection_failed";
    emit(detectionError ? "login_detection_failed" : "captcha_failed",
      detectionError ? { reason: diagnosis.diagnosticReason } : {});
    return { handled: true, resumed: false,
      ...(detectionError ? { reasonCode: "captcha_detection_failed" } : {}),
      message: attempts ? `本账号已调用 ${attempts}/${limit} 次：${message}` : message };
  };
  for (let round = 0; round <= limit; round += 1) {
    checkCancelled(options.signal);
    const preflight = await preflightCaptcha(page, account, {
      ...options, paidAttempts: attempts, initialPath: initialPath || undefined,
      forceCaptcha: round > 0 || options.forceCaptcha,
    }, deps);
    checkCancelled(options.signal);
    if (!preflight.needsSolver) {
      if (preflight.message) {
        const message = preflight.message.replace(/未调用打码/g, "本轮未调用打码");
        return fail(message, preflight);
      }
      return preflight;
    }
    if (!options.solver) return fail("出现人机验证，未启用 CAPSOLVER");
    attempts = scopedCount() ?? attempts;
    if (attempts >= limit) {
      return fail(`已达到每账号最多 ${limit} 次打码；${lastFailure || "Google 再次要求人机验证"}，已结束该账号`);
    }
    initialPath = preflight.snapshot.challenge.websiteURL;
    const result = await solveCaptchaAttempt(page, account, preflight.snapshot, {
      ...options,
      recordAttempt: () => {
        const previous = attempts;
        attempts = scopedCount() ?? attempts + 1;
        if (attempts > previous) options.onAttempt?.(attempts);
      },
    }, deps);
    if (result.resumed) return result;
    lastFailure = result.message;
    if (!result.retryable) return fail(`${result.message}；已结束该账号`);
    // Only retry metadata is logged. Each round reads new live widget data and
    // obtains a new token; an old token or snapshot is never replayed.
    if (attempts < limit) emit("captcha_retrying", { attempt: attempts + 1, maxAttemptsPerAccount: limit, code: result.code });
    await wait(1000, options.signal);
  }
  return fail(`已达到每账号最多 ${limit} 次打码；${lastFailure}，已结束该账号`);
}

module.exports = { handleLoginCaptcha, checkCancelled, pause, hasGoogleRejectionText };
