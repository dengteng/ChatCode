#!/usr/bin/env node
// 富文本复制的自检:小结剥除、TSV 抽取,外加几条源码不变量(DOM 那部分没法在 node 里跑,
// 只能断言规则还在)。和 bg-progress.check.mjs 同一套路。
//
// 跑法:node scripts/copy-rich.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const CHAT = readFileSync("src/components/Chat.tsx", "utf8");

// ---------- 1. 复制的正文要和屏幕上一致:抹掉「本轮小结」那行 ----------
// turnCopyText / stripSummary 本身搬去了 lib/timeline.ts,那边有真调用的断言(timeline.check.ts),
// 这里不再复刻一份跑 —— 复刻迟早会和真身漂开。这儿只管接线:两个按钮都得走它。
assert.ok(/export const turnCopyText/.test(readFileSync("src/lib/timeline.ts", "utf8")),
  "turnCopyText 不见了(搬走了就把这条指到新位置)");
assert.ok(/turnCopyText[,\s]/.test(CHAT.slice(0, CHAT.indexOf("\n\n"))) || /from "\.\.\/lib\/timeline"/.test(CHAT),
  "Chat.tsx 要从 lib/timeline 拿 turnCopyText");
assert.ok(/pasteToComposer\(turnCopyText\(/.test(CHAT) && /copyRich\(body, turnCopyText\(/.test(CHAT),
  "复制/贴回两个按钮都必须走 turnCopyText,不能再用原文");

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

// ---------- 4. 划选工具条:一滚就收 ----------
// 它是 fixed 定位、坐标在划选那一刻算死的,不收的话滚两下就悬在别的字上面,还挡着正文。
assert.ok(/document\.addEventListener\("scroll", onScroll, true\)/.test(CHAT),
  "划选工具条要监听 scroll(必须 capture:scroll 不冒泡到 document,收不到消息区那个容器的)");
assert.ok(/removeEventListener\("scroll", onScroll, true\)/.test(CHAT), "scroll 监听要在 cleanup 里摘掉");

// ---------- 5. agent 三按钮:自绘 tooltip + 靠右对齐 ----------
const CSS = readFileSync("src/styles.css", "utf8");
const actRow = /<div className="msg-redo-row agent-actions">[\s\S]*?<\/div>/.exec(CHAT);
assert.ok(actRow, "没找到 agent 气泡下方那排按钮");
assert.equal((actRow[0].match(/data-tip=/g) || []).length, 3, "三个按钮都得有 data-tip(hover 说明)");
assert.ok(!/\btitle=/.test(actRow[0]), "别再挂 title:原生 tooltip 会和 data-tip 那份一起冒出来");
assert.equal((actRow[0].match(/aria-label=/g) || []).length, 3, "纯图标按钮,可读名字只能靠 aria-label");
assert.ok(/\.msg-redo-row button\[data-tip\]:hover::after/.test(CSS), "data-tip 得有对应的 ::after,否则文案根本不画");
assert.ok(/\.turn-foot \{[^}]*width: 100%/.test(CSS),
  "turn-foot 要撑满整列 —— 不撑就只有 chips 那么宽,按钮的 margin-left:auto 顶不到气泡右缘");
assert.ok(/\.msg-redo-row\.agent-actions \{[^}]*margin-left: auto/.test(CSS), "按钮排要靠右");
assert.ok(/\.turn-foot \{[^}]*align-items: center/.test(CSS), "按钮要和左边的 chips 在这行里居中对齐");

console.log("✅ copy-rich: 小结剥除 / 建议保留 / TSV 抽取 / 双 flavor+兜底 / 划选一滚就收 / 三按钮 tooltip+靠右 全部通过");
