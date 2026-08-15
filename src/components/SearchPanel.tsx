import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useStore } from "../store";
import { brandName } from "./Avatar";

// 搜索结果横跨多天,只给 HH:mm 分不清哪天;今天的省掉日期,其余带 MM-DD
function fmtWhen(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

// 命中处高亮:后端已经把片段开在关键词附近,这里只负责按关键词切段打标(大小写不敏感)
function Hit({ text, q }: { text: string; q: string }) {
  const key = q.trim();
  if (!key) return <span>{text}</span>;
  const parts: ReactNode[] = [];
  const low = text.toLocaleLowerCase(), lowQ = key.toLocaleLowerCase();
  let i = 0;
  for (let at = low.indexOf(lowQ); at >= 0; at = low.indexOf(lowQ, i)) {
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={at}>{text.slice(at, at + key.length)}</mark>);
    i = at + key.length;
  }
  parts.push(text.slice(i));
  return <span>{parts}</span>;
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { state, searchMessages, reopenSession, dispatch } = useStore();
  const [query, setQuery] = useState("");
  // 从会话里唤起就默认只搜这个会话,从首页唤起默认全部("" = 全部)
  const [scope, setScope] = useState(state.activeId ?? "");
  const [kind, setKind] = useState<"all" | "user" | "agent">("all");
  useEffect(() => { const t = setTimeout(() => searchMessages(query, scope || undefined, kind), 180); return () => clearTimeout(t); }, [query, scope, kind]);
  const results = useMemo(() => query.trim() ? state.search : [], [query, state.search]);
  return <div className="search-shade" onMouseDown={onClose}>
    <div className="search-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="search-top"><b>{t("搜索对话记录")}</b><button className="ghost" onClick={onClose}><X size={16} /></button></div>
      <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("搜索提问、回复、工具调用…")} />
      <div className="search-filters">
        <select value={scope} onChange={(e) => setScope(e.target.value)} title={t("限定会话")}>
          <option value="">{t("全部会话")}</option>
          {state.index.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} title={t("限定发送人")}>
          <option value="all">{t("全部发送人")}</option>
          <option value="user">{t("用户")}</option>
          <option value="agent">{t("Agent（含工具）")}</option>
        </select>
      </div>
      <div className="search-results">{query.trim() && !results.length && <div className="muted">{t("没有找到匹配记录")}</div>}
        {results.map((r, i) => <button key={`${r.sessionId}-${i}`} className="search-result" onClick={() => {
          if (!state.sessions[r.sessionId]) reopenSession(r.sessionId); else dispatch({ type: "activate", id: r.sessionId });
          // 光切会话不够,还得滚到那条消息:Chat 接住这个事件,按 ts 定位并高亮(会话还在回放历史时它会重试)
          const ts = r.ts ? +new Date(r.ts) : 0;
          if (ts) window.dispatchEvent(new CustomEvent("cc-focus-msg", { detail: { id: r.sessionId, ts } }));
          onClose();
        }}>
          <span className="search-kind">{r.kind === "user" ? t("你") : r.kind === "agent" ? (state.sessions[r.sessionId]?.info.model ? brandName(state.sessions[r.sessionId].info.model!) : t("Agent")) : t("工具")}</span>
          <b>{r.title}</b>
          <span className="search-when">{fmtWhen(r.ts)}</span>
          <span className="search-text"><Hit text={r.text} q={query} /></span>
        </button>)}
      </div>
    </div>
  </div>;
}
