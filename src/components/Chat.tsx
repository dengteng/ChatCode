import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, isValidElement, type ReactNode } from "react";
import { GitFork, GitBranch, ChevronRight, ChevronDown, Folder, Server, Puzzle, Plug, ArrowDown, Wrench, Check, Copy, X, CircleHelp, Lock, Image as ImageIcon, MessageSquare, Ban, Pin, Pencil, TriangleAlert, Loader2, Brain, RotateCcw, CornerDownRight, Paperclip } from "lucide-react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealPath } from "../native";
import type { PermissionSuggestion, ResumeChoice, ResumePrompt, Session, TimelineItem } from "../types";
import { modelDisplayName } from "../types";
import { useStore, fetchBlob, type RememberChoice } from "../store";
import { applyEdgeGlow } from "../lib/edgeGlow";
import { pushCmd } from "../lib/gitcmd";
import { cleanMemory, stripLineNums } from "../lib/memtext";
import { btnPress } from "../lib/utils";
import { defaultRuleContent, destinationLabel, suggestionLabel } from "../permissions";
import { Composer } from "./Composer";
import { CommitDialog } from "./CommitDialog";
import { GitMapDialog } from "./GitMapDialog";
import { openImageWindow, openEditorWindow } from "../popout";
import { isEditable } from "./FileEditor";
import { homeDir } from "@tauri-apps/api/path";
import { UserAvatar, ModelAvatar, ComputerAvatar, brandName, getUserName } from "./Avatar";
import { toast, dismissToast } from "./Toast";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";

type OnPermission = (rid: string, b: "allow" | "deny", msg?: string, remember?: RememberChoice) => void;

// 中文与全角标点:URL 里合法的中文一定是百分号编码过的,所以裸出现在 URL 令牌里的中文
// 只可能是正文被顺手粘进来的(中英文之间往往不打空格)—— 见下面 autoHref 的注释
const CJK = /[⺀-鿿　-〿＀-￯]/;
// 文本里识别 URL 与文件路径:group1=URL,group2=路径(绝对 / ~ 开头 / 含斜杠的相对路径 / 带扩展名的文件名)
// URL 那段显式排除中文/全角标点,否则 "打开 http://localhost:5174,输入公司名" 会整句被当成 URL
const LINK_RE = /(https?:\/\/[^\s<>)"'`⺀-鿿　-〿＀-￯]+)|((?:~|\.{1,2})?\/[^\s:<>"'`()]+|[\w.\-@]+(?:\/[\w.\-@]+)+|[\w.\-@]+\.[A-Za-z][\w]{1,7})(?=$|[\s:,)"'`])/g;

// 自动链接(链接文字 = URL 本身)里,remark 会把紧跟 URL 的中文一并编码进 href:
//   "浏览器打开 http://localhost:5174,输入一个公司名" → href=http://localhost:5174%EF%BC%8C%E8%BE%93...
// 端口号后面直接跟了个编码的中文逗号 —— 这连合法 URL 都不是,macOS `open` 会报
// "Unable to interpret ... as a path or URL" 然后什么都不做,表现就是"点了没反应"。
// 所以自动链接改用"链接文字"来取 URL,切到第一个中文为止(文字里的中文必是正文,URL 里的中文一定被编码过);
// 切下来的那截中文当普通文字吐回正文,不能连正文一起吞掉。
// 手写的 [标签](url) 不动 —— 那种 href 里的 %E4%B8%AD 是人家路径的一部分,不能乱切。
function splitAutoLink(href: string, children: ReactNode): { url: string; rest: string } {
  const text = Array.isArray(children) ? children.find((c) => typeof c === "string") ?? "" : typeof children === "string" ? children : "";
  if (!/^https?:\/\//.test(text)) return { url: href, rest: "" }; // 不是自动链接
  const cut = text.search(CJK);
  let url = cut < 0 ? text : text.slice(0, cut);
  let rest = cut < 0 ? "" : text.slice(cut);
  // markdown 加粗/强调没解析成功时(常见于 URL 紧贴中文标点:`运行中：**http://…**（…` —— CJK 标点让 **
  // 不构成合法强调),autolink 会把尾部的 ** _ ~ 一起吞进 href。这就不是合法 URL 了,macOS `open` 报错、
  // 点"打开"没反应。把尾部这些残留符号剥回正文,URL 才干净可点。
  const tail = url.match(/[*_~]+$/);
  if (tail) { rest = url.slice(url.length - tail[0].length) + rest; url = url.slice(0, url.length - tail[0].length); }
  return { url, rest };
}

// 网络 TLD:裸域名(无 scheme)据此判定为在线链接,而非本地文件(README.md 的 md 不在此列)。
const WEB_TLD = /\.(com|net|org|io|ai|dev|co|app|xyz|info|me|cn|gov|edu|us|uk|de|jp|fr|tv|cc|site|online|tech|blog|shop|store|cloud|link)$/i;
// 判定令牌是否在线链接,并给出可直接 open 的 URL(裸域名补 https://)。
function webHref(raw: string, hasScheme: boolean): string | null {
  if (hasScheme) return raw;
  // 首段是域名(cuobiezi.net、github.com/owner/repo/pull/3)就补 https 当在线链接;
  // 带路径的裸域名以前落进"本地文件"分支,open_path 找不到文件 → 点了没反应。
  if (WEB_TLD.test(raw.split("/")[0])) return `https://${raw}`;
  return null;
}

// 常见文件扩展名:裸文件名(无斜杠)只有扩展名在这个集合或 WEB_TLD 里,才当路径 ——
// 否则 user.name / a.b 这种"词.词"会被误判成文件,hover 弹出"打开/打开目录"。
const FILE_EXT = new Set("ts tsx js jsx mjs cjs json json5 md mdx markdown txt text log py pyi rs go rb php java kt kts swift c h cc cpp hpp cxx cs css scss sass less styl html htm xml svg yaml yml toml ini cfg conf env sh bash zsh fish ps1 sql lock csv tsv vue svelte astro lua dart scala ex exs erl clj proto graphql gql prisma tf gradle png jpg jpeg gif webp ico bmp pdf zip tar gz tgz bz2 xz mp3 mp4 mov wav ttf otf woff woff2".split(" "));
// macOS/unix 文件系统根:裸绝对路径(/开头)首段命中才可能是真实路径。
// 否则 /api/v1/events、/v1/users 这类服务器 API 路由会被误判成本地目录,弹出"打开/打开目录"。
const FS_ROOTS = new Set("Users Applications Library System Volumes tmp var etc opt usr private bin sbin dev home root mnt srv proc cores net".split(" "));
function shouldLink(raw: string, isUrl: boolean): boolean {
  if (isUrl) return true;
  if (raw.startsWith("/")) { // 裸绝对路径:可能是真文件,也可能是 API 路由 —— 首段是文件系统根、或末段带已知扩展名才算
    const first = raw.slice(1).split("/")[0];
    const ext = raw.split(".").pop()?.toLowerCase() || "";
    return FS_ROOTS.has(first) || FILE_EXT.has(ext);
  }
  if (raw.includes("/")) return true; // 相对路径 / ~/ / ./  照旧
  const ext = raw.split(".").pop()?.toLowerCase() || "";
  return FILE_EXT.has(ext) || WEB_TLD.test("." + ext); // 裸名:扩展名须是已知文件类型或域名后缀
}

// 把对话里出现的路径解析成绝对路径,喂给内置编辑器(read_file/write_file 只认绝对路径,不展开 ~/不拼 cwd)。
// 绝对路径原样;~ / ~/x 展开 HOME;其余相对路径拼到会话 cwd 上。
// 交给原生侧解析(resolve_path):~ 展开 + 相对 cwd 拼接,拼不到还会往上找几级兄弟仓。
// 别在这儿再实现一遍 —— 两套规则一旦不一致,"打开"和"打开目录"就会指向不同文件。
async function absPath(raw: string, cwd: string): Promise<string> {
  if (raw.startsWith("/")) return raw;
  return invoke<string>("resolve_path_cmd", { path: raw, cwd }).catch(async () => {
    const home = (await homeDir()).replace(/\/$/, "");     // 命令挂了才走这:老规则,只拼不找
    if (raw === "~") return home;
    if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
    return `${cwd.replace(/\/$/, "")}/${raw}`;
  });
}

// 路径/URL 令牌:hover 弹操作菜单。文件=复制路径+打开+打开目录,在线链接=复制链接+打开。点令牌本身直接打开。
// 打开:内置编辑器支持的文件格式直接在 ChatCode 内置编辑器打开;其余交系统默认程序;在线链接用浏览器开。
// 菜单用 portal 挂到 body + fixed 定位 —— 否则在 <pre>/overflow 容器里会被裁掉,弹不出来。
function PathToken({ raw, cwd, isUrl }: { raw: string; cwd: string; isUrl: boolean }) {
  const { t } = useTranslation();
  // menu 存"进入时的光标 x + 菜单顶 y";pos 是量出主按钮宽度后算好的最终 left/top
  const [menu, setMenu] = useState<{ cx: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const closeT = useRef<number>();
  const menuRef = useRef<HTMLSpanElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null); // 最常用的按钮,要落在光标正下方
  const href = webHref(raw, isUrl);   // 非 null = 在线链接
  const isWeb = href !== null;
  const editable = !isWeb && isEditable(raw); // 内置编辑器支持的文件 → 在 ChatCode 内打开,不交系统程序
  const open = async () => {
    if (isWeb) { openUrl(href); return; }
    if (editable) { openEditorWindow(await absPath(raw, cwd), raw.split("/").pop() || raw); return; }
    openPath(raw, cwd);
  };
  const reveal = () => revealPath(raw, cwd);
  const copy = async () => { await copyText(raw); setCopied(true); window.setTimeout(() => setCopied(false), 1200); };
  // 锚到"进入时的光标处"而不是 token 左下角:长路径左对齐时,鼠标悬在路径中/右段,菜单却弹在最左边,
  // 斜着移过去中途会掉出 token 又没进到桥区域 → 一超时就关,很难点中。只在 mouseEnter 取一次坐标(不跟随
  // mousemove),所以不会漂移。
  const show = (e: React.MouseEvent) => {
    window.clearTimeout(closeT.current);
    if (menu) return; // 已弹出就只取消关闭,不重新定位 —— 鼠标在 token 与气泡间来回移动会反复触发 mouseEnter,
                      // 每次按新光标重定位就左右漂移。首次弹出后锁死位置,直到真正关闭。
    const r = e.currentTarget.getBoundingClientRect();
    setPos(null); // 先隐藏,量完主按钮位置再显示,避免跳一下
    setMenu({ cx: e.clientX, y: r.bottom });
  };
  const hide = () => { closeT.current = window.setTimeout(() => setMenu(null), 700); }; // 慢点关,给鼠标从 token 移到气泡的时间
  // 菜单渲染后:量出"主按钮"中心相对菜单左缘的偏移,反推菜单 left,让主按钮中心正对光标 —— 本地路径主按钮
  // 是"打开目录"、在线 URL 是"打开",都是各自最常用的那个。再做左右边界钳制防出屏。useLayoutEffect 在绘制前跑,无闪跳。
  useLayoutEffect(() => {
    if (!menu || !menuRef.current || !primaryRef.current) return;
    const mRect = menuRef.current.getBoundingClientRect();
    const bRect = primaryRef.current.getBoundingClientRect();
    const btnCenter = bRect.left - mRect.left + bRect.width / 2;
    const left = Math.max(8, Math.min(menu.cx - btnCenter, window.innerWidth - mRect.width - 8));
    setPos({ left, top: menu.y });
  }, [menu]);
  return (
    <span className="path-token" onMouseEnter={show} onMouseLeave={hide}
      // 拖选文本后 mouseup 也会触发 click —— 有选区时别打开(否则想复制路径却把文件打开了)
      onClick={(e) => { e.stopPropagation(); if (window.getSelection()?.isCollapsed !== false) open(); }}>
      <span className="path-token-label">{raw}</span>
      {menu && createPortal(
        <span ref={menuRef} className="path-actions"
          style={{ left: pos ? pos.left : menu.cx, top: menu.y, paddingTop: 10, visibility: pos ? "visible" : "hidden" }} // padding 当桥,盖住 token 与气泡间的空隙,鼠标不掉出去
          onMouseEnter={() => window.clearTimeout(closeT.current)} onMouseLeave={hide}
          onClick={(e) => e.stopPropagation()}>
          <button onMouseDown={(e) => { e.preventDefault(); copy(); }}>{copied ? t("已复制") : isWeb ? t("复制链接") : t("复制路径")}</button>
          <button ref={isWeb ? primaryRef : undefined} onMouseDown={(e) => { e.preventDefault(); open(); }}>{t("打开")}</button>
          {!isWeb && <button ref={primaryRef} onMouseDown={(e) => { e.preventDefault(); reveal(); }}>{t("打开目录")}</button>}
        </span>, document.body)}
    </span>
  );
}

// 终端输出块:内容超出限高(scrollbar 已藏)时,气泡底部中间浮出一个下箭头提示"还有更多",
// 点它平滑下滚一屏;滚到底箭头消失。用 ResizeObserver + onScroll 判断是否还没到底。
function TermOut({ text, cwd }: { text: string; cwd: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);
  const check = () => { const el = ref.current; if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2); };
  useEffect(() => {
    check();
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(check); ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div className="term-out-wrap">
      <pre className="term-out" ref={ref} onScroll={check}><Linkify text={text} cwd={cwd} /></pre>
      {more && <button className="term-more" title={t("还有更多，点击向下滚动")}
        onClick={() => ref.current?.scrollBy({ top: ref.current.clientHeight - 30, behavior: "smooth" })}><ChevronDown size={16} /></button>}
    </div>
  );
}

// 把纯文本里的路径/URL 替换成可 hover 的 PathToken,其余原样输出
function Linkify({ text, cwd }: { text: string; cwd: string }) {
  const out: ReactNode[] = [];
  let last = 0; let m: RegExpExecArray | null;
  const re = new RegExp(LINK_RE);
  while ((m = re.exec(text))) {
    if (!shouldLink(m[0], !!m[1])) continue; // 不像路径/URL:不 token 化,留作普通文本(下一段 slice 会带上)
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<PathToken key={m.index} raw={m[0]} cwd={cwd} isUrl={!!m[1]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

// 复制:WKWebView 里 clipboard.writeText 在窗口未聚焦时会抛 "Document is not focused"
//(hover 后首次点击窗口才刚聚焦,第一次必失败)。退回 execCommand 兜底,保证第一次点就成。
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// 气泡右上角那组按钮:贴到输入框 + 复制(顺序即左右)。绝对定位在这层,按钮本身走普通流,
// 不用给"复制"算固定右偏移("已复制"文案会变宽,写死就会错位)。
function BubbleActs({ text }: { text: string }) {
  return <div className="term-acts"><PasteBtn text={text} /><CopyBtn text={text} /></div>;
}

// 通用复制按钮:悬停显形,点后短暂显示"已复制"。stopPropagation 避免把卡片/抽屉一起点开。
function CopyBtn({ text, className = "term-copy" }: { text: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    // 用 mousedown 而非 click:WKWebView 里窗口未聚焦时,首次点击只激活窗口、不派发 click,导致"第一次没反应"。mousedown 首次即到。
    <button className={className} title={t("复制")} onMouseDown={(e) => {
      e.preventDefault(); e.stopPropagation();
      copyText(text).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } });
    }}>{copied ? <><Check size={12} /> {t("已复制")}</> : <><Copy size={12} /> {t("复制")}</>}</button>
  );
}

// 把整段文本以「引用」chip 贴进输入框(和划选后的"贴到输入框"同一条通路)。
// 插在输入框里最后停留的光标处 —— Composer 用 lastCaret 快照记着,不是一律追加到末尾。
function pasteToComposer(text: string) {
  window.dispatchEvent(new CustomEvent("cc-insert-snippet", { detail: { text } }));
}

// 气泡右上角的"贴到输入框":放在复制按钮左边,一键把整条内容变成输入框里的引用 chip
// 只放图标不放文案:气泡右侧要给这组按钮留出固定宽度(见 .line-term-out 的 padding-right),
// 多一个带文案的按钮就得再挤掉 50 多像素正文宽度。
function PasteBtn({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <button className="term-copy term-paste" title={t("贴到输入框")} onMouseDown={(e) => {
      e.preventDefault(); e.stopPropagation();
      pasteToComposer(text);
    }}><Paperclip size={12} /></button>
  );
}

// 清掉选区后逼 WKWebView 把消息区重画一遍。removeAllRanges() 本身不算样式变更,WebKit 就不重绘 ——
// 旧的高亮底色原地留在屏上(markdown 表格最明显:整个单元格的绿底能一直挂着,看着像"选中了没选的内容")。
// 动一下 opacity 是能触发重绘里最轻的:0.999 肉眼无差,不动布局、不动滚动位置。
function repaintSelection(el: HTMLElement | null) {
  if (!el) return;
  el.style.opacity = "0.999";
  requestAnimationFrame(() => { el.style.opacity = ""; });
}

// 选中消息文本后浮出的快捷工具条:复制 / 贴到输入框。只在消息区(timeline)内的选区触发。
// "贴到输入框"发全局事件,由当前会话的 Composer 接住,插成一个引用 chip(见 Composer.insertSnippetChip)。
function SelectionActions({ containerRef }: { containerRef: React.RefObject<HTMLDivElement> }) {
  const { t } = useTranslation();
  const [box, setBox] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      const cont = containerRef.current;
      if (!text.trim() || !sel || !sel.rangeCount || !cont || !cont.contains(sel.anchorNode)) { setBox(null); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r.width && !r.height) { setBox(null); return; }
      setBox({ x: r.left + r.width / 2, y: r.top - 8, text });
    };
    // 新一次划选前先手动清掉旧选区:.app 是 user-select:none、正文是一块块 user-select:text 的"孤岛"
    // (styles.css 末尾),WKWebView 在跨孤岛重新划选时不会重绘旧孤岛,旧的蓝底会一直留在屏幕上。
    // 光 removeAllRanges 不够,还得 repaintSelection 逼它真把那块重画掉。
    // 编辑区排除:那里的光标/输入法状态由 Composer 自己维护,别去动。
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".selection-toolbar")) return;
      setBox(null);
      if (!t?.closest?.('.editor, input, textarea, [contenteditable="true"]')) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) { sel.removeAllRanges(); repaintSelection(containerRef.current); }
      }
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mouseup", onUp); document.removeEventListener("mousedown", onDown); };
  }, [containerRef]);
  if (!box) return null;
  return createPortal(
    <div className="selection-toolbar" style={{ left: box.x, top: box.y }}>
      <button onMouseDown={(e) => { e.preventDefault(); copyText(box.text); setBox(null); }}><Copy size={12} /> {t("复制")}</button>
      <button onMouseDown={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("cc-insert-snippet", { detail: { text: box.text } }));
        window.getSelection()?.removeAllRanges(); repaintSelection(containerRef.current); setBox(null); }}>{t("贴到输入框")}</button>
    </div>, document.body);
}

// 代码块(```fenced```):右上角挂一个复制按钮。取文本不从 React children 里凑
// (那些已经过 Linkify 拆成一堆 PathToken 了),直接读渲染出来的 <code> 的 textContent —— 所见即所得。
// 递归摊平 ReactNode 的纯文本,用来判断代码块是不是空的
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  // 模型偶尔甩出一个空 ``` 围栏,照渲就是一条莫名其妙的黑色横条 —— 空块直接不渲染
  if (!textOf(children).trim()) return null;
  const copy = () => {
    const text = ref.current?.querySelector("code")?.textContent ?? "";
    copyText(text).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } });
  };
  return (
    // 复制按钮放在不滚动的外层 wrap 上(绝对定位),别塞进会横向滚动的 <pre> —— 否则滚代码时按钮跟着跑
    <div className="code-block-wrap">
      {/* mousedown(而非 click):窗口未聚焦时首次 click 不派发,要点两次;stopPropagation 防止点复制把详情抽屉一起点开 */}
      <button className="code-copy" title={t("复制")} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); copy(); }}>
        {copied ? <><Check size={12} /> {t("已复制")}</> : <><Copy size={12} /> {t("复制")}</>}
      </button>
      <pre ref={ref} className="code-block">{children}</pre>
    </div>
  );
}

// 链接走系统浏览器,别让 webview 自己导航到外链(会把整个 app 界面顶掉)。code/链接里的路径也做 hover 操作。
function makeMdComponents(cwd: string) {
  return {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (!href) return <>{children}</>;
      const { url, rest } = splitAutoLink(href, children);
      return <><PathToken raw={url} cwd={cwd} isUrl={/^https?:\/\//.test(url)} />{rest}</>;
    },
    code: ({ children }: { children?: ReactNode }) => <code><Linkify text={String(children ?? "")} cwd={cwd} /></code>,
    pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  };
}

// 菜单项:只认左键,且 preventDefault 掉默认的焦点转移(见 SSH 菜单处的注释)
const pick = (fn: () => void) => (e: React.MouseEvent) => { if (e.button !== 0) return; e.preventDefault(); fn(); };

// WKWebView 复用 .timeline 这个滚动层,"编程式"改 scrollTop 常常不触发重绘 —— 内容其实已经在、
// 滚动条也到位了,却停在一片空白,要手动滚一下(产生真实滚动事件)才上色。
// 下一帧真实滚 1px 再钉回目标位,等价于替用户滚了一下,逼它立刻重绘。到顶时改成往下滚,保证真有位移。
// 凡是编程式跳转滚动位置的地方都得跟一脚 —— 漏掉哪条路径,哪条路径就白屏(切会话、往前翻历史都踩过)。
const pokeRepaint = (el: HTMLElement, top: () => number, ok: () => boolean = () => true) =>
  requestAnimationFrame(() => {
    if (!ok()) return;
    el.scrollTop += el.scrollTop > 0 ? -1 : 1;
    el.scrollTop = top();
  });

export function Chat({ session, onToggleInfo, onShowTurn, onOpenSettings }: { session: Session; onToggleInfo: (tab?: "project" | "branches" | "files") => void; onShowTurn: (anchor: number) => void; onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const { state, respondPermission, sshReconnect, sshClose, configureSsh, chooseResume, requestGitInfo, runTerminal, listSshHosts, sendMessage, enqueuePending } = useStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 是否跟随底部:运行中往上翻历史时不该被新消息拽回去
  const [showSshConfig, setShowSshConfig] = useState(false);
  const [showCommit, setShowCommit] = useState(false); // 顶栏 commit 弹窗
  const [showGitMap, setShowGitMap] = useState(false); // 顶栏 关联 Git 仓库弹窗(本地非 git 目录时)
  const [sshPick, setSshPick] = useState(false); // 目录栏 ▾:本地 / SSH 主机切换菜单
  const [pushing, setPushing] = useState(false); // 顶栏 push/pull 进行中:禁二次点击 + 菊花
  const [committing, setCommitting] = useState(false); // 顶栏 commit 进行中:同上,和 push 一套观感
  const [showJump, setShowJump] = useState(false); // 往上滚一定距离后,右下角显示"回到底部"
  // 长会话滚动卡顿:整条历史全渲染时 DOM 上万节点,WKWebView 每帧重排扛不住。
  // 只渲染最近 N 个回合,顶部"加载更早消息"按需往前翻。
  const HIST_STEP = 30;
  const [histCap, setHistCap] = useState(HIST_STEP);
  useEffect(() => { setHistCap(HIST_STEP); }, [session.id]);
  // 往前翻会在顶部插入内容,把滚动位置往下顶;记住加载前的 scrollHeight,渲染后原地补回
  const histRestore = useRef<{ h: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = timelineRef.current, p = histRestore.current;
    if (el && p) {
      const target = el.scrollHeight - p.h + p.top;
      el.scrollTop = target;
      histRestore.current = null;
      // 少了这一脚就是"点了加载更早,聊天区整片空白":内容和滚动条都对,WKWebView 就是不上色
      pokeRepaint(el, () => target);
    }
  }, [histCap]);
  // 搜索面板点结果:切到会话后要滚到那条消息。ts 由搜索结果给(ISO → 毫秒),命中的可能是
  // 工具调用这种没有独立行的条目,所以取"不晚于它的最后一行"——落到所在回合的卡片上。
  const [focusTs, setFocusTs] = useState<number | null>(null);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.id === session.id && d.ts) setFocusTs(d.ts); };
    window.addEventListener("cc-focus-msg", on);
    return () => window.removeEventListener("cc-focus-msg", on);
  }, [session.id]);
  useLayoutEffect(() => {
    if (focusTs == null) return;
    const el = timelineRef.current; if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-ts]")];
    if (!rows.length) return;                                   // 历史还在回放,等下次渲染
    let hit: HTMLElement | null = null;
    for (const r of rows) { if (+(r.dataset.ts ?? 0) <= focusTs) hit = r; else break; }
    if (!hit) {                                                 // 目标比渲染窗口最早那行还早:往前多翻一页再试
      // 上界用 timeline 长度(回合数一定不超过它),翻到头还没找到就停在第一行,不空转
      if (histCap < session.timeline.length) { histRestore.current = null; setHistCap((c) => c + HIST_STEP); return; }
      hit = rows[0];
    }
    stick.current = false;                                      // 别让"跟随底部"把视图又拽回去
    hit.scrollIntoView({ block: "center" });
    hit.classList.add("msg-focus");
    setTimeout(() => hit?.classList.remove("msg-focus"), 2200);
    setFocusTs(null);
  }, [focusTs, session.timeline.length, histCap]);
  // 命令跑完(terminal_result)会自动刷新 git_info:push 成功则 ahead 归 0、按钮消失;失败则复位可再点。
  // commit 同理(成功后工作区干净、按钮消失),所以两个菊花共用这一处停表,不各自计时。
  useEffect(() => { setPushing(false); setCommitting(false); }, [state.git[session.id]]);
  // 手动往上滑 = 想看历史,松开跟随;滑回底部附近(80px 内)再恢复跟随。
  // 只在真正的滚动事件里判定 —— 自动滚到底也会触发一次,算出来仍是"贴底",不影响。
  const onTimelineScroll = () => {
    const el = timelineRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 80;      // 贴底(80px 内)恢复跟随
    setShowJump(dist > 300);        // 离底 300px 以上,显示回到底部按钮
  };
  const jumpBottom = () => { const el = timelineRef.current; if (el) el.scrollTop = el.scrollHeight; stick.current = true; setShowJump(false); };
  // 切会话:同步(paint 前)把滚动条钉到底。
  // 之前用 useEffect + sentinel.scrollIntoView 有两个毛病:① useEffect 在 paint 之后跑,
  // 浏览器已经先把 .timeline 这个复用 DOM 的 scrollTop 恢复到一个略偏的位置、闪一下;
  // ② scrollIntoView 对准的是零高 sentinel,而 .timeline 有 12px 底部 padding,会停在离底还差一点的地方。
  // 直接 scrollTop = scrollHeight 落点精确,useLayoutEffect 保证在 paint 前完成,不闪不偏。
  useLayoutEffect(() => {
    stick.current = true;
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // 编程式定位到底部同样不触发重绘,补一脚(见 pokeRepaint)。
    // ok 守卫:期间用户已手动往上翻(stick=false)就别硬拽回底部。
    const raf = pokeRepaint(el, () => el.scrollHeight, () => stick.current);
    return () => cancelAnimationFrame(raf);
  }, [session.id]);
  useEffect(() => {
    const el = timelineRef.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
  }, [session.timeline]);
  // 流式回复时 agent 卡片高度是"逐帧长大"的(markdown/工具卡/图片异步撑高),单靠 timeline 变更的 effect
  // 在那一拍 paint 时高度还没长完就钉不到真底,用户得手动往下拉。用 ResizeObserver 盯每个子元素的尺寸变化,
  // 只要还在跟随底部就实时钉回底 —— 覆盖所有增长来源。MutationObserver 保持被观察的子元素集随行增删同步。
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const pin = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(pin);
    const sync = () => { ro.disconnect(); for (const c of el.children) ro.observe(c); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [session.id]);
  // 发消息/重开会话(idle→running)那一刻:即便之前往上翻过(stick=false),也重新贴底并恢复跟随,
  // 保证"发出后 agent 一开口就自动滚到能看见回复",不用手动下拉。
  const prevStatus = useRef(session.status);
  useEffect(() => {
    if (session.status === "running" && prevStatus.current !== "running") {
      stick.current = true;
      const el = timelineRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevStatus.current = session.status;
  }, [session.status]);
  useEffect(() => {
    requestGitInfo(session.id);
    const timer = window.setInterval(() => requestGitInfo(session.id), 15_000);
    return () => window.clearInterval(timer);
  }, [session.id, session.termCwd]);

  const doneCount = session.todos.filter((t) => t.status === "completed").length;
  const parent = session.inheritFrom ? state.index.find((e) => e.id === session.inheritFrom) : null;
  const git = state.git[session.id];
  const branch = git?.local?.find((b) => b.name === git.current);
  // 工作区有未提交内容(含未跟踪文件)。unborn 分支和正常分支两条渲染路径共用同一个判据。
  const dirty = !!git?.status && git.status.trim().length > 0;
  // 顶栏那颗 commit:unborn 分支和正常分支两条路径各画一次,忙碌态又要和右边 push 完全一致 ——
  // 写成一份共用,免得改一处漏一处。菊花从「提交」弹窗按下开始转,到 git_info 刷新为止(同 push)。
  const commitBtn = (
    <button className={`branch-inline-btn hi ${committing ? "is-busy" : ""}`} disabled={committing}
      {...btnPress(() => { if (!committing) setShowCommit(true); })}>
      <span>commit</span>
      {committing && <span className="btn-busy"><Loader2 size={12} className="ico-spin" /></span>}
    </button>
  );
  // SSH 模式 = 这个会话配了远端(连上/连接中/失败都算)。此时目录栏显示远端路径,中间不显示 git 分支 —— 分支读的是本地仓库,和远端无关。
  const sshOn = !!session.ssh;
  const sshState = session.ssh?.status;
  const sshStateLabel = sshState === "connected" ? t("已连接") : sshState === "connecting" ? t("连接中…") : sshState === "error" ? t("连接失败") : t("未连接");
  // 远端命令跑过之后 termCwd 会变成 "user@host:/path";还没跑过时它仍是本地路径,别拿来当远端目录显示
  const sshLabel = session.ssh?.host ?? "";
  const sshPath = session.termCwd?.startsWith(`${sshLabel}:`) ? session.termCwd : `${sshLabel}:~`;

  return (
    <div className="chat">
      {/* data-tauri-drag-region:按住顶栏空白处即可拖动整个窗口(Tauri v2 内置手势,只对带该属性的
          元素本身生效)。所以标题/继承标签/任务进度这些"纯展示"元素都挂上,而"项目详情"是可点按钮 —— 不挂,
          点它只触发点击、不拖窗。浏览器模式下这只是个无意义 data 属性,无副作用。 */}
      {/* 顶栏合成一行:左=当前工作目录+本地/SSH 切换▾(会话名侧栏已有,这里不重复,目录直接和下方头像/输入框左对齐),右=分支信息+项目详情。
          不用横线分隔,自定义主题下用顶部渐变托底(同输入框底部处理),背景图再花也看得清上方文字。 */}
      <div className="chat-topbar" data-tauri-drag-region>
        <div className="topbar-left" data-tauri-drag-region>
          {parent && <span className="inherit-tag" data-tauri-drag-region title={t("继承自 {{title}} 的上下文", { title: parent.title })}><GitFork size={13} /> {t("继承自 {{title}}", { title: parent.title })}</span>}
          {/* 当前工作目录 + 本地/SSH 切换▾,和标题同一行左侧 */}
          {!session.casual && <div className={`dir-switch ${sshOn ? "ssh" : ""}`}>
          {sshOn
            ? <div className="dir-local ssh-target" title={`SSH ${session.ssh!.host} · ${sshLabel}`}>
                <span className={`ssh-dot ${sshState === "connected" ? "on" : "off"}`} />
                <span className="dir-local-path">{sshPath}</span>
              </div>
            : <div className="dir-local" title={t("点击打开 {{path}}", { path: session.termCwd || session.cwd })} role="button" tabIndex={0}
                onClick={() => openPath(session.termCwd || session.cwd)}>
                <span className="dir-ico"><Folder size={14} /></span><span className="dir-local-path">{(session.termCwd || session.cwd).replace(/^\/Users\/[^/]+/, "~")}</span>
              </div>}
          <div className="ssh-menu-wrap">
            {/* 整个菜单一律 onMouseDown + preventDefault,不用 onClick:
                click 要求 mousedown/mouseup 落在同一元素,而 mousedown 会 blur 掉聚焦的输入框 →
                编辑区回缩重排 → mouseup 落到移动后的位置,click 丢失,表现为"要点两次"。
                preventDefault 顺带拦住焦点转移,连 blur 都不发生(InfoPanel 的 tab 同此处理)。 */}
            <button className="dir-caret" title={t("切换本地 / SSH")} onMouseDown={pick(() => { listSshHosts(); setSshPick((o) => !o); })}><ChevronDown size={13} /></button>
            {sshPick && (
              <>
                <div className="ssh-menu-shade" onMouseDown={() => setSshPick(false)} />
                <div className="ssh-menu ssh-pick">
                  <button className={`ssh-pick-item ${sshOn ? "" : "sel"}`} onMouseDown={pick(() => { if (sshOn) sshClose(session.id); setSshPick(false); })}>
                    <b><Folder size={13} /> {t("本地目录")}</b>
                    <span className="muted">{session.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
                  </button>
                  <div className="ssh-pick-sep" />
                  {state.sshHosts.length === 0
                    ? <div className="ssh-pick-empty">
                        <div className="muted">{t("还没有 SSH 配置")}</div>
                        <button className="primary" onMouseDown={pick(() => { setSshPick(false); onOpenSettings(); })}>{t("去设置新建")}</button>
                      </div>
                    : state.sshHosts.map((h) => {
                        const target = `${h.username ? h.username + "@" : ""}${h.host}`;
                        return (
                          <button key={h.id} className={`ssh-pick-item ${sshOn && session.ssh!.host === target ? "sel" : ""}`} title={`${target}${h.port && h.port !== "22" ? ":" + h.port : ""}`}
                            onMouseDown={pick(() => { configureSsh(session.id, { host: h.host, username: h.username, port: h.port, keyPath: h.keyPath }); setSshPick(false); })}>
                            <b><Server size={13} /> {h.label || h.host}</b>
                            <span className="muted">{target}</span>
                          </button>
                        );
                      })}
                  <div className="ssh-pick-sep" />
                  {sshOn && <button disabled={sshState === "connecting"} onMouseDown={pick(() => { sshReconnect(session.id); setSshPick(false); })}>{t("重新连接")}</button>}
                  {sshOn && <button onMouseDown={pick(() => { setShowSshConfig(true); setSshPick(false); })}>{t("配置当前连接")}</button>}
                  <button className="ssh-pick-manage" onMouseDown={pick(() => { setSshPick(false); onOpenSettings(); })}>{t("管理 SSH 配置…")}</button>
                </div>
              </>
            )}
          </div>
          </div>}
        </div>
        <div className="topbar-right" data-tauri-drag-region>
          {session.todos.length > 0 && (
            <span className="progress" data-tauri-drag-region title={session.todos.map((t) => `${t.status === "completed" ? "✅" : t.status === "in_progress" ? "▶" : "○"} ${t.content}`).join("\n")}>
              {t("任务 {{done}}/{{total}}", { done: doneCount, total: session.todos.length })}
              <progress value={doneCount} max={session.todos.length} />
            </span>
          )}
        {!session.casual && !sshOn && <div className="workspace-status" title={git?.root || t("正在读取 Git 状态")}>
          {!git ? <span className="muted">Git…</span> : !git.isRepo ? (
            // 本地目录还没纳入 git:给个入口,一键关联到已有的远程仓库(git init + remote add + fetch)
            <button className="branch-inline-btn git-map-trigger" title={t("把该本地目录关联到一个已有的远程 Git 仓库")}
              onClick={(e) => { e.stopPropagation(); setShowGitMap(true); }}><GitBranch size={12} /> {t("关联 Git 仓库")}</button>
          ) : git.current && !branch ? (() => {
            // unborn 分支:有分支名但零提交,for-each-ref refs/heads 里没有它 → branch 为空。
            // 光"关联 Git 仓库"写了跟踪配置也会落到这:远程有同名分支就给「拉取」一键落地,否则提示先提交。
            const rm = git.remote.find((r) => r === "origin/" + git.current) || git.remote.find((r) => r.endsWith("/" + git.current));
            const [remoteName, ...rest] = (rm || "").split("/");
            return <div className="branch-line">
              <span className="branch-grp">{t("本地 {{branch}}", { branch: git.current })} <span className="muted">{t("·无提交")}</span>
              {/* 零提交的仓库同样要能提交 —— 首次提交恰恰是这个状态下最该做的事(之前只有正常分支路径给了按钮) */}
              {dirty && commitBtn}</span>
              <span className="branch-sep">-</span>
              {rm
                ? <span className="branch-grp">{t("远程 {{name}}", { name: rm })}
                    <button className="branch-inline-btn hi" {...btnPress(() => runTerminal(session.id, `git pull ${remoteName} ${rest.join("/")}`))}>{t("拉取")}</button>
                    <button className="branch-inline-btn" title={t("分支管理")} {...btnPress(() => onToggleInfo("branches"))}><GitBranch size={12} /></button></span>
                : <span className="branch-grp muted">{t("远程 未跟踪 · 提交一次后可推送")}</span>}
            </div>;
          })() : (() => {
            const ahead = branch?.ahead || 0, behind = branch?.behind || 0;
            const seg = (label: string, name: string, lead?: number) => <>{label} {name}{lead ? <span className="branch-lead">{t("·领先 {{n}}", { n: lead })}</span> : ""}</>;
            // push 走显式 refspec:裸 `git push` 在本地名 ≠ 上游名时(oss...origin/main)会直接 fatal,
            // 顶栏这颗按钮不能只在分支名恰好同名时才好使。pull 不受 push.default 影响,保持原样。
            const btn2 = behind ? { name: "pull", cmd: "git pull" }
              : ahead && git.current && branch?.upstream ? { name: "push", cmd: pushCmd(git.current, branch.upstream) } : null;
            return <div className={`branch-line clickable ${ahead || behind ? "changed" : ""}`} role="button" tabIndex={0}
              title={t("点击打开分支管理")} onClick={() => onToggleInfo("branches")}>
              <span className="branch-grp">{seg(t("本地"), git.current || "detached HEAD", ahead)}
              {dirty && commitBtn}</span>
              <span className="branch-sep">-</span>
              <span className="branch-grp">{seg(t("远程"), branch?.upstream || t("未跟踪"), behind)}
              {btn2 && <button className={`branch-inline-btn hi ${pushing ? "is-busy" : ""}`} disabled={pushing}
                {...btnPress(() => { if (pushing) return; setPushing(true); runTerminal(session.id, btn2.cmd); })}>
                <span>{btn2.name}</span>
                {pushing && <span className="btn-busy"><Loader2 size={12} className="ico-spin" /></span>}</button>}</span>
            </div>;
          })()}
        </div>}
        {/* 弹窗必须挂在 .branch-line 外面:Radix Portal 只是把 DOM 节点挪到了 body,
            React 的事件冒泡走的仍是组件树 —— 挂在里面的话,点弹窗的「提交」/「取消」/遮罩,
            事件都会冒泡到 .branch-line 的 onClick,把项目详情抽屉一起打开 */}
        {showCommit && <CommitDialog scope={session.cwd} sessionId={session.id} onSubmit={(message) => { setCommitting(true); runTerminal(session.id, `git add -A && git commit -m '${message.replace(/'/g, "'\\''")}'`); setShowCommit(false); }} onCancel={() => setShowCommit(false)} />}
        {/* 关联已有远程仓库(不动工作区文件)。关键:光 init+remote add+fetch 不会建立"分支跟踪(upstream)" ——
            git init 造出的本地分支和远程无血缘,之后 rebase/checkout/fetch 都补不上跟踪。所以这里 fetch 后:
              1) set-head 探测远程默认分支名(main/master),取不到则默认 main;
              2) 把本地当前分支改名成它(git branch -M,unborn 分支也可改名);
              3) 直接写 branch.<def>.remote/.merge 配置建立跟踪 —— 直接写 config 即便本地还没 commit 也生效。
            terminal_result 完成后 store 会自动刷新 git_info,目录栏随即从"关联 Git 仓库"变成正常分支行。 */}
        {showGitMap && <GitMapDialog onSubmit={(url) => {
          const safe = url.replace(/'/g, "'\\''"); // 单引号包裹 + 转义,URL 当字面量传给 bash
          // 注意用普通字符串拼接而非模板串:命令里的 ${def:-main} 会被 JS 模板语法误解析
          const cmd =
            "git init" +
            " && (git remote add origin '" + safe + "' 2>/dev/null || git remote set-url origin '" + safe + "')" +
            " && git fetch origin" +
            " && def=$(git remote set-head origin -a >/dev/null 2>&1; git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')" +
            "; def=${def:-main}" +
            "; git branch -M \"$def\"" +
            "; git config branch.\"$def\".remote origin" +
            "; git config branch.\"$def\".merge \"refs/heads/$def\"" +
            "; echo \"✓ 已关联 origin,本地分支 $def 现在跟踪 origin/$def\"";
          runTerminal(session.id, cmd);
          setShowGitMap(false);
        }} onCancel={() => setShowGitMap(false)} />}
        {/* 连上了就不再占位:左侧目录栏的绿点已经说明状态,只有连接中/失败/未连接才需要文字 */}
        {sshOn && sshState !== "connected" && <div className="workspace-status muted">{sshStateLabel}</div>}
        {/* onMouseDown 而非 onClick:WKWebView 里窗口/抽屉失焦后首次 click 会被吞(同 footer-row),mousedown 不会 */}
        {/* 默认开在「分支」:抽屉里最常看的是工作区改动/分支同步状态,不是项目信息 */}
        {!session.casual && <button className="ghost details-trigger" onMouseDown={(e) => { if (e.button === 0) onToggleInfo("branches"); }}>{t("项目详情")} <ChevronRight size={13} /></button>}
        </div>
      </div>

      <div className="timeline" ref={timelineRef} onScroll={onTimelineScroll}
        // 委托:光标在任一气泡内移动时,写 --mx/--my(spotlight 高光)
        // + --edge/--ang(BorderGlow:离边缘越近越亮、按光标方向点亮那条边)
        onMouseMove={(e) => {
          const b = (e.target as HTMLElement).closest(".bubble") as HTMLElement | null;
          if (b) applyEdgeGlow(b, e.clientX, e.clientY);
        }}>
        {/* 重开会话、历史还没回放到:显示加载态而非白屏 */}
        {session.loadingHistory && session.timeline.length === 0 && !session.resumePrompt && (
          <div className="timeline-loading"><Loader2 size={18} className="spin" /> {t("正在加载历史消息…")}</div>
        )}
        {(() => {
          // 整条时间线按用户消息切回合。每个 agent 回合折叠成一张卡片,点开看详情;
          // 回合的结算行(result:本轮耗时)单独留在卡片下方,不塞进卡片。
          const groups = groupTurns(session.timeline);
          const running = session.status === "running";
          // 「本轮 agent 组」= 最后一个 agent 组(它后面可能跟着用户跑的终端命令组,那不算新回合)。
          // 用它判进行中,而不是"最后一组",否则 commit/push 一插进来气泡就不再算 active。
          let lastUser = -1, lastAgent = -1;
          groups.forEach((g, i) => { if ("user" in g) lastUser = i; else if ("agent" in g) lastAgent = i; });
          if (running && (!groups.length || lastAgent < lastUser)) { groups.push({ agent: [] }); lastAgent = groups.length - 1; }
          const onPerm = (rid: string, b: "allow" | "deny", msg?: string, remember?: RememberChoice) => respondPermission(session.id, rid, b, msg, remember);
          // 点建议 chip = 等于自己敲这句话回车。agent 还在跑就进待发队列(和斜杠命令菜单同一道闸)
          const sendChip = (text: string) => {
            if (session.status === "running") {
              if ((session.pending?.length ?? 0) >= 3) { toast(t("待发已满（最多 3 条）")); return; }
              enqueuePending(session.id, { blocks: [{ type: "text", text }], text });
              toast(t("已加入待发"));
              return;
            }
            sendMessage(session.id, [{ type: "text", text }]);
          };
          // 某条 agent 回复由哪个模型产生:取该回合消息自带的 model(会话中途切模型时逐条不同),回退到当前模型。
          const groupModel = (items: TimelineItem[]): string | undefined => {
            for (const it of items) if ((it as any).model) return (it as any).model;
            return session.info.model;
          };
          // 展示名优先用 /model 列表里的 displayName(Opus 4.8 / DeepSeek V4 Pro…),查不到回退品牌名。
          const nameOf = (model?: string) => modelDisplayName(session, model) ?? brandName(model);
          const agentLabel = t("{{name}} 的回复", { name: nameOf(session.info.model) }); // user/solo 行的兜底(agent 组内按回合模型另算)
          // 窗口化:只渲染最近 histCap 个回合。anchor 回溯用完整 groups(被裁掉的也要能查到)。
          const start = Math.max(0, groups.length - histCap);
          const rows = groups.slice(start).map((g, si) => {
            const gi = start + si;
            // anchor = 最近的前置用户消息 ts。只看紧邻上一组会漏:中间夹了 term(git)组时退回 0,多张卡全指向会话开头那轮
            let anchor = 0;
            for (let k = gi - 1; k >= 0; k--) { const p = groups[k]; if ("user" in p) { anchor = p.user.ts; break; } }
            if ("user" in g) {
              // 这条消息后的 agent 回合被打断(interrupt → result.aborted)时,气泡下方给出 重试/编辑/复制。
              const nextG = groups[gi + 1];
              const aborted = !!nextG && "agent" in nextG && nextG.agent.some((it) => it.kind === "result" && (it as any).aborted);
              const uText = ((g.user as any).blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
              return (
              <div key={gi} className="msg-row msg-row-user" data-ts={g.user.ts}>
                <UserAvatar />
                <div className="msg-col">
                  <div className="msg-name">{getUserName() || t("我")}</div>
                  <Item item={g.user} cwd={session.termCwd || session.cwd} onAgentClick={() => onShowTurn(g.user.ts)} onPermission={onPerm} agentLabel={agentLabel} />
                  {/* 这排按钮原来只在"下一轮被打断"时才出现(aborted),平时整排都不渲染 —— 用户以为按钮丢了。
                      改成常驻:平时淡出、悬停整行才显形;被打断那种真要人动手的状态照旧常亮(.always)。 */}
                  {(
                    <div className={`msg-redo-row ${aborted ? "always" : ""}`}>
                      {/* onMouseDown 而非 onClick:WKWebView 首点常被吞(全仓一致处理) */}
                      <button title={t("重试:重新发起这条消息")} onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); sendMessage(session.id, (g.user as any).blocks); } }}><RotateCcw size={13} /></button>
                      {/* 有发送时的 composer 快照(本会话内发的)→ 图片+引用 chip 全还原;历史老消息只有 blocks → 图片可还原、引用退化为文本 */}
                      <button title={t("编辑:回填到输入框")} onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); const u = g.user as any; window.dispatchEvent(new CustomEvent("cc-fill-composer", { detail: u.composerHtml != null ? { html: u.composerHtml, imgs: u.composerImgs } : { blocks: u.blocks } })); } }}><Pencil size={13} /></button>
                      <button title={t("复制内容")} onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); copyText(uText).then((ok) => ok && toast(t("已复制"), "success")); } }}><Copy size={13} /></button>
                    </div>
                  )}
                </div>
              </div>
              );
            }
            if ("solo" in g) {
              // 终端命令渲染成两条聊天气泡:用户发的命令 + 电脑回的日志
              if (g.solo.kind === "terminal") return <TermRows key={gi} item={g.solo} cwd={session.termCwd || session.cwd} />;
              return <Item key={gi} item={g.solo} cwd={session.termCwd || session.cwd} onAgentClick={() => {}} onPermission={onPerm} agentLabel={agentLabel} />;
            }
            const isActive = running && gi === lastAgent;
            // 只有"最后一轮 + 会话已停"才可能悬着后台任务:一旦下一轮开始,它就不是最后一组了,提示自然消失。
            // 还要 ∩ SDK 的 background_tasks_changed 电平(session.bgTasks):正则扫时间线只能看出"发起过",
            // 任务跑完的自动完成通知被 sidecar 当输入回显丢了,不交集就会永远显示"运行中"。
            const liveBg = new Set(session.bgTasks ?? []);
            const bgWait = !running && gi === lastAgent ? pendingBgTasks(g.agent, t).filter((t) => liveBg.has(t.id)) : [];
            // 本轮结算:把一整回合(可能含多次 SDK result:续跑/授权/压缩)聚合成一行,现放进气泡底部。
            const settle = isActive ? null : aggregateRound(g.agent, anchor || g.agent[0]?.ts);
            const turnModel = groupModel(g.agent); // 该回合实际所用模型(会话中途切模型时逐条不同)
            return (
              <div key={gi} className="msg-row msg-row-agent" data-ts={g.agent[0]?.ts ?? anchor}>
                <ModelAvatar model={turnModel} running={isActive} />
                <div className="msg-col agent-turn">
                  <div className="msg-name">{nameOf(turnModel)}</div>
                  {isActive
                    ? <ActiveAgentBubble items={g.agent} running showFull={false} cwd={session.termCwd || session.cwd} liveInput={session.contextTokens} settle={null} onClick={() => onShowTurn(anchor)} onPermission={onPerm} agentLabel={t("{{name}} 的回复", { name: nameOf(turnModel) })} />
                    : <AgentTurnCard items={g.agent} running={false} showFull cwd={session.termCwd || session.cwd} liveInput={session.contextTokens} settle={settle} bgWait={bgWait} onClick={() => onShowTurn(anchor)} onPermission={onPerm} agentLabel={t("{{name}} 的回复", { name: nameOf(turnModel) })} />}
                  {/* 建议 chips(左)和复制/贴回按钮(右)同占一行 —— 分两行时按钮被 chips 顶得离气泡老远 */}
                  {!isActive && (
                    <div className="turn-foot">
                      {/* 下一步建议:只挂最后一个 agent 回合 —— 一发新消息它就不是最后一组了,chip 自动消失。
                          历史每轮都挂一排会把整屏塞满按钮。 */}
                      {gi === lastAgent && (() => {
                        const steps = nextSteps(g.agent);
                        if (!steps.length) return null;
                        return <div className="next-chips">
                          {steps.map((s, i) => (
                            <button key={i} className="next-chip" title={t("发送：{{text}}", { text: s })}
                              onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); sendChip(s); } }}>{s}</button>
                          ))}
                        </div>;
                      })()}
                      {/* 复制整条回复:和用户气泡下方那排同一套样式(.msg-redo-row),只是靠右对齐到气泡右下角 */}
                      {turnText(g.agent) && (
                        <div className="msg-redo-row agent-actions">
                          <button title={t("贴到输入框:整条回复变成一个引用 chip")} onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); pasteToComposer(turnText(g.agent)); } }}><Paperclip size={13} /></button>
                          <button title={t("复制整条回复")} onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); copyText(turnText(g.agent)).then((ok) => ok && toast(t("已复制"), "success")); } }}><Copy size={13} /></button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          });
          return <>
            {/* onMouseDown:mousedown 会 blur 掉聚焦的输入框、触发重排,click(mouseup)落在移动后的位置就丢了 */}
            {start > 0 && <button className="load-earlier" onMouseDown={pick(() => {
              const el = timelineRef.current;
              if (el) histRestore.current = { h: el.scrollHeight, top: el.scrollTop };
              setHistCap((c) => c + HIST_STEP);
            })}>{t("加载更早消息（还有 {{n}} 轮）", { n: start })}</button>}
            {rows}
          </>;
        })()}
        {/* 用量/耗时跟随对话流,落在整段消息的右下角(不再单独占一条压在输入框上方的色带) */}
        <SessionStats session={session} startedAt={state.index.find((entry) => entry.id === session.id)?.createdAt} />
        <div ref={bottomRef} />
      </div>

      {showJump && <button className="jump-bottom" title={t("回到最新")} onClick={jumpBottom}><ArrowDown size={18} /></button>}
      <SelectionActions containerRef={timelineRef} />

      {(() => {
        // 有待作答的 AskUserQuestion:把问答卡钉在输入框位置挡住输入,必须先作答才能继续输入指令
        const ask = [...session.timeline].reverse().find((t): t is Extract<TimelineItem, { kind: "permission" }> =>
          t.kind === "permission" && !t.decision && t.toolName === "AskUserQuestion" && Array.isArray(t.input?.questions));
        if (ask) return <div className="composer ask-dock">
          <AskQuestionCard item={ask}
            onSubmit={(msg) => respondPermission(session.id, ask.requestId, "deny", msg)}
            onCancel={() => respondPermission(session.id, ask.requestId, "deny", t("用户跳过了此问题,未作选择。"))} />
        </div>;
        // 恢复选项菜单显示在输入框上方(不再顶掉输入框);点选项或直接发消息都能关掉它,发消息=完整恢复
        return <>
          {session.resumePrompt && <ResumeCard prompt={session.resumePrompt} onChoose={(c) => chooseResume(session.id, c)} />}
          <Composer session={session} />
        </>;
      })()}
      {showSshConfig && <SshConfig current={session.ssh} onClose={() => setShowSshConfig(false)} onSave={(config) => { configureSsh(session.id, config); setShowSshConfig(false); }} />}
    </div>
  );
}

function SshConfig({ current, onClose, onSave }: { current?: Session["ssh"]; onClose: () => void; onSave: (c: { host: string; username?: string; port?: string; keyPath?: string }) => void }) {
  const { t } = useTranslation();
  const currentHost = current?.host;
  const [username, hostFromTarget = ""] = (currentHost || "").split("@");
  const [host, setHost] = useState(currentHost?.includes("@") ? hostFromTarget : currentHost || "");
  const [account, setAccount] = useState(currentHost?.includes("@") ? username : "");
  const [port, setPort] = useState(current?.port || "22");
  const [keyPath, setKeyPath] = useState(current?.keyPath || "");
  return <div className="ssh-config-shade" onMouseDown={onClose}><form className="ssh-config" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (host.trim()) onSave({ host: host.trim(), username: account.trim() || undefined, port: port.trim() || undefined, keyPath: keyPath.trim() || undefined }); }}>
    <div className="ssh-config-head"><b>{t("配置 SSH 连接")}</b><button type="button" className="ghost" onClick={onClose}><X size={16} /></button></div>
    <label>{t("服务器 IP / 主机名")}<input autoFocus required value={host} onChange={(e) => setHost(e.target.value)} placeholder={t("203.0.113.10 或 server.example.com")} /></label>
    <label>{t("登录账号")}<input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="ubuntu" /></label>
    <label>{t("端口")}<input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric" /></label>
    <label>{t("私钥文件路径（可选）")}<input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" /></label>
    <div className="ssh-config-note">{t("配置会随会话保存。私钥路径只保存在本机；请确保文件权限正确。")}</div>
    <button className="ssh-save" type="submit">{t("保存并连接")}</button>
  </form></div>;
}

// 重开大会话前的二次确认(对齐 CLI --resume)。agent 尚未启动,先选恢复方式。
function ResumeCard({ prompt, onChoose }: { prompt: ResumePrompt; onChoose: (c: ResumeChoice) => void }) {
  const { t } = useTranslation();
  const opts: { c: ResumeChoice; label: string; desc?: string }[] = [
    { c: "summary", label: t("从摘要恢复(推荐)"), desc: t("先接回上下文再立刻压缩,后续每轮只带摘要") },
    { c: "full", label: t("完整恢复"), desc: t("保留全部对话,这一轮就要吃掉整块上下文") },
    { c: "fresh", label: t("取消"), desc: t("不加载历史、不压缩,在该项目下作为全新对话开始") },
  ];
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (i + 1) % opts.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (i - 1 + opts.length) % opts.length); }
    else if (e.key >= "1" && e.key <= "3") { e.preventDefault(); onChoose(opts[+e.key - 1].c); }
    else if (e.key === "Enter") { e.preventDefault(); onChoose(opts[idx].c); }
  }
  return (
    <div className="resume-card" tabIndex={0} ref={ref} onKeyDown={onKey}>
      <div className="resume-head">
        {t("这个会话已存在 {{age}},上下文 {{tokens}} tokens。", { age: fmtAge(prompt.ageMs), tokens: fmtTok(prompt.tokens) })}
      </div>
      <div className="resume-sub muted">{t("完整恢复会占用可观的用量额度,建议从摘要恢复。")}</div>
      {opts.map((o, i) => (
        <div key={o.c} className={`resume-opt ${i === idx ? "hi" : ""}`}
          onMouseEnter={() => setIdx(i)} onClick={() => onChoose(o.c)}>
          <span className="resume-n">{i + 1}</span>
          <div><b>{o.label}</b>{o.desc && <div className="muted">{o.desc}</div>}</div>
        </div>
      ))}
      <div className="ask-hint">{t("↑↓/数字 选择 · ⏎ 确认")}</div>
    </div>
  );
}

function fmtAge(ms: number) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function hasStreamingTail(tl: TimelineItem[]) {
  const last = tl[tl.length - 1];
  return last?.kind === "agent_text" && last.streaming;
}

// token 数量采用具体数字 / k / w，避免 30 万显示成难读的 300k。
function fmtTok(n?: number) {
  if (n === undefined) return "";
  if (n >= 10_000) return `${fmtDecimal(n / 10_000)}w`;
  if (n >= 1_000) return `${fmtDecimal(n / 1_000)}k`;
  return String(n);
}
function fmtDecimal(n: number) { return n.toFixed(1).replace(/\.0$/, ""); }
function fmtDuration(ms: number) {
  const totalSeconds = Math.floor(Math.max(0, ms / 1000)); // 耗时不要小数
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}min${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}min${seconds}s`;
}
// running 卡片用:整秒,不带小数;超 60s 走 XminYs
function fmtDurationSec(ms: number) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}min${s % 60}s`;
}
// 右下角只要时和分,不要秒
function fmtDurationCoarse(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}min`;
}

// running 时每 200ms 走一次,让"本轮耗时"实时递增;结束(result 到)就停在最终值。
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

// 用户在授权/提问卡上花的"等选择"时间:卡片出现(ts)→ 作答(decidedTs)。还没答的按到 now 计(正在等)。
// 这段是等人做决定、agent 空转,不该算进本轮耗时,统一从耗时里扣掉。
function permWaitMs(items: TimelineItem[], now: number): number {
  let w = 0;
  for (const it of items) {
    if (it.kind !== "permission") continue;
    if (it.decidedTs) w += Math.max(0, it.decidedTs - it.ts);
    else if (!it.decision) w += Math.max(0, now - it.ts); // 还挂着 = 此刻仍在等
  }
  return w;
}

// 曾经这里有个"宽度棘轮":running 时把见过的最大 offsetWidth 钉成 minWidth,防活流行长忽长忽短时卡片回缩。
// 已删。.msg-row-agent > .msg-col 现在是 flex: 0 0 70%,气泡本来就恒宽,棘轮无事可做;
// 反倒是它钉下的是**像素**值,窗口变窄 / 侧栏展开后那个死数还在,min-width 又压得过 max-width:70%,
// 卡片就横着捅出聊天区(用户报的"消息卡片宽度超了")。
// 高度同样不做棘轮:.work-stream.tall 的 max-height 已经封住了活流把卡片越推越高。

// 用户发出消息后,agent 气泡不立刻出现:先在名字下方顶约 1.4s 的"思考中"小动画,再展开正在工作的气泡。
// 只用于当前活跃回合;定时器随该回合的行挂载启动,回合切换(新 gi)自然重新计时。
function ActiveAgentBubble(props: Parameters<typeof AgentTurnCard>[0]) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 1400); return () => clearTimeout(t); }, []);
  // 只有空回合(刚发出消息、还没任何内容)才顶这 1.4s。回合已有内容还退回三点的话,
  // 后台任务跑完接着续跑时,已经长出来的气泡会凭空消失两三秒再重新出现。
  if (!ready && !props.items.length) return <div className="agent-thinking" aria-label={t("正在思考")}><span /><span /><span /></div>;
  return <AgentTurnCard {...props} />;
}

// 回合正文的一段:agent 的连续文本,或中途用户对 AskUserQuestion 的作答
type TurnSeg = { kind: "text"; text: string } | { kind: "choice"; answer?: string };

// 回合内用户的作答。走用户消息那套绿色系(和 .line-user 同源),让它在 agent 正文里一眼可辨 ——
// 这是"用户说的话",不该长得像 agent 的输出。
function TurnChoice({ answer }: { answer?: string }) {
  const { t } = useTranslation();
  // sidecar 回传的答案带固定包装语,展示时剥掉(与 AskQuestionCard 的已决态一致)
  const text = answer?.replace(/^用户已作出选择:\n?/, "").replace(/\n请据此继续。$/, "").trim();
  return (
    <div className="turn-choice">
      <div className="turn-choice-label"><CornerDownRight size={12} /> {t("你的选择")}</div>
      {text ? <div className="turn-choice-body">{text}</div> : <div className="turn-choice-body muted">{t("已跳过,未作选择")}</div>}
    </div>
  );
}

// 鉴权失败是少数「用户点一下就能自救」的报错,但正文只有一句英文(Failed to authenticate: OAuth session
// expired and could not be refreshed),用户得自己想到去设置页登录 —— 就地挂个按钮,走和设置页同一条
// authAction(拉起系统终端跑真实 OAuth,webview 里做不了交互式授权)。
// 只认 Claude CLI 自己的这几句:第三方 provider 的 key 失效是另一回事(该去设置改 key),别把人往 OAuth 上引。
const AUTH_FAIL = /failed to authenticate|oauth (session|token) (has )?expired|please run\s*\/login|not logged in/i;

// 一个 agent 回合折叠成一张卡片:标题随状态变化,点开进右侧看详情(流式)。
// 执行中无待办 → "Agent 正在工作…";执行中有授权请求 → "Agent 正在工作,请求执行 xxx";已结束 → "Claude 的回复"。
function AgentTurnCard({ items, running, showFull, cwd, liveInput, settle, bgWait, onClick, onPermission, agentLabel }: { items: TimelineItem[]; running: boolean; showFull?: boolean; cwd: string; liveInput?: number; settle?: (TimelineItem & { kind: "result" }) | null; bgWait?: BgTask[]; onClick: () => void; onPermission: OnPermission; agentLabel?: string }) {
  const { t } = useTranslation();
  const { authAction } = useStore();
  // 待授权请求就地放在卡片内部,不另起一张卡。AskUserQuestion 改在输入框处强制作答,不塞进卡片。
  const pendingPerms = items.filter((it): it is Extract<TimelineItem, { kind: "permission" }> => it.kind === "permission" && !it.decision && it.toolName !== "AskUserQuestion");
  const now = useNow(running);
  const startTs = items[0]?.ts; // 本轮起点=组内首个动作
  const elapsed = startTs ? Math.max(0, now - startTs - permWaitMs(items, now)) : 0; // 扣掉等用户选择的时间
  // 气泡右上角时间 = 本轮回复完成时刻(优先结算行 ts,回退到最后一个动作);运行中还没完成则不显示
  const doneTs = settle?.ts ?? items[items.length - 1]?.ts;
  const { skills, mcps, activeSkills, activeMcps } = usedSkillsMcp(items);
  const memories = usedMemories(items); // 本轮触达的记忆(引用 / 更新)
  const memRefs = memories.filter((m) => m.action === "read");
  const memUpdates = memories.filter((m) => m.action !== "read");
  const md = makeMdComponents(cwd);
  // 一轮里的正文常被工具调用切成好几段(每段一条 agent_text),而且下一段往往直接续着上一段的句子写
  // (…确保 Mermaid → [跑一下] → 图能渲染。)。只渲染最后一条 = 正文缺一大截、还从半截句子开头,所以全都要,按顺序拼。
  //
  // 但"拼成一整块"在有 AskUserQuestion 的回合里会毁掉可读性:agent 问 → 用户选 → agent 接着说,
  // 这三步全糊成一大段 Markdown,而用户自己选了什么根本不显示(下面 pendingPerms 把已作答的 ask 排除了)。
  // 所以按时间顺序切段:连续的 agent_text 照旧合并(保住续句),遇到已作答的 ask 就断开并插入选择块。
  const segments = useMemo<TurnSeg[]>(() => {
    if (!showFull) return [];
    const out: TurnSeg[] = [];
    let buf: string[] = [];
    const flush = () => { const t = buf.join("\n\n").trim(); if (t) out.push({ kind: "text", text: t }); buf = []; };
    for (const it of items) {
      if (it.kind === "agent_text" && it.text.trim()) buf.push(stripSummary(it.text.trim()));
      else if (it.kind === "permission" && it.toolName === "AskUserQuestion" && it.decision) {
        flush();
        out.push({ kind: "choice", answer: it.answer });
      }
    }
    flush();
    return out;
  }, [items, showFull]);
  const hasBody = segments.length > 0;
  return (
    <div className={`agent-turn-card bubble ${running ? "running" : ""} ${bgWait?.length ? "bg-wait" : ""}`}>
      <div className="agent-turn-body">
        {running
          ? <WorkBody items={items} elapsed={elapsed} liveInput={liveInput} />
          : <><b>{agentLabel || t("回复")}</b>{hasBody ? null : <small>{workSummary(items, t)}</small>}</>}
      </div>
      {hasBody && (
        <div className="agent-turn-full md agent-copy">
          {segments.map((s, i) => s.kind === "text"
            ? <Markdown key={i} remarkPlugins={[remarkGfm]} components={md}>{s.text}</Markdown>
            : <TurnChoice key={i} answer={s.answer} />)}
        </div>
      )}
      {memUpdates.length > 0 && <MemoryRefs memories={memUpdates} kind="update" cwd={cwd} />}
      {memRefs.length > 0 && <MemoryRefs memories={memRefs} kind="ref" cwd={cwd} />}
      {pendingPerms.map((item) => <Item key={item.requestId} item={item} cwd={cwd} onAgentClick={onClick} onPermission={onPermission} agentLabel={agentLabel} />)}
      {settle && !settle.aborted && failedEdits(items).allFailed && (
        <div className="bubble-warn">{t("⚠ 本轮 {{n}} 处文件编辑全部失败,改动可能未落地", { n: failedEdits(items).failed })}</div>
      )}
      {settle?.isError && items.some((it) => it.kind === "agent_text" && AUTH_FAIL.test(it.text)) && (
        <div className="bubble-warn auth-fail">
          <span>{t("Claude 登录已失效。重新授权后再发一次这条消息。")}</span>
          <button className="primary" onClick={() => authAction("claude", "login")}>{t("去登录")}</button>
        </div>
      )}
      {!!bgWait?.length && <BgTasksBar tasks={bgWait} />}
      {settle && <RoundMeta r={settle} doneTs={!running ? doneTs : undefined} />}
      {(skills.length > 0 || mcps.length > 0) && <SkillMcpTags skills={skills} mcps={mcps} activeSkills={activeSkills} activeMcps={activeMcps} />}
      {/* 详情只由这个箭头触发(不再点整个气泡);圆形外框增大点击面积 */}
      <button className="bubble-arrow" title={t("查看本轮详情")} onClick={onClick}><ChevronRight size={14} /></button>
    </div>
  );
}

// 气泡底部结算行:本轮耗时 + token 输入/输出(含缓存命中率)
function RoundMeta({ r, doneTs }: { r: TimelineItem & { kind: "result" }; doneTs?: number }) {
  const { t } = useTranslation();
  const inTok = (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0);
  const outTok = r.usage?.output_tokens ?? 0;
  const inCached = r.usage?.cache_read_input_tokens ?? 0; // 命中缓存的输入数(绝对值)
  const inUncached = inTok - inCached; // 未命中缓存的输入数
  const prefix = r.aborted ? t("用户终止，耗时") : r.isError ? t("本轮出错，耗时") : t("本轮耗时");
  // 完成时间在"本轮耗时"左边(气泡内)
  return <div className={`bubble-meta ${r.aborted ? "aborted" : ""}`}>{doneTs && <span className="bubble-time">{fmtClock(doneTs)}</span>}{prefix}{fmtDuration(r.durationMs)}{t(" · 输入 {{n}} tokens", { n: fmtTok(inUncached) })}{inCached > 0 ? t("(+缓存{{n}})", { n: fmtTok(inCached) }) : ""}{t(" · 输出 {{n}} tokens", { n: fmtTok(outTok) })}</div>;
}

// 本轮"落空"检测:agent 发起过写文件工具(Edit/Write/…),但全部回了 is_error →
// 改动多半没落地,却因为轮次整体仍标"成功"而不显眼(agent 常以为改了就往下走)。
// 只在"发起过且全失败"时提示,避免误报;部分成功不算落空。
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function failedEdits(items: TimelineItem[]) {
  let total = 0, failed = 0;
  for (const it of items) {
    if (it.kind !== "tool" || !EDIT_TOOLS.has(it.name || "") || it.result === undefined) continue;
    total++;
    if (it.isError) failed++;
  }
  return { failed, allFailed: total > 0 && failed === total };
}

// 后台任务检测:Bash(run_in_background) 和异步子 agent 都是"发起完本轮就结束、任务跑完 SDK 才回来续跑",
// 于是气泡结算了、状态回 idle,但这条消息其实还会有下文。
// 不看 input.run_in_background —— 子 agent 默认就是后台,那个字段常常压根不在 input 里。
// 看工具自己回的固定标记最准:Bash 回 "Command running in background with ID: xxx",
// 子 agent 回 "Async agent launched successfully ... agentId: xxx"。
// 必须带真正的启动标记才算 —— 光看裸 "agentId:" 会误命中 agent 正文/报告里提到该词的工具结果
// (分析类会话尤其常见),塞进一个永不被消费的假 id,提示就永远挂着。
// shell 任务顺带给出输出文件路径(边跑边追加,是唯一能看到的真实进度);子 agent 只给 agentId。
const BG_START = /running in background with ID:\s*([\w-]+)\.\s*Output is being written to:\s*(\S+?)\.?(?=\s|$)|Async agent launched[\s\S]*?agentId:\s*([\w-]+)/g;
type BgTask = { id: string; kind: "shell" | "agent"; title: string; body: string; out?: string; ts?: number };
function pendingBgTasks(items: TimelineItem[], t: (key: string) => string): BgTask[] {
  const found: BgTask[] = [];
  const done = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    if (it.isError || it.result === undefined) continue; // 被拦下/报错的读取不算了结(它压根没跑)
    // 本轮内又去读/停过它(Read tasks/<id>.output、TaskOutput、TaskStop…),说明已经了结,不算悬着
    const inp = JSON.stringify(it.input ?? "");
    for (const t of found) if (inp.includes(t.id)) done.add(t.id);
    const res = typeof it.result === "string" ? it.result : JSON.stringify(it.result);
    const cmd = String(it.input?.command ?? "");
    // ts = 启动它的那次工具调用的时间,给 bar 上的"已跑 Xmin"当起点(后台任务本身不回时间)
    for (const m of res.matchAll(BG_START)) found.push(m[1]
      ? { id: m[1], kind: "shell", title: String(it.input?.description || cmd.split("\n")[0] || t("后台命令")), body: cmd, out: m[2], ts: it.ts }
      : { id: m[3], kind: "agent", title: String(it.input?.description || it.input?.subagent_type || t("子 agent")), body: String(it.input?.prompt ?? ""), ts: it.ts });
  }
  return found.filter((t) => !done.has(t.id));
}

// 后台任务的输出文件边跑边追加,2s 拉一次。折叠着的 bar 和展开的弹窗都要读,抽出来共用。
function useTailFile(path?: string) {
  const [out, setOut] = useState<string | null>(null);
  useEffect(() => {
    if (!path) { setOut(null); return; }
    let alive = true;
    const pull = () => invoke<string>("read_file", { path })
      .then((c) => { if (alive) setOut(c); }).catch(() => { if (alive) setOut(null); });
    pull();
    const timer = window.setInterval(pull, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [path]);
  return out;
}

// docker 拉镜像的进度。后台任务的 stdout 不是 TTY,docker 这时不画进度条,改成一行一条状态:
//   docker pull          "<层id> Pulling fs layer" / "<层id> Pull complete"      —— 只有层状态,没有字节数
//   docker compose pull  上面这些之外,还多 "<层id> Downloading 12.3MB"(累计值,会往上涨)
//                        和镜像级的 "Image redis:7 Pulling" / "Image redis:7 Pulled"
// 所以裸 docker pull 只能给出层进度,compose 才能连已下载字节一起给。两者都拿不到「总大小」——
// docker 压根没打印过分母,所以只报已下载多少,不报百分比(编不出来的数就别编)。
const BYTE_UNIT: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };
type DockerStat = { layers: number; layersDone: number; imgs: number; imgsDone: number; bytes: number };
function dockerStat(out: string): DockerStat | null {
  const layers = new Set<string>(), done = new Set<string>();
  const bytes = new Map<string, number>();
  let imgs = 0, imgsDone = 0;
  for (const ln of out.split("\n")) {
    let m;
    // 冒号是可选的:裸 docker pull 写 "58dee6a49ef1: Pulling fs layer",compose 写 " 58dee6a49ef1 Pulling fs layer 0B"
    if ((m = ln.match(/^\s*([0-9a-f]{8,}):?\s+Pulling fs layer/))) layers.add(m[1]);
    else if ((m = ln.match(/^\s*([0-9a-f]{8,}):?\s+Pull complete/))) { layers.add(m[1]); done.add(m[1]); }
    else if ((m = ln.match(/^\s*([0-9a-f]{8,}):?\s+Downloading\s+([\d.]+)\s*([kKMG]?B)\b/))) {
      layers.add(m[1]);
      // 每层报的是该层已下载的累计量,层下完后会跳回 "Download complete 0B" —— 取见过的最大值,别被那个 0 抹掉
      bytes.set(m[1], Math.max(bytes.get(m[1]) ?? 0, parseFloat(m[2]) * (BYTE_UNIT[m[3]] ?? 1)));
    }
    else if (/^\s*Image\s.*\sPulling\s*$/.test(ln)) imgs++;
    else if (/^\s*Image\s.*\sPulled\s*$/.test(ln)) imgsDone++;
  }
  if (!layers.size && !imgs) return null;   // 不是 docker 的输出,交给"显示最后一行"那条路
  let total = 0;
  for (const v of bytes.values()) total += v;
  return { layers: layers.size, layersDone: done.size, imgs, imgsDone, bytes: total };
}
const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1e3)}kB`;

// 弹窗里的一条后台任务。shell 任务的输出文件边跑边追加,2s 拉一次当进度看;
// 子 agent 的产物不落在这个路径下(只能拿到 agentId),只展示它领到的任务描述。
function BgTaskItem({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const out = useTailFile(task.out);
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = preRef.current; if (el) el.scrollTop = el.scrollHeight; }, [out]); // 贴着最新一行,和终端一样
  const lines = out ? out.replace(/\s+$/, "").split("\n") : [];
  return <div className="bgt-item">
    <div className="bgt-item-head">
      <span className={`bgt-badge ${task.kind}`}>{task.kind === "shell" ? t("命令") : t("子 agent")}</span>
      <b title={task.title}>{task.title}</b>
      {task.out && <span className="muted">{t("{{n}} 行输出", { n: lines.length })}</span>}
    </div>
    {task.body && <pre className="bgt-cmd">{task.body}</pre>}
    {task.out && <pre className="bgt-out" ref={preRef}>{lines.slice(-200).join("\n") || t("（还没有输出）")}</pre>}
  </div>;
}
// 气泡底部那条"后台任务运行中":点开看每个任务的内容和实时输出
function BgTasksBar({ tasks }: { tasks: BgTask[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // 弹窗内当前查看的任务 tab
  useEffect(() => { if (active >= tasks.length) setActive(0); }, [tasks.length, active]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = tasks[active];
  // 实时计时。没它的时候这条只有一个脉冲点,而气泡底下还挂着已结算那轮的"本轮耗时",
  // 一个几分钟的构建看着就像卡死了 —— 其实电平一清(SDK 的 background_tasks_changed)0.2s 内就续跑。
  const now = useNow(true);
  const since = Math.min(...tasks.map((t) => t.ts ?? now));
  // 折叠着也读输出,把进度顶到 bar 上 —— 拉几个 G 的镜像时,只有一个"已跑 3min"跟卡死没区别。
  // ponytail: 只跟第一个有输出文件的 shell 任务。同时跑两条命令时另一条的进度得点开看,
  //           合并多路进度要嘛串味要嘛占两行,不值当。
  const lead = tasks.find((k) => k.out);
  const out = useTailFile(lead?.out);
  const stat = useMemo(() => (out ? dockerStat(out) : null), [out]);
  // 速度靠两次轮询之间的字节差。docker 不给总大小,所以只有速率没有百分比。
  const prev = useRef<{ b: number; ms: number } | null>(null);
  const [speed, setSpeed] = useState(0);
  useEffect(() => {
    if (!stat) { prev.current = null; setSpeed(0); return; }
    const ms = Date.now(), p = prev.current;
    if (p && ms > p.ms) setSpeed(Math.max(0, ((stat.bytes - p.b) / (ms - p.ms)) * 1000));
    prev.current = { b: stat.bytes, ms };
  }, [stat]);
  const summary = useMemo(() => {
    if (stat) {
      const parts: string[] = [];
      if (stat.imgs) parts.push(t("镜像 {{a}}/{{b}}", { a: stat.imgsDone, b: stat.imgs }));
      if (stat.layers) parts.push(t("层 {{a}}/{{b}}", { a: stat.layersDone, b: stat.layers }));
      if (stat.bytes) parts.push(fmtBytes(stat.bytes));
      if (speed > 1e3) parts.push(`${fmtBytes(speed)}/s`);
      return parts.join(" · ");
    }
    // 不是 docker 就退回最后一行非空输出:不用写解析器,任何命令都有效
    const last = out?.replace(/\s+$/, "").split("\n").filter((l) => l.trim()).pop();
    return last ? last.slice(-120) : "";
  }, [stat, speed, out, t]);
  return <>
    <button className="bubble-bg-wait" onClick={() => { setOpen(true); setActive(0); }} title={t("查看后台任务内容与实时输出")}>
      <span className="bg-wait-l1">
        <i className="bg-wait-dot" />{t("后台任务运行中")}{tasks.length > 1 ? t(" · {{n}} 个", { n: tasks.length }) : ""}{t(" · 已跑 ")}<span className="bgt-dur">{fmtDurationSec(now - since)}</span>{t("，完成后会自动继续")}
        <ChevronRight size={13} className="bgt-chevron" />
      </span>
      {summary && <span className="bg-wait-l2" title={summary}>{summary}</span>}
    </button>
    {open && cur && createPortal(
      <div className="commit-modal-overlay" onMouseDown={() => setOpen(false)}>
        <div className="commit-modal bgt-modal" onMouseDown={(e) => e.stopPropagation()}>
          <div className="commit-modal-title"><Loader2 size={15} className="ico-spin" /> {t("后台任务（{{n}}）", { n: tasks.length })}</div>
          <div className="bgt-tabs">
            {tasks.map((t, i) => (
              <button key={t.id} className={`bgt-tab ${i === active ? "cur" : ""}`} title={t.title} onClick={() => setActive(i)}>
                <span className={`bgt-tab-dot ${t.kind}`} />
                <span className="bgt-tab-title">{t.title}</span>
              </button>
            ))}
          </div>
          <div className="bgt-pane"><BgTaskItem key={cur.id} task={cur} /></div>
          <div className="commit-modal-actions"><button type="button" onClick={() => setOpen(false)}>{t("关闭")}</button></div>
        </div>
      </div>, document.body)}
  </>;
}

// 本轮用到的 Skills / MCP 标签。active* = 此刻正在跑的(工具还没回结果),加 .active 闪烁。
export function SkillMcpTags({ skills, mcps, activeSkills, activeMcps }: { skills: string[]; mcps: string[]; activeSkills?: Set<string>; activeMcps?: Set<string> }) {
  const { t } = useTranslation();
  return <div className="skill-mcp-tags">
    {skills.map((s) => <span key={`s-${s}`} className={`smtag smtag-skill ${activeSkills?.has(s) ? "active" : ""}`} title={`Skill: ${s}${activeSkills?.has(s) ? t("(运行中)") : ""}`}><Puzzle size={12} /> {s}</span>)}
    {mcps.map((m) => <span key={`m-${m}`} className={`smtag smtag-mcp ${activeMcps?.has(m) ? "active" : ""}`} title={`MCP: ${m}${activeMcps?.has(m) ? t("(运行中)") : ""}`}><Plug size={12} /> {m}</span>)}
  </div>;
}

// 从一回合的工具调用里提取用到的 Skills 和 MCP 服务器。
// 顺序 = 首次使用顺序(Set 保序);active* = 有工具还没回结果 = 此刻正在跑,给闪烁用。
export function usedSkillsMcp(items: TimelineItem[]) {
  const skills = new Set<string>(), mcps = new Set<string>();
  const activeSkills = new Set<string>(), activeMcps = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const n = it.name || "";
    const running = it.result === undefined; // 工具还没回结果 = 正在跑
    if (n === "Skill" || n === "SlashCommand") {
      const s = (it.input?.skill ?? it.input?.command ?? it.input?.name);
      if (s) { const name = String(s).replace(/^\//, "").split(/\s+/)[0]; skills.add(name); if (running) activeSkills.add(name); }
    } else if (n.startsWith("mcp__")) {
      const server = n.split("__")[1];
      if (server) { mcps.add(server); if (running) activeMcps.add(server); }
    }
  }
  return { skills: [...skills], mcps: [...mcps], activeSkills, activeMcps };
}

// 记忆引用:agent 用 Read 读了 ~/.claude/projects/<项目>/memory/ 下的某条记忆文件 = 在本轮回复里"引用"了它。
// MEMORY.md 是索引(每次都会翻),不算引用某条具体记忆,排除掉。
const MEMORY_FILE_RE = /\/memory\/([^/]+\.md)$/i;
function memoryFileOf(path: unknown): string | null {
  if (typeof path !== "string" || !path.includes(".claude")) return null;
  const m = MEMORY_FILE_RE.exec(path);
  if (!m || /^MEMORY\.md$/i.test(m[1])) return null;
  return m[1];
}
// 工具结果内容可能是字符串、{text}、或 [{type:"text",text}] 数组,统一抽成纯文本。
function toolResultText(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("");
  if (typeof result === "object") return result.text ?? "";
  return String(result);
}
export type MemAction = "read" | "write" | "edit";
export interface MemRef { file: string; title: string; body: string; action: MemAction }
// 一轮里对记忆文件的所有动作:Read=引用,Write/Edit=更新。同一文件按"更新 > 引用"合并(既读又写算更新)。
export function usedMemories(items: TimelineItem[]): MemRef[] {
  const map = new Map<string, MemRef>();
  const rank: Record<MemAction, number> = { read: 0, write: 1, edit: 1 };
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const action: MemAction | null = it.name === "Read" ? "read"
      : it.name === "Write" ? "write"
      : it.name === "Edit" || it.name === "MultiEdit" ? "edit" : null;
    if (!action) continue;
    const file = memoryFileOf(it.input?.file_path);
    if (!file) continue;
    const raw = action === "read" ? stripLineNums(toolResultText(it.result)).trim()
      : action === "write" ? String(it.input?.content ?? "").trim() : ""; // edit 拿不到全文,留空,点开去编辑器看
    const { title, body } = cleanMemory(raw, file); // 剥 system-reminder + frontmatter,顺带取标题

    const prev = map.get(file);
    if (!prev || rank[action] >= rank[prev.action]) {
      map.set(file, { file, title: title || prev?.title || file, body: body || prev?.body || "", action });
    }
  }
  return [...map.values()];
}

// 打开记忆中心并定位到某条(App 监听 cc-open-memory)
const jumpToMemory = (file: string) => window.dispatchEvent(new CustomEvent("cc-open-memory", { detail: { file } }));

// 气泡里的记忆动作条:kind=ref → "N 条记忆引用";kind=update → "更新了 N 条记忆"。
// 点条 → 弹窗逐条显示(不再 inline 展开:inline 撑高气泡、折叠又收不回来);条目标题可点 → 跳记忆中心高亮定位。
function MemoryRefs({ memories, kind, cwd }: { memories: MemRef[]; kind: "ref" | "update"; cwd: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const md = makeMdComponents(cwd);
  const label = kind === "update" ? t("更新了 {{n}} 条记忆", { n: memories.length }) : t("{{n}} 条记忆引用", { n: memories.length });
  return (
    <div className={`mem-refs ${kind === "update" ? "mem-update" : ""}`}>
      <button className="mem-refs-toggle" onClick={() => setOpen(true)} title={kind === "update" ? t("本轮回复新增/更新的记忆") : t("本轮回复引用到的记忆")}>
        <ChevronRight size={13} /> <Brain size={13} /> {label}
      </button>
      {open && createPortal(
        <div className="commit-modal-overlay" onMouseDown={() => setOpen(false)}>
          <div className="commit-modal mem-refs-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="commit-modal-title mem-refs-head"><Brain size={15} /> {label}</div>
            <div className="mem-refs-list">
              {memories.map((m) => (
                <article key={m.file} className="mem-ref-item">
                  <button className="mem-ref-title" title={t("在记忆中心查看")} onClick={() => { jumpToMemory(m.file); setOpen(false); }}>
                    <span className="mem-ref-name">{m.title}</span>
                    <ChevronRight size={12} />
                  </button>
                  <div className="mem-ref-file" title={m.file}>{m.file}</div>
                  {m.body
                    ? <div className="mem-ref-body md"><Markdown remarkPlugins={[remarkGfm]} components={md}>{m.body}</Markdown></div>
                    : <div className="mem-ref-none">{t("这条本轮被改写过，正文到记忆中心看")}</div>}
                </article>
              ))}
            </div>
            <div className="commit-modal-actions">
              <button type="button" onMouseDown={(e) => { e.preventDefault(); setOpen(false); }}>{t("关闭")}</button>
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}

// 一整回合的正文:和气泡里 segments 的取法一致(正文常被工具调用切成好几段 agent_text)
const turnText = (items: TimelineItem[]) =>
  items.filter((it) => it.kind === "agent_text" && it.text.trim()).map((it) => (it as any).text.trim()).join("\n\n");

// agent 按系统提示(sidecar 的 NEXT_STEPS_INSTRUCTION)在回复末尾留的一行「本轮建议：A | B」。
// 这行照常显示在正文里,这里只是把它再解析成一排可点的快捷指令 —— 不改 timeline 里的 text,
// 免得撞上 agent_text_dedup 按 text 全等回查那套去重(改了文本气泡会出现两遍)。
// 标签两侧各留一处 `\**`:`**本轮建议**：A | B` 这种(强调只包标签、冒号在外)也要认,
// 少认这一种整排快捷指令就不出来。与 sidecar 的 SUMMARY_RE 同一套写法。
const NEXT_RE = /^[\s>*#`\-]*本轮建议\**\s*[：:]\**\s*(.+?)\s*\**$/;
// 「本轮小结」那行是给 commit 弹窗汇总用的(sidecar 从会话日志里读),对用户是噪音 —— 渲染时抹掉。
// 只改渲染用的字符串,timeline 里的 text 原样保留:sidecar 的汇总照常工作,前端去重也不受影响。
const SUMMARY_LINE_RE = /^[\s>*#`\-]*本轮小结\**\s*[：:]/;
const stripSummary = (text: string) => text.split("\n").filter((l) => !SUMMARY_LINE_RE.test(l)).join("\n").trim();
function nextSteps(items: TimelineItem[]): string[] {
  const lines = turnText(items).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(NEXT_RE);
    if (m) return m[1].split(/[|｜]/).map((s) => s.replace(/[*`]/g, "").trim()).filter(Boolean).slice(0, 3);
  }
  return [];
}

// 今天的只给时分;昨天及更早补日期(跨年再补年份)—— 长会话翻上去全是 "12:47",
// 分不清是刚才还是上周。日期只在需要时出现,今天的消息不平白变长。
function fmtClock(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (i18n.language === "zh") {
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
  }
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}

// 正在工作气泡里的动态副标题:显示 agent 最近一次动静 —— 流式文本的最新一行、
// 或正在跑的工具/终端命令。让"Agent 正在工作"能实时反映此刻在干嘛。
// 把线性时间线按"用户消息"切成回合:每条用户消息独立成组,其后到下一条用户消息之间的
// 所有 agent 动作(请求执行、回复、结果…)归到一个 agent 组,渲染时包进一个气泡。
type Turn = { user: TimelineItem } | { agent: TimelineItem[] } | { solo: TimelineItem };
export function groupTurns(items: TimelineItem[]): Turn[] {
  const groups: Turn[] = [];
  // agent 的当前回合:只有新的用户消息才算结束。中间插进来的终端命令(commit/push)、系统提示
  // 单独成组显示,但不能把这一轮切成两半 —— 切了的话,正在跑的那组就不再是"最后一组",
  // 气泡从"进行中"掉成一张还没内容的完成卡(看着像消息消失了),等 agent 再出声才另起一张。
  let open: Extract<Turn, { agent: TimelineItem[] }> | null = null;
  for (const item of items) {
    if (item.kind === "user") { groups.push({ user: item }); open = null; continue; }
    // 终端命令(InfoPanel git 按钮 / ! shell)是用户主动跑的,系统提示(清空上下文/切模型/git 对比)、
    // 压缩上下文(/compact)也都不是 agent 的"回复",各自独立成组;否则会被并进 agent 卡里 ——
    // 看不见正文,副标题还误显示"正在思考…"(卡片只认 agent 动作)。compact 自带进度/结果卡,单独渲染。
    if (item.kind === "terminal" || item.kind === "system" || item.kind === "compact") { groups.push({ solo: item }); continue; }
    if (open) { open.agent.push(item); continue; }
    // 落单的 result(压缩、控制指令等静默轮次结束时也会发一条,前面没有任何 agent 动作)不能自成一张卡:
    // 那样会渲染出一张空的"Claude 的回复 / 正在思考…"僵尸气泡,永远停在那。丢掉即可,它本就没有正文可展示。
    if (item.kind === "result") continue;
    open = { agent: [item] };
    groups.push(open);
  }
  return groups;
}

// 把一回合内所有 SDK result 聚合成单条结算:总时长(prompt 到收尾的墙上时间)+ 累计 token。
// 全 0 token 且非中断/报错 = 静默回合(压缩、控制指令等),返回 null 让调用方不渲染。
function aggregateRound(items: TimelineItem[], startTs: number): (TimelineItem & { kind: "result" }) | null {
  const results = items.filter((it): it is TimelineItem & { kind: "result" } => it.kind === "result");
  if (!results.length) return null;
  const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, cache_read_output_tokens: 0, cache_creation_output_tokens: 0 };
  let costUsd = 0, aborted = false, isError = false;
  for (const r of results) {
    const u = r.usage || {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_output_tokens += u.cache_read_output_tokens ?? 0;
    usage.cache_creation_output_tokens += u.cache_creation_output_tokens ?? 0;
    costUsd += r.costUsd ?? 0;
    if (r.aborted) aborted = true;
    if (r.isError) isError = true;
  }
  const totalIn = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (totalIn + usage.output_tokens === 0 && !aborted && !isError) return null;
  const lastTs = results[results.length - 1].ts;
  // 墙上时间(prompt 到收尾)对实时会话准;回放历史时全部 ts 都是回放瞬间,差值≈0,
  // 退回累加各 result 的 duration_ms(日志里保留了真实耗时)。取两者较大即可两头兼容。
  const wall = startTs ? Math.max(0, lastTs - startTs) : 0;
  const sumDur = results.reduce((a, r) => a + (r.durationMs || 0), 0);
  const waitMs = permWaitMs(items, lastTs); // 扣掉等用户选择/授权的空等时间
  const durationMs = Math.max(0, Math.max(wall, sumDur) - waitMs);
  return { kind: "result", costUsd, durationMs, usage, isError, aborted, ts: lastTs };
}

const TODO_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]; // todo 系记账工具,不算"在干活"

// 右栏活流:把本回合的正文 + 每个工具动作的完整内容(命令 + 输出、改了哪些代码的增删行)按时间顺序
// 抹平成带样式的多行日志。最新活动从底部冒出、把旧行往上挤;尾部封顶防长会话 DOM 爆炸,max-height 再裁一层。
type FeedLine = { t: string; c?: string }; // c: head/add/del/out/cmd → 上色
// 顶栏分支行那排按钮走 btnPress(mousedown 语义,见 lib/utils):click 在 WKWebView 里会被吞掉第一次。
const shortPath = (p?: string) => (p || "").replace(/^\/Users\/[^/]+/, "~");
function workFeed(items: TimelineItem[]): FeedLine[] {
  const out: FeedLine[] = [];
  // 单块正文按行拆。先按尾部截一刀再拆:整份 out 最后也只留 slice(-200),
  // 而浏览器测试的一条 take_snapshot 结果能有 5 万字符,整份拆成行等于每次都白造上千个字符串再扔掉。
  const body = (s: any): string[] => {
    const str = String(s ?? "").replace(/\s+$/, "");
    // 多截一点(200 行 × 保守 200 字符)再按行切,切完丢掉可能被拦腰截断的首行
    const cut = str.length > 40_000 ? str.slice(-40_000).split("\n").slice(1) : str.split("\n");
    return cut.length > 200 ? cut.slice(-200) : cut;
  };
  for (const it of items) {
    if (it.kind === "agent_text" && it.text?.trim()) {
      for (const l of it.text.trim().split("\n")) { if (!SUMMARY_LINE_RE.test(l)) out.push({ t: l }); }
    } else if (it.kind === "tool" && !TODO_TOOLS.includes(it.name)) {
      const run = it.result === undefined, pre = run ? "▶ " : "";
      const file = it.input?.file_path, inp = it.input ?? {};
      if (it.name === "Edit" && inp.old_string != null) {
        out.push({ t: `${pre}Edit ${shortPath(file)}`, c: "head" });
        for (const l of body(inp.old_string)) out.push({ t: `- ${l}`, c: "del" });
        for (const l of body(inp.new_string)) out.push({ t: `+ ${l}`, c: "add" });
      } else if (it.name === "Write" && inp.content != null) {
        out.push({ t: `${pre}Write ${shortPath(file)}`, c: "head" });
        for (const l of body(inp.content)) out.push({ t: `+ ${l}`, c: "add" });
      } else if (it.name === "Read") {
        const n = typeof it.result === "string" ? it.result.split("\n").length : 0;
        out.push({ t: `${pre}Read ${shortPath(file)}${n ? ` · ${i18n.t("{{n}} 行", { n })}` : ""}`, c: "head" });
      } else {
        const name = it.name === "Task" ? i18n.t("子 agent") : it.name;
        const detail = summarizeInput(it.name, it.input);
        const cmd = detail.split("\n");
        out.push({ t: `${pre}${name}${cmd[0] ? " " + cmd[0] : ""}`, c: "head" });
        for (const l of cmd.slice(1)) out.push({ t: l, c: "cmd" }); // 多行命令的后续行
        if (typeof it.result === "string" && it.result.trim()) for (const l of body(it.result)) out.push({ t: l, c: "out" });
      }
    } else if (it.kind === "terminal") {
      out.push({ t: `$ ${it.command}`, c: "head" });
      if (it.output.trim()) for (const l of body(it.output)) out.push({ t: l, c: "out" });
    }
  }
  return out.slice(-200); // 尾部封顶
}

// 阶段清单:重放本回合的 TodoWrite / TaskCreate / TaskUpdate,得到最新任务快照。
// TodoWrite 的 input.todos 是整份快照,直接覆盖;TaskCreate/Update 增量重放(SDK 的 taskId 从 1 起顺序分配)。
type TodoRow = { content: string; status: string };
function latestTodos(items: TimelineItem[], t: (key: string) => string): TodoRow[] {
  let todos: TodoRow[] = [];
  const idToIdx = new Map<string, number>();
  let seq = 0;
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const input = it.input ?? {};
    if (it.name === "TodoWrite" && Array.isArray(input.todos)) {
      todos = input.todos.map((t: any) => ({ content: String(t.content ?? ""), status: String(t.status ?? "pending") }));
      idToIdx.clear(); seq = 0;
    } else if (it.name === "TaskCreate") {
      todos.push({ content: String(input.subject ?? input.description ?? "").trim() || t("任务"), status: String(input.status ?? "pending") });
      idToIdx.set(String(input.taskId ?? ++seq), todos.length - 1);
    } else if (it.name === "TaskUpdate" && input.taskId != null) {
      const idx = idToIdx.get(String(input.taskId));
      if (idx !== undefined && todos[idx]) {
        if (input.status) todos[idx].status = String(input.status);
        const c = String(input.subject ?? "").trim();
        if (c) todos[idx].content = c;
      }
    }
  }
  return todos;
}

// 活流:多行日志(读写文件/命令/正文),底部对齐。气泡高度随行数从 min 长到 max 后封顶,
// 之后最新一行从底部冒出、把旧行往上挤出视口,顶部 mask 渐隐 —— 快速刷屏,像 agent 在飞速干活。
// memo 起来:耗时那行每 200ms 变一次,不隔开的话这 200 个 div 跟着每秒重建 5 次,纯白干。
const WorkStream = memo(function WorkStream({ feed }: { feed: FeedLine[] }) {
  const { t } = useTranslation();
  return (
    <div className={`work-stream ${feed.length > 10 ? "tall" : ""}`}>
      {feed.length
        ? feed.map((ln, i) => <div key={i} className={`ws-line ${ln.c ? "ws-" + ln.c : ""} ${i === feed.length - 1 ? "cur" : ""}`} title={ln.t}>{ln.t}</div>)
        : <div className="ws-line cur">{t("正在思考…")}</div>}
    </div>
  );
});

// 运行中气泡主体:头部(状态 + todo 进度条)/ 双栏(左 1/4=阶段清单,右 3/4=红框活流)/ 耗时。
// 拆分了步骤(有 todo)→ 左栏步骤 + 右栏活流;没拆步骤 → 单栏,整栏只显红框活流。
function WorkBody({ items, elapsed, liveInput }: { items: TimelineItem[]; elapsed: number; liveInput?: number }) {
  const { t } = useTranslation();
  // 这两个必须 memo:上面 useNow(running) 每 200ms 就 setState 一次(为了让"本轮耗时"实时走),
  // 不 memo 的话每秒 5 次把本回合所有工具结果重新扫一遍 —— 浏览器测试那种单回合近 10 万字符的结果,
  // 光 workFeed 一次就接近 1ms,还全是转手就扔的字符串。items 只在时间线真变了才换身份,正好当依赖。
  const todos = useMemo(() => latestTodos(items, t), [items, t]);
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
  const feed = useMemo(() => workFeed(items), [items]); // 红框活流:正文行 + 读写/命令动作,按序抹平成日志行
  const hasSteps = todos.length > 0;
  return (
    <>
      <div className="work-head">
        <b>{t("Agent 正在工作")}<span className="dots-anim"><i>.</i><i>.</i><i>.</i></span></b>
        {hasSteps && (
          <span className="work-progress">
            <span className="wp-track"><span className="wp-fill" style={{ width: `${pct}%` }} /></span>
            <span className="wp-num">{done}/{todos.length}</span>
          </span>
        )}
      </div>
      <div className={`work-cols ${hasSteps ? "" : "single"}`}>
        {hasSteps && (
          <div className="work-left">
            {todos.map((t, i) => <div key={i} className={`todo-row ${t.status}`} title={t.content}><span className="todo-ico" />{t.content}</div>)}
          </div>
        )}
        <div className="work-right">
          <WorkStream feed={feed} />
        </div>
      </div>
      <small className="work-meta">{t("本轮耗时 {{d}} · 输入 {{n}} tokens", { d: fmtDurationSec(elapsed), n: fmtTok(liveInput) })}</small>
    </>
  );
}

function workSummary(timeline: TimelineItem[], t: (key: string) => string) {
  const last = [...timeline].reverse().find((item) =>
    (item.kind === "agent_text" && item.text?.trim()) || item.kind === "tool" || item.kind === "terminal");
  if (last?.kind === "agent_text") {
    const lines = last.text.trim().split("\n").filter((l) => l.trim());
    return lines[lines.length - 1]?.slice(0, 80) ?? t("正在思考…");
  }
  if (last?.kind === "tool") return `${last.result !== undefined ? t("已执行") : t("正在执行")} ${last.name} ${summarizeInput(last.name, last.input)}`.trim().slice(0, 80);
  if (last?.kind === "terminal") return `${last.pending ? t("运行命令") : t("已运行")} ${last.command}`.slice(0, 80);
  return t("正在思考…");
}

function SessionStats({ session, startedAt }: { session: Session; startedAt?: number }) {
  const { t } = useTranslation();
  const started = startedAt || session.timeline[0]?.ts;
  const duration = started ? Math.max(0, Date.now() - started) : 0;
  // hover 拆开总数:新输入 / 缓存写 / 缓存命中 / 输出。推理(thinking)SDK 不单列,归在输出里
  const cw = session.cacheWriteTokens ?? 0, cr = session.cacheReadTokens ?? 0;
  const fresh = Math.max(0, session.inputTokens - cw - cr);
  const detail = [
    t("输入 {{n}}(新)", { n: fresh.toLocaleString() }),
    t("缓存写入 {{n}}", { n: cw.toLocaleString() }),
    t("缓存命中 {{n}}", { n: cr.toLocaleString() }),
    t("输出 {{n}}(含思考)", { n: session.outputTokens.toLocaleString() }),
    t("合计 {{n}}", { n: (session.inputTokens + session.outputTokens).toLocaleString() }),
  ].join("\n");
  return <div className="session-stats"><span title={detail}>{fmtTok(session.inputTokens + session.outputTokens)} tokens</span><span>{fmtDurationCoarse(duration)}</span></div>;
}

// 终端一条 = 两个气泡:① 用户发的 shell 命令(用户头像 + ! 前缀)② 电脑回的日志(本地/SSH 电脑头像)
function TermRows({ item, cwd }: { item: Extract<TimelineItem, { kind: "terminal" }>; cwd: string }) {
  const { t } = useTranslation();
  // item.cwd 兜底成会话当前目录:sidecar 曾在 SSH 断开后发出不带 cwd 的 terminal_result
  // (那边已修),但坏数据一旦进了 timeline 就留在内存里 —— 裸 .startsWith 会让错误边界吃掉整页。
  const itemCwd = item.cwd || cwd;
  const ssh = !itemCwd.startsWith("/"); // SSH 的 cwd 是 "user@host:path",本地是绝对路径
  const shortCwd = itemCwd.replace(/^\/Users\/[^/]+/, "~");
  const hasOut = item.output.trim().length > 0;
  const host = ssh ? itemCwd.split(":")[0] : t("本地电脑");
  return (
    <>
      <div className="msg-row msg-row-user">
        <UserAvatar />
        <div className="msg-col">
          <div className="msg-name">{getUserName() || t("我")}</div>
          <div className="line line-user bubble term-cmd-bubble">
            <div className="line-body term-cmd-body">
              <span className="term-bang" title={t("shell 命令")}>!</span>
              <span className="term-cmd-text">{item.command}</span>
              {!item.pending && item.exitCode !== 0 && <span className="term-ec"><X size={11} />{item.exitCode}</span>}
            </div>
          </div>
          {item.ts && <span className="bubble-time">{fmtClock(item.ts)}</span>}
        </div>
      </div>
      <div className="msg-row msg-row-term">
        <ComputerAvatar ssh={ssh} />
        <div className="msg-col">
          <div className="msg-name">{host}</div>
          <div className="line line-term-out bubble">
            <BubbleActs text={item.command + (hasOut ? "\n" + item.output : "")} />
            {item.pending ? <div className="term-cwd-line muted">{t("运行中…")}</div> : <>
              {hasOut && <TermOut text={item.output} cwd={cwd} />}
              {item.cwdChanged && <div className="term-cwd-line"><Folder size={13} /> {t("现在在 {{dir}}", { dir: shortCwd })}</div>}
              {!hasOut && !item.cwdChanged && item.exitCode === 0 && <div className="term-cwd-line muted">{t("（无输出）")}</div>}
            </>}
          </div>
        </div>
      </div>
    </>
  );
}

// 用 # 选的 skill 发送时被 expandSkillTags 拼成 "Use the X skill." 触发句放在正文最前(agent 靠它触发)。
// 回显时把这些行剥出来,不当正文露出机器味英文,改到气泡底部渲染成 skill tag。老消息同样适用(格式恒定)。
const SKILL_TRIGGER = /^Use the (.+?) skill\.$/;
function splitSkillTriggers(blocks: any[]): { skills: string[]; blocks: any[] } {
  const skills: string[] = [];
  const out = blocks.map((b) => {
    if (b?.type !== "text") return b;
    const lines = b.text.split("\n");
    let i = 0;
    for (; i < lines.length; i++) { const m = SKILL_TRIGGER.exec(lines[i].trim()); if (!m) break; skills.push(m[1]); }
    if (i === 0) return b;                       // 开头不是触发句,原样保留
    const rest = lines.slice(i).join("\n").trim();
    return rest ? { ...b, text: rest } : null;   // 剥掉触发行;整块都是触发句则丢弃
  }).filter(Boolean);
  return { skills, blocks: out };
}

// skill / 插件 / MCP 共用一个 tag:用户视角它们都是"我点名要用的那个能力",
// 分三种颜色只会逼人多记一套色码,信息量却是零。
function RefTag({ name, raw }: { name: string; raw: string }) {
  return <span className="ref-tag" title={raw}><Puzzle size={12} /> {name}</span>;
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 行首的 /xxx:插件 / MCP / skill 的 prompt 型命令(选中后原样留在正文里发出去)。
// 只认行首且后面不跟 / —— 免得把 /Users/tou/... 这类路径也收成 tag。
const SLASH_REF = /^\/([A-Za-z][\w:-]*)(?=[\s,.，。]|$)/;

// 正文里把 #skill 和行首 /command 就地渲染成 tag。names 来自被剥掉的 "Use the X skill."
// 触发句 —— 只认真正会被调用的那些,普通话题标签(#今天)保持纯文本。
// tag 之外的普通文本再过一遍 Linkify:自己发的消息里贴的路径/链接,与 agent 回复、终端输出一样能 hover 出操作菜单。
function RefText({ text, skills, cwd }: { text: string; skills: string[]; cwd: string }) {
  const out: ReactNode[] = [];
  let rest = text, k = 0;
  const plain = (s: string) => { if (s) out.push(<Linkify key={`p${k++}`} text={s} cwd={cwd} />); };
  const slash = SLASH_REF.exec(rest);
  if (slash) { out.push(<RefTag key={k++} name={slash[1]} raw={slash[0]} />); rest = rest.slice(slash[0].length); }
  if (skills.length) {
    const re = new RegExp(`#(${skills.map(reEsc).join("|")})(?=[\\s,.，。]|$)`, "g");
    let last = 0;
    for (const m of rest.matchAll(re)) {
      if (m.index > last) plain(rest.slice(last, m.index));
      out.push(<RefTag key={k++} name={m[1]} raw={m[0]} />);
      last = m.index + m[0].length;
    }
    rest = rest.slice(last);
  }
  plain(rest);
  return <>{out}</>;
}

function Item({ item, cwd, onPermission, onAgentClick, agentLabel }: { item: TimelineItem; cwd: string; onPermission: OnPermission; onAgentClick: () => void; agentLabel?: string }) {
  const { t } = useTranslation();
  const md = makeMdComponents(cwd);
  switch (item.kind) {
    case "user": {
      // 发出后与输入框一致:文本 + 图片标签内联混排(图片仍是标签,hover 看缩略图)
      let imgN = 0;
      const { skills: usedSkills, blocks: shownBlocks } = splitSkillTriggers(item.blocks);
      return (
        <div className="line line-user bubble">
          <div className="line-body user-msg">
            {shownBlocks.map((b, i) =>
              b.type === "text" ? <span key={i} className="user-text"><RefText text={b.text} skills={usedSkills} cwd={cwd} /></span>
              // 刚发的图带内联 base64;历史里的只有 blob 引用,hover/点击时才去 sidecar 取
              : b.type === "image" ? <ImgTag key={i} label={t("图片{{n}}", { n: ++imgN })}
                  src={b.source.type === "base64" ? `data:${b.source.media_type};base64,${b.source.data}` : undefined}
                  blob={b.source.type === "cc_blob" ? { key: b.source.key, mediaType: b.source.media_type } : undefined} />
              : null)}
          </div>
          {/* 时间 + 输入 token 同在气泡内 meta 行,时间在左 */}
          <div className="bubble-meta">
            {item.ts && <span className="bubble-time">{fmtClock(item.ts)}</span>}
            {item.tokensInUncached !== undefined && <span title={t("本条消息未命中缓存的输入 token")}>{t("输入 {{n}} tokens", { n: fmtTok(item.tokensInUncached) })}</span>}
          </div>
        </div>
      );
    }
    case "agent_text":
      return (
        <button className={`line line-agent agent-message ${item.phase === "progress" ? "agent-progress" : "agent-final"}`} onClick={onAgentClick}>
          <span className="gutter gutter-agent">{item.phase === "progress" ? "↳" : "✦"}</span>
          <div className="line-body md agent-copy">
            {item.phase === "progress" && <div className="agent-phase">{t("执行说明")}</div>}
            {item.phase !== "progress" && <div className="agent-phase">{agentLabel || t("回复")}</div>}
            <Markdown remarkPlugins={[remarkGfm]} components={md}>{item.text || (item.streaming ? "▍" : "")}</Markdown>
            {item.streaming && <span className="caret">▍</span>}
          </div>
          {item.tokensOut !== undefined && <span className="tok-tag" title={t("本条回复输出 token")}><ArrowDown size={11} />{fmtTok(item.tokensOut)}</span>}
        </button>
      );
    case "tool":
      return (
        <div className="line line-tool execution-item">
          <span className="gutter gutter-tool">⎿</span>
          <details className="tool-card">
            <summary>
              <Wrench size={13} /> {item.name}
              <span className="muted"> {summarizeInput(item.name, item.input)}</span>
              {item.result !== undefined && (item.isError ? <X size={13} className="tool-stat err" /> : <Check size={13} className="tool-stat ok" />)}
            </summary>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
            {item.result !== undefined && <pre className="tool-result">{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>}
          </details>
        </div>
      );
    case "permission":
      // AskUserQuestion:渲染成结构化问答卡,支持键盘/点击选择
      if (item.toolName === "AskUserQuestion" && Array.isArray(item.input?.questions)) {
        return (
          <div className="line line-perm">
            <span className="gutter gutter-perm"><CircleHelp size={15} /></span>
            <AskQuestionCard item={item} onSubmit={(msg) => onPermission(item.requestId, "deny", msg)} onCancel={() => onPermission(item.requestId, "deny", t("用户跳过了此问题,未作选择。"))} />
          </div>
        );
      }
      return (
        <div className="line line-perm">
          <span className="gutter gutter-perm"><Lock size={14} /></span>
          <PermissionCard item={item} cwd={cwd} onPermission={onPermission} />
        </div>
      );
    case "terminal": {
      const shortCwd = (item.cwd || cwd).replace(/^\/Users\/[^/]+/, "~"); // 同 TermRows:cwd 可能缺失
      const hasOut = item.output.trim().length > 0;
      return (
        <div className="line line-term">
          <span className="gutter gutter-term">$</span>
          <div className="term-card">
            {/* 悬停显形的复制按钮:一键复制命令 + 输出;文本本身也可鼠标框选 */}
            <BubbleActs text={item.command + (hasOut ? "\n" + item.output : "")} />
            <div className="term-cmd" title={item.cwd}>{item.command}{item.exitCode !== 0 && <span className="term-ec"> <X size={11} />{item.exitCode}</span>}</div>
            {item.pending ? <div className="term-cwd-line muted">{t("运行中…")}</div> : <>
              {hasOut && <TermOut text={item.output} cwd={cwd} />}
              {item.cwdChanged && <div className="term-cwd-line"><Folder size={13} /> {t("现在在 {{dir}}", { dir: shortCwd })}</div>}
              {!hasOut && !item.cwdChanged && item.exitCode === 0 && <div className="term-cwd-line muted">{t("（无输出）")}</div>}
            </>}
          </div>
        </div>
      );
    }
    case "system":
      return (
        <div className="line line-system">
          <span className="gutter gutter-system">ℹ</span>
          <div className="line-body sys-text">{item.text}</div>
        </div>
      );
    case "compact": {
      // 运行中的滚动进度条只保留输入框上方那条(.compact-bar);timeline 里不再重复显示,避免两条一起滚
      if (item.running) return null;
      // SDK 不报压缩百分比,只有开始/结束 —— 运行中用不定态动画,结束后用 token 数说明压掉了多少
      const suffix = (item.preTokens ? ` · ${fmtTok(item.preTokens)} → ${fmtTok(item.postTokens)} tokens` : "")
        + (item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "");
      const title = item.error ? t("压缩未成功：{{error}}", { error: item.error })
        : item.running ? (item.auto ? t("上下文将满,正在自动压缩…") : t("正在压缩上下文…"))
        : t("上下文已压缩{{suffix}}", { suffix });
      return (
        <div className="line line-compact">
          <span className="gutter gutter-compact">✻</span>
          <div className="compact-card">
            <div className={`compact-title ${item.error ? "err" : ""}`}>{title}</div>
            {item.running && <div className="compact-track"><div className="compact-fill" /></div>}
          </div>
        </div>
      );
    }
    case "result": {
      const inTok = (item.usage?.input_tokens ?? 0) + (item.usage?.cache_read_input_tokens ?? 0) + (item.usage?.cache_creation_input_tokens ?? 0);
      const outTok = item.usage?.output_tokens ?? 0;
      // 只有 cache_read 才是“命中”。cache_creation 是本轮新建缓存，有成本但并未命中缓存。
      const inCached = item.usage?.cache_read_input_tokens ?? 0;
      // 当前 Anthropic 协议通常只缓存输入；仍兼容未来或其他适配器上报的输出缓存字段。
      const outCached = (item.usage?.cache_read_output_tokens ?? 0) + (item.usage?.cache_creation_output_tokens ?? 0);
      const cacheLabel = (cached: number, total: number) => cached > 0 && total > 0 ? t("（缓存{{rate}}）", { rate: fmtCacheRate(cached / total) }) : "";
      // 用户按停止也走 error 路径,但那不是故障,不该显示成"本轮出错"
      const prefix = item.aborted ? t("用户终止，耗时") : item.isError ? t("本轮出错，耗时") : t("本轮耗时");
      return (
        <div className="line">
          <span className="gutter">&nbsp;</span>
          <span className={`result-meta ${item.aborted ? "aborted" : ""}`}>
            {prefix}{fmtDuration(item.durationMs)}{t("，token输入{{n}}", { n: fmtTok(inTok) })}{cacheLabel(inCached, inTok)}{t("，token输出{{n}}", { n: fmtTok(outTok) })}{cacheLabel(outCached, outTok)}
          </span>
        </div>
      );
    }
  }
}

function fmtCacheRate(ratio: number) {
  if (ratio >= 1) return "100%";
  const percent = Math.max(0, ratio * 100);
  // 接近 100% 时保留两位且向下截断，避免 99.999% 被四舍五入伪装成 100%。
  if (percent >= 99) return `${(Math.floor(percent * 100) / 100).toFixed(2)}%`;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}

// 图片标签:与输入框同款,hover 弹固定定位缩略图(不被时间线 overflow 裁剪),点击在独立窗口里看大图
function ImgTag({ src, blob, label }: { src?: string; blob?: { key: string; mediaType: string }; label: string }) {
  const { t } = useTranslation();
  // 缩略图水平居中对齐标签中心,上方放不下就翻到下方;portal 到 body + 高 z-index,
  // 逃出气泡的 transform/opacity 造出的层叠上下文,才能盖住所有元素、不被别的气泡压住。
  const [pv, setPv] = useState<{ left: number; top: number; below: boolean } | null>(null);
  // 历史图只有引用:hover 时才取 512px 缩略图(预览就这么大,取原图纯浪费),点击时才取原图。
  // fetchBlob 自带 promise 缓存,同一张图第二次 hover 直接命中,不再发请求。
  const [thumb, setThumb] = useState<string | null>(null);
  const preview = src ?? thumb;
  return (
    <span className="img-tag"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const below = r.top < 280; // 上方不够就翻到下方
        setPv({ left: r.left + r.width / 2, top: below ? r.bottom + 6 : r.top - 6, below });
        if (!src && blob && !thumb) fetchBlob(blob.key, blob.mediaType, false).then(setThumb);
      }}
      onMouseLeave={() => setPv(null)}
      // mousedown(而非 click):WKWebView 里看完大图关窗后主窗口刚拿回焦点,首个 click 会被"激活窗口"吞掉。
      // 和编辑器里的 onEditorMouseDown 保持一致,首次即到。
      onMouseDown={(e) => {
        e.preventDefault();
        if (src) { openImageWindow(src, label); return; }
        if (!blob) return;
        // 大图要现取,几 MB 的图有可感的等待 —— 先说一声,别像点了没反应
        toast(t("正在打开图片…"), "info", `blob:${blob.key}`);
        fetchBlob(blob.key, blob.mediaType, true).then((full) => {
          dismissToast(`blob:${blob.key}`);
          if (full) openImageWindow(full, label);
          else toast(t("图片已失效"), "error");
        });
      }}>
      <ImageIcon size={13} /> {label}
      {pv && preview && createPortal(
        <img className="img-preview-float" src={preview}
          style={{ left: pv.left, top: pv.top, transform: `translateX(-50%)${pv.below ? "" : " translateY(-100%)"}` }} />,
        document.body)}
    </span>
  );
}

// 普通权限卡(Bash 等):↑↓/←→ 选允许/拒绝、⏎ 确认、esc 拒绝,也可在下方输入框直接回复。
// SDK 可能会给同一次 Bash 请求多条可记住规则。它们共同描述当前这一次授权，
// 因此只提供一个“允许并记住全部”操作，避免用户误以为还需要逐条确认。
// 同一权限请求的所有 suggestion 由一次提交整合写入；每条 Bash 规则仍可在提交前调整。
// 三个操作竖向并列。有可记住规则时:允许并记住全部 / 允许 / 拒绝,且默认选中"记住";无则:允许 / 拒绝。↑↓ 选择、⏎ 确认、esc 拒绝。
export function PermissionCard({ item, cwd, onPermission }: {
  item: Extract<TimelineItem, { kind: "permission" }>;
  cwd: string;
  onPermission: OnPermission;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!item.decision) ref.current?.focus(); }, [item.decision]);
  const usable = uniqueRememberSuggestions(item.suggestions ?? [], item.input);
  const [contents, setContents] = useState<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    usable.forEach((s, i) => {
      if (s.type === "addRules") s.rules.forEach((rule, j) => {
        result[`${i}:${j}`] = defaultRuleContent(rule.toolName, rule.ruleContent, item.input);
      });
    });
    return result;
  });

  if (item.decision) {
    return (
      <div className="perm-card">
        <div>{t("agent 请求执行 {{tool}}", { tool: item.toolName })}</div>
        <pre><Linkify text={summarizeInput(item.toolName, item.input) || JSON.stringify(item.input)} cwd={cwd} /></pre>
        <div className="perm-decided">
          {item.answer ? <><MessageSquare size={13} /> {t("你回复了:{{answer}}", { answer: item.answer })}</> : item.decision === "allow" ? <><Check size={13} /> {t("你允许了此操作")}</> : <><Ban size={13} /> {t("你拒绝了此操作")}</>}
        </div>
        {item.remembered && <div className="perm-decided muted"><Pin size={13} /> {t("已记住:{{value}}", { value: item.remembered })}</div>}
      </div>
    );
  }
  const hasBlankRule = usable.some((s, i) => s.type === "addRules" && s.rules.some((_, j) => !contents[`${i}:${j}`]?.trim()));
  const apply = () => {
    if (hasBlankRule) return;
    const updates = usable.map((s, i): PermissionSuggestion => s.type !== "addRules" ? s : ({
      ...s,
      rules: s.rules.map((rule, j) => ({ ...rule, ruleContent: contents[`${i}:${j}`].trim() })),
    }));
    const rules = updates.flatMap((s) => s.type === "addRules" ? s.rules.map((r) => `${r.toolName}(${r.ruleContent})`) : [suggestionLabel(s) ?? ""]);
    onPermission(item.requestId, "allow", undefined, { updates, label: rules.join("；") });
  };
  // 有可记住规则时把"记住"排第一(choice 0,默认选中):[记住, 允许, 拒绝];无则 [允许, 拒绝]
  const hasR = usable.length > 0;
  const n = hasR ? 3 : 2;
  const act = (c: number) => {
    if (hasR) { if (c === 0) apply(); else if (c === 1) onPermission(item.requestId, "allow"); else onPermission(item.requestId, "deny"); }
    else { if (c === 0) onPermission(item.requestId, "allow"); else onPermission(item.requestId, "deny"); }
  };
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setChoice((c) => (c + n - 1) % n); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setChoice((c) => (c + 1) % n); }
    else if (e.key === "Enter") { e.preventDefault(); act(choice); }
    // esc 不再等于拒绝:误按一下就把整轮改动废掉,代价太大。拒绝只能点按钮。
  }
  return (
    <div className="perm-card" tabIndex={0} ref={ref} onKeyDown={onKey}>
      <div>{t("agent 请求执行 {{tool}}", { tool: item.toolName })}</div>
      <pre>{summarizeInput(item.toolName, item.input) || JSON.stringify(item.input)}</pre>
      {/* 被拦是因为路径在项目目录之外:此时加命令规则没用,必须放行目录 */}
      {item.blockedPath && (
        <div className="perm-blocked"><TriangleAlert size={13} /> {t("{{path}} 在项目目录之外 —— 只加命令规则挡不住这个,需放行目录", { path: item.blockedPath })}</div>
      )}
      {usable.length > 0 && (
        <div className="perm-remember">
          <div className="perm-remember-head muted">{t('"允许并记住"将写入以下规则：')}</div>
          {usable.flatMap((suggestion, i) => {
            if (suggestion.type !== "addRules") {
              return <div className="perm-remember-row" key={i}>{suggestionLabel(suggestion)}</div>;
            }
            return suggestion.rules.map((rule, j) => (
              <div className="perm-remember-row" key={`${i}:${j}`}>
                <span className="perm-rule-tool">{rule.toolName}(</span>
                <input className="perm-rule-input" value={contents[`${i}:${j}`]} spellCheck={false}
                  onChange={(e) => setContents((old) => ({ ...old, [`${i}:${j}`]: e.target.value }))}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
                <span className="perm-rule-tool">)</span>
                <span className="perm-dest muted">{destinationLabel(suggestion.destination)}</span>
              </div>
            ));
          })}
        </div>
      )}
      {/* 主操作(带底色)= 默认选中那个;其余走 ghost 弱化,拒绝再弱一档 */}
      <div className="perm-actions vertical">
        {hasR && (
          <button className={`primary ${choice === 0 ? "hi" : ""}`} disabled={hasBlankRule} onClick={apply}>
            {t("允许并记住全部（{{n}} 项）(⏎)", { n: rememberRuleCount(usable) })}
          </button>
        )}
        <button className={`${hasR ? "ghost" : "primary"} ${choice === (hasR ? 1 : 0) ? "hi" : ""}`} onClick={() => onPermission(item.requestId, "allow")}>{hasR ? t("允许") : t("允许 (⏎)")}</button>
        <button className={`ghost deny ${choice === n - 1 ? "hi" : ""}`} onClick={() => onPermission(item.requestId, "deny")}>{t("拒绝")}</button>
      </div>
    </div>
  );
}

// SDK 有时会在同一次请求里重复给出完全相同的 addRules。按最终会写入的规则去重，
// 以免用户看到多份一模一样的目录/命令规则，也避免把重复项落入 settings.local.json。
function uniqueRememberSuggestions(suggestions: PermissionSuggestion[], input: any): PermissionSuggestion[] {
  const seen = new Set<string>();
  return suggestions.flatMap((suggestion): PermissionSuggestion[] => {
    if (suggestion.type !== "addRules") {
      const label = suggestionLabel(suggestion);
      if (!label || seen.has(`${suggestion.type}:${label}`)) return [];
      seen.add(`${suggestion.type}:${label}`);
      return [suggestion];
    }
    const rules = suggestion.rules.filter((rule) => {
      const content = defaultRuleContent(rule.toolName, rule.ruleContent, input).trim();
      const key = `${suggestion.behavior}:${suggestion.destination}:${rule.toolName}:${content}`;
      if (!content || seen.has(key)) return false;
      seen.add(key); return true;
    });
    return rules.length ? [{ ...suggestion, rules }] : [];
  });
}
function rememberRuleCount(suggestions: PermissionSuggestion[]) {
  return suggestions.reduce((n, s) => n + (s.type === "addRules" ? s.rules.length : 1), 0);
}

// 问答卡草稿(选中项 + 自定义回复 + 当前题号):按 requestId 存到组件外。切到别的会话时卡片会卸载重挂,
// 不存的话用户填了一半的自定义回复 / 选择就丢了。答完(提交)或跳过后清掉。
const askDraftStore = new Map<string, { sel: (number | number[])[]; custom: string[]; qIdx: number }>();

// AskUserQuestion 交互卡:多问题用 ←→ 切换,选项用 ↑↓/数字键,空格/点击选中,可自定义回复,答完提交
function AskQuestionCard({ item, onSubmit, onCancel }: {
  item: Extract<TimelineItem, { kind: "permission" }>;
  onSubmit: (msg: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const questions: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[] = item.input.questions;
  const draft = askDraftStore.get(item.requestId); // 切回会话时恢复上次填了一半的选择 / 自定义回复
  const [qIdx, setQIdx] = useState(() => draft?.qIdx ?? 0);
  const [optIdx, setOptIdx] = useState(0);
  const [sel, setSel] = useState<(number | number[])[]>(() => draft?.sel ?? questions.map((q) => (q.multiSelect ? [] : -1)));
  const [custom, setCustom] = useState<string[]>(() => draft?.custom ?? questions.map(() => "")); // 每题的自定义回复,非空则覆盖选项
  const cardRef = useRef<HTMLDivElement>(null);
  // sel/custom/qIdx 一变就把草稿写回 store;已作答(decision)后不再写。切走再切回即可原样还原。
  useEffect(() => { if (!item.decision) askDraftStore.set(item.requestId, { sel, custom, qIdx }); }, [sel, custom, qIdx, item.decision, item.requestId]);
  useEffect(() => { if (!item.decision) cardRef.current?.focus(); }, [item.decision]);

  const q = questions[qIdx];
  // 某题是否已作答:有自定义文本,或选了选项
  const answeredWith = (s: (number | number[])[], c: string[], i: number) =>
    c[i].trim() !== "" || (questions[i].multiSelect ? (s[i] as number[]).length > 0 : (s[i] as number) >= 0);
  const answered = (i: number) => answeredWith(sel, custom, i);
  const allAnswered = questions.every((_, i) => answered(i));
  const isSelected = (i: number, j: number) => custom[i].trim() === "" && (questions[i].multiSelect ? (sel[i] as number[]).includes(j) : sel[i] === j);

  function choose(j: number) {
    setCustom((prev) => { if (!prev[qIdx]) return prev; const cp = [...prev]; cp[qIdx] = ""; return cp; }); // 选了选项就清掉自定义
    setSel((prev) => {
      const cp = [...prev];
      if (q.multiSelect) {
        const s = new Set(cp[qIdx] as number[]);
        s.has(j) ? s.delete(j) : s.add(j);
        cp[qIdx] = [...s];
      } else cp[qIdx] = j;
      return cp;
    });
  }
  function setCustomFor(i: number, v: string) {
    setCustom((prev) => { const cp = [...prev]; cp[i] = v; return cp; });
    if (v.trim()) setSel((prev) => { const cp = [...prev]; cp[i] = questions[i].multiSelect ? [] : -1; return cp; }); // 有自定义就清掉选项
  }

  function submit(s = sel, c = custom) {
    if (!questions.every((_, i) => answeredWith(s, c, i))) return;
    const lines = questions.map((qq, i) => {
      const ans = c[i].trim() ? c[i].trim()
        : qq.multiSelect ? (s[i] as number[]).map((j) => qq.options[j].label).join("、") : qq.options[s[i] as number].label;
      return `${qq.header || qq.question}:${ans}`;
    });
    askDraftStore.delete(item.requestId); // 已提交,清掉草稿
    onSubmit(`用户已作出选择:\n${lines.join("\n")}\n请据此继续。`);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight") { e.preventDefault(); if (qIdx < questions.length - 1) { setQIdx(qIdx + 1); setOptIdx(0); } }
    else if (e.key === "ArrowLeft") { e.preventDefault(); if (qIdx > 0) { setQIdx(qIdx - 1); setOptIdx(0); } }
    else if (e.key === "ArrowDown") { e.preventDefault(); setOptIdx((i) => (i + 1) % q.options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setOptIdx((i) => (i - 1 + q.options.length) % q.options.length); }
    else if (e.key >= "1" && e.key <= "9") { const j = +e.key - 1; if (j < q.options.length) { e.preventDefault(); setOptIdx(j); choose(j); } }
    else if (e.key === " ") { e.preventDefault(); choose(optIdx); }
    // 回车不再做任何事:等待作答时一律不响应回车,避免输入法确认候选词 / 想换行时误提交。
    // 提交与"下一题"都改为手动 —— 提交点按钮,切题用 ←→ 或点标签。
    else if (e.key === "Escape") { e.preventDefault(); askDraftStore.delete(item.requestId); onCancel(); }
  }

  // 已决定:只读展示用户的选择
  if (item.decision) {
    return (
      <div className="ask-card done">
        {item.answer ? <div className="ask-answer">{item.answer.replace(/^用户已作出选择:\n?/, "").replace(/\n请据此继续。$/, "")}</div>
          : <div className="perm-decided"><Ban size={13} /> {t("已跳过")}</div>}
      </div>
    );
  }

  return (
    <div className="ask-card" tabIndex={0} ref={cardRef} onKeyDown={onKey}>
      {questions.length > 1 && (
        <div className="ask-nav">
          {questions.map((qq, i) => (
            <span key={i} className={`ask-tab ${i === qIdx ? "cur" : ""} ${answered(i) ? "done" : ""}`}
              onClick={() => { setQIdx(i); setOptIdx(0); }}>{qq.header || t("问题{{n}}", { n: i + 1 })}{answered(i) ? <> <Check size={11} /></> : ""}</span>
          ))}
        </div>
      )}
      <div className="ask-q">{q.header && <span className="ask-q-tag">{q.header}</span>}{q.question}{q.multiSelect && <span className="muted">{t(" · 可多选")}</span>}</div>
      <div className="ask-opts">
        {q.options.map((opt, j) => (
          <div key={j} className={`ask-opt ${custom[qIdx].trim() === "" && j === optIdx ? "hi" : ""} ${isSelected(qIdx, j) ? "on" : ""}`}
            onClick={() => { setOptIdx(j); choose(j); }}>
            <span className="ask-opt-n">{j + 1}</span>
            <div className="ask-opt-body"><b>{opt.label}</b>{opt.description && <div className="muted">{opt.description}</div>}</div>
            {isSelected(qIdx, j) && <span className="ask-check"><Check size={13} /></span>}
          </div>
        ))}
        {/* 自定义回复:输入即作为该题答案,覆盖选项 */}
        <div className={`ask-opt ask-custom ${custom[qIdx].trim() ? "on" : ""}`}>
          <span className="ask-opt-n"><Pencil size={12} /></span>
          {/* textarea 不是 input:答案常是一整句规则,单行输入框只能看见光标附近那一截,
              写到一半就没法回头核对自己写了什么。固定两行高(rows=2,不给拖拽把手),超出的部分在框内滚。 */}
          <textarea className="ask-custom-input" rows={2} placeholder={t("自定义回复…(直接输入你的答案)")}
            value={custom[qIdx]}
            onChange={(e) => setCustomFor(qIdx, e.target.value)}
            // 回车一律不提交:用户常按回车录入输入法候选词,误触提交时内容还没输完。提交只走"提交"按钮。
            // 这里回车是换行(textarea 本行为),正合用 —— 规则本来就常常分条写。
            // stopPropagation 拦住冒泡到卡片 onKey(那里也不再处理回车,双保险)。只保留 Esc 退出编辑。
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); cardRef.current?.focus(); } }} />
          {custom[qIdx].trim() && <span className="ask-check"><Check size={13} /></span>}
        </div>
      </div>
      <div className="ask-foot">
        <button className="ask-submit" disabled={!allAnswered} onClick={() => submit()}>{t("提交")}{allAnswered ? "" : t("(还剩 {{n}} 题)", { n: questions.filter((_, i) => !answered(i)).length })}</button>
        {/* 取消必须有个看得见的出口:esc 只有知道的人会按,不给按钮就等于逼着人必须选一个(HIG escape-routes) */}
        <button className="ask-skip" onClick={() => { askDraftStore.delete(item.requestId); onCancel(); }}>{t("跳过")}</button>
        <span className="ask-hint">{t("←→ 切题 · ↑↓/数字 选项 · 空格 选中 · 提交请点按钮 · esc 跳过")}</span>
      </div>
    </div>
  );
}

function summarizeInput(name: string, input: any): string {
  if (!input) return "";
  if (name === "Bash") return input.command ?? "";
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  return "";
}
