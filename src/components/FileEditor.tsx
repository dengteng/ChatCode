import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import type { EditorView as EV } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { css as cssLang } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { useTranslation } from "react-i18next";

// app 内可编辑的文本类型;md 额外支持实时渲染预览。CodeMirror 6 对无对应语言包的类型也能纯文本编辑,
// 所以这里放开到常见代码/文本文件,统一走同一套编辑体验。
const EDITABLE = new Set(["html", "css", "py", "json", "md", "js", "jsx", "ts", "tsx", "txt", "yml", "yaml", "toml", "sh"]);
export const ext = (name: string) => name.split(".").pop()?.toLowerCase() || "";
export const isEditable = (name: string) => EDITABLE.has(ext(name));

// 文件扩展名 → CodeMirror 语言扩展(语法高亮、括号匹配、缩进感知)。查不到的类型走纯文本。
function langOf(name: string) {
  switch (ext(name)) {
    case "html": return html();
    case "css": return cssLang();
    case "py": return python();
    case "json": return json();
    case "md": return markdown();
    case "js": case "jsx": return javascript({ jsx: true });
    case "ts": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    default: return null;
  }
}

// 当前主题(浅/深)。独立弹出窗口里 data-theme 挂在 .app 上,主窗口挂在 <html> 上;
// 但弹窗首帧渲染时 .app 还没进 DOM(querySelector 拿不到)、其 <html> 又不带 data-theme,
// 会误判成浅色 —— 所以最后兜底到两个窗口共享的主题键(chat-code-theme,默认深色)。
const detectDark = () => {
  const attr = document.querySelector(".app")?.getAttribute("data-theme")
    ?? document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return localStorage.getItem("chat-code-theme") !== "light";
};

// 文件编辑器:左编辑(CodeMirror 6 语法高亮 + 行号)右预览(md)/纯编辑(其他)。⌘S 保存,点"关闭"按钮退出。
// windowed = 它自己就是一个独立的原生窗口(见 popout.tsx):铺满窗口、不要遮罩、不用自己实现拖动(交给系统标题栏)。
export function FileEditor({ path, name, onClose, windowed }: { path: string; name: string; onClose: () => void; windowed?: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");   // 上次保存内容,判断 dirty
  const [err, setErr] = useState("");
  const [status, setStatus] = useState(""); // "已保存"/"保存中…"
  const isMd = ext(name) === "md";
  const isHtml = ext(name) === "html" || ext(name) === "htm";
  const preview = isMd || isHtml;   // 右栏预览:md 渲染 / html iframe 实时预览
  const [dark, setDark] = useState(detectDark);
  // 主题实时切换时跟着换 CodeMirror 配色(data-theme 变化用 MutationObserver 监听)
  useEffect(() => {
    setDark(detectDark()); // 挂载后 .app 已进 DOM,纠正首帧可能的误判
    const targets = [document.documentElement, document.querySelector(".app")].filter(Boolean) as Element[];
    const ob = new MutationObserver(() => setDark(detectDark()));
    targets.forEach((t) => ob.observe(t, { attributes: true, attributeFilter: ["data-theme"] }));
    return () => ob.disconnect();
  }, []);

  const lang = useMemo(() => langOf(name), [name]);
  // lineWrapping:软换行,和右侧预览的百分比同步滚动配合(源码不横向溢出,scrollTop 才有可比性)
  const extensions = useMemo(() => [EditorView.lineWrapping, ...(lang ? [lang] : [])], [lang]);

  // html 预览:iframe srcDoc 直接渲染当前缓冲区(实时,不必先保存)。注入 <base> 指向文件所在目录,
  // 让相对路径的 css/img/js 从磁盘加载得到。sandbox 仅 allow-scripts:脚本能跑,但处于独立源,碰不到宿主。
  const htmlDoc = useMemo(() => {
    if (!isHtml || text === null) return "";
    const base = `<base href="${convertFileSrc(path.replace(/[^/\\]*$/, ""))}">`;
    return /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (m) => m + base) : base + text;
  }, [isHtml, text, path]);

  // 浮窗位置(初始居中);宽高交给 CSS resize 拖角缩放,不受控免打架
  const [pos, setPos] = useState(() => ({ x: Math.max(20, (window.innerWidth - 1100) / 2), y: Math.max(20, (window.innerHeight - 760) / 2) }));
  const onDragHead = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // 点按钮不拖
    const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
    const move = (ev: MouseEvent) => setPos({ x: Math.max(0, ox + ev.clientX - sx), y: Math.max(0, oy + ev.clientY - sy) });
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    let alive = true;
    invoke<string>("read_file", { path })
      .then((c) => { if (alive) { setText(c); setSaved(c); } })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [path]);

  const dirty = text !== null && text !== saved;
  // save 要读到最新的 text/dirty,但 CodeMirror 的 ⌘S 快捷键扩展只在挂载时绑定一次 —— 用 ref 转发最新闭包
  const saveRef = useRef<() => void>(() => {});
  const save = async () => {
    if (text === null || !dirty) return;
    setStatus(t("保存中…"));
    try {
      await invoke("write_file", { path, content: text });
      setSaved(text); setStatus(t("已保存")); setErr("");
      window.setTimeout(() => setStatus(""), 1600);
    } catch (e) { setErr(String(e)); setStatus(""); }
  };
  saveRef.current = save;

  const onKey = (e: React.KeyboardEvent) => {
    // 只保留 ⌘S 保存。不再用 Esc 关闭:编辑代码时很容易误点 Esc 把整个弹窗关掉、丢失现场。
    // 关闭统一走右上角"关闭"按钮。
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current(); }
  };

  // 左右同步滚动(仅 md 双栏):按滚动进度百分比对齐。
  // 为什么不做"源码行号 → 预览元素"的精确映射:编辑区是软换行的(一行长文本占好几行显示),
  // scrollTop 反推不出源码行号,要精确映射得先给每行做布局测量,代价远大于收益。
  // 百分比对齐的代价是:遇到长代码块/图片这类"源码短、渲染高"的内容,两边会有偏移。够用。
  const cmScrollerRef = useRef<HTMLElement | null>(null); // CodeMirror 的滚动容器(.cm-scroller),onCreateEditor 里拿到
  const prevRef = useRef<HTMLDivElement>(null);
  // 谁在被滚:同步会给对面派发 scroll 事件,对面若也去同步回来,两边就会互相推着抖。
  // 以鼠标所在的那一栏为准 —— 滚轮事件本来就只发给指针底下的元素。
  const driver = useRef<"src" | "prev" | null>(null);
  const align = (side: "src" | "prev") => {
    if (!isMd || driver.current !== side) return;
    const from = side === "src" ? cmScrollerRef.current : prevRef.current;
    const to = side === "src" ? prevRef.current : cmScrollerRef.current;
    if (!from || !to) return;
    const fMax = from.scrollHeight - from.clientHeight;
    const tMax = to.scrollHeight - to.clientHeight;
    if (fMax <= 0 || tMax <= 0) return; // 有一边没得滚,别把它顶到 0
    to.scrollTop = (from.scrollTop / fMax) * tMax;
  };
  // CodeMirror 的滚动发生在内部 .cm-scroller 上(scroll 事件不冒泡),React 的 onScroll 挂外层拿不到,
  // 所以挂载时直接给 scrollDOM 绑原生监听。
  const onCreate = (view: EV) => {
    cmScrollerRef.current = view.scrollDOM;
    view.scrollDOM.addEventListener("scroll", () => align("src"));
    view.scrollDOM.addEventListener("mouseenter", () => (driver.current = "src"));
    // 打字把光标顶出可视区时浏览器会自己滚,那时鼠标可能正停在右栏 —— 键入也算"在滚左栏"
    view.dom.addEventListener("keydown", () => (driver.current = "src"), true);
  };

  const panel = (
      <div className={`feditor ${windowed ? "windowed" : ""}`} style={windowed ? undefined : { left: pos.x, top: pos.y }} onKeyDown={onKey}>
        <div className="feditor-head" onMouseDown={windowed ? undefined : onDragHead}>
          <span className="feditor-name">{name}{dirty ? " ●" : ""}</span>
          <span className="feditor-path" title={path}>{path}</span>
          <div className="feditor-actions">
            {status && <span className="muted">{status}</span>}
            {/* onMouseDown 而非 onClick:按下先让 CodeMirror blur,状态行("已保存")随之增删把按钮挤走,
                click(mouseup)落在移位后的位置就丢了 → 要点两次。stopPropagation 是别把按下当成拖窗。 */}
            <button className="hi" disabled={!dirty} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); save(); }}>{t("保存")}</button>
            <button className="ghost" onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); onClose(); }}>{t("关闭")}</button>
          </div>
        </div>
        {err && <div className="feditor-err">{err}</div>}
        {text === null && !err ? (
          <div className="feditor-body"><div className="muted" style={{ padding: 16 }}>{t("加载中…")}</div></div>
        ) : text !== null && (
          <div className={`feditor-body ${preview ? "split" : ""}`}>
            <div className="feditor-input-wrap">
              <CodeMirror
                value={text}
                onChange={setText}
                onCreateEditor={onCreate}
                extensions={extensions}
                theme={dark ? oneDark : "light"}
                height="100%"
                autoFocus
                basicSetup={{ highlightActiveLine: true, foldGutter: true }}
                className="feditor-cm"
              />
            </div>
            {isMd && (
              <div className="feditor-preview md" ref={prevRef}
                onMouseEnter={() => (driver.current = "prev")} onScroll={() => align("prev")}>
                <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
              </div>
            )}
            {isHtml && <iframe className="feditor-preview-frame" title={t("HTML 预览")} sandbox="allow-scripts allow-forms allow-popups" srcDoc={htmlDoc} />}
          </div>
        )}
      </div>
  );
  return windowed ? panel : createPortal(<div className="feditor-overlay">{panel}</div>, document.body);
}
