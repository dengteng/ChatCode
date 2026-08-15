// 架构图后处理：fireworks-tech-graph 渲染出来的 SVG 上再改两处，跑完 render 就跑这个。
//   1) 删掉每个容器左侧那条 ownership spine 竖线（skill 的 Style 10 装饰，图上显杂乱）
//   2) 给每条连线叠一层流动虚线，做数据流动画
// 官方 animate 子命令走不了：Style 10 的运动契约钉死 5 条边 + 固定 role/stage/order，本图 9 条边。
// 用法: node scripts/polish-architecture.mjs docs/chatcode-architecture.svg
import fs from "node:fs";

const file = process.argv[2] || "docs/chatcode-architecture.svg";
let svg = fs.readFileSync(file, "utf8");

// spine 靠 opacity="0.72" 认，图例那几条短线没有这个属性
const before = svg.length;
svg = svg.replace(/\s*<line data-graph-role="decoration"[^>]*opacity="0\.72"\/>/g, "");
if (svg.length === before) throw new Error("没删掉任何 spine，渲染器的装饰写法可能变了");

// 右上角 PROVIDER-NEUTRAL / LOCAL-FIRST 印章，Style 10 强制渲染，JSON 关不掉
const stamp = svg.length;
svg = svg.replace(/\s*<g id="style-signature"[\s\S]*?<\/g>/, "");
if (svg.length === stamp) throw new Error("没删掉右上角印章，渲染器的签名写法可能变了");

// 每条 edge 复制一份无箭头的虚线覆盖上去，dashoffset 走满一个周期再循环 = 无缝流动
const edges = [...svg.matchAll(/<path id="([^"]+)" data-graph-role="edge"[^>]*? d="([^"]+)" fill="none" stroke="([^"]+)"/g)];
if (!edges.length) throw new Error("没找到 edge，选择器要跟着渲染器改");

const DASH = 9, GAP = 21, PERIOD = DASH + GAP;
const flow = edges
  .map(([, id, d, stroke], i) =>
    `  <path data-graph-role="decoration" data-owner="${id}" d="${d}" fill="none" stroke="${stroke}" ` +
    `stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${DASH} ${GAP}" ` +
    `class="cc-flow" style="animation-delay:${(-i * 0.18).toFixed(2)}s"/>`)
  .join("\n");

const css = `  <style>
    @keyframes cc-march { from { stroke-dashoffset: ${PERIOD}; } to { stroke-dashoffset: 0; } }
    .cc-flow { animation: cc-march 1.17s linear infinite; opacity: 0.95; }
    @media (prefers-reduced-motion: reduce) { .cc-flow { animation: none; opacity: 0; } }
  </style>
`;

svg = svg.replace("</svg>", `${css}<g data-graph-role="decoration">\n${flow}\n  </g>\n</svg>`);
fs.writeFileSync(file, svg);
console.log(`spine 已删 5 条，流动层已加 ${edges.length} 条 → ${file}`);
