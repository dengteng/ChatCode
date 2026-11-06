import { useState } from "react";
import { createPortal } from "react-dom";
import { FileDiff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TurnChanges as Changes } from "../types";
import { useApi, useStore } from "../store";
import { btnPress } from "../lib/utils";
import { DiffHtml } from "./BranchesTab";

// 每轮改动卡片:气泡底部列出这一轮改了哪些文件、各增删几行,点文件弹 diff。
// 数据是 sidecar 在轮首/轮末各拍一张工作区快照比出来的(见 server.mjs snapTree),
// Bash 改的、agent 自己提交掉的也都在,和这一轮调了哪些工具无关。
const SHOW = 5; // 多了先折起来:一轮改几十个文件(格式化、重命名)时卡片别把正文挤没
export function TurnChanges({ sid, ch }: { sid: string; ch: Changes }) {
  const { t } = useTranslation();
  const { requestGitFileDiff } = useApi();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const add = ch.files.reduce((n, f) => n + (f.add ?? 0), 0);
  const del = ch.files.reduce((n, f) => n + (f.del ?? 0), 0);
  const view = (file: string) => { setOpen(file); requestGitFileDiff(sid, ch.from, ch.to, file, true); };
  return (
    <div className="turn-changes">
      <div className="tc-head"><FileDiff size={12} /><span>{t("本轮改动 {{n}} 个文件", { n: ch.files.length })}</span>
        <span className="tc-add">+{add}</span><span className="tc-del">−{del}</span></div>
      {(all ? ch.files : ch.files.slice(0, SHOW)).map((f) => {
        const i = f.file.lastIndexOf("/");
        return (
          <button key={f.file} className="tc-file" title={f.file} {...btnPress(() => view(f.file))}>
            {/* 目录可以被截,文件名不截:一眼要认出的是改了哪个文件 */}
            <span className="tc-dir">{f.file.slice(0, i + 1)}</span><b>{f.file.slice(i + 1)}</b>
            <span className="tc-num">{f.add === null ? t("二进制")
              : <><span className="tc-add">+{f.add}</span><span className="tc-del">−{f.del}</span></>}</span>
          </button>
        );
      })}
      {ch.files.length > SHOW && <button className="tc-more" {...btnPress(() => setAll(!all))}>
        {all ? t("收起") : t("还有 {{n}} 个文件", { n: ch.files.length - SHOW })}</button>}
      {open && <TurnDiffModal sid={sid} file={open} to={ch.to} onClose={() => setOpen(null)} />}
    </div>
  );
}

// 单独一个组件才订阅 useStore:放在 TurnChanges 里的话,每张历史卡片都会跟着全局 state 重渲染
function TurnDiffModal({ sid, file, to, onClose }: { sid: string; file: string; to: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { state } = useStore();
  const d = state.gitFileDiff[sid];
  const ready = d && d.file === file && d.to === to;
  return createPortal(
    <div className="wtdiff-shade" onClick={onClose}>
      <div className="wtdiff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wtdiff-head"><b title={file}>{file}</b><button className="ghost" title={t("关闭")} {...btnPress(onClose)}><X size={15} /></button></div>
        <div className="wtdiff-body">
          {!ready ? <div className="muted branches-empty">{t("加载中…")}</div>
            : d.error ? <div className="branches-diff-err">{t("无法读取:{{error}}", { error: d.error })}</div>
            : <DiffHtml patch={d.patch} clipped={d.clipped} />}
        </div>
      </div>
    </div>, document.body);
}
