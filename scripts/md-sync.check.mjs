#!/usr/bin/env node
// md 双栏同步滚动的自检。规则本体在 src/components/FileEditor.tsx 的 anchors()/interp()
// (tsx 没法直接 import),这里照抄一份插值再断言源码没漂移 —— 和 model-name.check.mjs 同一套路。
//
// 跑法:node scripts/md-sync.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/components/FileEditor.tsx", "utf8");
assert.ok(SRC.includes("const interp ="), "FileEditor 的 interp 已漂移");
assert.ok(SRC.includes("const anchors ="), "FileEditor 的 anchors 已漂移");
assert.ok(SRC.includes("data-cc-line"), "对照表要靠 rehypeLine 打的 data-cc-line,丢了就只能退回百分比");
assert.ok(!SRC.includes("from.scrollTop / fMax"), "百分比对齐已被行号对齐取代,别退回去 —— 表格一多就散架");
assert.ok(SRC.includes("anchorsRef.current?.h === root.scrollHeight"),
  "对照表必须按 scrollHeight 失效,否则改字/拖分栏/图片加载完之后还在用旧坐标");
assert.ok(SRC.includes("lineBlockAtHeight"), "顶边行号要走 CodeMirror 高度模型,软换行下 scrollTop 比例不作数");

const interp = (pts, from, v) => {
  const to = from === "line" ? "top" : "line";
  let i = 1;
  while (i < pts.length - 1 && pts[i][from] <= v) i++;
  const p = pts[i - 1], q = pts[i];
  const span = q[from] - p[from];
  const r = span > 0 ? Math.max(0, Math.min(1, (v - p[from]) / span)) : 0;
  return p[to] + r * (q[to] - p[to]);
};

// 一份"源码短、渲染高"的文档:第 10 行起是个大表格,源码 5 行、渲染 800px。
// 百分比对齐正是在这种文档上散架的,所以拿它当样本。
const PTS = [
  { line: 1, top: 0 },
  { line: 5, top: 100 },   // 一段正文
  { line: 10, top: 200 },  // 表格开始
  { line: 15, top: 1000 }, // 表格结束:5 行源码吃掉 800px
  { line: 21, top: 1100 }, // 文末虚拟点(lastLine=20)
];

// —— 锚点上的点必须精确命中,不许被插值带偏 ——
assert.equal(interp(PTS, "line", 10), 200);
assert.equal(interp(PTS, "line", 15), 1000);
// 表格内部按比例摊开:第 12.5 行 = 表格过半
assert.equal(interp(PTS, "line", 12.5), 600);
// 反向同样命中,且和正向互为逆运算 —— 两边来回滚不会越滚越偏
assert.equal(interp(PTS, "top", 600), 12.5);
assert.equal(interp(PTS, "top", interp(PTS, "line", 7.5)), 7.5);

// —— 边界:超出两端一律夹住,不能外插出负数或超过文档高 ——
assert.equal(interp(PTS, "line", 0), 0, "行号小于首锚点时顶到文档开头");
assert.equal(interp(PTS, "line", 999), 1100, "行号超过末锚点时停在文档底,不外插");
assert.equal(interp(PTS, "top", -50), 1);
assert.equal(interp(PTS, "top", 99999), 21);

// —— 退化:两个锚点同行号(span=0)不能除出 NaN ——
assert.ok(Number.isFinite(interp([{ line: 3, top: 0 }, { line: 3, top: 50 }], "line", 3)));

// —— 对照表只收双双递增的点(嵌套元素会同起点甚至插队,混进来插值会忽上忽下)——
const build = (raw) => {
  const pts = [{ line: 1, top: 0 }];
  for (const { line, top } of raw) {
    const last = pts[pts.length - 1];
    if (line > last.line && top > last.top) pts.push({ line, top });
  }
  return pts;
};
// table(行 10)/ tr(行 11)/ td(行 11,同起点) —— td 那条必须被挡掉
assert.deepEqual(build([{ line: 10, top: 200 }, { line: 11, top: 240 }, { line: 11, top: 240 }]),
  [{ line: 1, top: 0 }, { line: 10, top: 200 }, { line: 11, top: 240 }]);
// 行号递增但位置回退(浮动/绝对定位元素)也要挡掉,否则映射不单调
assert.deepEqual(build([{ line: 5, top: 300 }, { line: 6, top: 120 }]), [{ line: 1, top: 0 }, { line: 5, top: 300 }]);

console.log("✅ md-sync: 锚点命中 / 表格内插值 / 正反互逆 / 两端夹住 / 同行号不 NaN / 对照表单调 全部通过");
