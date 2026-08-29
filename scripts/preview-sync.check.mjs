#!/usr/bin/env node
// 「点源码 → 预览定位」的自检。tagLines 是个正则解析器,错一条就会把用户的 html 改坏
// (属性粘连、script 里的字符串被当标签),这里把它复刻一份跑边界用例;DOM 那半截 node 里跑不了,
// 只能断言 FileEditor.tsx 的接线还在。和 copy-rich.check.mjs 同一套路。
//
// 跑法:node scripts/preview-sync.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/components/FileEditor.tsx", "utf8");

// ---------- 1. tagLines:和 FileEditor.tsx 里那份保持一致 ----------
function tagLines(src) {
  const starts = [];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  const lineAt = (off) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= off) lo = m + 1; else hi = m; }
    return lo + 1;
  };
  const skip = [];
  for (const m of src.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    skip.push([m.index + m[0].indexOf(">") + 1, m.index + m[0].length]);
  }
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) skip.push([m.index, m.index + m[0].length]);
  return src.replace(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (tag, name, attrs, off) => {
    if (skip.some(([s, e]) => off >= s && off < e)) return tag;
    if (/^(br|meta|base|title|html|head)$/i.test(name)) return tag;
    const self = attrs.endsWith("/");
    return `<${name}${self ? attrs.slice(0, -1).trimEnd() : attrs} data-cc-line="${lineAt(off)}"${self ? " /" : ""}>`;
  });
}

const lineOf = (out, needle) => +out.match(new RegExp(`${needle}[^>]*data-cc-line="(\\d+)"`))[1];

// 行号从 1 数起,且按源码真实行走
const doc = `<div class="a">\n  <p>hi</p>\n</div>`;
const out1 = tagLines(doc);
assert.equal(lineOf(out1, "<div"), 1, "第一行的 div 应该是 1");
assert.equal(lineOf(out1, "<p"), 2, "第二行的 p 应该是 2");
assert.ok(!/<\/div[^>]*data-cc-line/.test(out1), "闭合标签不该被写属性");

// script / style 的内容里那些 `<div>` 是字符串,不是标签 —— 加了属性就把用户的 JS 改坏了
const withJs = `<body>\n<script>\n  el.innerHTML = "<div>x</div>";\n</script>\n</body>`;
const out2 = tagLines(withJs);
assert.ok(out2.includes(`el.innerHTML = "<div>x</div>";`), "script 内容被篡改了");
assert.equal(lineOf(out2, "<body"), 1);
// 外链 script 标签本身要能拿到行号(后面 htmlDoc 还要按它内联)
assert.ok(/<script src="a\.js" data-cc-line="2">/.test(tagLines(`<body>\n<script src="a.js"></script>`)),
  "外链 script 的开标签应该照常打行号");

// 自闭合的斜杠必须留在最后,否则属性名会粘上它变成 `/data-cc-line`
assert.ok(/<img src="a\.png" data-cc-line="1" \/>/.test(tagLines(`<img src="a.png" />`)), "自闭合标签的斜杠位置错了");

// 属性值里带 `>` 不能把标签提前截断
const gt = tagLines(`<div title="a > b">x</div>`);
assert.ok(gt.includes(`title="a > b"`) && /<div title="a > b" data-cc-line="1">/.test(gt), "属性值里的 > 把标签截断了");

// 注释和 doctype 不是元素,别插属性
assert.ok(!tagLines(`<!DOCTYPE html>\n<!-- <div> -->`).includes("data-cc-line"), "doctype/注释不该被写属性");

// ---------- 2. FileEditor.tsx 的接线 ----------
// 行号必须在资源内联**之前**注入:内联会改变文本长度,之后再算偏移就对不上源码行了
assert.ok(/return tagLines\(previewText\)\s*\n\s*\.replace\(LINK_RE/.test(SRC),
  "htmlDoc 必须先 tagLines 再内联资源,顺序反了行号会全错");
assert.ok(/\}\) \+ SCROLL_RUNTIME;/.test(SRC), "htmlDoc 末尾要追加 SCROLL_RUNTIME,否则 iframe 收不到 postMessage");
assert.ok(SRC.includes("<iframe ref={frameRef}"), "iframe 没接 ref,postMessage 发不出去");
assert.ok(/rehypePlugins=\{\[rehypeLine\]\}/.test(SRC), "md 预览要挂 rehypeLine,否则没有 data-cc-line 可找");
assert.ok(/view\.dom\.addEventListener\("mouseup"/.test(SRC), "少了 mouseup 钩子,点击不会触发定位");
assert.ok(/jumpRef\.current\(view\.state\.doc\.lineAt/.test(SRC),
  "mouseup 里要走 jumpRef(onCreate 只跑一次,直接闭包会锁住首帧的 jumpTo)");
// selectionchange 排在 mouseup 之后,读 selection 会拿到上一次的光标 —— 预览慢一拍
assert.ok(/lineAt\(view\.posAtCoords\(\{ x: e\.clientX, y: e\.clientY \}, false\)\)/.test(SRC),
  "行号要按鼠标坐标现算,读 view.state.selection 会慢一拍");
assert.ok(!/selection\.main\.head/.test(SRC), "别再从 selection 取跳转行号");
// 定位引起的预览滚动会触发对面 align,不占住 driver 就会被反推回来
assert.ok(/driver\.current = "src";\s*\n\s*jumpRef/.test(SRC), "跳转前要先把 driver 占成 src");

console.log("✓ preview-sync 自检通过");
