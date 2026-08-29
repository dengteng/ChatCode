import { useLayoutEffect, useRef } from "react";

const NAME = "ChatCode";

// 三根线的变形走 SMIL,不走 CSS @keyframes 的 d:path() —— 后者只有 Chromium 认,
// WebKit(= Tauri 的 WKWebView)整个忽略,浏览器里好好的动画进 App 就只剩气泡在鼓。
// 每个 d 都是「M + 两段 C」,段数/段类型必须一致才能插值;代码态那三根本是折线,
// 写成控制点退化的 C(控制点=端点)纯粹为对齐段数,笑脸态才给真控制点弯成圆拱。
const EYE_L = ["M212,210 C212,210 176,251 176,251 C176,251 212,292 212,292", "M184,238 C184,238 197,208 211,208 C225,208 238,238 238,238"];
const EYE_R = ["M300,210 C300,210 336,251 336,251 C336,251 300,292 300,292", "M274,238 C274,238 287,208 301,208 C315,208 328,238 328,238"];
const MOUTH = [
  "M280,185 C280,185 259,247 259,247 C259,247 238,310 238,310", // 代码态的 /
  "M214,272 C214,272 234,294 256,294 C278,294 298,272 298,272", // 合
  "M210,268 C210,268 230,320 256,320 C282,320 302,268 302,268", // 张
];

/** 一条 2.15s 的 d 变形。keySplines 补回 CSS 里那条 ease-in-out,SMIL 默认是线性的。 */
const morph = (values: string[], keyTimes: string) => (
  <animate
    attributeName="d"
    dur="2.15s"
    fill="freeze"
    calcMode="spline"
    values={values.join(";")}
    keyTimes={keyTimes}
    keySplines={Array(values.length - 1).fill(".5 0 .5 1").join(";")}
  />
);

// 进场动画一次会话只播一次。空态每次从会话切回来都重新挂载,不记这一笔的话
// 每回主区空下来都要再看 2.5s 的 logo 说话 + 逐字,很快就烦。
let introPlayed = false;

/** 首页品牌区:logo 里的 </> 变成笑脸说话 → logo 左移让位 → 字母逐个出现。 */
export function BrandIntro() {
  const ref = useRef<HTMLDivElement>(null);
  // reduced-motion 也走 skip 分支:CSS 那条 media query 管不到 SMIL,
  // 不在这儿拦掉的话减弱动效的用户照样看见嘴在动。
  const skip = useRef(introPlayed || matchMedia("(prefers-reduced-motion: reduce)").matches);

  useLayoutEffect(() => {
    introPlayed = true;
    const measure = () => {
      const brand = ref.current;
      if (!brand) return;
      const logo = brand.querySelector<HTMLElement>(".brand-logo");
      const word = brand.querySelector<HTMLElement>(".brand-word");
      if (!logo || !word) return;

      // logo 起手停在整体(logo + 词)的正中央,--slide 就是它之后要让出去的距离
      const total = word.offsetLeft + word.offsetWidth;
      brand.style.setProperty("--slide", `${(total - logo.offsetWidth) / 2}px`);
    };
    measure();
    // Inter Variable 是 webfont,首次启动大概率在这之后才落地 —— 字宽一变
    // 上面量的 --slide 就偏了,logo 起手位置不居中。字体就绪后再量一次。
    document.fonts?.ready.then(measure);
  }, []);

  return (
    <div className="brand" ref={ref} data-skip={skip.current ? "" : undefined}>
      <div className="brand-logo">
        <svg viewBox="0 0 512 512">
          <defs>
            <linearGradient id="brand-lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#1a6bff" />
              <stop offset="1" stopColor="#5b2ce8" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="115" fill="url(#brand-lg)" />
          {/* 几何全部由 public/logo.png 逐行扫白色像素反算:白色 bbox 是描边外沿,
              中心线各往里缩半个 stroke。气泡中心线 x116~396 / y130~370 / 圆角 105。 */}
          <path
            className="brand-bubble"
            d="M221,130 H291 A105,105 0 0 1 396,235 V265 A105,105 0 0 1 291,370 H221 A105,105 0 0 1 188,366 L146,395 L139,331 A105,105 0 0 1 116,265 V235 A105,105 0 0 1 221,130 Z"
          />
          {/* skip 时干脆不渲染 <animate>:SMIL 归浏览器的 SVG 时间线管,
              CSS 那句 animation:none 关不掉它。 */}
          <path className="brand-eye-l" d={EYE_L[0]}>
            {!skip.current && morph([EYE_L[0], EYE_L[0], EYE_L[1], EYE_L[1], EYE_L[0]], "0;.23;.35;.82;1")}
          </path>
          <path className="brand-eye-r" d={EYE_R[0]}>
            {!skip.current && morph([EYE_R[0], EYE_R[0], EYE_R[1], EYE_R[1], EYE_R[0]], "0;.23;.35;.82;1")}
          </path>
          <path className="brand-mouth" d={MOUTH[0]}>
            {!skip.current && morph([MOUTH[0], MOUTH[0], MOUTH[1], MOUTH[2], MOUTH[1], MOUTH[2], MOUTH[1], MOUTH[1], MOUTH[0]], "0;.23;.35;.45;.55;.65;.75;.82;1")}
          </path>
        </svg>
      </div>
      <div className="brand-word">
        {/* letter-in 逐个错开;skip 时不写 delay,CSS 那条 animation:none 直接落终态 */}
        {Array.from(NAME).map((ch, i) => (
          <span key={i} style={skip.current ? undefined : { animationDelay: `${2.5 + i * 0.07}s` }}>
            {ch}
          </span>
        ))}
      </div>
    </div>
  );
}
