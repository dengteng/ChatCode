import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ContextUsage } from "../types";
import { useApi } from "../store";
import { btnPress } from "../lib/utils";

// 底栏「上下文」点开的构成面板:上下文里系统提示、工具、记忆、Skills、对话各占多少。
// 数据是 SDK 的 getContextUsage(summary 档,和 CLI 的 /context 同源),按上一轮 usage + 本地估算,不调模型。
// SDK 给的类别名是英文,中文界面按这张表翻;没收录的新类别原样显示。
const ZH: Record<string, string> = {
  "System prompt": "系统提示", "System tools": "内置工具", "MCP tools": "MCP 工具", "Custom agents": "自定义 agent",
  "Memory files": "记忆文件", "Skills": "Skills", "Messages": "对话消息", "Free space": "剩余空间", "Autocompact buffer": "自动压缩预留",
};
const COLORS = ["#8b5cf6", "#3b82f6", "#0891b2", "#d58b00", "#2e9c58", "#db2777", "#e5484d", "#65a30d"];
const FREE = new Set(["Free space", "Autocompact buffer"]);

export function ContextPanel({ sid, anchor, onClose }: { sid: string; anchor: DOMRect; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { contextUsage } = useApi();
  const [d, setD] = useState<ContextUsage | null>(null);
  const [err, setErr] = useState("");
  const [n, reload] = useState(0);
  useEffect(() => {
    let live = true;
    setErr("");
    contextUsage(sid).then((x) => live && setD(x), (e) => live && setErr(String(e?.message || e)));
    return () => { live = false; };
  }, [sid, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (s: string) => (i18n.language.startsWith("zh") ? ZH[s] ?? s : s);
  // deferred = 按需加载、现在不占上下文的那部分(工具/MCP 的 schema),不进条也不进列表
  const cats = (d?.categories ?? []).filter((c) => !c.isDeferred && c.tokens > 0);
  const used = cats.filter((c) => !FREE.has(c.name));
  const pct = (x: number) => (d?.maxTokens ? (x / d.maxTokens) * 100 : 0);
  const mcp = Object.entries((d?.mcpTools ?? []).reduce<Record<string, number>>((m, x) => ((m[x.serverName] = (m[x.serverName] ?? 0) + x.tokens), m), {}))
    .sort((a, b) => b[1] - a[1]);
  const tools = [...(d?.messageBreakdown?.toolCallsByType ?? [])].sort((a, b) => b.callTokens + b.resultTokens - a.callTokens - a.resultTokens).slice(0, 5);
  const skills = [...(d?.skills?.skillFrontmatter ?? [])].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return createPortal(
    <div className="ctxp-shade" onClick={onClose}>
      <div className="ctxp" style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 6 }} onClick={(e) => e.stopPropagation()}>
        <div className="ctxp-head">
          <b>{t("上下文构成")}</b>
          {d && <span className="muted">{fmt(d.totalTokens)} / {fmt(d.maxTokens)} · {Math.round(d.percentage)}%</span>}
          <button className="ghost" title={t("刷新")} {...btnPress(() => reload((v) => v + 1))}><RotateCw size={12} /></button>
        </div>
        {err ? <div className="muted ctxp-empty">{err}</div> : !d ? <div className="muted ctxp-empty">{t("加载中…")}</div> : <>
          <div className="ctxp-bar">{used.map((c, i) => <span key={c.name} style={{ width: `${pct(c.tokens)}%`, background: COLORS[i % COLORS.length] }} title={`${name(c.name)} ${fmt(c.tokens)}`} />)}</div>
          {d.isAutoCompactEnabled && d.autoCompactThreshold && <div className="muted ctxp-note">{t("到 {{n}} 自动压缩", { n: fmt(d.autoCompactThreshold) })}</div>}
          <div className="ctxp-rows">
            {cats.map((c) => {
              const i = used.indexOf(c);
              return <div key={c.name} className={`ctxp-row ${i < 0 ? "free" : ""}`}>
                <i style={{ background: i < 0 ? "var(--border)" : COLORS[i % COLORS.length] }} />
                <span>{name(c.name)}</span><span className="ctxp-num">{fmt(c.tokens)}</span><span className="ctxp-pct">{pct(c.tokens).toFixed(1)}%</span>
              </div>;
            })}
          </div>
          {!!d.memoryFiles.length && <Section title={t("记忆文件")} rows={[...d.memoryFiles].sort((a, b) => b.tokens - a.tokens).map((f) => [f.path.replace(/^\/Users\/[^/]+/, "~"), f.tokens])} />}
          {!!mcp.length && <Section title={t("MCP 工具(按服务)")} rows={mcp} />}
          {!!skills.length && <Section title={t("Skills 说明 · 共 {{n}} 个", { n: d.skills!.includedSkills })} rows={skills.map((s) => [s.name, s.tokens])} />}
          {!!tools.length && <Section title={t("对话里的工具调用")} rows={tools.map((x) => [x.name, x.callTokens + x.resultTokens])} />}
        </>}
      </div>
    </div>, document.body);
}

function Section({ title, rows }: { title: string; rows: [string, number][] }) {
  return <div className="ctxp-sec">
    <div className="ctxp-sec-h">{title}</div>
    {rows.map(([k, v]) => <div key={k} className="ctxp-row"><span title={k}>{k}</span><span className="ctxp-num">{fmt(v)}</span></div>)}
  </div>;
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : String(n);
}
