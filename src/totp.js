"use strict";

const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 把 base32 字符串解码为 Buffer（忽略空格/连字符，大小写不敏感）。 */
function base32Decode(input) {
  const clean = String(input || "").toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`非法的 base32 字符：${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** 是否像合法的 base32 TOTP 密钥。 */
function looksLikeSecret(value) {
  const clean = String(value || "").replace(/[\s-]/g, "");
  return clean.length >= 16 && /^[A-Za-z2-7]+$/.test(clean);
}

/**
 * 生成 TOTP 验证码（RFC 6238，默认 30s / 6 位 / SHA1）。
 * @returns {{ code: string, secondsRemaining: number }}
 */
function generate(secret, opts = {}) {
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const algorithm = opts.algorithm || "sha1";
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const counter = Math.floor(now / 1000 / step);

  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(algorithm, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const code = String(binary % 10 ** digits).padStart(digits, "0");
  const secondsRemaining = step - Math.floor((now / 1000) % step);
  return { code, secondsRemaining };
}

module.exports = { generate, base32Decode, looksLikeSecret };
