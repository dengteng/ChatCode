import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, ArrowUp, X, ChevronDown, Info, Folder, File, CornerLeftUp, Sparkles, History } from "lucide-react";
import { BUILTIN_COMMANDS, modelName } from "../types";
import { useStore } from "../store";
import { openImageWindow } from "../popout";
import { onEdgeGlow } from "../lib/edgeGlow";
import { unwrapSoftBreaks, htmlHasBlocks } from "../lib/unwrap";
import { HomeInfoPanel } from "./InfoPanel";
import { useTranslation } from "react-i18next";
import { btnPress } from "../lib/utils";

interface Img { media_type: string; data: string }
const ZWSP = "​";
// 和会话输入框一致的图片 chip 图标
const IMG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;

// @ 提及:从项目目录里挑文件/文件夹(和 Composer 同一套,首页没会话,mentionRoot 直接用所选 cwd)
interface FileEntry { path: string; dir: boolean } // path = 相对项目根目录
const walkCache = new Map<string, { at: number; list: FileEntry[] }>();
async function projectFiles(root: string): Promise<FileEntry[]> {
  const hit = walkCache.get(root);
  if (hit && Date.now() - hit.at < 15000) return hit.list;
  const raw = await invoke<[string, boolean][]>("walk_project", { root }).catch(() => [] as [string, boolean][]);
  const list = raw.map(([path, dir]) => ({ path, dir }));
  walkCache.set(root, { at: Date.now(), list });
  return list;
}
const baseName = (p: string) => p.split("/").pop() || p;
const dirName = (p: string) => p.split("/").slice(0, -1).join("/");
function scoreEntry(e: FileEntry, q: string): number {
  const path = e.path.toLowerCase(), name = baseName(path);
  let s = 0;
  if (name.startsWith(q)) s = 100;
  else if (name.includes(q)) s = 70;
  else if (path.includes(q)) s = 40;
  else return 0;
  if (!e.dir) s += 5;
  return s - Math.min(20, path.length / 8);
}

// 首页草稿:切到会话再切回来,本组件是整个卸载重建的,本地 state + contentEditable 全丢。
// 存模块级(不落盘):选的目录、编辑器 HTML、图片数据都原样带回;发送成功才清。重启 app 清空,够用。
const draft: { cwd: string; html: string; imgs: Map<string, Img>; idc: number } =
  { cwd: "", html: "", imgs: new Map(), idc: 0 };

// 空态(未打开任何会话)时,主区底部的快捷输入框:发消息即建会话。
// 输入区是 contentEditable —— 粘贴的图片以内联 chip 插在光标处、和文本混排,发送时拆成 image/text 块(与会话输入框一致)。
// 也支持 /(内置命令补全)、@(选项目文件)、#(skill —— 首页无会话拿不到列表,只提示建会话后可用)。
export function EmptyComposer() {
  const { t } = useTranslation();
  const { state, startSessionWithMessage, requestHomeModels, setHomeModel, restoreSession } = useStore();
  const [cwd, setCwd] = useState(draft.cwd);
  const [text, setText] = useState("");        // 纯文本镜像:驱动 / 命令面板与占位符
  const [imgCount, setImgCount] = useState(0);
  const [hasContent, setHasContent] = useState(false);
  const [preview, setPreview] = useState<{ src: string; left: number; top: number } | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [palIdx, setPalIdx] = useState(0);
  // @ 提及:mention=光标处的 @token(null=菜单关);mDir=浏览模式当前目录;mAll=全量索引(过滤用)
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [mDir, setMDir] = useState("");
  const [mEntries, setMEntries] = useState<FileEntry[]>([]);
  const [mAll, setMAll] = useState<FileEntry[]>([]);
  const [mIdx, setMIdx] = useState(0);
  const mDismiss = useRef(false);
  const [skillTok, setSkillTok] = useState<{ query: string } | null>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<HTMLSpanElement>(null);
  const edRef = useRef<HTMLDivElement>(null);
  const imgData = useRef<Map<string, Img>>(draft.imgs); // 同一个 Map 引用:增删自动进草稿
  const idc = useRef(draft.idc);

  // 草稿:挂载灌回编辑器,卸载存下来(切会话再切回首页不丢)
  useEffect(() => {
    const ed = edRef.current;
    if (ed && draft.html) { ed.innerHTML = draft.html; refresh(); }
    // 这个目录已经有会话了就把 chip 摘掉:点加号的意思是"再开一个新的",不是"接着刚才那个项目"。
    // 还没建过会话的目录留着 —— 那是用户选了还没发,清掉等于白选一次。
    if (draft.cwd && state.index.some((e) => !e.casual && e.cwd === draft.cwd)) setCwd("");
    return () => { draft.html = edRef.current?.innerHTML ?? ""; draft.idc = idc.current; };
  }, []);
  useEffect(() => { draft.cwd = cwd; }, [cwd]);

  // 首页无会话:模型列表走 sidecar 缓存的 Claude 列表 + 已配置 provider。连上后拉一次。
  useEffect(() => { if (state.connected) requestHomeModels(); }, [state.connected]);
  // 点菜单外收起(模型菜单 / 最近历史共用一套)
  useEffect(() => {
    if (!modelMenu && !histOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelMenu && !modelMenuRef.current?.contains(e.target as Node)) setModelMenu(false);
      if (histOpen && !histRef.current?.contains(e.target as Node)) setHistOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelMenu, histOpen]);
  const curModel = state.homeModels.find((m) => m.value === state.homeModel);
  const modelText = curModel ? modelName(state.homeModels, curModel)
    : (state.homeModel === "default" ? t("默认模型") : state.homeModel);

  const pick = async () => { try { const p = await invoke<string | null>("choose_directory"); if (p) setCwd(p); } catch { /* 取消选择 */ } };

  // / 命令面板(首页只有内置命令,插件/skill 命令要建会话后 init 才有)
  const paletteOpen = imgCount === 0 && text.startsWith("/") && !text.includes(" ");
  const filtered = paletteOpen ? BUILTIN_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(text.toLowerCase())) : [];
  useEffect(() => { setPalIdx(0); }, [text]);

  const refresh = () => {
    const ed = edRef.current; if (!ed) return;
    const imgs = ed.querySelectorAll(".img-tag").length;
    const txt = (ed.textContent ?? "").split(ZWSP).join("");
    setImgCount(imgs); setText(txt);
    setHasContent(imgs > 0 || !!txt.trim());
    refreshMention();
  };

  // 光标正前方的触发 token(@ 选文件 / # 选 skill):触发符必须在行首或空白后,与光标之间无空格
  function triggerToken(ch: string): { query: string; node: Text; start: number } | null {
    const sel = window.getSelection(); const ed = edRef.current;
    if (!sel || !sel.isCollapsed || !sel.rangeCount || !ed || !ed.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const at = before.lastIndexOf(ch);
    if (at < 0) return null;
    const prev = at > 0 ? before[at - 1] : "";
    if (prev && !/\s/.test(prev) && prev !== ZWSP) return null;
    const query = before.slice(at + 1);
    if (/[\s@#]/.test(query)) return null;
    return { query, node: node as Text, start: at };
  }
  function refreshMention() {
    const t = triggerToken("@");
    if (!t) { mDismiss.current = false; setMention(null); setMDir(""); }
    else setMention(mDismiss.current ? null : { query: t.query });
    const s = triggerToken("#");
    setSkillTok(s ? { query: s.query } : null);
  }
  // 用选中项替换 "<ch>query"(replacement 自带前缀),走 execCommand 保留撤销栈
  function replaceToken(ch: string, replacement: string) {
    const t = triggerToken(ch); const sel = window.getSelection();
    if (!t || !sel) return;
    const r = document.createRange();
    r.setStart(t.node, t.start); r.setEnd(t.node, t.start + 1 + t.query.length);
    sel.removeAllRanges(); sel.addRange(r);
    document.execCommand("insertText", false, replacement);
    refresh();
  }
  function pickMention(e: FileEntry, enter: boolean) {
    edRef.current?.focus();
    if (e.path === "..") { setMDir((d) => d.split("/").slice(0, -1).join("/")); setMIdx(0); return; }
    if (e.dir && enter) { setMDir(e.path); setMIdx(0); replaceToken("@", "@"); return; }
    replaceToken("@", `@${e.path}${e.dir ? "/" : ""} `);
  }

  // 把整块内容替换成纯文本(命令补全用),光标置末尾
  function setEditorText(s: string) {
    const ed = edRef.current; if (!ed) return;
    ed.innerHTML = ""; imgData.current.clear();
    if (s) ed.appendChild(document.createTextNode(s));
    ed.focus();
    const sel = window.getSelection();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    sel?.removeAllRanges(); sel?.addRange(r);
    refresh();
  }

  const mQuery = mention?.query ?? "";
  const mentionRoot = cwd; // 首页 @ 的根 = 所选项目目录;没选(闲聊)则拿不到文件,菜单为空
  useEffect(() => { if (mention && mentionRoot) projectFiles(mentionRoot).then(setMAll); }, [!!mention, mentionRoot]);
  useEffect(() => {
    if (!mention || mQuery || !mentionRoot) return;
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

  const insertChip = (img: Img) => {
    const ed = edRef.current; if (!ed) return;
    const id = String(idc.current++);
    imgData.current.set(id, img);
    const chip = document.createElement("span");
    chip.className = "img-tag"; chip.contentEditable = "false"; chip.dataset.id = id;
    chip.innerHTML = `<span class="img-tag-label">${IMG_ICON_SVG} ${t("图片")}</span><button class="img-tag-x" tabindex="-1" contenteditable="false">×</button>`;
    ed.focus();
    const sel = window.getSelection();
    let r: Range;
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) { r = sel.getRangeAt(0); r.deleteContents(); }
    else { r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); }
    // chip 前后各垫零宽字符:光标能落到 chip 前/后继续输入;拆 block 时 split(ZWSP) 去掉
    const tail = document.createTextNode(ZWSP);
    const frag = document.createDocumentFragment();
    frag.append(document.createTextNode(ZWSP), chip, tail);
    r.insertNode(frag);
    r.setStart(tail, 1); r.collapse(true);
    sel?.removeAllRanges(); sel?.addRange(r);
    refresh();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    let handledImg = false;
    for (const item of e.clipboardData.items) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault(); handledImg = true;
      const file = item.getAsFile(); if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => insertChip({ media_type: item.type, data: (reader.result as string).split(",")[1] });
      reader.readAsDataURL(file);
    }
    if (handledImg) return;
    const txt = e.clipboardData.getData("text/plain");
    // 和会话输入框一致:段内的排版折行并回去;带块级 HTML 的换行是结构性的,不并(见 lib/unwrap.ts)
    const html = e.clipboardData.getData("text/html");
    if (txt) { e.preventDefault(); document.execCommand("insertText", false, htmlHasBlocks(html) ? txt : unwrapSoftBreaks(txt)); refresh(); }
  };

  // 点 × 删图;点标签其余部分看大图(和会话输入框一致,mousedown 避免 WKWebView 首点只挪光标)
  const onEditorMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.classList?.contains("img-tag-x")) {
      e.preventDefault();
      const chip = target.closest<HTMLElement>(".img-tag");
      const id = chip?.dataset.id; if (id) imgData.current.delete(id);
      chip?.remove(); refresh(); setPreview(null); edRef.current?.focus();
      return;
    }
    const chip = target.closest?.(".img-tag") as HTMLElement | null;
    if (chip && edRef.current?.contains(chip)) {
      const id = chip.dataset.id; const img = id ? imgData.current.get(id) : undefined;
      if (img) { e.preventDefault(); openImageWindow(`data:${img.media_type};base64,${img.data}`, t("图片")); }
    }
  };

  // 悬浮标签 -> 固定定位浮层缩略图
  const onEditorOver = (e: React.MouseEvent) => {
    const chip = (e.target as HTMLElement).closest?.(".img-tag") as HTMLElement | null;
    if (chip && edRef.current?.contains(chip)) {
      const id = chip.dataset.id; const img = id ? imgData.current.get(id) : undefined;
      if (img) { const r = chip.getBoundingClientRect(); setPreview({ src: `data:${img.media_type};base64,${img.data}`, left: r.left, top: r.top - 6 }); }
    }
  };
  const onEditorOut = (e: React.MouseEvent) => {
    const to = e.relatedTarget as HTMLElement | null;
    if (!to || !to.closest?.(".img-tag")) setPreview(null);
  };

  const submit = () => {
    const ed = edRef.current; if (!ed || !state.connected) return;
    const blocks: any[] = [];
    let buf = "";
    const flush = () => { const t = buf.split(ZWSP).join(""); if (t.trim()) blocks.push({ type: "text", text: t }); buf = ""; };
    const walk = (root: Node) => root.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) buf += n.textContent ?? "";
      else if (n.nodeName === "BR") buf += "\n";
      else if (n instanceof HTMLElement && n.classList.contains("img-tag")) {
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
    startSessionWithMessage(cwd, blocks); // cwd 为空 = 闲聊会话
    // 发出去了才清草稿正文;目录这里不清 —— 下次挂载时那个目录已经有会话了,上面那条会把它摘掉
    ed.innerHTML = ""; imgData.current.clear(); draft.html = "";
    setHasContent(false); setText(""); setImgCount(0); setPreview(null);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    const ne = e.nativeEvent as any;
    if (ne.isComposing || ne.keyCode === 229) return;
    // @ 文件菜单打开时优先吃掉导航键
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
    // # 提示菜单:esc 关闭(无 skill 可选,不拦其他键)
    if (skillTok && e.key === "Escape") { e.preventDefault(); setSkillTok(null); return; }
    // / 命令面板:首页只补全,不执行(会话控制命令要建会话后才有意义)
    if (paletteOpen && filtered.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPalIdx((i) => (i + 1) % filtered.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPalIdx((i) => (i - 1 + filtered.length) % filtered.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); setEditorText(filtered[palIdx].cmd + " "); return; }
      if (e.key === "Escape") { e.preventDefault(); setEditorText(""); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  const short = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

  return (
    <div className="empty-composer">
      {/* 选好项目后右上角出现「项目详情」:未建会话也能先看目录/文件/记忆 */}
      {cwd && (
        <button className="home-details-btn" title={t("项目详情")} {...btnPress(() => setShowInfo(true))}>
          <Info size={14} /> {t("项目详情")}
        </button>
      )}
      {showInfo && cwd && <HomeInfoPanel cwd={cwd} onClose={() => setShowInfo(false)} />}
      <div className="empty-dir-row">
        {cwd ? (
          <span className="empty-dir-chip" title={cwd}>
            <FolderOpen size={13} /> <span className="empty-dir-path">{short(cwd)}</span>
            <button className="empty-dir-x" onMouseDown={(e) => { e.preventDefault(); setCwd(""); }} title={t("清除,改为闲聊会话")}><X size={12} /></button>
          </span>
        ) : (
          // 两个入口:左边翻已关闭的会话(接着上次聊),右边从电脑挑目录(开新的)
          <span className="empty-dir-pick-group" ref={histRef}>
            <button className="empty-dir-pick" disabled={!state.closed.length}
              title={state.closed.length ? t("从最近关闭的会话继续") : t("还没有关闭过的会话")}
              onMouseDown={(e) => { e.preventDefault(); setHistOpen((v) => !v); }}>
              <History size={13} /> {t("最近历史")}
            </button>
            <button className="empty-dir-pick" onMouseDown={(e) => { e.preventDefault(); pick(); }}>
              <FolderOpen size={13} /> {t("选择项目目录")}
            </button>
            {histOpen && (
              <div className="palette empty-hist-menu">
                <div className="palette-head"><History size={13} /> {t("最近关闭的会话")}</div>
                <div className="palette-scroll">
                  {state.closed.map((c) => (
                    <div key={c.id} className="palette-item"
                      onMouseDown={(e) => { e.preventDefault(); setHistOpen(false); restoreSession(c.id); }}>
                      <div>
                        <b>{c.title}</b> <span className="muted">{short(c.cwd)}</span>
                        {c.lastUser && <div className="muted empty-hist-last">{c.lastUser}</div>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="palette-hint">{t("点一条即恢复原对话,接着上次继续")}</div>
              </div>
            )}
          </span>
        )}
        <div className="empty-model" ref={modelMenuRef}>
          <button className="model-switch" title={t("选择模型")} onMouseDown={(e) => { e.preventDefault(); if (!modelMenu) requestHomeModels(); setModelMenu((v) => !v); }}>
            <strong>{modelText}</strong><ChevronDown size={12} />
          </button>
          {modelMenu && (
            <div className="palette empty-model-menu">
              <div className="palette-scroll">
                {state.homeModels.map((m) => (
                  <div key={m.value} className={`palette-item ${m.value === state.homeModel ? "sel" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); setHomeModel(m.value); setModelMenu(false); }}>
                    <div><b>{modelName(state.homeModels, m)}</b>{m.value === state.homeModel && <span className="muted">{t(" · 当前")}</span>}
                    {m.description && <div className="muted">{m.description}</div>}</div>
                  </div>
                ))}
                {state.homeModels.length === 0 && <div className="palette-item muted">{t("模型列表加载中…")}</div>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* / 命令面板 */}
      {paletteOpen && filtered.length > 0 && (
        <div className="palette">
          <div className="palette-scroll">
            {filtered.map((c, i) => (
              <div key={c.cmd} className={`palette-item ${i === palIdx ? "sel" : ""}`}
                onMouseEnter={() => setPalIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); setEditorText(c.cmd + " "); }}>
                <b>{c.cmd}</b> <span className="muted">{t(c.desc)}</span>
              </div>
            ))}
          </div>
          <div className="palette-hint">{t("↑↓ 选择 · Tab/⏎ 补全")}</div>
        </div>
      )}
      {/* @ 文件选择:空 query = 目录树浏览;有 query = 全项目过滤 */}
      {mention && (
        <div className="palette">
          <div className="palette-head">
            {mQuery ? <>{t("过滤")} <b>{mQuery}</b> · {mItems.length} {t("项")}</> : <><Folder size={13} /> {mDir || t("项目根目录")}</>}
          </div>
          <div className="palette-scroll">
            {mItems.map((e, i) => (
              <div key={e.path} className={`palette-item mention-item ${i === mIdx ? "sel" : ""}`}
                onMouseEnter={() => setMIdx(i)}
                onMouseDown={(ev) => { ev.preventDefault(); pickMention(e, true); }}>
                <span className="mention-ico">{e.path === ".." ? <CornerLeftUp size={14} /> : e.dir ? <Folder size={14} /> : <File size={14} />}</span>
                <b>{e.path === ".." ? t("上一级") : baseName(e.path)}{e.dir && e.path !== ".." ? "/" : ""}</b>
                {e.path !== ".." && dirName(e.path) && <span className="muted mention-dir">{dirName(e.path)}</span>}
              </div>
            ))}
            {!mItems.length && <div className="palette-item muted">{mentionRoot ? (mQuery ? t("没有匹配的文件") : t("空目录")) : t("先选择项目目录")}</div>}
          </div>
          <div className="palette-hint">{t("↑↓ 选择 · ⏎")} {mQuery ? t("插入(文件夹则进入)") : t("打开文件夹/选择文件")} {t(" · Tab 直接插入路径 · esc 关闭")}</div>
        </div>
      )}
      {/* # skill:首页无会话拿不到列表,只提示 */}
      {skillTok && (
        <div className="palette">
          <div className="palette-head"><Sparkles size={13} /> Skills</div>
          <div className="palette-scroll">
            <div className="palette-item muted">{t("建会话后可用(skill 列表由会话上报)")}</div>
          </div>
          <div className="palette-hint">{t("esc 关闭")}</div>
        </div>
      )}

      <div className="star-border">
      <div className="empty-input-box sb-inner input-glow" onMouseMove={onEdgeGlow}>
        <div className="empty-editor-wrap">
          {!hasContent && <div className="empty-editor-ph">{cwd ? t("需要我做什么") : t("想要聊点啥")}</div>}
          <div ref={edRef} className="empty-editor" contentEditable suppressContentEditableWarning
            onInput={refresh} onPaste={onPaste} onKeyDown={onKeyDown} onKeyUp={refreshMention}
            onMouseDown={onEditorMouseDown} onMouseUp={refreshMention} onBlur={() => setMention(null)}
            onMouseOver={onEditorOver} onMouseOut={onEditorOut} />
        </div>
        <button className="empty-send" disabled={!hasContent || !state.connected}
          onMouseDown={(e) => { e.preventDefault(); submit(); }} title={t("发送 (⏎)")}><ArrowUp size={16} /></button>
      </div>
      </div>
      {preview && (
        <img className="img-preview-float" src={preview.src}
          style={{ left: preview.left, top: preview.top, transform: "translateY(-100%)" }} />
      )}
    </div>
  );
}
