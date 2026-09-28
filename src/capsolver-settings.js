"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawnSync } = require("child_process");

function validKey(value) {
  if (typeof value !== "string" || !/^[^\s\x00-\x1f\x7f]{1,512}$/.test(value.trim())) {
    throw new Error("请输入有效的 CAPSOLVER API Key");
  }
  return value.trim();
}

// 使用当前 Windows 用户的 DPAPI；密钥只通过子进程 stdin 传递，不放入命令行。
// 无法加密/解密时直接失败，不静默退回明文保存，不输出系统原始错误。
function dpapi(operation, value) {
  if (process.platform !== "win32") throw new Error("当前系统不支持 Windows 本机密钥保存");
  const method = operation === "protect" ? "Protect" : "Unprotect";
  const command = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; "
    + "$secretBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); "
    + `$resultBytes = [Security.Cryptography.ProtectedData]::${method}($secretBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + "[Console]::Out.Write([Convert]::ToBase64String($resultBytes))";
  const binary = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-Command", command], {
    input: operation === "protect" ? Buffer.from(value, "utf8").toString("base64") : value,
    encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536,
  });
  const output = String(result.stdout || "").trim();
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
    throw new Error("本机密钥保护失败，请使用原 Windows 用户重试");
  }
  return operation === "protect" ? output : Buffer.from(output, "base64").toString("utf8");
}

function createStore({ file, protect = (key) => dpapi("protect", key), unprotect = (value) => dpapi("unprotect", value) }) {
  const read = () => {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("CAPSOLVER 本机配置读取失败，请重新保存密钥");
    }
    if (!value || value.version !== 1 || value.protection !== "windows-dpapi"
        || typeof value.encryptedKey !== "string" || !value.encryptedKey || value.encryptedKey.length > 16384) {
      throw new Error("CAPSOLVER 本机配置无效，请重新保存密钥");
    }
    return value;
  };
  const status = () => ({ configured: !!read() });
  const getKey = () => {
    const value = read();
    if (!value) throw new Error("请先保存 CAPSOLVER API Key");
    try { return validKey(unprotect(value.encryptedKey)); }
    catch (_) { throw new Error("CAPSOLVER 密钥无法读取，请使用保存时的 Windows 用户或重新保存"); }
  };
  const save = (key) => {
    const normalized = validKey(key);
    let encryptedKey;
    try { encryptedKey = protect(normalized); }
    catch (_) { throw new Error("CAPSOLVER 密钥加密失败，原配置未更改"); }
    if (typeof encryptedKey !== "string" || !encryptedKey || encryptedKey.length > 16384) {
      throw new Error("CAPSOLVER 密钥加密失败，原配置未更改");
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, protection: "windows-dpapi", encryptedKey }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } catch (_) {
      throw new Error("CAPSOLVER 本机配置保存失败");
    } finally {
      try { fs.unlinkSync(temporary); } catch (_) { /* Only our exact temporary file. */ }
    }
    return { configured: true };
  };
  const clear = () => {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("CAPSOLVER 本机配置清除失败"); }
    return { configured: false };
  };
  const resolveConfig = (config) => {
    if (!config || typeof config !== "object" || Array.isArray(config) || config.enabled !== true) return config;
    // 显式传入密钥的旧客户端仍可运行；空输入则自动使用本机配置。
    if (config.apiKey !== undefined && config.apiKey !== "" && config.apiKey !== null) return config;
    return { ...config, apiKey: getKey() };
  };
  return { status, save, clear, getKey, resolveConfig };
}

const directory = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR) : path.join(__dirname, "..", "data");
const store = createStore({ file: path.join(directory, "capsolver-settings.json") });
module.exports = { ...store, createStore, helpers: { dpapi } };
