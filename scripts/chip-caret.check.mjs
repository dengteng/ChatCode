#!/usr/bin/env node
// 输入框图片 chip 两侧的光标落点自检。
// bug:chip 前面没垫零宽字符时(删换行/历史回填会丢),在上一行行尾按 →,sel.modify 一步就把光标
//     跨到 chip 右侧,永远停不到 chip 左边。修法:行尾 → 且下一行以 chip 开头,直接把光标落到 chip 左侧。
// 两层:
//   1) 源码闸(总会跑):行尾 → 下一行是 chip 的那条分支在,且排在 sel.modify 之前。
//   2) WebKit 实跑(装了 playwright-core + WebKit 才跑,否则跳过):把 Composer.tsx 里真实的方向键块
//      和 selectionchange 兜底抠出来,在 5 种 DOM 结构上按键,断言光标左右落点。
//      找不到浏览器时:PLAYWRIGHT_CORE=<playwright-core 目录> WEBKIT_EXE=<.../pw_run.sh>。
// 跑法:node scripts/chip-caret.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";

const SRC = readFileSync("src/components/Composer.tsx", "utf8");

// ---------- 1. 源码闸 ----------
const branchAt = SRC.search(/nx\.nodeName === "BR" \? asChip\(skipZwspNodes\(nx\.nextSibling, "next"\)\)/);
const modifyAt = SRC.indexOf('sel.modify("move", dir, "character")');
assert.ok(branchAt > 0, "行尾 → 且下一行以 chip 开头的分支没了 —— modify 会一步跨过整块");
assert.ok(branchAt < modifyAt, "这条分支必须排在 sel.modify 之前,否则光标已经被推过 chip");

// ---------- 2. WebKit 实跑 ----------
const cut = (from, to) => {
  const a = SRC.indexOf(from), b = SRC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `抠不出源码片段:${from}`);
  return SRC.slice(a, b);
};
const helpers = cut("const ZWSP =", "\n// 复制/剪切编辑器选区").replace(/^interface .*$/m, "");
const chipChunk = SRC.slice(SRC.indexOf("function chipAfterCaret"), SRC.indexOf("// 按会话 id 暂存未发送草稿"));
const keyBlock = cut('if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey) {', "// shift+⏎ 换行自己插");
const fixBlock = cut("const mark = (ed: HTMLElement", 'document.addEventListener("selectionchange", fix);');
const ts = `
${helpers}
${chipChunk}
const edRef = { get current() { return document.getElementById("ed") as HTMLElement; } };
function onKey(e: KeyboardEvent) {
  ${keyBlock}
}
${fixBlock}
document.addEventListener("selectionchange", fix);
document.addEventListener("keydown", (e) => { if ((e.target as HTMLElement).id === "ed") onKey(e); });
`;
const js = transformSync(ts, { loader: "ts" }).code;
const css = (() => {
  const m = readFileSync("src/styles.css", "utf8").match(/\.img-tag, \.ref-tag \{.*?\n\}/s);
  return m ? m[0].replace(/var\(--[\w-]+\)/g, "#c0622a") : "";
})();

let webkit;
try {
  const req = createRequire(import.meta.url);
  webkit = req(process.env.PLAYWRIGHT_CORE || "playwright-core").webkit;
} catch {}
let browser;
if (webkit) {
  try {
    browser = await webkit.launch(process.env.WEBKIT_EXE ? { executablePath: process.env.WEBKIT_EXE } : {});
  } catch {}
}
if (!browser) {
  console.log("chip-caret: 源码闸 ok;没有可用的 playwright WebKit,实跑部分跳过");
  process.exit(0);
}

const ZW = "​";
const chip = (n) => `<span class="img-tag" contenteditable="false" data-id="${n}"><span class="img-tag-label"><svg width="13" height="13" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3"/></svg> 图片${n}</span></span>`;
const L1 = `1、${ZW}${chip(1)}${ZW}还是会有下面是一大片空白的情况`;
const cases = {
  "chip 前后都有垫字符": `${L1}<br>2、<br>${ZW}${chip(2)}${ZW}`,
  "chip 后面还有收尾 <br>": `${L1}<br>2、<br>${ZW}${chip(2)}${ZW}<br>`,
  "下一行是 <div>": `${L1}<br>2、<div>${ZW}${chip(2)}${ZW}</div>`,
  "chip 前没有垫字符(bug 现场)": `${L1}<br>2、<br>${chip(2)}${ZW}`,
  "chip 前后都没垫字符": `${L1}<br>2、<br>${chip(2)}`,
};

// 光标相对最后一个 chip:left = 在它左侧(紧贴它的垫字符里,或元素边界),right = 右侧,in = 钻进内部
const where = () => {
  const s = getSelection(), c = [...document.querySelectorAll(".img-tag")].pop();
  const n = s.anchorNode, o = s.anchorOffset;
  if ((n.nodeType === 1 ? n : n.parentElement).closest(".img-tag")) return "in";
  const strip = (t) => t.split("​").join("");
  let p = c.previousSibling;
  if (n === p || (n === c.parentNode && n.childNodes[o] === c)) return "left";
  if (n === c.nextSibling || (n === c.parentNode && n.childNodes[o - 1] === c)) return "right";
  return "other";
};

let failed = 0;
for (const [name, html] of Object.entries(cases)) {
  // 每个用例一张新页:setContent 不会清掉 document 上挂的监听,同页复用会让方向键处理跑多遍
  const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
  await page.setContent(
    `<style>body{font:14px Inter,-apple-system,sans-serif;width:520px}${css}.editor{white-space:pre-wrap;line-height:1.5}</style>` +
    `<div id="ed" class="editor" contenteditable="true">${html}</div>`);
  await page.addScriptTag({ content: js });
  await page.focus("#ed");
  await page.evaluate(() => { // 光标放在「2、」行尾
    const w = document.createTreeWalker(document.getElementById("ed"), NodeFilter.SHOW_TEXT);
    let n, t; while ((n = w.nextNode())) if (n.textContent.startsWith("2、")) t = n;
    const r = document.createRange(); r.setStart(t, t.textContent.length); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  const at = () => page.evaluate(`(${where})()`);
  const trail = [];
  for (const [key, want] of [["ArrowRight", "left"], ["ArrowRight", "right"], ["ArrowLeft", "left"]]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(50); // selectionchange 是异步派发,兜底要等它跑完才算最终落点
    const got = await at();
    trail.push(`${key === "ArrowRight" ? "→" : "←"}${got}`);
    if (got !== want) { failed++; console.error(`✗ ${name}: 按 ${key} 后期望在 chip ${want},实际 ${got}(轨迹 ${trail.join(" ")})`); break; }
  }
  await page.close();
}
await browser.close();
assert.equal(failed, 0, `${failed} 个用例光标落点不对`);
console.log("chip-caret: ok(源码闸 + WebKit 实跑 5 种结构)");
