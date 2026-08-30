import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
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
import { Eye, EyeOff } from "lucide-react";

// app 内可编辑的文本类型;md 额外支持实时渲染预览。CodeMirror 6 对无对应语言包的类型也能纯文本编辑,
// 所以这里放开到常见代码/文本文件,统一走同一套编辑体验。
const EDITABLE = new Set(["html", "css", "py", "json", "md", "js", "jsx", "ts", "tsx", "txt", "yml", "yaml", "toml", "sh"]);

// html 预览:同目录的样式表 / 脚本 / 图片全部读盘内联(见下面 htmlDoc 处的原因)。
// 三条正则各管一类;script 连闭合标签一起吃掉,否则替换完会剩个孤零零的 </script>。
const LINK_RE = /<link\b[^>]*>/gi;
const SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi;
const IMG_RE = /<img\b[^>]*>/gi;
// 标签里取本地路径。远程 / data: / 锚点返回 null —— 那些 iframe 自己能取,不碰。
// 顺手去掉 ?v=1 这类 query:磁盘上没有那个文件名。
// "/assets/x.js" 这种根绝对路径也要读盘:srcDoc + sandbox(无 allow-same-origin)的 iframe
// 处于不透明源,"/" 无处可指,交给它取等于取不到 —— Vite 打出来的站正文全靠那支 JS,
// 拿不到就只剩一片白。这里按「html 自己所在目录 = 站点根」解析。
// ponytail: 没做真站点根探测(往上找 index.html 之类)。猜错了读盘失败,预览退化成没样式,和修之前一样,不会更糟。
const localPath = (u: string | null | undefined): string | null => {
  if (!u || /^(https?:|\/\/|data:|asset:|#)/i.test(u)) return null;
  return u.split(/[?#]/)[0].replace(/^\/+/, "");
};
const localRef = (tag: string, attr: "href" | "src"): string | null =>
  localPath(tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]);
const isImg = (u: string) => /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i.test(u);
const MIME: Record<string, string> = { svg: "image/svg+xml", jpg: "image/jpeg", ico: "image/x-icon" };
const dataUrl = (ref: string, b64: string) => `data:${MIME[ext(ref)] || `image/${ext(ref)}`};base64,${b64}`;
// md 里的图片两种写法都要收:markdown 的 ![](x.png) 和直接写的 <img src="x.png">
// (README 开头那种 <div align="center"><img …> 居中排版全是后者)。
const MD_IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
export const ext = (name: string) => name.split(".").pop()?.toLowerCase() || "";
export const isEditable = (name: string) => EDITABLE.has(ext(name));

// ---------- 点击源码 → 预览定位 ----------
// 思路两边一致:渲染时把「这块内容来自源码第几行」写成属性,点击时取光标行号,
// 找最后一个行号 ≤ 光标的元素(嵌套时天然落到最深那层)滚过去并闪一下。

/** 给 html 每个开标签写上源码行号。script/style 的**内容**跳过 —— 里面的 `<div>` 是字符串,不是标签。 */
function tagLines(src: string): string {
  const starts: number[] = [];   // 每行起点偏移,二分反查行号(逐次 slice+split 是 O(n²),大文件会卡)
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  const lineAt = (off: number) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= off) lo = m + 1; else hi = m; }
    return lo + 1;
  };
  const skip: [number, number][] = [];
  for (const m of src.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    skip.push([m.index! + m[0].indexOf(">") + 1, m.index! + m[0].length]);   // 只跳内容,开标签本身还要打行号
  }
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) skip.push([m.index!, m.index! + m[0].length]);
  // 属性值里可能有 `>`,所以属性段要按「引号成对」吃,不能简单 [^>]*
  return src.replace(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (tag, name: string, attrs: string, off: number) => {
    if (skip.some(([s, e]) => off >= s && off < e)) return tag;
    if (/^(br|meta|base|title|html|head)$/i.test(name)) return tag;   // 不可见 / 滚不过去的,不占位
    const self = attrs.endsWith("/");   // <img … /> 的斜杠必须留在最后,不然属性名会粘上它
    return `<${name}${self ? attrs.slice(0, -1).trimEnd() : attrs} data-cc-line="${lineAt(off)}"${self ? " /" : ""}>`;
  });
}

/** 注进 iframe 的定位脚本。父页面 postMessage 行号过来 —— sandbox 无 allow-same-origin,
 *  iframe 处于不透明源,父页面碰不到它的 DOM,只能靠 postMessage 让它自己滚。 */
const SCROLL_RUNTIME = `<script>
addEventListener("message", function (e) {
  var line = e.data && e.data.ccLine; if (!line) return;
  var hit = null;
  document.querySelectorAll("[data-cc-line]").forEach(function (el) {
    if (+el.getAttribute("data-cc-line") <= line) hit = el;
  });
  if (!hit) return;
  hit.scrollIntoView({ block: "center", behavior: "smooth" });
  var old = hit.style.outline, off = hit.style.outlineOffset;
  hit.style.outline = "2px solid #4a9eff"; hit.style.outlineOffset = "2px";
  setTimeout(function () { hit.style.outline = old; hit.style.outlineOffset = off; }, 900);
});
</script>`;

/** md:把 remark 的行号透到 DOM 上。react-markdown 原样透传 data-*,不用逐个组件包一层。 */
const rehypeLine = () => (tree: any) => {
  const walk = (n: any) => {
    if (n.type === "element" && n.position) (n.properties ||= {})["data-cc-line"] = n.position.start.line;
    n.children?.forEach(walk);
  };
  walk(tree);
};

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
// 会误判成浅色 —— 所以最后兜底到两个窗口共享的主题键(ChatCode-theme,默认深色)。
const detectDark = () => {
  const attr = document.querySelector(".app")?.getAttribute("data-theme")
    ?? document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return localStorage.getItem("ChatCode-theme") !== "light";
};

/** 分栏比例夹到合法区间。size = 分栏轴上的可用像素(横向取宽、纵向取高)。
 *  两条约束同时管两边:谁也不能窄于 SPLIT_MIN_PX,谁也不能吃掉 90% 以上 ——
 *  面板窄于 500px 时 50px 比 10% 还大,那就是 50px 说了算。
 *  面板窄到 100px 以下两条约束会打架(下限反超上限),这种时候退回五五开,别乱夹。 */
const SPLIT_MIN_PX = 50;
export const clampFrac = (f: number, size: number) => {
  const lo = Math.max(0.1, SPLIT_MIN_PX / size), hi = Math.min(0.9, 1 - SPLIT_MIN_PX / size);
  return lo > hi ? 0.5 : Math.min(hi, Math.max(lo, f));
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
  const canPreview = isMd || isHtml;   // 这类文件有没有预览可看:md 渲染 / html iframe 实时预览
  // 用户手动开关。记进 localStorage:关掉的人多半是想专心写源码,每开一个文件再关一次很烦(同 vert)。
  // 默认开 —— 只有显式存过 "0" 才算关。
  const [previewOn, setPreviewOn] = useState(() => localStorage.getItem("ChatCode-feditor-preview") !== "0");
  const togglePreview = () => setPreviewOn((v) => {
    localStorage.setItem("ChatCode-feditor-preview", v ? "0" : "1");
    return !v;
  });
  const preview = canPreview && previewOn;   // 真的要分栏吗(下游的分栏/拖动条/同步滚动全看它)
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

  // html 预览:iframe srcDoc 直接渲染当前缓冲区(实时,不必先保存)。
  // 同目录的样式表 / 脚本 / 图片全部读盘,内联进文档。原先是注入 <base href=convertFileSrc(目录)>
  // 让 iframe 自己去取,那条路是死的,两处都不通:① tauri.conf.json 的 security 里没开 assetProtocol,
  // asset:// 根本不响应;② convertFileSrc 把整个绝对路径百分号编码成**单个** path segment,相对路径
  // 按 <base> 解析出来是 asset://localhost/style.css,目录整段被当最后一段替换掉了。
  // 脚本也必须内联,不只是为了交互:现在的站点常在 <head> 里给 <html> 打个 js-anim 之类的标记,
  // 让入场元素先 opacity:0,再由外部脚本滚动时点亮 —— 脚本取不到,正文就永远停在透明,
  // 表现是"预览只剩背景"。sandbox 仅 allow-scripts:脚本能跑,但处于独立源,碰不到宿主。
  const dir = useMemo(() => path.replace(/[^/\\]*$/, ""), [path]);
  // 预览用 deferred 值:图片是 base64 内联的,一份文档可能上兆,每敲一个键重建 + iframe 整页重载会卡。
  // useDeferredValue 让打字优先,空下来再刷预览。
  const previewText = useDeferredValue(text);
  const refs = useMemo(() => {
    // 关了预览就别扫了:下面那个 effect 会照着 refs 挨个读盘,内联上兆 base64 全是白干
    if (!preview || !previewText) return [] as string[];
    // md 只要图片:相对路径在 webview 里解析到 app 自己的 base,不内联就是一排破图。
    if (isMd) return [...new Set([
      ...[...previewText.matchAll(MD_IMG_RE)].map((m) => localPath(m[1])),
      ...(previewText.match(IMG_RE) || []).map((t) => localRef(t, "src")),
      // 只留认得出的图片扩展名:下面读盘那步按 isImg 分流 base64/文本,漏进来个没扩展名的
      // 会被当文本读回来,再拼成 data:image 就是一张永远加载不出的图。
    ].filter((r): r is string => !!r && isImg(r)))];
    if (!isHtml) return [] as string[];
    const out = [
      ...(previewText.match(LINK_RE) || []).filter((t) => /rel\s*=\s*["']?stylesheet/i.test(t)).map((t) => localRef(t, "href")),
      ...(previewText.match(SCRIPT_RE) || []).map((t) => localRef(t, "src")),
      ...(previewText.match(IMG_RE) || []).map((t) => localRef(t, "src")),
    ];
    return [...new Set(out.filter(Boolean) as string[])];
  }, [preview, isHtml, isMd, previewText]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  // 依赖用 join 出来的字符串而不是 refs 本身:数组每次正文变化都是新引用,直接当依赖会变成每敲一键读一次盘。
  const refKey = refs.join("|");
  useEffect(() => {
    let alive = true;
    for (const r of refs) {
      invoke<string>(isImg(r) ? "read_file_b64" : "read_file", { path: dir + r })
        .then((c) => alive && setAssets((a) => (a[r] === c ? a : { ...a, [r]: c })))
        .catch(() => {}); // 资源缺失不算错:预览退化成没样式/没图,别弹错误条挡住编辑
    }
    return () => { alive = false; };
  }, [refKey, dir]);

  const htmlDoc = useMemo(() => {
    if (!preview || !isHtml || previewText === null) return "";
    const got = (tag: string, attr: "href" | "src") => {
      const r = localRef(tag, attr);
      return r && assets[r] !== undefined ? { r, data: assets[r] } : null;
    };
    // 行号必须先注入:后面几步会把外链换成内联内容,文本长度一变,偏移就对不上源码了
    return tagLines(previewText)
      .replace(LINK_RE, (tag) => {
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
        const hit = got(tag, "href");
        return hit ? `<style>\n${hit.data}\n</style>` : tag;
      })
      // 内联脚本里出现字符串 "</script>" 会提前闭合整个标签,转义掉
      .replace(SCRIPT_RE, (tag) => {
        const hit = got(tag, "src");
        if (!hit) return tag;
        // 原属性留着,尤其 type="module" —— module 天生 defer,丢掉它内联成经典脚本,
        // <head> 里的入口就会在 <body> 之前跑,React 拿不到 #root,预览照样一片白。
        // src / crossorigin 是取远端才用的,内联后必须摘掉。
        const open = tag.match(/<script\b[^>]*>/i)![0]
          .replace(/\s+\bsrc\s*=\s*["'][^"']*["']/i, "")
          .replace(/\s+\bcrossorigin(\s*=\s*["'][^"']*["'])?/i, "");
        return `${open}\n${hit.data.replace(/<\/script/gi, "<\\/script")}\n</script>`;
      })
      .replace(IMG_RE, (tag) => {
        const hit = got(tag, "src");
        if (!hit) return tag;
        return tag.replace(/(\bsrc\s*=\s*["'])[^"']*(["'])/i, `$1${dataUrl(hit.r, hit.data)}$2`);
      }) + SCROLL_RUNTIME;
  }, [preview, isHtml, previewText, assets]);

  // md 预览里的图片:相对路径换成读回来的 base64。html 那边是改字符串(见 htmlDoc),md 走的是
  // 组件树,只能在这儿换。读盘还没回来时保持原 src(显示成破图),读回来 assets 一变就重渲染。
  const mdComponents = useMemo(() => ({
    img: ({ node: _node, ...p }: any) => {
      const r = localPath(p.src);
      return <img {...p} src={r && assets[r] !== undefined ? dataUrl(r, assets[r]) : p.src} />;
    },
  }), [assets]);

  // 预览分栏方向。窄窗口写代码时左右挤,宽屏读长文时上下挤 —— 交给用户自己按内容切。
  // 记进 localStorage:同一个人的习惯基本不变,每开一个文件都要重切一次很烦。
  const [vert, setVert] = useState(() => localStorage.getItem("ChatCode-feditor-vert") === "1");
  const toggleLayout = () => setVert((v) => {
    localStorage.setItem("ChatCode-feditor-vert", v ? "0" : "1");
    return !v;
  });

  // 分栏比例(源码区占的份额)。和 vert 一样记进 localStorage —— 每开一个文件都要重拖一次太烦。
  const [split, setSplit] = useState(() => clampFrac(Number(localStorage.getItem("ChatCode-feditor-split")) || 0.5, Infinity));
  useEffect(() => { localStorage.setItem("ChatCode-feditor-split", String(split)); }, [split]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = bodyRef.current;
    if (!el) return;
    document.body.style.cursor = vert ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    // html 预览是 iframe:鼠标划过去时 mousemove 归它自己的文档,外面收不到,拖动断在半路。
    // 拖的这一小会儿让它不收指针事件就行。
    document.body.classList.add("feditor-dragging");
    const move = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const size = vert ? r.height : r.width;
      setSplit(clampFrac((vert ? ev.clientY - r.top : ev.clientX - r.left) / size, size));
    };
    const up = () => {
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      document.body.classList.remove("feditor-dragging");
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  // 浮窗拖角缩放会改可用宽高,存着的比例可能把某一边压到 50px 以下 —— 跟着回夹一次
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !preview) return;
    const ro = new ResizeObserver(() => setSplit((f) => clampFrac(f, vert ? el.clientHeight : el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [preview, vert]);

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
  // 点击源码某行 → 预览滚到那块内容。html 隔着不透明源,只能 postMessage 让 iframe 自己滚;
  // md 就在本文档里,直接算容器内偏移(不用 scrollIntoView —— 它会连带把外面的浮窗一起滚跑)。
  const frameRef = useRef<HTMLIFrameElement>(null);
  const jumpTo = (line: number) => {
    if (isHtml) { frameRef.current?.contentWindow?.postMessage({ ccLine: line }, "*"); return; }
    const root = prevRef.current;
    if (!isMd || !root) return;
    let hit: HTMLElement | null = null;
    root.querySelectorAll<HTMLElement>("[data-cc-line]").forEach((el) => {
      if (+el.getAttribute("data-cc-line")! <= line) hit = el;   // 文档序递增,最后一个命中的就是最深那层
    });
    if (!hit) return;
    const el = hit as HTMLElement;
    root.scrollTo({
      top: root.scrollTop + el.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 3,
      behavior: "smooth",
    });
    el.style.outline = "2px solid var(--accent)"; el.style.outlineOffset = "2px";
    window.setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 900);
  };
  // onCreate 只在挂载时跑一次,里面的闭包会锁住首帧的 jumpTo —— 用 ref 转发最新那个(和 saveRef 同一套)
  const jumpRef = useRef(jumpTo);
  jumpRef.current = jumpTo;

  const onCreate = (view: EV) => {
    cmScrollerRef.current = view.scrollDOM;
    view.scrollDOM.addEventListener("scroll", () => align("src"));
    view.scrollDOM.addEventListener("mouseenter", () => (driver.current = "src"));
    // 打字把光标顶出可视区时浏览器会自己滚,那时鼠标可能正停在右栏 —— 键入也算"在滚左栏"
    view.dom.addEventListener("keydown", () => (driver.current = "src"), true);
    // 行号按鼠标坐标现算,不读 view.state.selection —— 简单点击时 CodeMirror 让浏览器原生落光标,
    // 再靠 selectionchange 异步读回,而那个事件排在 mouseup 之后:读 selection 会拿到上一次的位置,
    // 表现成"预览慢一拍,要再点一下才跟上"。precise=false 让行尾空白/边距也夹到最近位置,不会是 null。
    // 派 driver=src 是必须的:定位引起的预览滚动会触发对面的 align,不占住方向就会被它反推回来。
    view.dom.addEventListener("mouseup", (e) => {
      driver.current = "src";
      jumpRef.current(view.state.doc.lineAt(view.posAtCoords({ x: e.clientX, y: e.clientY }, false)).number);
    });
  };

  const panel = (
      <div className={`feditor ${windowed ? "windowed" : ""}`} style={windowed ? undefined : { left: pos.x, top: pos.y }} onKeyDown={onKey}>
        <div className="feditor-head" onMouseDown={windowed ? undefined : onDragHead}>
          <span className="feditor-name">{name}{dirty ? " ●" : ""}</span>
          <span className="feditor-path" title={path}>{path}</span>
          <div className="feditor-actions">
            {status && <span className="muted">{status}</span>}
            {/* 预览开关。只在有预览可看的类型上出现(md/html);关掉后整个右栏连同拖动条一起消失,
                源码栏铺满。这个状态是记住的 —— 图标画当前状态(眼睛开/闭),和下面那个方向按钮不同,
                因为"预览现在是开是关"一眼要能看出来。 */}
            {canPreview && (
              <button className="ghost feditor-layout" title={previewOn ? t("关闭预览") : t("开启预览")}
                onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); togglePreview(); }}>
                {previewOn ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            )}
            {/* 分栏方向切换。图标画的是切过去之后的样子(两块并排 / 两块上下),不是当前状态 ——
                按钮上画"你会得到什么"比画"你现在是什么"少一层脑内转换。 */}
            {preview && (
              <button className="ghost feditor-layout" title={vert ? t("切换为左右并列") : t("切换为上下并列")}
                onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); toggleLayout(); }}>
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                  {vert
                    ? <><rect x="1" y="1" width="5" height="12" rx="1" /><rect x="8" y="1" width="5" height="12" rx="1" /></>
                    : <><rect x="1" y="1" width="12" height="5" rx="1" /><rect x="1" y="8" width="12" height="5" rx="1" /></>}
                </svg>
              </button>
            )}
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
          <div ref={bodyRef} className={`feditor-body ${preview ? "split" : ""} ${preview && vert ? "vert" : ""}`}>
            <div className="feditor-input-wrap" style={preview ? { flex: `0 0 ${split * 100}%` } : undefined}>
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
            {preview && <div className="feditor-split-bar" onMouseDown={startSplit} title={t("拖动调节两栏比例")} />}
            {preview && isMd && (
              <div className="feditor-preview md" ref={prevRef}
                onMouseEnter={() => (driver.current = "prev")} onScroll={() => align("prev")}>
                {/* rehypeRaw 让写在 md 里的 HTML 真的渲染出来(react-markdown 默认把它当纯文本贴出来,
                    README 开头那种 <div align="center"> 排版就会以标签原文的样子糊在预览顶上)。
                    rehypeSanitize 紧跟着收口:md 可能来自克隆下来的任意仓库,不过滤就是把 <script> / onerror
                    直接放进宿主 webview 跑 —— 这里能碰到 Tauri 的 invoke。用默认的 GitHub 白名单,
                    align/width 这些排版属性本来就在里面。
                    rehypeLine 必须排在 sanitize **之后**:白名单不认 data-*,放前面会被当场剥掉,点源码跳转就没了。 */}
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeLine]}
                  components={mdComponents}>{text}</Markdown>
              </div>
            )}
            {preview && isHtml && <iframe ref={frameRef} className="feditor-preview-frame" title={t("HTML 预览")} sandbox="allow-scripts allow-forms allow-popups" srcDoc={htmlDoc} />}
          </div>
        )}
      </div>
  );
  return windowed ? panel : createPortal(<div className="feditor-overlay">{panel}</div>, document.body);
}
