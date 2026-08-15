import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, ExternalLink } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "../native";

type Dep = { name: string; ok: boolean; path: string };

// 依赖名 -> 引导文案:说明 + 安装命令(+ 国内镜像那条)+ 官方链接(+ 国内镜像下载页)
const GUIDE: Record<string, { title: string; desc: string; cmd?: string; cmdCN?: string; url: string; urlCN?: string }> = {
  node: {
    title: "Node.js",
    // 原来只给 brew 一条路。国内用户多半没装 Homebrew,而装 brew 本身在国内又是一道墙 ——
    // 卡在这里比卡在 claude CLI 更早、更冤。说清"不用 brew 也行,官网 .pkg 双击就装完"。
    desc: "ChatCode 的 sidecar 是 Node 脚本,缺了它整个后台起不来。没装 Homebrew 就别折腾它 —— 直接下官网 .pkg 安装包双击装,一样的效果。",
    cmd: "brew install node",
    url: "https://nodejs.org/zh-cn/download",
    urlCN: "https://npmmirror.com/mirrors/node/latest-v22.x/",
  },
  claude: {
    title: "Claude Code CLI",
    // 这段文案是国内用户的第一道劝退:原来写「装好后还需登录(OAuth)」,
    // 用 DeepSeek/Kimi/GLM 的人看到就以为必须有 Anthropic 账号,直接卸载。
    // 实际上 claude 在这里只是本地运行时:配了第三方 key 后走各家的兼容端点,不登录、不连 Anthropic。
    desc: "本地跑对话的运行时,SDK 靠它干活。只用 DeepSeek / Kimi / GLM 等第三方模型的话,装完即可 —— 不需要 Anthropic 账号,也不用登录(在设置里填对应 key 就行)。只有要用 Claude 官方模型时才需要登录。",
    cmd: "npm install -g @anthropic-ai/claude-code",
    cmdCN: "npm install -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com",
    url: "https://docs.claude.com/en/docs/claude-code/setup",
  },
};

// 启动门控:任一硬依赖缺失就挡在应用前,提示装什么。node 缺了 sidecar 无法自检,所以检测走 Rust。
export function DepGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [deps, setDeps] = useState<Dep[] | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(() => {
    setChecking(true);
    invoke<[string, boolean, string][]>("check_deps")
      .then((rows) => setDeps(rows.map(([name, ok, path]) => ({ name, ok, path }))))
      .catch(() => setDeps([]))  // 命令都调不动(如浏览器开发模式),放行别把人锁死
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => { check(); }, [check]);

  if (deps === null) return <div className="depgate-loading">{t("检测运行环境…")}</div>;
  const missing = deps.filter((d) => !d.ok);
  if (missing.length === 0) return <>{children}</>;

  return (
    <div className="depgate">
      <div className="depgate-card">
        <h1>{t("缺少运行依赖")}</h1>
        <p className="depgate-sub">{t("ChatCode 是 GUI 壳,真正干活靠下面这些。装好后点“重新检测”。")}</p>
        <ul className="depgate-list">
          {deps.map((d) => {
            const g = GUIDE[d.name];
            return (
              <li key={d.name} className={d.ok ? "ok" : "miss"}>
                <div className="depgate-row">
                  <span className="depgate-ico">{d.ok ? <Check size={15} /> : <X size={15} />}</span>
                  <span className="depgate-name">{g?.title || d.name}</span>
                  {d.ok && <code className="depgate-path" title={d.path}>{d.path}</code>}
                </div>
                {!d.ok && g && (
                  <div className="depgate-help">
                    <p>{t(g.desc)}</p>
                    {g.cmd && <div className="depgate-cmd"><code>{g.cmd}</code>
                      <button onClick={() => navigator.clipboard?.writeText(g.cmd!)}>{t("复制")}</button></div>}
                    {/* 国内直连 npm 官方源常年慢/断,给一条镜像命令,别让人卡在第一步 */}
                    {g.cmdCN && <div className="depgate-cmd"><code>{g.cmdCN}</code>
                      <button onClick={() => navigator.clipboard?.writeText(g.cmdCN!)}>{t("复制(国内镜像)")}</button></div>}
                    <button className="link" onClick={() => openUrl(g.url)}>{t("官方安装指南")} <ExternalLink size={12} /></button>
                    {/* 官网下载在国内时快时慢,给一条镜像下载页兜底 */}
                    {g.urlCN && <button className="link" onClick={() => openUrl(g.urlCN!)}>{t("国内镜像下载")} <ExternalLink size={12} /></button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <button className="depgate-recheck" disabled={checking} onClick={check}>
          {checking ? t("检测中…") : t("重新检测")}
        </button>
      </div>
    </div>
  );
}
