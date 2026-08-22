// 版本更新检测 + 几个全局版本常量。
// 只有一个出口请求:匿名 GET 一份公开版本号,不带 token、不带 body、不上传任何本地数据。
// fetch 用 tauri-plugin-http:走 Rust 原生发请求,绕开 webview CORS(接口未配 CORS 头,window.fetch 会 "Load failed")。
import { fetch } from "@tauri-apps/plugin-http";
import pkg from "../package.json";
import { version as TAURI_VERSION } from "../src-tauri/tauri.conf.json";
// 走相对路径而不是包名:SDK 的 exports 字段没开 "./package.json" 这条子路径,按包名 import 解析不到。
import { version as SDK_VERSION } from "../node_modules/@anthropic-ai/claude-agent-sdk/package.json";

// 版本号只有一个真源:src-tauri/tauri.conf.json 的 version —— 那份才是 tauri 真正打进 app 的。
// 具名 import,Vite 只内联这一个字符串(不像 SDK_VERSION 那样把整份 json 拖进 bundle)。
export const APP_VERSION = TAURI_VERSION;
// package.json / Cargo.toml 里各还有一份 version,发版时三处得一起改。
// 漏改一处 = 界面版本号与实际包不符,更新判断跟着错。开发期吵一声,构建产物里不会留。
if (import.meta.env.DEV && pkg.version !== TAURI_VERSION)
  console.warn(`[version] package.json ${pkg.version} ≠ tauri.conf.json ${TAURI_VERSION},发版时忘了同步`);
// 取**真正装上的**那份 SDK 的 version(node_modules 里的 package.json),不是我们 package.json 里的依赖范围。
// 范围是 ^0.3.x:换台机器 npm i 一次就可能装到更新的小版本,界面照着范围显示就会长期报个旧号。
// 具名 import,构建期常量(Vite 把这一个字符串内联),运行时不读文件。
export { SDK_VERSION };
export const PROJECT_ID = "chat-code"; // 项目 identifier(?project=)
export const PLATFORM = "macos";

const LS = { lastVerCheck: "cc-last-ver-skip" };

export class ApiError extends Error {
  status: number;
  retryAfter?: number;
  constructor(m: string, s: number, r?: number) { super(m); this.status = s; this.retryAfter = r; }
}

// ---- 版本更新检测 ----
export interface VersionInfo { latestVersion: string; minVersion: string; updateUrl: string; releaseNotes: string }
export interface VersionCheck extends VersionInfo { current: string; hasUpdate: boolean; forced: boolean }
function cmpVer(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
// 建议更新的提示节奏:每 3 天最多弹一次(强制更新不看这个,每次开都弹)
const VER_PROMPT_GAP = 3 * 24 * 60 * 60 * 1000;
export const shouldPromptUpdate = () => Date.now() - Number(localStorage.getItem(LS.lastVerCheck) || 0) >= VER_PROMPT_GAP;
export const markUpdatePrompted = () => localStorage.setItem(LS.lastVerCheck, String(Date.now()));

const UPDATE_API_BASE = "https://api.dengteng.xyz";
export async function checkVersion(): Promise<VersionCheck> {
  const res = await fetch(`${UPDATE_API_BASE}/api/public/version?project=${encodeURIComponent(PROJECT_ID)}`, {
    method: "GET", headers: { "Content-Type": "application/json" },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data.retryAfterSeconds);
  const v = data as VersionInfo;
  return { ...v, current: APP_VERSION, hasUpdate: cmpVer(v.latestVersion, APP_VERSION) > 0, forced: cmpVer(APP_VERSION, v.minVersion) < 0 };
}
