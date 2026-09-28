"use strict";

const assert = require("assert");
const { AdsPower } = require("../src/automation/adspower");

module.exports = async function run({ checkAsync }) {
  const profileId = "fixture-profile-id";
  const marker = "fixture-marker-1234";

  await checkAsync("AdsPower V2：创建临时环境只发送内部标记，不发送站点凭据", async () => {
    const ads = new AdsPower({ base: "http://127.0.0.1:50360", apiKey: "fixture-api-key" });
    let calls = 0;
    ads._request = async (method, pathname, query, body) => {
      calls += 1;
      assert.strictEqual(method, "POST");
      assert.strictEqual(pathname, "/api/v2/browser-profile/create");
      assert.deepStrictEqual(query, {});
      assert.deepStrictEqual(body, {
        group_id: "0",
        name: `am-temp-${marker}`,
        remark: `account-manager-owned:${marker}`,
        username: `am-temp-${marker}`,
        user_proxy_config: { proxy_soft: "no_proxy" },
        fingerprint_config: { screen_resolution: "none" },
      });
      for (const forbidden of ["password", "fakey", "cookie", "platform", "platform_account"]) {
        assert.ok(!Object.hasOwn(body, forbidden));
      }
      return { code: 0, data: { profile_id: profileId, profile_no: "105" } };
    };
    assert.deepStrictEqual(await ads.createTempProfile({ marker }), { profileId, profileNo: "105", marker });
    assert.strictEqual(calls, 1);
    assert.ok(ads.ownedProfileIds.has(profileId));
  });

  await checkAsync("AdsPower V2：仅精确自有 ID 可启动、关闭、查状态、删除", async () => {
    const ads = new AdsPower({ base: "http://127.0.0.1:50360", ownedProfileIds: [profileId] });
    const calls = [];
    ads._request = async (method, pathname, query, body, timeoutMs) => {
      calls.push({ method, pathname, query, body, timeoutMs });
      if (pathname.endsWith("/start")) return { code: 0, data: { ws: { selenium: "127.0.0.1:9222" } } };
      if (pathname.endsWith("/active")) return { code: 0, data: { status: "Inactive" } };
      return { code: 0, data: {} };
    };
    assert.deepStrictEqual(await ads.startProfile(profileId), { profileId, cdpEndpoint: "http://127.0.0.1:9222" });
    assert.deepStrictEqual(await ads.stopProfile(profileId), { profileId, stopped: true });
    assert.deepStrictEqual(await ads.profileStatus(profileId), { profileId, status: "Inactive" });
    assert.deepStrictEqual(await ads.deleteProfile(profileId), { profileId, deleted: true });
    assert.deepStrictEqual(calls.map(({ method, pathname, query, body }) => ({ method, pathname, query, body })), [
      { method: "POST", pathname: "/api/v2/browser-profile/start", query: {}, body: { profile_id: profileId, password_filling: "0", password_saving: "0" } },
      { method: "POST", pathname: "/api/v2/browser-profile/stop", query: {}, body: { profile_id: profileId } },
      { method: "GET", pathname: "/api/v2/browser-profile/active", query: { profile_id: profileId }, body: undefined },
      { method: "GET", pathname: "/api/v2/browser-profile/active", query: { profile_id: profileId }, body: undefined },
      { method: "POST", pathname: "/api/v2/browser-profile/delete", query: {}, body: { profile_id: [profileId] } },
    ]);
    assert.strictEqual(calls[0].timeoutMs, 90000);
    assert.ok(ads.ownedProfileIds.has(profileId), "客户端删除后保留授权，待账本持久确认后再清理");
  });

  await checkAsync("AdsPower V2：未知 ID 在任何网络请求前被拒绝", async () => {
    const ads = new AdsPower({ base: "http://127.0.0.1:50360", ownedProfileIds: [profileId] });
    ads._request = () => { throw new Error("不应发起网络请求"); };
    for (const method of ["startProfile", "stopProfile", "profileStatus", "deleteProfile"]) {
      await assert.rejects(ads[method]("another-profile-id"), /仅允许操作本系统创建的临时环境/);
      await assert.rejects(ads[method]("*"), /仅允许操作本系统创建的临时环境/);
    }
    assert.throws(() => new AdsPower({ base: "http://127.0.0.1:50360", ownedProfileIds: [""] }), /profile_id/);
  });

  await checkAsync("AdsPower V2：仍打开时不删除，关闭失败后仍可重试", async () => {
    const ads = new AdsPower({ base: "http://127.0.0.1:50360", ownedProfileIds: [profileId] });
    let status = "Active";
    let deleteCalls = 0;
    ads._request = async (_method, pathname) => {
      if (pathname.endsWith("/active")) return { code: 0, data: { status } };
      if (pathname.endsWith("/delete")) { deleteCalls += 1; return { code: -1, msg: "upstream-private-value" }; }
      throw new Error("unexpected request");
    };
    await assert.rejects(ads.deleteProfile(profileId), /仍在运行/);
    assert.strictEqual(deleteCalls, 0);
    status = "Inactive";
    await assert.rejects(ads.deleteProfile(profileId), error => !error.message.includes("upstream-private-value"));
    assert.strictEqual(deleteCalls, 1);
    assert.ok(ads.ownedProfileIds.has(profileId));
  });

  await checkAsync("AdsPower V2：创建失败和缺少 ID 不授予临时环境所有权", async () => {
    const ads = new AdsPower({ base: "http://127.0.0.1:50360" });
    ads._request = async () => ({ code: -1, msg: "upstream-private-value" });
    await assert.rejects(ads.createTempProfile({ marker }), error => !error.message.includes("upstream-private-value"));
    ads._request = async () => ({ code: 0, data: {} });
    await assert.rejects(ads.createTempProfile({ marker }), /profile_id/);
    assert.strictEqual(ads.ownedProfileIds.size, 0);
    await assert.rejects(ads.createTempProfile({ marker: "bad" }), /标记/);
    await assert.rejects(ads.createTempProfile(), /标记/);
  });
};

if (require.main === module) {
  let passed = 0;
  module.exports({ checkAsync: async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); } })
    .then(() => console.log(`${passed} passed`)).catch(error => { console.error(error); process.exitCode = 1; });
}
