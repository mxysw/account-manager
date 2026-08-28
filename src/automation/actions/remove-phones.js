"use strict";

/**
 * 移除账号的「2步验证手机号(2-Step Verification phones)」和「恢复电话(Recovery phone)」。
 *
 * 背景（用户实测截图）：Google 安全设置里常残留一个手机号，既作为「2 步验证电话(语音/短信)」
 *   又作为「恢复电话(Recovery phone)」。为账号安全/交付需要，把这两处电话都移除掉。
 *
 * 设计（复用 change-2fa 已打磨好的能力，不另写一套）：
 *   - 导航到对应设置页 → 用 change-2fa.shared.handleBlockers 统一过「重新验证(/challenge/totp 等)
 *     / unknownerror / 被拒」；reauth 内部复用 login.js（用账号「现有」totpSecret 生成 TOTP 过验证）。
 *   - 稳健识别 + 移除：多语言 + 多回退选择器（Remove/Delete/移除/删除 + 图标按钮 aria-label），
 *     每步用 withTimeout/短轮询等就绪，绝不在加载中/挑战页就判「没有电话」。
 *   - 有就移除（两处都移），没有就跳过。移除「2步验证电话」若被 Google 拦（如它是唯一两步验证方式、
 *     或需其它无法自动完成的验证）→ 给清晰 detail 的失败，不死转。
 *
 * 结果写回 status.phone：
 *   none    两处都不存在（跳过）
 *   removed 检测到的电话都已成功移除
 *   failed  检测到但未能移除 / 重新验证被拒 / 需人工
 *
 * 收敛：单页移除轮次上限 + 单动作总超时，避免在设置页/挑战页/错误页之间打转。
 */

const login = require("./login");
const change2fa = require("./change-2fa");

const {
  sleep, parseLoc, visibleFirst, clickText, bodyText, withTimeout,
} = login.helpers;
// 复用 change-2fa 的「拦路页处理」（reauth / unknownerror / 被拒）与页面稳定/导航工具。
const { handleBlockers, settle, safeGoto, pageKind, flatDetail } = change2fa.shared;

// 收敛上限。
const ACTION_TIMEOUT_MS = 6 * 60 * 1000; // 整个动作总超时
const MAX_PAGE_ROUNDS = 10; // 单个设置页内「扫描→移除→重扫」轮次上限
const MAX_REMOVE_PER_PAGE = 6; // 单页最多移除几个号（防意外死循环）

// 两处电话的设置入口（英文优先 ?hl=en；带多个候选 URL 兜底 Google 改版）。
const RECOVERY_URLS = [
  "https://myaccount.google.com/signinoptions/rescuephone?hl=en",
  "https://myaccount.google.com/signinoptions/recovery/phone?hl=en",
];
const TWOSV_URLS = [
  "https://myaccount.google.com/signinoptions/two-step-verification?hl=en",
  "https://myaccount.google.com/two-step-verification?hl=en",
];

// 「2 步验证电话」页里可能需要先点进的「语音或短信」区块入口。
const VOICE_TEXT_SOURCES = [
  "Voice or text message", "Text message or voice call", "Voice or text",
  "语音或短信", "短信或语音", "文字讯息或语音通话", "語音或簡訊", "簡訊或語音通話", "簡訊或語音",
];

// 「移除/删除电话」入口按钮（文本类，多语言 + 多回退）。
const REMOVE_TEXT_SOURCES = [
  "^Remove$", "^Remove phone$", "^Remove phone number$", "^Delete$", "^Delete phone number$",
  "Remove this phone", "Delete this phone", "Remove backup phone", "Remove recovery phone",
  "^移除$", "^删除$", "^刪除$", "移除电话", "删除电话", "移除电话号码", "删除电话号码",
  "移除此电话", "移除號碼", "刪除電話", "移除電話", "刪除號碼",
];
// 二次确认弹窗按钮。
const CONFIRM_TEXT_SOURCES = [
  "^Remove$", "^Remove phone$", "^Delete$", "^Delete phone number$", "^OK$", "^Confirm$", "^Yes$", "^Done$",
  "^移除$", "^删除$", "^刪除$", "^确定$", "^确认$", "^確定$", "^是$", "^移除號碼$", "^移除電話$",
];

// 区块/字段文案：判断某处电话是否存在的上下文锚点。
const SECTION_RE = {
  recovery: /Recovery phone|recovery phone number|恢复电话|復原電話|備援電話|備用電話|救援电话/i,
  twosv: /2-Step Verification phones?|two-step verification phones?|Voice or text message|2\s*步验证电话|两步验证电话|兩步驗證電話|语音或短信|簡訊或語音/i,
};

// 给 goto 套超时（safeGoto 复用自 change-2fa，签名 safeGoto(page, url)）。
async function gotoFirst(page, urls) {
  await safeGoto(page, urls[0]);
  await settle(page);
}

// 在页面里扫描：删除控件数量、是否出现电话号码、是否空态、可点进的「语音/短信」区块。
// 返回 { controlCount, hasNumber, emptyState, hasVoiceSection, sample }。
async function scanPhones(page) {
  return withTimeout(page.evaluate((removeSrc, voiceSrc) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const body = document.body ? document.body.innerText : "";
    const voiceRe = new RegExp(voiceSrc, "i");
    // 空态文案（多语言）：说明这里本来就没有电话。
    const EMPTY = /No (recovery |2-step |backup )?phone( numbers?)?( added)?|You (don'?t|do not) have a (recovery )?phone|Add (a )?(recovery )?phone( number)?|没有(设置)?(恢复|备用|两步验证)?电话|尚未(设置|添加)(电话|号码)|未设置(恢复)?电话|添加电话号码|沒有(設定)?(復原|備援)?電話|新增電話號碼/i;
    // 删除控件：按钮/角色按钮/链接，其 aria-label/title/文本命中「移除/删除」。
    const removeTextRe = /^\s*(remove|delete|移除|删除|刪除)(\s*(phone|number|电话|號碼|号码|電話))?\s*$/i;
    let controlCount = 0;
    for (const n of document.querySelectorAll("button, [role='button'], a, div[jsaction]")) {
      const attr = `${n.getAttribute("aria-label") || ""} ${n.getAttribute("title") || ""}`;
      const txt = norm(n.textContent);
      const hitAttr = /(remove|delete|移除|删除|刪除)/i.test(attr) && /(phone|电话|號碼|号码|電話|number)/i.test(attr);
      if (hitAttr || removeTextRe.test(txt)) controlCount += 1;
    }
    // 电话号码样式：连续数字（可含空格/圆点/星号做掩码），或掩码尾号「•• •• 85」。
    const hasNumber = /(?:\+?\d[\d •·*\u2022()-]{4,}\d)|(?:[•\u2022*]{2,}\s*\d{2,})/.test(body);
    const hasVoiceSection = voiceRe.test(body);
    return {
      controlCount,
      hasNumber,
      emptyState: EMPTY.test(body) && !hasNumber,
      hasVoiceSection,
      sample: norm(body).slice(0, 240),
    };
  }, REMOVE_TEXT_SOURCES.join("|"), VOICE_TEXT_SOURCES.join("|")), 6000, {
    controlCount: 0, hasNumber: false, emptyState: false, hasVoiceSection: false, sample: "",
  });
}

// 判定这一页是否「确实存在待移除的电话」。
function phonePresent(info) {
  if (info.controlCount > 0) return true; // 有明确的「移除电话」控件
  return info.hasNumber && !info.emptyState; // 或出现电话号码且非空态
}

// 确保停在目标设置页并过掉拦路页；返回 { ok:true } 或 { terminal:true, result }。
async function ensureOnPage(page, account, ctx, emit, counters, urls, deadline) {
  for (let i = 0; i < 8; i += 1) {
    if (Date.now() > deadline) return { terminal: true, result: { outcome: "error", detail: {} } };
    const kind = pageKind(page.url());
    if (kind === "settings") return { ok: true };
    const blocked = await handleBlockers(page, account, ctx, emit, counters);
    if (blocked.terminal) return { terminal: true, result: blocked.result };
    if (blocked.handled) {
      await settle(page, 4000);
      if (pageKind(page.url()) === "settings") return { ok: true };
      await gotoFirst(page, urls);
      continue;
    }
    // 非设置页也非拦路页（加载中/未知）→ 重新导航。
    await gotoFirst(page, urls);
  }
  return { ok: true }; // 交给调用方按扫描结果判定（不强行报错）
}

// 尝试移除当前页上的一个电话：点删除控件 → 二次确认 → 过 reauth。
// 返回 { removed:bool } 或 { terminal:true, result }。
async function removeOne(page, account, ctx, emit, counters, cfg, deadline) {
  // 2SV 页有时需先点进「语音或短信」区块才露出删除控件。
  if (cfg.key === "twosv") {
    const info0 = await scanPhones(page);
    if (info0.controlCount === 0 && info0.hasVoiceSection) {
      await withTimeout(clickText(page, VOICE_TEXT_SOURCES), 5000, false);
      await sleep(1800);
      const b = await handleBlockers(page, account, ctx, emit, counters);
      if (b.terminal) return { terminal: true, result: b.result };
      await sleep(600);
    }
  }

  // 点「移除/删除」入口（文本或图标按钮）。
  let clicked = await withTimeout(clickText(page, REMOVE_TEXT_SOURCES), 6000, false);
  if (!clicked) {
    // 图标类删除按钮（无文字）：按 aria-label/title 点。
    clicked = await clickIconRemove(page);
  }
  if (!clicked) return { removed: false };
  emit("click_remove", { key: cfg.key });
  await sleep(1500);

  // 二次确认（弹窗）。点前后都可能弹重新验证。
  const b1 = await handleBlockers(page, account, ctx, emit, counters);
  if (b1.terminal) return { terminal: true, result: b1.result };
  await withTimeout(clickText(page, CONFIRM_TEXT_SOURCES), 5000, false);
  await sleep(1800);
  const b2 = await handleBlockers(page, account, ctx, emit, counters);
  if (b2.terminal) return { terminal: true, result: b2.result };
  await sleep(1200);
  return { removed: true };
}

// 点击「图标型」删除按钮（无文字，仅 aria-label/title 标注 remove/delete + phone/number）。
async function clickIconRemove(page) {
  return withTimeout(page.evaluate(() => {
    const nodes = [...document.querySelectorAll("button, [role='button'], a")];
    const hit = nodes.find((n) => {
      const attr = `${n.getAttribute("aria-label") || ""} ${n.getAttribute("title") || ""}`;
      return /(remove|delete|移除|删除|刪除)/i.test(attr) && /(phone|电话|號碼|号码|電話|number)/i.test(attr);
    });
    if (!hit) return false;
    hit.scrollIntoView({ block: "center" });
    hit.click();
    return true;
  }), 5000, false);
}

/**
 * 处理某一处电话（recovery 或 twosv）。
 * 返回 { kind: "none"|"removed"|"failed", detail, terminal?, terminalResult? }。
 */
async function processPhone(page, account, ctx, emit, counters, cfg, deadline) {
  await gotoFirst(page, cfg.urls);
  let removed = 0;
  let sawPhone = false;

  for (let round = 0; round < MAX_PAGE_ROUNDS; round += 1) {
    if (Date.now() > deadline) {
      return { kind: sawPhone ? "failed" : "none", detail: `${cfg.label}处理超时`, removed };
    }

    const nav = await ensureOnPage(page, account, ctx, emit, counters, cfg.urls, deadline);
    if (nav.terminal) return { kind: "failed", terminal: true, terminalResult: nav.result, removed };

    const info = await scanPhones(page);
    if (!phonePresent(info)) {
      // 没有（或已全部移除）。
      return removed > 0
        ? { kind: "removed", detail: `${cfg.label}已移除 ${removed} 个`, removed }
        : { kind: "none", detail: `无${cfg.label}`, removed };
    }
    sawPhone = true;

    if (removed >= MAX_REMOVE_PER_PAGE) {
      return { kind: "failed", detail: `${cfg.label}移除数超上限仍有残留`, removed };
    }

    const act = await removeOne(page, account, ctx, emit, counters, cfg, deadline);
    if (act.terminal) return { kind: "failed", terminal: true, terminalResult: act.result, removed };
    if (act.removed) {
      removed += 1;
      emit("removed_one", { key: cfg.key, removed });
      // 重新导航回该页确认是否还有残留。
      await gotoFirst(page, cfg.urls);
      continue;
    }
    // 这一轮没点到删除控件：可能仍在渲染 / 需先点进区块。等一下再试，受 round 上限收敛。
    await sleep(1500);
    if (round >= 6) {
      return { kind: "failed", detail: `${cfg.label}检测到电话但未能自动移除（页面结构可能变化）`, removed };
    }
  }
  return { kind: removed > 0 ? "removed" : "failed", detail: `${cfg.label}移除未完全收敛`, removed };
}

// 把 handleBlockers 的终态结果（detail 用 change2fa 键）改写成本动作的 phones 语义。
// 被拦（reauth 被拒/超上限/unknownerror/需其它验证）一律归 need_verify：都需人工在常用设备上处理，
// 统一交「待人工管理」而非当作程序错误。真机实测案例会命中此路径：Google 的「确认是你本人」
// 默认走「短信发到待移除的那个号(ipp/consent)」+ 密码页，复用的 login.reauth 未能切到身份验证器通过 → 归此。
function toPhoneFailure(terminalResult) {
  const d = terminalResult ? flatDetail(terminalResult.detail) : "";
  return {
    outcome: "need_verify",
    statusPatch: { phone: "failed" },
    detail: { phones: `移除电话时被「确认是你本人」拦下：${d || "重新验证未通过，需人工在常用设备上移除"}` },
  };
}

async function removePhones(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};
  const counters = { reauth: 0, unknown: 0 };
  const deadline = Date.now() + ACTION_TIMEOUT_MS;

  // 移除过程 Google 常要求重新验证；没有当前 2FA 密钥则无法自动过验证（若两处都没有电话仍可判 none）。
  emit("open_phones");

  const configs = [
    { key: "twosv", urls: TWOSV_URLS, label: "2步验证电话", section: SECTION_RE.twosv },
    { key: "recovery", urls: RECOVERY_URLS, label: "恢复电话", section: SECTION_RE.recovery },
  ];

  const results = {};
  for (const cfg of configs) {
    emit("process_phone", { key: cfg.key });
    const r = await processPhone(page, account, ctx, emit, counters, cfg, deadline);
    if (r.terminal) {
      // reauth 被拒/超上限等终态：如实标 failed 并结束（后续那处也过不了）。
      const fail = toPhoneFailure(r.terminalResult);
      const done = [];
      for (const [k, v] of Object.entries(results)) done.push(`${labelOf(k)}:${zh(v.kind)}`);
      if (done.length) fail.detail.phones += `（此前 ${done.join("、")}）`;
      emit("phones_blocked", { key: cfg.key });
      return fail;
    }
    results[cfg.key] = r;
  }

  return summarize(results);
}

function labelOf(key) {
  return key === "twosv" ? "2步验证电话" : "恢复电话";
}
function zh(kind) {
  return kind === "removed" ? "已移除" : (kind === "none" ? "无" : "失败");
}

// 汇总两处结果 → status.phone + detail + outcome。
function summarize(results) {
  const kinds = Object.values(results).map((r) => r.kind);
  const allNone = kinds.every((k) => k === "none");
  const anyFailed = kinds.some((k) => k === "failed");
  const anyRemoved = kinds.some((k) => k === "removed");

  const removedLabels = Object.entries(results).filter(([, r]) => r.kind === "removed").map(([k]) => labelOf(k));
  const noneLabels = Object.entries(results).filter(([, r]) => r.kind === "none").map(([k]) => labelOf(k));
  const failedLabels = Object.entries(results).filter(([, r]) => r.kind === "failed").map(([k]) => labelOf(k));

  if (allNone) {
    return { outcome: "ok", statusPatch: { phone: "none" }, detail: { phones: "无验证/恢复电话，跳过" } };
  }
  if (!anyFailed && anyRemoved) {
    const parts = [];
    if (removedLabels.length) parts.push(`已移除：${removedLabels.join("、")}`);
    if (noneLabels.length) parts.push(`无：${noneLabels.join("、")}`);
    return { outcome: "ok", statusPatch: { phone: "removed" }, detail: { phones: parts.join("；") } };
  }
  // 有失败：如实汇报（部分成功也标 failed，需人工处理残留）。
  const parts = [];
  if (removedLabels.length) parts.push(`已移除：${removedLabels.join("、")}`);
  if (failedLabels.length) parts.push(`未能移除：${failedLabels.join("、")}`);
  if (noneLabels.length) parts.push(`无：${noneLabels.join("、")}`);
  return {
    outcome: "need_verify",
    statusPatch: { phone: "failed" },
    detail: { phones: `${parts.join("；")}（需人工核对/移除残留）` },
  };
}

module.exports = removePhones;
// 暴露纯逻辑函数，便于脱离 puppeteer 做确定性单测。
module.exports._internals = {
  phonePresent, summarize, toPhoneFailure, labelOf, zh, SECTION_RE, REMOVE_TEXT_SOURCES, CONFIRM_TEXT_SOURCES,
};
