import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, RefreshCw, Pencil, FolderOpen, TriangleAlert, ChevronRight, ChevronDown, LoaderCircle, Cloud } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rawHtml } from "../lib/mdhtml";
import { revealPath } from "../native";
import { scanMemories, defaultSyncName, syncMemoryTo, type MemoryEntry, type MemoryScan, type MemoryType } from "../memory";
import { openEditorWindow } from "../popout";
import { useTranslation } from "react-i18next";
import { btnPress } from "../lib/utils";

const TYPE_LABEL: Record<MemoryType, string> = { user: "用户", feedback: "偏好", project: "项目", reference: "参考", other: "其它" };
const TYPE_ORDER: MemoryType[] = ["user", "feedback", "project", "reference", "other"];

function relTime(ms: number, t: (s: string, opts?: Record<string, unknown>) => string): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("刚刚");
  if (min < 60) return t("{{min}} 分钟前", { min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("{{h}} 小时前", { h });
  const d = Math.floor(h / 24);
  if (d < 30) return t("{{d}} 天前", { d });
  const mo = Math.floor(d / 30);
  return mo < 12 ? t("{{mo}} 个月前", { mo }) : t("{{year}} 年前", { year: Math.floor(mo / 12) });
}

// 记忆中心:扫描本项目 memory/,按类型分组罗列,标出索引漂移,可展开看正文、点开内置编辑器编辑。
// highlight = 从气泡里的"记忆引用/更新"跳过来时要高亮定位的文件名。
export function MemoryTab({ cwd, highlight }: { cwd: string; highlight?: string }) {
  const { t } = useTranslation();
  const [scan, setScan] = useState<MemoryScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null); // 展开正文的文件
  const listRef = useRef<HTMLDivElement>(null);

  const load = () => { setLoading(true); scanMemories(cwd).then((s) => { setScan(s); setLoading(false); }); };
  useEffect(load, [cwd]);

  // 被点进来:展开并滚动 + 闪烁定位
  useEffect(() => {
    if (!highlight || !scan) return;
    setOpen(highlight);
    const t = window.setTimeout(() => {
      const el = listRef.current?.querySelector(`[data-mem="${CSS.escape(highlight)}"]`) as HTMLElement | null;
      if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    }, 60);
    return () => window.clearTimeout(t);
  }, [highlight, scan]);

  if (loading && !scan) return <div className="info-scroll"><div className="muted mem-empty"><LoaderCircle size={15} className="ico-spin" /> {t("正在读取记忆…")}</div></div>;
  if (!scan) return null;

  const total = scan.entries.length + scan.indexNotes.length;
  const unindexed = scan.entries.filter((e) => !e.indexed).length;
  const groups = TYPE_ORDER.map((t) => ({ type: t, items: scan.entries.filter((e) => e.type === t) })).filter((g) => g.items.length);

  return (
    <div className="info-scroll mem-tab" ref={listRef}>
      <div className="mem-head">
        <div className="mem-head-l"><Brain size={15} /> <b>{t("本项目记忆")}</b> <span className="muted">{t("共 {{num}} 条", { num: total })}</span></div>
        <button className="mem-refresh" title={t("重新扫描")} {...btnPress(load)}><RefreshCw size={13} /></button>
      </div>

      <MemorySync cwd={cwd} scan={scan} onDone={load} />

      {total === 0 && <div className="muted mem-empty">{t("这个项目还没有记忆。agent 在对话里记下的事实会出现在这里。")}</div>}

      {/* 索引漂移告警 */}
      {(unindexed > 0 || scan.orphanIndex.length > 0) && (
        <div className="mem-drift">
          <TriangleAlert size={13} />
          <div>
            <b>{t("索引不同步")}</b>
            {unindexed > 0 && <div>{t("{{num}} 条记忆未登记进 MEMORY.md 索引", { num: unindexed })}</div>}
            {scan.orphanIndex.length > 0 && <div>{t("{{num}} 条索引项对应的文件已不存在:{{files}}", { num: scan.orphanIndex.length, files: scan.orphanIndex.join("、") })}</div>}
            <div className="muted mem-drift-note">{t("(一键修复索引将在第二层实现)")}</div>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.type} className="mem-group">
          <h4 className="mem-group-title">{t(TYPE_LABEL[g.type])} <span className="muted">{g.items.length}</span></h4>
          {g.items.map((m) => (
            <MemoryCard key={m.file} m={m} expanded={open === m.file} onToggle={() => setOpen((o) => (o === m.file ? null : m.file))} />
          ))}
        </section>
      ))}

      {/* 仅写在 MEMORY.md 索引里、没有独立文件的记忆(如活文档指针) */}
      {scan.indexNotes.length > 0 && (
        <section className="mem-group">
          <h4 className="mem-group-title">{t("索引条目")} <span className="muted">{t("无独立文件")} · {scan.indexNotes.length}</span></h4>
          {scan.indexNotes.map((n, i) => (
            <div key={i} className="mem-card mem-note">
              <div className="mem-card-head" style={{ cursor: "default" }}>
                <div className="mem-card-main">
                  <div className="mem-card-title">{n.title}</div>
                  {n.hook && <div className="mem-card-desc">{n.hook}</div>}
                </div>
              </div>
            </div>
          ))}
          <button className="mem-note-edit" {...btnPress(() => openEditorWindow(`/MEMORY.md`, "MEMORY.md"))}><Pencil size={12} /> {t("编辑 MEMORY.md 索引")}</button>
        </section>
      )}
    </div>
  );
}

// 跨电脑同步:把本项目记忆改存到同步盘里的 <根目录>/<项目名>(写 Claude Code 原生的 autoMemoryDirectory)。
// 根目录每台电脑各记各的(localStorage);项目名默认取 git 仓库名,两台电脑填同一个名字就共用一份记忆。
const SYNC_ROOT_KEY = "ChatCode-memory-sync-root";
function MemorySync({ cwd, scan, onDone }: { cwd: string; scan: MemoryScan; onDone: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [root, setRoot] = useState(() => localStorage.getItem(SYNC_ROOT_KEY) ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (scan.custom) return (
    <div className="mem-sync muted" title={scan.dir}>
      <Cloud size={12} /> {t("已同步到")} <span className="mem-sync-path" onClick={() => revealPath(scan.dir)}>{scan.dir}</span>
    </div>
  );
  if (!editing) return (
    <div className="mem-sync muted">
      <button className="mem-sync-btn" {...btnPress(async () => { setName(await defaultSyncName(cwd)); setEditing(true); })}><Cloud size={12} /> {t("跨电脑同步…")}</button>
    </div>
  );
  const pick = async () => { try { const p = await invoke<string | null>("choose_directory"); if (p) setRoot(p); } catch { /* 取消选择 */ } };
  const go = async () => {
    setBusy(true); setErr("");
    try {
      await syncMemoryTo(cwd, root, name.trim());
      localStorage.setItem(SYNC_ROOT_KEY, root);
      setEditing(false); onDone();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setBusy(false);
  };
  return (
    <div className="mem-sync-form">
      <div className="muted">{t("记忆改存到同步盘里的文件夹(Obsidian 库、iCloud、Dropbox 等),由同步盘负责传到其他电脑。其他电脑填同一个项目名即可共用。")}</div>
      <label>{t("根目录")}<button className="mem-sync-btn" {...btnPress(pick)}><FolderOpen size={12} /> {root || t("选择…")}</button></label>
      <label>{t("项目名")}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      {err && <div className="mem-sync-err">{err}</div>}
      <div className="mem-sync-actions">
        <button className="mem-sync-btn" {...btnPress(() => setEditing(false))}>{t("取消")}</button>
        <button className="mem-sync-btn primary" disabled={busy || !root || !/^[^/\\]+$/.test(name.trim())} {...btnPress(go)}>{busy ? t("迁移中…") : t("迁移并同步")}</button>
      </div>
    </div>
  );
}

function MemoryCard({ m, expanded, onToggle }: { m: MemoryEntry; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null); // 文件名的右键菜单
  // 点别处 / 右键别处 关掉(和「文件」tab 的树是同一套)
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener("click", close); window.addEventListener("contextmenu", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("contextmenu", close); };
  }, [ctx]);
  return (
    <div className={`mem-card ${m.indexed ? "" : "unindexed"}`} data-mem={m.file}>
      <div className="mem-card-head" onClick={onToggle}>
        <span className="mem-chevron">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <div className="mem-card-main">
          <div className="mem-card-title">{m.title}{!m.indexed && <span className="mem-badge-drift" title={t("未登记进 MEMORY.md 索引")}>{t("未索引")}</span>}</div>
          {m.description && <div className="mem-card-desc">{m.description}</div>}
        </div>
        <span className="mem-card-time muted" title={new Date(m.mtime).toLocaleString()}>{relTime(m.mtime, t)}</span>
      </div>
      {expanded && (
        <div className="mem-card-body">
          <div className="mem-body-md md"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rawHtml}>{m.body}</Markdown></div>
        </div>
      )}
      {/* 折叠时也留着:文件名和两个操作是这条记忆的身份,不该藏在展开里 */}
      <div className="mem-card-actions">
        <button {...btnPress(() => openEditorWindow(m.path, m.file))}><Pencil size={12} /> {t("编辑")}</button>
        <button {...btnPress(() => revealPath(m.path))}><FolderOpen size={12} /> {t("打开目录")}</button>
      </div>
      {/* 文件名自己一行(不再挤在按钮右边被截成半截),交互和「文件」tab 里的文件行一致:
          左键打开、右键出「打开目录」 */}
      <div className="mem-card-file muted" title={m.file}
        onClick={() => openEditorWindow(m.path, m.file)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY }); }}>{m.file}</div>
      {ctx && createPortal(
        <div className="tree-ctx-menu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button onMouseDown={(e) => { e.preventDefault(); revealPath(m.path); setCtx(null); }}><FolderOpen size={13} /> {t("打开目录")}</button>
        </div>, document.body)}
    </div>
  );
}
