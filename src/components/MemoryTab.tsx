import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, RefreshCw, Pencil, FolderOpen, TriangleAlert, ChevronRight, ChevronDown, LoaderCircle } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { revealPath } from "../native";
import { scanMemories, type MemoryEntry, type MemoryScan, type MemoryType } from "../memory";
import { openEditorWindow } from "../popout";
import { useTranslation } from "react-i18next";

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
        <button className="mem-refresh" title={t("重新扫描")} onClick={load}><RefreshCw size={13} /></button>
      </div>

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
          <button className="mem-note-edit" onClick={() => openEditorWindow(`${scan.dir}/MEMORY.md`, "MEMORY.md")}><Pencil size={12} /> {t("编辑 MEMORY.md 索引")}</button>
        </section>
      )}
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
          <div className="mem-body-md md"><Markdown remarkPlugins={[remarkGfm]}>{m.body}</Markdown></div>
        </div>
      )}
      {/* 折叠时也留着:文件名和两个操作是这条记忆的身份,不该藏在展开里 */}
      <div className="mem-card-actions">
        <button onClick={() => openEditorWindow(m.path, m.file)}><Pencil size={12} /> {t("编辑")}</button>
        <button onClick={() => revealPath(m.path)}><FolderOpen size={12} /> {t("打开目录")}</button>
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
