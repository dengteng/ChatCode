import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "../native";
import { setLang, resetLang, selectedLang, getLang } from "../i18n";
import { X, RotateCw, Plus, Check, GitBranch, Pencil, Copy, Search, Trash2, Download, Loader2, Power, PowerOff, ExternalLink, ChevronLeft } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store";
import { toast } from "./Toast";
import { THEMES, type SshHost, type ThemeId, type CustomArt } from "../types";
import { loadExtensions, loadMarketplace, marketplaceNames, installPlugin, uninstallPlugin, enablePlugin, disablePlugin, addMarketplace, removeMarketplace, installSkillGit, setSkillOn, removeSkill, setMcpOn, removeMcp, SEED_MARKETPLACES, type Exts, type MarketPlugin } from "../extensions";
import { EXT_NOTE_ZH } from "../extNotesZh";
import { openEditorWindow } from "../popout";
import { copyText } from "./Chat";
import { getAvatar, getUserName, setAvatar, setUserName, fileToAvatar, modelLogo } from "./Avatar";
import { checkVersion, APP_VERSION, SDK_VERSION, ApiError, type VersionCheck } from "../version";

type Tab = "appearance" | "account" | "profile" | "github" | "ssh" | "extensions" | "about";

// provider logo:有官方图(Claude/DeepSeek)显示图,和会话头像/侧栏共用同一份;没有的退回字母底
function ProviderLogo({ name, cls, ini }: { name: string; cls: string; ini: string }) {
  const logo = modelLogo(name);
  return <span className={`provider-logo ${cls}`}>{logo ? <img src={logo} alt={name} /> : ini}</span>;
}

// 设置面板:外观主题、登录 Claude(未来支持其他 provider)、登录 GitHub、管理 SSH 预设、扩展、设置头像/昵称。
export function Settings({ onClose, initialTab, theme, onPickTheme, customBg, customBlur, customBrightness, onSetCustomBg, onSetCustomBlur, onSetCustomBrightness }: { onClose: () => void; initialTab?: string; theme: ThemeId; onPickTheme: (id: ThemeId) => void; customBg: string; customBlur: number; customBrightness: number; onSetCustomBg: (url: string, artJson?: string) => void; onSetCustomBlur: (v: number) => void; onSetCustomBrightness: (v: number) => void }) {
  const { t } = useTranslation();
  const { state, requestAuthStatus, listSshHosts } = useStore();
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || "account");
  // 打开时拉一次真实状态;之后每次窗口回到前台再拉一次 ——
  // 登录/登出是去系统终端跑 `claude login` 完成的,耗时不可预测(远超 auth_action 后那次 4s 补拉),
  // 用户切回 ChatCode 的这一刻就是"终端里已经弄完了"的唯一可靠信号。
  useEffect(() => {
    const pull = () => requestAuthStatus();
    pull(); listSshHosts();
    window.addEventListener("focus", pull);
    return () => window.removeEventListener("focus", pull);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="settings-shade" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <b>{t("设置")}</b>
          <button className="ghost" onClick={onClose} aria-label={t("关闭设置")}><X size={16} /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {/* 这个 tab 装的是 个人资料 + 账号/登录/同步(SHOW_ACCOUNT 关掉时就只剩头像昵称,名字随之改回「个人资料」) */}
            {([["profile", "个人资料"],["account", "大模型"], ["github", "GitHub连接"], ["ssh", "SSH连接"], ["extensions", "插件/MCP/Skills"], ["appearance", "语言与主题"], ["about", "关于"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" className={tab === k ? "sel" : ""} onMouseDown={(e) => { e.preventDefault(); setTab(k); }}>{t(label)}</button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === "appearance" && <AppearanceTab theme={theme} onPick={onPickTheme} customBg={customBg} customBlur={customBlur} customBrightness={customBrightness} onSetCustomBg={onSetCustomBg} onSetCustomBlur={onSetCustomBlur} onSetCustomBrightness={onSetCustomBrightness} />}
            {tab === "account" && <AccountTab />}
            {tab === "profile" && <ProfileTab />}
            {tab === "github" && <GithubTab />}
            {tab === "ssh" && <SshTab />}
            {tab === "extensions" && <ExtensionsTab />}
            {tab === "about" && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

// 上传时对图做一次性分析(Dream Skin 思路):64px 缩略图上算——
// 1) 主色:按色相分 24 桶(每桶 15°),权重=饱和度×中间亮度,最重桶加权均值;黑白图取不到,accent 缺省。
// 2) 平均亮度 + 左/右三分之一局部亮度:App 据此定主区保护层明暗(壳)。
// 3) 复杂度:相邻像素亮度差均值(边缘密度),App 据此上调各表面不透明度。
function analyzeArt(img: HTMLImageElement): CustomArt | undefined {
  const c = document.createElement("canvas");
  const s = 64 / Math.max(img.width, img.height);
  const W = (c.width = Math.max(16, Math.round(img.width * s)));
  const H = (c.height = Math.max(16, Math.round(img.height * s)));
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, W, H);
  let data: Uint8ClampedArray;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch { return; }
  const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const lums = new Float32Array(W * H);
  let sum = 0, sumL = 0, cntL = 0, sumR = 0, cntR = 0;
  const third = Math.max(1, Math.floor(W / 3));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lums[y * W + x] = lum; sum += lum;
    if (x < third) { sumL += lum; cntL++; }
    if (x >= W - third) { sumR += lum; cntR++; }
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (sat < 0.16 || l < 0.16 || l > 0.86) continue; // 跳过灰/过暗/过亮像素
    let h = 0;
    if (mx === r) h = ((g - b) / d + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    const w = sat * (1 - Math.abs(l - 0.52) * 0.85);
    const bin = bins[Math.min(23, Math.floor(h * 60 / 15))];
    bin.w += w; bin.r += data[i] * w; bin.g += data[i + 1] * w; bin.b += data[i + 2] * w;
  }
  // 复杂度:横向+纵向相邻亮度差均值,乘 6 拉伸到 0..1(经验值:平涂图 ~0.02,花哨图 ~0.12+)
  let edge = 0, edgeN = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x > 0) { edge += Math.abs(lums[y * W + x] - lums[y * W + x - 1]); edgeN++; }
    if (y > 0) { edge += Math.abs(lums[y * W + x] - lums[(y - 1) * W + x]); edgeN++; }
  }
  const best = bins.reduce((a, x) => (x.w > a.w ? x : a));
  const hex = (v: number) => Math.round(v / best.w).toString(16).padStart(2, "0");
  return {
    accent: best.w > 0 ? `#${hex(best.r)}${hex(best.g)}${hex(best.b)}` : undefined,
    lum: sum / (W * H),
    lumL: cntL ? sumL / cntL : sum / (W * H),
    lumR: cntR ? sumR / cntR : sum / (W * H),
    complexity: Math.min(1, (edgeN ? edge / edgeN : 0.08) * 6),
  };
}

// 外观:主题配色网格。每张卡片顶部一条双色预览(左=侧栏底色,右=主色),点选即时应用(App 持久化到 localStorage)。
// 子页面顶部返回条。用 onMouseDown 而非 onClick:第一次点击常先 blur 当前聚焦的输入框、
// 触发重排,onClick(mouseup 阶段)会落在移动后的位置而丢失 —— 这就是"要点两次"的根因。
function BackBtn({ label, onBack }: { label: string; onBack: () => void }) {
  return <button type="button" className="settings-back" onMouseDown={(e) => { e.preventDefault(); onBack(); }}><ChevronLeft size={15} /> {label}</button>;
}

// 选中"自定义"时,直接进背景图设置子页。
function AppearanceTab({ theme, onPick, customBg, customBlur, customBrightness, onSetCustomBg, onSetCustomBlur, onSetCustomBrightness }: { theme: ThemeId; onPick: (id: ThemeId) => void; customBg: string; customBlur: number; customBrightness: number; onSetCustomBg: (url: string, artJson?: string) => void; onSetCustomBlur: (v: number) => void; onSetCustomBrightness: (v: number) => void }) {
  const { t } = useTranslation();
  const { syncUiLang } = useStore();
  const langSel = selectedLang();
  const changeLang = (l: "zh" | "en" | "auto") => {
    if (l === "auto") resetLang(); else setLang(l);
    syncUiLang(getLang()); // 让后端聊天消息也切语言
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [bgPage, setBgPage] = useState(false); // 自定义背景设置:面板内切页
  // 原图(手机照片常 3~8MB)base64 后会撑爆 localStorage ~5MB 配额,存前用 canvas 缩到 ≤1920px 的 JPEG。
  const pickFile = (f?: File) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1920;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) { onSetCustomBg(String(r.result)); return; } // 兜底:拿不到画布就存原图
        ctx.drawImage(img, 0, 0, w, h);
        const art = analyzeArt(img);
        onSetCustomBg(c.toDataURL("image/jpeg", 0.85), art ? JSON.stringify(art) : undefined);
      };
      img.onerror = () => onSetCustomBg(String(r.result));
      img.src = String(r.result);
    };
    r.readAsDataURL(f);
  };
  const bgPanel = (
    <div className="custom-theme-panel">
      <p className="muted">{t("上传一张图片作为背景。系统自动分析图片的亮度、构图与复杂度:主区保护层自动选明暗、透明度随图的复杂程度调节(始终保证文字对比 ≥4.5:1),图片主色用于按钮、选中态与用户气泡。")}</p>
      <div className="custom-bg-preview" style={customBg ? { backgroundImage: `url("${customBg}")` } : undefined}>
        {!customBg && <span className="muted">{t("未选择图片")}</span>}
      </div>
      <div className="custom-theme-ops">
        <button type="button" className="primary" onClick={() => fileRef.current?.click()}>{customBg ? t("更换图片") : t("上传图片")}</button>
        {customBg && <button type="button" onClick={() => onSetCustomBg("")}>{t("移除")}</button>}
      </div>
      <div className="custom-slider-row">
        <label>{t("侧栏模糊")}<span className="muted">{customBlur}px</span></label>
        <input type="range" min={0} max={40} step={1} value={customBlur} onChange={(e) => onSetCustomBlur(Number(e.target.value))} />
      </div>
      <div className="custom-slider-row">
        <label>{t("侧栏亮度")}<span className="muted">{Math.round(customBrightness * 100)}%</span></label>
        <input type="range" min={50} max={150} step={5} value={Math.round(customBrightness * 100)} onChange={(e) => onSetCustomBrightness(Number(e.target.value) / 100)} />
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
    </div>
  );
  if (bgPage) {
    return (
      <section className="settings-section settings-subpage">
        <BackBtn label={t("返回语言与主题")} onBack={() => setBgPage(false)} />
        <h4>{t("自定义背景")}</h4>
        {bgPanel}
      </section>
    );
  }
  return (
    <section className="settings-section">
      <h4>{t("界面语言")}</h4>
      <div className="lang-row">
        {(["zh", "en", "auto"] as const).map((l) => (
          <button key={l} type="button" className={`lang-btn${langSel === l ? " sel" : ""}`} onClick={() => changeLang(l)}>
            {l === "zh" ? "中文" : l === "en" ? "English" : t("跟随系统")}
          </button>
        ))}
      </div>
      <h4>{t("主题配色")}</h4>
      <div className="theme-grid">
        {/* 形参别叫 t:会盖掉外层翻译函数,label 就永远是中文原文 */}
        {THEMES.map((th) => (
          // 「自定义 · 背景图」点了直接进背景设置子页(顺带选中 custom 主题);其余主题只是切配色
          <button key={th.id} type="button" className={`theme-card ${theme === th.id ? "sel" : ""}`}
            onPointerDown={(e) => { e.stopPropagation(); onPick(th.id); if (th.id === "custom") setBgPage(true); }}>
            <span className="theme-swatch"><span style={{ background: th.swatch[0] }} /><span style={{ background: th.swatch[1] }} /></span>
            <span className="theme-card-label">{t(th.label)}{theme === th.id && <Check size={14} />}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const Dot = ({ ok }: { ok: boolean }) => <span className={`auth-dot ${ok ? "on" : "off"}`}>●</span>;

// provider 显示元数据:徽标字母 + logo css class。顺序即渲染顺序。
const PROVIDER_META: { id: string; ini: string; cls: string }[] = [
  { id: "deepseek", ini: "DS", cls: "deepseek" },
  { id: "kimi", ini: "K", cls: "kimi" },
  { id: "glm", ini: "GLM", cls: "glm" },
  { id: "qwen", ini: "Q", cls: "qwen" },
  { id: "minimax", ini: "MM", cls: "minimax" },
  { id: "grok", ini: "X", cls: "grok" },
  { id: "openai", ini: "O", cls: "openai" },
  { id: "gemini", ini: "G", cls: "gemini" },
];

// 账号:Claude 登录 + 各第三方 LLM(key + baseUrl/模型可编辑)
function AccountTab() {
  const { t } = useTranslation();
  const { state, authAction, setCnEndpoint } = useStore();
  const c = state.auth?.claude;
  const provs = state.auth?.providers ?? {};
  const cnList = Object.values(provs).filter((p) => p.cnAvailable || p.baseUrlCN).map((p) => p.label);
  const [edit, setEdit] = useState<{ id: string; mode: "key" | "config" } | null>(null);
  if (edit) return <ProviderEditPage id={edit.id} mode={edit.mode} onDone={() => setEdit(null)} />;
  return (
    <section className="settings-section">
      <h4>{t("大模型账号")}</h4>
      <div className="provider-row">
        <div className="provider-id"><ProviderLogo name="Claude" cls="claude" ini="C" /><div><b>Claude</b><div className="muted">Anthropic · SDK v{SDK_VERSION}</div></div></div>
        <div className="provider-status">
          {!c ? <span className="muted">{t("检测中…")}</span> :
            c.loggedIn ? <><Dot ok /> {t("已登录")} <span className="muted">{c.method}</span></> :
            !c.installed ? <><Dot ok={false} /> <span className="muted">{t("未安装 claude CLI")}</span></> :
            <><Dot ok={false} /> {t("未登录")}</>}
        </div>
        <div className="provider-actions">
          {c?.loggedIn
            ? <button onClick={() => authAction("claude", "logout")}>{t("登出")}</button>
            : <button className="primary" disabled={!c?.installed} onClick={() => authAction("claude", "login")}>{t("登录")}</button>}
        </div>
      </div>

      {PROVIDER_META.filter((m) => provs[m.id]).map((m) => <ProviderRow key={m.id} meta={m} onEdit={(mode) => setEdit({ id: m.id, mode })} />)}

      {/* 国内节点:只影响自带国内域名的那几家(GLM/Qwen/MiniMax),其余不受影响。
          现在只是探测的优先顺序 —— 存 key 时会两个域名都试,哪个认这把 key 就用哪个,勾错也不会连不上。 */}
      <label className="profile-kb">
        <input type="checkbox" checked={!!state.auth?.cnEndpoint} onChange={(e) => setCnEndpoint(e.target.checked)} />
        {t("优先国内节点")}
        <span className="muted"> {cnList.length ? cnList.join(" / ") : ""}</span>
      </label>
      <p className="settings-note">{t("国际站和国内站是两套账号,同一把 key 只在其中一边有效。配好 key 后会自动试出该走哪边,上面每家显示的域名就是实际连的那个 —— 这个勾只决定先试哪边。")}</p>

      <p className="settings-note">{t("Claude 登录走系统终端真实 OAuth。第三方 key 只存本地 settings 文件(仅本机,不进仓库/keychain)。 标「经本地代理」的(Grok/OpenAI/Gemini)只有 OpenAI 兼容端点,由本机把 Anthropic 请求转译过去,CLI 无感。 baseUrl / 模型表会随版本漂移 —— 连不上时点「配置」改。配好在 /model 菜单选对应模型即切换,换 provider 会开启全新对话。")}</p>
    </section>
  );
}

// baseUrl 只取域名显示。用户可以手填任意串,URL() 解析不了就原样截断,别让设置页整块崩掉。
function hostOf(u: string) {
  try { return new URL(u).host; } catch { return u.slice(0, 40); }
}

// 单个第三方 provider 行:状态 + 操作按钮;key 输入与 baseUrl/模型表编辑走面板内切页(见 ProviderEditPage)。
function ProviderRow({ meta, onEdit }: { meta: { id: string; ini: string; cls: string }; onEdit: (mode: "key" | "config") => void }) {
  const { t } = useTranslation();
  const { id, ini, cls } = meta;
  const { state, setProviderKey } = useStore();
  const p = state.auth?.providers?.[id];
  const configured = !!p?.configured;
  const proxied = p?.transport === "openai";
  return (
    <div className="provider-row">
      <div className="provider-id"><ProviderLogo name={id} cls={cls} ini={ini} /><div><b>{p?.label || id}</b>
        {/* 配好 key 后把实际连的域名显示出来:国际站/国内站是自动探出来的,不显示的话用户无从知道走的哪边 */}
        <div className="muted">{proxied ? t("OpenAI 兼容 · 经本地代理") : t("Anthropic 兼容 · 直连")}
          {configured && p?.baseUrl ? ` · ${hostOf(p.baseUrl)}` : ""}</div></div></div>
      <div className="provider-status">{configured ? <><Dot ok /> {t("已配置 key")}</> : <><Dot ok={false} /> {t("未配置")}</>}</div>
      <div className="provider-actions">
        <button className={configured ? "" : "primary"} onClick={() => onEdit("key")}>{configured ? t("更换") : t("配置 key")}</button>
        <button onClick={() => onEdit("config")}>{t("配置")}</button>
        {configured && <button onClick={() => setProviderKey(id, "")}>{t("清除")}</button>}
      </div>
    </div>
  );
}

// provider 的 key / baseUrl+模型表编辑:面板内切页,不再弹窗套弹窗
function ProviderEditPage({ id, mode, onDone }: { id: string; mode: "key" | "config"; onDone: () => void }) {
  const { t } = useTranslation();
  const { state, setProviderKey, setProviderConfig } = useStore();
  const p = state.auth?.providers?.[id];
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p?.baseUrl || "");
  const [modelsText, setModelsText] = useState(() => JSON.stringify(p?.models ?? [], null, 2));
  const [err, setErr] = useState("");
  const saveKey = () => { const k = key.trim(); if (!k) return; setProviderKey(id, k); onDone(); };
  const saveConfig = () => {
    let models: any;
    try { models = JSON.parse(modelsText); if (!Array.isArray(models)) throw new Error(); } catch { setErr(t("模型必须是 JSON 数组")); return; }
    setProviderConfig(id, { baseUrl: baseUrl.trim() || undefined, models });
    onDone();
  };
  const resetConfig = () => { setProviderConfig(id, null); onDone(); };
  return (
    <section className="settings-section settings-subpage">
      <BackBtn label={t("返回大模型账号")} onBack={onDone} />
      {mode === "key" ? (
        <>
          <h4>{p?.configured ? t("更换") : t("配置")} API key — {p?.label || id}</h4>
          <input className="provider-key-input" type="password" autoFocus placeholder={t("粘贴 API key")} value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveKey(); }} />
          <div className="commit-modal-actions" style={{ marginTop: 12 }}>
            <button onClick={onDone}>{t("取消")}</button>
            <button className="hi" disabled={!key.trim()} onClick={saveKey}>{t("保存")}</button>
          </div>
        </>
      ) : (
        <>
          <h4>{t("配置")} — {p?.label || id}</h4>
          <label className="provider-config-field"><span>baseUrl</span>
            <input value={baseUrl} placeholder={p?.defaultBaseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
          <label className="provider-config-field"><span>{t("模型表 (JSON)")}</span>
            <textarea className="provider-config-models" spellCheck={false} value={modelsText} onChange={(e) => setModelsText(e.target.value)} /></label>
          {/* price 是选填的:填了用量条显示金额,不填只显示 token 数。单价按每 100 万 token 计,
              各家调价频繁又分币种,所以放这里让用户自己填,代码不写死。vision 同理,填了覆盖出厂判断。 */}
          <div className="provider-config-hint muted">{t("每项")}:{`{ "value": "${id}/模型id", "model": "模型id", "displayName": "显示名", "contextWindow": 200000, "vision": false, "price": { "in": 2, "out": 3, "cacheRead": 0.2, "currency": "¥" } }`}</div>
          {err && <div className="provider-config-err">{err}</div>}
          <div className="commit-modal-actions" style={{ marginTop: 12 }}>
            <button onClick={resetConfig}>{t("恢复默认")}</button>
            <button onClick={onDone}>{t("取消")}</button>
            <button className="hi" onClick={saveConfig}>{t("保存配置")}</button>
          </div>
        </>
      )}
    </section>
  );
}

// GitHub:gh CLI 登录
function GithubTab() {
  const { t } = useTranslation();
  const { state, authAction } = useStore();
  const g = state.auth?.github;
  return (
    <section className="settings-section">
      <h4>GitHub</h4>
      <div className="provider-row">
        {/* 登录状态就是这行的副标题,不另占一列 */}
        <div className="provider-id"><span className="provider-logo github"><GitBranch size={16} /></span><div><b>GitHub CLI</b>
          <div className="provider-status">
            {!g ? <span className="muted">{t("检测中…")}</span> :
              !g.installed ? <><Dot ok={false} /> <span className="muted">{t("未安装 gh CLI")}</span></> :
              g.loggedIn ? <><Dot ok /> {t("已登录")} <span className="muted">{g.account || ""}</span></> :
              <><Dot ok={false} /> {t("未登录")}</>}
          </div>
        </div></div>
        <div className="provider-actions">
          {g?.loggedIn
            ? <button onClick={() => authAction("github", "logout")}>{t("登出")}</button>
            : <button className="primary" disabled={!g?.installed} onClick={() => authAction("github", "login")}>{t("登录")}</button>}
        </div>
      </div>
      {g?.detail && <pre className="settings-detail">{g.detail}</pre>}
      {/* 只在未登录时给操作说明 —— 登录后这句就是废话,还占一行 */}
      {!g?.loggedIn && <p className="settings-note">{t("登录会在系统终端运行")} <code>gh auth login --web</code>{t(",按提示在浏览器授权即可。")}</p>}
    </section>
  );
}

// SSH:全局主机预设的增删改查 + 连通性测试
function SshTab() {
  const { t } = useTranslation();
  const { state, saveSshHost, deleteSshHost, testSshHost } = useStore();
  const [editing, setEditing] = useState<SshHost | null>(null);
  // 新增/编辑:面板内切页,不再和列表挤在一起
  if (editing) {
    return (
      <section className="settings-section settings-subpage">
        <BackBtn label={t("返回 SSH 列表")} onBack={() => setEditing(null)} />
        <h4>{t(editing.id ? "编辑 SSH 主机" : "新增 SSH 主机")}</h4>
        <SshHostForm host={editing} onCancel={() => setEditing(null)}
          onSave={(h) => { saveSshHost(h); setEditing(null); }} />
      </section>
    );
  }
  return (
    <section className="settings-section">
      <div className="settings-section-head"><h4>{t("SSH 主机预设")}</h4><button className="primary" onClick={() => setEditing({ host: "" })}><Plus size={14} /> {t("新增")}</button></div>
      {state.sshHosts.length === 0 && !editing && <p className="muted">{t("暂无预设。新增后可在会话里快速复用。")}</p>}
      <div className="ssh-host-list">
        {state.sshHosts.map((h) => {
          const st = h.id ? state.sshTests[h.id] : undefined;
          return (
            <div className="ssh-host-row" key={h.id}>
              <div className="ssh-host-meta">
                <b>{h.label || h.host}</b>
                <div className="muted">{h.username ? `${h.username}@` : ""}{h.host}{h.port && h.port !== "22" ? `:${h.port}` : ""}{h.keyPath ? ` · ${h.keyPath}` : ""}</div>
                {st && <div className={`ssh-test-result ${st.ok ? "ok" : "fail"}`}>{st.ok ? <><Check size={13} /> {t("连接成功")}</> : <><X size={13} /> {st.detail || t("连接失败")}</>}</div>}
              </div>
              <div className="ssh-host-actions">
                <button className="ghost" onClick={() => testSshHost(h)} title={t("测试连接")}>{t("测试")}</button>
                <button className="ghost" onClick={() => setEditing(h)}>{t("编辑")}</button>
                <button className="ghost danger" onClick={() => h.id && deleteSshHost(h.id)}>{t("删除")}</button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="settings-note">{t("预设保存在本机,私钥仅存路径不存内容。仅支持密钥认证(无 TTY 不支持交互式密码)。")}</p>
    </section>
  );
}

function SshHostForm({ host, onSave, onCancel }: { host: SshHost; onSave: (h: SshHost) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<SshHost>({ port: "22", ...host });
  const set = (k: keyof SshHost) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <form className="ssh-host-form" onSubmit={(e) => { e.preventDefault(); if (f.host.trim()) onSave({ ...f, host: f.host.trim() }); }}>
      {/* 除私钥路径外都不给 placeholder:灰字示例长得像已填好的值,分不清哪些是真填了的 */}
      <label>{t("名称(可选)")}<input value={f.label || ""} onChange={set("label")} /></label>
      <label>{t("主机 / IP")}<input autoFocus required value={f.host} onChange={set("host")} /></label>
      <label>{t("ssh.username")}<input value={f.username || ""} onChange={set("username")} /></label>
      <label>{t("端口")}<input value={f.port || ""} onChange={set("port")} inputMode="numeric" /></label>
      <label>{t("私钥路径(可选)")}<input value={f.keyPath || ""} onChange={set("keyPath")} placeholder={t("如 ~/.ssh/id_ed25519")} /></label>
      <div className="settings-form-actions"><button type="button" className="ghost" onClick={onCancel}>{t("取消")}</button><button className="primary" type="submit">{t("保存")}</button></div>
    </form>
  );
}

const errMsg = (e: any) => (e instanceof ApiError ? e.message : String(e?.message || e)).split("\n")[0];

// GitHub 品牌标记(lucide 已移除品牌图标,用官方 mark 内联 SVG)
const GithubMark = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
);

// 个人资料:头像 + 昵称
function ProfileTab() {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(getAvatar);
  const [name, setName] = useState(getUserName);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => { setSrc(getAvatar()); setName(getUserName()); };
    window.addEventListener("chatcode-avatar-change", sync);
    return () => window.removeEventListener("chatcode-avatar-change", sync);
  }, []);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) fileToAvatar(f); };
  return (
    <section className="settings-section">
      <h4>{t("个人资料")}</h4>
      <div className="profile-row">
        <span className="avatar avatar-user profile-avatar" onClick={() => fileRef.current?.click()} title={t("点击更换头像")}>
          {src ? <img src={src} alt={t("我")} /> : <span className="avatar-fallback">{name ? name.slice(0, 1).toUpperCase() : t("我")}</span>}
        </span>
        <div className="profile-avatar-actions">
          <button className="primary" onClick={() => fileRef.current?.click()}>{t("上传头像")}</button>
          {src && <button className="ghost" onClick={() => setAvatar(null)}>{t("移除")}</button>}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
        </div>
      </div>
      <label className="profile-name">{t("昵称")}
        <input value={name} onChange={(e) => { setName(e.target.value); setUserName(e.target.value); }} placeholder={t("我")} maxLength={24} />
      </label>
    </section>
  );
}

// 关于:当前版本 + 检查更新
function AboutTab() {
  const { t } = useTranslation();
  const [ver, setVer] = useState<VersionCheck | null>(null);
  const [verBusy, setVerBusy] = useState(false);
  const doCheck = async () => {
    setVerBusy(true);
    try { const v = await checkVersion(); setVer(v); if (!v.hasUpdate) toast(t("已是最新版本 v{{version}}", { version: v.current })); }
    catch (e) { errToast(errMsg(e)); } finally { setVerBusy(false); }
  };
  return (
    <section className="settings-section">
      <h4>{t("关于")}</h4>
      <div className="ver-row">
        <span>{t("当前版本")} <b>v{APP_VERSION}</b></span>
        <button className="primary" disabled={verBusy} onClick={doCheck}>{verBusy ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />} {t("检查更新")}</button>
      </div>
      {ver && (ver.hasUpdate ? (
        <div className="update-note">
          <div><b>{t("发现新版本 v{{version}}", { version: ver.latestVersion })}</b>{ver.forced && <span className="mkt-tag" style={{ marginLeft: 6 }}>{t("需强制更新")}</span>}</div>
          {ver.releaseNotes && <p className="settings-note" style={{ whiteSpace: "pre-wrap" }}>{ver.releaseNotes}</p>}
          {ver.updateUrl && <button className="primary" onClick={() => openUrl(ver.updateUrl)}><ExternalLink size={13} /> {t("前往下载")}</button>}
        </div>
      ) : <p className="settings-note">{t("已是最新版本。")}</p>)}
    </section>
  );
}

// mkt:插件所属市场。同名插件可以来自不同市场(如 superpowers@superpowers 与 superpowers@superpowers-dev),
// 只按 name 找就会把开关点到另一个同名插件上("已经是停用的"报错)。行的身份、React key 都得带上它。
type ExtRow = { name: string; desc: string; status?: string; path?: string; url?: string; on?: boolean; project?: string; mkt?: string };

// 项目名标签最多 10 个字符,超长省略号截断(完整名放 title 里)
const shortProject = (s: string) => (s.length > 10 ? s.slice(0, 10) + "…" : s);

// 插件 / MCP / Skills 各一组,一项一行:状态点在名字左侧。
// 点击:Skills/插件的 md 文件用内置代码编辑器打开;MCP 直接用浏览器打开远端 url。
// 用户给每个 插件/MCP/Skill 加的备注,按名字存本地(仅本机,不进仓库)
const EXT_NOTES_KEY = "cc-ext-notes";
const loadExtNotes = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(EXT_NOTES_KEY) || "{}"); } catch { return {}; } };
function saveExtNote(name: string, note: string) {
  const all = loadExtNotes();
  if (note.trim()) all[name] = note.trim(); else delete all[name];
  try { localStorage.setItem(EXT_NOTES_KEY, JSON.stringify(all)); } catch { /* 隐私模式写不了,忽略 */ }
}

// on === undefined 的行没有开关/删除按钮(内置技能、claude.ai 云端连接器这类本地没有文件、管不了的)。
// naTag = 给这类行打的小标签,说明"为什么这行没按钮"(不传就不打)。
function ExtGroup({ items, empty, onToggle, onDelete, naTag, naHint }: {
  items: ExtRow[]; empty: string;
  onToggle?: (it: ExtRow) => Promise<void>;
  onDelete?: (it: ExtRow) => Promise<void>;
  naTag?: string; naHint?: string;
}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<Record<string, string>>(loadExtNotes);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [askDel, setAskDel] = useState<ExtRow | null>(null); // 弹窗确认(Tauri 的 confirm() 不可靠,自己画一个)
  const rowKey = (it: ExtRow) => (it.mkt ? `${it.name}@${it.mkt}` : it.name); // 同名不同市场的插件要能分开
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setAskDel(null);
    try { await fn(); } catch (e: any) { errToast(String(e?.message || e).split("\n")[0] || t("操作失败")); }
    finally { setBusy(null); }
  };
  const open = (it: ExtRow) => {
    if (it.url) openUrl(it.url);
    else if (it.path) openEditorWindow(it.path, it.name);
  };
  const startEdit = (name: string) => { setDraft(notes[name] || ""); setEditing(name); };
  const commit = (name: string) => { saveExtNote(name, draft); setNotes(loadExtNotes()); setEditing(null); };
  return (
    <div className="ext-group">
      {!items.length && <div className="ext-empty">{t(empty)}</div>}
      {items.map((it) => {
        const actionable = !!(it.url || it.path);
        // 备注三级兜底:自己写的 > 内置中文说明 > 磁盘上 SKILL.md / plugin.json 的英文 description
        const note = notes[it.name] || EXT_NOTE_ZH[it.name] || it.desc;
        return (
          <div key={rowKey(it)} className={`ext-item ${actionable ? "clickable" : ""}${it.on === false ? " off" : ""}`}
            title={it.url ? t("点击用浏览器打开") : it.path ? t("点击用代码编辑器打开") : undefined}
            onClick={actionable && editing !== it.name ? () => open(it) : undefined}>
            {it.status && <span className={`ext-dot ${it.status === "connected" ? "ok" : "err"}`} title={it.status}>●</span>}
            <div className="ext-main">
              {/* 标签一律排在名字右侧,不再一前一后参差不齐 */}
              <span className="ext-nameline">
                <span className="ext-name">{it.name}</span>
                {it.project && <span className="ext-tag proj" title={t("项目级 skill,来自 {{project}}", { project: it.project })}>{shortProject(it.project)}</span>}
                {/* 市场名:同名插件靠它区分(superpowers@superpowers vs superpowers@superpowers-dev) */}
                {it.mkt && <span className="ext-tag na" title={t("来自市场 {{mkt}}", { mkt: it.mkt })}>{it.mkt}</span>}
                {it.on === undefined && naTag && <span className="ext-tag na" title={naHint ? t(naHint) : undefined}>{t(naTag)}</span>}
              </span>
              {editing === it.name ? (
                <input className="ext-note-input" autoFocus value={draft} placeholder={t("添加备注…")}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(it.name)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(it.name); } else if (e.key === "Escape") { e.preventDefault(); setEditing(null); } }} />
              ) : note ? <span className="ext-note" title={note}>{note}</span> : null}
            </div>
            {/* onMouseDown 而非 onClick:WKWebView 首点常被吞;stopPropagation 免触发整行打开 */}
            <button className="ext-note-btn ext-copy-btn" title={t("复制名字")}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); copyText(it.name).then((ok) => ok && toast(t("已复制"), "success")); } }}><Copy size={12} /></button>
            <button className="ext-note-btn" title={note ? t("编辑备注") : t("添加备注")}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); startEdit(it.name); } }}><Pencil size={12} /></button>
            {onDelete && it.on !== undefined && (
              <button className="ext-note-btn" disabled={busy === rowKey(it)} title={t("删除")}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); setAskDel(it); } }}>
                <Trash2 size={12} />
              </button>
            )}
            {onToggle && it.on !== undefined && (
              <button type="button" role="switch" aria-checked={it.on} disabled={busy === rowKey(it)}
                className={`ext-switch${it.on ? " on" : ""}`}
                title={it.on ? t("已启用,点击停用(保留安装)") : t("已停用,点击启用")}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); act(rowKey(it), () => onToggle(it)); } }} />
            )}
          </div>
        );
      })}
      {askDel && onDelete && (
        <div className="commit-modal-overlay" onClick={() => setAskDel(null)}>
          <div className="commit-modal ext-del-modal" onClick={(e) => e.stopPropagation()}>
            <div className="commit-modal-title">{t("确认删除 {{name}}?", { name: askDel.name })}</div>
            <p className="git-map-hint">
              {t("会把它的整个目录从磁盘删掉,不可撤销。")}<br />
              {t("删除将在会话关闭后生效 —— 正在运行的会话仍会用旧的那份。")}
            </p>
            <div className="commit-modal-actions">
              <button type="button" onMouseDown={(e) => { e.preventDefault(); setAskDel(null); }}>{t("取消")}</button>
              <button type="button" className="hi danger" onMouseDown={(e) => {
                e.preventDefault(); const it = askDel; act(rowKey(it), () => onDelete(it));
              }}>{t("删除")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 失败一律走 error 语气(红图标 + 更长停留),成功/中间态由调用处显式指定
const errToast = (text: string) => toast(text, "error");

// 已删除的 skill 名。会话 init 上报的 info.skills 是启动时的快照,删掉目录后那条还挂在快照里,
// 不记一笔就会在列表里留下一行"没有开关也删不掉"的幽灵,直到会话重开。
// 重新装回来时 reloadExts 会把它从这里剔除。
const GONE_SKILLS_KEY = "cc-skills-removed";
const loadGoneSkills = (): string[] => { try { return JSON.parse(localStorage.getItem(GONE_SKILLS_KEY) || "[]"); } catch { return []; } };
const saveGoneSkills = (names: string[]) => { try { localStorage.setItem(GONE_SKILLS_KEY, JSON.stringify(names)); } catch { /* 隐私模式写不了,忽略 */ } };

// skills 列表顶部:输入 github 仓库地址装 skill。只认 github;非 skill 仓库后端报错弹 toast。
function SkillInstaller({ onInstalled }: { onInstalled: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const isGithub = /github\.com[/:]/.test(url) || /^git@github\.com:/.test(url);
  const install = async () => {
    const u = url.trim();
    if (!u) return;
    if (!isGithub) { errToast(t("只支持 github 仓库地址")); return; }
    setBusy(true);
    try {
      const names = await installSkillGit(u);
      toast(t("已安装 skill:{{n}}", { n: names.join("、") }), "success");
      setUrl(""); onInstalled();
    } catch (e: any) { errToast(String(e?.message || e).split("\n")[0] || t("安装失败")); }
    finally { setBusy(false); }
  };
  return (
    <div className="mkt-addrow skill-install">
      <input value={url} onChange={(e) => setUrl(e.target.value)}
        placeholder={t("github 仓库地址,如 github.com/owner/skill-repo")}
        onKeyDown={(e) => { if (e.key === "Enter") install(); }} />
      <button className="mkt-btn" disabled={busy || !url.trim()} onClick={install}>
        {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {t("安装")}
      </button>
    </div>
  );
}

// 插件市场:读磁盘上已加市场的 marketplace.json 列可装插件;装/卸/启停/加源壳调 claude CLI。
// 改动插件后自动重启空闲会话让新 Skills · MCP 生效;工作中的会话不动,只提示手动重开。
function Marketplace({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const { state, restartSession } = useStore();
  const [items, setItems] = useState<MarketPlugin[] | null>(null);
  const [mkts, setMkts] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("全部");
  const [busy, setBusy] = useState<string | null>(null); // 正在操作的 "name@mkt"
  const [repo, setRepo] = useState("");
  const [addingMkt, setAddingMkt] = useState(false);
  const [addOpen, setAddOpen] = useState(false); // 加源弹窗
  const [page, setPage] = useState(1); // 分页:每页 20 条,页数递增加载
  const [preview, setPreview] = useState<MarketPlugin | null>(null);
  const [readme, setReadme] = useState<string | null>(null); // null=加载中,""=无

  const refresh = () => {
    loadMarketplace().then(setItems).catch(() => setItems([]));
    marketplaceNames().then(setMkts).catch(() => {});
  };
  useEffect(refresh, []);

  // 改动生效:重启空闲(活着)会话,工作中的返回计数由调用方提示。closed 会话下次打开本就重载,跳过。
  const applyToSessions = (): number => {
    let working = 0;
    for (const s of Object.values(state.sessions)) {
      if (s.status === "running" || s.status === "waiting") working++;
      else if (s.status === "idle") restartSession(s.id);
    }
    return working;
  };

  const run = async (key: string, fn: () => Promise<void>, ok: string, affects = false) => {
    setBusy(key);
    try {
      await fn(); refresh(); onChanged();
      const working = affects ? applyToSessions() : 0;
      toast(working > 0 ? t("{{msg}},{{count}} 个工作中会话需完成后手动重开", { msg: ok, count: working }) : ok);
    } catch (e: any) { errToast(String(e?.message || e).split("\n")[0] || t("操作失败")); }
    finally { setBusy(null); }
  };

  const openPreview = (p: MarketPlugin) => {
    setPreview(p); setReadme(null);
    if (p.installed && p.installPath) {
      invoke<string>("read_file", { path: `${p.installPath}/README.md` }).then(setReadme).catch(() => setReadme(""));
    } else setReadme("");
  };

  const query = q.trim().toLowerCase();
  const cats = ["全部", "已安装", ...[...new Set((items ?? []).map((p) => p.category).filter(Boolean))].sort()];
  const shown = (items ?? []).filter((p) =>
    (cat === "全部" || (cat === "已安装" ? p.installed : p.category === cat)) &&
    (!query || p.name.toLowerCase().includes(query) || p.desc.toLowerCase().includes(query) || p.category.toLowerCase().includes(query)));

  const missingSeeds = SEED_MARKETPLACES.filter((s) => !mkts.includes(s.name));
  const doAddRepo = () => { setAddingMkt(true); run(`mkt:${repo}`, () => addMarketplace(repo.trim()), t("已添加市场")).finally(() => { setRepo(""); setAddingMkt(false); setAddOpen(false); }); };

  // 筛选变了就回到第 1 页;分页:每页 20 条
  useEffect(() => { setPage(1); }, [query, cat]);
  const PAGE = 20;
  const visible = shown.slice(0, page * PAGE);

  // 详情页:直接在设置面板内切页(不再弹窗套弹窗),顶部返回列表
  if (preview) {
    return (
      <section className="settings-section settings-subpage">
        <BackBtn label={t("返回插件列表")} onBack={() => setPreview(null)} />
        <div className="mkt-page-head">
          <div className="mkt-modal-title">{preview.name}</div>
          <div className="mkt-modal-meta">
            {preview.author && <span>{preview.author}</span>}
            {preview.category && <span className="mkt-tag">{preview.category}</span>}
            <span className="mkt-mkt">{preview.marketplace}</span>
          </div>
        </div>
        {preview.desc && <p className="mkt-modal-desc">{preview.desc}</p>}
        {readme === null ? <p className="settings-note">{t("读取 README…")}</p>
          : readme ? <div className="md mkt-readme"><Markdown remarkPlugins={[remarkGfm]}>{readme}</Markdown></div>
          : <p className="settings-note">{preview.installed ? t("该插件没有 README。") : t("未安装,装好后可在此看 README。可先打开主页了解。")}</p>}
        {preview.homepage && (
          <div className="mkt-modal-foot">
            <button className="mkt-btn ghost" onClick={() => openUrl(preview.homepage)}>
              <ExternalLink size={13} /> {t("打开主页")}
            </button>
          </div>
        )}
      </section>
    );
  }
  if (addOpen) {
    return (
      <section className="settings-section settings-subpage">
        <BackBtn label={t("返回插件列表")} onBack={() => setAddOpen(false)} />
        <h4>{t("添加市场源")}</h4>
        <div className="mkt-addrow">
          <input autoFocus value={repo} onChange={(e) => setRepo(e.target.value)}
            placeholder={t("owner/repo 或 git URL")}
            onKeyDown={(e) => { if (e.key === "Enter" && repo.trim()) doAddRepo(); }} />
          <button className="mkt-btn" disabled={!repo.trim() || addingMkt} onClick={doAddRepo}>
            {addingMkt ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {t("加源")}
          </button>
        </div>
        {missingSeeds.length > 0 && (
          <div className="mkt-seeds">
            {missingSeeds.map((s) => (
              <button key={s.name} className="mkt-seed" title={t(s.desc)}
                disabled={busy === `mkt:${s.name}`}
                onClick={() => run(`mkt:${s.name}`, () => addMarketplace(s.repo), t("已添加市场 {{name}}", { name: s.name }))}>
                {busy === `mkt:${s.name}` ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} {s.name}
              </button>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="settings-section">
      {/* 搜索框(内含搜索按钮)+ 加源按钮 同行 */}
      <div className="mkt-searchrow">
        <div className="mkt-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("搜索插件名 / 说明 / 分类…")}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <button className="mkt-search-go" title={t("搜索")} onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.blur()}>
            <Search size={14} />
          </button>
        </div>
        <button className="mkt-btn mkt-addsrc" onClick={() => setAddOpen(true)}>
          <Plus size={13} /> {t("加源")}
        </button>
      </div>

      {/* 分类 tab */}
      {(items?.length ?? 0) > 0 && (
        <div className="mkt-cats">
          {cats.map((c) => (
            <button key={c} className={`mkt-cat${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>{t(c)}</button>
          ))}
        </div>
      )}

      <div className="mkt-list">
        {items === null ? <p className="settings-note">{t("读取中…")}</p>
          : items.length === 0 ? <p className="settings-note">{t("还没有市场源。点右上「加源」加一个,插件就会列在这里。")}</p>
          : shown.length === 0 ? <p className="settings-note">{t("没有匹配的插件。")}</p>
          : visible.map((p) => {
            const key = `${p.name}@${p.marketplace}`;
            const b = busy === key;
            return (
              <div key={key} className={`mkt-item${p.installed && !p.enabled ? " off" : ""}`}>
                <div className="mkt-item-main" onClick={() => openPreview(p)} title={t("查看详情 / README")}>
                  <div className="mkt-item-head">
                    <span className="mkt-item-name">{p.name}</span>
                    {p.installed && !p.enabled && <span className="mkt-tag off">{t("已停用")}</span>}
                    {p.category && <span className="mkt-tag">{p.category}</span>}
                    <span className="mkt-mkt">{p.marketplace}</span>
                  </div>
                  {p.desc && <div className="mkt-item-desc">{p.desc}</div>}
                </div>
                <div className="mkt-item-acts">
                  {p.installed && (
                    p.enabled ? (
                      <button className="mkt-btn ghost" disabled={b} title={t("停用(保留安装)")}
                        onClick={() => run(key, () => disablePlugin(p.name, p.marketplace), t("已停用 {{name}}", { name: p.name }), true)}>
                        {b ? <Loader2 size={13} className="spin" /> : <PowerOff size={13} />}
                      </button>
                    ) : (
                      <button className="mkt-btn" disabled={b} title={t("启用")}
                        onClick={() => run(key, () => enablePlugin(p.name, p.marketplace), t("已启用 {{name}}", { name: p.name }), true)}>
                        {b ? <Loader2 size={13} className="spin" /> : <Power size={13} />}
                      </button>
                    )
                  )}
                  {p.installed ? (
                    <button className="mkt-btn ghost" disabled={b} title={t("卸载")}
                      onClick={() => run(key, () => uninstallPlugin(p.name, p.marketplace), t("已卸载 {{name}}", { name: p.name }), true)}>
                      {b ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                    </button>
                  ) : (
                    <button className="mkt-btn" disabled={b}
                      onClick={() => run(key, () => installPlugin(p.name, p.marketplace), t("已安装 {{name}}", { name: p.name }), true)}>
                      {b ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {t("安装")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>
      {visible.length < shown.length && (
        <button className="mkt-more" onClick={() => setPage((p) => p + 1)}>
          {t("加载更多(还有 {{count}} 个)", { count: shown.length - visible.length })}
        </button>
      )}
      <p className="settings-note">{t("改动插件后会自动重启空闲会话应用;工作中的会话不打断,完成后手动重开。市场清单来自已添加的源,搜索只匹配已拉取的源。")}</p>
    </section>
  );
}

// claude.ai 下发的远程连接器:本地没有配置文件,只能去 claude.ai 里管。
// agent 上报的名字就带 "claude.ai " 前缀(见 `claude mcp list`),没有别的标识可认。
const isCloudMcp = (n: string) => n.startsWith("claude.ai");

// 扩展页:插件 / Skills / MCP 都从磁盘扫描(无会话也能列出);会话上报的再合并进来(带 MCP 实时状态)
function ExtensionsTab() {
  const { t } = useTranslation();
  const { state, restartSession } = useStore();
  const loadedMcp = useMemo(() => [...new Map(Object.values(state.sessions)
    .flatMap((s) => s.info.mcp_servers ?? []).map((sv) => [sv.name, sv] as const)).values()], [state.sessions]);
  const loadedSkills = useMemo(() => [...new Set(Object.values(state.sessions).flatMap((s) => s.info.skills ?? []))], [state.sessions]);
  // 项目级 skill 在各自 cwd 下,只扫一个的话别的项目的 skill 会变成"扫不到 = 没有按钮"的一行
  const cwds = useMemo(() => {
    const all = [...Object.values(state.sessions).map((s) => s.cwd), state.index[0]?.cwd ?? ""].filter(Boolean);
    return [...new Set(all)];
  }, [state.sessions, state.index]);
  const cwdKey = cwds.join("|");
  const [exts, setExts] = useState<Exts | null>(null);
  const [gone, setGone] = useState<string[]>(loadGoneSkills);
  const reloadExts = async () => {
    const ex = await loadExtensions(cwds).catch(() => null);
    if (!ex) return;
    setExts(ex);
    // 重新装回来的就不再算"已删除",让它回到列表
    const still = loadGoneSkills().filter((n) => !ex.skillPath[n]);
    saveGoneSkills(still); setGone(still);
  };
  useEffect(() => { reloadExts(); }, [cwdKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 磁盘 + 会话并集,去重排序。
  // 会话上报的名字是它启动那一刻的快照:配置后来被删了,老会话照样还挂着 —— 这种残影磁盘上没配置,
  // 既没开关也没删除键,以前还被误打成"云端"标,看着像个删不掉的云端连接器。真·云端只有 claude.ai 那批,
  // 其余无配置的一律当残影剔掉(会话重开后本来也就没了)。
  const mcpNames = useMemo(
    () => [...new Set([...loadedMcp.map((s) => s.name), ...(exts?.mcp ?? [])])]
      .filter((n) => !exts || exts.mcpMeta[n] || isCloudMcp(n))
      .sort(),
    [loadedMcp, exts]);
  // 内置(磁盘上没 SKILL.md、管不了的)排最前,免得混在可管理的里头东一条西一条;组内按名字排
  const skillNames = useMemo(
    () => [...new Set([...loadedSkills, ...(exts?.skills ?? [])])]
      .filter((n) => !gone.includes(n))
      .sort((a, b) => (+!!exts?.skillPath[a] - +!!exts?.skillPath[b]) || a.localeCompare(b)),
    [loadedSkills, exts, gone]);
  const [sub, setSub] = useState<"skills" | "plugins" | "mcp" | "market">("skills");
  const TABS: [typeof sub, string][] = [["skills", "Skills"], ["plugins", "插件"], ["mcp", "MCP"], ["market", "市场"]];

  // 改完刷新列表,并重启空闲会话让新配置生效(和市场页同一套:工作中的会话不打断)
  const after = async (msg: string) => {
    await reloadExts();
    let working = 0;
    for (const s of Object.values(state.sessions)) {
      if (s.status === "running" || s.status === "waiting") working++;
      else if (s.status === "idle") restartSession(s.id);
    }
    // 改动只在会话重启后才生效,空闲的已自动重启,正在跑的不能打断,得说清楚
    toast(working > 0
      ? t("{{msg}}。有 {{count}} 个会话正在运行,等它跑完后手动重开该会话才会生效", { msg, count: working })
      : t("{{msg}},已重启空闲会话使其生效", { msg }));
  };

  return (
    <section className="settings-section">
      <div className="ext-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={`ext-tab${sub === id ? " on" : ""}`} onMouseDown={(e) => { e.preventDefault(); setSub(id); }}>{t(label)}</button>
        ))}
      </div>

      {sub === "market" ? <Marketplace onChanged={reloadExts} /> : (
        <>
          <div className="ext-panel in-settings">
            {sub === "skills" && <>
              <SkillInstaller onInstalled={reloadExts} />
              <ExtGroup empty={exts ? "未安装 Skills" : "读取中…"}
                naTag="内置" naHint="Claude Code 内置的技能,本地没有 SKILL.md 文件,所以不能停用或删除"
                items={skillNames.map((n) => ({ name: n, desc: exts?.skillDesc[n] || "", path: exts?.skillPath[n], on: exts?.skillOn[n], project: exts?.skillProject[n] }))}
                onToggle={async (it) => { await setSkillOn(it.path!, !it.on); await after(it.on ? t("已停用 {{name}}", { name: it.name }) : t("已启用 {{name}}", { name: it.name })); }}
                onDelete={async (it) => {
                  await removeSkill(it.path!);
                  const next = [...new Set([...loadGoneSkills(), it.name])];
                  saveGoneSkills(next); setGone(next); // 立刻从列表消失,不等会话重开
                  await after(t("已删除 {{name}}", { name: it.name }));
                }} />
            </>}
            {sub === "plugins" && <ExtGroup empty={exts ? "未安装插件" : "读取中…"}
              items={(exts?.plugins ?? []).map((p) => ({ name: p.name, desc: p.desc, path: p.path, on: p.on, mkt: p.marketplace }))}
              onToggle={async (it) => {
                await (it.on ? disablePlugin : enablePlugin)(it.name, it.mkt || "");
                await after(it.on ? t("已停用 {{name}}", { name: it.name }) : t("已启用 {{name}}", { name: it.name }));
              }}
              onDelete={async (it) => {
                await uninstallPlugin(it.name, it.mkt || "");
                await after(t("已卸载 {{name}}", { name: it.name }));
              }} />}
            {sub === "mcp" && <ExtGroup empty={exts ? "未配置 MCP" : "读取中…"}
              naTag="claude.ai" naHint="claude.ai 下发的远程连接器,本地没有配置文件,请到 claude.ai 里管理"
              items={mcpNames.map((n) => ({ name: n, status: loadedMcp.find((s) => s.name === n)?.status, url: exts?.mcpUrl[n], on: exts?.mcpMeta[n]?.on, desc: exts?.mcpDesc[n] || (isCloudMcp(n) ? t("claude.ai 远程连接器") : "") }))}
              onToggle={async (it) => {
                const m = exts?.mcpMeta[it.name]; if (!m) return;
                await setMcpOn(it.name, m.scope, m.config, !it.on, m.cwd);
                await after(it.on ? t("已停用 {{name}}", { name: it.name }) : t("已启用 {{name}}", { name: it.name }));
              }}
              onDelete={async (it) => {
                const m = exts?.mcpMeta[it.name]; if (!m) return;
                await removeMcp(it.name, m.scope, !!it.on, m.cwd);
                await after(t("已删除 {{name}}", { name: it.name }));
              }} />}
          </div>
        </>
      )}
    </section>
  );
}
