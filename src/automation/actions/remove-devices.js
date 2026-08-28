"use strict";

/**
 * 移除登录设备：把当前账号下「除当前会话/当前设备外」仍然活跃的所有已登录设备全部退掉，
 * 只保留当前登录的这一台。
 *
 * 基于 myaccount.google.com/device-activity 的实际行为：
 *   - 每个会话是一个 <a>（href 相对路径 device-activity/id/<ID>），靠 jsaction 同页跳转到详情；
 *   - 详情页有「Sign out」按钮；退出后该会话在列表里变成「Signed out」(挂 28 天，无法删除)；
 *   - 当前会话会标「Your current session」。
 *
 * 设计要点（对应用户反馈的问题）：
 *   1. 全部移除：目标 = 列表里所有「非当前 且 未显示 Signed out」的会话，不再用「带日期」之类的窄启发式漏掉设备。
 *   2. 每退一个就重查列表：每轮都重开 device-activity 重新拉取会话（退一个后旧 ElementHandle 会失效，
 *      只认稳定的 /id/<ID>），并借此捕捉 reauth 期间新生成的会话。用「每个 id 的尝试次数上限」收敛：
 *      只要某会话仍活跃(非当前、未 Signed out)且尝试次数没到上限就继续退它，直到除当前外无活跃会话或到上限/超时，
 *      绝不"尝试过就永久跳过"（那会漏掉"点了退出但没退干净/退出需 reauth 后再确认"的会话）。
 *   3. 重新验证(reauth)：退设备常触发「确认是你本人」。密码 / 身份验证器(TOTP) 沿用 login.js 的 reauth（黑盒复用）。
 *   4. 处理不了的验证只标记、不中断：出现「安全码 / 安全密钥(security key) / passkey / 无法验证您的身份」且没有可用的
 *      密码/验证器输入项时，停止"继续移除剩余设备"，把结果如实标「无法移除(需安全码)/被拒」并写回账号库；
 *      「确认是你本人」被直接拒绝(couldn't verify it's you)同样标「拒验·人工」。
 *      ★ 关键：移除设备失败【绝不 stop 整个账号的流水线】——后续 detect-gpt / gemini-check 等验证步骤照常继续跑。
 *        本动作只通过 outcome + statusPatch.device + detail 如实反映结果，永不返回 res.stop。
 *   5. 绝不退当前会话：先识别出「当前会话」；识别不到就中止，绝不盲退（避免把自己这台退掉）。
 *      点进详情后再次校验不是当前会话才点退出（双保险）。
 *   6. 超时保护：所有可能挂起的操作（goto / reauth / 读正文）都套 Promise.race 超时；整个动作有总超时上限。
 */

const login = require("./login");
const { sleep, parseLoc, clickText, bodyText, visibleFirst } = login.helpers;

const DEV_URL = "https://myaccount.google.com/device-activity?hl=en";
const CURRENT_RE = /current session|当前会话|目前的工作阶段|這個工作階段|this device|您的当前会话|您的當前工作階段/i;
// 「已退出/已登出」状态（多语言 + 多回退）：会话已不再是活动登录。
// 覆盖：Signed out / You're signed out / 已退出账号 / 已退出 / 已注销 / 已登出 / サインアウト / 로그아웃 / 已登出帳戶…
const SIGNEDOUT_RE = /signed out|you'?re signed out|signed-out|已退出|已登出|已注销|已註銷|已登出帳[戶户]|登出账[户號号]|サインアウト|로그아웃/i;
// 「已退出」会话特有的灰色减号圆圈图标的 SVG path 片段（语言无关的兜底信号，
// 当状态文案因懒加载/本地化未出现在 <a> 文本里时，靠图标也能认出已退出）。当前会话用的是对勾圆圈图标，不含此片段。
const SIGNEDOUT_ICON_RE = /7v-2h10v2z/;
// 「确认是你本人」被直接拒绝 → 环境/IP 不被信任，无法自动完成，需人工。
const REJECT_RE = /we couldn'?t verify it'?s you|couldn'?t verify it'?s you|无法验证是你本人|未能验证是您本人/i;
// 处理不了的验证方式：安全码 / 安全密钥 / 通行密钥(passkey) / 「无法验证您的身份」。
const SECKEY_RE = /security key|安全密钥|安全码|passkey|通行密钥|insert your security key|use your security key|tap your security key|use your phone or security key/i;
const CANT_VERIFY_RE = /can'?t verify it'?s you|can'?t verify your identity|couldn'?t verify your identity|无法验证您的身份|无法验证你的身份|无法验证您身份|无法核实您的身份/i;
// 「换一种方式」入口（存在时交给 reauth 去尝试切到验证器，不算无法处理）。
const TRY_ANOTHER_RE = /try another way|try a different way|试试其他方式|换一种方式|其他验证方式|別の方法|다른 방법|otra forma|choose another way/i;
// 验证器/获取验证码入口（存在时说明这页有可自动处理的 2FA 通道，不算无法处理）。
const AUTHN_RE = /authenticator|身份验证器|验证码应用|google authenticator|get a (verification|security) code|获取验证码|enter.*code/i;

// 重新验证时可用的输入框（用于判断这页能不能自动处理）。
const PWD_SEL = ["input[type='password']", "input[name='Passwd']"];
const TOTP_SEL = [
  "input[name='totpPin']",
  "input[name='idvPin']",
  "input[type='tel']",
  "input[aria-label*='code' i]",
  "input[aria-label*='验证码']",
];

// 整个动作的总超时上限：再怎么样也不能无限挂着。
const ACTION_TIMEOUT_MS = 7 * 60 * 1000;

// 给任意 promise 套超时；超时返回 fallback（绝不抛、绝不挂）。
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    guard,
  ]).then((v) => { if (timer) clearTimeout(timer); return v; });
}

async function safeGoto(page) {
  await withTimeout(
    page.goto(DEV_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    65000,
    null,
  );
}

async function hasVisible(page, selectors) {
  const h = await withTimeout(visibleFirst(page, selectors), 4000, null);
  if (!h) return false;
  await h.dispose().catch(() => {});
  return true;
}

/**
 * 纯函数：在「已经尝试过 login.reauth」之后，根据 reauth 结果 + 当前页面文案/URL + 是否有密码/验证器输入框，
 * 判定这次重新验证属于哪种结局。绝不在 reauth 之前调用（那会把「正常的确认是你本人/选择验证方式页」误判为 seckey）。
 *   - ok        reauth 已通过
 *   - rejected  Google 明确拒绝/账号停用（终态，需人工）
 *   - seckey    reauth 没过，且当前页确实只剩安全码/安全密钥/passkey：无密码、无验证器输入框、无「换一种方式」、无验证器入口
 *   - rejected（兜底） 其它收尾失败（停在某页跳不过），仍需停止避免死循环，归「需人工」
 */
function classifyReauthResult(outcome, detail, text, url, hasPwd, hasTotp) {
  if (outcome === "ok") return { kind: "ok" };
  const d = detail || "";
  // 1) Google 明确拒绝「确认是你本人」/账号停用（终态）→ 拒验·人工。
  //    注意：只认「明确拒绝」的字样（couldn't verify it's you / 拒绝验证 / 停用 / signin/rejected），
  //    绝不把「需要你验证」的正常中间页（确认是你本人 / 验证您的身份）当成被拒。
  if (REJECT_RE.test(`${d}\n${text}`) || /\/signin\/rejected|\/disabled\b|deniedsigninrejected/i.test(url) || /拒绝验证|已被停用|封禁|账号已被停用/i.test(d)) {
    return { kind: "rejected", detail: d || "Google 拒绝验证「确认是你本人」（环境/IP 不被信任），需人工" };
  }
  // 2) reauth 跑完仍没过，且当前页确实只剩处理不了的方式（安全码/安全密钥/passkey/无法验证身份），
  //    且没有任何密码/验证器输入框、没有「换一种方式」、没有验证器入口 → seckey。
  const hay = `${text}\n${url}`;
  const unhandleable = (SECKEY_RE.test(hay) || CANT_VERIFY_RE.test(hay))
    && !TRY_ANOTHER_RE.test(text)
    && !AUTHN_RE.test(text)
    && !hasPwd && !hasTotp;
  if (unhandleable) return { kind: "seckey", detail: unhandleableReason(text, url) };
  // 3) 其它收尾失败：仍需停止避免死循环，归「需人工」。
  return { kind: "rejected", detail: d || "重新验证未通过，需人工处理" };
}

function unhandleableReason(text, url) {
  const hay = `${text}\n${url}`;
  if (SECKEY_RE.test(hay)) return "需要安全码/安全密钥/通行密钥验证";
  if (CANT_VERIFY_RE.test(hay)) return "Google 提示「无法验证您的身份」";
  return "出现无法自动完成的验证";
}

// 当前页面属于哪种状态：列表 / 重新验证 / 被直接拒绝 / 其它。
function pageKind(url, text) {
  const { host, path } = parseLoc(url);
  if (/\/signin\/rejected/i.test(path) || (text && REJECT_RE.test(text))) return "rejected";
  if (host === "accounts.google.com" || /\/challenge\//i.test(path) || /\/signin\//i.test(path)) return "reauth";
  if (/device-activity/i.test(path)) return "list";
  return "other";
}

/**
 * 处理「重新验证」页。
 *
 * 关键修复（消除假阳性）：正常的「确认是你本人 / 验证您的身份 / To help keep your account safe…」reauth 页
 * （包括会列出「安全密钥/通行密钥」等选项的"选择验证方式"页）必须**先真正驱动 login.reauth**（密码/TOTP）走完，
 * 绝不能在 reauth 之前凭页面里出现 "security key / passkey / 验证身份" 字样就提前判 seckey/rejected——
 * 那正是把可正常处理的账号误判为「拒验」的根因。
 * 只有在 reauth 已经跑完且**确实没过**、且当前页只剩处理不了的方式时，才判 seckey/rejected。
 * 返回 { kind: "ok" | "seckey" | "rejected", detail }
 */
async function handleReauth(page, account, ctx) {
  // 先把密码/2FA reauth 跑完（login.js 黑盒：会处理选择验证方式页→点身份验证器→填 TOTP/密码）。
  const r = await withTimeout(
    login.reauth(page, account, ctx),
    150000,
    { outcome: "error", detail: { reauth: "重新验证超时（150s）" } },
  );
  if (r.outcome === "ok") return { kind: "ok" };

  // 走到这里说明 reauth 没过，再据「最终页面状态 + 是否还有密码/验证器入口」精确归类。
  const d = r.detail ? Object.values(r.detail).filter(Boolean).join("；") : "";
  const text = await withTimeout(bodyText(page), 8000, "");
  const url = page.url();
  const hasPwd = await hasVisible(page, PWD_SEL);
  const hasTotp = await hasVisible(page, TOTP_SEL);
  return classifyReauthResult(r.outcome, d, text, url, hasPwd, hasTotp);
}

/**
 * 确保停在设备列表页：打开 device-activity；若被重定向去验证，处理之。
 * 返回 { kind: "ok" } 或 { kind: "seckey"|"rejected", detail }（上层据此停止）。
 */
async function ensureOnList(page, account, ctx) {
  await safeGoto(page);
  await sleep(2000);
  let text = await withTimeout(bodyText(page), 6000, "");
  let kind = pageKind(page.url(), text);
  if (kind === "rejected") return { kind: "rejected", detail: "Google 拒绝验证「确认是你本人」（环境/IP 不被信任）" };
  if (kind === "reauth") {
    const rr = await handleReauth(page, account, ctx);
    if (rr.kind !== "ok") return rr;
    await sleep(1500);
    if (!/device-activity/i.test(page.url())) {
      await safeGoto(page);
      await sleep(2000);
    }
    text = await withTimeout(bodyText(page), 6000, "");
    kind = pageKind(page.url(), text);
    if (kind === "rejected") return { kind: "rejected", detail: "重新验证后仍被拒" };
  }
  return { kind: "ok" };
}

// 读会话列表：[{id, current, signedOut, label}]，用稳定 /id/<ID> 去重。
// signedOut 双信号：①状态文案（多语言正则）②已退出会话特有的灰色减号图标 SVG path（语言无关兜底），
// 任一命中即视为「已退出」——避免某些渲染/本地化下文案缺失时把已退出会话误判为活动会话而继续尝试退出（触发不必要的 reauth）。
async function readSessions(page) {
  return withTimeout(page.evaluate((curSrc, soSrc, soIconSrc) => {
    const curRe = new RegExp(curSrc, "i");
    const soRe = new RegExp(soSrc, "i");
    const soIconRe = new RegExp(soIconSrc);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll("a[href*='device-activity/id/']")) {
      const m = a.href.match(/\/id\/([^/?#]+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const label = (a.textContent || "").replace(/\s+/g, " ").trim();
      const html = a.innerHTML || "";
      out.push({
        id: m[1],
        current: curRe.test(label),
        signedOut: soRe.test(label) || soIconRe.test(html),
        label: label.slice(0, 70),
      });
    }
    return out;
  }, CURRENT_RE.source, SIGNEDOUT_RE.source, SIGNEDOUT_ICON_RE.source), 8000, []);
}

// 等列表渲染出来（有会话即可）。
async function readSessionsStable(page, totalMs = 20000) {
  const deadline = Date.now() + totalMs;
  let s = await readSessions(page);
  while (Date.now() < deadline && !s.length) {
    await sleep(2000);
    s = await readSessions(page);
  }
  return s;
}

// 在列表里点击指定 id 的会话 <a>（同页跳转，不触发重新验证）。
async function clickSession(page, id) {
  return withTimeout(page.evaluate((sid) => {
    const a = [...document.querySelectorAll("a[href*='device-activity/id/']")].find((x) => x.href.includes("/id/" + sid));
    if (!a) return false;
    a.scrollIntoView({ block: "center" });
    a.click();
    return true;
  }, id), 6000, false);
}

// 退出后等结果：reauth 页 / 被拒 / 已退出 / 回到列表 / 超时。
async function waitSignOutOutcome(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const { path } = parseLoc(url);
    if (/\/signin\/rejected/i.test(path)) return { kind: "rejected" };
    const text = await withTimeout(bodyText(page), 5000, "");
    const kind = pageKind(url, text);
    if (kind === "rejected") return { kind: "rejected" };
    if (kind === "reauth") return { kind: "reauth" };
    if (SIGNEDOUT_RE.test(text)) return { kind: "done" };
    await sleep(1000);
  }
  return { kind: "timeout" };
}

// 目标：非当前、且未退过的活跃会话。
function isTarget(s) {
  return !s.current && !s.signedOut;
}

// 统计：尝试过的 id 里已变成「已退出/已不在列表」的算成功移除。attemptedIds 可为 Set/数组/Map.keys()。
function countRemoved(sessions, attemptedIds) {
  let n = 0;
  for (const id of attemptedIds) {
    const s = sessions.find((x) => x.id === id);
    if (!s || s.signedOut) n += 1;
  }
  return n;
}

// 组装「无法移除」结果：只如实标记状态，绝不 stop（移除设备失败不应中断该账号后续动作，
// 后面的 detect-gpt / gemini-check 等验证步骤照常继续跑）。
// 仅在「确实仍有活动(非当前、未退出)会话退不掉」时才调用——此处只负责把 rejected/seckey 语义如实组装出来。
// remaining 为仍活跃的其它会话数（已知时写进 detail，说清"还有 N 个活动会话无法自动退出"）。
function blockedResult(info, removed, remaining) {
  const prefix = removed > 0 ? `已退出 ${removed} 台，` : "";
  const left = typeof remaining === "number" && remaining > 0 ? `仍有 ${remaining} 个活动会话无法自动退出，` : "仍有设备无法自动退出，";
  if (info.kind === "seckey") {
    return {
      outcome: "need_verify",
      statusPatch: { device: "seckey" },
      detail: { devices: `${prefix}${left}遇到无法自动完成的验证（安全码/安全密钥/无法验证身份），需人工处理${info.detail ? `：${info.detail}` : ""}` },
    };
  }
  return {
    outcome: "need_verify",
    statusPatch: { device: "rejected" },
    detail: { devices: `${prefix}${left}重新验证被拒（Google 不信任当前环境/IP，「确认是你本人」未通过），需人工处理${info.detail ? `：${info.detail}` : ""}` },
  };
}

async function removeDevices(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const actionDeadline = Date.now() + ACTION_TIMEOUT_MS;

  emit("open_devices");
  const nav = await ensureOnList(page, account, ctx);
  if (nav.kind !== "ok") return blockedResult(nav, 0);

  const first = await readSessionsStable(page);
  if (!first.length) {
    return { outcome: "error", detail: { devices: `没读到任何会话，停在：${page.url().slice(0, 80)}` } };
  }
  // 安全：必须先识别出「当前会话」，否则无法保证不会退掉自己 → 中止，不盲退。
  if (!first.some((s) => s.current)) {
    await sleep(2500);
    const retry = await readSessions(page);
    if (!retry.some((s) => s.current)) {
      return {
        outcome: "error",
        statusPatch: { device: "rejected" },
        detail: { devices: "未能识别「当前会话」，为避免误退掉当前设备已中止（需人工核对）" },
      };
    }
  }
  const initialTargets = first.filter(isTarget).length;
  emit("sessions_found", { total: first.length, toRemove: initialTargets });

  // 关键收敛设计：
  //  - 不用「尝试过就永久拉黑」的 Set（那会把"点了退出但没退干净/退出需 reauth 后再次确认"的会话漏掉，
  //    正是这次只剩 1 条活跃会话没退的根因）；
  //  - 改用「每个 id 的尝试次数」上限：只要某会话仍是活跃(非当前、未 Signed out)且尝试次数没到上限，就继续退它；
  //  - 每轮都重开列表重新拉取：既因旧句柄失效，也为了**捕捉 reauth 期间新生成的会话**（带 New 徽章的新会话）；
  //  - 循环只在「除当前外已无活跃会话」或「剩下的都已达尝试上限」或超时/上限时才结束 → 收尾必为"只剩当前"或如实"仍剩 N"。
  const attempts = new Map();
  // 本次运行内已确认「不再活跃(已退出/已不在活动列表)」的会话 id。
  // 它是判定成功的关键：即使收尾时被重新验证挡住、无法重读列表，也能据此知道"那台到底退没退掉"，
  // 从而不把"其实已经退掉、只是再开页时被 Google 要 reauth 拦了"的情况误报成 rejected。
  const confirmedSignedOut = new Set();
  const MAX_ATTEMPTS = 3; // 每个会话最多尝试 3 次（覆盖"退出需 reauth、reauth 后需再次确认退出"的情况）
  const MAX_ROUNDS = Math.min(200, (initialTargets + 20) * MAX_ATTEMPTS);
  let blockInfo = null; // 记录"无法继续自动移除"的原因（被拒/安全码），仅用于如实标记，不会 stop 流水线
  let lastSessions = first; // 最近一次成功读到的会话列表（收尾失联时用它 + confirmedSignedOut 兜底估算剩余活跃数）

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (Date.now() > actionDeadline) { emit("devices_timeout", {}); break; }

    // 每轮都重开 device-activity 重新拉取（旧句柄失效 + 捕捉 reauth 期间新生成的活跃会话）。
    const nav2 = await ensureOnList(page, account, ctx);
    if (nav2.kind !== "ok") { blockInfo = nav2; break; }
    const sessions = await readSessionsStable(page);
    if (!sessions.length) break;
    if (!sessions.some((s) => s.current)) break; // 安全：识别不到当前会话就停手
    lastSessions = sessions;

    // 同步确认：尝试过的会话只要在最新列表里已变「已退出」或已消失，就记为已确认退出。
    for (const id of attempts.keys()) {
      const s = sessions.find((x) => x.id === id);
      if (!s || s.signedOut) confirmedSignedOut.add(id);
    }

    // 选一个：活跃(非当前、未 Signed out)且尝试次数未达上限的会话。
    const target = sessions.find((s) => isTarget(s) && (attempts.get(s.id) || 0) < MAX_ATTEMPTS);
    if (!target) break; // 收敛：除当前外已无可退的活跃会话（或剩下的都已达尝试上限）。
    attempts.set(target.id, (attempts.get(target.id) || 0) + 1);

    emit("sign_out_session", { label: target.label, attempt: attempts.get(target.id) });
    if (!(await clickSession(page, target.id))) continue;
    await sleep(2500); // 等详情页同页加载

    // 双保险：详情页若是当前会话，绝不退。
    const detailText = await withTimeout(bodyText(page), 6000, "");
    if (CURRENT_RE.test(detailText)) { emit("skip_current", { label: target.label }); continue; }

    // 点「退出」+ 二次确认。
    await withTimeout(clickText(page, ["^Sign out$", "^退出$", "^登出$", "^登出帳戶$", "^Sign out\\??$"]), 6000, false);
    await sleep(1500);
    await withTimeout(clickText(page, ["^Sign out$", "^退出$", "^登出$", "^Remove$", "^Confirm$", "^确定$", "^确认$"]), 6000, false);

    const oc = await waitSignOutOutcome(page, 25000);
    if (oc.kind === "reauth") {
      const rr = await handleReauth(page, account, ctx);
      if (rr.kind !== "ok") { blockInfo = rr; break; }
      emit("reauth_passed", {});
      // reauth 通过后该会话可能需要再次确认退出：不在此假定已退，靠下一轮重查列表 + 重试（attempts 未达上限）兜底。
    } else if (oc.kind === "rejected") {
      blockInfo = { kind: "rejected", detail: "退出设备时 Google 拒绝「确认是你本人」" };
      break;
    } else {
      emit("signed_out_one", { label: target.label });
      confirmedSignedOut.add(target.id); // 看到「已退出」回执：本会话已确认退出
    }
  }

  // —— 统一成功判定：唯一标准 = 「除当前会话外，是否还有仍处于活动登录的其它会话」 ——
  // 列表里残留的「已退出」记录条目（Google 会保留 28 天）不算未清干净，不影响判定。
  const remaining = await remainingActiveSessions(page, account, ctx, { blockInfo, lastSessions, confirmedSignedOut });
  const removed = confirmedSignedOut.size;
  emit("devices_done", { removed, remaining });

  // 已无活动的其它会话 → 已清（即使被 reauth 挡住无法重读列表，只要能据已确认退出推断出"已无活动会话"也判已清，
  // 消除"其它会话其实早已退出、却因再开页要 reauth 被拒而误报 rejected"的假阳性）。
  if (remaining <= 0) {
    return {
      outcome: "ok",
      statusPatch: { device: "cleaned" },
      detail: { devices: removed > 0 ? `已退出 ${removed} 台，除当前会话外已无活动会话` : "除当前会话外已无活动会话" },
    };
  }

  // 确实仍有活动的其它会话没能退出：据 blockInfo 区分 rejected/seckey（保持原语义），否则归 rejected（到尝试上限/超时）。
  if (blockInfo) {
    emit("devices_blocked", { kind: blockInfo.kind, removed });
    return blockedResult(blockInfo, removed, remaining);
  }
  return {
    outcome: "need_verify",
    statusPatch: { device: "rejected" },
    detail: { devices: `已退出 ${removed} 台，仍有 ${remaining} 个活动会话未能退出（需人工处理）` },
  };
}

/**
 * 计算「除当前会话外仍处于活动登录」的其它会话数（成功判定的唯一依据）。
 *   - 优先：重开列表重读，数仍活跃(非当前、未退出)的会话 —— 真实、准确。
 *   - 兜底：当已知被重新验证挡住(blockInfo)或重读失败时，重读多半会再次触发同样的拦截，
 *     于是改用「最近一次成功读到的列表」扣掉本次已确认退出的会话来估算，避免再白等一次 reauth，
 *     也避免把"其实已退掉、只是再开页被要 reauth"误判为仍有活动会话。
 */
async function remainingActiveSessions(page, account, ctx, { blockInfo, lastSessions, confirmedSignedOut }) {
  const estimateFromLast = () => (lastSessions || [])
    .filter((s) => isTarget(s) && !confirmedSignedOut.has(s.id)).length;

  // 已知被拦：不再重开页（会再触发一次同样的 reauth 拦截），直接用最近成功列表估算。
  if (blockInfo) return estimateFromLast();

  const tally = await ensureOnList(page, account, ctx);
  if (tally.kind === "ok") {
    const finalSessions = await readSessionsStable(page);
    if (finalSessions.length && finalSessions.some((s) => s.current)) {
      return finalSessions.filter(isTarget).length;
    }
  }
  // 收尾重读失败（被重新验证挡住/读不到当前会话）：用最近成功列表 + 已确认退出兜底估算。
  return estimateFromLast();
}

module.exports = removeDevices;
// 暴露纯逻辑函数，便于脱离 puppeteer 做确定性单测。
module.exports._internals = {
  CURRENT_RE, SIGNEDOUT_RE, SIGNEDOUT_ICON_RE, REJECT_RE, SECKEY_RE, CANT_VERIFY_RE, TRY_ANOTHER_RE, AUTHN_RE,
  pageKind, isTarget, countRemoved, blockedResult, classifyReauthResult, handleReauth, remainingActiveSessions,
};
