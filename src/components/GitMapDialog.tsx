import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { btnPress } from "../lib/utils";

// 把一个尚未纳入 git 的本地目录,关联到一个"已经存在"的远程仓库(暂不支持在这里新建远程仓库)。
// 只做映射,不改动工作区文件:调用方拿到 URL 后跑 git init + git remote add origin + git fetch。
export function GitMapDialog({ onSubmit, onCancel }: { onSubmit: (url: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // 只做最基本的形态校验:http(s)://、git@host:path、ssh:// 三种常见远程写法
  const valid = /^(https?:\/\/|git@[^\s]+:|ssh:\/\/)/.test(url.trim());
  const done = () => { const u = url.trim(); if (!u) return; onSubmit(u); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      {/* onInteractOutside 拦掉:点弹窗外部不关闭,避免误触丢掉正在填的地址 —— 只能点 取消/×/关联 */}
      <DialogContent className="w-[min(480px,92vw)] max-w-none" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle>{t("关联 Git 仓库")}</DialogTitle></DialogHeader>
        <p className="git-map-hint">
          {t("把当前本地目录关联到一个")}<b>{t("已存在")}</b>{t("的远程仓库:执行")} <code>git init</code>{t("、加为")} <code>origin</code>{t("、拉回远程分支并")}<b>{t("自动跟踪其默认分支")}</b>(main/master),<b>{t("不会改动你的文件")}</b>{t("。暂不支持在此新建远程仓库。")}
        </p>
        <input ref={ref} className="git-map-input" spellCheck={false}
          placeholder="https://github.com/user/repo.git 或 git@github.com:user/repo.git"
          value={url} onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); done(); } }} />
        <DialogFooter>
          <Button variant="ghost" {...btnPress(onCancel)}>{t("取消")}</Button>
          <Button disabled={!valid} {...btnPress(done)}>{t("关联")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
