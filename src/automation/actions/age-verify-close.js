"use strict";

/**
 * 信用卡验证年龄 + 立即关闭支付资料（组合动作）。
 * 逻辑：先用卡池里的卡做年龄验证；不管验证结果如何，紧接着把支付资料里存进去的卡全部删掉，
 * 避免卖号前账号里残留支付方式。两步的状态/详情都回写账号库。
 */

const ageVerify = require("./age-verify");
const closePayment = require("./close-payment");

async function ageVerifyClose(page, account, ctx) {
  const emit = ctx && ctx.emit ? ctx.emit : () => {};

  emit("age_verify_start", {});
  const a = await ageVerify(page, account, ctx);
  emit("age_verify_done", { outcome: a.outcome });

  // 无论年龄验证成功与否，都走一遍关闭支付资料（验证过程会把卡存进 Wallet）。
  emit("close_payment_start", {});
  const c = await closePayment(page, account, ctx);
  emit("close_payment_done", { outcome: c.outcome });

  const statusPatch = { ...(a.statusPatch || {}), ...(c.statusPatch || {}) };
  const fieldPatch = { ...(a.fieldPatch || {}), ...(c.fieldPatch || {}) };
  const detail = { ...(a.detail || {}), ...(c.detail || {}) };
  // 整体结论：年龄验证没过就以它为准（需人工）；过了就看关支付的结果。
  const outcome = a.outcome === "ok" ? c.outcome : a.outcome;
  return { outcome, statusPatch, fieldPatch, detail };
}

module.exports = ageVerifyClose;
