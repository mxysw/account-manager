"use strict";

const { AdsPower } = require("./adspower");
const browser = require("./browser");
const localBrowser = require("./local-browser");
const actions = require("./actions");
const accounts = require("../accounts");
const capsolver = require("./capsolver");

/**
 * 自动化任务引擎：
 * - 一个 job = 在若干 AdsPower 环境上，对若干账号依次执行若干动作
 * - 环境池循环复用，按 maxConcurrent 控制并发
 * - 每个动作的结果写回账号库（status / 字段）
 *
 * 注意：本引擎假设环境里“已登录目标账号”（登录动作可单独实现后接入）。
 */
const jobs = new Map();
// AdsPower serial 是跨 job 共享的真实浏览器环境。只靠 job 内的 env.busy 无法阻止
// 另一个任务复用同一 serial 并在启动前 ads.stop，因此在进程内做全局占用。
const adsSerialOwners = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOCAL_LAUNCH_ATTEMPTS = 2;
const LOCAL_CONNECT_ATTEMPTS = 4;

function cancelledError() {
  const error = new Error("任务已取消");
  error.name = "AbortError";
  return error;
}

// 不能等一个卡住的 CDP/动作自行返回；同时接住迟到的 reject，避免未处理异常。
function abortable(signal, work) {
  if (signal && signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelledError());
    if (signal) signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal && signal.aborted) throw cancelledError();
      return work();
    }).then(resolve, reject).finally(() => {
      if (signal) signal.removeEventListener("abort", abort);
    });
  });
}

function bounded(work, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function cancellationClosing(job) {
  return !!job.cancelled && job.envs.some((env) => env.busy || env.closePromise || env.pendingResources);
}

function connectSession(endpoint, env, signal, isCancelled, connect = browser.connect, options = {}) {
  // 接管不创建新的浏览器进程；不能等永不返回的 CDP 连接才结束取消。
  // 迟到的会话只关它自己，不再 stop 环境（该 serial 可能已分配给新任务）。
  return abortable(signal, async () => {
    const session = await connect(endpoint, { signal, background: options.background === true, onBackgroundWarning: options.onBackgroundWarning });
    if ((signal && signal.aborted) || isCancelled()) {
      void bounded(() => session.close(), 3500, "迟到连接关闭超时").catch(() => {});
      throw cancelledError();
    }
    env.session = session;
    return session;
  });
}

// 句柄必须先登记再交给动作；取消期间迟到的启动/连接也属于本任务，不能成为孤儿窗口。
function trackResource(job, env, work, adopt) {
  env.pendingResources = (env.pendingResources || 0) + 1;
  return Promise.resolve().then(work).then((value) => {
    adopt(value);
    env.resourceVersion = (env.resourceVersion || 0) + 1;
    return value;
  }, (error) => {
    if (error.local) env.local = error.local;
    throw error;
  }).finally(() => {
    env.pendingResources -= 1;
    if (job.cancelled) {
      // 上一轮 stop 可能先于 start 的返回完成，必须在新句柄登记后再收尾。
      const previous = env.closePromise || Promise.resolve();
      previous.then(() => closeEnvironment(job, env, true)).then(() => schedule(job));
    }
  });
}

function pendingEnvironmentRequest(job, env, work) {
  env.pendingResources = (env.pendingResources || 0) + 1;
  return Promise.resolve().then(work).finally(() => {
    env.pendingResources -= 1;
    // HTTP 等待超时不等于服务端请求结束；真正 settle 前保留环境所有权。
    schedule(job);
  });
}

function closeEnvironment(job, env, retry = false) {
  if (env.closePromise) return env.closePromise;
  if (env.closeError && !retry) return Promise.resolve(false);
  const local = env.local;
  const session = env.session;
  const stopAds = job.mode !== "local" && !!env.needsStop;
  const resourceVersion = env.resourceVersion;
  if (!local && !session && !stopAds) {
    if (!env.closeError) env.retained = false;
    return Promise.resolve(!env.closeError);
  }
  env.closeError = null;
  env.closePromise = (async () => {
    // CDP 卡住不能挡住进程 stop；进程/API stop 才是窗口关闭的最终依据。
    const disconnect = session
      ? bounded(() => session.close({ timeoutMs: 1500 }), 3500, "浏览器连接关闭超时").catch(() => null)
      : Promise.resolve();
    try {
      if (local) await bounded(() => local.stop(), 10000, "浏览器进程关闭超时，请重试");
      else if (stopAds) {
        const ads = new AdsPower({ apiKey: job.apiKey });
        const result = await bounded(() => pendingEnvironmentRequest(job, env, () => ads.stop(env.serial)), 15000, "AdsPower 关闭超时，请重试");
        if (!result || (result.code != null ? result.code !== 0 : result.ok !== true)) {
          throw new Error((result && (result.error || result.message || result.msg)) || "AdsPower 未确认关闭成功，请重试");
        }
      }
      await disconnect;
      if (env.local === local) env.local = null;
      if (env.session === session) env.session = null;
      if (env.resourceVersion === resourceVersion) env.needsStop = false;
      env.retained = false;
      return true;
    } catch (error) {
      env.closeError = sanitizeTotpSetupValue(error.message || "窗口关闭失败，请重试");
      env.retained = true;
      return false;
    }
  })().finally(() => { env.closePromise = null; });
  return env.closePromise;
}

function isFatalLocalStartupError(err) {
  const message = err && err.message ? err.message : String(err || "");
  return /未找到本机浏览器|未安装 puppeteer-core/.test(message);
}

// 登录动作尚未来得及返回结构化结果时（最常见是浏览器/CDP 冷启动失败），
// 也生成与正常 login 动作同形的结果，确保账号行和任务日志都能看到具体原因。
function buildUnhandledLoginResult(err, activeActionId = null, actionId = "login") {
  const raw = err && err.message ? err.message : String(err || "未知错误");
  const message = raw
    .replace(/https?:\/\/[^\s，；]+/gi, (url) => url.split("?")[0].slice(0, 180))
    .slice(0, 500);
  const browserFailure = activeActionId == null
    || /浏览器|Chrome|Edge|CDP|调试地址|接管|connect|launch|Target closed|Session closed|detached/i.test(message);
  const reasonCode = browserFailure ? "browser_start_failed"
    : (/超时|timeout|timed out/i.test(message) ? "timeout" : "other");
  const detail = browserFailure
    ? `浏览器/检测环境启动失败：${message}`
    : `登录检测异常：${message}`;
  const lastLoginCheck = {
    reasonCode,
    outcome: "error",
    detail,
    checkedAt: new Date().toISOString(),
  };
  const passwordOnly = actionId === "check-password";
  return {
    action: actionId,
    outcome: "error",
    reasonCode,
    detail: { [passwordOnly ? "password" : "login"]: detail },
    statusPatch: passwordOnly ? {} : { login: "failed" },
    // 浏览器/CDP 启动异常发生在密码提交前；完整登录也不能因此抹掉旧的独立密码检测结论。
    fieldPatch: passwordOnly ? { lastPasswordCheck: lastLoginCheck } : { lastLoginCheck },
  };
}

// 添加身份验证器的结果会公开给轮询接口/任务日志，绝不能把设置密钥或二维码回传到这些位置。
function sanitizeTotpSetupValue(value, secrets = []) {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length) text = text.split(secret).join("[已隐藏]");
    }
    return text
      .replace(/otpauth:\/\/[^\s，；]+/gi, "[已隐藏密钥]")
      .replace(/https?:\/\/[^\s，；]+/gi, (raw) => raw.split(/[?#]/)[0].slice(0, 180))
      .replace(/\b[A-Z2-7]{16,}\b/gi, "[已隐藏密钥]");
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTotpSetupValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:totpSecret|oldTotpSecret|pendingTotpSetup|secret|password|recoveryEmail|raw|code|qrCode|qrData|otpauth|uri)$/i.test(key)) continue;
    safe[key] = sanitizeTotpSetupValue(item, secrets);
  }
  return safe;
}

function publicActionResult(result, secrets = []) {
  if (!result || result.action !== "add-2fa") return result;
  const safe = sanitizeTotpSetupValue(result, secrets);
  safe.fieldPatch = {};
  if (result.fieldPatch && Object.prototype.hasOwnProperty.call(result.fieldPatch, "lastTotpSetup")) {
    safe.fieldPatch.lastTotpSetup = accounts.normalizeTotpSetup(sanitizeTotpSetupValue(result.fieldPatch.lastTotpSetup, secrets));
  }
  return safe;
}

// 仅 add-2fa 得到这两个 durable callback。先落盘再返回，动作才能安全地提交新验证码。
function createTotpSetupContext(account, task, emit, secrets = new Set(), store = accounts, isCancelled = () => false) {
  return {
    async recordLoginResult(result) {
      if (isCancelled()) throw cancelledError();
      if (!result || typeof result !== "object") throw new Error("登录结果无效");
      const patch = {};
      if (result.statusPatch && Object.prototype.hasOwnProperty.call(result.statusPatch, "login")) {
        patch.status = { login: result.statusPatch.login };
      }
      for (const field of ["lastLoginCheck", "lastPasswordCheck"]) {
        if (result.fieldPatch && Object.prototype.hasOwnProperty.call(result.fieldPatch, field)) patch[field] = result.fieldPatch[field];
      }
      if (Object.keys(patch).length) {
        if (!store.update(account.id, patch)) throw new Error("账号已不存在，无法保存登录结果");
        await store.flush();
      }
      if (isCancelled()) throw cancelledError();
      const safe = sanitizeTotpSetupValue({
        action: "login", outcome: result.outcome, reasonCode: result.reasonCode || "",
        detail: result.detail || {}, statusPatch: patch.status || {},
        fieldPatch: Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "status")),
      }, [...secrets]);
      const previous = task.results.findIndex((entry) => entry && entry.action === "login");
      if (previous >= 0) task.results[previous] = safe;
      else task.results.push(safe);
      emit("login_result_saved", { outcome: safe.outcome });
    },
    async checkpointTotpSetup(fieldPatch) {
      if (isCancelled()) throw cancelledError();
      if (!fieldPatch || typeof fieldPatch !== "object" || Array.isArray(fieldPatch)) throw new Error("2FA 保存内容无效");
      const patch = {};
      for (const field of ["pendingTotpSetup", "totpSecret", "lastTotpSetup"]) {
        if (!Object.prototype.hasOwnProperty.call(fieldPatch, field)) continue;
        const value = fieldPatch[field];
        if (field === "pendingTotpSetup") {
          patch[field] = store.normalizePendingTotpSetup(value);
          if (value != null && !patch[field]) throw new Error("待确认的 2FA 密钥无效，未提交");
          if (patch[field]) secrets.add(patch[field].secret);
        } else if (field === "totpSecret") {
          patch[field] = store.normalizeTotpSecret(value);
          if (!patch[field]) throw new Error("2FA 密钥无效，未保存");
          secrets.add(patch[field]);
        } else {
          patch[field] = store.normalizeTotpSetup(value);
        }
      }
      if (!Object.keys(patch).length) return;
      // accounts.update 会隐式刷新时间；仅写 totpSecret 时还会清掉旧 lastTotpSetup。
      // 这些派生改动同样必须在持久化失败时回滚。
      const rollbackFields = new Set([...Object.keys(patch), "lastTotpSetup", "lastCheckedAt", "updatedAt"]);
      const previous = Object.fromEntries([...rollbackFields].map((key) => [key, account[key]]));
      try {
        if (!store.update(account.id, patch)) throw new Error("账号已不存在，无法保存 2FA 设置");
        await store.flush();
      } catch (err) {
        // 落盘失败不能让进程内缓存把新密钥误当作已保存/已启用。
        Object.assign(account, previous);
        throw new Error("2FA 设置无法安全保存，已停止提交");
      }
      // 已落盘的候选密钥保留，但取消后不能允许动作继续提交验证码。
      if (isCancelled()) throw cancelledError();
    },
  };
}

function buildUnhandledTotpSetupResult(account, message) {
  const pending = !!account.pendingTotpSetup;
  const activationPending = !!account.totpSecret && account.lastTotpSetup && account.lastTotpSetup.state === "pending_activation";
  const state = pending ? "needs_attention" : (activationPending ? "pending_activation" : "failed");
  const detail = pending ? "添加过程已中断，待确认密钥已保留，尚未确认生效"
    : (activationPending ? "身份验证器密钥已保存，但尚未确认两步验证开启" : `添加 2FA 未完成：${message}`);
  return {
    action: "add-2fa", outcome: pending || activationPending ? "need_verify" : "error",
    detail: { "2fa": detail }, statusPatch: {},
    fieldPatch: { lastTotpSetup: accounts.normalizeTotpSetup({ state, detail, checkedAt: new Date().toISOString() }) },
  };
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    background: job.background === true,
    phoneMode: job.phoneMode,
    keepOpenSelected: !!job.requestedKeepOpen,
    manualChallengePolicy: job.manualChallengePolicy,
    captchaSolver: job.captchaSolver ? job.captchaSolver.summary() : null,
    createdAt: job.createdAt,
    actionIds: job.actionIds,
    status: job.status,
    cancelRequested: !!job.cancelled,
    closing: cancellationClosing(job),
    closeErrors: job.envs.filter((e) => e.closeError).map((e) => ({ env: e.serial, message: e.closeError })),
    envs: job.envs.map((e) => ({ serial: e.serial, busy: e.busy, retained: !!e.retained })),
    tasks: job.tasks.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      email: t.email,
      env: t.env,
      status: t.status,
      captcha: t.captcha || null,
      windowWarning: t.windowWarning || "",
      results: t.results.map((result) => publicActionResult(result)),
      error: t.error,
    })),
  };
}

function runningCount(job) {
  return job.tasks.filter((t) => t.status === "running").length;
}

function isEnvReusable(env) {
  return !!env && !env.busy && !env.retained;
}

function finishQueuedWithoutReusableEnv(job) {
  const queued = job.tasks.filter((t) => t.status === "queued");
  if (!queued.length || job.envs.some((env) => isEnvReusable(env) || env.busy)) return false;
  const message = "没有可复用的浏览器环境：已有窗口正保留给人工完成验证，为避免关闭该窗口，剩余账号未启动";
  for (const task of queued) {
    task.status = "error";
    task.error = message;
    task.events.push({ time: new Date().toISOString(), type: "env_unavailable", data: { message } });
  }
  return true;
}

function normalizeAdsSerials(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value == null ? "" : value).trim())
    .filter(Boolean))];
}

function reserveAdsSerials(jobId, serials) {
  const conflict = serials.find((serial) => adsSerialOwners.has(serial));
  if (conflict) throw new Error(`AdsPower 环境 ${conflict} 正被另一个任务使用或保留，请先停止并关闭原任务窗口`);
  serials.forEach((serial) => adsSerialOwners.set(serial, jobId));
}

function releaseAdsSerial(job, env, force = false) {
  if (!job || job.mode === "local" || !env) return false;
  if (!force && (env.retained || env.busy || env.pendingResources || env.closePromise || env.needsStop)) return false;
  if (adsSerialOwners.get(env.serial) !== job.id) return false;
  adsSerialOwners.delete(env.serial);
  return true;
}

function releaseFinishedAdsSerials(job) {
  if (!job || job.mode === "local") return;
  job.envs.forEach((env) => releaseAdsSerial(job, env, false));
}

function schedule(job) {
  if (job.cancelled) {
    // 取消后：排队中的全部置为已取消，不再开新窗口。
    job.tasks.forEach((t) => { if (t.status === "queued") t.status = "cancelled"; });
    if (!cancellationClosing(job) && job.tasks.every((t) => ["done", "error", "cancelled"].includes(t.status))) {
      job.status = "cancelled";
      releaseFinishedAdsSerials(job);
    }
    return;
  }
  for (const env of job.envs) {
    if (runningCount(job) >= job.maxConcurrent) break;
    if (!isEnvReusable(env)) continue;
    const task = job.tasks.find((t) => t.status === "queued");
    if (!task) break;
    env.busy = true;
    task.env = env.serial;
    task.status = "running";
    runTask(job, env, task);
  }
  finishQueuedWithoutReusableEnv(job);
  if (!job.envs.some((env) => env.busy) && job.tasks.every((t) => ["done", "error", "cancelled"].includes(t.status))) {
    job.status = job.cancelled ? "cancelled" : "done";
    if (job.captchaSolver) job.captchaSolver.dispose();
    releaseFinishedAdsSerials(job);
  }
}

/** 立即接受取消，后台独立收尾；接口返回不代表窗口已经关完。 */
async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.cancelled = true;
  job.abortController.abort();
  if (job.captchaSolver) job.captchaSolver.dispose();
  job.tasks.forEach((t) => { if (t.status === "queued") t.status = "cancelled"; });
  if (!job.cancelPromise) {
    job.cancelPromise = Promise.all(job.envs.map((env) => closeEnvironment(job, env, true)))
      .finally(() => { job.cancelPromise = null; schedule(job); });
  }
  schedule(job);
  return job;
}

function shouldKeepTaskOpen(jobKeepOpen, actionRequested) {
  return !!(jobKeepOpen || actionRequested);
}

function normalizeManualChallengePolicy(value) {
  if (value == null || value === "") return "close";
  const policy = String(value);
  if (policy !== "close" && policy !== "keep" && policy !== "solve_close") {
    throw new Error("需人工验证窗口策略无效：只能是 close、keep 或 solve_close");
  }
  return policy;
}

function shouldRetainTaskWindow(jobKeepOpen, actionRequested, manualChallengePolicy) {
  // 自动打码模式明确要求完成/失败后关窗，优先于普通保留与动作接管请求。
  if (manualChallengePolicy === "solve_close") return false;
  // 动作明确请求 handoff，说明当前是人机/短信/设备通知等需人工验证页；
  // 此时独立策略优先于普通“跑完保留窗口”。其它普通结果仍由 jobKeepOpen 控制。
  if (actionRequested) return manualChallengePolicy === "keep";
  return !!jobKeepOpen;
}

function normalizeJobKeepOpen(actionIds, requestedKeepOpen) {
  // 添加手机号批次若沿用全局“跑完保留窗口”，已完成的账号会持续占住并发 slot；
  // 当所有 slot 都被保留后，schedule 只能把剩余账号判为无可用环境。
  // 动作自身的人机/短信/人工接管请求由 manualChallengePolicy 单独决定。
  return !actionIds.includes("add-2fa-phone") && !!requestedKeepOpen;
}

/**
 * 启动并接管一个本机临时浏览器。
 *
 * Chrome 冷启动时，调试 HTTP 接口与 Target.createTarget 并不总是同时就绪：端口已经能访问，
 * Puppeteer 的 connect/newPage 仍可能短暂失败。先在同一进程上短退避重连；仍失败时再完整重启
 * 一次浏览器。这里只重试“动作开始前”的启动阶段，绝不会重复执行登录、换 2FA、关支付等动作。
 */
async function openLocalSession(options = {}, deps = {}) {
  const env = options.env || { local: null };
  const emit = typeof options.emit === "function" ? options.emit : () => {};
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;
  const step = (work) => abortable(options.signal, () => {
    if (isCancelled()) throw cancelledError();
    return work();
  });
  const track = options.trackResource || (async (work, adopt) => { const value = await work(); adopt(value); return value; });
  const startLocal = deps.start || localBrowser.start;
  const connectBrowser = deps.connect || browser.connect;
  const wait = deps.sleep || sleep;
  const launchAttempts = Math.max(1, Number(deps.launchAttempts) || LOCAL_LAUNCH_ATTEMPTS);
  const connectAttempts = Math.max(1, Number(deps.connectAttempts) || LOCAL_CONNECT_ATTEMPTS);
  let lastError = null;

  for (let launchAttempt = 1; launchAttempt <= launchAttempts; launchAttempt += 1) {
    let launched = null;
    try {
      if (isCancelled()) throw new Error("任务已取消");
      emit("opening_local", {
        env: env.serial,
        clearData: !!options.clearData,
        attempt: launchAttempt,
        totalAttempts: launchAttempts,
      });
      launched = await step(() => track(
        () => startLocal({ clearData: options.clearData, proxy: options.proxy, signal: options.signal, background: options.background === true }),
        (local) => { env.local = local; },
      ));
      emit("local_opened", {
        env: env.serial,
        port: launched.port,
        browser: launched.executablePath,
        attempt: launchAttempt,
      });

      for (let connectAttempt = 1; connectAttempt <= connectAttempts; connectAttempt += 1) {
        try {
          if (isCancelled()) throw new Error("任务已取消");
          const session = await step(() => connectSession(launched.cdpEndpoint, env, options.signal, isCancelled, connectBrowser, options));
          if (isCancelled()) {
            await bounded(() => session.close(), 3500, "浏览器连接关闭超时").catch(() => {});
            throw cancelledError();
          }
          return { local: launched, session };
        } catch (err) {
          lastError = err;
          if (isCancelled() || isFatalLocalStartupError(err) || connectAttempt === connectAttempts) break;
          const delayMs = Math.min(1200, 250 * (2 ** (connectAttempt - 1)));
          emit("local_connect_retry", {
            env: env.serial,
            attempt: connectAttempt + 1,
            totalAttempts: connectAttempts,
            delayMs,
            error: err.message,
          });
          await step(() => wait(delayMs));
        }
      }
    } catch (err) {
      lastError = err;
      if (err.local) env.local = err.local;
      if (err.cleanupFailed) throw err;
    }

    // 引擎统一关闭已登记/迟到句柄，不能在这里与 cancel 重复 stop。
    if (isCancelled() && options.trackResource) throw cancelledError();
    if (launched) {
      try { await bounded(() => launched.stop(), 10000, "浏览器进程关闭超时"); }
      catch (error) { env.retained = true; throw error; }
      if (env.local === launched) env.local = null;
    }
    if (isCancelled()) throw new Error("任务已取消");
    if (isFatalLocalStartupError(lastError) || launchAttempt === launchAttempts) break;

    const delayMs = 600;
    emit("local_launch_retry", {
      env: env.serial,
      attempt: launchAttempt + 1,
      totalAttempts: launchAttempts,
      delayMs,
      error: lastError && lastError.message ? lastError.message : String(lastError || "未知错误"),
    });
    await step(() => wait(delayMs));
  }

  const reason = lastError && lastError.message ? lastError.message : "未知错误";
  throw new Error(`本机浏览器启动/接管失败（已自动重试）：${reason}`);
}

async function runTask(job, env, task) {
  const step = (work) => abortable(job.abortController.signal, work);
  const track = (work, adopt) => trackResource(job, env, work, adopt);
  // 代理/指纹/预关闭请求也可能迟到；返回前不能把同一 serial 交给另一个任务。
  const adsStep = (work) => step(() => track(work, () => {}));
  const account = accounts.getById(task.accountId);
  const setupSecrets = new Set(account ? [account.totpSecret, account.pendingTotpSetup && account.pendingTotpSetup.secret, account.password] : []);
  let accountCaptchaSolver = null;
  const emit = (type, data = {}) => {
    if (job.cancelled) return;
    if (/^(?:captcha_|capsolver_)/.test(type)) {
      // 仅记录固定诊断字段；绝不保存验证码令牌、回调函数、URL 或挑战参数。
      const safe = {};
      if (["explicit", "observed", "none"].includes(data.callbackSource)) safe.callbackSource = data.callbackSource;
      if (typeof data.callbackInvoked === "boolean") safe.callbackInvoked = data.callbackInvoked;
      if (typeof data.hasDataS === "boolean") safe.hasDataS = data.hasDataS;
      if (/^[A-Z0-9_]{1,60}$/.test(data.code || "")) safe.code = data.code;
      if (Number.isInteger(data.attempt) && data.attempt >= 1 && data.attempt <= 10) safe.attempt = data.attempt;
      if (Number.isInteger(data.maxAttemptsPerAccount) && data.maxAttemptsPerAccount >= 1 && data.maxAttemptsPerAccount <= 10) {
        safe.maxAttemptsPerAccount = data.maxAttemptsPerAccount;
      }
      data = safe;
    }
    const captchaStates = {
      captcha_inspecting: "inspecting", captcha_solving: "solving", captcha_retrying: "retrying",
      captcha_checkbox_checking: "checking", captcha_checkbox_clicked: "clicked",
      captcha_checkbox_passed: "checkbox_passed", captcha_checkbox_challenge: "challenge",
      captcha_free_accepted: "direct_passed",
      capsolver_attempt: "solving", capsolver_created: "solving", capsolver_processing: "processing",
      capsolver_ready: "ready", captcha_submitted: "submitted",
      captcha_accepted: "accepted", capsolver_failed: "failed", captcha_failed: "failed",
    };
    if (captchaStates[type] && job.captchaSolver) {
      task.captcha = task.captcha || { state: "inspecting", attempted: 0, ready: 0, failed: 0 };
      task.captcha.state = captchaStates[type];
      // Provider counters count actual requests/results; page inspection and a
      // terminal captcha_failed event must not create or double-count attempts.
      if (accountCaptchaSolver) {
        const { attempted, ready, failed, maxAttemptsPerAccount } = accountCaptchaSolver.summary();
        Object.assign(task.captcha, { attempted, ready, failed, maxAttemptsPerAccount });
      }
      if (["explicit", "observed", "none"].includes(data.callbackSource)) task.captcha.callbackSource = data.callbackSource;
      if (typeof data.callbackInvoked === "boolean") task.captcha.callbackInvoked = data.callbackInvoked;
      if (typeof data.hasDataS === "boolean") task.captcha.hasDataS = data.hasDataS;
    }
    task.events.push({
      time: new Date().toISOString(), type,
      data: job.actionIds.includes("add-2fa") ? sanitizeTotpSetupValue(data, [...setupSecrets]) : data,
    });
  };
  if (job.captchaSolver) accountCaptchaSolver = job.captchaSolver.forAccount(task.accountId, { emit });
  const isLocal = job.mode === "local";
  const ads = isLocal ? null : new AdsPower({ apiKey: job.apiKey });
  let session = null;
  let activeActionId = null;
  let keepOpenRequested = false;
  let handoffRequested = false;
  let windowOpened = false;
  const onBackgroundWarning = () => {
    if (!job.background || job.cancelled || task.status !== "running" || task.windowWarning) return;
    task.windowWarning = "浏览器未能保持最小化，可能弹到前台；检测仍继续。可手动最小化，或停止任务后关闭后台运行选项重试。";
    emit("background_window_warning", { message: task.windowWarning });
  };
  try {
    if (!account) throw new Error("账号已不存在");

    if (isLocal) {
      // 本机临时浏览器模式：不走 AdsPower 代理池 / 随机指纹 / 环境序号，
      // 直接起一个一次性 Chrome/Edge，再用同样的 CDP 接管。启动阶段带冷启动重试，
      // 但动作一旦开始绝不重跑，避免写操作被执行两次。
      // proxy 为规划中字段：若 job.proxy.server 存在则透传 --proxy-server（UI 暂未对接，留好入口）。
      const proxyServer = job.proxy && job.proxy.server ? job.proxy.server : null;
      const opened = await openLocalSession({
        env,
        emit,
        clearData: job.clearData,
        background: job.background,
        onBackgroundWarning,
        proxy: proxyServer,
        isCancelled: () => job.cancelled,
        signal: job.abortController.signal,
        trackResource: track,
      });
      env.local = opened.local;
      session = opened.session;
      windowOpened = true;
    } else {
      // 开窗口前处理代理（需先关窗，改动才能在重开后生效）：
      //  - 勾选：从代理池绑一条住宅（每开一个号换一个新住宅 IP）
      //  - 未勾选：把环境已有代理清成无代理（直连）
      {
        env.needsStop = true;
        try { await adsStep(() => ads.stop(env.serial)); } catch (_) { /* cancellation is checked by next step */ }
        await step(() => sleep(500));
        if (job.proxy && job.proxy.enabled) {
          if (Array.isArray(job.proxy.proxyIds) && job.proxy.proxyIds.length) {
            // 按标签筛过的代理池：从该标签里随机挑一条绑上。
            const pid = job.proxy.proxyIds[Math.floor(Math.random() * job.proxy.proxyIds.length)];
            emit("setting_proxy", { env: env.serial, mode: "pool-tag", proxyId: pid });
            const pr = await adsStep(() => ads.bindProxyId(env.serial, pid));
            emit(pr.ok ? "proxy_set" : "proxy_set_failed", pr);
          } else {
            // 整个代理池随机绑一条住宅。
            emit("setting_proxy", { env: env.serial, mode: "pool" });
            const pr = await adsStep(() => ads.bindRandomProxy(env.serial));
            emit(pr.ok ? "proxy_set" : "proxy_set_failed", pr);
          }
        } else {
          // 未勾选动态住宅：清除环境已有代理，保证直连无代理。
          emit("clearing_proxy", { env: env.serial });
          const pr = await adsStep(() => ads.setProxy(env.serial, { proxy_soft: "no_proxy" }));
          emit(pr.ok ? "proxy_cleared" : "proxy_clear_failed", pr);
        }
        await step(() => sleep(500));
      }

      // 开窗口前：确保关闭（让随机指纹生效）+ 随机指纹。
      if (job.randomFp) {
        try { await adsStep(() => ads.stop(env.serial)); } catch (_) { /* cancellation is checked by next step */ }
        await step(() => sleep(800));
        emit("randomizing_fingerprint", { env: env.serial });
        const fp = await adsStep(() => ads.randomizeFingerprint(env.serial));
        emit(fp.ok ? "fingerprint_randomized" : "fingerprint_failed", fp);
        await step(() => sleep(500));
      }

      emit("opening_env", { env: env.serial, clearCache: !!job.clearData });
      const opened = await step(() => track(
        () => ads.start(env.serial, { clearCache: job.clearData, background: job.background }),
        () => { env.needsStop = true; },
      ));
      windowOpened = true;
      if (!opened.cdpEndpoint) throw new Error("AdsPower 未返回调试地址");
      session = await step(() => connectSession(opened.cdpEndpoint, env, job.abortController.signal, () => job.cancelled, browser.connect, { background: job.background, onBackgroundWarning }));
    }

    // 打开后清空全部数据，保证从干净状态开始检测。
    if (job.clearData) {
      const w = await step(() => session.wipe());
      emit(w.ok ? "data_wiped_open" : "data_wipe_failed", w);
    }

    for (const actionId of job.actionIds) {
      if (job.cancelled) { emit("cancelled", {}); break; }
      const action = actions.get(actionId);
      if (!action) continue;
      activeActionId = actionId;
      emit("action_start", { action: actionId });
      // ctx 里多传一个 session：cookie-login 等动作需要用 session.setCookies/getCookies（注入/抓取 cookie）。
      // 其它动作只用 page/browser，忽略 session 即可，不影响现有行为。
      const res = await step(() => action.run(session.page, account, {
        emit,
        targets: job.targets,
        browser: session.browser,
        session,
        phoneMode: job.phoneMode,
        manualChallengePolicy: job.manualChallengePolicy,
        signal: job.abortController.signal,
        isCancelled: () => job.cancelled,
        captchaSolver: actionId === "login" || actionId === "add-2fa" ? accountCaptchaSolver : null,
        ...(actionId === "add-2fa" ? createTotpSetupContext(account, task, emit, setupSecrets, accounts, () => job.cancelled) : {}),
      }));
      if (job.cancelled) throw cancelledError();
      // need_verify 本身就代表当前账号需要人工判断；不要求每个动作都重复声明 keepOpen，
      // 统一交给独立策略决定关窗还是保留。保留时停在当前页面，不新开结果标签遮住现场。
      const needsManualAttention = res.outcome === "need_verify" || res.keepOpen === true;
      if (needsManualAttention) keepOpenRequested = true;
      if (res.handoff === true || res.outcome === "need_verify") handoffRequested = true;
      // 写回账号库
      const patch = {};
      if (res.statusPatch && Object.keys(res.statusPatch).length) patch.status = res.statusPatch;
      Object.assign(patch, res.fieldPatch || {});
      if (Object.keys(patch).length) { accounts.update(account.id, patch); await step(() => accounts.flush()); }
      if (job.cancelled) throw cancelledError();
      task.results.push(publicActionResult({ action: actionId, outcome: res.outcome, reasonCode: res.reasonCode || "", detail: res.detail || {}, statusPatch: res.statusPatch || {}, fieldPatch: res.fieldPatch || {} }, [...setupSecrets]));
      activeActionId = null;
      emit("action_done", { action: actionId, outcome: res.outcome });

      // 登录没成功（含 2FA 密钥错误/账号停用/需人工）就别再往下做了——没登录进去，后续动作都白费。
      // res.stop 由登录动作给出；其它动作也可设 stop 来中断。
      const stop = res.stop || (actionId === "login" && res.outcome !== "ok");
      if (stop) {
        const rawReason = res.detail ? Object.values(res.detail).filter(Boolean).join("；") : "登录未通过";
        const reason = actionId === "add-2fa" ? sanitizeTotpSetupValue(rawReason, [...setupSecrets]) : rawReason;
        const idx = job.actionIds.indexOf(actionId);
        for (const skipId of job.actionIds.slice(idx + 1)) {
          task.results.push({ action: skipId, outcome: "skipped", detail: { skip: `已跳过：${reason}` }, statusPatch: {}, fieldPatch: {} });
        }
        emit("steps_skipped", { from: actionId, reason, skipped: job.actionIds.slice(idx + 1) });
        break;
      }
    }

    task.status = job.cancelled ? "cancelled" : "done";
  } catch (err) {
    const safeMessage = job.actionIds.includes("add-2fa") ? sanitizeTotpSetupValue(err.message, [...setupSecrets]) : err.message;
    const credentialActionId = job.actionIds.find((id) => id === "login" || id === "check-password")
      || (job.actionIds.includes("add-2fa") ? "login" : "");
    const hasCredentialResult = credentialActionId && task.results.some((r) => r && r.action === credentialActionId);
    const failedBeforeOrDuringCredential = activeActionId == null || activeActionId === credentialActionId || activeActionId === "add-2fa";
    if (!job.cancelled && account && credentialActionId && !hasCredentialResult && failedBeforeOrDuringCredential) {
      const failure = buildUnhandledLoginResult(new Error(safeMessage), activeActionId, credentialActionId);
      try {
        const failurePatch = { ...failure.fieldPatch };
        if (Object.keys(failure.statusPatch).length) failurePatch.status = failure.statusPatch;
        accounts.update(account.id, failurePatch);
        await step(() => accounts.flush());
        task.results.push(job.actionIds.includes("add-2fa") ? sanitizeTotpSetupValue(failure, [...setupSecrets]) : failure);
      } catch (persistErr) {
        emit("credential_failure_persist_failed", { message: persistErr.message });
      }
    }
    if (!job.cancelled && account && job.actionIds.includes("add-2fa") && !task.results.some((result) => result.action === "add-2fa")) {
      const failure = buildUnhandledTotpSetupResult(account, safeMessage);
      try {
        accounts.update(account.id, failure.fieldPatch);
        await step(() => accounts.flush());
        task.results.push(failure);
        if (failure.outcome === "need_verify") { keepOpenRequested = true; handoffRequested = true; }
      } catch (_) { emit("totp_setup_failure_persist_failed", { message: "2FA 中断结果未能保存" }); }
    }
    task.error = job.cancelled ? null : safeMessage;
    task.status = job.cancelled ? "cancelled" : "error";
    emit("error", { message: safeMessage });
  } finally {
    const keepThisTaskOpen = !job.cancelled && windowOpened
      && shouldRetainTaskWindow(job.keepOpen, keepOpenRequested, job.manualChallengePolicy);
    try {
      if (keepThisTaskOpen) {
        // 保留窗口只断连，不清数据、不关进程；保留句柄供用户之后点击关闭。
        if (session) {
          if (!handoffRequested) {
            try {
              const email = (account && account.email) || task.email;
              const summary = summarizeForLabel(task);
              const lr = await step(() => bounded(() => session.label({ email, summary }), 3500, "窗口标签设置超时"));
              emit(lr && lr.ok ? "env_labeled" : "env_label_failed", lr || {});
            } catch (err) {
              emit("env_label_failed", { error: err.message });
            }
          }
          try { await step(() => bounded(() => session.disconnect(), 1500, "浏览器断连超时")); } catch (_) { /* ignore */ }
        }
        // 保留环境不能复用，否则后续账号会关掉人工处理中的窗口。
        if (!job.cancelled) env.retained = true;
        emit("env_kept_open", { env: env.serial });
      } else if (session && job.clearData && !job.cancelled) {
        // 正常收尾允许清理数据；主动停止不等待卡住的清理/CDP 操作。
        try {
          const w = await step(() => bounded(() => session.wipe(), 3500, "浏览器清理超时"));
          emit(w.ok ? "data_wiped_close" : "data_wipe_failed", w);
        } catch (_) { /* ignore */ }
      }
    } finally {
      // 保留窗口流程中也可能收到取消，必须重新检查，不能用进入 finally 时的旧决定。
      if (job.cancelled || !keepThisTaskOpen) {
        const closed = await closeEnvironment(job, env);
        emit(closed ? "env_closed" : "env_close_failed", { env: env.serial, message: env.closeError || "" });
      }
    }
    if (job.cancelled && task.status === "running") task.status = "cancelled";
    env.busy = false;
    schedule(job);
  }
}

// 给「保留窗口」标签页用的简短动作名（比注册表里的完整说明短，适合大字展示）。
const LABEL_ACTION_NAMES = {
  "login": "登录",
  "check-password": "密码检测",
  "detect-ban": "封禁检测",
  "detect-region": "归属地",
  "detect-gpt": "GPT 授权",
  "change-language": "改语言",
  "change-2fa": "改 2FA",
  "add-2fa": "添加 2FA",
  "remove-devices": "移除设备",
  "remove-phones": "移除验证电话",
  "add-2fa-phone": "添加验证手机号",
  "gemini-check": "Gemini",
  "age-verify": "年龄验证",
  "age-verify-close": "年龄验证+关支付",
  "close-payment": "关闭支付",
  "cookie-login": "一键登录",
};

/**
 * 把本任务的检测结果汇总成给标签页展示的几行摘要：
 * 只挑「非 ok」的结论（登录失败 / 需人工 / 2FA 错 / GPT 卡 CF 等），让用户一眼看出窗口为何留着。
 */
function summarizeForLabel(task) {
  const lines = [];
  if (task && task.error) lines.push(`任务出错：${task.error}`);
  for (const r of (task && task.results) || []) {
    if (!r || r.outcome === "ok") continue;
    const name = LABEL_ACTION_NAMES[r.action] || r.action;
    const detailText = r.detail && typeof r.detail === "object"
      ? Object.values(r.detail).filter(Boolean).join("；")
      : (r.detail ? String(r.detail) : "");
    lines.push(`${name}：${detailText || r.outcome}`);
  }
  return lines;
}

function createJob({ apiKey, envSerials, accountIds, actionIds, maxConcurrent, targets, randomFp, clearData, keepOpen, background, manualChallengePolicy, proxy, mode, phoneMode, captchaSolver: captchaOptions }) {
  const selectedActionIds = actions.normalizeSelection(actionIds);
  const actionError = actions.validateSelection(selectedActionIds);
  if (actionError) throw new Error(actionError);
  const selectedPhoneMode = phoneMode === undefined ? "shared" : phoneMode;
  if (selectedPhoneMode !== "shared" && selectedPhoneMode !== "exclusive") {
    throw new Error("手机号使用模式无效：只能是 shared 或 exclusive");
  }
  const id = genId();
  const runMode = mode === "local" ? "local" : "adspower";
  const challengePolicy = normalizeManualChallengePolicy(manualChallengePolicy);
  const captchaConfig = capsolver.normalizeConfig(captchaOptions, { accountCount: accountIds.length, actionIds: selectedActionIds, proxy });
  if (challengePolicy === "solve_close" && !captchaConfig) throw new Error("自动打码模式需要启用 CAPSOLVER 并保存 API Key");
  if (captchaConfig && runMode !== "local") throw new Error("CAPSOLVER 测试版仅支持本机浏览器登录");
  if (captchaConfig) accountIds = [...new Set(accountIds)];
  const concurrent = Math.min(20, Math.max(1, Number(maxConcurrent) || 3));
  const tasks = accountIds.map((accountId) => {
    const acc = accounts.getById(accountId);
    return {
      id: `${id}-${accountId}`,
      accountId,
      email: acc ? acc.email : accountId,
      env: null,
      status: "queued",
      results: [],
      events: [],
      error: null,
    };
  });
  // 本机模式没有 AdsPower 环境序号：把「并发数」当作 N 个本地 slot，
  // 每个 slot 是一个占位 env（serial 仅作展示），跑任务时各自启动一个临时浏览器。
  const adsSerials = runMode === "local" ? [] : normalizeAdsSerials(envSerials);
  const envs = runMode === "local"
    ? Array.from({ length: concurrent }, (_, i) => ({ serial: `本地#${i + 1}`, busy: false, retained: false, local: null }))
    : adsSerials.map((serial) => ({ serial, busy: false, retained: false }));
  const job = {
    id,
    mode: runMode,
    background: background === true,
    phoneMode: selectedPhoneMode,
    apiKey,
    createdAt: new Date().toISOString(),
    actionIds: selectedActionIds,
    targets: targets || null,
    // 本机模式没有 AdsPower 指纹概念，randomFp 不适用，固定为 false。
    randomFp: runMode === "local" ? false : randomFp !== false,
    clearData: clearData !== false,
    requestedKeepOpen: !!keepOpen,
    keepOpen: challengePolicy !== "solve_close" && normalizeJobKeepOpen(selectedActionIds, keepOpen),
    manualChallengePolicy: challengePolicy,
    // proxy：AdsPower 代理池字段（enabled/tagId/proxyIds）保持原样；
    // 本机模式预留 proxy.server（规划中，透传给 --proxy-server，UI 暂未对接）。
    proxy: runMode === "local"
      ? (proxy && proxy.server ? { server: String(proxy.server) } : null)
      : (proxy && proxy.enabled ? {
        enabled: true,
        tagId: proxy.tagId ? String(proxy.tagId) : "",
        proxyIds: Array.isArray(proxy.proxyIds) ? proxy.proxyIds.map(String) : [],
      } : null),
    maxConcurrent: concurrent,
    envs,
    tasks,
    status: "running",
    abortController: new AbortController(),
  };
  if (captchaConfig) job.captchaSolver = capsolver.createSolver(captchaConfig, { signal: job.abortController.signal });
  if (runMode !== "local") reserveAdsSerials(id, adsSerials);
  jobs.set(id, job);
  try {
    schedule(job);
  } catch (err) {
    job.envs.forEach((env) => releaseAdsSerial(job, env, true));
    jobs.delete(id);
    throw err;
  }
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = {
  createJob,
  getJob,
  cancelJob,
  publicJob,
  listActions: actions.list,
  normalizeActionSelection: actions.normalizeSelection,
  validateActionSelection: actions.validateSelection,
  helpers: {
    openLocalSession,
    isFatalLocalStartupError,
    buildUnhandledLoginResult,
    buildUnhandledTotpSetupResult,
    createTotpSetupContext,
    sanitizeTotpSetupValue,
    publicActionResult,
    shouldKeepTaskOpen,
    shouldRetainTaskWindow,
    normalizeManualChallengePolicy,
    normalizeJobKeepOpen,
    isEnvReusable,
    finishQueuedWithoutReusableEnv,
    normalizeAdsSerials,
    reserveAdsSerials,
    releaseAdsSerial,
  },
};
