#!/usr/bin/env node
// 编辑器两栏分割条的边界自检。clampFrac 同时管两条约束(≥50px、≤90%),而它们在小面板上会互相
// 反超 —— 夹错的表现是某一栏被拖没、再也拖不回来。纯函数复刻一份跑边界,DOM 那半截只能断言接线还在。
//
// 跑法:node scripts/split-clamp.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/components/FileEditor.tsx", "utf8");

// ---------- 1. clampFrac:和 FileEditor.tsx 里那份保持一致 ----------
const SPLIT_MIN_PX = 50;
const clampFrac = (f, size) => {
  const lo = Math.max(0.1, SPLIT_MIN_PX / size), hi = Math.min(0.9, 1 - SPLIT_MIN_PX / size);
  return lo > hi ? 0.5 : Math.min(hi, Math.max(lo, f));
};

// 宽面板(1000px):10% 的下限比 50px 严,90% 上限生效
assert.equal(clampFrac(0.5, 1000), 0.5, "中间值不该被动");
assert.equal(clampFrac(0, 1000), 0.1, "拖到最左要停在 10%");
assert.equal(clampFrac(1, 1000), 0.9, "拖到最右要停在 90%");
assert.equal(clampFrac(-5, 1000), 0.1, "鼠标拖出面板外也得夹住");

// 窄面板(200px):50px = 25%,比 10% 严,该由像素下限说了算
assert.equal(clampFrac(0, 200), 0.25, "窄面板下限按 50px 算");
assert.equal(clampFrac(1, 200), 0.75, "窄面板上限也按 50px 算(另一栏留够 50px)");
for (const size of [120, 200, 480, 500, 1400]) {
  for (const f of [0, 0.3, 0.5, 0.7, 1]) {
    const px = clampFrac(f, size) * size;
    assert.ok(px >= SPLIT_MIN_PX - 1e-9 && size - px >= SPLIT_MIN_PX - 1e-9,
      `size=${size} f=${f}: 有一栏窄于 50px(得 ${px.toFixed(1)}px / ${(size - px).toFixed(1)}px)`);
  }
}

// 面板窄到装不下两个 50px:两条约束打架,退回五五开而不是夹出个反的
assert.equal(clampFrac(0.9, 80), 0.5, "面板 < 100px 时退回五五开");
assert.equal(clampFrac(0.9, 100), 0.5, "刚好 100px 也算打架(lo=hi=0.5 不走翻转分支但结果同)");

// 没有尺寸时(初始读 localStorage)只应用百分比约束
assert.equal(clampFrac(2, Infinity), 0.9, "无尺寸时按 90% 夹");
assert.equal(clampFrac(0.42, Infinity), 0.42, "无尺寸时合法值原样保留");

// ---------- 2. 接线还在 ----------
assert.ok(/const \[split, setSplit\] = useState\(\(\) => clampFrac\(/.test(SRC),
  "localStorage 里存着的比例要先过一遍 clampFrac —— 旧版本存过的值可能越界");
assert.ok(/style=\{preview \? \{ flex: `0 0 \$\{split \* 100\}%` \}/.test(SRC),
  "源码栏的 flex-basis 要跟着 split 走(纵向布局下同一行代码作用于高度)");
assert.ok(/className="feditor-split-bar" onMouseDown=\{startSplit\}/.test(SRC), "拖动条没接上 startSplit");
assert.ok(/new ResizeObserver\(\(\) => setSplit\(\(f\) => clampFrac\(/.test(SRC),
  "浮窗拖角缩小后要回夹一次,否则某一栏会被压到 50px 以下");
// 拖到 iframe 上时 mousemove 归它自己的文档,不挡住就拖一半断掉
assert.ok(/classList\.add\("feditor-dragging"\)/.test(SRC) && /classList\.remove\("feditor-dragging"\)/.test(SRC),
  "拖动期间要给 iframe 关掉 pointer-events,且拖完要摘干净");
assert.ok(/\.feditor-dragging \.feditor-preview-frame \{ pointer-events: none; \}/
  .test(readFileSync("src/styles.css", "utf8")), "styles.css 缺 feditor-dragging 的 pointer-events 规则");

// ---------- 3. 预览开关 ----------
// 关掉预览要一路关到底:分栏、拖动条、右栏本身,还有 html 那条读盘内联的链路(不然白关)。
assert.ok(/localStorage\.getItem\("ChatCode-feditor-preview"\) !== "0"/.test(SRC),
  "预览开关要记进 localStorage 且默认开(只有显式存过 \"0\" 才算关)");
assert.ok(/const preview = canPreview && previewOn;/.test(SRC),
  "preview 要 = 类型支持 && 用户没关 —— 下游的分栏/拖动条/同步滚动全看它");
assert.ok(/\{preview && isMd &&/.test(SRC) && /\{preview && isHtml &&/.test(SRC),
  "两个预览栏都要跟着开关走,只改 split 类名没用");
assert.ok(/if \(!preview \|\| !isHtml \|\| !previewText\)/.test(SRC) && /if \(!preview \|\| !isHtml \|\| previewText === null\)/.test(SRC),
  "关了预览还在扫 refs / 拼 htmlDoc:每敲一键读盘内联上兆 base64,等于没关");
assert.ok(/\{canPreview && \(/.test(SRC), "开关按钮的显示条件是 canPreview(不是 preview,否则关掉就再也开不回来)");

console.log("✓ split-clamp 自检通过");
