"use strict";

const assert = require("assert");
const { inspectDocument } = require("../src/automation/actions/add-2fa").helpers;

// Inert DOM fixtures only: no browser, account store, network, or paid service.
const EMAIL = "activation-recognition@example.com";
const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/twosv?hl=en";
const PROTECTED = "You’re now protected with 2-Step Verification";

function node(tag = "div", text = "", attrs = {}, children = []) {
  const attributes = { ...attrs };
  const result = {
    parentElement: null, children, disabled: !!attrs.disabled, type: attrs.type || "text",
    get innerText() {
      return [text, ...children.filter((child) => child.getAttribute("hidden") === null)
        .map((child) => child.innerText)].filter(Boolean).join(" ");
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
          const value = result.getAttribute(attr[1]);
          if (value === null) return false;
          if (attr[2] === "=" && value !== attr[3]) return false;
          if (attr[2] === "*=" && !String(value).includes(attr[3])) return false;
        }
        return true;
      });
    },
    closest(selector) {
      for (let current = result; current; current = current.parentElement) {
        if (current.matches(selector)) return current;
      }
      return null;
    },
    querySelectorAll(selector) {
      return children.flatMap((child) => [child, ...child.querySelectorAll("*")])
        .filter((child) => child.matches(selector));
    },
    querySelector(selector) { return result.querySelectorAll(selector)[0] || null; },
  };
  children.forEach((child) => { child.parentElement = result; });
  return result;
}

function fixture({ title = "", content = [], prefix = "", profileAttrs = {}, email = EMAIL,
  semantic = true, headingAttrs = {}, headingTag = "h2" } = {}) {
  const profile = node("a", "", {
    href: "https://accounts.google.com/SignOutOptions?hl=en",
    "aria-label": `Google Account: Fixture (${email})`, ...profileAttrs,
  });
  const background = node("div", "", { "aria-hidden": "true" }, [
    node("header", "", {}, [profile]),
    node("main", "2-Step Verification", {}, [node("button", "Turn on 2-Step Verification")]),
  ]);
  const heading = semantic ? node(headingTag, title, headingAttrs) : null;
  const dialog = node("div", semantic ? "" : title, { role: "dialog", "aria-modal": "true" }, [
    ...(prefix ? [node("p", prefix)] : []), ...(heading ? [heading] : []), ...content,
  ]);
  return { body: node("body", "", {}, [background, dialog]), dialog, background, profile, heading };
}

function inspect(f, url = TWO_STEP_URL) {
  const previousDocument = global.document;
  const previousStyle = global.getComputedStyle;
  global.document = {
    body: f.body, location: new URL(url),
    querySelectorAll: (selector) => f.body.querySelectorAll(selector),
    querySelector: (selector) => f.body.querySelector(selector),
  };
  global.getComputedStyle = (element) => ({ display: "block", visibility: "visible", opacity: "1", ...element.fixtureStyle });
  try { return inspectDocument(); } finally {
    global.document = previousDocument;
    global.getComputedStyle = previousStyle;
  }
}

module.exports = async function runAdd2faRecognitionTests({ checkAsync }) {
  await checkAsync("两步验证识别：中英韩明确语义成功标题直接确认，前导说明不遮蔽标题", () => {
    const variants = [
      [PROTECTED, "Done"], [PROTECTED.replace("’", "'"), "Done"],
      ["2-Step Verification is on", "Done"], ["2-Step Verification is now on.", "OK"],
      ["two-step Verification has been turned on!", "Got it"],
      ["两步验证已开启", "完成"], ["两步验证已启用。", "确定"],
      ["兩步驟驗證已啟用", "確定"], ["兩步驟驗證已開啟", "知道了"],
      ["2단계 인증이 사용 설정되었습니다.", "완료"], ["2단계 인증 설정되었습니다", "확인"],
    ];
    for (const [title, label] of variants) {
      const done = node("button", label);
      const f = fixture({ title, prefix: "Review your account security settings.", content: [done] });
      const result = inspect(f);
      assert.strictEqual(result.dialog, "success", title);
      assert.strictEqual(result.activationConfirmed, true, title);
      assert.strictEqual(result.enabled, false, "弹窗成功不能伪装背景已出现关闭按钮");
      assert.strictEqual(result.accountEmail, EMAIL);
      assert.strictEqual(f.body.querySelector(result.dismiss), done);
      assert.ok(!result.turnOn && !result.confirmTurnOn && !result.skipPhone);
    }
  });

  await checkAsync("两步验证识别：明确确认标题优先于前导说明，只授权相应开启按钮", () => {
    for (const [title, label] of [
      ["Turn on 2-Step Verification?", "Turn on"], ["开启两步验证", "开启"],
      ["開啟兩步驟驗證", "開啟兩步驟驗證"], ["2단계 인증 사용 설정", "2단계 인증 사용 설정"],
    ]) {
      const confirm = node("button", label);
      const f = fixture({ title, prefix: "Review your account security settings.", content: [confirm] });
      const result = inspect(f);
      assert.strictEqual(result.dialog, "confirm", title);
      assert.strictEqual(result.activationConfirmed, false);
      assert.strictEqual(result.accountEmail, EMAIL);
      assert.strictEqual(f.body.querySelector(result.confirmTurnOn), confirm);
      assert.ok(!result.turnOn && !result.dismiss && !result.skipPhone);
    }
  });

  await checkAsync("两步验证识别：无语义标题仅保留精确 protected 回退，其余正文不是开启证据", () => {
    for (const title of ["2-Step Verification is on", "两步验证已开启", "2단계 인증이 사용 설정되었습니다"]) {
      const result = inspect(fixture({ title, semantic: false, content: [node("button", "Done")] }));
      assert.strictEqual(result.dialog, "success");
      assert.strictEqual(result.activationConfirmed, false, "正文形式需关闭提示后另行复核，不能直接记成功");
    }
    const protectedResult = inspect(fixture({ title: PROTECTED, semantic: false, content: [node("button", "Done")] }));
    assert.strictEqual(protectedResult.activationConfirmed, true);
    for (const title of [
      `After setup you will see ${PROTECTED}`, "You may see 2-Step Verification is on after setup",
      "完成后会显示：两步验证已开启", "当前说明：2단계 인증이 사용 설정되었습니다",
    ]) {
      const result = inspect(fixture({ title, semantic: false, content: [node("button", "Done")] }));
      assert.strictEqual(result.dialog, "unsupported");
      assert.ok(!result.activationConfirmed && !result.dismiss && !result.confirmTurnOn);
    }
  });

  await checkAsync("两步验证识别：否定、附加条件、问题和示例标题不得记为成功", () => {
    for (const title of [
      "2-Step Verification is not on", "2-Step Verification is on hold", "2-Step Verification is on?",
      "2-Step Verification is on if you complete setup", "2-Step Verification has been turned on elsewhere",
      "两步验证已开启后可以使用", "两步验证未开启", "兩步驟驗證已啟用？",
      "2단계 인증이 사용 설정되었습니다 예시", `${PROTECTED} not yet`,
      `Example: ${PROTECTED}`, "Turn off 2-Step Verification?",
    ]) {
      const result = inspect(fixture({ title, content: [node("button", "Done"), node("button", "Turn on")] }));
      assert.strictEqual(result.dialog, "unsupported", title);
      assert.ok(!result.activationConfirmed && !result.dismiss && !result.confirmTurnOn);
    }
  });

  await checkAsync("两步验证识别：正文和后续标题不能覆盖首个非成功语义标题", () => {
    for (const title of ["Review your account settings", "Confirm your identity"]) {
      const result = inspect(fixture({ title, prefix: PROTECTED, content: [
        node("p", "2-Step Verification is on"), node("h3", PROTECTED), node("button", "Done"),
      ] }));
      assert.strictEqual(result.dialog, "unsupported");
      assert.ok(!result.activationConfirmed && !result.dismiss);
    }
  });

  await checkAsync("两步验证识别：隐藏语义标题不能降级为可见正文成功证据", () => {
    for (const attrs of [{ hidden: "hidden" }, { "aria-hidden": "true" }]) {
      const result = inspect(fixture({ title: PROTECTED, headingAttrs: attrs, content: [node("button", "Done")] }));
      assert.strictEqual(result.dialog, "unsupported");
      assert.ok(!result.activationConfirmed && !result.dismiss);
    }
    const f = fixture({ title: "两步验证已开启", content: [node("button", "完成")] });
    f.heading.fixtureStyle = { display: "none" };
    assert.ok(!inspect(f).activationConfirmed);
  });

  await checkAsync("两步验证识别：成功标题不依赖 Done 可点击，但不可点击或重复按钮无选择器", () => {
    for (const content of [
      [], [node("button", "Done", { hidden: "hidden" })],
      [node("button", "Done", { "aria-hidden": "true" })], [node("button", "Done", { disabled: true })],
      [node("button", "Done", { "aria-disabled": "true" })], [node("button", "Done"), node("button", "Done")],
    ]) {
      const result = inspect(fixture({ title: "2-Step Verification is on", content }));
      assert.strictEqual(result.activationConfirmed, true);
      assert.strictEqual(result.dialog, "success");
      assert.ok(!result.dismiss && !result.turnOn && !result.confirmTurnOn);
    }
  });

  await checkAsync("两步验证识别：可选手机号按标题分类，禁用 Skip 只等待不生成点击选择器", () => {
    for (const attrs of [{ disabled: true }, { "aria-disabled": "true" }]) {
      const skip = node("button", "Skip", attrs);
      const f = fixture({ title: "Add a phone number for 2-Step Verification?",
        prefix: "Review your account security settings.", content: [node("button", "Add phone"), skip] });
      const waiting = inspect(f);
      assert.strictEqual(waiting.dialog, "optional_phone");
      assert.strictEqual(waiting.accountEmail, EMAIL);
      assert.ok(!waiting.skipPhone && !waiting.activationConfirmed && !waiting.confirmTurnOn);
      skip.disabled = false;
      skip.removeAttribute("disabled");
      skip.removeAttribute("aria-disabled");
      const ready = inspect(f);
      assert.strictEqual(ready.dialog, "optional_phone");
      assert.strictEqual(f.body.querySelector(ready.skipPhone), skip);
      assert.ok(!ready.activationConfirmed);
    }
  });

  await checkAsync("两步验证识别：手机号强制验证、未知 Skip、缺失重复隐藏按钮仍不支持", () => {
    const variants = [
      { title: "Verify your phone number", content: [node("button", "Add phone"), node("button", "Skip")] },
      { title: "Add a phone number for 2-Step Verification?", content: [node("input", "", { type: "tel" }), node("button", "Add phone"), node("button", "Skip")] },
      { title: "Add a phone number for 2-Step Verification?", content: [node("button", "Add phone")] },
      { title: "Add a phone number for 2-Step Verification?", content: [node("button", "Add phone"), node("button", "Skip"), node("button", "Skip")] },
      { title: "Add a phone number for 2-Step Verification?", content: [node("button", "Add phone"), node("button", "Skip", { hidden: "hidden" })] },
      { title: "Add a phone number for 2-Step Verification?", content: [node("button", "Skip")] },
    ];
    for (const variant of variants) {
      const result = inspect(fixture(variant));
      assert.strictEqual(result.dialog, "unsupported");
      assert.ok(!result.skipPhone && !result.activationConfirmed && !result.confirmTurnOn);
    }
  });

  await checkAsync("两步验证识别：成功或确认标题不跳过输入、强制手机号和付款内容", () => {
    for (const title of ["2-Step Verification is on", "Turn on 2-Step Verification?"]) {
      for (const extra of [
        node("input", "", { type: "tel" }), node("select"), node("div", "", { role: "textbox" }),
        node("p", "Add a phone number to continue"), node("p", "Confirm payment method"),
      ]) {
        const result = inspect(fixture({ title, content: [extra, node("button", "Done"), node("button", "Turn on")] }));
        assert.strictEqual(result.dialog, "unsupported");
        assert.ok(!result.activationConfirmed && !result.confirmTurnOn && !result.dismiss && !result.skipPhone);
      }
    }
  });

  await checkAsync("两步验证识别：语义识别仍限可信设置页和单一当前弹窗", () => {
    for (const url of [
      "https://outside-fixture.example/signinoptions/twosv", "http://myaccount.google.com/signinoptions/twosv",
      "https://myaccount.google.com.outside-fixture.example/signinoptions/twosv",
      "https://accounts.google.com/signin/challenge/totp",
      "https://myaccount.google.com/two-step-verification/authenticator",
      "https://myaccount.google.com/signinoptions/twosv/enroll-welcome",
    ]) {
      const result = inspect(fixture({ title: "2-Step Verification is on", content: [node("button", "Done")] }), url);
      assert.ok(!result.activationConfirmed && !result.dismiss, url);
    }
    const f = fixture({ title: "两步验证已开启", content: [node("button", "完成")] });
    const otherDialog = node("div", "Other dialog", { role: "dialog" });
    otherDialog.parentElement = f.body;
    f.body.children.push(otherDialog);
    const multi = inspect(f);
    assert.strictEqual(multi.blocked, true);
    assert.ok(!multi.activationConfirmed && !multi.dismiss);
  });

  await checkAsync("两步验证识别：识别成功不伪造目标身份，隐藏头像和冲突身份保持未确认", () => {
    for (const profileAttrs of [{ hidden: "hidden" }, { "aria-hidden": "true" }, { href: "https://outside-fixture.example/SignOutOptions", "aria-label": `Email ${EMAIL}` }]) {
      const result = inspect(fixture({ title: "两步验证已开启", profileAttrs, content: [node("button", "完成")] }));
      assert.strictEqual(result.accountEmail, "");
    }
    const different = inspect(fixture({ title: "2-Step Verification is on", email: "different@example.com", content: [node("button", "Done")] }));
    assert.strictEqual(different.accountEmail, "different@example.com", "交给 runFlow 的目标账号一致性保护，不能拿正文邮箱覆盖");
    const f = fixture({ title: "2-Step Verification is on", content: [node("p", EMAIL), node("button", "Done")] });
    const otherProfile = node("a", "", { href: "https://accounts.google.com/SignOutOptions", "aria-label": "Google Account: different@example.com" });
    otherProfile.parentElement = f.background;
    f.background.children.push(otherProfile);
    assert.strictEqual(inspect(f).accountEmail, "");
  });
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, test) => { await test(); passed += 1; console.log(`ok ${name}`); } })
    .then(() => console.log(`Passed ${passed} add-2fa recognition groups`))
    .catch((err) => { console.error(err); process.exitCode = 1; });
}
