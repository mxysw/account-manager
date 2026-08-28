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

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    createdAt: job.createdAt,
    actionIds: job.actionIds,
    status: job.status,
    envs: job.envs.map((e) => ({ serial: e.serial, busy: e.busy })),
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

function schedule(job) {
  if (job.cancelled) {
    // 取消后：排队中的全部置为已取消，不再开新窗口。
    job.tasks.forEach((t) => { if (t.status === "queued") t.status = "cancelled"; });
    if (job.tasks.every((t) => ["done", "error", "cancelled"].includes(t.status))) job.status = "cancelled";
    return;
  }
  for (const env of job.envs) {
    if (runningCount(job) >= job.maxConcurrent) break;
    if (env.busy) continue;
    const task = job.tasks.find((t) => t.status === "queued");
    if (!task) break;
    env.busy = true;
    task.env = env.serial;
    task.status = "running";
    runTask(job, env, task);
  }
  if (job.tasks.every((t) => ["done", "error", "cancelled"].includes(t.status))) {
    job.status = job.cancelled ? "cancelled" : "done";
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
    await Promise.all(job.envs.map((e) => (e.local ? e.local.stop().catch(() => {}) : Promise.resolve())));
  } else {
    const ads = new AdsPower({ apiKey: job.apiKey });
    await Promise.all(job.envs.map((e) => ads.stop(e.serial).catch(() => {})));
  }
  return job;
}

async function runTask(job, env, task) {
  const account = accounts.getById(task.accountId);
  const emit = (type, data = {}) => task.events.push({ time: new Date().toISOString(), type, data });
  const isLocal = job.mode === "local";
  const ads = isLocal ? null : new AdsPower({ apiKey: job.apiKey });
  let session = null;
  try {
    if (!account) throw new Error("账号已不存在");

    if (isLocal) {
      // 本机临时浏览器模式：不走 AdsPower 代理池 / 随机指纹 / 环境序号，
      // 直接起一个一次性 Chrome/Edge，再用同样的 CDP 接管。
      emit("opening_local", { env: env.serial, clearData: !!job.clearData });
      // proxy 为规划中字段：若 job.proxy.server 存在则透传 --proxy-server（UI 暂未对接，留好入口）。
      const proxyServer = job.proxy && job.proxy.server ? job.proxy.server : null;
      env.local = await localBrowser.start({ clearData: job.clearData, proxy: proxyServer });
      emit("local_opened", { env: env.serial, port: env.local.port, browser: env.local.executablePath });
      session = await browser.connect(env.local.cdpEndpoint);
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
      emit("action_start", { action: actionId });
      // ctx 里多传一个 session：cookie-login 等动作需要用 session.setCookies/getCookies（注入/抓取 cookie）。
      // 其它动作只用 page/browser，忽略 session 即可，不影响现有行为。
      const res = await action.run(session.page, account, { emit, targets: job.targets, browser: session.browser, session });
      // 写回账号库
      const patch = {};
      if (res.statusPatch && Object.keys(res.statusPatch).length) patch.status = res.statusPatch;
      Object.assign(patch, res.fieldPatch || {});
      if (Object.keys(patch).length) { accounts.update(account.id, patch); accounts.flush(); }
      task.results.push({ action: actionId, outcome: res.outcome, detail: res.detail || {}, statusPatch: res.statusPatch || {}, fieldPatch: res.fieldPatch || {} });
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
    task.error = err.message;
    task.status = job.cancelled ? "cancelled" : "error";
    emit("error", { message: err.message });
  } finally {
    if (job.keepOpen) {
      // 保留窗口：只断开自动化连接，不清空、不关窗，方便人工接着看/操作。
      // 本机模式同样保留：不杀进程（临时目录也随之保留，直到用户手动关闭浏览器）。
      if (session) {
        // 断开前先挂上账号标签：在窗口里新开一个醒目标签页，标题=邮箱、正文=状态摘要，
        // 方便用户扫一眼标签栏/任务栏就把窗口和账号对上号。AdsPower / 本机模式同样生效。
        // 挂标签失败绝不能影响窗口保留：label 内部已全包 try/catch，这里再兜一层。
        try {
          const email = (account && account.email) || task.email;
          const summary = summarizeForLabel(task);
          const lr = await session.label({ email, summary });
          emit(lr && lr.ok ? "env_labeled" : "env_label_failed", lr || {});
        } catch (err) {
          emit("env_label_failed", { error: err.message });
        }
        try { await session.disconnect(); } catch (_) { /* ignore */ }
      }
      if (isLocal) env.local = null; // 放弃句柄但不杀进程
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
      } else {
        try { await ads.stop(env.serial); } catch (_) { /* ignore */ }
      }
      emit("env_closed", { env: env.serial });
    }
    env.busy = false;
    schedule(job);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 给「保留窗口」标签页用的简短动作名（比注册表里的完整说明短，适合大字展示）。
const LABEL_ACTION_NAMES = {
  "login": "登录",
  "detect-ban": "封禁检测",
  "detect-region": "归属地",
  "detect-gpt": "GPT 授权",
  "change-language": "改语言",
  "change-2fa": "改 2FA",
  "remove-devices": "移除设备",
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

function createJob({ apiKey, envSerials, accountIds, actionIds, maxConcurrent, targets, randomFp, clearData, keepOpen, proxy, mode }) {
  const id = genId();
  const runMode = mode === "local" ? "local" : "adspower";
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
  const envs = runMode === "local"
    ? Array.from({ length: concurrent }, (_, i) => ({ serial: `本地#${i + 1}`, busy: false, local: null }))
    : envSerials.map((s) => ({ serial: String(s), busy: false }));
  const job = {
    id,
    mode: runMode,
    apiKey,
    createdAt: new Date().toISOString(),
    actionIds,
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
  jobs.set(id, job);
  schedule(job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = { createJob, getJob, cancelJob, publicJob, listActions: actions.list };
