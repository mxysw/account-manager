"use strict";

const https = require("https");

/**
 * 本机时钟与「真实时间」的偏差校准。
 * TOTP 完全依赖准确的 UTC 时间，本机时钟偏差超过约 ±15s 就会算出错误验证码。
 * 这里通过一次 HTTPS HEAD 请求读取服务器 Date 头来估算偏差。
 */
let TIME_OFFSET = 0;
let syncedAt = 0;

function accurateNow() {
  return Date.now() + TIME_OFFSET;
}

async function syncTime(opts = {}) {
  // force=true 时忽略 5 分钟缓存强制重新对时。
  // 2FA 重试场景需要它：上次取码失败时，宁可重新确认本机相对真实时间的偏移没在缓存窗口内变化，
  // 也不要带着可能已漂移/不准的旧偏移再算一次码。
  if (!opts.force && Date.now() - syncedAt < 5 * 60 * 1000) return TIME_OFFSET;
  const targets = ["https://www.google.com/generate_204", "https://accounts.google.com"];
  for (const url of targets) {
    try {
      const offset = await new Promise((resolve, reject) => {
        const req = https.request(url, { method: "HEAD", timeout: 5000 }, (res) => {
          const t0 = Date.now();
          const dateHeader = res.headers && res.headers.date;
          res.resume();
          if (!dateHeader) return reject(new Error("no date header"));
          const server = new Date(dateHeader).getTime();
          if (!Number.isFinite(server)) return reject(new Error("bad date header"));
          // Date 头只有秒级精度，按请求往返中点对齐。
          resolve(server + 500 - Math.floor((Date.now() + t0) / 2));
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.end();
      });
      TIME_OFFSET = offset;
      syncedAt = Date.now();
      return TIME_OFFSET;
    } catch (_) {
      // 试下一个目标
    }
  }
  return TIME_OFFSET;
}

module.exports = { syncTime, accurateNow, offset: () => TIME_OFFSET };
