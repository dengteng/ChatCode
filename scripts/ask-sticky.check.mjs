#!/usr/bin/env node
// AskUserQuestion 卡片:两头(选题标签 + 提交/跳过)都得钉住,中间那截才准滚。
//
// 卡片停靠在输入框位置时限了高、**整张卡**在滚(.ask-dock .ask-card)。选项一多:
//   · 脚栏滚下去 = 提交按钮看不见,而回车是刻意禁用的(防输入法确认候选词误提交),等于卡死;
//   · tab 排滚上去 = 既不知道现在第几题、也不知道哪题答过了(✓ 在 tab 里),只剩 ←→ 盲切。
// 两条都是"看着没坏"的退化,没人会为它报 bug,所以在这儿钉住。
//
// 跑法:node scripts/ask-sticky.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const CSS = readFileSync("src/styles.css", "utf8");
const CHAT = readFileSync("src/components/Chat.tsx", "utf8");

const rule = (sel) => {
  const m = new RegExp(`^\\${sel[0] === "." ? "." : ""}${sel.slice(1)} \\{([\\s\\S]*?)\\}`, "m").exec(CSS);
  assert.ok(m, `styles.css 里找不到 ${sel} 的规则(改名了就更新这条)`);
  return m[1];
};

// ---------- 1. 前提:卡片限高且自己滚 ----------
// 不滚的话下面两条 sticky 全是空转,坏了也看不出来 —— 所以前提得先钉住。
assert.ok(/\.ask-dock \.ask-card \{[^}]*max-height:[^}]*overflow-y: auto/.test(CSS),
  "停靠版卡片要限高 + 自己滚,否则 sticky 没有滚动容器可贴");

// ---------- 2. 选题标签钉在顶,脚栏钉在底 ----------
for (const [sel, side] of [[".ask-nav", "top"], [".ask-foot", "bottom"]]) {
  const body = rule(sel);
  assert.ok(/position: sticky/.test(body), `${sel} 要 position: sticky`);
  // -12px 而不是 0:卡片上下各有 12px 内边距,贴 0 的话那道缝里能看见选项从底下滑过去。
  assert.ok(new RegExp(`${side}: -12px`).test(body), `${sel} 要 ${side}: -12px,把卡片那 12px 内边距一起压住`);
  // 透明背景 = 选项直接从字底下穿过。inherit 是为了跟着卡片那三套底色
  // (5% accent / 停靠版 --panel / 自定义主题 --custom-dialog)走,不用复制三条规则。
  assert.ok(/background: inherit/.test(body), `${sel} 要 background: inherit,否则滚动内容会透上来`);
  // 负的左右 margin:横贯到卡片边沿,不然两侧各留 14px 的缝。
  assert.ok(/margin: [^;]*-14px/.test(body), `${sel} 要靠负 margin 横贯到卡片边沿`);
}

// ---------- 3. 标签和选项都走 btnPress ----------
// 点它们的时候焦点多半在自定义回复的 textarea 里,而 WKWebView 会把这种第一次 click 吞掉(见 lib/utils)。
// 切到下一个顶层 function 为止(函数体里嵌着好几个提前 return 的 `}`,按第一个行首 `}` 断会只截到签名)
const at = CHAT.indexOf("function AskQuestionCard");
assert.ok(at >= 0, "找不到 AskQuestionCard");
const next = CHAT.indexOf("\nfunction ", at + 1);
const card = CHAT.slice(at, next < 0 ? undefined : next);
// 取一个元素的属性段:从 className 起找配对的 '>'。花括号里的不算(属性值里全是表达式),
// 紧跟 '=' 的也不算 —— 箭头函数的 => 会把朴素的 /[\s\S]*?>/ 截在 btnPress 开头。
const attrs = (src, cls) => {
  const at = src.indexOf("className={`" + cls + " ");
  assert.ok(at >= 0, `找不到 .${cls} 那个元素`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return src.slice(at, i + 1);
  }
  assert.fail(`.${cls} 的标签没找到收尾的 '>'`);
};
for (const cls of ["ask-tab", "ask-opt"]) {
  const tag = attrs(card, cls);
  assert.ok(!/onClick=/.test(tag), `.${cls} 还挂着裸 onClick,第一次点会被吞:\n  ${tag.replace(/\s+/g, " ")}`);
  assert.ok(/\{\.\.\.btnPress\(/.test(tag), `.${cls} 要走 btnPress`);
  // btnPress 的 preventDefault 把移焦点也拦了,不自己收回来的话 ←→/↑↓ 会一直被 textarea 吃掉。
  assert.ok(/cardRef\.current\?\.focus\(\)/.test(tag),
    `.${cls} 点完要把焦点收回卡片,否则键盘切题/选项失灵`);
}

console.log("✅ ask-sticky: 卡片限高自滚 / 标签+脚栏两头钉住 / 标签+选项走 btnPress 并收回焦点 全部通过");
