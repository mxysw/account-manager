"use strict";

// 查看代理池标签分布：node tools/proxy-tags.js <apiKey>
const adsCli = require("../src/automation/ads-cli");

const apiKey = process.argv[2] || process.env.AP_KEY || "";

(async () => {
  if (!apiKey) throw new Error("用法：node tools/proxy-tags.js <apiKey>");
  const r = await adsCli.listProxyTags(apiKey);
  console.log(`代理总数：${r.total}，无标签：${r.untagged}`);
  console.log("标签：");
  r.tags.forEach((t) => console.log(`  - ${t.name}  (id=${t.id})  共 ${t.count} 条`));
  process.exit(0);
})().catch((e) => { console.error("失败：", e.message); process.exit(1); });
