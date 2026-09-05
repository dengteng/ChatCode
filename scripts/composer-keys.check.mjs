#!/usr/bin/env node
// 输入框方向键/换行两条键位规则的自检。两条都是"看着对、实际反着来"的那类,回归了很难一眼看出:
//   1) ↑ 翻上一条只在光标停在最前面时生效,↓ 翻下一条只在光标停在最末尾时生效。
//      早先两边都只判"光标在最前面":多行历史回显后光标钉在第一位,想把光标下移一行就整条被换掉。
//   2) shift+⏎ 换行自己插 <br>,不能交回 WKWebView 默认 —— 它的段落合并 fixup 会把行首那截文字吃掉。
// 跑法:node scripts/composer-keys.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/components/Composer.tsx", "utf8");

// ---------- 1. 翻历史的闸:和 Composer.onKeyDown 里那份保持一致 ----------
const histGate = (key, { atStart, atEnd }) =>
  (key === "ArrowUp" && atStart) || (key === "ArrowDown" && atEnd);

const START = { atStart: true, atEnd: false };
const END = { atStart: false, atEnd: true };
const MID = { atStart: false, atEnd: false };
const EMPTY = { atStart: true, atEnd: true }; // 空框:两头是同一处

assert.equal(histGate("ArrowUp", START), true, "光标在最前面,↑ 该翻上一条");
assert.equal(histGate("ArrowUp", END), false, "光标在末尾,↑ 只该把光标上移一行");
assert.equal(histGate("ArrowUp", MID), false, "光标在中间,↑ 只该移动光标");
// 这条就是本次的 bug:多行回显后光标钉在第一位,按 ↓ 的本意是下移一行
assert.equal(histGate("ArrowDown", START), false, "光标在最前面,↓ 不该翻下一条");
assert.equal(histGate("ArrowDown", END), true, "光标在末尾,↓ 该翻下一条");
assert.equal(histGate("ArrowDown", MID), false, "光标在中间,↓ 只该移动光标");
assert.equal(histGate("ArrowUp", EMPTY) && histGate("ArrowDown", EMPTY), true, "空框时 ↑↓ 都该翻历史");

// ---------- 2. 源码里的闸就是上面这份 ----------
assert.ok(/\(e\.key === "ArrowUp" && caretAtStart\(\)\) \|\| \(e\.key === "ArrowDown" && caretAtEnd\(\)\)/.test(SRC),
  "翻历史的判据被改回'两个方向都看 caretAtStart'了 —— ↓ 会在多行回显后吞掉整条内容");
// 翻完把光标钉在下一次判据的那一头,否则连按同一个键只翻得动一条
assert.ok(/function restoreHistory\(h: HistEntry, toStart = true\)/.test(SRC), "restoreHistory 要能按方向决定光标钉哪头");
assert.ok(/r\.collapse\(toStart\)/.test(SRC), "restoreHistory 的光标位置没跟着 toStart 走");
assert.ok(/restoreHistory\(h\[next\], up\)/.test(SRC), "翻历史没把方向传给 restoreHistory");

// ---------- 3. shift+⏎ 必须自己插 <br>,且排在"⏎ 发送"之前 ----------
const brAt = SRC.indexOf('if (e.key === "Enter" && e.shiftKey)');
const sendAt = SRC.indexOf('if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }');
assert.ok(brAt > 0, "shift+⏎ 没自己接管换行 —— WKWebView 默认换行会吃掉行首文字");
assert.ok(sendAt > brAt, "换行分支必须排在发送分支之前");
const branch = SRC.slice(brAt, sendAt);
assert.ok(/createElement\("br"\)/.test(branch) && /r\.insertNode\(br\)/.test(branch), "换行分支得真插一个 <br>");
assert.ok(/if \(!after\)/.test(branch), "末尾换行要补第二个 <br>,否则新起的空行不占高度、光标像没动");
assert.ok(/histIdx\.current = -1/.test(branch) && /syncText\(\)/.test(branch),
  "手改 DOM 不触发 input 事件,onInput 里的 histIdx 复位和 syncText 得在分支里补上");

console.log("composer-keys: ok");
