"use strict";

const http = require("http");
const adsSettings = require("../adspower-settings");

function validProfileId(value) {
  if (typeof value !== "string" || !/^[^\s\x00-\x1f\x7f]{1,128}$/.test(value)) {
    throw new Error("AdsPower profile_id 无效");
  }
  return value;
}

/** 轻量 AdsPower Local API 客户端，仅连接本机保存的 Local API 端口。 */
class AdsPower {
  constructor(opts = {}) {
    const base = opts.base || adsSettings.getBase();
    const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/.exec(base);
    if (!match) {
      throw new Error("AdsPower 只允许连接 127.0.0.1 的本地 API 端口");
    }
    const port = adsSettings.validPort(match[1]);
    this.base = `http://127.0.0.1:${port}`;
    this.apiKey = opts.apiKey || "";
    const owned = opts.ownedProfileIds || [];
    if (!Array.isArray(owned) && !(owned instanceof Set)) throw new Error("临时环境 ID 列表无效");
    this.ownedProfileIds = new Set([...owned].map(validProfileId));
  }

  _ownedProfileId(value) {
    const profileId = validProfileId(value);
    if (!this.ownedProfileIds.has(profileId)) throw new Error("仅允许操作本系统创建的临时环境");
    return profileId;
  }

  /** V2 临时环境：只写本系统标记，不把站点账号、密码或 2FA 密钥交给 AdsPower。 */
  async createTempProfile({ marker } = {}) {
    if (typeof marker !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(marker)) {
      throw new Error("临时环境标记无效");
    }
    const label = `am-temp-${marker}`;
    const response = await this._request("POST", "/api/v2/browser-profile/create", {}, {
      group_id: "0",
      name: label,
      remark: `account-manager-owned:${marker}`,
      username: label,
      user_proxy_config: { proxy_soft: "no_proxy" },
      fingerprint_config: { screen_resolution: "none" },
    });
    const profileId = response && response.code === 0 && response.data && response.data.profile_id;
    if (!profileId) throw new Error("AdsPower 临时环境创建未返回 profile_id");
    validProfileId(profileId);
    this.ownedProfileIds.add(profileId);
    return { profileId, profileNo: String(response.data.profile_no || ""), marker };
  }

  /** V2 启动：始终关闭 AdsPower 自带的密码保存与自动填充。 */
  async startProfile(profileId) {
    const id = this._ownedProfileId(profileId);
    const response = await this._request("POST", "/api/v2/browser-profile/start", {}, {
      profile_id: id,
      password_filling: "0",
      password_saving: "0",
    }, 90000);
    if (!response || response.code !== 0) throw new Error("AdsPower 临时环境启动失败");
    const cdpEndpoint = this._cdpFromData(response.data);
    if (!cdpEndpoint) throw new Error("AdsPower 临时环境未返回调试地址");
    return { profileId: id, cdpEndpoint };
  }

  async stopProfile(profileId) {
    const id = this._ownedProfileId(profileId);
    const response = await this._request("POST", "/api/v2/browser-profile/stop", {}, { profile_id: id });
    if (!response || response.code !== 0) throw new Error("AdsPower 临时环境关闭失败");
    return { profileId: id, stopped: true };
  }

  async profileStatus(profileId) {
    const id = this._ownedProfileId(profileId);
    const response = await this._request("GET", "/api/v2/browser-profile/active", { profile_id: id });
    const status = response && response.code === 0 && response.data && response.data.status;
    if (status !== "Active" && status !== "Inactive") throw new Error("AdsPower 临时环境状态未确认");
    return { profileId: id, status };
  }

  /** 再次确认关闭后仅删除一个精确的自有 ID；所有权记录由上层持久账本管理。 */
  async deleteProfile(profileId) {
    const id = this._ownedProfileId(profileId);
    const state = await this.profileStatus(id);
    if (state.status !== "Inactive") throw new Error("AdsPower 临时环境仍在运行，不能删除");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await this._request("POST", "/api/v2/browser-profile/delete", {}, { profile_id: [id] });
    if (!response || response.code !== 0) throw new Error("AdsPower 临时环境删除失败");
    return { profileId: id, deleted: true };
  }

  /** 官方只读 /status：仅确认当前本机 Local API 可用。 */
  async checkConnection() {
    const response = await this._request("GET", "/status", {}, null, 5000);
    return !!(response && response.code === 0);
  }

  _request(method, pathname, query = {}, body = null, timeoutMs = 20000) {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (_) {
            reject(new Error("AdsPower 返回了无法解析的响应"));
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("AdsPower API 超时")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 从 start/active 的 data 里解析出 http://host:port 形式的 CDP 地址。 */
  _cdpFromData(data) {
    const ws = (data && data.ws) || {};
    // 优先级：selenium(host:port) > debug_port > 从 puppeteer 的 ws 里解析端口。
    if (ws.selenium && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(String(ws.selenium))) {
      return `http://${ws.selenium}`;
    }
    if (data && data.debug_port) {
      return `http://127.0.0.1:${data.debug_port}`;
    }
    if (ws.puppeteer) {
      const m = String(ws.puppeteer).match(/:(\d+)\//);
      if (m) return `http://127.0.0.1:${m[1]}`;
    }
    return "";
  }

  /** 轮询 browser/active，等环境真正 Active 后取调试地址（用于 start 超时兜底）。 */
  async _waitActive(serialNumber, totalMs = 40000) {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
      try {
        const act = await this._request("GET", "/api/v1/browser/active", { serial_number: serialNumber });
        if (act.code === 0 && act.data && act.data.status === "Active") {
          const cdp = this._cdpFromData(act.data);
          if (cdp) return cdp;
        }
      } catch (_) { /* 继续等 */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return "";
  }

  /** 打开环境，返回 CDP 调试地址。clearCache=true 时让 AdsPower 关闭后清缓存。 */
  async start(serialNumber, opts = {}) {
    const query = {
      serial_number: serialNumber,
      open_tabs: 1,
      ip_tab: 0,
    };
    if (opts.clearCache) query.clear_cache_after_closing = 1;
    // 后台模式在 CDP 接管后最小化。这里不传 launch_args：AdsPower 会用它
    // 覆盖环境原有启动参数，不能为窗口偏好丢掉用户已配置的参数。
    // 改过指纹/代理后第一次开窗往往很慢，给到 90s 超时。
    let r = null;
    let cdp = "";
    try {
      r = await this._request("GET", "/api/v1/browser/start", query, null, 90000);
      if (r.code !== 0) throw new Error(r.msg || "打开 AdsPower 环境失败");
      cdp = this._cdpFromData(r.data);
    } catch (err) {
      // start 超时/出错：窗口可能仍在后台打开，轮询 active 兜底拿地址。
      cdp = await this._waitActive(serialNumber, 40000);
      if (!cdp) throw err;
    }
    // 兜底：对已打开的环境再 start 时 ws 可能为空，改查 active 取调试口。
    if (!cdp) cdp = await this._waitActive(serialNumber, 40000);
    return { serialNumber: String(serialNumber), cdpEndpoint: cdp, raw: r && r.data };
  }

  async stop(serialNumber) {
    return this._request("GET", "/api/v1/browser/stop", { serial_number: serialNumber });
  }

  async status(serialNumber) {
    return this._request("GET", "/api/v1/browser/active", { serial_number: serialNumber });
  }

  /** 列出所有环境（自动翻页），返回精简后的列表。 */
  async listProfiles() {
    const out = [];
    let page = 1;
    const pageSize = 100;
    for (;;) {
      const r = await this._request("GET", "/api/v1/user/list", { page, page_size: pageSize });
      if (r.code !== 0) throw new Error(r.msg || "读取 AdsPower 环境列表失败");
      const list = (r.data && r.data.list) || [];
      for (const it of list) {
        out.push({
          userId: it.user_id,
          serial: String(it.serial_number),
          name: it.name || "",
          group: it.group_name || "",
          remark: it.remark || "",
          domainName: it.domain_name || "",
          username: it.username || "",
        });
      }
      if (list.length < pageSize) break;
      page += 1;
      if (page > 50) break; // 安全上限：最多 5000 个
    }
    return out;
  }

  async getUserId(serialNumber) {
    const r = await this._request("GET", "/api/v1/user/list", { serial_number: serialNumber, page_size: 1 });
    const item = r && r.data && r.data.list && r.data.list[0];
    return item ? item.user_id : "";
  }

  /** 给环境重新随机指纹：优先专用接口，失败回退 user/update 加噪。 */
  async randomizeFingerprint(serialNumber) {
    try {
      const r = await this._request("GET", "/api/v1/browser/new-fingerprint", { serial_number: serialNumber });
      if (r && r.code === 0) return { ok: true, via: "new-fingerprint" };
    } catch (_) { /* 回退 */ }
    const userId = await this.getUserId(serialNumber);
    if (!userId) return { ok: false, msg: "未找到该环境的 user_id" };
    const major = 120 + Math.floor(Math.random() * 20);
    const build = `${major}.0.${1000 + Math.floor(Math.random() * 6000)}.${Math.floor(Math.random() * 200)}`;
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${build} Safari/537.36`;
    const r = await this._request("POST", "/api/v1/user/update", {}, {
      user_id: userId,
      fingerprint_config: { ua, canvas: "1", webgl_image: "1", audio: "1", automatic_timezone: "1" },
    });
    if (r && r.code === 0) return { ok: true, via: "update" };
    return { ok: false, msg: (r && r.msg) || "update failed" };
  }

  /** 读取某环境当前的代理配置（user_proxy_config）与最近探测到的 IP/国家。 */
  async readProxy(serialNumber) {
    const r = await this._request("GET", "/api/v1/user/list", { serial_number: serialNumber, page_size: 1 });
    const it = (r && r.data && r.data.list && r.data.list[0]) || null;
    if (!it) return { ok: false, msg: "未找到该环境" };
    return {
      ok: true,
      userId: it.user_id,
      proxy: it.user_proxy_config || { proxy_soft: "no_proxy" },
      ip: it.ip || "",
      ipCountry: it.ip_country || "",
    };
  }

  /**
   * 给环境设置代理（写 user_proxy_config）。常见动态住宅网关用：
   *   { proxy_soft:"other", proxy_type:"socks5"|"http", proxy_host, proxy_port, proxy_user, proxy_password }
   * 也可整体传入一个 proxy_soft 已知的 config 对象。
   */
  async setProxy(serialNumber, proxyConfig) {
    const userId = await this.getUserId(serialNumber);
    if (!userId) return { ok: false, msg: "未找到该环境的 user_id" };
    const r = await this._request("POST", "/api/v1/user/update", {}, {
      user_id: userId,
      user_proxy_config: proxyConfig,
    });
    if (r && r.code === 0) return { ok: true };
    return { ok: false, msg: (r && r.msg) || "设置代理失败" };
  }

  /**
   * 从「已保存的代理池」里随机绑一条到环境（proxyid:"random"）。
   * 动态住宅池每条是不同会话=不同 IP，所以每次绑=换一个新住宅 IP。
   * 这是用 AdsPower 原生代理池的最干净方式，无需处理账号密码。
   */
  async bindRandomProxy(serialNumber) {
    const userId = await this.getUserId(serialNumber);
    if (!userId) return { ok: false, msg: "未找到该环境的 user_id" };
    const r = await this._request("POST", "/api/v1/user/update", {}, {
      user_id: userId,
      proxyid: "random",
    });
    if (r && r.code === 0) return { ok: true };
    return { ok: false, msg: (r && r.msg) || "随机绑定代理失败" };
  }

  /** 给环境绑定指定的已保存代理（用于"按标签随机"挑出的某条 proxyId）。 */
  async bindProxyId(serialNumber, proxyId) {
    const userId = await this.getUserId(serialNumber);
    if (!userId) return { ok: false, msg: "未找到该环境的 user_id" };
    const r = await this._request("POST", "/api/v1/user/update", {}, {
      user_id: userId,
      proxyid: String(proxyId),
    });
    if (r && r.code === 0) return { ok: true };
    return { ok: false, msg: (r && r.msg) || "绑定代理失败" };
  }

  /** 当前已打开环境的 user_id 集合（用于在列表里标“已打开”）。 */
  async activeUserIds() {
    try {
      const r = await this._request("GET", "/api/v1/browser/local-active");
      const list = (r.data && r.data.list) || [];
      return new Set(list.map((it) => String(it.user_id)));
    } catch (_) {
      return new Set();
    }
  }
}

module.exports = { AdsPower };
