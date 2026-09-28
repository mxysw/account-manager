"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const VERSION = 1;
const STATES = new Set(["creating", "created", "closed", "deleted"]);
const DATA_DIR = process.env.ACCOUNT_MANAGER_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_MANAGER_DATA_DIR) : path.join(__dirname, "..", "..", "data");
const DEFAULT_FILE = path.join(DATA_DIR, "adspower-temp-ledger.json");

function validIdentifier(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

function validNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("AdsPower 临时环境 nonce 无效");
  }
  return value;
}

function validProfileId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("AdsPower 临时环境 profileId 无效");
  }
  return value;
}

function validateRecords(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.records)) {
    throw new Error("AdsPower 临时环境台账格式无效");
  }
  const nonces = new Set();
  const tasks = new Set();
  const profileIds = new Set();
  return value.records.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !STATES.has(item.state)) {
      throw new Error("AdsPower 临时环境台账记录无效");
    }
    const jobId = validIdentifier(item.jobId, "AdsPower 临时环境 jobId");
    const taskId = validIdentifier(item.taskId, "AdsPower 临时环境 taskId");
    const nonce = validNonce(item.nonce);
    if (nonces.has(nonce) || tasks.has(JSON.stringify([jobId, taskId]))) {
      throw new Error("AdsPower 临时环境台账存在重复记录");
    }
    nonces.add(nonce);
    tasks.add(JSON.stringify([jobId, taskId]));
    let profileId = null;
    if (item.state === "creating") {
      if (item.profileId !== null) throw new Error("AdsPower 临时环境创建意图不能包含 profileId");
    } else {
      profileId = validProfileId(item.profileId);
      if (profileIds.has(profileId)) throw new Error("AdsPower 临时环境台账存在重复 profileId");
      profileIds.add(profileId);
    }
    if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
        || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new Error("AdsPower 临时环境台账时间无效");
    }
    return { jobId, taskId, nonce, profileId, state: item.state,
      createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
}

function createLedger({ file = DEFAULT_FILE, fsApi = fs, nonceFactory = randomUUID, now = () => new Date().toISOString() } = {}) {
  if (typeof file !== "string" || !file.trim()) throw new Error("AdsPower 临时环境台账路径无效");
  const target = path.resolve(file);
  let records;
  try {
    records = validateRecords(JSON.parse(fsApi.readFileSync(target, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") records = [];
    else throw new Error(`AdsPower 临时环境台账读取失败：${error.message}`);
  }

  const copy = (record) => record ? { ...record } : null;
  const find = (nonce) => {
    const token = validNonce(nonce);
    return records.find((record) => record.nonce === token);
  };
  const save = (next) => {
    const verified = validateRecords({ version: VERSION, records: next });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      fsApi.mkdirSync(path.dirname(target), { recursive: true });
      handle = fsApi.openSync(temporary, "wx", 0o600);
      fsApi.writeFileSync(handle, JSON.stringify({ version: VERSION, records: verified }), "utf8");
      fsApi.fsyncSync(handle);
      fsApi.closeSync(handle);
      handle = null;
      fsApi.renameSync(temporary, target);
      records = verified;
    } catch (error) {
      throw new Error(`AdsPower 临时环境台账保存失败：${error.message}`);
    } finally {
      if (handle != null) { try { fsApi.closeSync(handle); } catch (_) { /* exact temporary file only */ } }
      try { fsApi.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") { /* retain original failure */ } }
    }
  };
  const update = (nonce, expected, nextState, profileId = null) => {
    const current = find(nonce);
    if (!current) throw new Error("AdsPower 临时环境创建意图不存在");
    if (current.state === nextState && (profileId === null || current.profileId === profileId)) return copy(current);
    if (current.state !== expected) throw new Error(`AdsPower 临时环境状态不能从 ${current.state} 变为 ${nextState}`);
    const changed = { ...current, state: nextState, updatedAt: now(),
      ...(profileId === null ? {} : { profileId }) };
    save(records.map((record) => record.nonce === nonce ? changed : record));
    return copy(changed);
  };

  return {
    begin(jobId, taskId, nonce) {
      validIdentifier(jobId, "AdsPower 临时环境 jobId");
      validIdentifier(taskId, "AdsPower 临时环境 taskId");
      const existing = records.find((record) => record.jobId === jobId && record.taskId === taskId);
      if (existing) {
        if (nonce !== undefined && validNonce(nonce) !== existing.nonce) {
          throw new Error("AdsPower 临时环境任务已有不同的创建意图");
        }
        return copy(existing);
      }
      const token = validNonce(nonce === undefined ? nonceFactory() : nonce);
      if (records.some((record) => record.nonce === token)) throw new Error("AdsPower 临时环境 nonce 已存在");
      const timestamp = now();
      const record = { jobId, taskId, nonce: token, profileId: null, state: "creating",
        createdAt: timestamp, updatedAt: timestamp };
      save([...records, record]);
      return copy(record);
    },
    // Only pass the ID returned by this intent's create API response. A list
    // result, serial number, profile name, or remark is not proof of ownership.
    recordProfile(nonce, profileId) {
      const id = validProfileId(profileId);
      if (records.some((record) => record.profileId === id && record.nonce !== nonce)) {
        throw new Error("AdsPower 临时环境 profileId 已归属其它创建意图");
      }
      return update(nonce, "creating", "created", id);
    },
    markClosed(nonce) { return update(nonce, "created", "closed"); },
    markDeleted(nonce) { return update(nonce, "closed", "deleted"); },
    // The caller must also confirm Inactive immediately before the delete API.
    // This ledger proves ownership and the last recorded close, not live state.
    deletionCandidate(nonce) {
      const record = find(nonce);
      if (!record || record.state !== "closed" || !record.profileId) {
        throw new Error("AdsPower 临时环境未确认关闭或不属于本任务，禁止删除");
      }
      return record.profileId;
    },
    get(nonce) { return copy(find(nonce)); },
    list() { return records.map(copy); },
    listOwned() { return records.filter((record) => record.profileId && record.state !== "deleted").map(copy); },
  };
}

module.exports = { createLedger };
