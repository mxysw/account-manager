"use strict";

/**
 * 每个动作模块统一签名：
 *   async fn(page, account, ctx) -> { statusPatch?, fieldPatch?, detail, outcome }
 * - statusPatch: 写回 account.status 的字段，如 { gmail: "banned" }
 * - fieldPatch:  写回普通字段，如 { country: "US" }
 * - outcome:     ok | blocked | need_verify | error
 *
 * 安全原则：遇到验证码/可疑活动/二次验证，一律返回 need_verify 并停止，不强行操作。
 */

const login = require("./login");
const detectBan = require("./detect-ban");
const detectRestrict = require("./detect-restrict");
const detectRegion = require("./detect-region");
const detectGpt = require("./detect-gpt");
const changeLanguage = require("./change-language");
const change2fa = require("./change-2fa");
const removeDevices = require("./remove-devices");
const removePhones = require("./remove-phones");
const addPhone = require("./add-phone");
const geminiCheck = require("./gemini-fix");
const ageVerify = require("./age-verify");
const ageVerifyClose = require("./age-verify-close");
const closePayment = require("./close-payment");
// 一键登录（cookie-login）暂时下线：功能未完善，先从动作注册表移除（保留 cookie-login.js 文件便于以后恢复）。

const REGISTRY = {
  "login": {
    label: "登录账号（自动填邮箱/密码/2FA）",
    risk: "medium",
    readOnly: true,
    run: login,
  },
  "check-password": {
    label: "仅验证账号密码（密码通过即停止，不进入2FA）",
    risk: "medium",
    readOnly: true,
    exclusive: true,
    run: login.checkPassword,
  },
  "detect-ban": {
    label: "检测 Gmail / YouTube 封禁",
    risk: "low",
    readOnly: true,
    run: detectBan,
  },
  "detect-restrict": {
    label: "检测服务限制/封禁（账号级处罚）",
    risk: "low",
    readOnly: true,
    run: detectRestrict,
  },
  "detect-region": {
    label: "检测账号归属地（国家/地区）",
    risk: "low",
    readOnly: true,
    run: detectRegion,
  },
  "detect-gpt": {
    label: "检测 GPT 一键授权（用 Google 登录 ChatGPT，弹「无法验证身份」=失败）",
    risk: "medium",
    readOnly: true,
    run: detectGpt,
  },
  "change-language": {
    label: "更改账号语言（默认改为简体中文）",
    risk: "low",
    readOnly: false,
    run: changeLanguage,
  },
  "change-2fa": {
    label: "更改 2FA 密钥（更换验证器，写操作！）",
    risk: "high",
    readOnly: false,
    run: change2fa,
  },
  "remove-devices": {
    label: "移除登录设备（退出除当前外的全部设备，只保留当前会话，写操作！）",
    risk: "high",
    readOnly: false,
    run: removeDevices,
  },
  "remove-phones": {
    label: "移除2步验证手机号/恢复电话（清掉安全设置里的验证电话，写操作！）",
    risk: "high",
    readOnly: false,
    run: removePhones,
  },
  "add-2fa-phone": {
    label: "添加两步验证手机号（从手机号池领取，直接添加，写操作！）",
    risk: "high",
    readOnly: false,
    exclusive: true,
    run: addPhone,
  },
  "gemini-check": {
    label: "检测 Gemini（建 Gem，失败=需年龄验证）",
    risk: "medium",
    readOnly: true,
    run: geminiCheck,
  },
  "age-verify": {
    label: "信用卡验证年龄（仅验证，从卡池领卡，写操作！）",
    risk: "high",
    readOnly: false,
    run: ageVerify,
  },
  "age-verify-close": {
    label: "信用卡验证年龄 + 立即关闭支付资料（写操作！）",
    risk: "high",
    readOnly: false,
    run: ageVerifyClose,
  },
  "close-payment": {
    label: "关闭支付资料（注销整个支付档案，写操作！）",
    risk: "high",
    readOnly: false,
    run: closePayment,
  },
};

function list() {
  return Object.entries(REGISTRY).map(([id, a]) => ({
    id, label: a.label, risk: a.risk, readOnly: a.readOnly, exclusive: a.exclusive === true,
  }));
}

function get(id) {
  return REGISTRY[id] || null;
}

function normalizeSelection(ids) {
  return [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
}

function validateSelection(ids) {
  const selected = normalizeSelection(ids);
  const unknown = selected.find((id) => !REGISTRY[id]);
  if (unknown) return `未知操作：${unknown}`;
  const exclusive = selected.find((id) => REGISTRY[id] && REGISTRY[id].exclusive === true);
  if (exclusive && selected.length !== 1) {
    return `${REGISTRY[exclusive].label}必须单独运行，不能同时选择其它操作`;
  }
  return "";
}

module.exports = { list, get, normalizeSelection, validateSelection, REGISTRY };
