"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { helpers: { dpapi } } = require("./capsolver-settings");

const DEFAULT_ADDRESS = "127.0.0.1";
const DEFAULT_PORT = 50325;

// The Local API receives the Bearer key. Always connect to the literal loopback
// address even when the user pastes AdsPower's documented local.adspower.net.
function validAddress(value) {
  if (typeof value !== "string") throw new Error("AdsPower API 地址只能是本机地址");
  const host = value.trim().replace(/^http:\/\//i, "");
  if (!/^(?:127\.0\.0\.1|localhost|local\.adspower\.net)$/i.test(host)) {
    throw new Error("AdsPower API 地址只能是 127.0.0.1、localhost 或 local.adspower.net，端口请单独填写");
  }
  return DEFAULT_ADDRESS;
}

function validPort(value) {
  const text = String(value);
  if (!/^[0-9]{1,5}$/.test(text)) throw new Error("AdsPower 本地 API 端口须为 1–65535 的整数");
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error("AdsPower 本地 API 端口须为 1–65535 的整数");
  return port;
}

function validKey(value) {
  if (typeof value !== "string" || !/^[^\s\x00-\x1f\x7f]{1,512}$/.test(value.trim())) {
    throw new Error("请输入有效的 AdsPower API Key");
  }
  return value.trim();
}

function createStore({ file, protect = (key) => dpapi("protect", key), unprotect = (value) => dpapi("unprotect", value) }) {
  const read = () => {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("AdsPower 本机配置读取失败，请重新保存");
    }
    if (!value || ![1, 2].includes(value.version) || value.protection !== "windows-dpapi"
        || typeof value.encryptedKey !== "string" || value.encryptedKey.length > 16384) {
      throw new Error("AdsPower 本机配置无效，请重新保存");
    }
    validPort(value.port);
    // Version 1 stored only the port and encrypted key. Reading it must retain
    // the encrypted key unchanged; the next save upgrades the file to v2.
    const address = value.address === undefined && value.version === 1
      ? DEFAULT_ADDRESS : validAddress(value.address);
    return { ...value, address };
  };
  const getAddress = () => { const value = read(); return value ? value.address : DEFAULT_ADDRESS; };
  const getPort = () => { const value = read(); return value ? validPort(value.port) : DEFAULT_PORT; };
  const getBase = () => {
    const value = read();
    return `http://${value ? value.address : DEFAULT_ADDRESS}:${value ? validPort(value.port) : DEFAULT_PORT}`;
  };
  const status = () => {
    const value = read();
    return {
      configured: !!(value && value.encryptedKey),
      address: value ? value.address : DEFAULT_ADDRESS,
      port: value ? validPort(value.port) : DEFAULT_PORT,
    };
  };
  const getKey = () => {
    const value = read();
    if (!value || !value.encryptedKey) throw new Error("请先保存 AdsPower API Key");
    try { return validKey(unprotect(value.encryptedKey)); }
    catch (_) { throw new Error("AdsPower 密钥无法读取，请使用保存时的 Windows 用户或重新保存"); }
  };
  const save = (config) => {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("AdsPower 配置无效");
    const port = validPort(config.port);
    const previous = read();
    const address = config.address === undefined
      ? (previous ? previous.address : DEFAULT_ADDRESS) : validAddress(config.address);
    const key = config.apiKey;
    let encryptedKey;
    if (key === undefined || key === null || key === "") {
      encryptedKey = previous ? previous.encryptedKey : "";
    } else {
      const normalized = validKey(key);
      try { encryptedKey = protect(normalized); }
      catch (_) { throw new Error("AdsPower 密钥加密失败，原配置未更改"); }
      if (typeof encryptedKey !== "string" || !encryptedKey || encryptedKey.length > 16384) {
        throw new Error("AdsPower 密钥加密失败，原配置未更改");
      }
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, protection: "windows-dpapi", address, port, encryptedKey }), {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      fs.renameSync(temporary, file);
    } catch (_) {
      throw new Error("AdsPower 本机配置保存失败");
    } finally {
      try { fs.unlinkSync(temporary); } catch (_) { /* Only this exact temporary file. */ }
    }
    return { configured: !!encryptedKey, address, port };
  };
  const clear = () => {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("AdsPower 本机配置清除失败"); }
    return { configured: false, address: DEFAULT_ADDRESS, port: DEFAULT_PORT };
  };
  return { status, getAddress, getPort, getBase, getKey, save, clear };
}

const directory = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR) : path.join(__dirname, "..", "data");
const store = createStore({ file: path.join(directory, "adspower-settings.json") });
module.exports = { ...store, createStore, validAddress, validPort, DEFAULT_ADDRESS, DEFAULT_PORT };
