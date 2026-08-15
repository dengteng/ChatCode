import { openUrl } from "../native";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VersionCheck } from "../version";

// 版本更新弹窗。两种形态,差别只在"能不能关":
//   建议更新(hasUpdate):可关,关掉后 3 天内不再弹(节奏由 version.ts 的 shouldPromptUpdate 管);
//   强制更新(forced,当前版本 < minVersion):没有关闭按钮、点遮罩和 Esc 都不关 —— 只能去下载。
export function UpdateDialog({ info, onClose }: { info: VersionCheck; onClose?: () => void }) {
  const { t } = useTranslation();
  const forced = info.forced;
  return createPortal(
    <div className="commit-modal-overlay" onMouseDown={() => { if (!forced) onClose?.(); }}>
      <div className="commit-modal update-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="commit-modal-title update-title">
          <span>{forced ? t("需要更新到") : t("发现新版本")} v{info.latestVersion}</span>
          {!forced && <button className="ghost" title={t("稍后再说")} onClick={onClose}><X size={15} /></button>}
        </div>
        <div className="update-ver muted">{t("当前 v")}{info.current}{forced ? t(" · 最低要求 v{{minVersion}}", { minVersion: info.minVersion }) : ""}</div>
        {forced && <div className="update-forced">{t("这是一个必须更新的版本，请下载新版后继续使用。")}</div>}
        {info.releaseNotes?.trim() && <div className="update-notes">{info.releaseNotes}</div>}
        <div className="commit-modal-actions">
          {!forced && <button type="button" onClick={onClose}>{t("稍后再说")}</button>}
          <button type="button" className="hi" onClick={() => openUrl(info.updateUrl)}>
            <Download size={13} /> {t("立即更新")}
          </button>
        </div>
      </div>
    </div>, document.body);
}
