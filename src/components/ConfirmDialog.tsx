// 统一的二次确认弹窗。所有危险操作(删除 / 批量 kill / git reset --hard 等)都走它,
// 不再在按钮原位 inline 变"确认？"(见记忆 confirm-dialog-not-inline)。
// 复用 commit-modal 那套弹窗样式,危险确认按钮用 hi danger。
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, danger = true, onConfirm, onCancel }:
  { title: string; body?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return createPortal(
    <div className="commit-modal-overlay" onMouseDown={onCancel}>
      <div className="commit-modal ext-del-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="commit-modal-title">{title}</div>
        {body && <p className="git-map-hint">{body}</p>}
        <div className="commit-modal-actions">
          <button type="button" onMouseDown={(e) => { e.preventDefault(); onCancel(); }}>{cancelLabel ?? t("取消")}</button>
          <button type="button" className={danger ? "hi danger" : "hi"} onMouseDown={(e) => { e.preventDefault(); onConfirm(); }}>{confirmLabel ?? t("确认")}</button>
        </div>
      </div>
    </div>, document.body);
}
