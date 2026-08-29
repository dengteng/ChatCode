import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, File, CornerLeftUp, RotateCw, ChevronDown, X, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { BUILTIN_COMMANDS, modelLabel, modelName, contextWindowOf, canSendImage } from "../types";
import { useStore, fetchBlob, sessionBusy, PENDING_MAX } from "../store";
import { UsageBar } from "./UsageBar";
import { openImageWindow } from "../popout";
import { onEdgeGlow } from "../lib/edgeGlow";
import { unwrapSoftBreaks, htmlHasBlocks } from "../lib/unwrap";
import { toast } from "./Toast";
import { extNote, skillDescs } from "../extensions";
import { useTranslation } from "react-i18next";

interface Img { media_type: string; data: string }

// 需要跟参数才有意义的内置命令:回车不直接执行,只把命令回显到输入框等用户补参数(如 /goal <目标>)
const ARG_CMDS = new Set(["/goal"]);

// 一条输入历史 = 编辑器 HTML + 图片数据(不能只存文本,否则 ↑ 回显会把图片丢掉)
interface HistEntry { html: string; imgs: Record<string, Img>; text: string; ts: number }

const ZWSP = "​"; // 零宽字符:插在图片标签后,保证光标能停到标签之后继续输入

// 图片 chip 的标签在编辑器里是直接拼 innerHTML 的(非 React),没法塞 lucide 组件,
// 用同款 image 图标的内联 SVG 字符串,和消息气泡里的 <Image> 视觉一致。
const IMG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
// 引用 chip 的图标:必须是和上面同规格的 svg。原来用 📎 emoji,emoji 走系统彩色字体、行盒比 13px 图标高一截,
// chip 整个被撑高,和图片 chip 对不齐。
const SNIP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

// 刚用 modify 跨过的那一格是否零宽字符(前移看 caret 左侧,后移看右侧)。是则该次移动不可见,需再移一步。
function crossedZwsp(sel: Selection, dir: "forward" | "backward"): boolean {
  const n = sel.anchorNode, o = sel.anchorOffset;
  if (!n) return false;
  if (n.nodeType === 3) {
    const t = n.textContent || "";
    return (dir === "forward" ? t[o - 1] : t[o]) === ZWSP;
  }
  const child = n.childNodes[dir === "forward" ? o - 1 : o]; // 元素边界:检查相邻子节点
  return !!child && child.nodeType === 3 && child.textContent === ZWSP;
}

// 往一个方向跳过"只有零宽字符"的文本节点,拿到真正相邻的那个节点
function skipZwspNodes(node: Node | null, dir: "prev" | "next"): Node | null {
  while (node && node.nodeType === 3 && (node.textContent || "").split(ZWSP).join("") === "")
    node = dir === "prev" ? node.previousSibling : node.nextSibling;
  return node;
}
// 光标同侧(跳过零宽字符)紧贴的节点。side="prev" 看左边,"next" 看右边。
// 返回 false = 同侧还有真实字符挡着;null = 那一侧到头了(行首/行尾)。
function siblingAtCaret(sel: Selection, side: "prev" | "next"): Node | null | false {
  const n = sel.anchorNode, o = sel.anchorOffset;
  if (!n) return false;
  let node: Node | null;
  if (n.nodeType === 3) {
    const t = n.textContent || "";
    if ((side === "prev" ? t.slice(0, o) : t.slice(o)).split(ZWSP).join("") !== "") return false;
    node = side === "prev" ? n.previousSibling : n.nextSibling;
  } else {
    node = n.childNodes[side === "prev" ? o - 1 : o] ?? null;
  }
  return skipZwspNodes(node, side);
}
const asChip = (node: Node | null | false) =>
  node && node.nodeType === 1 && (node as HTMLElement).classList.contains("img-tag") ? (node as HTMLElement) : null;
// 光标正前方(跳过零宽字符)是否紧贴一个图片 chip。是则返回该 chip,用于 backspace 一次删掉整块。
const chipBeforeCaret = (sel: Selection) => asChip(siblingAtCaret(sel, "prev"));
// 光标停在"某行行首 + 右边就是 chip"这个位置:它和"chip 右侧"在屏幕上是两个不同的落点,
// 方向键必须能停在这儿 —— 否则从上一行按 → 会一路跳过 chip,永远落不到 chip 左边(行首)。
function atChipLineStart(sel: Selection): boolean {
  if (!asChip(siblingAtCaret(sel, "next"))) return false;
  const prev = siblingAtCaret(sel, "prev");
  return prev === null || (prev !== false && prev.nodeName === "BR"); // 左边到头或是换行 = 行首
}

// 复制/剪切编辑器选区:把带 chip 的片段序列化成两种剪贴板格式。
//   text/plain —— 图片 chip 出 [图片],引用 chip 出原文;贴到纯文本处就是一段文字
//   text/html  —— 图片 chip 出 <img src="data:…">(贴进邮件/备忘录这类吃 HTML 的应用就是原图),
//                 并带 data-cc-* 标记;贴回自己输入框时据此原样还原成 chip
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function serializeFragment(frag: Node, imgs: Map<string, Img>): { plain: string; html: string } {
  let plain = "", html = "";
  const walk = (root: Node) => root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { const t = (n.textContent || "").split(ZWSP).join(""); plain += t; html += escHtml(t); }
    else if (n.nodeName === "BR") { plain += "\n"; html += "<br>"; }
    else if (n instanceof HTMLElement && n.classList.contains("snip-tag")) {
      const t = n.dataset.snip || "";
      plain += t; html += `<span data-cc-snip="${escHtml(t)}">${escHtml(t)}</span>`;
    } else if (n instanceof HTMLElement && n.classList.contains("img-tag")) {
      const img = imgs.get(n.dataset.id || "");
      plain += "[图片]";
      if (img) html += `<img data-cc-img="1" src="data:${img.media_type};base64,${img.data}">`;
    } else if (n instanceof HTMLElement) {
      if (n.nodeName === "DIV" && plain && !plain.endsWith("\n")) { plain += "\n"; html += "<br>"; }
      walk(n);
    }
  });
  walk(frag);
  return { plain, html };
}

// chipBeforeCaret 的镜像:光标正后方(跳过零宽字符)是否紧贴一个 chip。用于 →/← 一步跨过整块。
function chipAfterCaret(sel: Selection): HTMLElement | null {
  const n = sel.anchorNode, o = sel.anchorOffset;
  if (!n) return null;
  let node: Node | null;
  if (n.nodeType === 3) {
    if ((n.textContent || "").slice(o).split(ZWSP).join("") !== "") return null; // 右侧有真实字符 → 正常移动
    node = n.nextSibling;
  } else {
    node = n.childNodes[o] ?? null;
  }
  while (node && node.nodeType === 3 && (node.textContent || "").split(ZWSP).join("") === "") node = node.nextSibling;
  return node && node.nodeType === 1 && (node as HTMLElement).classList.contains("img-tag") ? (node as HTMLElement) : null;
}

// 按会话 id 暂存未发送草稿(编辑器 HTML + 图片数据)—— 切换会话各自独立,互不串
const draftStore = new Map<string, { html: string; imgs: Record<string, Img> }>();
// ↑↓ 回显的历史,同样按会话 id 分开存。
// 为什么要放到组件外:切会话时 <Chat session={active}> 没有 key,Composer 根本不重新挂载 ——
// 组件内的 useRef 是同一份,四个会话就共用一条历史,在 A 里按 ↑ 会翻出 B 里发过的指令。
// 放这里 + 用 session.id 取,和上面草稿走同一套(顺带:历史本来就该跟着会话走,和草稿一个道理)。
// 这里只存**不进时间线**的那些(!终端命令、/model、/clear …);发给 agent 的消息不往这存,
// 它们由时间线本身供给历史 —— 这个 Map 是内存的,关掉 app 就空了,时间线会随会话恢复回来。
const histStore = new Map<string, HistEntry[]>();

// 纯文本 → 编辑器 HTML。换行走 <br>;尖括号必须转义 —— 历史消息里一段字面 `<div>` 直接塞进
// innerHTML 会被当标签吃掉,回显出来就少一截。
const textHtml = (text: string) =>
  text.split("\n").map((ln) => ln.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)).join("<br>");

// /export:把可见时间线整理成 Markdown(用户/Agent 对话 + 终端 + 系统提示;跳过工具细节与执行说明)
function timelineToMarkdown(session: Session): string {
  const out: string[] = [`# ${session.title}`, ""];
  for (const it of session.timeline) {
    if (it.kind === "user") {
      const text = it.blocks.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[图片]" : "")).filter(Boolean).join("\n");
      if (text) out.push("**你:**", "", text, "");
    } else if (it.kind === "agent_text" && it.phase !== "progress" && it.text.trim()) {
      out.push("**Agent:**", "", it.text, "");
    } else if (it.kind === "terminal") {
      out.push("```sh", `$ ${it.command}`, it.output || "", "```", "");
    } else if (it.kind === "system") {
      out.push(`> ${it.text.replace(/\n/g, "\n> ")}`, "");
    }
  }
  return out.join("\n");
}

// ---------- @ 提及:从项目目录里挑文件/文件夹 ----------
interface FileEntry { path: string; dir: boolean } // path = 相对项目根目录

// 全量索引缓存:每敲一个字符都回 Rust 走一遍磁盘太亏,走一次全量、前端拿着过滤。15s 过期,新建的文件也能很快被看到。
const walkCache = new Map<string, { at: number; list: FileEntry[] }>();
async function projectFiles(root: string): Promise<FileEntry[]> {
  const hit = walkCache.get(root);
  if (hit && Date.now() - hit.at < 15000) return hit.list;
  const raw = await invoke<[string, boolean][]>("walk_project", { root }).catch(() => [] as [string, boolean][]);
  const list = raw.map(([path, dir]) => ({ path, dir }));
  walkCache.set(root, { at: Date.now(), list });
  return list;
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 发送前在正文最前面补一句显式调用指令 "Use the X skill."(agent 靠它触发)。
// #skill-name 本身**留在原位不动** —— 它是句子的一部分("用 #foo 重新设计…"),
// 删掉就再也不知道用户当初把它放在哪儿了,气泡里也就没法把 tag 渲染回原处。
// 只认 names(当前会话已加载的 skill),别的 # 是普通文本(话题标签、C# 之类),不管。
export function expandSkillTags(blocks: any[], skills: string[]): any[] {
  const names = skills.slice().sort((a, b) => b.length - a.length); // 长的先匹配,免得被短名前缀截断
  if (!names.length) return blocks;
  const re = new RegExp(`(^|\\s)#(${names.map(reEsc).join("|")})(?=[\\s,.，。]|$)`, "g");
  const used: string[] = [];
  for (const b of blocks) {
    if (b.type !== "text") continue;
    for (const m of b.text.matchAll(re)) if (!used.includes(m[2])) used.push(m[2]);
  }
  if (!used.length) return blocks;
  return [{ type: "text", text: used.map((n) => `Use the ${n} skill.`).join("\n") }, ...blocks];
}
const baseName = (p: string) => p.split("/").pop() || p;
const dirName = (p: string) => p.split("/").slice(0, -1).join("/");

// 过滤打分:文件名前缀 > 文件名子串 > 整条路径子串(支持直接敲 src/comp 这种带斜杠的)。同分时路径越短越靠前。
function scoreEntry(e: FileEntry, q: string): number {
  const path = e.path.toLowerCase(), name = baseName(path);
  let s = 0;
  if (name.startsWith(q)) s = 100;
  else if (name.includes(q)) s = 70;
  else if (path.includes(q)) s = 40;
  else return 0;
  if (!e.dir) s += 5; // 同分时文件排在文件夹前:@ 多半是想引用文件
  return s - Math.min(20, path.length / 8);
}

// 键盘优先: "/" 唤起命令面板(↑↓选 Tab/⏎补全) · "@" 唤起项目文件选择 · "#" 唤起 skill 选择
//           · ↑翻输入历史 · ⏎发送 · Shift+⏎换行
// 输入框空时若有待确认权限: ⏎=允许 esc=拒绝
// a: 输入区是 contentEditable —— 图片以内联标签插在光标处,和文本混排,方向键可在其间移动
export function Composer({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { state, sendMessage, respondPermission, interrupt, runTerminal, reopenSession, setModel, clearContext, requestModels, setPermissionPreset, dispatch, enqueuePending, cancelPending } = useStore();
  const edRef = useRef<HTMLDivElement>(null);
  const imgData = useRef(new Map<string, Img>()); // chip id -> 图片数据
  const idc = useRef(0);
  const composing = useRef(false); // 输入法组合中
  const compEndAt = useRef(-1e9);  // 上次 compositionend 的 performance.now()
  const [palIdx, setPalIdx] = useState(0);
  const [modelMenu, setModelMenu] = useState(false); // /model 选择器打开中
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");     // 纯文本镜像(驱动命令面板/占位符,不回写编辑器)
  const [imgCount, setImgCount] = useState(0);
  const [preview, setPreview] = useState<{ src: string; left: number; top: number } | null>(null); // 悬浮预览
  const [suggestion, setSuggestion] = useState(""); // 基于历史的灰字自动建议(光标后的补全)
  const liveHist = () => { // 当前会话的本地历史(懒建),不是全 app 一条
    let h = histStore.get(session.id);
    if (!h) histStore.set(session.id, (h = []));
    return h;
  };
  // 时间线里的用户消息就是这个会话的历史本体 —— 关掉 app 再打开,histStore 空了,但时间线随会话
  // 恢复回来,↑ 照样翻得到开会话前发的消息(这正是原来翻不到的原因)。
  // 本次会话发出去的那几条带 composerHtml,图片/引用 chip 能原样还原;恢复回来的只有 blocks,
  // 退化成纯文本(图片数据在 sidecar,为翻个历史去逐条取不值)。
  const timelineHist = useMemo<HistEntry[]>(() => {
    const out: HistEntry[] = [];
    for (const it of session.timeline) {
      if (it.kind !== "user") continue;
      const text = it.blocks.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n").trim();
      if (it.composerHtml) out.push({ html: it.composerHtml, imgs: it.composerImgs ?? {}, text, ts: it.ts });
      else if (text) out.push({ html: textHtml(text), imgs: {}, text, ts: it.ts });
    }
    return out.reverse(); // 新的排前面,↑ 第一下就是最近一条
  }, [session.timeline]);
  // 两路合并按时间倒序,再把紧挨着的重复项折掉。同一条发出去的消息两边都有(histStore 一份、
  // 时间线一份),它俩的 html 完全相同 —— 先比 html 就把这种成对的收掉了;文本那条顺带把
  // "连发两条一模一样的"也折成一条(shell 历史就是这么做的),只发图没文字的除外。
  const dupe = (a: HistEntry, b: HistEntry) =>
    a.html === b.html || (!!a.text && a.text === b.text && hasImgs(a) === hasImgs(b));
  const hist = () => {
    const all = [...liveHist(), ...timelineHist].sort((a, b) => b.ts - a.ts);
    return all.filter((h, i) => i === 0 || !dupe(h, all[i - 1]));
  };
  const histIdx = useRef(-1);             // ↑ 翻到第几条(-1 = 没在翻历史,框里是用户自己的内容)
  const histDraft = useRef<HistEntry | null>(null); // 开始翻之前框里那份,↓ 翻回头时还给他
  const selItemRef = useRef<HTMLDivElement>(null); // 命令面板当前选中项,用于键盘导航时滚动进视口
  // @ 提及:mention=光标处的 @token(null=菜单关);mDir=浏览模式当前目录;mAll=全量索引(过滤用)
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [mDir, setMDir] = useState("");
  const [mEntries, setMEntries] = useState<FileEntry[]>([]);
  const [mAll, setMAll] = useState<FileEntry[]>([]);
  const [mIdx, setMIdx] = useState(0);
  const mDismiss = useRef(false); // esc 关掉后别让下一次 syncText 又把它弹回来,直到这个 @ 被删掉
  // # skill 选择:和 @ 同一套 token 机制,skillTok=光标处的 #token(null=菜单关)
  const [skillTok, setSkillTok] = useState<{ query: string } | null>(null);
  const [sIdx, setSIdx] = useState(0);
  const sDismiss = useRef(false);
  const mentionRoot = session.cwd; // 用 cwd 而非 termCwd:agent 的工作目录才是相对路径的基准(SSH 时 termCwd 是远端路径)

  // g: 命令面板 = 内置常用命令 + init 上报的 slash_commands(skill/插件)。
  // 过滤掉内部命令(__*)、纯 debug 及在无 TUI 环境里跑不通的交互式命令。
  const commands = useMemo(() => {
    const HIDDEN = new Set(["heapdump", "config", "agents", "reload-skills", "extra-usage", "usage-credits", "design", "design-consent", "design-revoke", "team-onboarding"]);
    const fromInit = (session.info.slash_commands ?? [])
      .map((c) => (c.startsWith("/") ? c : `/${c}`))
      .filter((c) => !c.startsWith("/__") && !HIDDEN.has(c.slice(1)))
      .filter((c) => !BUILTIN_COMMANDS.some((b) => b.cmd === c))
      .map((c) => ({ cmd: c, desc: "" }));
    return [...BUILTIN_COMMANDS, ...fromInit];
  }, [session.info.slash_commands]);

  useEffect(() => { selItemRef.current?.scrollIntoView({ block: "nearest" }); }, [palIdx, mIdx, sIdx]);

  // 光标正前方的触发 token(@ 选文件 / # 选 skill)。触发符与光标之间不能有空格。
  // 前一个字符只挡 ASCII 字母数字 —— 挡掉的正是 a@b(邮箱)、C#、utf-8 这类"词内符号";
  // 中文/标点/括号后面照常唤起("测试@" 要能弹,飞书就是这样),不再要求必须在行首或空白后。
  function triggerToken(ch: string): { query: string; node: Text; start: number } | null {
    const sel = window.getSelection(); const ed = edRef.current;
    if (!sel || !sel.isCollapsed || !sel.rangeCount || !ed || !ed.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const at = before.lastIndexOf(ch);
    if (at < 0) return null;
    const prev = at > 0 ? before[at - 1] : "";
    if (/[A-Za-z0-9]/.test(prev)) return null;
    const query = before.slice(at + 1);
    if (/[\s@#]/.test(query)) return null;
    return { query, node: node as Text, start: at };
  }
  const mentionToken = () => triggerToken("@");
  function refreshMention() {
    const t = mentionToken();
    if (!t) { mDismiss.current = false; setMention(null); setMDir(""); } // @ 没了 → 状态归零
    else setMention(mDismiss.current ? null : { query: t.query });
    const s = triggerToken("#");
    if (!s) { sDismiss.current = false; setSkillTok(null); return; }
    setSkillTok(sDismiss.current ? null : { query: s.query });
  }
  // 用选中项替换掉 "<ch>query"(replacement 自带前缀);走 execCommand 以保留撤销栈
  function replaceToken(ch: string, replacement: string) {
    const t = triggerToken(ch); const sel = window.getSelection();
    if (!t || !sel) return;
    const r = document.createRange();
    r.setStart(t.node, t.start); r.setEnd(t.node, t.start + 1 + t.query.length);
    sel.removeAllRanges(); sel.addRange(r);
    document.execCommand("insertText", false, replacement);
    syncText(); refreshMention();
  }
  // enter=true:文件夹 → 进去接着挑;false(Tab) → 直接把文件夹路径插进去
  function pickMention(e: FileEntry, enter: boolean) {
    edRef.current?.focus();
    if (e.path === "..") { setMDir((d) => d.split("/").slice(0, -1).join("/")); setMIdx(0); return; }
    if (e.dir && enter) { setMDir(e.path); setMIdx(0); replaceToken("@", "@"); return; } // 过滤模式下进目录:query 清掉,回到树浏览
    replaceToken("@", `@${e.path}${e.dir ? "/" : ""} `);
  }

  // # 唤起 skill 选择:列当前会话已加载的 skill(init 上报的那份,选了才真能用)。
  // 选中只插一个简洁的 #name 标记,发送时再翻译成显式调用指令(见 expandSkillTags)。
  const sQuery = skillTok?.query ?? "";
  // 说明:光有名字分不清 design / design-system / taste-skill 这类,菜单里每行跟一句备注。
  // 和设置页同一份来源(自己写的备注 > 内置中文表 > SKILL.md 的 description),开菜单时才去读盘。
  const [sDesc, setSDesc] = useState<Record<string, string>>({});
  useEffect(() => { if (skillTok) skillDescs(session.cwd).then(setSDesc); }, [!!skillTok, session.cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const sItems = useMemo(() => {
    const all = session.info.skills ?? [];
    if (!sQuery) return all;
    const q = sQuery.toLowerCase();
    // 前缀命中的排前面,其次是名字里任意位置命中的
    return all.filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => (+!a.toLowerCase().startsWith(q)) - (+!b.toLowerCase().startsWith(q)) || a.localeCompare(b));
  }, [session.info.skills, sQuery]);
  useEffect(() => { setSIdx(0); }, [sQuery]);
  function pickSkill(name: string) {
    edRef.current?.focus();
    replaceToken("#", `#${name} `);
  }

  const mQuery = mention?.query ?? "";
  // 全量索引:菜单一开就拉(过滤模式要用)
  useEffect(() => { if (mention) projectFiles(mentionRoot).then(setMAll); }, [!!mention, mentionRoot]);
  // 浏览模式:只列当前目录一层
  useEffect(() => {
    if (!mention || mQuery) return;
    const path = mDir ? `${mentionRoot}/${mDir}` : mentionRoot;
    invoke<[string, boolean][]>("list_dir", { path })
      .then((rows) => setMEntries(rows.filter(([n]) => !n.startsWith(".")).map(([n, dir]) => ({ path: mDir ? `${mDir}/${n}` : n, dir }))))
      .catch(() => setMEntries([]));
  }, [!!mention, mQuery === "", mDir, mentionRoot]);
  const mItems = useMemo<FileEntry[]>(() => {
    if (!mention) return [];
    if (!mQuery) return mDir ? [{ path: "..", dir: true }, ...mEntries] : mEntries;
    const q = mQuery.toLowerCase();
    return mAll.map((e) => ({ e, s: scoreEntry(e, q) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 50).map((x) => x.e);
  }, [mention, mQuery, mDir, mEntries, mAll]);
  useEffect(() => { setMIdx(0); }, [mQuery, mDir]);

  const paletteOpen = imgCount === 0 && text.startsWith("/") && !text.includes(" ");
  const filtered = paletteOpen ? commands.filter((c) => c.cmd.toLowerCase().startsWith(text.toLowerCase())) : [];
  const pendingPerm = [...session.timeline].reverse().find((t) => t.kind === "permission" && !t.decision);
  const isEmpty = text.trim() === "" && imgCount === 0;
  // ! 开头的内容不会发给 agent，而是在当前项目目录执行。用独立外观避免误以为是普通对话。
  const shellMode = imgCount === 0 && text.startsWith("!");
  // 正在压缩上下文:输入框照常可用,但发出去的消息进待发队列(压缩完自动依次发出) ——
  // 压缩期间 status 仍是 idle,不拦就会立刻打进去,SDK 把它当新一轮跑起来、压缩白做。
  const compactItem = session.timeline.find((t) => t.kind === "compact" && t.running);
  const compacting = !!compactItem;

  // 压缩进度百分比。SDK 全程只给"开始/结束"两个信号,没有真进度 —— CLI 那条也是纯时间估算,
  // 照抄它的曲线(claude 2.1.235:pct = 1 - e^(-t/90s),封顶 95%,不满 8 格宽就不画条):
  // 前 30 秒涨得快、之后放缓,压再久也不谎报 100%。纯 elapsed 的函数,天然单调,不用另存进度。
  const [, tick] = useState(0);
  useEffect(() => {
    if (!compacting) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [compacting]);
  const compactPct = compactItem ? Math.min(95, Math.round((1 - Math.exp(-Math.max(0, Date.now() - compactItem.ts) / 90_000)) * 100)) : 0;

  // 压缩超时兜底。压缩只有两个出口:SDK 的 compact_boundary(成功)或轮次末尾的 result(store 里 compact_settle 兜底)。
  // 两条都不来时(请求挂死、大上下文压缩卡住)running 就永远挂着,而 compacting 会把所有新消息塞进排队,
  // 「停止」按钮又只认 status==="running"(压缩期 status 是 idle)—— 用户既发不出消息也断不掉,只能重启 app。
  // 15 分钟没动静就自认失败:状态一收,store 里的自动出队 effect 会立刻把排队的消息发出去。
  useEffect(() => {
    if (!compacting) return;
    const timer = setTimeout(() => dispatch({ type: "compact_finish", id: session.id,
      patch: { error: t("压缩超时（15 分钟无响应），已自动结束") } }), 15 * 60_000);
    return () => clearTimeout(timer);
  }, [compacting, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 输入框里最后一次的光标位置。点消息区的"贴到输入框"时选区早已跑到气泡上、输入框也失焦了,
  // 只有这份快照知道 chip 该插哪儿(见 restoreCaret / insertSnippetChip)。
  const lastCaret = useRef<Range | null>(null);
  useEffect(() => {
    const on = () => {
      const sel = window.getSelection(), ed = edRef.current;
      if (ed && sel?.rangeCount && ed.contains(sel.anchorNode)) lastCaret.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);

  // 只取真正的文本(跳过图片标签的内部文字),BR/块级换行计入 \n
  function nodeText(root: Node): string {
    let out = "";
    root.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
      else if (n.nodeName === "BR") out += "\n";
      else if (n instanceof HTMLElement) {
        if (n.classList.contains("img-tag")) return; // 图片占位,不算文本
        if (n.nodeName === "DIV" && out && !out.endsWith("\n")) out += "\n";
        out += nodeText(n);
      }
    });
    return out;
  }
  const getText = () => (edRef.current ? nodeText(edRef.current).split(ZWSP).join("") : "");

  function syncText() {
    const ed = edRef.current;
    // 删图后遗留的零宽字符/空白文本节点会把光标顶到中间,看着像根删不掉的竖线。
    // 编辑器里没有任何元素(图片 chip / br / div)、纯文本又全是空白时,直接清空 DOM 归位。
    if (ed && !composing.current && !ed.querySelector("*") && (ed.textContent ?? "").replace(/[​\s]/g, "") === "" && ed.innerHTML !== "") {
      ed.innerHTML = "";
    }
    const t = getText();
    const imgs = ed?.querySelectorAll(".img-tag").length ?? 0;
    setText(t); setImgCount(imgs);
    // 灰字建议:单行纯文本时,取最近一条以当前输入为前缀的纯文本历史,补全其余部分
    let sug = "";
    if (t && imgs === 0 && !t.includes("\n")) {
      const h = hist().find((x) => !hasImgs(x) && x.text.length > t.length && x.text.startsWith(t));
      if (h) sug = h.text.slice(t.length);
    }
    setSuggestion(sug);
    persistDraft();
  }

  // 草稿实时落盘:每次编辑就写 draftStore,不靠卸载时的 effect cleanup ——
  // 回首页是 Composer 完全卸载,React 先把 edRef 置 null 再跑 cleanup,那时读不到 DOM,草稿会丢。
  function persistDraft() {
    const ed = edRef.current; if (!ed) return;
    const html = ed.innerHTML;
    if (html.trim() && (nodeText(ed).trim() || ed.querySelector(".img-tag")))
      draftStore.set(session.id, { html, imgs: Object.fromEntries(imgData.current) });
    else draftStore.delete(session.id);
  }

  const hasImgs = (h: HistEntry) => Object.keys(h.imgs).length > 0;

  // 快照当前编辑器内容(含图片),必须在 clearEditor 之前调用
  function snapshot(): HistEntry {
    return { html: edRef.current?.innerHTML ?? "", imgs: Object.fromEntries(imgData.current), text: getText().trim(), ts: Date.now() };
  }
  function pushHistory(h: HistEntry) {
    if (h.text || hasImgs(h)) liveHist().unshift(h);
  }
  // ↑ 回显上一条:整体还原 HTML + 图片数据,图片标签因此不会丢
  function restoreHistory(h: HistEntry) {
    const ed = edRef.current; if (!ed) return;
    ed.innerHTML = h.html;
    imgData.current = new Map(Object.entries(h.imgs));
    const maxId = Math.max(-1, ...[...imgData.current.keys()].map(Number).filter((n) => !isNaN(n)));
    idc.current = maxId + 1; // 新插入的图片不能和还原出来的 chip id 撞
    renumber();
    ed.focus();
    // 光标一律落在最前面。翻历史时光标停在末尾的话,下一下 ↑ 就成了"把光标往上移一行",
    // 一条就翻不动了 —— 钉在第一位,连按 ↑ 才能一路往上翻。
    const sel = window.getSelection();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(true);
    sel?.removeAllRanges(); sel?.addRange(r);
    ed.scrollTop = 0;
    syncText();
  }

  // 光标是否落在编辑器最前面。不能只看 textContent 为空 —— 图片 chip 和 <br> 都不贡献文本,
  // 光标停在图片后面/第二行行首也会被算成"在最前",↑ 就抢走了本该移动光标的那一下。
  function caretAtStart() {
    const ed = edRef.current, sel = window.getSelection();
    if (!ed || !sel || !sel.isCollapsed || !sel.rangeCount || !ed.contains(sel.anchorNode)) return false;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(ed); pre.setEnd(r.startContainer, r.startOffset);
    const frag = pre.cloneContents();
    return (frag.textContent ?? "").split(ZWSP).join("") === "" && !frag.querySelector(".img-tag, .snip-tag, br");
  }

  // 图片标签是原子块:光标只能停在它前面或后面,不能钻进去。
  // chip 已经是 contenteditable=false,但 WKWebView 里点击/方向键仍会偶尔把折叠光标塞进 chip 内部
  // (画在图标左边、紧贴边框里),看着像能在标签里打字。落进去就把它弹到 chip 之后(那里垫了零宽字符可落脚)。
  // 顺带:拖选扫过 chip 时给它打 .sel —— chip 是原子块,理应整块反白。浏览器原生高亮是按里面的
  // 文本节点分别涂的,图标/文字/× 会被切成三段,看着像 chip 散架了(内部的 ::selection 在 CSS 里已关掉)。
  useEffect(() => {
    // 只认"整块都在选区里"。不用 intersectsNode:选区末端刚好停在 chip 前一格时它也算相交,
    // 于是明明没选到的 chip 会先亮一下。比边界点就没有这个 off-by-one。
    const mark = (ed: HTMLElement, r: Range | null) => {
      const cr = document.createRange();
      for (const chip of ed.querySelectorAll<HTMLElement>(".img-tag")) {
        let on = false;
        if (r) {
          cr.selectNode(chip);
          on = r.compareBoundaryPoints(Range.START_TO_START, cr) <= 0
            && r.compareBoundaryPoints(Range.END_TO_END, cr) >= 0;
        }
        chip.classList.toggle("sel", on);
      }
    };
    const fix = () => {
      const ed = edRef.current; const sel = window.getSelection();
      if (!ed) return;
      const inEd = sel?.anchorNode && ed.contains(sel.anchorNode);
      mark(ed, inEd && sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null);
      if (!sel || !sel.isCollapsed || !inEd) return;
      const n = sel.anchorNode!;
      const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
      const chip = el?.closest(".img-tag");
      if (!chip || !ed.contains(chip)) return;
      const r = document.createRange();
      r.setStartAfter(chip); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    };
    document.addEventListener("selectionchange", fix);
    return () => document.removeEventListener("selectionchange", fix);
  }, []);

  // 光标是否在可编辑文本末尾(用于 → 接受建议)
  function caretAtEnd(): boolean {
    const ed = edRef.current; const sel = window.getSelection();
    if (!ed || !sel || !sel.isCollapsed || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0).cloneRange();
    r.setEndAfter(ed.lastChild ?? ed);
    r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return r.toString().split(ZWSP).join("").length === 0;
  }

  function acceptSuggestion() {
    if (!suggestion) return;
    const ed = edRef.current; if (!ed) return;
    ed.focus();
    const sel = window.getSelection();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    sel?.removeAllRanges(); sel?.addRange(r);
    document.execCommand("insertText", false, suggestion);
    setSuggestion("");
    syncText();
  }

  // 重排图片标签序号
  function renumber() {
    edRef.current?.querySelectorAll<HTMLElement>(".img-tag .img-tag-label")
      .forEach((el, i) => (el.innerHTML = `${IMG_ICON_SVG} ${t("图片{{n}}", { n: i + 1 })}`));
  }

  function clearEditor() {
    if (edRef.current) edRef.current.innerHTML = "";
    imgData.current.clear();
    draftStore.delete(session.id); // 已发送,清掉草稿
    setText(""); setImgCount(0); setPalIdx(0); setPreview(null); setSuggestion("");
    histIdx.current = -1; histDraft.current = null; // 发出去了,下一轮 ↑ 从最新一条重新数
  }

  // 模型菜单开着时:点菜单和输入框以外的任何位置都收起(点输入框保留,方便直接打字)。
  // esc 也挂在 document 上:菜单常从底部按钮点开,焦点不在编辑器,编辑器的 onKeyDown 收不到。
  useEffect(() => {
    if (!modelMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modelMenuRef.current?.contains(t) || modelBtnRef.current?.contains(t) || edRef.current?.contains(t)) return;
      setModelMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setModelMenu(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [modelMenu]);

  // 换会话时收起:Composer 不随会话 remount,菜单会挂在新会话上还显示旧列表
  useEffect(() => { setModelMenu(false); }, [session.id]);

  function openModelMenu() {
    if (modelMenu) { setModelMenu(false); return; } // 再点一次收起
    // 每次打开都刷新:运行中会话的列表是启动快照,用户后来改 settings 新增/改窗口的模型不在其中
    // (症状:切到新模型后名字显示原始 id、上下文窗口回退 200k)。重拉即更新 session.models。
    requestModels(session.id);
    setPalIdx(0);
    setModelMenu(true);
  }

  const plainHist = (text: string): HistEntry => ({ html: textHtml(text), imgs: {}, text, ts: Date.now() });

  // 纯前端命令:CLI 有,但 SDK init 不上报、当 prompt 发会被模型当字面文本,故在客户端实现,不发给 agent。
  // 命中返回 true(调用方据此不再走 sendMessage)。
  const LOCAL_COMMANDS = new Set(["/help", "/cost", "/export"]);
  function runLocalCommand(cmd: string): boolean {
    const sys = (text: string) => dispatch({ type: "append", id: session.id, item: { kind: "system", text, ts: Date.now() } });
    if (cmd === "/help") {
      const lines = commands.map((c) => `  ${c.cmd}${c.desc ? "  ·  " + t(c.desc) : ""}`);
      sys(t("可用命令({{count}})\n{{body}}\n\n快捷键\n  /  命令面板 · ↑↓ 选 · Tab 补全 · ⏎ 执行\n  @  选项目文件 · # 选 skill(发送时转成显式调用)\n  ⏎ 发送 · Shift+⏎ 换行 · ↑ 翻输入历史\n  ! 前缀 在项目目录跑终端命令(!ssh 连远端)\n  ⌘K 搜索历史 · Esc/⌘C 打断运行", { count: commands.length, body: lines.join("\n") }));
      return true;
    }
    if (cmd === "/cost") {
      const win = contextWindowOf(session);
      sys(t("本会话用量\n  花费 · ${{cost}}\n  输入 · {{input}} tokens\n  输出 · {{output}} tokens\n  上下文 · {{context}} / {{window}}", { cost: session.costUsd.toFixed(4), input: session.inputTokens.toLocaleString(), output: session.outputTokens.toLocaleString(), context: session.contextTokens.toLocaleString(), window: win.toLocaleString() }));
      return true;
    }
    if (cmd === "/export") {
      const md = timelineToMarkdown(session);
      navigator.clipboard.writeText(md).then(
        () => sys(t("✅ 已复制本会话对话到剪贴板({{n}} 字符 · Markdown)", { n: md.length })),
        () => sys(t("❌ 复制失败:剪贴板不可用")),
      );
      return true;
    }
    return false;
  }

  // 选中命令:内置控制命令(/compact /clear …)回车即执行;skill/插件等 prompt 型命令回显到输入框,
  // 补个空格把光标停到末尾,让用户继续输入参数再发送(如 /ui-ux-pro-max 后面还要跟需求描述)。
  function selectCommand(cmd: string) {
    // 需要跟参数的内置命令(如 /goal <目标>):回车只回显命令 + 空格,让用户接着输入参数再发,别直接执行
    if (ARG_CMDS.has(cmd)) { setEditorText(cmd + " "); return; }
    if (!BUILTIN_COMMANDS.some((b) => b.cmd === cmd)) { setEditorText(cmd + " "); return; }
    pushHistory(plainHist(cmd)); // 记入历史,↑ 可回溯
    clearEditor();
    if (cmd === "/model") { openModelMenu(); return; }
    if (cmd === "/clear") { clearContext(session.id); return; }
    if (runLocalCommand(cmd)) return;
    // agent 正在跑:必须排队,不能直接发。轮内追加的输入会被并进当前这一轮,而 Claude Code
    // 只在**新一轮 prompt** 上解析斜杠命令 —— /compact 会被当成普通文本读掉,压缩根本不执行。
    // 闸统一走 sessionBusy:status 只在模型说话时是 running,后台任务续跑(bgWait)和压缩中时
    // 它已回到 idle,轮次却还没了结 —— 只拦 running 就会从这两个口子漏出去,
    // 表现为"压缩未成功:命令被并入了正在跑的那一轮"。
    if (sessionBusy(session)) {
      // 满没满由 enqueuePending 现读实时队列判(渲染快照可能已经过期),它说没进去才提示
      if (!enqueuePending(session.id, { blocks: [{ type: "text", text: cmd }], text: cmd })) {
        toast(t("待发已满（最多 {{n}} 条）", { n: PENDING_MAX }));
      }
      return;
    }
    sendMessage(session.id, [{ type: "text", text: cmd }]);
    if (cmd === "/compact") dispatch({ type: "compact_start", id: session.id }); // 立刻显示压缩进度,不等 SDK 的 status
  }

  // 把整块内容替换成纯文本(命令补全 / 历史回溯用),光标置末尾
  function setEditorText(s: string) {
    const ed = edRef.current; if (!ed) return;
    ed.innerHTML = "";
    imgData.current.clear();
    if (s) ed.appendChild(document.createTextNode(s));
    ed.focus();
    const sel = window.getSelection();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    sel?.removeAllRanges(); sel?.addRange(r);
    setText(s); setImgCount(0);
  }

  function insertChip(img: Img) {
    const ed = edRef.current; if (!ed) return;
    const id = String(idc.current++);
    imgData.current.set(id, img);
    const chip = document.createElement("span");
    chip.className = "img-tag"; chip.contentEditable = "false"; chip.dataset.id = id;
    // 不带 × 按钮:chip 是原子块,退格就整个删掉,一行正文里挂几个小叉太吵。
    // 删除入口只留退格 —— 老消息的编辑快照里可能仍存着 × 的 html,CSS 那边把它 display:none 压掉。
    chip.innerHTML = `<span class="img-tag-label"></span>`;

    ed.focus();
    const sel = window.getSelection();
    let r: Range;
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      r = sel.getRangeAt(0); r.deleteContents();
    } else {
      r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    }
    // 标签前后各垫一个零宽字符:前面的让光标能落到标签之前(尤其行首),后面的让光标能停到标签之后继续输入。
    // getText / 拆 block 时都会 split(ZWSP) 去掉,不影响真实内容。
    const tail = document.createTextNode(ZWSP);
    const frag = document.createDocumentFragment();
    frag.append(document.createTextNode(ZWSP), chip, tail);
    r.insertNode(frag);
    r.setStart(tail, 1); r.collapse(true);
    sel?.removeAllRanges(); sel?.addRange(r);
    renumber(); syncText();
  }

  // 引用片段 chip:从消息里选中文本"贴到输入框"来。复用图片 chip 的全套机制(class 带 img-tag ——
  // 光标弹出、退格整删、× 删除、非文本计数都直接生效),差别只有:发送时把 dataset.snip 的文本拼进 prompt(见 submit 的 walk)。
  // end=true:不看光标,一律追加到末尾(目前没人走这条,留给确实需要追加的调用方)
  function insertSnippetChip(text: string, end = false) {
    const ed = edRef.current; if (!ed) return;
    if (end) caretToEnd();
    // 从消息区点过来时焦点/选区都在气泡里,focus() 回来后光标默认落在末尾 ——
    // 先把 lastCaret 记下的位置装回去,chip 才插在用户原本停的地方。
    else restoreCaret();
    const chip = document.createElement("span");
    chip.className = "img-tag snip-tag"; chip.contentEditable = "false"; chip.dataset.snip = text; chip.title = text;
    chip.innerHTML = `<span class="snip-tag-label">${SNIP_ICON_SVG} ${t("引用")}</span>`;
    ed.focus();
    const sel = window.getSelection();
    let r: Range;
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) { r = sel.getRangeAt(0); r.deleteContents(); }
    else { r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); }
    const tail = document.createTextNode(ZWSP);
    const frag = document.createDocumentFragment();
    frag.append(document.createTextNode(ZWSP), chip, tail);
    r.insertNode(frag);
    r.setStart(tail, 1); r.collapse(true);
    sel?.removeAllRanges(); sel?.addRange(r);
    syncText();
  }
  function caretToEnd() {
    const ed = edRef.current; if (!ed) return;
    ed.focus();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
  }
  // 把光标装回输入框里最后停留的位置。快照的节点可能已被清空/换掉(clearEditor、切会话),
  // 所以用前先 contains 一遍,失效就保持 focus() 给的默认位置。
  function restoreCaret() {
    const ed = edRef.current, r = lastCaret.current;
    ed?.focus();
    if (!ed || !r || !ed.contains(r.startContainer)) return;
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r.cloneRange());
  }
  const appendLines = (text: string) => { const ed = edRef.current!; text.split("\n").forEach((ln, i) => { if (i) ed.append(document.createElement("br")); ed.append(document.createTextNode(ln)); }); };
  // "编辑"按钮回填整条消息(替换现有内容)。优先用发送时快照的 html —— 图片和引用 chip 全部原样还原;
  // 没有快照(历史回放的老消息)则从 blocks 重建:图片可还原,引用已并进纯文本、退化为普通文字。
  function fillComposer(detail: any) {
    const ed = edRef.current; if (!ed) return;
    if (typeof detail?.html === "string") {
      ed.innerHTML = detail.html;
      imgData.current = new Map(Object.entries(detail.imgs ?? {}));
      const maxId = Math.max(-1, ...[...imgData.current.keys()].map(Number).filter((n) => !isNaN(n)));
      idc.current = maxId + 1;
      caretToEnd(); renumber(); syncText();
      return;
    }
    ed.innerHTML = ""; imgData.current.clear();
    if (Array.isArray(detail?.blocks)) {
      // 串行 await:历史里的图只有 blob 引用(数据在 sidecar),得现取一次。逐个 await 才能保住
      // 文字和图片的原始先后顺序 —— 并发取回来谁先到谁先插,顺序就乱了。
      (async () => {
        for (const b of detail.blocks) {
          if (b.type === "text") { appendLines(b.text); continue; }
          if (b.type !== "image" || !b.source) continue;
          let img: { media_type: string; data: string } | null = null;
          if (b.source.type === "cc_blob") {
            const m = (await fetchBlob(b.source.key, b.source.media_type, true))?.match(/^data:([^;]+);base64,(.*)$/);
            if (m) img = { media_type: m[1], data: m[2] };
          } else img = { media_type: b.source.media_type, data: b.source.data };
          if (img) { caretToEnd(); insertChip(img); }
        }
        caretToEnd(); syncText();
      })();
      return;
    } else if (typeof detail?.text === "string") appendLines(detail.text);
    caretToEnd(); syncText();
  }
  // 消息区"贴到输入框"/"编辑回填"通过全局事件送来(选区在 Chat、chip 在这,跨组件解耦)。只有当前活跃会话的 Composer 挂载,收到即插。
  // 依赖必须带 session.id:切会话时 Composer 复用同一实例(Chat 没 key),空依赖会把 handler 闭包钉死在
  // **首次挂载那个会话**上 —— innerHTML 走 edRef 填对了当前编辑器,但尾部 syncText → persistDraft 的
  // draftStore.set(session.id) 会把草稿存进旧会话的槽位,切过去就看到别的会话的消息躺在输入框里。
  useEffect(() => {
    const onSnip = (e: Event) => { const d = (e as CustomEvent).detail; if (typeof d?.text === "string" && d.text.trim()) insertSnippetChip(d.text, !!d.end); };
    const onFill = (e: Event) => fillComposer((e as CustomEvent).detail);
    window.addEventListener("cc-insert-snippet", onSnip);
    window.addEventListener("cc-fill-composer", onFill);
    return () => { window.removeEventListener("cc-insert-snippet", onSnip); window.removeEventListener("cc-fill-composer", onFill); };
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    const ed = edRef.current; if (!ed) return;
    let compactCmd = false;

    // ! 前缀 = 终端命令(仿 Claude Code CLI 的 bash 模式),不发给 agent
    if (imgCount === 0) {
      const input = getText().trim();
      // 需要跟参数的命令(如 /goal <条件>):只有命令本身、没参数时,回车不发送,等用户补参数
      if (ARG_CMDS.has(input)) return;
      const done = (fn: () => void) => { pushHistory(plainHist(input)); clearEditor(); fn(); };
      if (input.startsWith("!") && input.length > 1) { done(() => runTerminal(session.id, input.slice(1).trim())); return; }
      // /model /clear 前端拦截(SDK 控制方法,非 CLI 本地命令)
      if (input === "/model") { done(openModelMenu); return; }
      const mm = input.match(/^\/model\s+(\S+)$/);
      if (mm) {
        // 手输 model id 必须在模型表里(按 value/resolvedModel/model 匹配),否则静默透传给 SDK 会
        // 被 providerOf 当未知前缀回退到 claude,拿错 id 打 Anthropic 报"模型不存在"。命中后统一用 value 切换,
        // 顺带把裸 id(如 k3)归一成 kimi/k3。
        const hit = session.models.find((m) => m.value === mm[1] || m.resolvedModel === mm[1] || m.model === mm[1]);
        if (!hit) { done(() => dispatch({ type: "append", id: session.id, item: { kind: "system", text: t("未知模型「{{name}}」。用 /model 打开菜单选择;第三方模型 id 形如 provider/model(如 kimi/k3),别用连字符。", { name: mm[1] }), ts: Date.now() } })); return; }
        done(() => setModel(session.id, hit.value)); return;
      }
      if (input === "/clear") { done(() => clearContext(session.id)); return; }
      if (LOCAL_COMMANDS.has(input)) { done(() => runLocalCommand(input)); return; }
      compactCmd = input === "/compact";
      // 有待确认权限(非 AskUserQuestion)且输入了文本 → 作为回复发回 agent
      if (input && pendingPerm?.kind === "permission" && pendingPerm.toolName !== "AskUserQuestion") {
        done(() => respondPermission(session.id, pendingPerm.requestId, "deny", input));
        return;
      }
    }

    const blocks: any[] = [];
    let buf = "";
    // 保留换行/空行(所见即所发),只丢弃纯空白段;不再整体 trim 掉行结构
    const flush = () => { const t = buf.split(ZWSP).join(""); if (t.trim()) blocks.push({ type: "text", text: t }); buf = ""; };
    const walk = (root: Node) => root.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) buf += n.textContent ?? "";
      else if (n.nodeName === "BR") buf += "\n";
      else if (n instanceof HTMLElement && n.classList.contains("snip-tag")) {
        buf += n.dataset.snip || ""; // 引用片段:文本拼进当前段,和周围文字一起作为 prompt 发出
      } else if (n instanceof HTMLElement && n.classList.contains("img-tag")) {
        flush();
        const id = n.dataset.id; const img = id ? imgData.current.get(id) : undefined;
        if (img) blocks.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
      } else if (n instanceof HTMLElement) {
        if (n.nodeName === "DIV" && buf && !buf.endsWith("\n")) buf += "\n";
        walk(n);
      }
    });
    walk(ed); flush();
    if (blocks.length === 0) return;
    const outBlocks = expandSkillTags(blocks, session.info.skills ?? []);
    const snap = snapshot(); // 快照编辑器(含图片/引用 chip 的 html),给"编辑"按钮完整还原
    // agent 正在工作、上一轮还挂着后台任务在续跑(轮次未彻底了结)、或正在压缩上下文:
    // 都不打断,消息进待发区排队(最多 3),彻底完成后自动依次发出(闸见 sessionBusy)
    if (sessionBusy(session)) {
      // 没排上就别清编辑器 —— 用户写的东西还在框里,清一条待发就能直接再按一次
      if (!enqueuePending(session.id, { blocks: outBlocks, text: snap.text, html: snap.html, imgs: snap.imgs })) {
        toast(t("待发已满（最多 {{n}} 条）", { n: PENDING_MAX }));
        return;
      }
      pushHistory(snap); clearEditor();
      return;
    }
    sendMessage(session.id, outBlocks, { html: snap.html, imgs: snap.imgs });
    if (compactCmd) dispatch({ type: "compact_start", id: session.id }); // 进度条要排在 /compact 这条消息之后
    pushHistory(snap); // 先快照(含图片),再清空
    clearEditor();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // 中文输入法:确认候选词的那个回车绝不能当成"发送"。三重保险 ——
    //  1) compositionstart/end 维护的 composing 标记
    //  2) isComposing(Chrome 可靠)
    //  3) keyCode 229(WebKit/WKWebView 组合期间恒为 229,此时 isComposing 有时为 false)
    const ne = e.nativeEvent as any;
    if (composing.current || ne.isComposing || ne.keyCode === 229) return;
    // WebKit 有时把 compositionend 排在确认键的 keydown 之前,上面三个标记就都失效了。
    // 紧跟在组合结束后的回车视为"上屏确认",吞掉;真要发送再按一次。
    // 用 performance.now() 而不是 e.timeStamp:合成事件的 timeStamp 可能是 0 或另一套时钟,
    // 一旦算出负的时间差,这里就会把之后每一个回车都吃掉。
    if (e.key === "Enter" && performance.now() - compEndAt.current < 100) { e.preventDefault(); return; }

    // agent 运行中:Esc 不打断任务(已按用户要求禁用)

    // @ 文件菜单打开时优先吃掉导航键(⏎ 不能发送、Tab 不能去接受灰字建议)
    if (mention) {
      if (e.key === "Escape") { e.preventDefault(); mDismiss.current = true; setMention(null); return; }
      if (mItems.length) {
        const n = mItems.length;
        if (e.key === "ArrowDown") { e.preventDefault(); setMIdx((i) => (i + 1) % n); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setMIdx((i) => (i - 1 + n) % n); return; }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickMention(mItems[mIdx % n], true); return; }
        if (e.key === "Tab") { e.preventDefault(); pickMention(mItems[mIdx % n], false); return; }
      }
    }

    // # skill 菜单打开时同样优先吃掉导航键
    if (skillTok) {
      if (e.key === "Escape") { e.preventDefault(); sDismiss.current = true; setSkillTok(null); return; }
      if (sItems.length) {
        const n = sItems.length;
        if (e.key === "ArrowDown") { e.preventDefault(); setSIdx((i) => (i + 1) % n); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setSIdx((i) => (i - 1 + n) % n); return; }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); pickSkill(sItems[sIdx % n]); return; }
      }
    }

    // 灰字建议:Tab 接受;→ 在行尾时接受(命令面板打开时让 / 补全优先)
    if (suggestion && !paletteOpen) {
      if (e.key === "Tab") { e.preventDefault(); acceptSuggestion(); return; }
      if (e.key === "ArrowRight" && !e.shiftKey && caretAtEnd()) { e.preventDefault(); acceptSuggestion(); return; }
    }

    // 模型菜单打开时:↑↓ 选择、⏎ 确认、esc 关闭(优先级高于输入历史)
    if (modelMenu && session.models.length > 0) {
      const n = session.models.length;
      if (e.key === "ArrowDown") { e.preventDefault(); setPalIdx((i) => (i + 1) % n); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPalIdx((i) => (i - 1 + n) % n); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setModel(session.id, session.models[palIdx % n].value); setModelMenu(false); return; }
    }

    // 权限快捷键(完全空时)—— AskUserQuestion 交给问答卡自己处理,不在此拦截
    if (isEmpty && pendingPerm?.kind === "permission" && pendingPerm.toolName !== "AskUserQuestion") {
      if (e.key === "Enter") { e.preventDefault(); respondPermission(session.id, pendingPerm.requestId, "allow"); return; }
      // esc 不再等于拒绝:误按一下就把整轮改动废掉,代价太大。拒绝只能点按钮。
    }
    // 命令面板导航
    if (paletteOpen && filtered.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPalIdx((i) => (i + 1) % filtered.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPalIdx((i) => (i - 1 + filtered.length) % filtered.length); return; }
      if (e.key === "Tab") { e.preventDefault(); setEditorText(filtered[palIdx].cmd + " "); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filtered[palIdx].cmd);
        return;
      }
      if (e.key === "Escape") { setEditorText(""); return; }
    }
    // 模型菜单打开时:esc 关闭
    if (modelMenu && e.key === "Escape") { e.preventDefault(); setModelMenu(false); return; }
    // 输入历史:光标停在第一位时 ↑/↓ 翻历史,不限次数。判据从"框里是空的"改成"光标在最前面",
    // 加上每翻一条都把光标钉回第一位,连按 ↑ 就能一路往上翻;光标不在第一位时方向键照常移动光标,
    // 两种意图不会打架。
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && caretAtStart()) {
      const h = hist();
      const next = histIdx.current + (e.key === "ArrowUp" ? 1 : -1);
      if (next < -1) return;                            // 已经在最新一条之下:↓ 交还给光标
      if (next >= h.length) { e.preventDefault(); return; } // 到头了就停住,别掉回"移动光标"
      e.preventDefault();
      if (histIdx.current === -1) histDraft.current = snapshot(); // 开始翻之前先把手上这份收好
      histIdx.current = next;
      if (next >= 0) restoreHistory(h[next]);
      else if (histDraft.current && (histDraft.current.text || hasImgs(histDraft.current))) restoreHistory(histDraft.current);
      else clearEditor();
      return;
    }
    // backspace 落在图片 chip 之后(隔着零宽字符)时,一次删掉整块,不用先删掉那个看不见的零宽字符再删一次。
    if (e.key === "Backspace") {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.rangeCount) {
        const chip = chipBeforeCaret(sel);
        if (chip) {
          e.preventDefault();
          const id = chip.dataset.id; if (id) imgData.current.delete(id);
          const parent = chip.parentNode as Node;
          const lead = chip.previousSibling, tail = chip.nextSibling;
          const before = (lead && lead.nodeType === 3 && lead.textContent === ZWSP) ? lead.previousSibling : lead;
          if (tail && tail.nodeType === 3 && tail.textContent === ZWSP) (tail as ChildNode).remove();
          if (lead && lead.nodeType === 3 && lead.textContent === ZWSP) (lead as ChildNode).remove();
          chip.remove();
          const r = document.createRange();
          if (before && before.parentNode) r.setStartAfter(before); else r.setStart(parent, 0);
          r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
          renumber(); syncText(); return;
        }
        // 光标停在"行首 + 右边紧挨着 chip":这里按退格应当删掉前面那个换行,把 chip 并到上一行末尾。
        // WKWebView 的默认退格在这个位置会失手 —— chip 是 contenteditable=false 的原子块,它的
        // 跨行合并 fixup 处理不了,结果不是删掉换行而是又多塞一行(光标独占空行、chip 被顶到下一行)。
        // 自己删这个 <br>,行为就确定了。
        const prev = siblingAtCaret(sel, "prev");
        if (atChipLineStart(sel) && prev && prev.nodeName === "BR") {
          e.preventDefault();
          const parent = prev.parentNode;
          if (parent) {
            // 先记住下标再删:删完 range 才好落在"原来 <br> 所在的位置"= 上一行行尾
            const idx = Array.prototype.indexOf.call(parent.childNodes, prev);
            (prev as ChildNode).remove();
            const r = document.createRange();
            r.setStart(parent, idx); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
          }
          syncText(); return;
        }
      }
    }
    // shift+方向键:交给浏览器默认扩选(批量选中);不做零宽跳格,否则会破坏选区。
    // 无 shift:图片标签两侧垫了零宽字符,方向键跨它时"按一次光标没动"。把零宽停顿并进相邻移动,单次按键即可见移动。
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey) {
      const sel = window.getSelection() as any;
      const ed = edRef.current;
      if (sel && sel.isCollapsed && typeof sel.modify === "function" && ed && ed.contains(sel.anchorNode)) {
        // 光标正紧贴一个 chip:直接落到它另一侧,一步到位。绕开 WKWebView modify 的不确定性 ——
        // 它有时把折叠光标塞进原子 chip 内部,随后 selectionchange 的兜底又统一弹到 chip 之后,
        // 于是"想往左跨到 chip 左侧"却停在了右侧。确定性地 setStartBefore/After 就不会被兜底纠偏。
        const adj = e.key === "ArrowLeft" ? chipBeforeCaret(sel) : chipAfterCaret(sel);
        if (adj) {
          e.preventDefault();
          const r = document.createRange();
          if (e.key === "ArrowLeft") r.setStartBefore(adj); else r.setStartAfter(adj);
          r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
          return;
        }
        const dir = e.key === "ArrowRight" ? "forward" : "backward";
        const beforeN = sel.anchorNode, beforeO = sel.anchorOffset;
        sel.modify("move", dir, "character");
        // WKWebView 里光标紧贴原子 chip 时,首次 modify 有时原地不动,需要再推一次(否则要按两下方向键)。
        if (sel.anchorNode === beforeN && sel.anchorOffset === beforeO) sel.modify("move", dir, "character");
        let guard = 0;
        // 跳零宽时停住的两个真实落点:
        //  - 前移落到"行首 + 右边是 chip":chip 左边这个真实位置(见 atChipLineStart)
        //  - 后移落到"紧贴 chip 左侧(即 chip 右侧)":上一行行尾以 chip 收尾时,从下一行行首按 ← 应停在这儿,
        //    而不是被零宽推格一路跨过 chip 推到 chip 开头。
        while (guard++ < 4 && crossedZwsp(sel, dir)
          && !(dir === "forward" && atChipLineStart(sel))
          && !(dir === "backward" && chipBeforeCaret(sel)))
          sel.modify("move", dir, "character");
        if (sel.anchorNode === beforeN && sel.anchorOffset === beforeO) return; // 到边界没动,交回默认
        e.preventDefault(); return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  // 复制/剪切:选区里没有 chip 就交给浏览器默认(更准);有 chip 才自己序列化两种格式。
  function onCopyCut(e: React.ClipboardEvent, cut: boolean) {
    const sel = window.getSelection(); const ed = edRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !ed || !ed.contains(sel.anchorNode)) return;
    const frag = sel.getRangeAt(0).cloneContents();
    if (!frag.querySelector(".img-tag")) return;
    const { plain, html } = serializeFragment(frag, imgData.current);
    e.preventDefault();
    e.clipboardData.setData("text/plain", plain);
    e.clipboardData.setData("text/html", html);
    // 剪切走 execCommand:进 WebKit 撤销栈,⌘Z 能整块还原。图片数据留在 imgData 里(没 chip 引用就不会被发出去)
    if (cut) { document.execCommand("delete"); renumber(); syncText(); }
  }

  // 粘贴:图片插到光标处;文本以纯文本插入(避免带样式 HTML)
  function onPaste(e: React.ClipboardEvent) {
    // 自家 chip 回贴:认 data-cc-* 标记,按原顺序重建 chip 和文字(优先于下面的图片分支 ——
    // 这种剪贴板里只有 text/html,没有图片文件)
    const ccHtml = e.clipboardData.getData("text/html");
    if (ccHtml && /data-cc-(img|snip)/.test(ccHtml)) {
      e.preventDefault();
      const doc = new DOMParser().parseFromString(ccHtml, "text/html");
      const walk = (root: Node) => root.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) { const t = n.textContent || ""; if (t) document.execCommand("insertText", false, t); }
        else if (n.nodeName === "BR") document.execCommand("insertText", false, "\n");
        else if (n instanceof HTMLImageElement && n.dataset.ccImg) {
          const m = /^data:([^;]+);base64,(.*)$/.exec(n.getAttribute("src") || "");
          if (m) insertChip({ media_type: m[1], data: m[2] });
        } else if (n instanceof HTMLElement && n.dataset.ccSnip !== undefined) insertSnippetChip(n.dataset.ccSnip || "");
        else walk(n); // WebKit 会在外面套一层 <span style=…>,穿过去继续找
      });
      walk(doc.body);
      syncText();
      return;
    }
    // 当前模型不吃图片(DeepSeek/GLM/Qwen 这些编程端点)：在这儿就拦下并说清楚。
    // 放进去只会在发送时挨一个 400,用户看到的是"发不出去"而不是"这个模型不支持"。
    const hasImg = Array.from(e.clipboardData.items).some((it) => it.type.startsWith("image/"));
    if (hasImg && !canSendImage(session, state.auth?.providers)) {
      e.preventDefault();
      toast(t("当前模型不支持图片，已忽略(可在设置的模型表里加 \"vision\": true 覆盖)"), "info");
      return;
    }
    let handledImg = false;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault(); handledImg = true;
        const file = item.getAsFile(); if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => insertChip({ media_type: item.type, data: (reader.result as string).split(",")[1] });
        reader.readAsDataURL(file);
      }
    }
    if (handledImg) return;
    const txt = e.clipboardData.getData("text/plain");
    // 走 execCommand:插入进 WebKit 撤销栈,和打字一视同仁,Ctrl+Z 按录入顺序回退。
    // 原来用 DOM Range 手插是为躲"--"→"—"替换,但那样不进撤销栈;现改由原生侧
    // 关掉智能替换(见 main.rs disable_smart_substitution),execCommand 也不再改坏文本。
    // unwrapSoftBreaks:从窄栏(终端/markdown 源/邮件)复制来的文字每行都带硬换行,贴进来右侧空一大片,
    // 还得手动删换行。段内折行并回去,列表/空行/代码原样(见 lib/unwrap.ts)。
    // 剪贴板带块级 HTML(列表/段落)时换行是结构性的,跳过合并(见 htmlHasBlocks)
    if (txt) { e.preventDefault(); document.execCommand("insertText", false, htmlHasBlocks(ccHtml) ? txt : unwrapSoftBreaks(txt)); syncText(); }
  }

  // 点标签看大图(事件委托)。删除只靠退格 —— chip 不再画 × 按钮。
  // 用 mousedown 而非 click:WKWebView 里编辑器聚焦时,第一次点 chip 只挪光标不派发 click,导致要点两次。
  function onEditorMouseDown(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    const chip = target.closest?.(".img-tag") as HTMLElement | null;
    if (chip && edRef.current?.contains(chip)) {
      const id = chip.dataset.id; const img = id ? imgData.current.get(id) : undefined;
      if (img) { e.preventDefault(); openImageWindow(`data:${img.media_type};base64,${img.data}`, chip.textContent?.trim() || t("图片")); }
    }
  }

  // 悬浮图片标签 -> 用固定定位的浮层预览(不受编辑器 overflow 裁剪)
  function onEditorOver(e: React.MouseEvent) {
    const chip = (e.target as HTMLElement).closest?.(".img-tag") as HTMLElement | null;
    if (chip && edRef.current?.contains(chip)) {
      const id = chip.dataset.id; const img = id ? imgData.current.get(id) : undefined;
      if (img) {
        const r = chip.getBoundingClientRect();
        setPreview({ src: `data:${img.media_type};base64,${img.data}`, left: r.left, top: r.top - 6 });
        return;
      }
    }
  }
  function onEditorOut(e: React.MouseEvent) {
    const to = e.relatedTarget as HTMLElement | null;
    if (!to || !to.closest?.(".img-tag")) setPreview(null);
  }

  // c: 切换会话时保存/恢复各自草稿(编辑器不受控,直接存 DOM HTML + 图片数据)
  useEffect(() => {
    const ed = edRef.current;
    const d = draftStore.get(session.id);
    histIdx.current = -1; histDraft.current = null; // 历史是按会话分的,翻到第几条也别跟过来
    if (ed) {
      ed.innerHTML = d?.html ?? "";
      imgData.current = new Map(Object.entries(d?.imgs ?? {}));
      const maxId = Math.max(-1, ...[...imgData.current.keys()].map(Number).filter((n) => !isNaN(n)));
      idc.current = maxId + 1;
      syncText(); setPreview(null); setSuggestion("");
      // 候选菜单只属于唤起它的那个会话。Chat 没给 Composer 加 key,切会话复用同一个实例,
      // 而 @ / # 的 token 是从当时那个编辑器的选区算出来的 —— 编辑器已经换成新会话的草稿,
      // 菜单再挂着就是个跟谁都对不上的空列表(还会替换错文本)。连同浏览目录一起收掉。
      setMention(null); setSkillTok(null); setMDir("");
      mDismiss.current = false; sDismiss.current = false;
    }
    return () => {
      const ed2 = edRef.current; if (!ed2) return;
      const html = ed2.innerHTML;
      if (html.trim() && (nodeText(ed2).trim() || ed2.querySelector(".img-tag")))
        draftStore.set(session.id, { html, imgs: Object.fromEntries(imgData.current) });
      else draftStore.delete(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // 拖拽文件夹/文件到窗口 -> 在光标处插入其绝对路径(仅 Tauri 窗口;浏览器拿不到真实路径,直接跳过)
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent((e: any) => {
          if (e.payload?.type !== "drop" || !Array.isArray(e.payload.paths) || !e.payload.paths.length) return;
          const ed = edRef.current; if (!ed) return;
          ed.focus();
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) {
            const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
            sel?.removeAllRanges(); sel?.addRange(r);
          }
          // 路径含空格时加引号,便于作为终端参数
          const paths = e.payload.paths.map((p: string) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
          document.execCommand("insertText", false, paths + " ");
          syncText();
        });
        if (cancelled) un(); else unlisten = un;
      } catch { /* 非 Tauri 或 API 不可用,忽略 */ }
    })();
    return () => { cancelled = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // agent 运行/等待中:⌘C 打断已按用户要求禁用,选中文本时系统正常复制

  // "忙" = 正在跑,或上一轮挂着没退出的后台任务(轮次未了结)。判据必须和 submit 里入队那处一致 ——
  // 之前打断按钮只认 running,于是"挂着后台任务"这个态既发不出消息(入队)又打不断(按钮不渲染),
  // 后台任务如果永不退出(比如 agent 起了个常驻进程),待发队列就死在那儿,没有任何出口。
  const busy = session.status === "running" || !!session.bgWait;
  const hasActions = busy || !isEmpty;

  return (
    <div className="composer">
      {/* 待发队列:agent 忙时排队,紧贴输入框上方、左侧缩进。先发的在最上,每行超长省略,最右可取消 */}
      {(session.pending?.length ?? 0) > 0 && (
        <div className="pending-queue">
          {session.pending!.map((p, i) => (
            <div key={p.pid} className="pending-row">
              <span className="pending-tag">{t("排队{{n}}", { n: i + 1 })}</span>
              {/* title:这行是 nowrap + 省略号,长消息看不全;悬停给全文,选中复制拿到的也是全文 */}
              <span className="pending-text" title={p.text}>{p.text || t("（图片）")}</span>
              {/* 斜杠命令排队时点明"本轮结束后执行":否则用户看不出命令是被吞了还是在等,
                  /compact 尤其容易误以为"任务被打断了/命令没生效" */}
              {/^\/\S+$/.test(p.text.trim()) && <span className="pending-note">{t("本轮结束后执行")}</span>}
              <button className="pending-cancel" title={t("取消这条待发消息")} onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); cancelPending(session.id, p.pid); } }}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
      {paletteOpen && filtered.length > 0 && (
        <div className="palette">
          <div className="palette-scroll">
            {filtered.map((c, i) => (
              <div key={c.cmd} ref={i === palIdx ? selItemRef : undefined}
                className={`palette-item ${i === palIdx ? "sel" : ""}`}
                onMouseEnter={() => setPalIdx(i)}
                onClick={() => selectCommand(c.cmd)}>
                <b>{c.cmd}</b> <span className="muted">{t(c.desc)}</span>
              </div>
            ))}
          </div>
          <div className="palette-hint">{t("↑↓ 选择 · Tab 补全 · ⏎ 执行")}</div>
        </div>
      )}
      {modelMenu && (
        <div className="palette" ref={modelMenuRef}>
          <div className="palette-scroll">
            {session.models.map((m, i) => (
              <div key={m.value} ref={i === palIdx ? selItemRef : undefined}
                className={`palette-item ${i === palIdx ? "sel" : ""}`}
                onMouseEnter={() => setPalIdx(i)}
                // mousedown 而非 click:WKWebView 里编辑器聚焦时首个 click 只挪光标/激活焦点被吞,要点两次
                onMouseDown={(e) => { e.preventDefault(); setModel(session.id, m.value); setModelMenu(false); }}>
                {/* 菜单里也走 modelName:选中后底栏显示什么,菜单里就该长什么样(default 那条尤其) */}
                <div><b>{modelName(session.models, m)}</b>{m.value === session.info.model && <span className="muted">{t(" · 当前")}</span>}
                {m.description && <div className="muted">{m.description}</div>}</div>
              </div>
            ))}
            {session.models.length === 0 && <div className="palette-item muted">{t("模型列表加载中…")}</div>}
          </div>
          <div className="palette-hint">{t("点击选择 · esc 取消")}</div>
        </div>
      )}
      {mention && (
        // @ 文件选择:空 query = 按目录树浏览;有 query = 全项目过滤。选中后插入 @相对路径
        <div className="palette">
          <div className="palette-head">
            {mQuery ? <>{t("过滤")} <b>{mQuery}</b> · {mItems.length} {t("项")}</> : <><Folder size={13} /> {mDir || t("项目根目录")}</>}
          </div>
          <div className="palette-scroll">
            {mItems.map((e, i) => (
              <div key={e.path} ref={i === mIdx ? selItemRef : undefined}
                className={`palette-item mention-item ${i === mIdx ? "sel" : ""}`}
                onMouseEnter={() => setMIdx(i)}
                // 必须 mousedown+preventDefault:click 会先让编辑器失焦,选区一丢就找不到要替换的 @token 了
                onMouseDown={(ev) => { ev.preventDefault(); pickMention(e, true); }}>
                <span className="mention-ico">{e.path === ".." ? <CornerLeftUp size={14} /> : e.dir ? <Folder size={14} /> : <File size={14} />}</span>
                <b>{e.path === ".." ? t("上一级") : baseName(e.path)}{e.dir && e.path !== ".." ? "/" : ""}</b>
                {e.path !== ".." && dirName(e.path) && <span className="muted mention-dir">{dirName(e.path)}</span>}
              </div>
            ))}
            {!mItems.length && <div className="palette-item muted">{mQuery ? t("没有匹配的文件") : t("空目录")}</div>}
          </div>
          <div className="palette-hint">{t("↑↓ 选择 · ⏎")} {mQuery ? t("插入(文件夹则进入)") : t("打开文件夹/选择文件")} {t(" · Tab 直接插入路径 · esc 关闭")}</div>
        </div>
      )}
      {skillTok && (
        // # skill 选择:选中插入 #name 标记,发送时翻译成 "Use the <name> skill."
        <div className="palette">
          <div className="palette-head">
            <Sparkles size={13} /> Skills{sQuery ? <> · {t("过滤")} <b>{sQuery}</b></> : null} · {sItems.length} {t("项")}
          </div>
          <div className="palette-scroll">
            {sItems.map((n, i) => (
              <div key={n} ref={i === sIdx ? selItemRef : undefined}
                className={`palette-item mention-item ${i === sIdx ? "sel" : ""}`}
                onMouseEnter={() => setSIdx(i)}
                // 同 @ 菜单:必须 mousedown+preventDefault,否则编辑器先失焦、选区丢了就找不到要替换的 token
                onMouseDown={(ev) => { ev.preventDefault(); pickSkill(n); }}>
                <span className="mention-ico"><Sparkles size={14} /></span>
                <b>{n}</b>
                {extNote(n, sDesc[n]) && <span className="muted skill-desc" title={extNote(n, sDesc[n])}>{extNote(n, sDesc[n])}</span>}
              </div>
            ))}
            {!sItems.length && <div className="palette-item muted">{(session.info.skills ?? []).length ? t("没有匹配的 skill") : t("会话还没上报 skill 列表")}</div>}
          </div>
          <div className="palette-hint">{t("↑↓ 选择 · ⏎/Tab 插入 · esc 关闭 · 发送时自动转成显式调用")}</div>
        </div>
      )}
      {session.status === "closed" ? (
        <div className="reconnect-bar" onMouseDown={(e) => { if (e.button === 0) reopenSession(session.id); }}><RotateCw size={14} /> {t("会话已断开 · 点此重连")}</div>
      ) : (
      <>
      {compacting && (
        <div className="compact-bar">
          <span>{t("✻ 正在压缩上下文…可以继续输入，消息会排队等压缩完成")}</span>
          <div className="compact-track"><div className="compact-fill det" style={{ width: `${compactPct}%` }} /></div>
          <span className="compact-pct">{compactPct}%</span>
          {/* 手动出口:压缩期 status 是 idle,输入框右侧那个「停止」按钮不渲染,这里是唯一能断掉的地方。
              interrupt 让 SDK 停下,compact_finish 收掉 running —— 排队的消息随即自动发出。 */}
          <button className="compact-cancel" title={t("停止压缩，并放行排队的消息")}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              interrupt(session.id);
              dispatch({ type: "compact_finish", id: session.id, patch: { error: t("已手动取消") } });
            }}>{t("取消")}</button>
        </div>
      )}
      <div className="star-border">
      <div className={`input-box sb-inner input-glow ${shellMode ? "shell-mode" : ""} ${hasActions ? "has-actions" : ""} ${busy && !isEmpty ? "two-actions" : ""}`} onMouseMove={onEdgeGlow}>
        {isEmpty && (
          <div className="editor-ph">{pendingPerm ? t("⏎ 允许 · esc 拒绝 · 或输入消息") : t("输入消息")}</div>
        )}
        {suggestion && (
          // 灰字建议叠层:透明的已输入文本占位,把灰色补全推到光标之后(Tab/→ 接受)
          <div className="ghost-overlay" aria-hidden>
            <span className="ghost-typed">{text}</span><span className="ghost-sug">{suggestion}</span>
          </div>
        )}
        <div
          ref={edRef}
          className="editor"
          contentEditable
          suppressContentEditableWarning
          // 手动改了内容就退出"翻历史"状态:框里已经是他自己的东西了,下一下 ↑ 该从最新一条重新数。
          // 回显历史走 innerHTML 直赋值,不触发 input,不会误伤。
          onInput={() => { histIdx.current = -1; histDraft.current = null; syncText(); refreshMention(); }}
          onKeyDown={onKeyDown}
          onKeyUp={refreshMention}
          onPaste={onPaste}
          onCopy={(e) => onCopyCut(e, false)}
          onCut={(e) => onCopyCut(e, true)}
          onMouseDown={onEditorMouseDown}
          onMouseUp={() => { syncText(); refreshMention(); }}
          onMouseOver={onEditorOver}
          onMouseOut={onEditorOut}
          onBlur={() => setMention(null)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => { composing.current = false; compEndAt.current = performance.now(); syncText(); refreshMention(); }}
        />
        {shellMode && <div className="shell-mode-hint">!&nbsp; shell mode</div>}
        {hasActions && (
          <div className="input-actions">
            {busy && (
              <button className="input-btn interrupt"
                title={session.status === "running" ? t("打断 (⌘C)") : t("不等后台任务了,立刻放行待发消息")}
                onMouseDown={(e) => { e.preventDefault(); interrupt(session.id); }}><span className="stop-dot" /> {session.status === "running" ? t("打断") : t("不等了")}</button>
            )}
            {!isEmpty && (
              <button className="input-btn send" title={t("发送 (⏎)")} onMouseDown={(e) => { e.preventDefault(); submit(); }}>{t("发送")}</button>
            )}
          </div>
        )}
      </div>
      </div>
      </>
      )}
      {preview && (
        <img className="img-preview-float" src={preview.src}
          style={{ left: preview.left, top: preview.top, transform: "translateY(-100%)" }} />
      )}
      <div className="model-line">
        <button className="model-switch" ref={modelBtnRef} title={t("切换模型（同 /model）")}
          onMouseDown={(e) => { e.preventDefault(); openModelMenu(); }}>
          <strong>{modelLabel(session) || t("模型连接中…")}</strong>
          <ChevronDown size={12} />
        </button>
        <UsageBar session={session} auto={!!state.autoAllow[session.id]}
          mode={state.permMode[session.id] ?? "default"}
          onPreset={(key) => setPermissionPreset(session.id, key)} />
      </div>
    </div>
  );
}
