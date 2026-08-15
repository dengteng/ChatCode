import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { StoreProvider } from "./store";
import { DepGate } from "./components/DepGate";
import { Popout, popoutRoute } from "./popout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@fontsource-variable/inter"; // Inter 可变字体,离线打包(shadcn 默认字体)
import "./i18n"; // 先初始化多语言,再挂 React 组件
import "./tailwind.css"; // Tailwind 层在前,styles.css 在后,手写样式冲突时仍占上风
import "./styles.css";

// 全局中文输入法回车防误发:选候选词 / 上屏用的那个回车绝不能被当成"提交"。
// window capture 阶段先于 React(挂在 #root 上)的事件,拦下后所有输入框统一生效,
// 无需每个输入框各自判断。判定沿用 Composer 的多重保险:composing 标记 + isComposing
// + keyCode 229(WKWebView 组合期恒为 229)+ compositionend 后 120ms 内的落单回车。
let imeComposing = false;
let imeEndAt = -1e9;
window.addEventListener("compositionstart", () => { imeComposing = true; }, true);
window.addEventListener("compositionend", () => { imeComposing = false; imeEndAt = performance.now(); }, true);
window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (imeComposing || e.isComposing || e.keyCode === 229) {
    e.stopPropagation(); // 挡住 app 的提交,放行 IME 把候选词上屏
  } else if (performance.now() - imeEndAt < 120) {
    e.stopPropagation(); e.preventDefault(); // compositionend 抢在 keydown 之前的那个落单回车,直接吞掉
  }
}, true);

// 屏蔽 webview 自带的右键菜单(Reload / Inspect Element)—— 桌面应用不该露出这两项。
// 只在"没有可编辑目标、也没选中文字"时拦:输入框和选中文本仍保留系统的剪切/复制/粘贴菜单。
// 用冒泡阶段 + preventDefault:app 自己的 onContextMenu(侧栏会话菜单等)照常触发。
window.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  const editable = !!el?.closest?.("input, textarea, [contenteditable='true']");
  const selected = !!window.getSelection()?.toString();
  if (!editable && !selected) e.preventDefault();
});

// 弹出的独立窗口(看大图 / 编辑文件)复用同一个 index.html,靠 hash 分流:
// 它们只显示自己那一件事,不连 agent 服务、不建 store。
const pop = popoutRoute();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {pop ? <Popout kind={pop.kind} params={pop.params} /> : (
        <DepGate>
          <StoreProvider>
            <App />
          </StoreProvider>
        </DepGate>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
