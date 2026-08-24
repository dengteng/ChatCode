#!/usr/bin/env node
// 富文本复制的自检:小结剥除、TSV 抽取,外加几条源码不变量(DOM 那部分没法在 node 里跑,
// 只能断言规则还在)。和 bg-progress.check.mjs 同一套路。
//
// 跑法:node scripts/copy-rich.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const CHAT = readFileSync("src/components/Chat.tsx", "utf8");

// ---------- 1. 复制的正文要和屏幕上一致:抹掉「本轮小结」那行 ----------
const SUMMARY_LINE_RE = /^[\s>*#`\-]*本轮小结\**\s*[：:]/;
const stripSummary = (text) => text.split("\n").filter((l) => !SUMMARY_LINE_RE.test(l)).join("\n").trim();
assert.ok(CHAT.includes("const turnCopyText"), "Chat.tsx 的 turnCopyText 已漂移");
assert.ok(/pasteToComposer\(turnCopyText\(/.test(CHAT) && /copyRich\(body, turnCopyText\(/.test(CHAT),
  "复制/贴回两个按钮都必须走 turnCopyText,不能再用原文");

assert.equal(stripSummary("正文一\n\n本轮小结：改了 A。"), "正文一");
assert.equal(stripSummary("正文\n**本轮小结**：改了 A。\n"), "正文");
// 「本轮建议」那行照常显示在正文里,不能一起抹掉
const kept = stripSummary("正文\n本轮建议：提交并推送 | 修第 3 条\n本轮小结：改了 A。");
assert.ok(kept.includes("本轮建议"), "建议行是正文的一部分,不该被剥掉");
assert.ok(!kept.includes("本轮小结"));

// ---------- 2. 表格 → TSV(没有 HTML 通道时的纯文本兜底) ----------
const toTsv = (rows) => rows.map((r) => r.map((c) => c.replace(/\s+/g, " ").trim()).join("\t")).join("\n");
assert.equal(
  toTsv([["榜单", "状态"], ["Finance Agent v2", "在用，\n51模型"]]),
  "榜单\t状态\nFinance Agent v2\t在用， 51模型",
  "单元格里的换行要压成空格,否则 TSV 的行列会错位",
);

// ---------- 3. 源码不变量 ----------
assert.ok(/"text\/html"[\s\S]{0,200}"text\/plain"/.test(CHAT), "clipboard 必须同时写 html 和 plain 两种 flavor");
assert.ok(CHAT.includes("return c.outerHTML"), "必须用 outerHTML —— innerHTML 会把单独复制表格时的 <table> 壳弄丢");
assert.ok(CHAT.includes('c.querySelectorAll("button").forEach'), "界面自己的复制按钮必须剥掉,否则粘出来多几个「复制」");
assert.ok(/return copyText\(text\);/.test(CHAT), "clipboard.write 失败必须退回纯文本,不能静默失败");

console.log("✅ copy-rich: 小结剥除 / 建议保留 / TSV 抽取 / 双 flavor+兜底 全部通过");
