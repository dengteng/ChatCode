import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { TriangleAlert } from "lucide-react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { EmptyComposer } from "./components/EmptyComposer";
import { BrandIntro } from "./components/BrandIntro";
import { InfoPanel, TurnDrawer } from "./components/InfoPanel";
import { SearchPanel } from "./components/SearchPanel";
import { Settings } from "./components/Settings";
import { checkVersion, shouldPromptUpdate, markUpdatePrompted, type VersionCheck } from "./version";
import { UpdateDialog } from "./components/UpdateDialog";
import { ToastHost } from "./components/Toast";
import { THEMES, type ThemeId, type CustomArt } from "./types";

// 图片主色 → 当前明暗基座下的 accent(Dream Skin 思路):
// 色相取图的,饱和度夹到 [0.38, 0.72],亮度按基座钉死(浅 0.42 / 深 0.66)——对比度永远受控,换任何图都协调。
// 智能布局:由上传时的图分析(CustomArt)推导 —— 主区壳明暗 + 各表面不透明度。
// 壳:主区在右,按 平均亮度40% + 右侧亮度60% 加权定;亮图浅壳深字,暗图深壳亮字。
// 透明度:各表面有自己的档位区间(侧栏 .82~.94 / 顶栏 .78~.90 / 卡片 .88~.96 / 代码 .94~1 / 输入 .94~.98 / 弹窗 .96~1),
//   图越复杂(complexity)越靠区间上限;再按"面板色×α + 图亮度×(1-α) 的等效底色 vs 正文字色"反推出
//   满足 4.5:1 对比的最低 α,两者取大 —— 亮度不可控的用户图也保证可读。
function customLayout(art: CustomArt | null) {
  const lum = art?.lum ?? 0.35, lumL = art?.lumL ?? lum, lumR = art?.lumR ?? lum, c = art?.complexity ?? 0.5;
  const main = lum * 0.4 + lumR * 0.6;
  const shell: "dark" | "light" = main >= 0.52 ? "light" : "dark";
  // 深面板(亮字 L≈.93):等效底亮度须 ≤.168;浅面板(深字 L≈.01):等效底亮度须 ≥.22
  const minDark = (L: number) => (L > 0.168 ? (L - 0.168) / Math.max(0.05, L - 0.03) : 0);
  const minLight = (L: number) => (L < 0.22 ? (0.22 - L) / Math.max(0.05, 0.97 - L) : 0);
  const minMain = shell === "light" ? minLight(main) : minDark(main);
  // 侧栏壳:按左侧图(lumL)独立定明暗 —— 左边亮就用浅侧栏配深字,左边暗就深侧栏配亮字
  const sbShell: "dark" | "light" = lumL >= 0.52 ? "light" : "dark";
  const a = (base: number, range: number, min: number) => Math.min(1, Math.max(base + range * c, min)).toFixed(3);
  return {
    shell,
    sbShell,
    sb: a(0.82, 0.12, sbShell === "light" ? minLight(lumL) : minDark(lumL)),
    // 侧栏磨砂饱和度:图越复杂(花花绿绿)越去饱和,把身后的彩色混乱降成灰调,玻璃才和谐。c=0→1.15,c=1→0.6
    sbSat: Math.max(0.55, 1.15 - c * 0.55).toFixed(3),
    head: a(0.78, 0.12, minMain),
    card: a(0.88, 0.08, minMain),
    code: a(0.94, 0.06, minMain),
    input: a(0.80, 0.06, minMain), // 更透,让背景图透出一点;minMain 兜底保证正文对比不破

    dialog: a(0.96, 0.04, minMain),
  };
}

// —— 配色辅助:HSL→hex + WCAG 对比,accent/glow 都据此按壳反推亮度保证可读 ——
function hueSatOf(hex: string): { h: number; s: number } | null {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return null;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s };
}
function hslHex(h: number, S: number, L: number): string {
  const f = (k: number) => {
    const t = (k + h / 30) % 12;
    const v = L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(t - 3, 9 - t, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const _lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function relLumHex(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * _lin((n >> 16) & 255) + 0.7152 * _lin((n >> 8) & 255) + 0.0722 * _lin(n & 255);
}
const contrastOn = (hex: string, panelL: number) => { const l = relLumHex(hex); return (Math.max(l, panelL) + 0.05) / (Math.min(l, panelL) + 0.05); };
// ponytail: 面板半透明叠在背景图上,真实底色不可知;用不透明极值(浅≈白 .98 / 深≈极暗 .012)兜底,
// 与 customLayout 里 minMain 同一近似思路 —— 保证任意图都不破正文/主色对比。
const PANEL_L = (shell: "dark" | "light") => (shell === "light" ? 0.98 : 0.012);

// 主色:取图主色色相 + 夹紧饱和,亮度不再固定,按壳向暗/亮方向步进直到 accent↔面板 ≥4.5:1。
// 青/黄/绿等高亮度色相在浅壳上自动压更暗,不再糊在白面板里。
function shellAccent(hex: string, shell: "dark" | "light"): string {
  const p = hueSatOf(hex);
  if (!p) return hex;
  const S = Math.min(0.72, Math.max(0.38, p.s));
  const panelL = PANEL_L(shell), dir = shell === "light" ? -0.03 : 0.03;
  let L = shell === "light" ? 0.44 : 0.64, out = hslHex(p.h, S, L);
  for (let i = 0; i < 16 && contrastOn(out, panelL) < 4.5 && L > 0.12 && L < 0.9; i++) { L += dir; out = hslHex(p.h, S, L); }
  return out;
}

// 光晕/微光色:保留图主色色相,饱和度只夹到 [0.55, 0.85](不把柔和低饱和图强拉成霓虹)。
// 非正文,浅壳下把亮度压到 ≥3:1 够醒目即可,深壳保持亮版。
function glowAccent(hex: string, shell: "dark" | "light"): string {
  const p = hueSatOf(hex);
  if (!p) return hex;
  const S = Math.min(0.85, Math.max(0.55, p.s));
  const panelL = PANEL_L(shell);
  let L = 0.62, out = hslHex(p.h, S, L);
  if (shell === "light") for (let i = 0; i < 12 && contrastOn(out, panelL) < 3 && L > 0.2; i++) { L -= 0.03; out = hslHex(p.h, S, L); }
  return out;
}

const SB_MIN = 76;     // 侧栏最窄:约等于红绿灯三颗按钮的宽度
const SB_NARROW = 150; // 窄于此 → 图标模式

export default function App() {
  const { t } = useTranslation();
  const { state } = useStore();
  const [showInfo, setShowInfo] = useState(false);
  const [infoTab, setInfoTab] = useState<"project" | "branches" | "files" | "memory" | "btw">("branches");
  const [memoryTarget, setMemoryTarget] = useState<string | undefined>(); // 从气泡"记忆引用/更新"跳转时要高亮的记忆文件名
  const [turnAnchor, setTurnAnchor] = useState<number | null>(null); // 非 null = 抽屉开着,值为该轮起始用户消息 ts(0 = 会话开头那轮)
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined); // 侧栏"插件·MCP·Skills"点开时定位到扩展页
  const [update, setUpdate] = useState<VersionCheck | null>(null); // 有新版:侧栏底部常驻"新版本"入口
  const [showUpdate, setShowUpdate] = useState(false);             // 更新弹窗是否展开
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem("ChatCode-theme");
    return THEMES.some((t) => t.id === saved) ? (saved as ThemeId) : "dark";
  });
  const applyTheme = (id: ThemeId) => { localStorage.setItem("ChatCode-theme", id); setTheme(id); };
  // 自定义主题:背景图(dataURL)+ 毛玻璃开关,各存 localStorage。
  // ponytail: dataURL 直存 localStorage,单图几 MB 够用;超大图会顶到 ~5MB 配额,真需要再加压缩。
  const [customBg, setCustomBg] = useState<string>(() => localStorage.getItem("ChatCode-custom-bg") || "");
  // 上传时的图分析结果(主色/亮度/复杂度);壳与各表面透明度由 customLayout 推导
  const [customArt, setCustomArt] = useState<CustomArt | null>(() => {
    try { return JSON.parse(localStorage.getItem("ChatCode-custom-art") || "null"); } catch { return null; }
  });
  const applyCustomBg = (url: string, artJson?: string) => {
    setCustomBg(url); // 先应用,存储失败也不影响本次会话
    let art: CustomArt | null = null;
    if (url && artJson) { try { art = JSON.parse(artJson); } catch { /* 分析失败走默认布局 */ } }
    setCustomArt(art);
    try {
      if (url) localStorage.setItem("ChatCode-custom-bg", url); else localStorage.removeItem("ChatCode-custom-bg");
      if (art) localStorage.setItem("ChatCode-custom-art", JSON.stringify(art)); else localStorage.removeItem("ChatCode-custom-art");
      localStorage.removeItem("ChatCode-custom-accent"); localStorage.removeItem("ChatCode-custom-overlay"); // 旧版遗留键
    } catch { /* 超配额:本次生效,但重启不保留 */ }
  };
  // 侧栏磨砂参数:高斯模糊半径(px)+ 亮度(1=100%),设置里可调,存 localStorage
  const [customBlur, setCustomBlur] = useState<number>(() => { const v = Number(localStorage.getItem("ChatCode-custom-blur")); return v >= 0 ? v : 18; });
  const [customBrightness, setCustomBrightness] = useState<number>(() => { const v = Number(localStorage.getItem("ChatCode-custom-brightness")); return v > 0 ? v : 1; });
  const applyCustomBlur = (v: number) => { localStorage.setItem("ChatCode-custom-blur", String(v)); setCustomBlur(v); };
  const applyCustomBrightness = (v: number) => { localStorage.setItem("ChatCode-custom-brightness", String(v)); setCustomBrightness(v); };
  const lay = customLayout(customArt); // 自定义主题的智能布局(壳 + 各表面透明度)
  // 明暗基座:管原生标题栏 + 浅色附属样式。自定义主题按图分析出的壳定。
  const base = theme === "custom" ? lay.shell : (THEMES.find((t) => t.id === theme)?.base ?? "dark");
  const active = state.activeId ? state.sessions[state.activeId] : null;
  // 原生标题栏只认明暗基座;窗口级 setTheme 在 macOS 不生效,走 Rust app.set_theme
  useEffect(() => { invoke("set_app_theme", { theme: base }).catch(() => {}); }, [base]);
  // data-theme(基座)决定明暗与浅色附属样式;data-palette(配色)只覆盖侧栏底色/主色调等变量。
  // 两者都打到 <html>:Radix(Dialog/菜单/Tooltip)把内容 Portal 到 body(在 .app 之外),否则浅色弹层会掉回暗色变量。
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", base);
    document.documentElement.setAttribute("data-palette", theme);
    // 壳/透明度/主色都打到 <html>(弹层 Portal 在 .app 外也要拿到):
    // data-custom-shell 定主区明暗;--ca-* 是各表面不透明度;--custom-accent 是按壳夹紧后的图主色
    const el = document.documentElement;
    if (theme === "custom") {
      el.setAttribute("data-custom-shell", lay.shell);
      el.setAttribute("data-custom-sidebar", lay.sbShell);
      el.style.setProperty("--csb-blur", `${customBlur}px`);
      el.style.setProperty("--csb-brightness", String(customBrightness));
      el.style.setProperty("--csb-sat", lay.sbSat);
      el.style.setProperty("--ca-sb", lay.sb); el.style.setProperty("--ca-head", lay.head);
      el.style.setProperty("--ca-card", lay.card); el.style.setProperty("--ca-code", lay.code);
      el.style.setProperty("--ca-input", lay.input); el.style.setProperty("--ca-dialog", lay.dialog);
      if (customArt?.accent) {
        el.style.setProperty("--custom-accent", shellAccent(customArt.accent, lay.shell));
        el.style.setProperty("--custom-glow", glowAccent(customArt.accent, lay.shell)); // 输入框光晕:图主色亮版,浅壳下压暗保证可读
      } else { el.style.removeProperty("--custom-accent"); el.style.removeProperty("--custom-glow"); }
    } else {
      el.removeAttribute("data-custom-shell");
      el.removeAttribute("data-custom-sidebar");
      for (const v of ["--ca-sb", "--ca-head", "--ca-card", "--ca-code", "--ca-input", "--ca-dialog", "--custom-accent", "--custom-glow", "--csb-blur", "--csb-brightness", "--csb-sat"]) el.style.removeProperty(v);
    }
  }, [base, theme, customArt, customBlur, customBrightness]); // eslint-disable-line react-hooks/exhaustive-deps
  // 侧栏宽度可拖,300 = 设计稿默认宽,也是上限
  // 下限 76 = 红绿灯那三颗按钮的宽度(再窄就压到窗口按钮上了);窄到 SB_NARROW 以下切图标模式,
  // 逐级砍掉名字/新建分组/副标题/文字标签(见 styles.css 的 [data-sb-narrow])。
  const [sbw, setSbw] = useState(() => Math.min(300, Math.max(SB_MIN, Number(localStorage.getItem("ChatCode-sbw")) || 300)));
  useEffect(() => { localStorage.setItem("ChatCode-sbw", String(sbw)); }, [sbw]);
  // 侧栏宽上限:除了设计上限 300,还要保证右侧聊天区 ≥ 600px(减去 5px 分隔条)。窗口越窄,侧栏能拉得越窄。
  const maxSidebar = () => Math.min(300, window.innerWidth - 605);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = sbw;
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => setSbw(Math.min(maxSidebar(), Math.max(SB_MIN, startW + ev.clientX - startX)));
    const up = () => {
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  // 拖窗口边框缩放时:若聊天区被挤到 < 600px,自动收窄侧栏补偿(下限仍 200,靠窗口 minWidth 兜底)
  useEffect(() => {
    const onResize = () => setSbw((w) => Math.max(SB_MIN, Math.min(w, maxSidebar())));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 首次打开主动检测版本更新(匿名 GET 一份公开版本号,不带 token、不上传任何本地数据):
  //   强制更新 → 每次开都弹,弹窗关不掉;建议更新 → 每 3 天首次打开弹一次,可关。
  //   不论弹不弹,只要有新版就在侧栏底部留一个"新版本"入口(update 状态一直在)。
  useEffect(() => {
    checkVersion().then((v) => {
      if (!v.hasUpdate && !v.forced) return;
      setUpdate(v);
      if (v.forced || shouldPromptUpdate()) setShowUpdate(true);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setShowSearch(true); }
      if (e.key === "Escape") { setShowSearch(false); setTurnAnchor(null); setShowInfo(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 气泡里的"记忆引用/更新"点条目 → 打开详情面板的"记忆"tab 并高亮定位该条
  useEffect(() => {
    const onOpenMem = (e: Event) => {
      const file = (e as CustomEvent).detail?.file as string | undefined;
      setInfoTab("memory"); setShowInfo(true);
      setMemoryTarget(undefined); // 先清再设,连点同一条也能重新触发高亮
      if (file) requestAnimationFrame(() => setMemoryTarget(file));
    };
    // 划选后点「顺便问问」→ 打开抽屉的 btw tab(选中的文本由 BtwTab 自己取,见 stashBtwDraft)
    const onOpenBtw = () => { setInfoTab("btw"); setShowInfo(true); };
    window.addEventListener("cc-open-memory", onOpenMem);
    window.addEventListener("cc-open-btw", onOpenBtw);
    return () => { window.removeEventListener("cc-open-memory", onOpenMem); window.removeEventListener("cc-open-btw", onOpenBtw); };
  }, []);

  return (
    <div className="app" data-theme={base} data-palette={theme}
      {...(sbw < SB_NARROW ? { "data-sb-narrow": "" } : {})}
      {...(theme === "custom" ? { "data-custom-shell": lay.shell, "data-custom-sidebar": lay.sbShell } : {})}
      style={{ "--sbw": `${sbw}px`,
        ...(theme === "custom" && customBg ? { "--custom-bg": `url("${customBg}")` } : {}) } as React.CSSProperties}>
      <div className="titlebar-drag" data-tauri-drag-region />
      <Sidebar onSearch={() => setShowSearch(true)} onOpenSettings={(tab) => { setSettingsTab(tab); setShowSettings(true); }}
        update={update} onShowUpdate={() => setShowUpdate(true)} />
      <div className="sidebar-resizer" onMouseDown={startResize} />
      <div className="main">
        {active ? (
          <Chat session={active} onToggleInfo={(tab = "branches") => { // 同一个 tab 再点一次 = 关抽屉
            setShowInfo((open) => !(open && tab === infoTab)); setInfoTab(tab);
          }} onShowTurn={setTurnAnchor} onOpenSettings={() => setShowSettings(true)} />
        ) : (
          <div className="empty-wrap">
            <div className="empty">
              <BrandIntro />
              {!state.connected && <p className="warn"><TriangleAlert size={14} /> {t("sidecar 未连接 — 请先 npm run sidecar")}</p>}
            </div>
            <EmptyComposer />
          </div>
        )}
      </div>
      {showInfo && active && <InfoPanel session={active} initialTab={infoTab} memoryTarget={infoTab === "memory" ? memoryTarget : undefined} onClose={() => setShowInfo(false)} />}
      {turnAnchor !== null && active && <TurnDrawer session={active} anchor={turnAnchor} onClose={() => setTurnAnchor(null)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
      {showSettings && <Settings initialTab={settingsTab} theme={theme} onPickTheme={applyTheme}
        customBg={customBg} customBlur={customBlur} customBrightness={customBrightness}
        onSetCustomBg={applyCustomBg} onSetCustomBlur={applyCustomBlur} onSetCustomBrightness={applyCustomBrightness}
        onClose={() => setShowSettings(false)} />}
      {showUpdate && update && <UpdateDialog info={update} onClose={() => { markUpdatePrompted(); setShowUpdate(false); }} />}
      <ToastHost />
    </div>
  );
}
