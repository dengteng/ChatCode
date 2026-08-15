// 前端统一事件模型 —— 有意对齐 ACP 的概念,以后接 Codex/Gemini 时在 sidecar 层加适配器即可
export type ContentBlock =
  | { type: "text"; text: string }
  // cc_blob: 历史日志里的图片只存引用(数据在 sidecar 的 blobs/),要看时按 key 现取 —— 见 fetchBlob
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "cc_blob"; media_type: string; key: string; bytes?: number } }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: any; is_error?: boolean };

// 时间线上的一条渲染项(i: 区分谁说的、发生了什么)
export type TimelineItem =
  | { kind: "user"; blocks: ContentBlock[]; ts: number; tokensIn?: number; tokensInUncached?: number; composerHtml?: string; composerImgs?: Record<string, { media_type: string; data: string }> }
  | { kind: "agent_text"; text: string; ts: number; streaming?: boolean; tokensOut?: number; phase?: "progress" | "final"; model?: string }
  | { kind: "tool"; id: string; name: string; input: any; result?: any; isError?: boolean; ts: number; model?: string }
  | { kind: "permission"; requestId: string; toolName: string; input: any; suggestions?: PermissionSuggestion[]; blockedPath?: string; decision?: "allow" | "deny"; answer?: string; remembered?: string; ts: number; decidedTs?: number }
  | { kind: "system"; text: string; ts: number }
  | { kind: "terminal"; command: string; cwd: string; cwdChanged?: boolean; output: string; exitCode: number; pending?: boolean; ts: number } // ! 前缀的 shell 命令
  // /compact 压缩上下文。SDK 只给开始(system/status)与结束(system/compact_boundary),没有百分比,
  // 所以运行中是不定态动画;结束后用 pre/post token 数说明压掉了多少。
  | { kind: "compact"; running: boolean; auto?: boolean; preTokens?: number; postTokens?: number; durationMs?: number; error?: string; ts: number }
  | { kind: "result"; costUsd: number; durationMs: number; usage: any; isError: boolean; aborted?: boolean; ts: number };

// 权限建议:SDK 在 canUseTool 里给出,点"允许并记住"时原样回填到 PermissionResult.updatedPermissions。
// destination 由 SDK 决定(addRules 建议 localSettings,其余建议 session),不需要我们选。
export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
export interface PermissionRule { toolName: string; ruleContent?: string }
export type PermissionSuggestion =
  | { type: "addRules"; rules: PermissionRule[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "setMode"; mode: string; destination: PermissionDestination };

export interface Todo { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }

export interface SessionInfo {
  model?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  slash_commands?: string[];
  skills?: string[];
}

// resolvedModel = value 背后真正的模型 id。判断上下文窗口只能看它:
// "default" 解析成 claude-opus-4-8[1m](1M),而 "claude-fable-5[1m]" 反过来解析成不带 [1m] 的 claude-fable-5。
// provider/model:非 Claude provider(DeepSeek 等)的模型才带,value 形如 "deepseek/deepseek-chat"。
// vision: 该模型收不收图片。不写则按 provider 的声明来(见 canSendImage);设置里的模型表可手填覆盖。
export interface ModelInfo { value: string; resolvedModel?: string; displayName: string; description?: string; provider?: string; model?: string; contextWindow?: number; vision?: boolean }

// 会话当前选中的那条模型信息(models 列表还没到时可能查不到)
export function sessionModel(session: Session): ModelInfo | undefined {
  const m = session.info.model;
  return session.models.find((x) => x.value === m || x.resolvedModel === m || x.model === m)
    ?? (m ? undefined : session.models.find((x) => x.value === "default"));
}

// 能不能往这个会话发图片。模型表里显式写了就听它的,否则看 provider 声明;都没有一律放行 ——
// 拦错了比漏拦更糟(用户会以为 ChatCode 坏了),所以只拦明确声明不支持的那几家。
export function canSendImage(session: Session, providers?: Record<string, ProviderState>): boolean {
  const mi = sessionModel(session);
  if (typeof mi?.vision === "boolean") return mi.vision;
  return providers?.[sessionProvider(session)]?.vision !== false;
}

// 会话当前走哪个 provider(默认 claude)。用量条等按它区分:claude/kimi 有订阅额度,其余按量计费没有。
export function sessionProvider(session: Session): string {
  const m = session.info.model;
  const hit = sessionModel(session);
  if (hit?.provider) return hit.provider;
  // Fallback: parse prefix from model value ("deepseek/deepseek-v4-flash" -> "deepseek").
  // Needed when models list hasn't arrived yet but model is already known from stored index.
  // 只有带斜杠的 "provider/model" 才算第三方;claude 原生 id 无斜杠(claude-opus-4-8/haiku…)一律算 claude,
  // 否则会把 "claude-opus-4-8" 整串当 provider,isClaude 判否,5h/周用量条消失。
  if (m && m !== "default" && String(m).includes("/")) {
    const pre = String(m).split("/")[0];
    if (pre !== "claude") return pre;
  }
  // 兜底再收一道:models 列表没到、id 又是裸的(SDK init 只回裸 id)时,上面查不到就一路默认成 claude,
  // DeepSeek 会话会因此显示出根本不存在的 5h/周订阅用量条。Claude 的模型 id 一律 claude- 开头,
  // 不是这个前缀就肯定不是 Claude —— 判成 other 只会少显示订阅条,不会误显示。
  if (m && m !== "default" && !String(m).startsWith("claude")) return "other";
  return "claude";
}

// 会话累计花费(按量计费的 provider 用;sidecar 的 spend.mjs 逐轮累加并落盘)。
// unpriced = 有些 token 在模型表里查不到单价,cost 只是已计价的那部分。
export interface Spend { in: number; out: number; cacheRead: number; cacheWrite: number; cost: number; currency: string; unpriced: boolean }
export const spendTokens = (s: Spend) => s.in + s.out + s.cacheRead + s.cacheWrite;

// 按量计费 provider 的钱包(sidecar 广播):
//   balance   —— provider 自家余额接口(目前只有 DeepSeek 有);拉不到时 error 有值,余额显示上一份并变灰
//   today/month —— 本地账本累计(各家都没有消费查询 API),只含 ChatCode 里发生的花费
export interface Wallet {
  today: number; month: number; currency: string;
  balance?: number; balanceCurrency?: string; fetchedAt?: number; error?: string;
}

// c: 订阅限额(session 5h / weekly)—— SDK 消息流不含,需 sidecar 另接 OAuth usage 端点
export interface LimitUsage { usedPct: number | null; resetAt: number | null; unavailableReason?: string } // null = 暂无数据
// 账号级订阅限额。fetchedAt = 这份数字是什么时候从服务端拿到的;stale = 最近一次刷新失败,现在显示的是旧值。
// 两者都要暴露给界面:限额是"账户级"的,别的客户端(claude.ai / 另一个 CLI)烧掉的额度我们只能靠刷新才看得到,
// 数字天然滞后 —— 至少得让人知道滞后了多久。
export interface AccountUsage { session: LimitUsage; weekly: LimitUsage; fetchedAt: number | null; stale: boolean }

// 重开大会话前的二次确认(对齐 CLI 的 --resume 提示)
export interface ResumePrompt { tokens: number; ageMs: number }
// fresh = 不接历史、不压缩,在该项目下直接开一段全新对话(等于放弃这次恢复)
export type ResumeChoice = "summary" | "full" | "fresh";

// 待发消息:agent 工作时继续发的消息进队列,完成后自动依次发出。html/imgs 供发出后"编辑"完整还原
export interface PendingMsg { pid: string; blocks: ContentBlock[]; text: string; html?: string; imgs?: Record<string, { media_type: string; data: string }> }

export interface Session {
  id: string;
  title: string;
  cwd: string;
  termCwd?: string;          // 终端当前目录(随 !cd 变),显示在目录栏
  ssh?: { host: string; status: string; port?: string; keyPath?: string } | null;
  resumePrompt?: ResumePrompt | null; // 非空 = 等用户选"摘要/完整恢复",此时 agent 还没起
  status: "idle" | "running" | "waiting" | "closed"; // waiting = 等你确认权限
  freshDone?: boolean; // 本次启动后真正完成过一轮(驱动列表绿色✅),历史 reopen 不点亮
  timeline: TimelineItem[];
  todos: Todo[];
  info: SessionInfo;
  models: ModelInfo[];       // /model 选择器,sidecar 单独上报(独立于 info,避免 init 覆盖)
  costUsd: number;
  inputTokens: number;       // 含缓存:新读 + 缓存写入 + 缓存命中
  outputTokens: number;      // 含思考(thinking 计在 output,SDK 不单列推理 token)
  cacheWriteTokens: number;  // 其中写进缓存的部分
  cacheReadTokens: number;   // 其中命中缓存的部分
  contextTokens: number;   // 当前上下文占用(最近一轮送进模型的总 token)
  contextWindow: number;   // 模型上下文窗口(来自 modelUsage)
  sessionLimit: LimitUsage;  // 5h 限额
  weeklyLimit: LimitUsage;   // 周限额
  inheritFrom?: string | null;
  casual?: boolean;          // 闲聊会话:无工作目录/git,隐藏目录栏与项目详情
  loadingHistory?: boolean;  // 重开会话:等 sidecar 回放历史期间为 true,timeline 空时显示"加载中"而非白屏
  pending?: PendingMsg[];    // 待发队列:agent 忙时排队,完成后自动发下一条(最多 3 条)
  bgTasks?: string[];        // SDK background_tasks_changed 电平(REPLACE):当前在跑的后台任务 id 集,空=无
  bgWait?: boolean;          // 上一轮有后台任务,轮次还没完全了结(还在等后台任务及它的续跑)→ 禁止待发队列出队
}

// 1M 上下文的模型,其 resolvedModel 带 [1m] 后缀。modelUsage 报的 contextWindow 有时仍是 200k,
// 且按模型名分桶(子 agent 的 haiku 也占一桶),所以这里以模型 id 为准兜底。
// info.model 只在 SDK init(首条消息后才发)才有值。空窗期回退到 models 列表的默认行,
// 而不是干等显示"连接中"。有值时优先用列表里的 displayName,退回原始 id。
function modelInList(models: ModelInfo[], modelValue: string): ModelInfo | undefined {
  return models.find((m) => m.value === modelValue || m.resolvedModel === modelValue || m.model === modelValue);
}

export function modelLabel(session: Session): string {
  const byId = session.info.model ? modelInList(session.models, session.info.model) : undefined;
  if (session.info.model) return byId?.displayName ?? session.info.model;
  const def = session.models.find((m) => m.value === "default") ?? session.models[0];
  return def?.displayName ?? "";
}

// 某个具体模型 id → 展示名(如 "claude-opus-4-8" → "Opus 4.8"、"deepseek-v4-pro" → "DeepSeek V4 Pro")。
// 用于聊天气泡里"某条回复是哪个模型产生的"—— 会话中途可能切模型,故按消息自带的 model 逐条解析。
// 列表里查不到(如子 agent 的 haiku 未在 /model 菜单)时返回 undefined,调用方回退到 brandName。
export function modelDisplayName(session: Session, modelId?: string): string | undefined {
  if (!modelId) return undefined;
  return modelInList(session.models, modelId)?.displayName;
}

// 每个模型见过的最大上下文窗口,落 localStorage。
// 起因:同一个模型上报的窗口并不稳定 —— supportedModels 不带窗口,modelUsage 有时报 1M、
// 有时报默认 200k(还会被子 agent 的 haiku 桶带偏),于是"确认过 1M"的模型过一会儿又掉回 200k。
// 认过的最大值就钉住:窗口只会随模型升级变大,不会缩水。
const MODEL_WIN_KEY = "cc-model-window";
let winCache: Record<string, number> | null = null;
function stickyWindow(model: string, w: number): number {
  if (!model || !w) return w;
  if (!winCache) { try { winCache = JSON.parse(localStorage.getItem(MODEL_WIN_KEY) || "{}"); } catch { winCache = {}; } }
  const cache = winCache ?? (winCache = {});
  const key = model.replace(/\[1m\]$/i, ""); // 1M 变体和裸 id 算同一个模型
  const best = Math.max(cache[key] || 0, w);
  if (best !== cache[key]) { cache[key] = best; try { localStorage.setItem(MODEL_WIN_KEY, JSON.stringify(cache)); } catch { /* 隐私模式写不了,忽略 */ } }
  return best;
}

export function contextWindowOf(session: Session): number {
  // 和 modelLabel 一样:info.model 要等 SDK init(首条消息后)才有值,空窗期按 models 列表里的
  // 默认行算,否则新开会话的 default(1M)会先显示成 200k,聊一句才跳成 1M。
  // sdk_init 带的 model 不带 provider 前缀(如 "deepseek-v4-pro"),
  // 而列表里的 value 带前缀("deepseek/deepseek-v4-pro")——加 m.model 匹配兜底。
  const cur = session.info.model
    ? modelInList(session.models, session.info.model)
    : (session.models.find((m) => m.value === "default") ?? session.models[0]);
  const id = cur?.resolvedModel ?? session.info.model ?? ""; // 列表还没到时退回 info.model
  // 列表里有窗口(我们自己维护的表,含 sidecar 给 SDK 模型补的)就以它为准;没有的才退回
  // 会话实时上报的 modelUsage。不取两者最大值 —— session.contextWindow 未拿到实时值前是 200k
  // 占位,取最大会把 GLM Air 这类 128k 的模型错显成 200k,还会被 stickyWindow 钉死。
  const listed = cur?.contextWindow ?? (/\[1m\]/i.test(id) ? 1_000_000 : 0);
  const w = listed || session.contextWindow;
  return stickyWindow(session.info.model || cur?.model || cur?.value || "", w);
}

export interface IndexEntry {
  id: string; title: string; cwd: string; sdkSessionId: string | null;
  createdAt: number; inheritFrom?: string | null; model?: string;
  groupId?: string | null; // 所属分组(仅顶级会话携带;子会话跟随母会话)
  casual?: boolean;
  lastUser?: string;        // 最新一条用户消息文本(列表副标题;重启后内存无 timeline 时用它)
}

// 会话分组(左侧列表的文件夹)。顺序 = 数组顺序,持久化在 sidecar 的 groups.json
export interface SessionGroup { id: string; name: string }

// ts:消息落盘时间的 ISO 字符串。老日志里 assistant 消息没有,sidecar 会退回同轮最近一条(见 findMessages)
export interface SearchResult {
  sessionId: string; title: string; kind: "user" | "agent" | "tool"; text: string; ts?: string;
}

// 设置:某个第三方 LLM provider 的状态 + 可编辑配置(baseUrl / 模型表随版本漂移,用户可覆盖)
export interface ProviderState {
  label: string;
  configured: boolean;            // 是否配了 API key
  transport?: "anthropic" | "openai" | null; // openai = 走本地转译代理
  baseUrl?: string;               // 当前生效(默认或用户覆盖)
  defaultBaseUrl?: string;        // 出厂默认(占位/重置用)
  models?: ModelInfo[];           // 当前生效模型表
  defaultModels?: ModelInfo[];
  smallFast?: string;
  vision?: boolean;               // 端点收不收图片(false 才拦,不写 = 放行)
  baseUrlCN?: string;             // 有国内节点可切(勾了「使用国内节点」时生效)
  cnAvailable?: boolean;          // 候选里有国内端点(Kimi 这种把国内域名写在 variants 里的也算)
  subscriptionUsage?: boolean;    // 订阅制(用量条显示 5h/周)还是按量计费(显示余额 + 本会话花费)。
                                  // 随探测结果变:同一家换把 key 可能从订阅翻成按量
}
// 设置:账号登录状态(Claude + GitHub + 其他 LLM provider)
export interface AuthStatus {
  claude: { installed: boolean; loggedIn: boolean; method: string };
  github: { installed: boolean; loggedIn: boolean; account?: string; detail?: string };
  providers?: Record<string, ProviderState>;
  cnEndpoint?: boolean;           // 国内节点总开关
}
// 设置:全局 SSH 主机预设(独立于会话,可复用)
export interface SshHost { id?: string; label?: string; host: string; username?: string; port?: string; keyPath?: string }

// upstreamAuthor:上游远程分支最新提交的作者名(远程那头"谁最后动的")
// gone:配了上游但远程分支已被删(git 的 [gone]),此时 ahead/behind 都是 0,不单独标会伪装成"已同步"
export interface GitBranch { name: string; upstream?: string; ahead?: number; behind?: number; sha?: string; upstreamSha?: string; upstreamAuthor?: string; gone?: boolean }
// 分支 Tab:提交拓扑图数据(git_log)与两 ref 对比(git_diff)
export interface GitCommit { hash: string; parents: string[]; author: string; date: string; subject: string }
export interface GitLogData { commits: GitCommit[]; heads: { name: string; sha: string; remote: boolean }[] }
export interface GitDiffFile { file: string; add: number | null; del: number | null } // null = 二进制
export interface GitDiffData { from: string; to: string; ahead: number; behind: number; files: GitDiffFile[]; error?: string }
export interface GitInfo {
  cwd: string; isRepo: boolean; root?: string; current?: string; status?: string;
  local: GitBranch[]; remote: string[]; remotes: string[]; remoteUrl?: string;
  // task 有值 = agent 起的后台任务(SDK 报的),没有真 pid,停止走 stopTask 而非 kill_pid
  runtime?: { processes: { pid: string; name: string; elapsed: string; task?: string }[]; ports: { process: string; port: string }[] };
  github?: { installed: boolean; loggedIn: boolean; account?: string; detail?: string };
}

// cmd 前缀命令。
// - /model /clear:前端拦截(SDK 控制方法)。
// - /help /cost /export:纯前端命令 —— CLI 有,但 SDK init 不上报、当 prompt 发会被模型当字面文本处理,故在客户端实现(见 Composer runLocalCommand)。
// - 其余:作为 prompt 发给 CLI 本地处理(均在 init 上报的 slash_commands 里)。
export const BUILTIN_COMMANDS = [
  { cmd: "/model", desc: "切换模型" },
  { cmd: "/clear", desc: "清空上下文,开始新会话" },
  { cmd: "/compact", desc: "压缩上下文,保留摘要" },
  { cmd: "/context", desc: "查看当前上下文占用" },
  { cmd: "/cost", desc: "查看本会话花费与 token" },
  { cmd: "/usage", desc: "查看用量、限额与花费" },
  { cmd: "/export", desc: "导出本会话对话到剪贴板" },
  { cmd: "/init", desc: "为项目生成 CLAUDE.md" },
  { cmd: "/review", desc: "审查 GitHub PR" },
  { cmd: "/security-review", desc: "对当前改动做安全审查" },
  { cmd: "/recap", desc: "生成一句话会话回顾" },
  { cmd: "/insights", desc: "生成会话分析报告" },
  { cmd: "/goal", desc: "设定目标,达成前持续工作" },
  { cmd: "/help", desc: "列出所有命令与快捷键" },
];

// 主题配色方案。base = 明暗基座(管原生标题栏 + 浅色附属样式),用户主要在浅色下换配色(侧栏底色 + 主色调)。
// swatch = [侧栏底色, 主色] —— 设置面板里画预览小色块用。CSS 见 styles.css 的 [data-palette=*] 块。
export type ThemeId = "dark" | "light" | "sand" | "lavender" | "forest" | "custom";
// 自定义背景图的叠加模式:dark=深色蒙版 light=浅色蒙版 none=原图直出(元素改用不透明底与背景隔离)
// 自定义主题:上传时对图做的 64px 分析结果。lum=平均亮度,lumL/lumR=左/右三分之一局部亮度(0..1),
// complexity=边缘复杂度(0..1,越花越高),accent=色相直方图主色。App 据此定壳(明暗)与各表面透明度。
export interface CustomArt { accent?: string; lum: number; lumL: number; lumR: number; complexity: number }
export const THEMES: { id: ThemeId; label: string; base: "dark" | "light"; swatch: [string, string] }[] = [
  { id: "dark", label: "暗色", base: "dark", swatch: ["#0a1120", "#3b82f6"] },
  { id: "light", label: "浅色 · 经典蓝", base: "light", swatch: ["#e9edf4", "#2563eb"] },
  { id: "sand", label: "暖砂 · 赤陶", base: "light", swatch: ["#efe4d0", "#8f4419"] },
  { id: "lavender", label: "薰衣草 · 紫", base: "light", swatch: ["#e6def2", "#5730bd"] },
  { id: "forest", label: "森林 · 深绿", base: "light", swatch: ["#123d2b", "#15803d"] },
  // custom:base=dark(深表面在任意背景图上都稳),背景图/毛玻璃由 App 另存 localStorage。swatch 仅占位。
  { id: "custom", label: "自定义 · 背景图", base: "dark", swatch: ["#33405c", "#6aa5ff"] },
];
