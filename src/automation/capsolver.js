"use strict";

// One instance belongs to one job; each account has an independent budget.
// A started request is never refunded: a lost createTask response can be billable.
const API = "https://api.capsolver.com";
const REQUEST_MS = 18000;
const SOLVE_MS = 140000;
const POLL_MS = 3000;
const MAX_POLLS = 40;
const ownErrors = new WeakSet();
const messages = Object.freeze({
  CAPSOLVER_CONFIG_INVALID: "CAPSOLVER 配置无效。",
  CAPSOLVER_CONFIG_OUTDATED: "打码次数已改为每账号设置，请刷新页面后重试。",
  CAPSOLVER_KEY_REQUIRED: "请填写有效的 CAPSOLVER API Key。",
  CAPSOLVER_LIMIT_INVALID: "每个账号的 CAPSOLVER 尝试次数必须是 1 至 10 的整数。",
  CAPSOLVER_ACTION_UNSUPPORTED: "CAPSOLVER 支持先登录再执行后续操作，或单独运行添加 2FA；不能用于仅检测密码或其它独立操作。",
  CAPSOLVER_PROXY_UNSUPPORTED: "CAPSOLVER 目前不支持代理模式。",
  CAPSOLVER_ACCOUNT_COUNT_INVALID: "CAPSOLVER 账号数量无效。",
  CAPSOLVER_DISABLED: "CAPSOLVER 未启用。",
  CAPSOLVER_DISPOSED: "CAPSOLVER 会话已结束。",
  CAPSOLVER_CANCELLED: "CAPSOLVER 请求已取消。",
  CAPSOLVER_ACCOUNT_LIMIT: "当前账号已达到 CAPSOLVER 尝试次数上限。",
  CAPSOLVER_ACCOUNT_INVALID: "CAPSOLVER 账号标识无效。",
  CAPSOLVER_CHALLENGE_INVALID: "CAPSOLVER 验证码参数无效。",
  CAPSOLVER_CHALLENGE_UNSUPPORTED: "CAPSOLVER 仅支持 reCAPTCHA v2。",
  CAPSOLVER_URL_UNSUPPORTED: "CAPSOLVER 仅支持 Google 账号 HTTPS 页面。",
  CAPSOLVER_REQUEST_TIMEOUT: "CAPSOLVER 请求超时，未自动重新创建任务。",
  CAPSOLVER_TIMEOUT: "CAPSOLVER 等待结果超时。",
  CAPSOLVER_NETWORK_ERROR: "CAPSOLVER 请求结果未确认，未自动重新创建任务。",
  CAPSOLVER_HTTP_ERROR: "CAPSOLVER HTTP 请求失败。",
  CAPSOLVER_HTTP_RETRYABLE: "CAPSOLVER 服务暂时不可用。",
  CAPSOLVER_RESPONSE_INVALID: "CAPSOLVER 返回的结果格式无效。",
  CAPSOLVER_TOKEN_INVALID: "CAPSOLVER 返回的验证码令牌无效。",
  CAPSOLVER_PROVIDER_ERROR: "CAPSOLVER 未能完成验证码任务。",
  ERROR_SERVICE_UNAVALIABLE: "CAPSOLVER 服务暂时不可用。",
  ERROR_RATE_LIMIT: "CAPSOLVER 请求达到服务限额。",
  ERROR_INVALID_TASK_DATA: "CAPSOLVER 不接受当前验证码参数。",
  ERROR_BAD_REQUEST: "CAPSOLVER 请求被拒绝。",
  ERROR_TASKID_INVALID: "CAPSOLVER 任务不存在或已过期。",
  ERROR_TASK_TIMEOUT: "CAPSOLVER 服务端任务超时。",
  ERROR_SETTLEMENT_FAILED: "CAPSOLVER 余额结算失败。",
  ERROR_KEY_DENIED_ACCESS: "CAPSOLVER API Key 无效或无权访问。",
  ERROR_ZERO_BALANCE: "CAPSOLVER 余额不足。",
  ERROR_TASK_NOT_SUPPORTED: "CAPSOLVER 不支持当前任务。",
  ERROR_CAPTCHA_UNSOLVABLE: "CAPSOLVER 未能识别验证码。",
  ERROR_UNKNOWN_QUESTION: "CAPSOLVER 无法处理当前验证码。",
  ERROR_PROXY_BANNED: "CAPSOLVER 使用的代理被目标网站拒绝。",
  ERROR_IP_BANNED: "CAPSOLVER 暂时拒绝当前 IP 的请求。",
  ERROR_KEY_TEMP_BLOCKED: "CAPSOLVER API Key 暂时被限制。",
});

function failure(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(messages, code) ? code : "CAPSOLVER_PROVIDER_ERROR";
  const error = new Error(messages[safeCode]);
  error.code = safeCode;
  if (safeCode === "CAPSOLVER_CANCELLED") error.name = "AbortError";
  ownErrors.add(error);
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfig(config, { accountCount, actionIds, proxy } = {}) {
  if (config == null || config === false) return null;
  if (!plainObject(config)) throw failure("CAPSOLVER_CONFIG_INVALID");
  if (config.enabled == null || config.enabled === false) return null;
  if (config.enabled !== true) throw failure("CAPSOLVER_CONFIG_INVALID");
  if (Object.prototype.hasOwnProperty.call(config, "maxTasks")) throw failure("CAPSOLVER_CONFIG_OUTDATED");
  if (Object.keys(config).some((key) => !["enabled", "apiKey", "maxAttemptsPerAccount"].includes(key))) {
    throw failure("CAPSOLVER_CONFIG_INVALID");
  }
  if (typeof config.apiKey !== "string" || !/^[^\s\x00-\x1f\x7f]{1,512}$/.test(config.apiKey.trim())) {
    throw failure("CAPSOLVER_KEY_REQUIRED");
  }
  const maxAttemptsPerAccount = config.maxAttemptsPerAccount === undefined ? 3 : config.maxAttemptsPerAccount;
  if (!Number.isInteger(maxAttemptsPerAccount) || maxAttemptsPerAccount < 1 || maxAttemptsPerAccount > 10) {
    throw failure("CAPSOLVER_LIMIT_INVALID");
  }
  const standaloneAuthenticator = Array.isArray(actionIds) && actionIds.length === 1 && actionIds[0] === "add-2fa";
  const startsWithLogin = Array.isArray(actionIds) && actionIds[0] === "login" && !actionIds.includes("check-password");
  if (!standaloneAuthenticator && !startsWithLogin) {
    throw failure("CAPSOLVER_ACTION_UNSUPPORTED");
  }
  if (proxy) throw failure("CAPSOLVER_PROXY_UNSUPPORTED");
  if (accountCount !== undefined && (!Number.isInteger(accountCount) || accountCount < 1)) {
    throw failure("CAPSOLVER_ACCOUNT_COUNT_INVALID");
  }
  return { enabled: true, apiKey: config.apiKey.trim(), maxAttemptsPerAccount };
}

function taskFor(challenge) {
  if (!plainObject(challenge)) throw failure("CAPSOLVER_CHALLENGE_INVALID");
  if (challenge.type !== "recaptcha-v2") throw failure("CAPSOLVER_CHALLENGE_UNSUPPORTED");
  const fields = ["type", "websiteURL", "websiteKey", "enterprise", "dataS", "pageAction", "isInvisible"];
  if (Object.keys(challenge).some((key) => !fields.includes(key)) || typeof challenge.enterprise !== "boolean") {
    throw failure("CAPSOLVER_CHALLENGE_INVALID");
  }
  let url;
  try {
    if (typeof challenge.websiteURL !== "string" || challenge.websiteURL.length > 8192) throw new Error();
    url = new URL(challenge.websiteURL);
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.port || url.username || url.password) {
      throw new Error();
    }
  } catch (_) { throw failure("CAPSOLVER_URL_UNSUPPORTED"); }
  if (typeof challenge.websiteKey !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(challenge.websiteKey)) {
    throw failure("CAPSOLVER_CHALLENGE_INVALID");
  }
  const task = {
    type: challenge.enterprise ? "ReCaptchaV2EnterpriseTaskProxyLess" : "ReCaptchaV2TaskProxyLess",
    websiteURL: `${url.origin}${url.pathname}`,
    websiteKey: challenge.websiteKey,
  };
  if (challenge.dataS !== undefined) {
    if (typeof challenge.dataS !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(challenge.dataS)) {
      throw failure("CAPSOLVER_CHALLENGE_INVALID");
    }
    if (challenge.enterprise) task.enterprisePayload = { s: challenge.dataS };
    else task.recaptchaDataSValue = challenge.dataS;
  }
  if (challenge.pageAction !== undefined) {
    if (typeof challenge.pageAction !== "string" || !/^[A-Za-z0-9/_-]{1,128}$/.test(challenge.pageAction)) {
      throw failure("CAPSOLVER_CHALLENGE_INVALID");
    }
    task.pageAction = challenge.pageAction;
  }
  if (challenge.isInvisible !== undefined) {
    if (typeof challenge.isInvisible !== "boolean") throw failure("CAPSOLVER_CHALLENGE_INVALID");
    task.isInvisible = challenge.isInvisible;
  }
  return task;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // Always observe an already-started promise, even if cancellation won the
    // race immediately before this wrapper was attached.
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  });
}

function createSolver(config, { signal, emit, fetchImpl = globalThis.fetch, sleep = delay, now = Date.now } = {}) {
  const normalized = normalizeConfig(config, { actionIds: ["login"] });
  let apiKey = normalized ? normalized.apiKey : "";
  const enabled = !!normalized;
  const maxAttemptsPerAccount = normalized ? normalized.maxAttemptsPerAccount : 0;
  // Do not retain the caller's configuration object or a second key copy.
  if (normalized) normalized.apiKey = "";
  config = null;
  let disposed = false;
  let attempted = 0;
  let ready = 0;
  let failed = 0;
  const accounts = new Map();
  const publish = (receiver, type, data = {}) => { try { if (typeof receiver === "function") receiver(type, data); } catch (_) {} };

  async function request(endpoint, payload, context, beforeSend) {
    context.check();
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(failure("CAPSOLVER_REQUEST_TIMEOUT")),
      Math.min(REQUEST_MS, context.remaining()));
    try {
      if (context.signal.aborted) onAbort();
      const operation = (async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (beforeSend) beforeSend();
        let response;
        try {
          response = await fetchImpl(`${API}/${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, ...payload }),
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal,
          });
        } catch (_) {
          throw controller.signal.aborted ? controller.signal.reason : failure("CAPSOLVER_NETWORK_ERROR");
        }
        if (!response || !Number.isInteger(response.status)) throw failure("CAPSOLVER_RESPONSE_INVALID");
        if (response.status < 200 || response.status >= 300) {
          throw failure([408, 429, 500, 502, 503, 504].includes(response.status)
            ? "CAPSOLVER_HTTP_RETRYABLE" : "CAPSOLVER_HTTP_ERROR");
        }
        let result;
        try { result = await response.json(); }
        catch (_) { throw failure("CAPSOLVER_RESPONSE_INVALID"); }
        if (!plainObject(result)) throw failure("CAPSOLVER_RESPONSE_INVALID");
        if (result.errorId !== 0) {
          if (Number.isInteger(result.errorId) && result.errorId > 0) {
            const code = typeof result.errorCode === "string" && result.errorCode.startsWith("ERROR_")
              ? result.errorCode : "CAPSOLVER_PROVIDER_ERROR";
            throw failure(code);
          }
          throw failure("CAPSOLVER_RESPONSE_INVALID");
        }
        return result;
      })();
      const result = await abortable(operation, controller.signal);
      context.check();
      return result;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  async function solveFor(stats, challenge, { emit: taskEmit } = {}) {
    const send = (type, data) => publish(typeof taskEmit === "function" ? taskEmit : emit, type, data);
    if (!enabled) throw failure("CAPSOLVER_DISABLED");
    if (disposed) throw failure("CAPSOLVER_DISPOSED");
    if (signal && signal.aborted) throw failure("CAPSOLVER_CANCELLED");
    const task = taskFor(challenge);
    if (stats.attempted >= maxAttemptsPerAccount) throw failure("CAPSOLVER_ACCOUNT_LIMIT");
    let requestStarted = false;
    const started = now();
    const controller = new AbortController();
    const onAbort = () => controller.abort(failure("CAPSOLVER_CANCELLED"));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(failure("CAPSOLVER_TIMEOUT")), SOLVE_MS);
    const context = {
      signal: controller.signal,
      remaining: () => Math.max(0, SOLVE_MS - (now() - started)),
      check: () => {
        if (signal && signal.aborted && !controller.signal.aborted) onAbort();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (disposed) throw failure("CAPSOLVER_DISPOSED");
        if (now() - started >= SOLVE_MS) throw failure("CAPSOLVER_TIMEOUT");
      },
    };
    try {
      const created = await request("createTask", { task }, context, () => {
        // Check and reserve together immediately before fetch, synchronously.
        // Even concurrent flows for the same account cannot exceed its budget.
        if (stats.attempted >= maxAttemptsPerAccount) throw failure("CAPSOLVER_ACCOUNT_LIMIT");
        stats.attempted += 1;
        attempted += 1;
        requestStarted = true;
        send("capsolver_attempt", { attempt: stats.attempted, maxAttemptsPerAccount });
      });
      if (typeof created.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(created.taskId)) {
        throw failure("CAPSOLVER_RESPONSE_INVALID");
      }
      const taskId = created.taskId;
      send("capsolver_created");
      for (let poll = 0; poll < MAX_POLLS; poll += 1) {
        context.check();
        await abortable(sleep(Math.min(POLL_MS, context.remaining()), controller.signal), controller.signal);
        context.check();
        let result;
        try { result = await request("getTaskResult", { taskId }, context); }
        catch (error) {
          if (ownErrors.has(error) && error.code === "CAPSOLVER_HTTP_RETRYABLE") {
            send("capsolver_processing");
            continue;
          }
          throw error;
        }
        if (result.status === "ready") {
          const token = result.solution && result.solution.gRecaptchaResponse;
          if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,16384}$/.test(token)) {
            throw failure("CAPSOLVER_TOKEN_INVALID");
          }
          context.check();
          ready += 1;
          stats.ready += 1;
          send("capsolver_ready");
          return { token };
        }
        if (result.status !== "idle" && result.status !== "processing") throw failure("CAPSOLVER_RESPONSE_INVALID");
        send("capsolver_processing");
      }
      throw failure("CAPSOLVER_TIMEOUT");
    } catch (error) {
      if (requestStarted) { failed += 1; stats.failed += 1; }
      const safe = ownErrors.has(error) ? error : failure("CAPSOLVER_PROVIDER_ERROR");
      send("capsolver_failed", { code: safe.code });
      throw safe;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  function forAccount(accountId, options = {}) {
    if (typeof accountId !== "string" || !accountId || accountId.length > 512) throw failure("CAPSOLVER_ACCOUNT_INVALID");
    if (!accounts.has(accountId)) accounts.set(accountId, { attempted: 0, ready: 0, failed: 0 });
    const stats = accounts.get(accountId);
    return {
      solve: (challenge) => solveFor(stats, challenge, options),
      maxAttemptsPerAccount,
      getAttemptCount: () => stats.attempted,
      summary: () => ({ enabled, ...stats, maxAttemptsPerAccount }),
    };
  }

  return {
    // Standalone callers retain a single-account interface. Multi-account jobs
    // must request account scopes and never share this implicit default scope.
    solve: (challenge, options) => forAccount("default", options).solve(challenge),
    forAccount,
    maxAttemptsPerAccount,
    getAttemptCount: () => forAccount("default").getAttemptCount(),
    summary: () => ({ enabled, attempted, ready, failed, maxAttemptsPerAccount }),
    dispose: () => { disposed = true; apiKey = ""; },
  };
}

module.exports = { normalizeConfig, createSolver };
