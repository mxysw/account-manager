"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { handleLoginCaptcha, hasGoogleRejectionText } = require("../src/automation/login-captcha");

module.exports = async function run({ checkAsync }) {
  await checkAsync("登录 CAPTCHA 回调观察只在主动启用后注册，且先于导航", async () => {
    const { openLoginPage } = require("../src/automation/actions/login").helpers;
    const operations = [];
    const page = {
      evaluateOnNewDocument: async () => { operations.push("observer"); },
      goto: async () => { operations.push("navigate"); },
    };
    await openLoginPage(page, {});
    assert.deepEqual(operations, ["navigate"]);
    operations.length = 0;
    await openLoginPage(page, { captchaSolver: {} });
    assert.deepEqual(operations, ["observer", "navigate"]);
    operations.length = 0;
    await openLoginPage(page, { captchaSolver: {} });
    assert.deepEqual(operations, ["navigate"], "同一 page 不重复注册");
  });
  await checkAsync("登录页面诊断不包含查询参数、片段或 URL 中的密码", async () => {
    const { diagnosticPageUrl } = require("../src/automation/actions/login").helpers;
    assert.equal(diagnosticPageUrl("https://user:secret@accounts.google.com/v3/signin/challenge/recaptcha?TL=private#private"),
      "https://accounts.google.com/v3/signin/challenge/recaptcha");
    assert.equal(diagnosticPageUrl("not a URL"), "");
  });
  const account = { email: "fixture@example.com" };
  function fixture() {
    let url = "https://accounts.google.com/v3/signin/challenge/recaptcha";
    let visibleText = "Verify it's you";
    const snapshot = { present: true, supported: true, fingerprint: "fixture", checkboxFingerprint: "checkbox-fixture", challenge: { websiteURL: url } };
    const log = [];
    const calls = { solve: 0, submit: 0, next: 0 };
    const f = {
      page: {
        url: () => url,
        evaluate: async (fn, source) => vm.runInNewContext(`(${fn})(source)`, {
          URL, source, document: { location: { href: url }, body: { innerText: visibleText } },
        }),
      }, snapshot, calls, log,
      setURL: (value) => { url = value; },
      setText: (value) => { visibleText = value; },
      options: {
        forceCaptcha: true, emit: (type, data) => log.push({ type, data }),
        solver: { solve: async () => { calls.solve++; return { token: "fixture-token-not-for-logs" }; } },
      },
      deps: {
        inspect: async () => url === snapshot.challenge.websiteURL ? snapshot : { present: false, supported: false, reason: "unsupported_page" },
        submit: async () => { calls.submit++; return { submitted: true }; }, sleep: async () => {},
        advance: async () => { calls.next++; url = "https://myaccount.google.com/"; return { advanced: true }; },
      },
    };
    f.deps.inspectCheckbox = async () => {
      const snap = await f.deps.inspect();
      return snap.supported ? { state: "challenge", present: true, fingerprint: "checkbox-fixture" }
        : { state: snap.present ? "unsupported" : "absent", present: !!snap.present, reason: snap.reason || "challenge_missing" };
    };
    return f;
  }
  await checkAsync("CAPTCHA 无可见挑战时不收费、不提交", async () => {
    const f = fixture(); f.options.forceCaptcha = false; f.deps.inspect = async () => ({ present: false });
    assert.deepEqual(await handleLoginCaptcha(f.page, account, f.options, f.deps), { handled: false });
    assert.equal(f.calls.solve, 0);
  });
  await checkAsync("CAPTCHA 不支持或本账号已尝试时不收费", async () => {
    const f = fixture(); f.snapshot.supported = false; f.snapshot.reason = "account_mismatch";
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, false);
    f.snapshot.supported = true; f.options.attempted = true;
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, false);
    assert.equal(f.calls.solve, 0);
  });
  await checkAsync("CAPTCHA 真正离开挑战才继续登录，token 不进入日志", async () => {
    const f = fixture();
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.deepEqual(f.calls, { solve: 1, submit: 1, next: 1 });
    assert.ok(f.log.some(x => x.type === "captcha_accepted"));
    assert.ok(!JSON.stringify(f.log).includes("fixture-token"));
  });
  await checkAsync("CAPTCHA token 返回但 Google 未放行不能算成功或重复收费", async () => {
    const f = fixture(); f.deps.advance = async () => { f.calls.next++; return { advanced: true }; };
    const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.equal(result.resumed, false);
    assert.match(result.message, /Google 未确认通过/);
    assert.deepEqual(f.calls, { solve: 1, submit: 1, next: 1 });
    assert.ok(!f.log.some(x => x.type === "captcha_accepted"));
  });
  await checkAsync("CAPTCHA 通过后进入手机号页应恢复登录识别，不误报打码未通过", async () => {
    for (const path of ["/v3/signin/challenge/iap", "/v3/signin/challenge/ipp", "/v3/signin/challenge/ipp/consent", "/v3/signin/challenge/kpe"]) {
      const f = fixture(); let moved = false;
      f.deps.submit = async () => { f.calls.submit++; moved = true; return { submitted: true }; };
      f.page.url = () => moved ? `https://accounts.google.com${path}` : f.snapshot.challenge.websiteURL;
      f.deps.inspect = async () => moved
        ? { present: false, supported: false, reason: "challenge_missing" } : f.snapshot;
      const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
      assert.equal(result.resumed, true);
      assert.deepEqual(f.calls, { solve: 1, submit: 1, next: 0 });
      assert.ok(f.log.some(x => x.type === "captcha_accepted"));
    }
  });
  await checkAsync("CAPTCHA 页面变化时不点击下一步", async () => {
    const f = fixture(); f.deps.submit = async () => ({ submitted: false });
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, false);
    assert.equal(f.calls.next, 0);
  });
  await checkAsync("CAPTCHA provider 原始错误与 token 不回显", async () => {
    const f = fixture(); f.options.solver.solve = async () => { throw Object.assign(new Error("CAP-secret-should-not-leak"), { code: "ERROR_TASK_TIMEOUT" }); };
    const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.match(result.message, /ERROR_TASK_TIMEOUT/);
    assert.ok(!JSON.stringify({ result, log: f.log }).includes("CAP-secret"));
  });
  await checkAsync("CAPTCHA 取消后不回填迟到 token", async () => {
    const f = fixture(); const controller = new AbortController(); f.options.signal = controller.signal;
    const solution = { token: "late-token" };
    f.options.solver.solve = async () => { controller.abort(); return solution; };
    await assert.rejects(handleLoginCaptcha(f.page, account, f.options, f.deps), { name: "AbortError" });
    assert.equal(f.calls.submit, 0); assert.equal(f.calls.next, 0);
    assert.equal(solution.token, "", "取消路径也必须清空迟到的验证码");
  });
  await checkAsync("CAPTCHA 页面读取失败不算 Google 已接受", async () => {
    const f = fixture(); let submitted = false;
    f.deps.submit = async () => { submitted = true; return { submitted: true }; };
    f.deps.inspect = async () => submitted ? { present: false, supported: false, reason: "evaluation_timeout" } : f.snapshot;
    f.page.url = () => submitted ? "https://accounts.google.com/v3/signin/challenge/pwd" : f.snapshot.challenge.websiteURL;
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, false);
    assert.ok(!f.log.some(x => x.type === "captcha_accepted"));
  });
  await checkAsync("CAPTCHA 新挑战路径尚未挂载不能误报放行", async () => {
    const f = fixture(); let submitted = false;
    f.deps.submit = async () => { submitted = true; return { submitted: true }; };
    f.deps.inspect = async () => submitted ? { present: false, supported: false, reason: "challenge_missing" } : f.snapshot;
    f.page.url = () => submitted ? "https://accounts.google.com/v3/signin/challenge/recaptcha/retry" : f.snapshot.challenge.websiteURL;
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, false);
    assert.ok(!f.log.some(x => x.type === "captcha_accepted"));
  });
  await checkAsync("CAPTCHA 延迟挂载只等待，不提前收费或误判", async () => {
    const f = fixture(); let reads = 0;
    const inspect = f.deps.inspect;
    f.deps.inspect = async () => ++reads < 3 ? { supported: false, present: false, reason: "challenge_missing" } : inspect();
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.equal(f.calls.solve, 1);
  });
  await checkAsync("CAPTCHA 诊断只记录回调类别和布尔状态，不记录挑战参数", async () => {
    const f = fixture();
    f.snapshot.callbackSource = "observed";
    f.snapshot.challenge.dataS = "private-challenge-param";
    f.deps.submit = async () => ({ submitted: true, callbackInvoked: true });
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.deepEqual(f.log.find(x => x.type === "captcha_inspecting").data, { callbackSource: "observed", hasDataS: true });
    assert.deepEqual(f.log.find(x => x.type === "captcha_submitted").data, { callbackSource: "observed", callbackInvoked: true });
    assert.ok(!JSON.stringify(f.log).includes("private-challenge-param"));
    f.snapshot.callbackSource = "private-unexpected-value";
    f.log.length = 0;
    await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.ok(!JSON.stringify(f.log).includes("private-unexpected-value"));
  });

  function freeFixture(initial = "unchecked") {
    const f = fixture();
    let state = initial;
    f.free = { click: 0, next: 0, attempts: 0, waits: 0 };
    f.setState = (value) => { state = value; };
    f.options.onPreflightAttempt = () => { f.free.attempts++; };
    f.deps.inspectCheckbox = async () => f.page.url() === f.snapshot.challenge.websiteURL
      ? { state, present: state !== "absent", fingerprint: "checkbox-fixture", reason: state === "absent" ? "challenge_missing" : "fixture" }
      : { state: "absent", present: false, reason: "unsupported_page" };
    f.deps.clickCheckbox = async () => { f.free.click++; state = "passed"; return { clicked: true }; };
    f.deps.advanceCheckbox = async () => { f.free.next++; f.setURL("https://myaccount.google.com/"); return { advanced: true }; };
    f.deps.sleep = async () => { f.free.waits++; };
    return f;
  }
  const runFree = (f) => handleLoginCaptcha(f.page, account, f.options, f.deps);
  function assertDetectionFailure(f, result, reason, beforeChallenge = true) {
    assert.equal(result.handled, true);
    assert.equal(result.resumed, false);
    assert.equal(result.reasonCode, "captcha_detection_failed");
    assert.match(result.message, /检测异常/);
    assert.deepEqual(f.calls, { solve: 0, submit: 0, next: 0 });
    assert.equal(f.free.next, 0);
    assert.deepEqual(f.log.find(x => x.type === "login_detection_failed")?.data, { reason });
    assert.ok(!f.log.some(x => ["captcha_failed", "captcha_accepted", "captcha_solving"].includes(x.type)));
    if (beforeChallenge) {
      assert.equal(f.free.click, 0);
      assert.equal(f.free.attempts, 0);
      assert.ok(!f.log.some(x => x.type.startsWith("captcha_")));
    }
  }
  await checkAsync("普通密码和 TOTP 页无控件时继续，不创建人机状态或打码尝试", async () => {
    for (const path of ["pwd", "totp"]) {
      const f = freeFixture();
      f.setURL(`https://accounts.google.com/v3/signin/challenge/${path}`);
      f.options.forceCaptcha = false;
      f.deps.inspectCheckbox = async () => ({ state: "absent", present: false, reason: "challenge_missing" });
      assert.deepEqual(await runFree(f), { handled: false });
      assert.deepEqual(f.calls, { solve: 0, submit: 0, next: 0 });
      assert.deepEqual(f.free, { click: 0, next: 0, attempts: 0, waits: 0 });
      assert.deepEqual(f.log, []);
    }
  });
  await checkAsync("无控件但账号真正不匹配时安全停止，不能标记人机验证", async () => {
    for (const forceCaptcha of [false, true]) {
      const f = freeFixture();
      f.options.forceCaptcha = forceCaptcha;
      f.deps.inspectCheckbox = async () => ({ state: "unsupported", present: false, reason: "account_mismatch" });
      assertDetectionFailure(f, await runFree(f), "account_mismatch");
    }
  });
  await checkAsync("无控件页面读取失败或超时只报告检测异常，原始内容不泄漏", async () => {
    for (const observation of [null,
      { state: "unsupported", present: false, reason: "evaluation_failed" },
      { state: "error", present: false, reason: "evaluation_timeout" },
      { state: "unsupported", present: false, reason: "private-diagnostic-content" },
      "throw",
    ]) {
      const f = freeFixture();
      f.options.forceCaptcha = false;
      f.deps.inspectCheckbox = async () => {
        if (observation === "throw") throw new Error("private-diagnostic-content");
        return observation;
      };
      const result = await runFree(f);
      const expected = observation?.reason === "evaluation_timeout" ? "evaluation_timeout"
        : observation?.reason === "private-diagnostic-content" ? "observation_failed" : "evaluation_failed";
      assertDetectionFailure(f, result, expected);
      assert.ok(!JSON.stringify({ result, log: f.log }).includes("private-diagnostic-content"));
    }
  });
  await checkAsync("仅路径或文字提示人机但控件始终缺失时有限等待，不误标已发现人机", async () => {
    const f = freeFixture("absent");
    assertDetectionFailure(f, await runFree(f), "challenge_missing");
    assert.equal(f.free.waits, 5);
  });
  await checkAsync("已见控件后读取异常与真实控件过期分开，均不付费", async () => {
    for (const reason of ["evaluation_timeout", "evaluation_failed", "checkbox_expired", "checkbox_error"]) {
      const f = freeFixture();
      f.deps.inspectCheckbox = async () => f.free.click
        ? { state: "error", present: false, reason }
        : { state: "unchecked", present: true, fingerprint: "checkbox-fixture" };
      const result = await runFree(f);
      if (reason.startsWith("evaluation_")) assertDetectionFailure(f, result, reason, false);
      else {
        assert.equal(result.resumed, false);
        assert.equal(result.reasonCode, undefined);
        assert.match(result.message, /错误或已过期/);
        assert.ok(f.log.some(x => x.type === "captcha_failed"));
      }
      assert.equal(f.free.click, 1);
      assert.equal(f.free.next, 0);
      assert.equal(f.calls.solve, 0);
    }
  });
  await checkAsync("可见但不支持的人机控件仍安全停止，不误报登录成功或额外收费", async () => {
    const f = freeFixture();
    f.deps.inspectCheckbox = async () => ({ state: "unsupported", present: true, reason: "frame_missing" });
    const result = await runFree(f);
    assert.equal(result.resumed, false);
    assert.equal(result.reasonCode, undefined);
    assert.match(result.message, /已发现人机验证控件/);
    assert.deepEqual(f.calls, { solve: 0, submit: 0, next: 0 });
    assert.equal(f.free.click, 0);
    assert.ok(f.log.some(x => x.type === "captcha_failed"));
  });
  function assertFree(f, result) {
    assert.equal(result.resumed, true);
    assert.deepEqual(f.calls, { solve: 0, submit: 0, next: 0 });
    assert.ok(f.log.some(x => x.type === "captcha_free_accepted"));
    assert.ok(!f.log.some(x => x.type === "captcha_solving"));
    assert.equal(f.free.attempts, 1);
  }
  await checkAsync("CAPTCHA 复选框一次勾选并点下一步免费通过，不触碰付费提交", async () => {
    const f = freeFixture();
    assertFree(f, await runFree(f));
    assert.equal(f.free.click, 1); assert.equal(f.free.next, 1);
    assert.deepEqual(f.log.map(x => x.type), ["captcha_checkbox_checking", "captcha_checkbox_clicked", "captcha_checkbox_passed", "captcha_accepted", "captcha_free_accepted"]);
  });
  await checkAsync("CAPTCHA 复选框直接跳转不再点击下一步，绿勾已有时不重复勾选", async () => {
    const direct = freeFixture();
    direct.deps.clickCheckbox = async () => { direct.free.click++; direct.setURL("https://myaccount.google.com/"); return { clicked: true }; };
    assertFree(direct, await runFree(direct));
    assert.equal(direct.free.click, 1); assert.equal(direct.free.next, 0);
    const checked = freeFixture("passed");
    assertFree(checked, await runFree(checked));
    assert.equal(checked.free.click, 0); assert.equal(checked.free.next, 1);
  });
  await checkAsync("CAPTCHA 复选框无响应或持续转圈只等待，超时不收费不重复点击", async () => {
    for (const state of ["unchecked", "checking"]) {
      const f = freeFixture(state);
      f.deps.clickCheckbox = async () => { f.free.click++; return { clicked: true }; };
      const result = await runFree(f);
      assert.equal(result.resumed, false); assert.match(result.message, /超时.*未调用打码/);
      assert.equal(f.free.click, state === "unchecked" ? 1 : 0);
      assert.equal(f.free.next, 0); assert.equal(f.calls.solve, 0);
      assert.ok(f.free.waits <= 30);
    }
  });
  await checkAsync("CAPTCHA 仅绿勾或点击下一步没有实际跳转不能算完成", async () => {
    const f = freeFixture("passed");
    f.deps.advanceCheckbox = async () => { f.free.next++; return { advanced: true }; };
    assert.equal((await runFree(f)).resumed, false);
    assert.equal(f.free.next, 1); assert.equal(f.calls.solve, 0);
    assert.ok(!f.log.some(x => x.type === "captcha_free_accepted"));
  });
  await checkAsync("CAPTCHA 真实挑战才调用一次solver，免费观察不消耗付费次数", async () => {
    const f = freeFixture();
    f.deps.clickCheckbox = async () => { f.free.click++; f.setState("challenge"); return { clicked: true }; };
    let paidAttempts = 0;
    f.options.onAttempt = () => { paidAttempts++; };
    assert.equal((await runFree(f)).resumed, true);
    assert.equal(f.free.click, 1); assert.equal(f.free.next, 0); assert.equal(paidAttempts, 1);
    assert.deepEqual(f.calls, { solve: 1, submit: 1, next: 1 });
    assert.ok(f.log.some(x => x.type === "captcha_checkbox_challenge"));
    assert.ok(!f.log.some(x => x.type === "captcha_free_accepted"));
  });
  await checkAsync("CAPTCHA 付费前再次检查已变绿勾时回到免费分支", async () => {
    const f = freeFixture("challenge");
    f.deps.inspect = async () => { f.setState("passed"); return f.snapshot; };
    assertFree(f, await runFree(f));
    assert.equal(f.free.click, 0); assert.equal(f.free.next, 1);
  });
  await checkAsync("CAPTCHA 错误、账号不匹配或读取失败绝不触发点击和付费", async () => {
    for (const state of ["error", "unsupported"]) {
      const f = freeFixture(state);
      assert.equal((await runFree(f)).resumed, false);
      assert.equal(f.free.click, 0); assert.equal(f.free.next, 0); assert.equal(f.calls.solve, 0);
    }
    const f = freeFixture();
    f.deps.inspectCheckbox = async () => { throw new Error("private-page-error"); };
    const result = await runFree(f);
    assert.equal(result.resumed, false); assert.equal(f.calls.solve, 0);
    assert.ok(!JSON.stringify(result).includes("private-page-error"));
  });
  await checkAsync("CAPTCHA 免费通过过一次不会阻止后续独立挑战", async () => {
    const f = freeFixture(); f.options.preflightAttempted = true;
    const result = await runFree(f);
    assert.equal(result.resumed, true);
    assert.equal(f.free.click, 1); assert.equal(f.free.next, 1); assert.equal(f.calls.solve, 0);
  });
  await checkAsync("CAPTCHA 免费通过后进入手机号关卡应交还登录分类而非误判失败", async () => {
    for (const path of ["iap", "ipp", "ipp/consent", "totp", "ipe", "kpe", "recoveryemail", "dp", "ootp", "idvpin"]) {
      const f = freeFixture();
      f.deps.clickCheckbox = async () => { f.free.click++; f.setURL(`https://accounts.google.com/v3/signin/challenge/${path}`); return { clicked: true }; };
      assertFree(f, await runFree(f));
      assert.equal(f.free.next, 0);
    }
  });
  await checkAsync("CAPTCHA 免费路径拒绝新挑战空壳和不可信跳转", async () => {
    for (const target of ["https://accounts.google.com/v3/signin/challenge/recaptcha/retry", "https://other.example/", "https://accounts.google.com/v3/signin/rejected"]) {
      const f = freeFixture();
      f.deps.clickCheckbox = async () => { f.free.click++; f.setURL(target); return { clicked: true }; };
      assert.equal((await runFree(f)).resumed, false); assert.equal(f.calls.solve, 0);
      assert.ok(!f.log.some(x => x.type === "captcha_free_accepted"));
    }
  });
  await checkAsync("CAPTCHA 取消后不点击Next、不调用solver，包括检查和点击的迟到结果", async () => {
    for (const where of ["read", "click", "challenge"]) {
      const f = freeFixture(where === "challenge" ? "challenge" : "unchecked");
      const controller = new AbortController(); f.options.signal = controller.signal;
      if (where === "read") f.deps.inspectCheckbox = async () => { controller.abort(); return { state: "unchecked", present: true }; };
      if (where === "click") f.deps.clickCheckbox = async () => { controller.abort(); return { clicked: true }; };
      if (where === "challenge") f.deps.inspect = async () => { controller.abort(); return f.snapshot; };
      await assert.rejects(runFree(f), { name: "AbortError" });
      assert.equal(f.free.next, 0); assert.equal(f.calls.solve, 0);
    }
  });
  await checkAsync("CAPTCHA 绿勾后下一步晚挂载只等待并继续，实际点击仍只一次", async () => {
    const f = freeFixture("passed"); let checks = 0;
    const advance = f.deps.advanceCheckbox;
    f.deps.advanceCheckbox = async () => ++checks < 3
      ? { advanced: false, attempted: false, reason: checks === 1 ? "next_missing" : "next_disabled" }
      : advance();
    assertFree(f, await runFree(f));
    assert.equal(checks, 3); assert.equal(f.free.next, 1);
  });
  await checkAsync("CAPTCHA 加载等待期间直接放行保留初始路径，不误报超时", async () => {
    const f = freeFixture(); let reads = 0;
    f.deps.inspectCheckbox = async () => ++reads === 1
      ? { state: "absent", present: false, reason: "challenge_missing" }
      : { state: "absent", present: false, reason: "unsupported_page" };
    f.deps.sleep = async () => { f.setURL("https://accounts.google.com/v3/signin/challenge/totp"); };
    assertFree(f, await runFree(f));
    assert.equal(f.free.click, 0); assert.equal(f.free.next, 0);
  });
  await checkAsync("CAPTCHA 同URL挑战被替换时不得为旧挑战付费", async () => {
    const f = freeFixture("challenge"); let reads = 0;
    f.deps.inspectCheckbox = async () => ({ state: "challenge", present: true, fingerprint: ++reads === 1 ? "old" : "new" });
    const result = await runFree(f);
    assert.equal(result.resumed, false); assert.match(result.message, /挑战已变化/);
    assert.equal(f.calls.solve, 0); assert.equal(f.calls.submit, 0);
  });
  await checkAsync("CAPTCHA 打码元数据必须绑定当前复选框挑战，缺失或不一致不收费", async () => {
    for (const value of [undefined, "stale-widget"]) {
      const f = freeFixture("challenge"); f.snapshot.checkboxFingerprint = value;
      const result = await runFree(f);
      assert.equal(result.resumed, false); assert.match(result.message, /挑战数据已变化/);
      assert.equal(f.calls.solve, 0);
    }
  });

  function retryFixture(limit = 3) {
    const f = fixture();
    f.options.solver.maxAttemptsPerAccount = limit;
    f.options.solver.getAttemptCount = () => f.calls.solve;
    return f;
  }
  await checkAsync("明确拒绝文字只识别 Google 可信来源，一般验证身份提示不误杀", async () => {
    const trusted = "https://accounts.google.com/v3/signin/challenge/recaptcha";
    for (const text of ["We couldn’t verify it’s you", "Couldn't verify it's you", "无法验证是您本人", "未能验证是你本人"]) {
      assert.equal(hasGoogleRejectionText(text, trusted), true);
      assert.equal(hasGoogleRejectionText(text, "https://other.example/"), false);
      assert.equal(hasGoogleRejectionText(text, "https://accounts.google.com.other.example/"), false);
    }
    for (const text of ["Verify it's you", "Verify your identity", "验证身份", "确认是你本人"]) {
      assert.equal(hasGoogleRejectionText(text, trusted), false);
    }
  });
  await checkAsync("同路径已显示明确拒绝时不点击人机或发起首次付费请求", async () => {
    for (const text of ["We couldn’t verify it’s you", "无法验证是您本人"]) {
      const f = retryFixture(); f.setText(text + " private-page-content");
      const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
      assert.equal(result.resumed, false); assert.match(result.message, /Google 拒绝/);
      assert.deepEqual(f.calls, { solve: 0, submit: 0, next: 0 });
      assert.ok(!JSON.stringify({ result, log: f.log }).includes("private-page-content"));
    }
  });
  await checkAsync("首次付费后同路径显示拒绝文字立即停止，不点击下一步或第二次付费", async () => {
    const f = retryFixture();
    f.deps.submit = async () => {
      f.calls.submit++; f.setText("We couldn't verify it's you private-page-content"); return { submitted: true };
    };
    const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.equal(result.resumed, false); assert.match(result.message, /Google 拒绝/);
    assert.deepEqual(f.calls, { solve: 1, submit: 1, next: 0 });
    assert.ok(!f.log.some(x => x.type === "captcha_retrying"));
    assert.ok(!JSON.stringify({ result, log: f.log }).includes("private-page-content"));
  });
  await checkAsync("明确拒绝读取失败或被取消时不发起付费请求", async () => {
    const unreadable = retryFixture();
    unreadable.page.evaluate = async () => { throw new Error("private-read-error"); };
    const result = await handleLoginCaptcha(unreadable.page, account, unreadable.options, unreadable.deps);
    assert.equal(result.resumed, false); assert.match(result.message, /检测异常/);
    assert.equal(result.reasonCode, "captcha_detection_failed");
    assert.equal(unreadable.calls.solve, 0);
    assert.ok(!JSON.stringify(result).includes("private-read-error"));
    const cancelled = retryFixture(); const controller = new AbortController(); cancelled.options.signal = controller.signal;
    cancelled.page.evaluate = async () => { controller.abort(); return false; };
    await assert.rejects(handleLoginCaptcha(cancelled.page, account, cancelled.options, cancelled.deps), { name: "AbortError" });
    assert.equal(cancelled.calls.solve, 0); assert.equal(cancelled.calls.submit, 0);
  });
  await checkAsync("每账号设置三次，首次成功仅发起一次并立即继续", async () => {
    const f = retryFixture();
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.equal(f.calls.solve, 1);
    assert.ok(!f.log.some(x => x.type === "captcha_retrying"));
  });
  await checkAsync("第二次打码通过后结束重试，每次使用新快照和新token", async () => {
    const f = retryFixture(); const snapshots = []; const tokens = []; const counts = [];
    const originalInspect = f.deps.inspect;
    f.deps.inspect = async () => ({ ...await originalInspect() });
    f.options.onAttempt = count => counts.push(count);
    f.options.solver.solve = async () => ({ token: `fixture-token-${++f.calls.solve}` });
    f.deps.submit = async (_page, snapshot, token) => {
      f.calls.submit++; snapshots.push(snapshot); tokens.push(token); return { submitted: true };
    };
    f.deps.advance = async () => {
      if (++f.calls.next === 2) f.setURL("https://myaccount.google.com/");
      return { advanced: true };
    };
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.deepEqual(f.calls, { solve: 2, submit: 2, next: 2 });
    assert.notEqual(snapshots[0], snapshots[1]);
    assert.notEqual(tokens[0], tokens[1]);
    assert.deepEqual(counts, [1, 2]);
    assert.equal(f.log.filter(x => x.type === "captcha_retrying").length, 1);
    assert.ok(!JSON.stringify(f.log).includes("fixture-token"));
  });
  await checkAsync("持续可识别挑战最多打码三次，耗尽后不发起第四次", async () => {
    const f = retryFixture();
    f.deps.advance = async () => { f.calls.next++; return { advanced: true }; };
    const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.equal(result.resumed, false);
    assert.match(result.message, /3\/3.*每账号最多 3 次/);
    assert.deepEqual(f.calls, { solve: 3, submit: 3, next: 3 });
    assert.equal(f.log.filter(x => x.type === "captcha_retrying").length, 2);
  });
  await checkAsync("打码识别失败可按账号预算重试，并在第三次通过时继续", async () => {
    const f = retryFixture();
    f.options.solver.solve = async () => {
      if (++f.calls.solve < 3) throw Object.assign(new Error("private-error"), { code: "ERROR_CAPTCHA_UNSOLVABLE" });
      return { token: "fixture-third-token" };
    };
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.deepEqual(f.calls, { solve: 3, submit: 1, next: 1 });
  });
  await checkAsync("余额密钥限流及请求结果不明时结束账号，不连续创建任务", async () => {
    for (const code of ["ERROR_ZERO_BALANCE", "ERROR_KEY_DENIED_ACCESS", "ERROR_RATE_LIMIT", "CAPSOLVER_CONFIG_OUTDATED", "CAPSOLVER_NETWORK_ERROR", "CAPSOLVER_REQUEST_TIMEOUT"]) {
      const f = retryFixture();
      f.options.solver.solve = async () => { f.calls.solve++; throw Object.assign(new Error("private-error"), { code }); };
      const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
      assert.equal(result.resumed, false); assert.match(result.message, new RegExp(code));
      assert.equal(f.calls.solve, 1); assert.equal(f.calls.submit, 0);
      assert.ok(!f.log.some(x => x.type === "captcha_retrying"));
    }
  });
  await checkAsync("Google拒绝登录或账号变化时不使用剩余次数", async () => {
    const f = retryFixture();
    f.deps.advance = async () => { f.calls.next++; f.setURL("https://accounts.google.com/v3/signin/rejected"); return { advanced: true }; };
    const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.equal(result.resumed, false); assert.match(result.message, /Google 拒绝/);
    assert.equal(f.calls.solve, 1);
    const changed = retryFixture();
    changed.deps.submit = async () => ({ submitted: false, reason: "account_mismatch" });
    assert.equal((await handleLoginCaptcha(changed.page, account, changed.options, changed.deps)).resumed, false);
    assert.equal(changed.calls.solve, 1);
  });
  await checkAsync("重试等待时迟到放行不再付费，也不误标为免费通过", async () => {
    const f = retryFixture();
    f.deps.advance = async () => { f.calls.next++; return { advanced: true }; };
    f.deps.sleep = async ms => { if (ms === 1000) f.setURL("https://myaccount.google.com/"); };
    assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
    assert.equal(f.calls.solve, 1);
    assert.ok(!f.log.some(x => x.type === "captcha_free_accepted"));
  });
  await checkAsync("失败后挑战控件错误或加载不明不会额外付费", async () => {
    for (const state of ["error", "unsupported", "checking"]) {
      const f = retryFixture();
      const original = f.deps.inspectCheckbox;
      f.deps.inspectCheckbox = async () => f.calls.solve ? { state, present: true, reason: "fixture-error" } : original();
      f.options.solver.solve = async () => { f.calls.solve++; throw Object.assign(new Error("private"), { code: "ERROR_CAPTCHA_UNSOLVABLE" }); };
      assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, false);
      assert.equal(f.calls.solve, 1);
    }
  });
  await checkAsync("重试间取消立即停止，不消耗第二次额度", async () => {
    const f = retryFixture(); const controller = new AbortController(); f.options.signal = controller.signal;
    f.options.solver.solve = async () => { f.calls.solve++; throw Object.assign(new Error("private"), { code: "ERROR_CAPTCHA_UNSOLVABLE" }); };
    f.deps.sleep = async ms => { if (ms === 1000) controller.abort(); };
    await assert.rejects(handleLoginCaptcha(f.page, account, f.options, f.deps), { name: "AbortError" });
    assert.equal(f.calls.solve, 1); assert.equal(f.calls.submit, 0);
  });
  await checkAsync("同账号跨多个挑战共享三次预算，后续调用不能重置", async () => {
    const f = retryFixture();
    for (let i = 1; i <= 3; i++) {
      f.setURL(f.snapshot.challenge.websiteURL);
      assert.equal((await handleLoginCaptcha(f.page, account, f.options, f.deps)).resumed, true);
      assert.equal(f.calls.solve, i);
    }
    f.setURL(f.snapshot.challenge.websiteURL);
    const result = await handleLoginCaptcha(f.page, account, f.options, f.deps);
    assert.equal(result.resumed, false); assert.match(result.message, /3\/3/);
    assert.equal(f.calls.solve, 3);
  });
  await checkAsync("付费次数耗尽后仍可免费勾选通过，手机号页不再打码", async () => {
    const f = freeFixture();
    f.options.solver.maxAttemptsPerAccount = 3;
    f.options.solver.getAttemptCount = () => 3;
    assert.equal((await runFree(f)).resumed, true);
    assert.equal(f.calls.solve, 0);
    const phone = retryFixture();
    phone.deps.advance = async () => { phone.calls.next++; phone.setURL("https://accounts.google.com/v3/signin/challenge/iap"); return { advanced: true }; };
    assert.equal((await handleLoginCaptcha(phone.page, account, phone.options, phone.deps)).resumed, true);
    assert.equal(phone.calls.solve, 1);
  });
};
