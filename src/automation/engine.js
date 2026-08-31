"use strict";

const { AdsPower } = require("./adspower");
const browser = require("./browser");
const localBrowser = require("./local-browser");
const actions = require("./actions");
const accounts = require("../accounts");

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

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    phoneMode: job.phoneMode,
    createdAt: job.createdAt,
    actionIds: job.actionIds,
    status: job.status,
    envs: job.envs.map((e) => ({ serial: e.serial, busy: e.busy, retained: !!e.retained })),
    tasks: job.tasks.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      email: t.email,
      env: t.env,
      status: t.status,
      results: t.results,
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
  if (!force && env.retained) return false;
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
    if (job.tasks.every((t) => ["done", "error", "cancelled"].includes(t.status))) job.status = "cancelled";
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
  if (job.tasks.every((t) => ["done", "error", "cancelled"].includes(t.status))) {
    job.status = job.cancelled ? "cancelled" : "done";
    releaseFinishedAdsSerials(job);
  }
}

/** 停止任务：不再开新窗口，正在跑的做完当前动作后收尾，并关闭该任务所有环境窗口。 */
async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.cancelled = true;
  job.tasks.forEach((t) => { if (t.status === "queued") t.status = "cancelled"; });
  if (!job.tasks.some((t) => t.status === "running")) job.status = "cancelled";
  // 关闭所有相关窗口。
  if (job.mode === "local") {
    // 本机模式：杀掉每个 slot 正在运行的临时浏览器进程（runTask 会把句柄挂在 env.local 上）。
    await Promise.all(job.envs.map(async (e) => {
      if (e.local) await e.local.stop().catch(() => {});
      e.local = null;
      e.retained = false;
    }));
  } else {
    const ads = new AdsPower({ apiKey: job.apiKey });
    await Promise.all(job.envs.map(async (e) => {
      try {
        await ads.stop(e.serial);
        e.retained = false;
        releaseAdsSerial(job, e, true);
      } catch (_) { /* 关闭失败时保留占用，避免新任务误关仍在运行的窗口 */ }
    }));
  }
  return job;
}

function shouldKeepTaskOpen(jobKeepOpen, actionRequested) {
  return !!(jobKeepOpen || actionRequested);
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
      launched = await startLocal({ clearData: options.clearData, proxy: options.proxy });
      env.local = launched;
      emit("local_opened", {
        env: env.serial,
        port: launched.port,
        browser: launched.executablePath,
        attempt: launchAttempt,
      });

      for (let connectAttempt = 1; connectAttempt <= connectAttempts; connectAttempt += 1) {
        try {
          if (isCancelled()) throw new Error("任务已取消");
          const session = await connectBrowser(launched.cdpEndpoint);
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
          await wait(delayMs);
        }
      }
    } catch (err) {
      lastError = err;
    }

    if (launched) {
      try { await launched.stop(); } catch (_) { /* ignore */ }
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
    await wait(delayMs);
  }

  const reason = lastError && lastError.message ? lastError.message : "未知错误";
  throw new Error(`本机浏览器启动/接管失败（已自动重试）：${reason}`);
}

async function runTask(job, env, task) {
  const account = accounts.getById(task.accountId);
  const emit = (type, data = {}) => task.events.push({ time: new Date().toISOString(), type, data });
  const isLocal = job.mode === "local";
  const ads = isLocal ? null : new AdsPower({ apiKey: job.apiKey });
  let session = null;
  let activeActionId = null;
  let keepOpenRequested = false;
  let handoffRequested = false;
  let windowOpened = false;
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
        proxy: proxyServer,
        isCancelled: () => job.cancelled,
      });
      env.local = opened.local;
      session = opened.session;
      windowOpened = true;
    } else {
      // 开窗口前处理代理（需先关窗，改动才能在重开后生效）：
      //  - 勾选：从代理池绑一条住宅（每开一个号换一个新住宅 IP）
      //  - 未勾选：把环境已有代理清成无代理（直连）
      {
        try { await ads.stop(env.serial); } catch (_) { /* ignore */ }
        await sleep(500);
        if (job.proxy && job.proxy.enabled) {
          if (Array.isArray(job.proxy.proxyIds) && job.proxy.proxyIds.length) {
            // 按标签筛过的代理池：从该标签里随机挑一条绑上。
            const pid = job.proxy.proxyIds[Math.floor(Math.random() * job.proxy.proxyIds.length)];
            emit("setting_proxy", { env: env.serial, mode: "pool-tag", proxyId: pid });
            const pr = await ads.bindProxyId(env.serial, pid);
            emit(pr.ok ? "proxy_set" : "proxy_set_failed", pr);
          } else {
            // 整个代理池随机绑一条住宅。
            emit("setting_proxy", { env: env.serial, mode: "pool" });
            const pr = await ads.bindRandomProxy(env.serial);
            emit(pr.ok ? "proxy_set" : "proxy_set_failed", pr);
          }
        } else {
          // 未勾选动态住宅：清除环境已有代理，保证直连无代理。
          emit("clearing_proxy", { env: env.serial });
          const pr = await ads.setProxy(env.serial, { proxy_soft: "no_proxy" });
          emit(pr.ok ? "proxy_cleared" : "proxy_clear_failed", pr);
        }
        await sleep(500);
      }

      // 开窗口前：确保关闭（让随机指纹生效）+ 随机指纹。
      if (job.randomFp) {
        try { await ads.stop(env.serial); } catch (_) { /* ignore */ }
        await sleep(800);
        emit("randomizing_fingerprint", { env: env.serial });
        const fp = await ads.randomizeFingerprint(env.serial);
        emit(fp.ok ? "fingerprint_randomized" : "fingerprint_failed", fp);
        await sleep(500);
      }

      emit("opening_env", { env: env.serial, clearCache: !!job.clearData });
      const opened = await ads.start(env.serial, { clearCache: job.clearData });
      windowOpened = true;
      if (!opened.cdpEndpoint) throw new Error("AdsPower 未返回调试地址");
      session = await browser.connect(opened.cdpEndpoint);
    }

    // 打开后清空全部数据，保证从干净状态开始检测。
    if (job.clearData) {
      const w = await session.wipe();
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
      const res = await action.run(session.page, account, {
        emit,
        targets: job.targets,
        browser: session.browser,
        session,
        phoneMode: job.phoneMode,
      });
      // 动作可为当前账号请求人工接管（例如短信验证码页）。这只保留当前任务的窗口，
      // 不会把整个批次的其它窗口都改成“保留”。handoff=true 时还需保持当前页焦点。
      if (res.keepOpen === true) keepOpenRequested = true;
      if (res.handoff === true) handoffRequested = true;
      // 写回账号库
      const patch = {};
      if (res.statusPatch && Object.keys(res.statusPatch).length) patch.status = res.statusPatch;
      Object.assign(patch, res.fieldPatch || {});
      if (Object.keys(patch).length) { accounts.update(account.id, patch); accounts.flush(); }
      task.results.push({ action: actionId, outcome: res.outcome, reasonCode: res.reasonCode || "", detail: res.detail || {}, statusPatch: res.statusPatch || {}, fieldPatch: res.fieldPatch || {} });
      activeActionId = null;
      emit("action_done", { action: actionId, outcome: res.outcome });

      // 登录没成功（含 2FA 密钥错误/账号停用/需人工）就别再往下做了——没登录进去，后续动作都白费。
      // res.stop 由登录动作给出；其它动作也可设 stop 来中断。
      const stop = res.stop || (actionId === "login" && res.outcome !== "ok");
      if (stop) {
        const reason = res.detail ? Object.values(res.detail).filter(Boolean).join("；") : "登录未通过";
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
    const credentialActionId = job.actionIds.find((id) => id === "login" || id === "check-password") || "";
    const hasCredentialResult = credentialActionId && task.results.some((r) => r && r.action === credentialActionId);
    const failedBeforeOrDuringCredential = activeActionId == null || activeActionId === credentialActionId;
    if (!job.cancelled && account && credentialActionId && !hasCredentialResult && failedBeforeOrDuringCredential) {
      const failure = buildUnhandledLoginResult(err, activeActionId, credentialActionId);
      try {
        const failurePatch = { ...failure.fieldPatch };
        if (Object.keys(failure.statusPatch).length) failurePatch.status = failure.statusPatch;
        accounts.update(account.id, failurePatch);
        accounts.flush();
        task.results.push(failure);
      } catch (persistErr) {
        emit("credential_failure_persist_failed", { message: persistErr.message });
      }
    }
    task.error = err.message;
    task.status = job.cancelled ? "cancelled" : "error";
    emit("error", { message: err.message });
  } finally {
    const keepThisTaskOpen = !job.cancelled && windowOpened
      && shouldKeepTaskOpen(job.keepOpen, keepOpenRequested);
    if (keepThisTaskOpen) {
      // 保留窗口：只断开自动化连接，不清空、不关窗，方便人工接着看/操作。
      // 本机模式同样保留：不杀进程（临时目录也随之保留，直到用户手动关闭浏览器）。
      if (session) {
        // 断开前先挂上账号标签：在窗口里新开一个醒目标签页，标题=邮箱、正文=状态摘要，
        // 方便用户扫一眼标签栏/任务栏就把窗口和账号对上号。AdsPower / 本机模式同样生效。
        // 挂标签失败绝不能影响窗口保留：label 内部已全包 try/catch，这里再兜一层。
        if (!handoffRequested) {
          try {
            const email = (account && account.email) || task.email;
            const summary = summarizeForLabel(task);
            const lr = await session.label({ email, summary });
            emit(lr && lr.ok ? "env_labeled" : "env_label_failed", lr || {});
          } catch (err) {
            emit("env_label_failed", { error: err.message });
          }
        }
        try { await session.disconnect(); } catch (_) { /* ignore */ }
      }
      // 无论本机还是 AdsPower，已保留窗口都占住当前 slot。否则本机模式会继续弹出超过
      // maxConcurrent 的窗口，AdsPower 模式则会在下一次启动前把同一 serial 直接关掉。
      env.retained = true;
      emit("env_kept_open", { env: env.serial });
    } else {
      // 关闭前：清空全部数据，再关窗口。
      if (session) {
        if (job.clearData) {
          try {
            const w = await session.wipe();
            emit(w.ok ? "data_wiped_close" : "data_wipe_failed", w);
          } catch (_) { /* ignore */ }
        }
        await session.close();
      }
      if (isLocal) {
        // 本机模式：杀掉临时浏览器进程并删除临时 user-data-dir（用完即弃）。
        if (env.local) { try { await env.local.stop(); } catch (_) { /* ignore */ } env.local = null; }
      } else if (windowOpened) {
        try { await ads.stop(env.serial); } catch (_) { /* ignore */ }
      }
      emit("env_closed", { env: env.serial });
    }
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

function createJob({ apiKey, envSerials, accountIds, actionIds, maxConcurrent, targets, randomFp, clearData, keepOpen, proxy, mode, phoneMode }) {
  const selectedActionIds = actions.normalizeSelection(actionIds);
  const actionError = actions.validateSelection(selectedActionIds);
  if (actionError) throw new Error(actionError);
  const selectedPhoneMode = phoneMode === undefined ? "shared" : phoneMode;
  if (selectedPhoneMode !== "shared" && selectedPhoneMode !== "exclusive") {
    throw new Error("手机号使用模式无效：只能是 shared 或 exclusive");
  }
  const id = genId();
  const runMode = mode === "local" ? "local" : "adspower";
  // 添加手机号会在短信验证码页交给用户逐个接管；强制单并发，避免同时弹出多个验证码窗口。
  const concurrencyCeiling = selectedActionIds.includes("add-2fa-phone") ? 1 : 20;
  const concurrent = Math.min(concurrencyCeiling, Math.max(1, Number(maxConcurrent) || 3));
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
    phoneMode: selectedPhoneMode,
    apiKey,
    createdAt: new Date().toISOString(),
    actionIds: selectedActionIds,
    targets: targets || null,
    // 本机模式没有 AdsPower 指纹概念，randomFp 不适用，固定为 false。
    randomFp: runMode === "local" ? false : randomFp !== false,
    clearData: clearData !== false,
    keepOpen: !!keepOpen,
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
  };
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
    shouldKeepTaskOpen,
    isEnvReusable,
    finishQueuedWithoutReusableEnv,
    normalizeAdsSerials,
    reserveAdsSerials,
    releaseAdsSerial,
  },
};
