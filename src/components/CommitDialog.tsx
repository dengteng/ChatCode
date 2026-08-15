import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { useStore } from "../store";

// 最近 5 条提交说明(localStorage),弹窗里点一条即可回填 —— 提交信息高度重复,省得每次重打。
// 按 git 项目(scope=项目根目录)分桶存:不同仓库的提交描述天差地别,混在一起点错的概率比省的事还多。
const HIST_KEY = "chat-code-commit-history";           // 旧的全局键:一次性迁移到当前项目桶后删掉
const keyOf = (scope: string) => `chat-code-commit-history:${scope || "_"}`;
const readHistory = (scope: string): string[] => {
  try { const v = JSON.parse(localStorage.getItem(keyOf(scope)) || "[]"); return Array.isArray(v) ? v.slice(0, 5) : []; } catch { return []; }
};
const remember = (scope: string, msg: string) =>
  localStorage.setItem(keyOf(scope), JSON.stringify([msg, ...readHistory(scope).filter((m) => m !== msg)].slice(0, 5)));

// 统一的 commit 弹窗:顶部 dir-bar 和项目详情面板共用。多行输入,⌘/Ctrl+Enter 或点提交。
// scope = 当前 git 项目根目录,历史提交描述按它独立存储。
export function CommitDialog({ scope, sessionId, onSubmit, onCancel }: { scope: string; sessionId: string; onSubmit: (message: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { suggestCommit } = useStore();
  const [value, setValue] = useState("");
  const [suggesting, setSuggesting] = useState(true);   // 打开即自动总结,先转圈
  const touched = useRef(false);                         // 用户一旦手动改过输入框,就别再被自动总结覆盖
  const [history] = useState(() => {
    // 一次性迁移:老版本把所有项目的提交描述混存在全局键里,首次在某项目打开且该项目桶为空时,
    // 把旧的全局记录搬进当前项目桶(用户当下多半就在这个仓库里提交),之后清掉全局键。
    const own = readHistory(scope);
    if (own.length === 0) {
      const legacy = localStorage.getItem(HIST_KEY);
      if (legacy) { localStorage.setItem(keyOf(scope), legacy); localStorage.removeItem(HIST_KEY); return readHistory(scope); }
    }
    return own; // 打开时快照,提交后自己关闭,不用跟着变
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // 打开时(及点「重新生成」时)让 sidecar 总结待提交改动,回填输入框。用户已手动改过则不覆盖。
  const runSuggest = (force = false) => {
    setSuggesting(true);
    let alive = true;
    suggestCommit(sessionId, force)
      .then((msg) => { if (alive && !touched.current) setValue(msg); })
      .catch(() => {})   // 汇总失败就留空,用户手写
      .finally(() => { if (alive) setSuggesting(false); });
    return () => { alive = false; };
  };
  useEffect(() => runSuggest(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { const m = value.trim(); if (!m) return; remember(scope, m); onSubmit(m); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      {/* Radix 自带 Portal + Esc 关闭 + 焦点陷阱;首个可聚焦元素即 textarea,onOpenAutoFocus 交给它。
          onInteractOutside 拦掉:点弹窗外部(遮罩/别处)不关闭,避免误触丢掉正在写的提交说明 —— 只能点 取消/×/提交 */}
      <DialogContent className="w-[min(480px,92vw)] max-w-none" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle>{t("提交改动")}</DialogTitle></DialogHeader>
        <textarea ref={ref} className="commit-modal-input" placeholder={suggesting ? t("正在汇总各轮小结…") : t("请输入")} value={value}
          onChange={(e) => { touched.current = true; setValue(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(); }
          }} />
        {/* 输入框正下方一行:左=最近提交标签,右=取消/提交。历史条目列在这行下方。 */}
        <div className="commit-actions-row">
          <div className="commit-history-title">{history.length > 0 ? t("最近提交") : ""}</div>
          <div className="commit-actions-btns">
            {/* mousedown:避开 WKWebView 首击只聚焦不触发的坑 */}
            <Button variant="ghost" onMouseDown={(e) => { e.preventDefault(); onCancel(); }}>{t("取消")}</Button>
            <Button disabled={!value.trim()} onMouseDown={(e) => { e.preventDefault(); done(); }}>{t("提交")}</Button>
          </div>
        </div>
        {history.length > 0 && (
          <div className="commit-history">
            {history.map((m) => (
              // mousedown 而非 click:WKWebView 里 textarea 聚焦时首次点击只挪焦点、不派发 click,要点两次
              <button key={m} type="button" className="commit-history-item" title={m}
                onMouseDown={(e) => { e.preventDefault(); setValue(m); ref.current?.focus(); }}>{m.split("\n")[0]}</button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
