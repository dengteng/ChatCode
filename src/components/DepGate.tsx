import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, ExternalLink } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "../native";
import { btnPress } from "../lib/utils";

type Dep = { name: string; ok: boolean; path: string };

// 和 Rust 那边 NPM_OFFICIAL / NPM_MIRROR 是同两个值
const OFFICIAL = "https://registry.npmjs.org";
const MIRROR = "https://registry.npmmirror.com";

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
  // 装 claude 的状态:null=没开始,字符串=进行中/结果
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 默认源由 Rust 探测:官方源连不上(国内常态)就自动落到 npmmirror,用户仍可手动切
  const [registry, setRegistry] = useState<string>("");

  const check = useCallback(() => {
    setChecking(true);
    invoke<[string, boolean, string][]>("check_deps")
      .then(async (rows) => {
        // 依赖齐了就先把 sidecar 补起来再放行:启动那会儿 claude 还没装,Rust 里那次自动拉起是失败的,
        // 直接渲染主界面等于给用户一个连不上后台的空壳。已在跑的话这个命令是空操作。
        if (rows.every(([, ok]) => ok)) await invoke("start_sidecar").catch(() => {});
        setDeps(rows.map(([name, ok, path]) => ({ name, ok, path })));
      })
      .catch(() => setDeps([]))  // 命令都调不动(如浏览器开发模式),放行别把人锁死
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => { check(); }, [check]);
  // 探测一次就够:结果只用来定"默认勾哪个源"
  useEffect(() => { invoke<string>("probe_registry").then(setRegistry).catch(() => setRegistry(MIRROR)); }, []);

  // npm 的每行输出。只留最新一行 —— 装包时用户要的是"还活着、在干什么",不是一份日志。
  // 用 ref 存 unlisten:listen 是异步的,组件在装完前被卸载时得能取消掉。
  const [progress, setProgress] = useState("");
  const unlisten = useRef<null | (() => void)>(null);
  useEffect(() => () => unlisten.current?.(), []);

  // 已等待秒数。267MB 那个包在日志里只占一行,下载那几分钟最新行是不动的 ——
  // 没有这个计时器,界面看着就像卡死了,用户会去关窗口(关了就得重下)。
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!installing) return;
    const id = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [installing]);

  // 一键装 claude:用包内 node + 包内 npm,装进 ~/.ChatCode/npm —— 用户机器可以完全没有 Node/npm
  const install = async () => {
    setInstalling(true);
    setInstallMsg(null);
    setProgress("");
    setElapsed(0);
    unlisten.current?.();
    unlisten.current = await listen<string>("claude-install", (e) => setProgress(e.payload));
    try {
      const [reg] = await invoke<[string, string]>("install_claude", { registry });
      setInstallMsg({ ok: true, text: t("已从 {{reg}} 安装完成", { reg }) });
      check();
    } catch (e) {
      setInstallMsg({ ok: false, text: String(e) });
    } finally {
      unlisten.current?.();
      unlisten.current = null;
      setInstalling(false);
      setProgress("");
    }
  };

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
                    {/* claude 这条能一键装:app 自带 node 和 npm,不必先让用户去装 Node。
                        源默认跟 probe_registry 的结果走,国内连不上官方源时自动是镜像。 */}
                    {d.name === "claude" && (
                      <div className="depgate-install">
                        <button className="depgate-go" disabled={installing} {...btnPress(install)}>
                          {installing ? t("安装中…") : t("一键安装")}
                        </button>
                        <select value={registry} onChange={(e) => setRegistry(e.target.value)} disabled={installing}>
                          <option value={OFFICIAL}>{t("官方源 npmjs.org")}</option>
                          <option value={MIRROR}>{t("国内镜像 npmmirror.com")}</option>
                        </select>
                        {/* 装包时只滚最新一行。整行不换行 + 省略号:npm 的 URL 很长,
                            换行会让整块卡片高度随每行输出上下跳。 */}
                        {/* 说清「要等多久、别关窗口」:下载主包那几分钟日志是不动的,
                            只给一行静止的日志会被当成卡死。计时器是唯一还在动的东西。 */}
                        {installing && <p className="depgate-wait">
                          {t("正在下载 Claude Code（约 270MB），首次安装通常需要 1–5 分钟，网络慢时更久。请耐心等待，别关闭窗口 —— 关了要重新下。")}
                          {" "}<b>{t("已等待 {{s}} 秒", { s: elapsed })}</b>
                        </p>}
                        {installing && <p className="depgate-msg run" title={progress}>{progress || t("准备中…")}</p>}
                        {installMsg && <p className={installMsg.ok ? "depgate-msg ok" : "depgate-msg err"}>{installMsg.text}</p>}
                      </div>
                    )}
                    {g.cmd && <div className="depgate-cmd"><code>{g.cmd}</code>
                      <button {...btnPress(() => { navigator.clipboard?.writeText(g.cmd!); })}>{t("复制")}</button></div>}
                    {/* 国内直连 npm 官方源常年慢/断,给一条镜像命令,别让人卡在第一步 */}
                    {g.cmdCN && <div className="depgate-cmd"><code>{g.cmdCN}</code>
                      <button {...btnPress(() => { navigator.clipboard?.writeText(g.cmdCN!); })}>{t("复制(国内镜像)")}</button></div>}
                    <button className="link" {...btnPress(() => openUrl(g.url))}>{t("官方安装指南")} <ExternalLink size={12} /></button>
                    {/* 官网下载在国内时快时慢,给一条镜像下载页兜底 */}
                    {g.urlCN && <button className="link" {...btnPress(() => openUrl(g.urlCN!))}>{t("国内镜像下载")} <ExternalLink size={12} /></button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <button className="depgate-recheck" disabled={checking} {...btnPress(check)}>
          {checking ? t("检测中…") : t("重新检测")}
        </button>
      </div>
    </div>
  );
}
