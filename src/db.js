"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 极简的本地 JSON 数据层：
 * - 进程内缓存，读快
 * - 写入用 临时文件 + rename 做原子替换，避免半截文件
 * - 写入做去抖合并，连续多次修改只落盘一次
 */
class JsonDB {
  constructor(file, initial = {}) {
    this.file = file;
    this.dir = path.dirname(file);
    this.initial = initial;
    this.data = null;
    this._writeTimer = null;
    this._writing = false;
    this._dirtyAgain = false;
  }

  load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!this.data || typeof this.data !== "object") this.data = { ...this.initial };
    } catch (_) {
      this.data = JSON.parse(JSON.stringify(this.initial));
    }
    return this.data;
  }

  get() {
    return this.load();
  }

  /** 标记需要落盘，去抖 120ms 后写入。 */
  save() {
    this.load();
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this._flush();
    }, 120);
  }

  /** 立即同步落盘（用于退出前或测试）。 */
  flushSync() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._writeToDisk();
  }

  async _flush() {
    if (this._writing) {
      this._dirtyAgain = true;
      return;
    }
    this._writing = true;
    try {
      this._writeToDisk();
    } finally {
      this._writing = false;
      if (this._dirtyAgain) {
        this._dirtyAgain = false;
        this.save();
      }
    }
  }

  _writeToDisk() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonDB };
