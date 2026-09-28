"use strict";

const assert = require("assert");

// Fictitious credentials and deterministic snapshots only. Never opens a browser,
// contacts Google/time servers, or reads the live account database.
const FIXTURE_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const FIXTURE_CODE = "123456";
const FIXTURE_EMAIL = "add-authenticator@example.com";
const FIXTURE_LOGIN = {
  outcome: "ok",
  reasonCode: "ok",
  statusPatch: { login: "ok" },
  fieldPatch: {
    lastLoginCheck: { outcome: "ok", reasonCode: "ok", detail: "fixture login", checkedAt: "2026-01-01T00:00:00.000Z" },
  },
  detail: { login: "fixture login" },
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function account(overrides = {}) {
  return {
    id: "add-authenticator-fixture",
    email: FIXTURE_EMAIL,
    password: "fixture-password",
    recoveryEmail: "fixture-recovery@example.net",
    totpSecret: "",
    oldTotpSecret: "",
    totpChangeCount: 0,
    lastTotpSetup: null,
    pendingTotpSetup: null,
    ...overrides,
  };
}
function snapshot(overrides = {}) {
  return {
    kind: "authenticator", accountEmail: FIXTURE_EMAIL, existing: false, setup: "", manual: "", next: "",
    codeInput: "", verify: "", wizard: false, secret: null, codeRejected: false,
    saved: false, turnOn: "", enabled: false, dialog: "", confirmTurnOn: "", dismiss: "", skipPhone: "",
    activationConfirmed: false,
    ...overrides,
  };
}

function fixture(options = {}) {
  const stages = {
    settings: snapshot({ setup: "#setup" }),
    wizard: snapshot({ wizard: true, manual: "#manual" }),
    secret: snapshot({ wizard: true, secret: FIXTURE_SECRET, next: "#next" }),
    code: snapshot({ wizard: true, codeInput: "#code", verify: "#verify" }),
    saved: snapshot({ existing: true, saved: true }),
    twoStep: snapshot({ kind: "two_step", turnOn: "#turn-on" }),
    enabled: snapshot({ kind: "two_step", enabled: true }),
    ...(options.stages || {}),
  };
  const transitions = {
    "#setup": "wizard", "#manual": "secret", "#next": "code", "#verify": "saved", "#turn-on": "enabled",
    ...(options.transitions || {}),
  };
  const inputAccount = account(options.account);
  const stored = clone(inputAccount);
  const calls = [];
  const checkpoints = [];
  let stage = "settings";
  let reads = 0;
  let pauses = 0;
  const adapter = {
    login: async () => {
      calls.push(["login"]);
      return clone(options.loginResult || FIXTURE_LOGIN);
    },
    recordLoginResult: async (result) => {
      calls.push(["recordLoginResult", clone(result)]);
      Object.assign(stored, clone(result.fieldPatch || {}));
      stored.status = { ...(stored.status || {}), ...(result.statusPatch || {}) };
    },
    checkpoint: async (patch) => {
      calls.push(["checkpoint", clone(patch)]);
      if (options.failCheckpoint) await options.failCheckpoint(patch);
      checkpoints.push(clone(patch));
      Object.assign(stored, clone(patch));
    },
    open: async (url) => {
      calls.push(["open", url]);
      assert.match(String(url), /^https:\/\/myaccount\.google\.com\/(?:signinoptions\/)?two-step-verification(?:[/?]|$)/,
        "设置入口只应前往 Google 账号两步验证页面");
      assert.strictEqual(new URL(url).searchParams.get("authuser"), inputAccount.email,
        "设置页导航必须显式指定本次目标账号，不能默认使用浏览器中的第一个账号");
      stage = new URL(url).pathname.includes("/authenticator") ? "settings" : "twoStep";
    },
    read: async () => {
      reads += 1;
      assert.ok(reads <= 1000, "状态轮询必须有界，不能无限等待");
      return clone(stages[stage]);
    },
    click: async (selector) => {
      calls.push(["click", selector]);
      assert.ok(Object.prototype.hasOwnProperty.call(transitions, selector), `不得点击未在快照中授权的控件 ${selector}`);
      if (selector === "#verify") {
        assert.ok(checkpoints.some((patch) => patch.pendingTotpSetup), "提交验证码之前必须先持久化待确认密钥");
        assert.ok(!checkpoints.some((patch) => patch.totpSecret), "提交前不能将密钥当成已生效密钥");
      }
      stage = transitions[selector];
      return true;
    },
    type: async (selector, code) => {
      calls.push(["type", selector, code]);
      assert.strictEqual(stage, "code", "只在验证器向导的验证码步骤输入");
      assert.strictEqual(selector, "#code");
      assert.strictEqual(code, FIXTURE_CODE);
      return true;
    },
    code: async (secret) => {
      calls.push(["code"]);
      assert.strictEqual(secret, FIXTURE_SECRET);
      return FIXTURE_CODE;
    },
    pause: async () => {
      pauses += 1;
      assert.ok(pauses <= 1000, "等待必须有界");
    },
    emit: (event, data) => {
      assert.ok(!JSON.stringify(data || {}).includes(FIXTURE_SECRET), "事件日志不能包含密钥");
      calls.push(["emit", event]);
    },
    // The production engine persists the final result after intermediate
    // checkpoints. Model that separately from checkpoint ordering assertions.
    applyResult: (result) => {
      Object.assign(stored, clone(result.fieldPatch || {}));
      stored.status = { ...(stored.status || {}), ...(result.statusPatch || {}) };
    },
  };
  return { adapter, inputAccount, stored, calls, checkpoints };
}

function clicks(f) { return f.calls.filter((entry) => entry[0] === "click").map((entry) => entry[1]); }
function assertNoActiveKey(f) {
  assert.ok(!f.checkpoints.some((patch) => patch.totpSecret), "尚未验证成功不能保存正式密钥");
}
function assertNoReplacementMetadata(f) {
  for (const patch of f.checkpoints) {
    for (const key of ["oldTotpSecret", "totpChangeCount", "totpChangedAt"]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(patch, key), `首次添加不能写入更换记录 ${key}`);
    }
  }
}
function assertSafeDetail(result) {
  assert.ok(!JSON.stringify(result.detail || {}).includes(FIXTURE_SECRET), "结果说明不能暴露密钥");
}
function assertActivationOnly(f) {
  assert.ok(!f.calls.some((entry) => ["type", "code", "checkpoint"].includes(entry[0])),
    "待启用重试只能操作总开关，不生成/输入验证码或写入新的验证器检查点");
  assert.ok(!f.calls.some((entry) => entry[0] === "open" && new URL(entry[1]).pathname.includes("/authenticator")));
  assert.ok(clicks(f).every((selector) => selector === "#turn-on"), "不能进入设置或更换验证器");
  assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET, "已经保存的密钥保持不变");
  assertNoReplacementMetadata(f);
}

function domNode(tag = "div", text = "", attrs = {}, children = []) {
  const attributes = { ...attrs };
  const node = {
    parentElement: null, children,
    disabled: !!attrs.disabled,
    type: attrs.type || "text",
    get href() { return attributes.href || ""; },
    get innerText() {
      return [text, ...children.filter((child) => !child.getAttribute("hidden")).map((child) => child.innerText)].filter(Boolean).join(" ");
    },
    getAttribute: (name) => Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null,
    setAttribute: (name, value) => { attributes[name] = String(value); },
    removeAttribute: (name) => { delete attributes[name]; },
    getBoundingClientRect: () => ({ width: 180, height: 40 }),
    matches(selector) {
      return selector.split(",").some((part) => {
        const source = part.trim();
        const tagMatch = source.match(/^[a-z][a-z0-9-]*/i);
        if (tagMatch && tagMatch[0].toLowerCase() !== tag.toLowerCase()) return false;
        for (const attr of source.matchAll(/\[([^\]=*]+)(?:(\*?=)["']?([^\]"']*)["']?)?\]/g)) {
          const value = node.getAttribute(attr[1]);
          if (value === null) return false;
          if (attr[2] === "=" && value !== attr[3]) return false;
          if (attr[2] === "*=" && !String(value).includes(attr[3])) return false;
        }
        return true;
      });
    },
    closest(selector) {
      let current = node;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      return children.flatMap((child) => [child, ...child.querySelectorAll("*")]).filter((child) => child.matches(selector));
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
  };
  children.forEach((child) => { child.parentElement = node; });
  return node;
}

function inspectFixture(inspectDocument, body, url = "https://myaccount.google.com/two-step-verification/authenticator?hl=en") {
  const previousDocument = global.document;
  const previousStyle = global.getComputedStyle;
  global.document = {
    body, location: new URL(url),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
  };
  global.getComputedStyle = (node) => ({ display: "block", visibility: "visible", ...(node.fixtureStyle || {}) });
  try { return inspectDocument(); } finally {
    global.document = previousDocument;
    global.getComputedStyle = previousStyle;
  }
}

module.exports = async function runAdd2faTests({ checkAsync }) {
  const addTotp = require("../src/automation/actions/add-2fa");
  const { runFlow: executeFlow, inspectDocument } = addTotp.helpers;
  const runFlow = async (adapter, inputAccount) => {
    const result = await executeFlow(adapter, inputAccount);
    adapter.applyResult(result);
    return result;
  };

  await checkAsync("验证器稳健性：短暂身份缺失恢复后清除旧标记，不把状态超时报成身份异常", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    let reads = 0;
    f.adapter.read = async () => snapshot({ kind: "two_step", accountEmail: ++reads === 1 ? "" : FIXTURE_EMAIL });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.match(result.detail.add2fa, /未识别到可用的开启按钮/);
    assert.doesNotMatch(result.detail.add2fa, /身份.*(?:未|不)|账号.*不一致/);
    assert.deepStrictEqual(f.stored.lastLoginCheck, FIXTURE_LOGIN.fieldPatch.lastLoginCheck);
    assert.strictEqual(f.calls.filter(([type]) => type === "recordLoginResult").length, 1);
    assert.strictEqual(reads, 20);
    assert.deepStrictEqual(clicks(f), []);
    assertActivationOnly(f);
  });

  await checkAsync("验证器稳健性：开启后身份恢复但没有结果时仍可只读复核成功", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const open = f.adapter.open;
    const read = f.adapter.read;
    let opens = 0;
    let settling = 0;
    f.adapter.open = async (url) => { opens += 1; await open(url); };
    f.adapter.read = async () => {
      if (opens > 1) return snapshot({ kind: "two_step", enabled: true });
      if (clicks(f).includes("#turn-on")) return snapshot({ kind: "two_step", accountEmail: ++settling === 1 ? "" : FIXTURE_EMAIL });
      return read();
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(opens, 2);
    assert.deepStrictEqual(clicks(f), ["#turn-on"]);
    assertActivationOnly(f);
  });

  await checkAsync("验证器稳健性：已知确认弹窗的按钮稍后才可点时等待，不提前判失败", async () => {
    for (const [dialog, field, selector] of [
      ["confirm", "confirmTurnOn", "#confirm-turn-on"],
      ["optional_phone", "skipPhone", "#skip-phone"],
      ["success", "dismiss", "#done"],
    ]) {
      for (const afterTurnOn of [false, true]) {
        const waiting = snapshot({ kind: "two_step", dialog, [field]: selector });
        const f = fixture({
          account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
          stages: { ...(afterTurnOn ? {} : { twoStep: waiting }), delayed: waiting },
          transitions: { "#turn-on": "delayed", [selector]: "enabled" },
        });
        const read = f.adapter.read;
        let delayed = 0;
        f.adapter.read = async () => {
          const current = await read();
          return current.dialog === dialog && delayed++ < 3 ? { ...current, [field]: "" } : current;
        };
        const result = await runFlow(f.adapter, f.inputAccount);
        assert.strictEqual(result.outcome, "ok", `${dialog}, afterTurnOn=${afterTurnOn}`);
        assert.deepStrictEqual(clicks(f), [...(afterTurnOn ? ["#turn-on"] : []), selector]);
        assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
        assert.ok(!f.calls.some(([type]) => ["type", "code", "checkpoint"].includes(type)));
      }
    }
  });

  await checkAsync("验证器稳健性：已知弹窗按钮一直不可用时有界停止并记录具体弹窗", async () => {
    for (const [dialog, label] of [["confirm", "开启确认"], ["optional_phone", "可跳过的手机号建议"], ["success", "完成提示"]]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { twoStep: snapshot({ kind: "two_step", dialog }) },
      });
      let reads = 0;
      const read = f.adapter.read;
      f.adapter.read = async () => { reads += 1; return read(); };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.ok(result.detail.add2fa.includes(label));
      assert.ok(reads >= 20 && reads <= 40);
      assert.deepStrictEqual(clicks(f), []);
      assertActivationOnly(f);
    }
  });

  await checkAsync("验证器稳健性：身份在等待末尾消失时不能沿用旧页面身份或按钮", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    let reads = 0;
    f.adapter.read = async () => snapshot({ kind: "two_step", accountEmail: ++reads === 1 ? FIXTURE_EMAIL : "" });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.match(result.detail.add2fa, /身份暂未读到/);
    assert.deepStrictEqual(clicks(f), []);
    assertActivationOnly(f);
  });

  await checkAsync("验证器稳健性：身份缺失与账号不匹配有不同诊断，均保留原登录结果", async () => {
    for (const [accountEmail, reason] of [["", /身份暂未读到/], ["different-account@example.com", /账号与所选账号不一致/]]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { twoStep: snapshot({ kind: "two_step", accountEmail, enabled: true }) },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.match(result.detail.add2fa, reason);
      assert.deepStrictEqual(f.stored.lastLoginCheck, FIXTURE_LOGIN.fieldPatch.lastLoginCheck);
      assert.deepStrictEqual(clicks(f), []);
      assertActivationOnly(f);
    }
  });

  await checkAsync("验证器稳健性：首次设置读取因导航上下文暂失时可恢复，不重复设置或提交", async () => {
    const f = fixture();
    const read = f.adapter.read;
    let failures = 0;
    f.adapter.read = async () => {
      if (clicks(f).includes("#setup") && failures++ < 2) throw new Error("Execution context was destroyed");
      return read();
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify", "#turn-on"]);
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
  });

  await checkAsync("验证器稳健性：阶段日志仅含固定枚举且去重，不含身份、密钥或页面正文", async () => {
    const f = fixture();
    const events = [];
    f.adapter.emit = (type, data) => events.push({ type, data });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.ok(events.some(({ data }) => data.stage === "verifying_code"));
    assert.ok(events.some(({ data }) => data.lastAction === "turn_on"));
    assert.ok(events.length > 0 && events.length <= 40);
    for (const { type, data } of events) {
      assert.strictEqual(type, "totp_setup_progress");
      assert.deepStrictEqual(Object.keys(data), ["stage", "activationStage", "page", "dialog", "identity", "lastAction", "readFailed"]);
    }
    const diagnostic = JSON.stringify(events);
    for (const privateValue of [FIXTURE_SECRET, FIXTURE_CODE, FIXTURE_EMAIL, f.inputAccount.password, f.inputAccount.recoveryEmail]) {
      assert.ok(!diagnostic.includes(privateValue));
    }
    for (let i = 1; i < events.length; i += 1) assert.notDeepStrictEqual(events[i], events[i - 1]);
  });

  await checkAsync("验证器稳健性：诊断日志回调异常不影响密钥确认与开启", async () => {
    const f = fixture();
    f.adapter.emit = () => { throw new Error("fixture log unavailable"); };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
  });

  await checkAsync("验证器稳健性：跳转其它页面后进度及时更新，不能保留上页身份已核对的状态", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const events = [];
    const read = f.adapter.read;
    f.adapter.emit = (_type, data) => events.push(data);
    f.adapter.read = async () => clicks(f).length ? { kind: "other", route: "/security" } : read();
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(events.at(-1).page, "other");
    assert.strictEqual(events.at(-1).identity, "unknown");
    assert.match(result.detail.add2fa, /其它页面 \/security/);
    assertActivationOnly(f);
  });

  await checkAsync("验证器稳健性：多次页面变动的日志最多40条，达到上限不影响最终结果", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const events = [];
    let reads = 0;
    let opens = 0;
    const open = f.adapter.open;
    f.adapter.open = async (url) => { opens += 1; await open(url); };
    f.adapter.emit = (_type, data) => events.push(data);
    f.adapter.read = async () => {
      reads += 1;
      if (reads === 20) return snapshot({ kind: "two_step", turnOn: "#turn-on" });
      if (opens > 1) return snapshot({ kind: "two_step", enabled: true });
      return snapshot({ kind: reads % 2 ? "authenticator" : "two_step" });
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(events.length, 40);
    assert.deepStrictEqual(clicks(f), ["#turn-on"]);
    assertActivationOnly(f);
  });

  await checkAsync("添加验证器：本地已有密钥直接跳过，不登录不导航不替换", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET } });
    await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(f.calls.filter((entry) => ["login", "open", "click", "type", "checkpoint"].includes(entry[0])).length, 0);
  });

  await checkAsync("添加验证器：存在待确认密钥时不重新设置，保留人工核实状态", async () => {
    const f = fixture({ account: { pendingTotpSetup: { secret: FIXTURE_SECRET, createdAt: "2026-01-01T00:00:00.000Z" } } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.notStrictEqual(result.outcome, "ok");
    assert.strictEqual(f.calls.filter((entry) => ["login", "open", "click", "type"].includes(entry[0])).length, 0);
    assertNoActiveKey(f);
    assertSafeDetail(result);
  });

  await checkAsync("添加验证器：Google 已有验证器优先于设置按钮，不触碰旧验证器", async () => {
    const f = fixture({ stages: { settings: snapshot({ existing: true, setup: "#setup" }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.deepStrictEqual(clicks(f), []);
    assertNoActiveKey(f);
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "内部登录的结果也必须保留");
    assertSafeDetail(result);
  });

  await checkAsync("添加验证器：设置页身份异常时停止设置，登录与设置诊断分别保留", async () => {
    for (const accountEmail of ["", "different-account@example.com"]) {
      const f = fixture({ stages: { settings: snapshot({ accountEmail, setup: "#setup" }) } });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.deepStrictEqual(clicks(f), []);
      assert.ok(!f.calls.some((entry) => ["type", "code"].includes(entry[0])));
      assertNoActiveKey(f);
      assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
      assert.strictEqual(f.stored.status.login, "ok");
      assertSafeDetail(result);
    }
  });

  await checkAsync("添加验证器：下一步后账号身份变化时不输入或提交验证码", async () => {
    const f = fixture({ stages: { code: snapshot({
      accountEmail: "different-account@example.com", wizard: true, codeInput: "#code", verify: "#verify",
    }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next"]);
    assert.ok(!f.calls.some((entry) => ["type", "code"].includes(entry[0])));
    assertNoActiveKey(f);
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
  });

  await checkAsync("添加验证器：输入验证码后再次核实身份，身份变化不点确认且保留候选密钥", async () => {
    const f = fixture();
    const type = f.adapter.type;
    const read = f.adapter.read;
    let typed = false;
    f.adapter.type = async (...args) => { await type(...args); typed = true; };
    f.adapter.read = async () => {
      const s = await read();
      return typed ? { ...s, accountEmail: "different-account@example.com" } : s;
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.ok(!clicks(f).includes("#verify"));
    assert.ok(f.stored.pendingTotpSetup);
    assertNoActiveKey(f);
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
  });

  await checkAsync("添加验证器：提交后身份变为其他账号不能采用成功信号，原候选密钥仍保留", async () => {
    const f = fixture({ stages: { saved: snapshot({
      accountEmail: "different-account@example.com", existing: true, saved: true,
    }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.ok(clicks(f).includes("#verify"));
    assert.ok(!clicks(f).includes("#turn-on"));
    assertNoActiveKey(f);
    assert.strictEqual(f.stored.pendingTotpSetup.secret, FIXTURE_SECRET);
    assert.strictEqual(f.stored.pendingTotpSetup.stage, "submitted");
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
  });

  await checkAsync("添加验证器：开启总开关前目标身份必须匹配，已验证密钥不因跳错账号丢失", async () => {
    for (const accountEmail of ["", "different-account@example.com"]) {
      const f = fixture({ stages: { twoStep: snapshot({ kind: "two_step", accountEmail, turnOn: "#turn-on" }) } });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.ok(!clicks(f).includes("#turn-on"));
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
    }
  });

  await checkAsync("添加验证器：开启后其他账号的已开启状态不能误判本账号完成", async () => {
    const f = fixture({ stages: { enabled: snapshot({ kind: "two_step", accountEmail: "different-account@example.com", enabled: true }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(clicks(f).filter((selector) => selector === "#turn-on").length, 1);
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
  });

  await checkAsync("添加验证器：无验证器且辅助邮箱登录成功，依次设置、验证和启用后保存", async () => {
    const f = fixture();
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify", "#turn-on"]);
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.ok(!f.stored.pendingTotpSetup, "验证成功后应清空待确认密钥");
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok");
    assert.ok(f.calls.findIndex((entry) => entry[0] === "recordLoginResult") < f.calls.findIndex((entry) => entry[0] === "open"));
    assertNoReplacementMetadata(f);
    assertSafeDetail(result);
  });

  await checkAsync("添加验证器：纯账号密码与辅助邮箱登录均须完成总开关及确认弹窗才成功", async () => {
    for (const recoveryEmail of ["", "fixture-recovery@example.net"]) {
      const f = fixture({
        account: { recoveryEmail },
        stages: {
          confirmation: snapshot({ kind: "two_step", dialog: "confirm", confirmTurnOn: "#confirm-turn-on" }),
          success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
        },
        transitions: { "#turn-on": "confirmation", "#confirm-turn-on": "success", "#done": "enabled" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify", "#turn-on", "#confirm-turn-on", "#done"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.stored.pendingTotpSetup, null);
      assertNoReplacementMetadata(f);
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证明确成功：两种登录资料首次添加收到 protected 提示即完成，不再等旧总开关", async () => {
    for (const recoveryEmail of ["", "fixture-recovery@example.net"]) {
      const f = fixture({
        account: { recoveryEmail },
        stages: {
          protected: snapshot({ kind: "two_step", dialog: "success", activationConfirmed: true, dismiss: "#done" }),
          stale: snapshot({ kind: "two_step", turnOn: "#turn-on" }),
        },
        transitions: { "#turn-on": "protected", "#done": "stale" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify", "#turn-on", "#done"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.stored.pendingTotpSetup, null);
      assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 2,
        "仅打开首次设置和总开关，不因旧页面反馈重复导航");
      assertNoReplacementMetadata(f);
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证明确成功：待开启账号收到 protected 提示后 Done 失败或无反馈不降级", async () => {
    for (const dismissMode of ["missing", "throws", "stalled"]) {
      const protectedState = snapshot({ kind: "two_step", dialog: "success", activationConfirmed: true,
        dismiss: dismissMode === "missing" ? "" : "#done" });
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { twoStep: protectedState }, transitions: { "#done": "twoStep" },
      });
      const read = f.adapter.read;
      f.adapter.read = async () => {
        assert.ok(!clicks(f).includes("#done"), "精确成功已确认，Done 后不依赖回读才成功");
        return read();
      };
      if (dismissMode === "throws") {
        const click = f.adapter.click;
        f.adapter.click = async (selector) => {
          await click(selector);
          throw new Error("Execution context was destroyed after Done");
        };
      }
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok", dismissMode);
      assert.deepStrictEqual(clicks(f), dismissMode === "missing" ? [] : ["#done"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1);
      assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
      assertNoReplacementMetadata(f);
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证明确成功：先跳过可选手机号再收到 protected 提示，不添加手机号", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: {
        phone: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }),
        protected: snapshot({ kind: "two_step", dialog: "success", activationConfirmed: true, dismiss: "#done" }),
      },
      transitions: { "#turn-on": "phone", "#skip-phone": "protected", "#done": "protected" },
    });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#skip-phone", "#done"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1);
    assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
  });

  await checkAsync("两步验证明确成功：身份缺失或不一致的 protected 弹窗不能记成功或点击 Done", async () => {
    for (const accountEmail of ["", "other-fixture@example.com"]) {
      for (const initiallyProtected of [false, true]) {
        const protectedState = snapshot({ kind: "two_step", accountEmail, dialog: "success", activationConfirmed: true, dismiss: "#done" });
        const f = fixture({
          account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
          stages: { protected: protectedState, ...(initiallyProtected ? { twoStep: protectedState } : {}) },
          transitions: { "#turn-on": "protected", "#done": "enabled" },
        });
        const result = await runFlow(f.adapter, f.inputAccount);
        assert.strictEqual(result.outcome, "need_verify");
        assert.deepStrictEqual(clicks(f), initiallyProtected ? [] : ["#turn-on"]);
        assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
        assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
        assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      }
    }
  });

  await checkAsync("两步验证可选手机号：两种登录资料首次添加后只跳过手机号，复核总开关才完成", async () => {
    for (const recoveryEmail of ["", "fixture-recovery@example.net"]) {
      const f = fixture({
        account: { recoveryEmail },
        stages: {
          phone: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }),
          success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
        },
        transitions: { "#turn-on": "phone", "#skip-phone": "success", "#done": "enabled" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify", "#turn-on", "#skip-phone", "#done"]);
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.stored.pendingTotpSetup, null);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assertNoReplacementMetadata(f);
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证可选手机号：待开启账号从已有弹窗继续，不重新添加或更换密钥", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { twoStep: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }) },
      transitions: { "#skip-phone": "enabled" },
    });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#skip-phone"]);
    assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
    assert.ok(!f.calls.some((entry) => entry[0] === "open" && entry[1].includes("/authenticator")));
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assertNoReplacementMetadata(f);
  });

  await checkAsync("两步验证可选手机号：开启确认与手机号提醒任意先后均各点击一次", async () => {
    for (const phoneFirst of [false, true]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: {
          phone: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }),
          confirmation: snapshot({ kind: "two_step", dialog: "confirm", confirmTurnOn: "#confirm-turn-on" }),
          success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
        },
        transitions: {
          "#turn-on": phoneFirst ? "phone" : "confirmation",
          "#skip-phone": phoneFirst ? "confirmation" : "success",
          "#confirm-turn-on": phoneFirst ? "success" : "phone", "#done": "enabled",
        },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.deepStrictEqual(clicks(f), ["#turn-on", ...(phoneFirst
        ? ["#skip-phone", "#confirm-turn-on"] : ["#confirm-turn-on", "#skip-phone"]), "#done"]);
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
    }
  });

  await checkAsync("两步验证可选手机号：跳过后弹窗延迟消失继续观察，不重复点击", async () => {
    const phone = snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" });
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { phone }, transitions: { "#turn-on": "phone", "#skip-phone": "enabled" },
    });
    const read = f.adapter.read;
    let remaining = 4;
    f.adapter.read = async () => clicks(f).includes("#skip-phone") && remaining-- > 0 ? clone(phone) : read();
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.ok(remaining <= 0);
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#skip-phone"]);
    assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1);
  });

  await checkAsync("两步验证可选手机号：跳过导航异常后仍观察明确结果，不能重复提交", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { phone: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }) },
      transitions: { "#turn-on": "phone", "#skip-phone": "enabled" },
    });
    const click = f.adapter.click;
    f.adapter.click = async (selector) => {
      await click(selector);
      if (selector === "#skip-phone") throw new Error("Execution context was destroyed during skip navigation");
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#skip-phone"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assertSafeDetail(result);
  });

  await checkAsync("两步验证可选手机号：跳过无反馈或只有成功提示，不能假报已开启", async () => {
    for (const nextStage of ["phone", "unconfirmed", "success"]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: {
          phone: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }),
          success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
          unconfirmed: snapshot({ kind: "two_step" }),
        },
        transitions: { "#turn-on": "phone", "#skip-phone": nextStage, "#done": "unconfirmed" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.deepStrictEqual(clicks(f), ["#turn-on", "#skip-phone", ...(nextStage === "success" ? ["#done"] : [])]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      if (nextStage === "phone") {
        assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1,
          "不能通过重开页面清掉仍显示的手机号弹窗");
      }
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证可选手机号：身份缺失或不匹配绝不点击跳过", async () => {
    for (const initial of [false, true]) {
      for (const accountEmail of ["", "other-fixture@example.com"]) {
        const phone = snapshot({ kind: "two_step", accountEmail, dialog: "optional_phone", skipPhone: "#skip-phone" });
        const f = fixture({
          account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
          stages: { phone, ...(initial ? { twoStep: phone } : {}) },
          transitions: { "#turn-on": "phone", "#skip-phone": "enabled" },
        });
        const result = await runFlow(f.adapter, f.inputAccount);
        assert.strictEqual(result.outcome, "need_verify");
        assert.deepStrictEqual(clicks(f), initial ? [] : ["#turn-on"]);
        assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
        assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
        assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
      }
    }
  });

  await checkAsync("两步验证可选手机号：完成提示后退回手机号弹窗不能再点跳过", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: {
        success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
        phone: snapshot({ kind: "two_step", dialog: "optional_phone", skipPhone: "#skip-phone" }),
      },
      transitions: { "#turn-on": "success", "#done": "phone", "#skip-phone": "enabled" },
    });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#done"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1);
  });

  await checkAsync("添加验证器：开启阶段重新验证使用刚确认保存的新密钥，保留两种登录资料", async () => {
    for (const recoveryEmail of ["", "fixture-recovery@example.net"]) {
      const f = fixture({ account: { recoveryEmail } });
      const read = f.adapter.read;
      let verified = false;
      let reauthCalls = 0;
      f.adapter.read = async () => {
        const current = await read();
        return current.kind === "two_step" && !verified ? snapshot({ kind: "reauth" }) : current;
      };
      f.adapter.reauth = async (verifiedAccount) => {
        reauthCalls += 1;
        assert.ok(verifiedAccount, "再次验证不能继续使用添加前不含密钥的旧对象");
        assert.strictEqual(verifiedAccount.email, FIXTURE_EMAIL);
        assert.strictEqual(verifiedAccount.password, f.inputAccount.password);
        assert.strictEqual(verifiedAccount.recoveryEmail, recoveryEmail);
        assert.strictEqual(verifiedAccount.totpSecret, FIXTURE_SECRET);
        assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET, "先保存新密钥，再交给重新验证流程");
        assert.strictEqual(f.inputAccount.totpSecret, "", "不能隐式修改最初传入的账号对象");
        verified = true;
        return { outcome: "ok" };
      };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.strictEqual(reauthCalls, 1);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    }
  });

  await checkAsync("两步验证启用：成功弹窗本身不算完成，必须关闭后读到总开关已开启", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: {
        success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
        unconfirmed: snapshot({ kind: "two_step" }),
      },
      transitions: { "#turn-on": "success", "#done": "unconfirmed" },
    });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#done"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
  });

  await checkAsync("两步验证启用：确认点击因跳转报错仍复核，不重复提交确认", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { confirmation: snapshot({ kind: "two_step", dialog: "confirm", confirmTurnOn: "#confirm-turn-on" }) },
      transitions: { "#turn-on": "confirmation", "#confirm-turn-on": "enabled" },
    });
    const click = f.adapter.click;
    f.adapter.click = async (selector) => {
      await click(selector);
      if (selector === "#confirm-turn-on") throw new Error("Execution context was destroyed after confirmation");
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#confirm-turn-on"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assertSafeDetail(result);
  });

  await checkAsync("两步验证启用：新密钥保存后重新验证触发人工步骤，保留待开启且不重复设置", async () => {
    const f = fixture();
    const read = f.adapter.read;
    f.adapter.read = async () => {
      const current = await read();
      return current.kind === "two_step" ? snapshot({ kind: "reauth" }) : current;
    };
    f.adapter.reauth = async (verifiedAccount) => {
      assert.strictEqual(verifiedAccount.totpSecret, FIXTURE_SECRET);
      return { outcome: "need_verify", reasonCode: "captcha" };
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.handoff, true);
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.stored.pendingTotpSetup, null);
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify"]);
    assertNoReplacementMetadata(f);
    assertSafeDetail(result);
  });

  await checkAsync("两步验证启用：确认或完成按钮无反馈最多点击一次，不循环提交", async () => {
    for (const dialog of ["confirm", "success"]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: {
          stalled: snapshot({ kind: "two_step", dialog,
            ...(dialog === "confirm" ? { confirmTurnOn: "#confirm-turn-on" } : { dismiss: "#done" }) }),
        },
        transitions: { "#turn-on": "stalled", "#confirm-turn-on": "stalled", "#done": "stalled" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.deepStrictEqual(clicks(f), ["#turn-on", dialog === "confirm" ? "#confirm-turn-on" : "#done"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    }
  });

  await checkAsync("两步验证启用：完成提示之后回退到开启确认时不能再点确认", async () => {
    for (const initiallySuccessful of [false, true]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: {
          ...(initiallySuccessful ? { twoStep: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }) } : {}),
          success: snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" }),
          backwards: snapshot({ kind: "two_step", dialog: "confirm", confirmTurnOn: "#confirm-turn-on" }),
        },
        transitions: { "#turn-on": "success", "#done": "backwards", "#confirm-turn-on": "enabled" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify", "成功提示后出现反向确认属于未确认状态，不能重新提交");
      assert.deepStrictEqual(clicks(f), initiallySuccessful ? ["#done"] : ["#turn-on", "#done"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1,
        "不能通过重新导航绕过反向出现的确认弹窗");
      assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证启用：点击后弹窗延迟变化时继续有界观察，不提前退出或重复点击", async () => {
    const confirmation = snapshot({ kind: "two_step", dialog: "confirm", confirmTurnOn: "#confirm-turn-on" });
    const success = snapshot({ kind: "two_step", dialog: "success", dismiss: "#done" });
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { confirmation, success },
      transitions: { "#turn-on": "confirmation", "#confirm-turn-on": "success", "#done": "enabled" },
    });
    const read = f.adapter.read;
    const remaining = { "#turn-on": 2, "#confirm-turn-on": 3, "#done": 4 };
    f.adapter.read = async () => {
      const clicked = clicks(f);
      const lastClick = clicked[clicked.length - 1];
      if (remaining[lastClick] > 0) {
        remaining[lastClick] -= 1;
        return clone(lastClick === "#turn-on" ? snapshot({ kind: "two_step", turnOn: "#turn-on" })
          : lastClick === "#confirm-turn-on" ? confirmation : success);
      }
      return read();
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(remaining, { "#turn-on": 0, "#confirm-turn-on": 0, "#done": 0 });
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#confirm-turn-on", "#done"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1,
      "已在限定时间内正常完成，不需要额外重开设置页");
    assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
  });

  await checkAsync("两步验证启用：弹窗身份缺失或切到其他账号时不能点击确认或完成", async () => {
    for (const dialog of ["confirm", "success"]) {
      for (const accountEmail of ["", "other-fixture@example.com"]) {
        const f = fixture({
          account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
          stages: {
            wrongIdentity: snapshot({ kind: "two_step", dialog, accountEmail,
              confirmTurnOn: "#confirm-turn-on", dismiss: "#done" }),
          },
          transitions: { "#turn-on": "wrongIdentity" },
        });
        const result = await runFlow(f.adapter, f.inputAccount);
        assert.strictEqual(result.outcome, "need_verify");
        assert.deepStrictEqual(clicks(f), ["#turn-on"]);
        assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
        assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
        assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
      }
    }
  });

  await checkAsync("两步验证启用：未识别弹窗和多弹窗不点击，保持已保存密钥", async () => {
    for (const blocked of [false, true]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { unrelated: snapshot({ kind: "two_step", dialog: "unsupported", blocked }) },
        transitions: { "#turn-on": "unrelated" },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.deepStrictEqual(clicks(f), ["#turn-on"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assertActivationOnly(f);
    }
  });

  await checkAsync("两步验证启用：真实多弹窗快照或跳离设置页时不重新导航绕过阻塞", async () => {
    const afterClickStates = [
      { kind: "two_step", accountEmail: FIXTURE_EMAIL, blocked: true },
      { kind: "other", route: "/two-step-verification/phone-numbers" },
      { kind: "other" },
    ];
    for (const afterClick of afterClickStates) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { interrupted: afterClick },
        transitions: { "#turn-on": "interrupted" },
      });
      assert.ok(!Object.prototype.hasOwnProperty.call(afterClick, "dialog"),
        "本用例模拟实际没有 dialog 字段的多弹窗或非设置页快照");
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.deepStrictEqual(clicks(f), ["#turn-on"]);
      assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1,
        "仅有初次设置导航，不应把未知页面或多弹窗清走后重试");
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assertActivationOnly(f);
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证启用：点击后旧页面无反馈仅重新打开一次设置页作只读复核", async () => {
    for (const revealed of ["enabled", "still-off", "other-account"]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        transitions: { "#turn-on": "twoStep" },
      });
      const open = f.adapter.open;
      const read = f.adapter.read;
      let settingsOpens = 0;
      f.adapter.open = async (url) => { settingsOpens += 1; await open(url); };
      f.adapter.read = async () => {
        if (settingsOpens >= 2 && revealed !== "still-off") {
          return snapshot({ kind: "two_step", enabled: true,
            accountEmail: revealed === "other-account" ? "other-fixture@example.com" : FIXTURE_EMAIL });
        }
        return read();
      };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(settingsOpens, 2, "初次导航加至多一次只读重开，不无限刷新");
      assert.deepStrictEqual(clicks(f), ["#turn-on"], "重开后即使仍显示开启按钮也不能再次提交");
      assert.strictEqual(result.outcome, revealed === "enabled" ? "ok" : "need_verify");
      assert.strictEqual(f.stored.lastTotpSetup.state, revealed === "enabled" ? "added" : "pending_activation");
      assertActivationOnly(f);
    }
  });

  await checkAsync("添加验证器：两步验证本来已开启时不再点启用", async () => {
    const f = fixture({ stages: { twoStep: snapshot({ kind: "two_step", enabled: true, turnOn: "#turn-on" }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.ok(!clicks(f).includes("#turn-on"));
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
  });

  await checkAsync("添加验证器：密钥已验证但不能确认开启时标待启用，不假报全部完成", async () => {
    const f = fixture({ stages: { twoStep: snapshot({ kind: "two_step" }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET, "已被 Google 接受的密钥应保留");
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.ok(!clicks(f).includes("#turn-on"));
    assertSafeDetail(result);
  });

  await checkAsync("添加验证器：启用按钮无反馈只点击一次，保留待启用状态", async () => {
    const f = fixture({ transitions: { "#turn-on": "twoStep" } });
    await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(clicks(f).filter((selector) => selector === "#turn-on").length, 1);
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
  });

  await checkAsync("添加验证器：待启用重试只检查和开启两步验证，不生成或更换密钥", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#turn-on"]);
    assert.ok(!f.calls.some((entry) => ["type", "code"].includes(entry[0])));
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assertNoReplacementMetadata(f);
  });

  await checkAsync("添加验证器：开启点击报导航异常但页面已明确启用时复核为成功", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const click = f.adapter.click;
    f.adapter.click = async (selector) => {
      await click(selector);
      throw new Error("Execution context was destroyed during activation navigation");
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok", "点击产生跳转异常不等于开启失败，必须重新读取明确状态");
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.deepStrictEqual(clicks(f), ["#turn-on"]);
    assertActivationOnly(f);
    assertSafeDetail(result);
  });

  await checkAsync("添加验证器：总开关导航抛异常但目标账号页面已启用时仍可复核成功", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { twoStep: snapshot({ kind: "two_step", enabled: true }) },
    });
    const open = f.adapter.open;
    f.adapter.open = async (url) => { await open(url); throw new Error("Navigation timeout after document loaded"); };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.deepStrictEqual(clicks(f), []);
    assertActivationOnly(f);
  });

  await checkAsync("添加验证器：开启按钮消失但无明确已开启证据不能当成功", async () => {
    for (const throwsAfterClick of [false, true]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { afterClick: snapshot({ kind: "two_step" }) },
        transitions: { "#turn-on": "afterClick" },
      });
      if (throwsAfterClick) {
        const click = f.adapter.click;
        f.adapter.click = async (selector) => { await click(selector); throw new Error("Node was detached after activation"); };
      }
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.deepStrictEqual(clicks(f), ["#turn-on"]);
      assertActivationOnly(f);
      assertSafeDetail(result);
    }
  });

  await checkAsync("添加验证器：开启点击异常后出现另一账号已启用页面不能误报成功", async () => {
    const f = fixture({
      account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
      stages: { enabled: snapshot({ kind: "two_step", accountEmail: "other-fixture@example.com", enabled: true }) },
    });
    const click = f.adapter.click;
    f.adapter.click = async (selector) => { await click(selector); throw new Error("Navigation interrupted"); };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
    assert.deepStrictEqual(clicks(f), ["#turn-on"]);
    assertActivationOnly(f);
  });

  await checkAsync("添加验证器：待启用重试的总开关账号不匹配或身份缺失时绝不点击", async () => {
    for (const accountEmail of ["", "other-fixture@example.com"]) {
      const f = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        stages: { twoStep: snapshot({ kind: "two_step", accountEmail, turnOn: "#turn-on" }) },
      });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
      assert.deepStrictEqual(clicks(f), []);
      assertActivationOnly(f);
    }
  });

  await checkAsync("添加验证器：开启点击异常且状态仍未确认时保留旧密钥，诊断不回显秘密", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    f.adapter.click = async (selector) => {
      f.calls.push(["click", selector]);
      throw new Error(`activation failure ${FIXTURE_SECRET} code=${FIXTURE_CODE} https://accounts.google.com/?TL=fixture-private-session`);
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.deepStrictEqual(clicks(f), ["#turn-on"], "不因点击结果不确定而盲目重复提交");
    assertActivationOnly(f);
    const diagnostic = JSON.stringify({ detail: result.detail, lastTotpSetup: f.stored.lastTotpSetup });
    assert.ok(!diagnostic.includes(FIXTURE_SECRET));
    assert.ok(!diagnostic.includes(FIXTURE_CODE));
    assert.ok(!diagnostic.includes("fixture-private-session"));
  });

  await checkAsync("添加验证器：开启后仅导航上下文暂失可有界重读并确认成功", async () => {
    for (const message of [
      "Execution context was destroyed, most likely because of a navigation",
      "Cannot find context with specified id", "Execution context is not available", "Inspected target navigated",
    ]) {
      const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
      const read = f.adapter.read;
      let failures = 0;
      let pauses = 0;
      f.adapter.read = async () => {
        if (clicks(f).length && failures < 2) { failures += 1; throw new Error(message); }
        return read();
      };
      f.adapter.pause = async () => { pauses += 1; };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.strictEqual(failures, 2);
      assert.strictEqual(pauses, 2, "只在已知的导航瞬时错误之后重新观察");
      assert.deepStrictEqual(clicks(f), ["#turn-on"]);
      assertActivationOnly(f);
    }
  });

  await checkAsync("添加验证器：关闭、协议超时或未知读取错误立即待确认，不反复等待或泄露异常", async () => {
    for (const message of [
      "Protocol error (Runtime.callFunctionOn): Target closed", "Session closed",
      "Runtime.callFunctionOn timed out", "fixture unexpected document error",
    ]) {
      const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
      const read = f.adapter.read;
      let failures = 0;
      let pauses = 0;
      f.adapter.read = async () => {
        if (clicks(f).length) {
          failures += 1;
          throw new Error(`${message} ${FIXTURE_SECRET} ${FIXTURE_CODE} https://accounts.google.com/?TL=fixture-private-session`);
        }
        return read();
      };
      f.adapter.pause = async () => { pauses += 1; };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(failures, 1, "持久或未知错误不能重复触发长协议等待");
      assert.strictEqual(pauses, 0);
      assert.deepStrictEqual(clicks(f), ["#turn-on"]);
      assertActivationOnly(f);
      const diagnostic = JSON.stringify({ detail: result.detail, lastTotpSetup: f.stored.lastTotpSetup });
      for (const privateValue of [FIXTURE_SECRET, FIXTURE_CODE, "fixture-private-session", message]) {
        assert.ok(!diagnostic.includes(privateValue), "只允许安全的枚举诊断，不回显原始读取异常");
      }
    }
  });

  await checkAsync("添加验证器：导航暂失持续发生时同时受 20 轮和 30 秒总截止限制", async () => {
    for (const timeLimited of [false, true]) {
      const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
      const read = f.adapter.read;
      const realNow = Date.now;
      let now = 1700000000000;
      let failures = 0;
      f.adapter.read = async () => {
        if (clicks(f).length) { failures += 1; throw new Error("Execution context was destroyed"); }
        return read();
      };
      f.adapter.pause = async () => { if (timeLimited) now += 16000; };
      try {
        if (timeLimited) Date.now = () => now;
        const result = await runFlow(f.adapter, f.inputAccount);
        assert.strictEqual(result.outcome, "need_verify");
        assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
        assert.strictEqual(failures, timeLimited ? 2 : 20,
          "不得因一直读取不到导航上下文而无限循环，达到任一上限就停止");
        assert.deepStrictEqual(clicks(f), ["#turn-on"]);
        assertActivationOnly(f);
      } finally { Date.now = realNow; }
    }
  });

  await checkAsync("添加验证器：待启用重试登录受阻后仍可继续开启，不丢失待启用阶段", async () => {
    for (const outcome of ["need_verify", "error"]) {
      const reasonCode = outcome === "need_verify" ? "captcha" : "password_wrong";
      const loginResult = {
        outcome, reasonCode, stop: true,
        statusPatch: { login: outcome === "need_verify" ? "need_verify" : "failed" },
        fieldPatch: { lastLoginCheck: { reasonCode, outcome } },
        detail: { login: "fixture login interrupted" },
      };
      const failed = fixture({
        account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } },
        loginResult,
      });
      const failure = await runFlow(failed.adapter, failed.inputAccount);
      assert.strictEqual(failure.outcome, "need_verify");
      assert.strictEqual(failed.stored.lastTotpSetup.state, "pending_activation");
      assert.strictEqual(failed.stored.lastLoginCheck.reasonCode, reasonCode);
      assert.strictEqual(failed.stored.totpSecret, FIXTURE_SECRET);
      assert.ok(!failed.calls.some((entry) => ["open", "click", "type", "code"].includes(entry[0])));
      assertNoReplacementMetadata(failed);

      const retry = fixture({ account: clone(failed.stored) });
      const completed = await runFlow(retry.adapter, retry.inputAccount);
      assert.strictEqual(completed.outcome, "ok");
      assert.deepStrictEqual(clicks(retry), ["#turn-on"], "必须恢复总开关阶段，不能重新设置验证器或直接跳过");
      assert.ok(!retry.calls.some((entry) => ["type", "code"].includes(entry[0])));
      assert.strictEqual(retry.stored.totpSecret, FIXTURE_SECRET);
      assert.strictEqual(retry.stored.lastTotpSetup.state, "added");
      assertNoReplacementMetadata(retry);
    }
  });

  await checkAsync("添加验证器：待启用重试登录抛异常也保留阶段，再跑仍只开启总开关", async () => {
    const interrupted = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    interrupted.adapter.login = async () => { throw new Error("fixture interrupted login"); };
    const result = await runFlow(interrupted.adapter, interrupted.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(interrupted.stored.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(interrupted.stored.totpSecret, FIXTURE_SECRET);
    assert.deepStrictEqual(clicks(interrupted), []);
    const retry = fixture({ account: clone(interrupted.stored) });
    const completed = await runFlow(retry.adapter, retry.inputAccount);
    assert.strictEqual(completed.outcome, "ok");
    assert.deepStrictEqual(clicks(retry), ["#turn-on"]);
    assert.strictEqual(retry.stored.totpSecret, FIXTURE_SECRET);
    assertNoReplacementMetadata(retry);
  });

  await checkAsync("添加验证器：提交结果不明确后的重复运行始终保留候选密钥，不重设或当成正式密钥", async () => {
    const ambiguous = fixture({ stages: { saved: snapshot({ existing: true, saved: false }) } });
    const initial = await runFlow(ambiguous.adapter, ambiguous.inputAccount);
    assert.strictEqual(initial.outcome, "need_verify");
    const candidate = clone(ambiguous.stored.pendingTotpSetup);
    assert.strictEqual(candidate.secret, FIXTURE_SECRET);
    let savedAccount = clone(ambiguous.stored);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = fixture({ account: savedAccount });
      const result = await runFlow(retry.adapter, retry.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(retry.stored.totpSecret, "");
      assert.deepStrictEqual(retry.stored.pendingTotpSetup, candidate, "不能覆盖或清空上一次的候选密钥");
      assert.ok(!retry.calls.some((entry) => ["login", "open", "click", "type", "code"].includes(entry[0])));
      assertNoActiveKey(retry);
      assertNoReplacementMetadata(retry);
      savedAccount = clone(retry.stored);
    }
  });

  await checkAsync("添加验证器：登录触发人工验证时保存诊断并停止，不进入设置", async () => {
    const failed = {
      outcome: "need_verify", reasonCode: "captcha", stop: true,
      statusPatch: { login: "need_verify" },
      fieldPatch: { lastLoginCheck: { reasonCode: "captcha", outcome: "need_verify" } },
      detail: { login: "fixture captcha" },
    };
    const f = fixture({ loginResult: failed });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "captcha");
    assert.ok(!f.calls.some((entry) => ["open", "click", "type", "code"].includes(entry[0])));
    assertNoActiveKey(f);
  });

  await checkAsync("添加验证器：设置页重新验证未通过时应交给人工关窗策略，不当作普通失败", async () => {
    for (const supportsReauth of [false, true]) {
      const f = fixture({ stages: { settings: snapshot({ kind: "reauth" }) } });
      if (supportsReauth) f.adapter.reauth = async () => ({ outcome: "need_verify", reasonCode: "captcha" });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "need_verify");
      assert.strictEqual(result.stop, true);
      assert.strictEqual(result.keepOpen, true, "只报告人工接管需求，由引擎遵循用户的保留/关闭选项");
      assert.deepStrictEqual(clicks(f), []);
      assertNoActiveKey(f);
      assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok");
    }
  });

  await checkAsync("添加验证器：设置页正常重新验证后重新读页面再继续首次添加", async () => {
    const f = fixture();
    const read = f.adapter.read;
    let needsReauth = true;
    let reauthCalls = 0;
    f.adapter.read = async () => needsReauth ? snapshot({ kind: "reauth" }) : read();
    f.adapter.reauth = async () => {
      reauthCalls += 1;
      needsReauth = false;
      return { outcome: "ok" };
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.strictEqual(reauthCalls, 1);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
  });

  await checkAsync("添加验证器：向导没有有效密钥时不输入也不提交验证码", async () => {
    for (const secret of [null, "invalid key !"]) {
      const f = fixture({ stages: { secret: snapshot({ wizard: true, secret, next: "#next" }) } });
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.notStrictEqual(result.outcome, "ok");
      assert.ok(!f.calls.some((entry) => ["type", "code"].includes(entry[0])));
      assert.ok(!clicks(f).includes("#verify"));
      assertNoActiveKey(f);
    }
  });

  await checkAsync("添加验证器：提交被拒时不保存正式密钥，待确认副本仍在", async () => {
    const f = fixture({ stages: { saved: snapshot({ wizard: true, codeInput: "#code", verify: "#verify", codeRejected: true }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.notStrictEqual(result.outcome, "ok");
    assertNoActiveKey(f);
    assert.ok(f.stored.pendingTotpSetup, "失败后不能丢掉已提交过的候选密钥");
    assert.ok(!clicks(f).includes("#turn-on"));
    assertSafeDetail(result);
  });

  await checkAsync("添加验证器：弹窗消失但无成功证据，不把旧设置页误报为已添加", async () => {
    const f = fixture({ stages: { saved: snapshot({ existing: true, saved: false }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.notStrictEqual(result.outcome, "ok");
    assertNoActiveKey(f);
    assert.ok(f.stored.pendingTotpSetup);
    assert.ok(!clicks(f).includes("#turn-on"));
  });

  await checkAsync("添加验证器：向导未关闭时即使页面带成功文字也不保存正式密钥", async () => {
    const f = fixture({ stages: { saved: snapshot({ wizard: true, saved: true, codeInput: "#code", verify: "#verify" }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.notStrictEqual(result.outcome, "ok");
    assertNoActiveKey(f);
    assert.ok(f.stored.pendingTotpSetup);
  });

  await checkAsync("添加验证器：未识别页面不猜测设置动作，已成功的登录结果不丢失", async () => {
    const f = fixture({ stages: { settings: snapshot({ kind: "other" }) } });
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.notStrictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), []);
    assertNoActiveKey(f);
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok");
  });

  await checkAsync("添加验证器：待确认密钥落盘失败时不得提交验证码", async () => {
    const f = fixture({ failCheckpoint: async (patch) => {
      if (patch.pendingTotpSetup) throw new Error("fixture checkpoint unavailable");
    } });
    let result;
    try { result = await runFlow(f.adapter, f.inputAccount); } catch (err) {
      assert.match(err.message, /fixture checkpoint unavailable/);
    }
    if (result) assert.notStrictEqual(result.outcome, "ok");
    assert.ok(!clicks(f).includes("#verify"));
    assertNoActiveKey(f);
  });

  await checkAsync("添加验证器：登录新建替代页面后继续使用新页面并同步引擎会话", async () => {
    const oldPage = {
      goto: async () => { throw new Error("不得导航旧页面"); },
      evaluate: async () => { throw new Error("不得读取旧页面"); },
      url: () => { throw new Error("不得使用旧页面"); },
    };
    const calls = [];
    const freshPage = {
      goto: async (url) => {
        calls.push(["goto", url]);
        assert.strictEqual(new URL(url).searchParams.get("authuser"), FIXTURE_EMAIL);
      },
      evaluate: async (fn) => {
        assert.strictEqual(fn.name, "inspectDocument");
        calls.push(["read"]);
        return snapshot({ existing: true });
      },
    };
    const session = { page: oldPage };
    const result = await addTotp(oldPage, account(), {
      session,
      openLoginPage: async (page) => {
        assert.strictEqual(page, oldPage);
        return { page: freshPage, error: null };
      },
      driveAuthFlow: async (page) => {
        assert.strictEqual(page, freshPage);
        assert.strictEqual(session.page, freshPage);
        return { outcome: "ok", reasonCode: "ok", detail: { login: "fixture login" } };
      },
      recordLoginResult: async (r) => { calls.push(["loginResult", r.reasonCode]); },
    });
    assert.strictEqual(session.page, freshPage);
    assert.strictEqual(result.fieldPatch.lastTotpSetup.state, "already_configured");
    assert.strictEqual(calls.filter((entry) => entry[0] === "goto").length, 1);
    assert.strictEqual(calls.filter((entry) => entry[0] === "read").length, 1);
    assert.ok(calls.some((entry) => entry[0] === "loginResult" && entry[1] === "ok"));
  });

  await checkAsync("添加验证器：内部登录和设置页重新验证透传同一解题器与取消信号", async () => {
    for (const activationOnly of [false, true]) {
      let reads = 0;
      let attempted = 0;
      const labels = [];
      const solver = { maxAttemptsPerAccount: 3, getAttemptCount: () => attempted,
        solve: async () => { attempted += 1; return { token: "fixture-only-token" }; } };
      const controller = new AbortController();
      const input = account(activationOnly
        ? { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } : {});
      const page = {
        goto: async () => {},
        evaluate: async () => ++reads === 1 ? snapshot({ kind: "reauth" })
          : activationOnly ? snapshot({ kind: "two_step", enabled: true }) : snapshot({ existing: true }),
      };
      const result = await addTotp(page, input, {
        captchaSolver: solver, signal: controller.signal,
        openLoginPage: async (_page, ctx) => {
          assert.strictEqual(ctx.captchaSolver, solver);
          return { page, error: null };
        },
        driveAuthFlow: async (currentPage, currentAccount, _emit, options) => {
          assert.strictEqual(currentPage, page);
          assert.strictEqual(currentAccount.email, FIXTURE_EMAIL);
          assert.strictEqual(options.captchaSolver, solver);
          assert.strictEqual(options.signal, controller.signal);
          assert.strictEqual(solver.getAttemptCount(), labels.length);
          if (activationOnly) assert.strictEqual(currentAccount.totpSecret, FIXTURE_SECRET);
          labels.push(options.label);
          await options.captchaSolver.solve({ type: "fixture-only" });
          return { outcome: "ok", reasonCode: "ok", detail: { [options.label]: "fixture passed" } };
        },
        checkpointTotpSetup: async () => {},
      });
      assert.deepStrictEqual(labels, ["login", "reauth"]);
      assert.strictEqual(attempted, 2);
      assert.strictEqual(result.outcome, "ok");
      if (activationOnly) assert.strictEqual(result.fieldPatch.totpSecret, FIXTURE_SECRET);
      assertSafeDetail(result);
    }
  });

  await checkAsync("添加验证器：开启前打码预算耗尽仍保留已保存密钥和待开启状态", async () => {
    let attempts = 2;
    const solver = { maxAttemptsPerAccount: 3, getAttemptCount: () => attempts,
      solve: async () => { assert.ok(attempts < 3); attempts += 1; return {}; } };
    const labels = [];
    const page = { goto: async () => {}, evaluate: async () => snapshot({ kind: "reauth" }) };
    const result = await addTotp(page, account({ totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } }), {
      captchaSolver: solver,
      openLoginPage: async () => ({ page, error: null }),
      driveAuthFlow: async (_page, _account, _emit, options) => {
        labels.push(options.label);
        assert.strictEqual(options.captchaSolver, solver);
        if (options.label === "login") {
          await solver.solve({ type: "fixture-only" });
          return { outcome: "ok", reasonCode: "ok", detail: { login: "fixture passed" } };
        }
        assert.strictEqual(solver.getAttemptCount(), 3);
        return { outcome: "need_verify", reasonCode: "captcha", detail: { reauth: "本账号已调用 3/3 次" } };
      },
      checkpointTotpSetup: async () => {},
    });
    assert.deepStrictEqual(labels, ["login", "reauth"]);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(result.fieldPatch.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(result.fieldPatch.totpSecret, FIXTURE_SECRET);
    assertSafeDetail(result);
  });

  await checkAsync("验证器路由诊断：外域和非 HTTPS 页面不输出 route", () => {
    const body = domNode("body", "fixture page");
    for (const url of [
      "https://outside-fixture.example/security/private-token?TL=private-query#private-fragment",
      "https://myaccount.google.com.outside-fixture.example/security/private-token",
      "http://myaccount.google.com/security/private-token",
    ]) {
      const result = inspectFixture(inspectDocument, body, url);
      assert.strictEqual(result.kind, "other");
      assert.ok(!Object.prototype.hasOwnProperty.call(result, "route"), "外域诊断不得携带页面路径");
    }
  });

  await checkAsync("验证器路由诊断：Google 静态路径可定位跳转，但查询与片段永不输出", () => {
    const url = "https://myaccount.google.com/security?TL=fixture-private-query&authuser=personal-fixture%40example.com#fixture-private-fragment";
    const result = inspectFixture(inspectDocument, domNode("body", "fixture page"), url);
    assert.strictEqual(result.kind, "other");
    assert.strictEqual(result.route, "/security");
    const diagnostic = JSON.stringify(result);
    for (const privateValue of ["fixture-private-query", "personal-fixture", "fixture-private-fragment", "?", "#"]) {
      assert.ok(!diagnostic.includes(privateValue), `路由不能暴露 ${privateValue}`);
    }
  });

  await checkAsync("验证器路由诊断：路径中的动态令牌和邮箱不能作为静态段原样输出", () => {
    for (const privateSegment of [
      "FixturePrivateToken12345", "lowercaseprivatesessiontoken",
      "personal-fixture@example.com", "personal-fixture%40example.com",
    ]) {
      const result = inspectFixture(inspectDocument, domNode("body", "fixture page"),
        `https://myaccount.google.com/security/${privateSegment}?TL=fixture-private-query#fixture-private-fragment`);
      const diagnostic = JSON.stringify(result);
      assert.ok(!diagnostic.includes(privateSegment), "仅凭小写字母形式不能证明某路径段是静态路由");
      assert.ok(!diagnostic.includes(decodeURIComponent(privateSegment)));
      assert.ok(!diagnostic.includes("fixture-private-query"));
      assert.ok(!diagnostic.includes("fixture-private-fragment"));
    }
  });

  await checkAsync("验证器路由诊断：待启用结果仅采用脱敏路径，不传播令牌邮箱查询或片段", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const url = "https://myaccount.google.com/security/lowercaseprivatesessiontoken/personal-fixture%40example.com?TL=fixture-private-query#fixture-private-fragment";
    f.adapter.read = async () => inspectFixture(inspectDocument, domNode("body", "fixture page"), url);
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assertActivationOnly(f);
    const diagnostic = JSON.stringify({ detail: result.detail, lastTotpSetup: f.stored.lastTotpSetup });
    for (const privateValue of ["lowercaseprivatesessiontoken", "personal-fixture", "fixture-private-query", "fixture-private-fragment", FIXTURE_SECRET]) {
      assert.ok(!diagnostic.includes(privateValue), `待启用诊断不能传播 ${privateValue}`);
    }
  });

  await checkAsync("验证器页面识别：只允许 HTTPS Google 指定设置页", () => {
    for (const url of [
      "https://myaccount.google.com.evil.example/two-step-verification/authenticator",
      "http://myaccount.google.com/two-step-verification/authenticator",
      "https://myaccount.google.com/security",
      "https://example.com/two-step-verification/authenticator",
    ]) {
      const button = domNode("button", "Set up authenticator");
      const result = inspectFixture(inspectDocument, domNode("body", "", {}, [button]), url);
      assert.strictEqual(result.kind, "other");
      assert.ok(!result.setup);
      assert.strictEqual(button.getAttribute("data-am-auth-control"), null);
    }
    assert.strictEqual(inspectFixture(inspectDocument, domNode("body"), "https://accounts.google.com/v3/signin/challenge/pwd").kind, "reauth");
  });

  await checkAsync("验证器页面识别：只从当前 Google 账号控件识别目标邮箱，兼容中英韩标签", () => {
    for (const label of [
      `Google Account: Fixture (${FIXTURE_EMAIL.toUpperCase()})`,
      `Google 账号：测试 ${FIXTURE_EMAIL}`,
      `Google 계정: 테스트 ${FIXTURE_EMAIL}`,
    ]) {
      const body = domNode("body", "", {}, [
        domNode("button", "", { "aria-label": label }),
        domNode("main", "Authenticator", {}, [domNode("button", "Set up authenticator")]),
      ]);
      assert.strictEqual(inspectFixture(inspectDocument, body).accountEmail, FIXTURE_EMAIL);
    }
    const linked = domNode("body", "", {}, [
      domNode("a", "", { href: "https://accounts.google.com/SignOutOptions?hl=ja", "aria-label": `Google アカウント ${FIXTURE_EMAIL}` }),
      domNode("div", "Authenticator Scan a QR code", { role: "dialog" }, [domNode("button", "Next")]),
    ]);
    assert.strictEqual(inspectFixture(inspectDocument, linked).accountEmail, FIXTURE_EMAIL, "弹窗不应阻止读取外层当前账号控件");
  });

  await checkAsync("验证器页面识别：正文邮箱、普通按钮邮箱和隐藏账号不能冒充当前身份", () => {
    const cases = [
      domNode("body", `Authenticator ${FIXTURE_EMAIL}`),
      domNode("body", "", {}, [domNode("button", FIXTURE_EMAIL)]),
      domNode("body", "", {}, [domNode("button", "", { "aria-label": `Email ${FIXTURE_EMAIL}` })]),
      domNode("body", "", {}, [domNode("button", "", { "aria-label": `Google Account: ${FIXTURE_EMAIL}`, hidden: "hidden" })]),
      domNode("body", "", {}, [domNode("a", "", { href: "https://example.com/SignOutOptions", "aria-label": `Email ${FIXTURE_EMAIL}` })]),
    ];
    for (const body of cases) assert.strictEqual(inspectFixture(inspectDocument, body).accountEmail, "");
  });

  await checkAsync("验证器页面识别：出现多个不同当前账号信号时不能随意取第一个", () => {
    const body = domNode("body", "", {}, [
      domNode("button", "", { "aria-label": `Google Account: ${FIXTURE_EMAIL}` }),
      domNode("a", "", { href: "https://accounts.google.com/SignOutOptions", "aria-label": "Google Account: different-account@example.com" }),
    ]);
    assert.strictEqual(inspectFixture(inspectDocument, body).accountEmail, "");
  });

  function modalProfileFixture(email = FIXTURE_EMAIL, options = {}) {
    const profile = domNode("a", "", {
      href: "https://accounts.google.com/SignOutOptions?hl=en&continue=https://myaccount.google.com/",
      "aria-label": `Google Account: Fixture (${email})`,
      ...(options.profileAttrs || {}),
    });
    if (options.profileStyle) profile.fixtureStyle = options.profileStyle;
    if (options.zeroSize) profile.getBoundingClientRect = () => ({ width: 0, height: 0 });
    const header = domNode("header", "", { role: "banner" }, [profile, ...(options.headerChildren || [])]);
    const background = domNode("div", "", { "aria-hidden": "true" }, [
      header, domNode("main", "Authenticator", {}, [domNode("button", "Set up authenticator")]),
    ]);
    const dialog = domNode("div", options.dialogText || "Set up authenticator Scan a QR code",
      { role: "dialog", "aria-modal": "true" }, options.dialogChildren || [
        domNode("button", "Can't scan it?"), domNode("button", "Next"),
      ]);
    return { body: domNode("body", "", {}, [background, dialog]), profile, background, dialog };
  }

  await checkAsync("验证器模态框：背景仅被 aria-hidden 时仍读取可见顶部当前账号，不丢失身份", () => {
    const f = modalProfileFixture();
    const result = inspectFixture(inspectDocument, f.body);
    assert.strictEqual(result.wizard, true, "QR 向导本身已经打开并可见");
    assert.ok(result.manual && result.next, "当前向导控件仍应正常识别");
    assert.strictEqual(result.accountEmail, FIXTURE_EMAIL,
      "aria-hidden 隔离读屏焦点不等于头像视觉隐藏；不能因模态框打开就把已登录账号变成未确认");
    assert.ok(!result.setup, "只允许读取背景身份，不能放开背景设置按钮的点击");
  });

  await checkAsync("验证器模态框：手动密钥页同时保留背景账号身份、唯一密钥和下一步", () => {
    const grouped = FIXTURE_SECRET.toLowerCase().match(/.{4}/g).join(" ");
    const next = domNode("button", "Next");
    const f = modalProfileFixture(FIXTURE_EMAIL, {
      dialogText: "Set up authenticator Enter this setup key in your authenticator app",
      dialogChildren: [domNode("strong", grouped), next],
    });
    const result = inspectFixture(inspectDocument, f.body);
    assert.strictEqual(result.wizard, true);
    assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
    assert.strictEqual(result.secret, FIXTURE_SECRET);
    assert.ok(result.next);
    assert.strictEqual(f.body.querySelector(result.next), next);
    assert.ok(!result.codeInput && !result.verify && !result.setup);
  });

  await checkAsync("验证器模态框：验证码输入页同时保留背景账号身份、输入框和确认按钮", () => {
    const input = domNode("input", "", { type: "tel" });
    const verify = domNode("button", "Verify");
    const f = modalProfileFixture(FIXTURE_EMAIL, {
      dialogText: "Set up authenticator Enter the 6-digit code you see in the app",
      dialogChildren: [input, verify],
    });
    const result = inspectFixture(inspectDocument, f.body);
    assert.strictEqual(result.wizard, true);
    assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
    assert.ok(result.codeInput && result.verify);
    assert.strictEqual(f.body.querySelector(result.codeInput), input);
    assert.strictEqual(f.body.querySelector(result.verify), verify);
    assert.strictEqual(result.secret, null);
    assert.ok(!result.setup);
  });

  await checkAsync("验证器完整模态流程：真实 DOM 识别贯穿 QR、手动密钥、验证码和启用阶段", async () => {
    const f = fixture();
    const ordinaryPage = (text, label) => domNode("body", "", {}, [
      domNode("header", "", { role: "banner" }, [domNode("a", "", {
        href: "https://accounts.google.com/SignOutOptions",
        "aria-label": `Google Account: Fixture (${FIXTURE_EMAIL})`,
      })]),
      domNode("main", text, {}, [domNode("button", label)]),
    ]);
    const codeInput = domNode("input", "", { type: "tel" });
    const pages = {
      settings: ordinaryPage("Authenticator", "Set up authenticator"),
      wizard: modalProfileFixture().body,
      secret: modalProfileFixture(FIXTURE_EMAIL, {
        dialogText: "Set up authenticator Enter this setup key",
        dialogChildren: [domNode("strong", FIXTURE_SECRET.match(/.{4}/g).join(" ")), domNode("button", "Next")],
      }).body,
      code: modalProfileFixture(FIXTURE_EMAIL, {
        dialogText: "Set up authenticator Enter the 6-digit code",
        dialogChildren: [codeInput, domNode("button", "Verify")],
      }).body,
      saved: ordinaryPage("Authenticator app Added just now", "Change authenticator app"),
      twoStep: ordinaryPage("2-Step Verification", "Turn on 2-Step Verification"),
      enabled: ordinaryPage("2-Step Verification", "Turn off 2-Step Verification"),
    };
    const transitions = {
      settings: { label: "Set up authenticator", next: "wizard", action: "#setup" },
      wizard: { label: "Can't scan it?", next: "secret", action: "#manual" },
      secret: { label: "Next", next: "code", action: "#next" },
      code: { label: "Verify", next: "saved", action: "#verify" },
      twoStep: { label: "Turn on 2-Step Verification", next: "enabled", action: "#turn-on" },
    };
    let stage = "settings";
    let currentUrl = "https://myaccount.google.com/two-step-verification/authenticator?hl=en";
    const observed = [];
    f.adapter.open = async (url) => {
      assert.strictEqual(new URL(url).searchParams.get("authuser"), FIXTURE_EMAIL);
      stage = new URL(url).pathname.includes("/authenticator") ? "settings" : "twoStep";
      currentUrl = url;
      f.calls.push(["open", url]);
    };
    f.adapter.read = async () => {
      const result = inspectFixture(inspectDocument, pages[stage], currentUrl);
      observed.push({ stage, accountEmail: result.accountEmail });
      return result;
    };
    f.adapter.click = async (selector) => {
      const control = pages[stage].querySelector(selector);
      const transition = transitions[stage];
      assert.ok(control && transition, `不能点击非当前步骤控件 ${stage}`);
      assert.strictEqual(control.innerText, transition.label);
      assert.ok(!control.closest('[aria-hidden="true"]'), "从背景读取身份不意味着可以点击背景控件");
      if (stage === "code") {
        assert.strictEqual(codeInput.value, FIXTURE_CODE);
        assert.strictEqual(f.stored.pendingTotpSetup.stage, "submitted");
      }
      f.calls.push(["click", transition.action]);
      stage = transition.next;
      return true;
    };
    f.adapter.type = async (selector, value) => {
      assert.strictEqual(stage, "code");
      assert.strictEqual(pages[stage].querySelector(selector), codeInput);
      assert.strictEqual(value, FIXTURE_CODE);
      assert.ok(!codeInput.closest('[aria-hidden="true"]'));
      codeInput.value = value;
      f.calls.push(["type", "#code", value]);
      return true;
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#setup", "#manual", "#next", "#verify", "#turn-on"]);
    for (const expected of ["wizard", "secret", "code"]) {
      const snapshots = observed.filter((entry) => entry.stage === expected);
      assert.ok(snapshots.length > 0, `应读到 ${expected} 模态页`);
      assert.ok(snapshots.every((entry) => entry.accountEmail === FIXTURE_EMAIL), `${expected} 阶段不得丢失当前身份`);
    }
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.strictEqual(f.stored.pendingTotpSetup, null);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assertNoReplacementMetadata(f);
  });

  await checkAsync("验证器模态框：错误的可见当前账号必须如实读取，不能误用目标账号", () => {
    const f = modalProfileFixture("different-account@example.com");
    const result = inspectFixture(inspectDocument, f.body);
    assert.strictEqual(result.accountEmail, "different-account@example.com");
    assert.notStrictEqual(result.accountEmail, FIXTURE_EMAIL);
  });

  await checkAsync("验证器模态框：顶部真实头像可读取，aria-hidden 隐藏菜单中的其他账号仍排除", () => {
    const menuAccount = domNode("a", "", {
      href: "https://accounts.google.com/SignOutOptions",
      "aria-label": "Google Account: different-account@example.com",
    });
    const menu = domNode("div", "", { role: "menu", "aria-hidden": "true" }, [menuAccount]);
    const f = modalProfileFixture(FIXTURE_EMAIL, { headerChildren: [menu] });
    assert.strictEqual(inspectFixture(inspectDocument, f.body).accountEmail, FIXTURE_EMAIL,
      "不能把已关闭账号切换菜单中的条目纳入身份候选");
  });

  await checkAsync("验证器模态框：真正隐藏、零尺寸或自身 aria-hidden 的头像不得成为身份依据", () => {
    for (const options of [
      { profileAttrs: { hidden: "hidden" } },
      { profileAttrs: { "aria-hidden": "true" } },
      { profileStyle: { display: "none" } },
      { profileStyle: { visibility: "hidden" } },
      { zeroSize: true },
    ]) {
      const f = modalProfileFixture(FIXTURE_EMAIL, options);
      assert.strictEqual(inspectFixture(inspectDocument, f.body).accountEmail, "",
        `不能把真正隐藏的头像当成当前账号：${JSON.stringify(options)}`);
    }
  });

  await checkAsync("验证器模态框：身份读取例外不能扩展到无模态框、无关弹窗或非官方头像链接", () => {
    const noDialog = modalProfileFixture();
    noDialog.body.children.pop();
    assert.strictEqual(inspectFixture(inspectDocument, noDialog.body).accountEmail, "",
      "没有验证器模态框时，不能任意放宽 aria-hidden 身份来源");

    const unrelated = modalProfileFixture();
    const paymentDialog = domNode("div", "Confirm payment method", { role: "dialog", "aria-modal": "true" }, [domNode("button", "Confirm")]);
    const unrelatedBody = domNode("body", "", {}, [unrelated.background, paymentDialog]);
    assert.strictEqual(inspectFixture(inspectDocument, unrelatedBody).accountEmail, "");

    for (const href of ["", "https://example.com/SignOutOptions", "https://accounts.google.com/AccountChooser"]) {
      const f = modalProfileFixture(FIXTURE_EMAIL, { profileAttrs: { href } });
      assert.strictEqual(inspectFixture(inspectDocument, f.body).accountEmail, "",
        "仅匹配 Google Account 标签的控件，不足以放宽背景 aria-hidden 限制");
    }
  });

  await checkAsync("验证器模态框：菜单、列表框或另一个对话框内的头像不得作为背景身份", () => {
    for (const role of ["menu", "listbox", "dialog"]) {
      const f = modalProfileFixture();
      f.profile.parentElement.setAttribute("role", role);
      assert.strictEqual(inspectFixture(inspectDocument, f.body).accountEmail, "",
        `不能从 ${role} 的账号选项里拿当前身份`);
    }
  });

  await checkAsync("验证器模态框：头像祖先真正隐藏时不得利用 aria-hidden 例外", () => {
    for (const hiddenKind of ["hidden", "display", "visibility"]) {
      const f = modalProfileFixture();
      if (hiddenKind === "hidden") f.background.setAttribute("hidden", "hidden");
      if (hiddenKind === "display") f.background.fixtureStyle = { display: "none" };
      if (hiddenKind === "visibility") f.background.fixtureStyle = { visibility: "hidden" };
      assert.strictEqual(inspectFixture(inspectDocument, f.body).accountEmail, "",
        `真正隐藏祖先 ${hiddenKind} 不能被忽略`);
    }
  });

  await checkAsync("验证器页面识别：中英韩明确首次设置按钮可识别，通用设置按钮不能代替", () => {
    for (const text of ["Set up authenticator", "Add authenticator app", "设置身份验证器", "添加验证器", "인증 앱 설정"]) {
      const button = domNode("button", text);
      const result = inspectFixture(inspectDocument, domNode("body", "", {}, [domNode("main", "Authenticator", {}, [button])]));
      assert.ok(result.setup, text);
      assert.strictEqual(result.existing, false);
    }
    for (const text of ["Set up", "Continue", "Add", "Setup payment", "设置", "Set up a different device"]) {
      const result = inspectFixture(inspectDocument, domNode("body", "Authenticator", {}, [domNode("button", text)]));
      assert.ok(!result.setup, text);
    }
  });

  await checkAsync("验证器页面识别：更换、重新设置和旧验证器提示优先阻止首次添加", () => {
    for (const text of ["Change authenticator app", "Set up a different authenticator app", "重新设置身份验证器", "更换验证器", "인증 앱 변경"]) {
      const result = inspectFixture(inspectDocument, domNode("body", "Authenticator", {}, [
        domNode("button", "Set up authenticator"), domNode("button", text),
      ]));
      assert.strictEqual(result.existing, true, text);
      assert.ok(!result.setup, text);
    }
    const oldWizard = domNode("div", "Authenticator You won’t be able to use your old authenticator", { role: "dialog" }, [domNode("button", "Next")]);
    assert.strictEqual(inspectFixture(inspectDocument, domNode("body", "", {}, [oldWizard])).existing, true);
  });

  await checkAsync("验证器页面识别：不点击主内容外、隐藏、禁用或不唯一的设置按钮", () => {
    const outside = domNode("body", "", {}, [domNode("button", "Set up authenticator"), domNode("main", "Loading")]);
    assert.ok(!inspectFixture(inspectDocument, outside).setup);
    for (const attrs of [{ hidden: "hidden" }, { "aria-hidden": "true" }, { disabled: true }, { "aria-disabled": "true" }]) {
      const result = inspectFixture(inspectDocument, domNode("body", "Authenticator", {}, [domNode("button", "Set up authenticator", attrs)]));
      assert.ok(!result.setup);
    }
    const duplicate = domNode("body", "Authenticator", {}, [domNode("button", "Set up authenticator"), domNode("button", "Set up authenticator")]);
    assert.ok(!inspectFixture(inspectDocument, duplicate).setup);
  });

  await checkAsync("验证器页面识别：仅从当前向导提取唯一可见的 32 位密钥", () => {
    const secondSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const makePage = (inside) => domNode("body", "", {}, [
      domNode("strong", secondSecret),
      domNode("div", "Authenticator Scan a QR code", { role: "dialog" }, [
        ...inside, domNode("button", "Next"),
      ]),
    ]);
    const grouped = FIXTURE_SECRET.toLowerCase().match(/.{4}/g).join(" ");
    const valid = inspectFixture(inspectDocument, makePage([
      domNode("strong", grouped), domNode("strong", secondSecret, { hidden: "hidden" }),
    ]));
    assert.strictEqual(valid.secret, FIXTURE_SECRET);
    const duplicate = inspectFixture(inspectDocument, makePage([domNode("strong", grouped), domNode("code", FIXTURE_SECRET)]));
    assert.strictEqual(duplicate.secret, FIXTURE_SECRET, "同一密钥重复渲染不是冲突");
    const ambiguous = inspectFixture(inspectDocument, makePage([domNode("strong", FIXTURE_SECRET), domNode("strong", secondSecret)]));
    assert.strictEqual(ambiguous.secret, null);
    const outsideWizard = inspectFixture(inspectDocument, domNode("body", "Authenticator", {}, [domNode("strong", FIXTURE_SECRET)]));
    assert.strictEqual(outsideWizard.secret, null);
  });

  await checkAsync("验证器页面识别：只有当前验证器向导的唯一验证码框能填写", () => {
    const input = () => domNode("input", "", { type: "tel" });
    const dialog = (heading, children) => domNode("body", "", {}, [domNode("div", heading, { role: "dialog" }, children)]);
    const valid = inspectFixture(inspectDocument, dialog("Authenticator Enter the code", [input(), domNode("button", "Verify")]));
    assert.ok(valid.codeInput && valid.verify);
    const several = inspectFixture(inspectDocument, dialog("Authenticator Enter the code", [input(), input(), domNode("button", "Verify")]));
    assert.ok(!several.codeInput);
    const unrelated = inspectFixture(inspectDocument, dialog("Confirm your phone number", [input(), domNode("button", "Verify")]));
    assert.ok(!unrelated.codeInput);
    const mainForm = inspectFixture(inspectDocument, domNode("body", "Authenticator", {}, [input(), domNode("button", "Verify")]));
    assert.ok(!mainForm.codeInput);
  });

  const twoStepAliasPage = (buttonText, email = FIXTURE_EMAIL) => domNode("body", "", {}, [
    domNode("a", "", {
      href: "https://accounts.google.com/SignOutOptions",
      "aria-label": `Google Account: Fixture (${email})`,
    }),
    domNode("main", "2-Step Verification", {}, buttonText ? [domNode("button", buttonText)] : []),
  ]);

  const twoStepFixtureUrl = "https://myaccount.google.com/signinoptions/two-step-verification?hl=en";
  const activationModal = (text, children, email = FIXTURE_EMAIL, profileOptions = {}) => modalProfileFixture(email, {
    ...profileOptions, dialogText: text, dialogChildren: children,
  });

  const protectedHeading = "You’re now protected with 2-Step Verification";
  const protectedBody = "When signing in you’ll be asked to complete the most secure second step available on your account.";

  await checkAsync("两步验证成功标题：精确 protected 标题兼容弯直引号，仅标明确完成而非背景已开启", () => {
    for (const heading of [protectedHeading, protectedHeading.replace("’", "'"), `${protectedHeading}!`, `${protectedHeading}.`]) {
      for (const headingTag of ["h1", "h2", "h3", "role-heading"]) {
        const done = domNode("button", "Done");
        const f = activationModal(" ", [
          domNode(headingTag === "role-heading" ? "div" : headingTag, heading,
            headingTag === "role-heading" ? { role: "heading" } : {}),
          domNode("p", protectedBody), done,
        ]);
        const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
        assert.strictEqual(result.kind, "two_step");
        assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
        assert.strictEqual(result.dialog, "success");
        assert.strictEqual(result.activationConfirmed, true);
        assert.strictEqual(result.enabled, false, "弹窗成功和背景反向总开关是不同证据");
        assert.strictEqual(f.body.querySelector(result.dismiss), done);
        assert.ok(!result.turnOn && !result.confirmTurnOn && !result.skipPhone);
      }
    }
  });

  await checkAsync("两步验证成功标题：无语义标题只容许精确标题加截图正文或 Done", () => {
    for (const text of [protectedHeading, `${protectedHeading} ${protectedBody}`, protectedHeading.replace("’", "'")]) {
      const f = activationModal(text, [domNode("button", "Done")]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.strictEqual(result.dialog, "success");
      assert.strictEqual(result.activationConfirmed, true);
      assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
    }
    const bare = activationModal(protectedHeading, []);
    assert.strictEqual(inspectFixture(inspectDocument, bare.body, twoStepFixtureUrl).activationConfirmed, true);
  });

  await checkAsync("两步验证成功标题：Done 缺失、隐藏、禁用、重复不抹去完成证据且不授权点击", () => {
    const candidates = [
      [], [domNode("button", "Done", { hidden: "hidden" })],
      [domNode("button", "Done", { "aria-hidden": "true" })],
      [domNode("button", "Done", { disabled: true })],
      [domNode("button", "Done", { "aria-disabled": "true" })],
      [domNode("button", "Done"), domNode("button", "Done")],
    ];
    for (const buttons of candidates) {
      const f = activationModal(" ", [domNode("h2", protectedHeading), ...buttons]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.strictEqual(result.activationConfirmed, true);
      assert.strictEqual(result.dialog, "success");
      assert.ok(!result.dismiss);
    }
  });

  await checkAsync("两步验证成功标题：否定、任意后缀、正文引用或后续标题不能冒充精确成功", () => {
    const headings = [
      "You're not protected with 2-Step Verification",
      `${protectedHeading} not yet`, `${protectedHeading} is an example`,
      `After this you will see: ${protectedHeading}`, "2-Step Verification is on",
      "You are now protected with 2-Step Verification",
    ];
    for (const heading of headings) {
      for (const semantic of [false, true]) {
        const f = activationModal(semantic ? " " : heading,
          [...(semantic ? [domNode("h2", heading)] : []), domNode("button", "Done")]);
        const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
        assert.strictEqual(!!result.activationConfirmed, semantic && heading === "2-Step Verification is on", heading);
      }
    }
    const firstOther = activationModal(" ", [
      domNode("h2", "Review your account settings"), domNode("h3", protectedHeading), domNode("button", "Done"),
    ]);
    assert.ok(!inspectFixture(inspectDocument, firstOther.body, twoStepFixtureUrl).activationConfirmed);
    const hiddenTitle = activationModal("Review your account settings", [
      domNode("h2", protectedHeading, { "aria-hidden": "true" }), domNode("button", "Done"),
    ]);
    assert.ok(!inspectFixture(inspectDocument, hiddenTitle.body, twoStepFixtureUrl).activationConfirmed);
  });

  await checkAsync("两步验证成功标题：输入项、手机号付款步骤、多弹窗或页面正文都拒绝确认", () => {
    for (const extra of [
      domNode("input", "", { type: "tel" }), domNode("select"), domNode("div", "", { role: "textbox" }),
      domNode("p", "Add a phone number to continue"), domNode("p", "Confirm payment method"),
    ]) {
      const f = activationModal(" ", [domNode("h2", protectedHeading), extra, domNode("button", "Done")]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.ok(!result.activationConfirmed);
      assert.ok(!result.dismiss);
    }
    const multi = activationModal(" ", [domNode("h2", protectedHeading), domNode("button", "Done")]);
    const extraDialog = domNode("div", "Confirm identity", { role: "dialog" }, []);
    extraDialog.parentElement = multi.body;
    multi.body.children.push(extraDialog);
    const multiResult = inspectFixture(inspectDocument, multi.body, twoStepFixtureUrl);
    assert.strictEqual(multiResult.blocked, true);
    assert.ok(!multiResult.activationConfirmed && !multiResult.dismiss);
    const body = domNode("body", "", {}, [domNode("main", "", {}, [domNode("h2", protectedHeading), domNode("button", "Done")])]);
    assert.ok(!inspectFixture(inspectDocument, body, twoStepFixtureUrl).activationConfirmed);
  });

  await checkAsync("两步验证成功标题：不可信域和验证器子页不接受 protected 证据", () => {
    const f = activationModal(" ", [domNode("h2", protectedHeading), domNode("button", "Done")]);
    for (const url of [
      "https://outside-fixture.example/two-step-verification", "http://myaccount.google.com/two-step-verification",
      "https://myaccount.google.com.outside-fixture.example/two-step-verification",
      "https://accounts.google.com/signin/challenge/totp",
      "https://myaccount.google.com/two-step-verification/authenticator",
      "https://myaccount.google.com/two-step-verification/phone-numbers",
    ]) {
      const result = inspectFixture(inspectDocument, f.body, url);
      assert.ok(!result.activationConfirmed, url);
      assert.ok(!result.dismiss, url);
    }
  });

  await checkAsync("两步验证成功标题：实际 DOM 同账号成功直接完成，身份缺失或不匹配不得点 Done", async () => {
    for (const identity of ["match", "missing", "mismatch"]) {
      const email = identity === "mismatch" ? "other-fixture@example.com" : FIXTURE_EMAIL;
      const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
      const page = activationModal(" ", [domNode("h2", protectedHeading), domNode("p", protectedBody), domNode("button", "Done")],
        email, identity === "missing" ? { profileAttrs: { hidden: "hidden" } } : {});
      f.adapter.read = async () => {
        assert.ok(!clicks(f).length, "成功完成后不需要再次回读，也不能因缺少回读再次打开总开关");
        return inspectFixture(inspectDocument, page.body, twoStepFixtureUrl);
      };
      f.adapter.click = async (selector) => {
        assert.strictEqual(page.body.querySelector(selector).innerText, "Done");
        f.calls.push(["click", "#done"]);
      };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, identity === "match" ? "ok" : "need_verify");
      assert.deepStrictEqual(clicks(f), identity === "match" ? ["#done"] : []);
      assert.strictEqual(f.stored.lastTotpSetup.state, identity === "match" ? "added" : "pending_activation");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
      assert.strictEqual(f.calls.filter((entry) => entry[0] === "open").length, 1);
    }
  });

  const optionalPhoneModal = (children = [domNode("button", "Cancel"), domNode("button", "Add phone"), domNode("button", "Skip")],
    email = FIXTURE_EMAIL, profileOptions = {}, heading = "Add a phone number for 2-Step Verification?") =>
    activationModal(heading, children, email, profileOptions);

  await checkAsync("两步验证手机号弹窗：截图的 Cancel、Add phone、Skip 只授权唯一 Skip", () => {
    const f = optionalPhoneModal();
    const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
    assert.strictEqual(result.kind, "two_step");
    assert.strictEqual(result.accountEmail, FIXTURE_EMAIL, "弹窗背景的当前账号仍必须可核实");
    assert.strictEqual(result.dialog, "optional_phone");
    assert.ok(result.skipPhone);
    assert.strictEqual(f.body.querySelector(result.skipPhone).innerText, "Skip");
    assert.ok(!result.turnOn && !result.confirmTurnOn && !result.dismiss && !result.enabled);
    assert.ok(!result.codeInput && !result.verify && !result.setup && !result.next);
    const stamped = f.dialog.querySelectorAll("[data-am-auth-control]");
    assert.strictEqual(stamped.length, 1);
    assert.strictEqual(stamped[0].innerText, "Skip", "取消和添加手机号都不应获得操作 selector");
  });

  await checkAsync("两步验证手机号弹窗：只接受精确跳过标签，兼容 aria 与隐藏重复控件", () => {
    for (const label of ["Skip", "跳过", "略過", "건너뛰기"]) {
      const target = domNode("button", " \n ", { "aria-label": label });
      const f = optionalPhoneModal([
        domNode("button", "Add phone"), target,
        domNode("button", label, { hidden: "hidden" }),
        domNode("button", label, { "aria-hidden": "true" }),
      ]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.strictEqual(result.dialog, "optional_phone");
      assert.strictEqual(f.body.querySelector(result.skipPhone), target);
    }
  });

  await checkAsync("两步验证手机号弹窗：缺失、重复、隐藏或禁用 Skip 都不能继续", () => {
    const candidates = [
      [], [domNode("button", "Skip"), domNode("button", "Skip")],
      [domNode("button", "Skip", { hidden: "hidden" })],
      [domNode("button", "Skip", { "aria-hidden": "true" })],
      [domNode("button", "Skip", { disabled: true })],
      [domNode("button", "Skip", { "aria-disabled": "true" })],
      [domNode("button", "Skip verification")], [domNode("button", "Do not skip")],
    ];
    const invisible = domNode("button", "Skip");
    invisible.fixtureStyle = { display: "none" };
    candidates.push([invisible]);
    for (const buttons of candidates) {
      const f = optionalPhoneModal([domNode("button", "Cancel"), domNode("button", "Add phone"), ...buttons]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.ok(!result.skipPhone && !result.turnOn && !result.confirmTurnOn && !result.dismiss && !result.enabled);
      const disabledSkip = buttons.length === 1 && (buttons[0].disabled || buttons[0].getAttribute("aria-disabled") === "true");
      assert.strictEqual(result.dialog === "optional_phone", !!disabledSkip, "已知弹窗按钮暂不可用时只识别状态，仍不允许点击");
    }
  });

  await checkAsync("两步验证手机号弹窗：无明确添加手机号按钮或任意输入项都拒绝跳过", () => {
    const variants = [
      [domNode("button", "Skip")],
      [domNode("button", "Add phone", { hidden: "hidden" }), domNode("button", "Skip")],
      [domNode("button", "Add phone"), domNode("button", "Add phone"), domNode("button", "Skip")],
      ...[
        domNode("input", "", { type: "tel" }), domNode("input", "", { type: "text" }),
        domNode("select"), domNode("textarea"), domNode("div", "", { role: "textbox" }),
        domNode("div", "", { role: "combobox" }),
      ].map((input) => [domNode("button", "Add phone"), domNode("button", "Skip"), input]),
    ];
    for (const children of variants) {
      const f = optionalPhoneModal(children);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.ok(!result.skipPhone && !result.confirmTurnOn && !result.enabled);
      assert.notStrictEqual(result.dialog, "optional_phone");
    }
  });

  await checkAsync("两步验证手机号弹窗：强制手机号挑战、无关 Skip 和主页面按钮都不当可选提醒", () => {
    for (const heading of [
      "Verify your phone number", "Confirm the phone number you added to your account",
      "Add a payment method", "Add a phone number", "Enter a phone number to continue",
    ]) {
      const f = optionalPhoneModal(undefined, FIXTURE_EMAIL, {}, heading);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.ok(!result.skipPhone && !result.confirmTurnOn && !result.enabled, heading);
    }
    const f = optionalPhoneModal();
    f.dialog.removeAttribute("role");
    f.dialog.removeAttribute("aria-modal");
    assert.ok(!inspectFixture(inspectDocument, f.body, twoStepFixtureUrl).skipPhone,
      "页面正文里出现相同文字仍不能把任意 Skip 当手机号弹窗按钮");
    const multi = optionalPhoneModal();
    const extra = domNode("div", "Verify your identity", { role: "dialog" }, [domNode("button", "Skip")]);
    extra.parentElement = multi.body;
    multi.body.children.push(extra);
    const multiResult = inspectFixture(inspectDocument, multi.body, twoStepFixtureUrl);
    assert.strictEqual(multiResult.blocked, true);
    assert.ok(!multiResult.skipPhone);
  });

  await checkAsync("两步验证手机号弹窗：外域、重新验证及手机号子页不能获准跳过", () => {
    for (const url of [
      "https://other-fixture.example/signinoptions/two-step-verification",
      "https://myaccount.google.com.other-fixture.example/two-step-verification",
      "http://myaccount.google.com/two-step-verification",
      "https://accounts.google.com/signin/challenge/iap",
      "https://myaccount.google.com/two-step-verification/phone-numbers",
      "https://myaccount.google.com/two-step-verification/authenticator",
    ]) {
      const result = inspectFixture(inspectDocument, optionalPhoneModal().body, url);
      assert.ok(!result.skipPhone, url);
      assert.notStrictEqual(result.dialog, "optional_phone", url);
    }
  });

  await checkAsync("两步验证手机号弹窗：背景账号放宽规则仍拒绝隐藏或非官方身份信号", () => {
    for (const profileOptions of [
      { profileAttrs: { hidden: "hidden" } }, { profileAttrs: { "aria-hidden": "true" } },
      { profileAttrs: { href: "https://other-fixture.example/SignOutOptions" } },
      { profileAttrs: { href: "https://accounts.google.com/AccountChooser" } },
      { profileStyle: { display: "none" } }, { zeroSize: true },
    ]) {
      const f = optionalPhoneModal(undefined, FIXTURE_EMAIL, profileOptions);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.strictEqual(result.accountEmail, "");
    }
  });

  await checkAsync("两步验证手机号弹窗：实际 DOM 贯穿总开关、跳过和状态复核，绝不点 Add phone", async () => {
    for (const initialPhoneModal of [false, true]) {
      const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
      const pages = {
        waiting: twoStepAliasPage("Turn on 2-Step Verification"),
        phone: optionalPhoneModal().body,
        success: activationModal("2-Step Verification is on", [domNode("button", "Done")]).body,
        enabled: twoStepAliasPage("Turn off 2-Step Verification"),
      };
      const transitions = {
        waiting: { label: "Turn on 2-Step Verification", next: "phone", action: "#turn-on" },
        phone: { label: "Skip", next: "success", action: "#skip-phone" },
        success: { label: "Done", next: "enabled", action: "#done" },
      };
      let stage = initialPhoneModal ? "phone" : "waiting";
      f.adapter.read = async () => inspectFixture(inspectDocument, pages[stage], twoStepFixtureUrl);
      f.adapter.click = async (selector) => {
        const control = pages[stage].querySelector(selector);
        const transition = transitions[stage];
        assert.ok(control && transition);
        assert.strictEqual(control.innerText, transition.label, "仅允许当前步骤明确的操作按钮");
        assert.notStrictEqual(control.innerText, "Add phone");
        assert.ok(!control.closest('[aria-hidden="true"]'));
        f.calls.push(["click", transition.action]);
        stage = transition.next;
      };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.deepStrictEqual(clicks(f), [...(initialPhoneModal ? [] : ["#turn-on"]), "#skip-phone", "#done"]);
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
      assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
      assertSafeDetail(result);
    }
  });

  await checkAsync("两步验证弹窗：明确开启确认识别独立按钮，背景身份保留但背景按钮不可点", () => {
    for (const [heading, action] of [["Turn on 2-Step Verification?", "Turn on"], ["开启两步验证", "开启"]]) {
      const button = domNode("button", action);
      const f = activationModal(heading, [domNode("button", "Cancel"), button]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
      assert.strictEqual(result.dialog, "confirm");
      assert.ok(result.confirmTurnOn);
      assert.strictEqual(f.body.querySelector(result.confirmTurnOn), button);
      assert.ok(!result.turnOn && !result.enabled && !result.dismiss);
      assert.ok(!button.closest('[aria-hidden="true"]'));
    }
  });

  await checkAsync("两步验证弹窗：明确成功弹窗只允许关闭，不能直接作为已开启证据", () => {
    for (const [heading, action] of [["2-Step Verification is on", "Done"], ["两步验证已开启", "完成"]]) {
      const button = domNode("button", action);
      const f = activationModal(heading, [button]);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
      assert.strictEqual(result.dialog, "success");
      assert.ok(result.dismiss);
      assert.strictEqual(f.body.querySelector(result.dismiss), button);
      assert.strictEqual(result.enabled, false);
      assert.ok(!result.turnOn && !result.confirmTurnOn);
    }
  });

  await checkAsync("两步验证弹窗：无关弹窗、输入框、重复按钮或多个弹窗不能授权通用确认", () => {
    const cases = [
      ["Confirm payment method", [domNode("button", "Turn on")]],
      ["Add a phone number for 2-Step Verification", [domNode("input", "", { type: "tel" }), domNode("button", "Turn on")]],
      ["Turn on 2-Step Verification?", [domNode("input", "", { type: "text" }), domNode("button", "Turn on")]],
      ["Turn on 2-Step Verification?", [domNode("button", "Turn on"), domNode("button", "Turn on")]],
      ["2-Step Verification is on", [domNode("button", "Done"), domNode("button", "Done")]],
      ["Turn off 2-Step Verification?", [domNode("button", "Turn off")]],
      ["Verify your identity", [domNode("button", "Continue")]],
    ];
    for (const [heading, children] of cases) {
      const f = activationModal(heading, children);
      const result = inspectFixture(inspectDocument, f.body, twoStepFixtureUrl);
      assert.ok(!result.turnOn && !result.confirmTurnOn && !result.dismiss && !result.enabled, heading);
    }
    const multi = activationModal("Turn on 2-Step Verification?", [domNode("button", "Turn on")]);
    const extra = domNode("div", "Other dialog", { role: "dialog" }, [domNode("button", "Continue")]);
    extra.parentElement = multi.body;
    multi.body.children.push(extra);
    const result = inspectFixture(inspectDocument, multi.body, twoStepFixtureUrl);
    assert.strictEqual(result.blocked, true);
    assert.ok(!result.turnOn && !result.confirmTurnOn && !result.dismiss && !result.enabled);
  });

  await checkAsync("两步验证弹窗：背景身份例外仍拒绝隐藏、非官方链接和账号菜单", () => {
    for (const profileOptions of [
      { profileAttrs: { hidden: "hidden" } },
      { profileAttrs: { "aria-hidden": "true" } },
      { profileAttrs: { href: "https://fixture.example/SignOutOptions" } },
      { profileAttrs: { href: "https://accounts.google.com/AccountChooser" } },
      { profileStyle: { display: "none" } },
      { zeroSize: true },
    ]) {
      const f = activationModal("Turn on 2-Step Verification?", [domNode("button", "Turn on")], FIXTURE_EMAIL, profileOptions);
      assert.strictEqual(inspectFixture(inspectDocument, f.body, twoStepFixtureUrl).accountEmail, "");
    }
    for (const role of ["menu", "listbox", "dialog"]) {
      const f = activationModal("2-Step Verification is on", [domNode("button", "Done")]);
      f.profile.parentElement.setAttribute("role", role);
      assert.strictEqual(inspectFixture(inspectDocument, f.body, twoStepFixtureUrl).accountEmail, "");
    }
    const unrelated = activationModal("Confirm payment method", [domNode("button", "Confirm")]);
    assert.strictEqual(inspectFixture(inspectDocument, unrelated.body, twoStepFixtureUrl).accountEmail, "",
      "无关弹窗不能借两步验证 URL 放宽背景身份识别");
  });

  await checkAsync("两步验证按钮：纯空白文本不能遮蔽 aria 标签，且主内容外或禁用按钮不授权", () => {
    const button = domNode("button", " \n  ", { "aria-label": "Turn on 2-Step Verification" });
    const body = twoStepAliasPage("");
    const main = body.querySelector("main");
    button.parentElement = main;
    main.children.push(button);
    const result = inspectFixture(inspectDocument, body, twoStepFixtureUrl);
    assert.ok(result.turnOn);
    assert.strictEqual(body.querySelector(result.turnOn), button);
    for (const attrs of [{ hidden: "hidden" }, { "aria-hidden": "true" }, { disabled: true }, { "aria-disabled": "true" }]) {
      const blocked = twoStepAliasPage("");
      const blockedMain = blocked.querySelector("main");
      const control = domNode("button", "Turn on 2-Step Verification", attrs);
      control.parentElement = blockedMain;
      blockedMain.children.push(control);
      assert.ok(!inspectFixture(inspectDocument, blocked, twoStepFixtureUrl).turnOn);
    }
    const outside = domNode("body", "", {}, [domNode("button", "Turn on 2-Step Verification"), domNode("main", "Loading")]);
    assert.ok(!inspectFixture(inspectDocument, outside, twoStepFixtureUrl).turnOn);
  });

  await checkAsync("两步验证按钮：快照 selector 不复用，旧 selector 不能指向新按钮", () => {
    const firstButton = domNode("button", "Turn on 2-Step Verification");
    const main = domNode("main", "2-Step Verification", {}, [firstButton]);
    const body = domNode("body", "", {}, [main]);
    const first = inspectFixture(inspectDocument, body, twoStepFixtureUrl);
    assert.ok(first.turnOn);
    assert.strictEqual(body.querySelector(first.turnOn), firstButton);
    const secondButton = domNode("button", "Turn on 2-Step Verification");
    main.children.splice(0, 1, secondButton);
    secondButton.parentElement = main;
    const second = inspectFixture(inspectDocument, body, twoStepFixtureUrl);
    assert.ok(second.turnOn);
    assert.notStrictEqual(second.turnOn, first.turnOn, "新快照须有独立标识，不能从 am-auth-1 重新分配");
    assert.strictEqual(body.querySelector(first.turnOn), null, "旧 selector 必须失效，避免点击其他 DOM 节点");
    assert.strictEqual(body.querySelector(second.turnOn), secondButton);
  });

  await checkAsync("两步验证完整模态流程：实际 DOM 识别贯穿开启、确认、完成和关闭总开关证据", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const pages = {
      waiting: twoStepAliasPage("Turn on 2-Step Verification"),
      confirmation: activationModal("Turn on 2-Step Verification?", [domNode("button", "Turn on")]).body,
      success: activationModal("2-Step Verification is on", [domNode("button", "Done")]).body,
      enabled: twoStepAliasPage("Turn off 2-Step Verification"),
    };
    const transitions = {
      waiting: { label: "Turn on 2-Step Verification", next: "confirmation", action: "#turn-on" },
      confirmation: { label: "Turn on", next: "success", action: "#confirm-turn-on" },
      success: { label: "Done", next: "enabled", action: "#done" },
    };
    let stage = "waiting";
    f.adapter.read = async () => inspectFixture(inspectDocument, pages[stage], twoStepFixtureUrl);
    f.adapter.click = async (selector) => {
      const control = pages[stage].querySelector(selector);
      const transition = transitions[stage];
      assert.ok(control && transition, "只能点击当前快照给出的当前步骤控件");
      assert.strictEqual(control.innerText, transition.label);
      assert.ok(!control.closest('[aria-hidden="true"]'));
      f.calls.push(["click", transition.action]);
      stage = transition.next;
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "ok");
    assert.deepStrictEqual(clicks(f), ["#turn-on", "#confirm-turn-on", "#done"]);
    assert.strictEqual(f.stored.lastTotpSetup.state, "added");
    assert.strictEqual(f.stored.totpSecret, FIXTURE_SECRET);
    assert.ok(!f.calls.some((entry) => ["checkpoint", "code", "type"].includes(entry[0])));
  });

  await checkAsync("两步验证别名：精确 twosv 路径支持中英开启和关闭总开关证据", () => {
    for (const suffix of ["", "/"]) {
      const url = `https://myaccount.google.com/signinoptions/twosv${suffix}?hl=en&authuser=fixture#ignored`;
      for (const [label, enabled] of [
        ["Turn on 2-Step Verification", false], ["开启两步验证", false],
        ["Turn off 2-Step Verification", true], ["关闭两步验证", true],
      ]) {
        const result = inspectFixture(inspectDocument, twoStepAliasPage(label), url);
        assert.strictEqual(result.kind, "two_step");
        assert.strictEqual(result.accountEmail, FIXTURE_EMAIL);
        assert.strictEqual(result.enabled, enabled);
        assert.strictEqual(!!result.turnOn, !enabled);
      }
    }
  });

  await checkAsync("两步验证别名：twosv 路径本身、普通继续按钮或正文不能当已开启", () => {
    for (const label of ["", "Continue", "Turn on", "身份验证器已添加"]) {
      const result = inspectFixture(inspectDocument, twoStepAliasPage(label),
        "https://myaccount.google.com/signinoptions/twosv");
      assert.strictEqual(result.kind, "two_step");
      assert.strictEqual(result.enabled, false);
      assert.ok(!result.turnOn);
    }
  });

  await checkAsync("两步验证别名：只接受精确 Google twosv，不扩展外域、前缀或未知后缀", () => {
    for (const url of [
      "https://outside-fixture.example/signinoptions/twosv",
      "https://myaccount.google.com.outside-fixture.example/signinoptions/twosv",
      "http://myaccount.google.com/signinoptions/twosv",
      "https://myaccount.google.com/signinoptions/twosv-extra",
      "https://myaccount.google.com/signinoptions/twosv/enroll-welcome",
      "https://myaccount.google.com/signinoptions/other/twosv",
      "https://myaccount.google.com/signinoptions/twosv/unknown",
      "https://myaccount.google.com/u/0/signinoptions/twosv",
      "https://myaccount.google.com/signinoptions/TWOSV",
    ]) {
      const result = inspectFixture(inspectDocument, twoStepAliasPage("Turn on 2-Step Verification"), url);
      assert.strictEqual(result.kind, "other", "不能使用包含 twosv 就接受的宽泛路径匹配");
      assert.ok(!result.turnOn && !result.enabled);
    }
  });

  await checkAsync("两步验证别名：twosv 当前账号不匹配时零点击且保存的密钥不变", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    f.adapter.read = async () => inspectFixture(inspectDocument,
      twoStepAliasPage("开启两步验证", "other-fixture@example.com"),
      "https://myaccount.google.com/signinoptions/twosv");
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.strictEqual(f.stored.lastLoginCheck.reasonCode, "ok", "设置页身份异常不能覆盖已成功的登录结果");
    assert.deepStrictEqual(clicks(f), []);
    assertActivationOnly(f);
  });

  await checkAsync("两步验证别名：待启用账号经 DOM 夹具解析只开总开关，不重设旧密钥", async () => {
    for (const labels of [["Turn on 2-Step Verification", "Turn off 2-Step Verification"], ["开启两步验证", "关闭两步验证"]]) {
      const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
      const pages = { waiting: twoStepAliasPage(labels[0]), enabled: twoStepAliasPage(labels[1]) };
      let stage = "waiting";
      f.adapter.read = async () => inspectFixture(inspectDocument, pages[stage],
        "https://myaccount.google.com/signinoptions/twosv");
      f.adapter.click = async (selector) => {
        assert.strictEqual(stage, "waiting");
        const control = pages[stage].querySelector(selector);
        assert.ok(control, "必须点击当前快照给出的唯一控件");
        assert.strictEqual(control.innerText, labels[0]);
        f.calls.push(["click", "#turn-on"]);
        stage = "enabled";
      };
      const result = await runFlow(f.adapter, f.inputAccount);
      assert.strictEqual(result.outcome, "ok");
      assert.strictEqual(f.stored.lastTotpSetup.state, "added");
      assert.strictEqual(f.stored.pendingTotpSetup, null);
      assert.deepStrictEqual(clicks(f), ["#turn-on"]);
      assertActivationOnly(f);
    }
  });

  await checkAsync("两步验证别名：twosv 点击后按钮消失仍无成功证据时保留待启用和旧密钥", async () => {
    const f = fixture({ account: { totpSecret: FIXTURE_SECRET, lastTotpSetup: { state: "pending_activation" } } });
    const pages = { waiting: twoStepAliasPage("开启两步验证"), unconfirmed: twoStepAliasPage("") };
    let stage = "waiting";
    f.adapter.read = async () => inspectFixture(inspectDocument, pages[stage],
      "https://myaccount.google.com/signinoptions/twosv");
    f.adapter.click = async (selector) => {
      const control = pages[stage].querySelector(selector);
      assert.ok(control);
      assert.strictEqual(control.innerText, "开启两步验证");
      f.calls.push(["click", "#turn-on"]);
      stage = "unconfirmed";
    };
    const result = await runFlow(f.adapter, f.inputAccount);
    assert.strictEqual(result.outcome, "need_verify");
    assert.strictEqual(f.stored.lastTotpSetup.state, "pending_activation");
    assert.deepStrictEqual(clicks(f), ["#turn-on"]);
    assertActivationOnly(f);
  });

  await checkAsync("验证器页面识别：多个弹窗不继续，启用只匹配明确两步验证总开关", () => {
    const multi = domNode("body", "", {}, [
      domNode("div", "Authenticator", { role: "dialog" }, [domNode("button", "Next")]),
      domNode("div", "Confirm", { role: "dialog" }, [domNode("button", "Verify")]),
    ]);
    const result = inspectFixture(inspectDocument, multi);
    assert.strictEqual(result.blocked, true);
    assert.ok(!result.next && !result.verify && !result.codeInput);
    const url = "https://myaccount.google.com/signinoptions/two-step-verification?hl=en";
    const enabled = inspectFixture(inspectDocument, domNode("body", "", {}, [domNode("button", "Turn off 2-Step Verification")]), url);
    assert.strictEqual(enabled.enabled, true);
    assert.ok(!enabled.turnOn);
    const generic = inspectFixture(inspectDocument, domNode("body", "", {}, [domNode("button", "Turn on"), domNode("button", "Continue")]), url);
    assert.ok(!generic.enabled && !generic.turnOn);
    const onboarding = inspectFixture(inspectDocument, domNode("body", "", {}, [
      domNode("button", "Turn off 2-Step Verification"), domNode("div", "Other", { role: "dialog" }, []),
    ]), url);
    assert.strictEqual(onboarding.enabled, false, "遮挡对话框下不能断言总开关已确认");
  });
};
