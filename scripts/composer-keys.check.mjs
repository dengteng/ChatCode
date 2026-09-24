#!/usr/bin/env node
// 输入框方向键/换行两条键位规则的自检。两条都是"看着对、实际反着来"的那类,回归了很难一眼看出:
//   1) ↑ 翻上一条只在光标停在最前面时生效,↓ 翻下一条只在光标停在最末尾时生效。
//      早先两边都只判"光标在最前面":多行历史回显后光标钉在第一位,想把光标下移一行就整条被换掉。
//   2) shift+⏎ 换行自己插 <br>,不能交回 WKWebView 默认 —— 它的段落合并 fixup 会把行首那截文字吃掉。
//      在**末尾**换行还要补第二个 <br>(结尾的单个 <br> 不占行高),而"是不是在末尾"不能判
//      nextSibling 为空:insertNode 会切开文本节点,br 后面留个空文本节点,判空就漏。
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
// 末尾换行要补第二个 <br>:HTML 里结尾的单个 <br> 不占行高,新起的空行看不见、光标像没动。
// 只数 <br> 的个数,不绑某个变量名 —— 这条原本写死 /if \(!after\)/,等于替"用 nextSibling 判末尾"
// 那版实现站岗;后来判据换成下面那条更严的,它就失配了,而那次换恰恰是在修 bug。
assert.ok((branch.match(/createElement\("br"\)/g) || []).length >= 2,
  "末尾换行要补第二个 <br>,否则新起的空行不占高度、光标像没动");
// 判"在末尾"不能只看 br.nextSibling 是不是 null:光标停在文本节点末尾时,insertNode 会按规范
// 把那个文本节点切开,br 后面留下一个**空文本节点** —— 判 null 就漏了,于是行尾第一次 shift+⏎
// 看着没反应、得按第二下才换行。所以末尾判据必须把空文本节点跳过去。
assert.ok(/Node\.TEXT_NODE/.test(branch),
  "末尾判据要跳过空文本节点,别退回 br.nextSibling == null —— 那样行尾第一次换行会像没反应");
assert.ok(/histIdx\.current = -1/.test(branch) && /syncText\(\)/.test(branch),
  "手改 DOM 不触发 input 事件,onInput 里的 histIdx 复位和 syncText 得在分支里补上");

console.log("composer-keys: ok");
