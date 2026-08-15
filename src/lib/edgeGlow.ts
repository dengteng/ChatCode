// 鼠标边缘扫光:写 4 个 CSS 变量,样式全在 CSS 里(见 styles.css 的 .edge-glow)。
//   --mx/--my  光标在元素内的坐标 → spotlight 径向高光
//   --edge     0~100,离最近的边越近越大 → 控制边缘环亮度
//   --ang      光标相对中心的角度 → conic mask 只点亮那条边
// 原本只有消息气泡用(Chat.tsx 里委托实现),侧栏/输入框/抽屉也要,就抽出来共用。

// 大面板上 mousemove 很密,而 --edge 变化会触发 inset box-shadow 重绘。
// 用 rAF 合帧:一帧内只落最后一次位置,避免同帧多次重绘。
let pending: (() => void) | null = null;
function schedule(fn: () => void) {
  if (!pending) requestAnimationFrame(() => { pending?.(); pending = null; });
  pending = fn;
}

export function applyEdgeGlow(el: HTMLElement, clientX: number, clientY: number) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = clientX - r.left, y = clientY - r.top;
  const cx = r.width / 2, cy = r.height / 2, dx = x - cx, dy = y - cy;
  // 归一化的切比雪夫距离:0=正中,1=贴边。取两轴里更靠边的那个。
  const edge = Math.min(Math.max(Math.max(Math.abs(dx) / cx, Math.abs(dy) / cy), 0), 1) * 100;
  let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90; if (deg < 0) deg += 360;
  schedule(() => {
    el.style.setProperty("--mx", `${x}px`);
    el.style.setProperty("--my", `${y}px`);
    el.style.setProperty("--edge", edge.toFixed(1));
    el.style.setProperty("--ang", `${deg.toFixed(1)}deg`);
  });
}

// 直接挂在元素上:onMouseMove={onEdgeGlow}
export const onEdgeGlow = (e: { currentTarget: HTMLElement; clientX: number; clientY: number }) =>
  applyEdgeGlow(e.currentTarget, e.clientX, e.clientY);
