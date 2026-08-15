import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Server } from "lucide-react";
import claudeLogo from "../assets/claude.png";
import deepseekLogo from "../assets/deepseek.webp";
import codexLogo from "../assets/codex.png";
import geminiLogo from "../assets/gemini.png";
import kimiLogo from "../assets/kimi.png";
import glmLogo from "../assets/glm.png";
import qwenLogo from "../assets/qwen.png";
import grokLogo from "../assets/grok.png";
import minimaxLogo from "../assets/minimax.png";

// 终端输出的头像:本地电脑用显示器图标,SSH 远端服务器用机架图标,两者配色也不同以便一眼区分
export function ComputerAvatar({ ssh }: { ssh?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={`avatar avatar-computer ${ssh ? "ssh" : "local"}`} title={ssh ? t("远端服务器(SSH)") : t("本地电脑")}>
      {ssh ? <Server size={15} /> : <Monitor size={15} />}
    </span>
  );
}

// model id → 品牌 logo 图(有官方图的返回,没有的返回 null,退回 SVG/字母标记)。
// 侧栏"Agent服务"、会话头像、设置账号列表都复用这一份,保证同一个 logo。
export function modelLogo(model?: string): string | null {
  const m = (model || "").toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return claudeLogo;
  if (/deepseek/.test(m)) return deepseekLogo;
  if (/gpt|openai|codex|\bo1\b|\bo3\b|\bo4\b/.test(m)) return codexLogo;
  if (/gemini|google|palm|bard/.test(m)) return geminiLogo;
  if (/kimi|moonshot/.test(m)) return kimiLogo;
  if (/\bglm\b|zhipu|bigmodel/.test(m)) return glmLogo;
  if (/qwen|tongyi/.test(m)) return qwenLogo;
  if (/grok|xai/.test(m)) return grokLogo;
  if (/minimax/.test(m)) return minimaxLogo;
  return null;
}

// 头像:左侧气泡。"我"可点头像自设图片(存 localStorage);agent 按模型显示对应 logo。

export const AV_KEY = "chatcode.userAvatar";
export const NAME_KEY = "chatcode.userName";
export const AV_EVT = "chatcode-avatar-change";

// 头像/昵称读写(localStorage);改动后广播 AV_EVT,各处实例同步刷新。设置面板也复用这些。
export const getAvatar = () => localStorage.getItem(AV_KEY);
export const getUserName = () => localStorage.getItem(NAME_KEY) || "";
export function setAvatar(dataUrl: string | null) {
  if (dataUrl) localStorage.setItem(AV_KEY, dataUrl); else localStorage.removeItem(AV_KEY);
  window.dispatchEvent(new Event(AV_EVT));
}
export function setUserName(name: string) {
  if (name.trim()) localStorage.setItem(NAME_KEY, name.trim()); else localStorage.removeItem(NAME_KEY);
  window.dispatchEvent(new Event(AV_EVT));
}
export function fileToAvatar(f: File) {
  const r = new FileReader();
  r.onload = () => setAvatar(String(r.result));
  r.readAsDataURL(f);
}

// 我的头像:点一下选图片,存 base64 到 localStorage,多处实例靠自定义事件同步刷新。
export function UserAvatar() {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(getAvatar);
  const [name, setName] = useState<string>(getUserName);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => { setSrc(getAvatar()); setName(getUserName()); };
    window.addEventListener(AV_EVT, sync);
    return () => window.removeEventListener(AV_EVT, sync);
  }, []);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) fileToAvatar(f);
  };
  const initial = name ? name.slice(0, 1).toUpperCase() : t("我");
  return (
    <span className="avatar avatar-user" title={t("点击更换我的头像")} onClick={() => fileRef.current?.click()}>
      {src ? <img src={src} alt={name || t("我")} /> : <span className="avatar-fallback">{initial}</span>}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
    </span>
  );
}

// model id → 厂商显示名(头像右侧那行)。产品当前只跑 Claude,未来接别家时这里自然对上。
export function brandName(model?: string): string {
  const m = (model || "").toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return "Claude";
  if (/gpt|openai|\bo1\b|\bo3\b|\bo4\b/.test(m)) return "OpenAI";
  if (/gemini|google|palm|bard/.test(m)) return "Gemini";
  if (/grok|xai/.test(m)) return "Grok";
  if (/deepseek/.test(m)) return "DeepSeek";
  if (/qwen|tongyi/.test(m)) return "Qwen";
  if (/kimi|moonshot/.test(m)) return "Kimi";
  if (/\bglm\b|zhipu|bigmodel/.test(m)) return "GLM";
  if (/minimax/.test(m)) return "MiniMax";
  if (/llama|meta/.test(m)) return "Llama";
  if (/mistral/.test(m)) return "Mistral";
  return "Claude";
}

// model id 提取厂商 + 品牌色 + 标记
function brandOf(model?: string) {
  const m = (model || "").toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return { bg: "#D97757", mark: "claude" as const };
  if (/gpt|openai|\bo1\b|\bo3\b|\bo4\b/.test(m)) return { bg: "#000000", mark: "openai" as const };
  if (/gemini|google|palm|bard/.test(m)) return { bg: "#1A73E8", mark: "gemini" as const };
  if (/grok|xai/.test(m)) return { bg: "#000000", mark: "grok" as const };
  if (/deepseek/.test(m)) return { bg: "#4D6BFE", mark: "text" as const, text: "DS" };
  if (/qwen|tongyi/.test(m)) return { bg: "#615CED", mark: "text" as const, text: "Q" };
  if (/kimi|moonshot/.test(m)) return { bg: "#000000", mark: "text" as const, text: "K" };
  if (/\bglm\b|zhipu|bigmodel/.test(m)) return { bg: "#3859FF", mark: "text" as const, text: "GLM" };
  if (/minimax/.test(m)) return { bg: "#F23F5D", mark: "text" as const, text: "MM" };
  if (/llama|meta/.test(m)) return { bg: "#0866FF", mark: "text" as const, text: "L" };
  if (/mistral/.test(m)) return { bg: "#FA520F", mark: "text" as const, text: "M" };
  return { bg: "var(--accent)", mark: "text" as const, text: (model || "AI").slice(0, 1).toUpperCase() };
}

// agent 头像:按模型渲染品牌标记(SVG 抽象轮廓,非官方素材)。className 可加尺寸变体(如侧栏小图标)。
export function ModelAvatar({ model, className = "" }: { model?: string; running?: boolean; className?: string }) {
  const b = brandOf(model);
  // 有官方 logo 图的(Claude/DeepSeek)直接用图,头像底透明
  const logo = modelLogo(model);
  if (logo)
    return <span className={`avatar avatar-model ${className}`} title={model || "agent"}>
      <img src={logo} alt={brandName(model)} />
    </span>;
  return (
    <span className={`avatar avatar-model ${className}`} style={{ background: b.bg }} title={model || "agent"}>
      <Mark kind={b.mark} text={(b as any).text} />
    </span>
  );
}

function Mark({ kind, text }: { kind: string; text?: string }) {
  if (kind === "openai") // 六瓣缠结环(抽象)
    return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="6" /><path d="M12 6v12M6.8 9v6M17.2 9v6" />
    </svg>;
  if (kind === "gemini") // 四角星
    return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path fill="#fff" d="M12 2c.6 5 3 7.4 8 8-5 .6-7.4 3-8 8-.6-5-3-7.4-8-8 5-.6 7.4-3 8-8z" />
    </svg>;
  if (kind === "grok")
    return <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="#fff" d="M4 20L14 6h3L7 20H4zm9 0l4-6h3l-4 6h-3z" />
    </svg>;
  return <span className="avatar-fallback">{text || "AI"}</span>;
}
