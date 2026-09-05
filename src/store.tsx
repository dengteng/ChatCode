import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { AccountUsage, AuthStatus, ClosedEntry, GitCommitDetail, GitDiffData, GitInfo, GitLogData, IndexEntry, LimitUsage, ModelInfo, PermissionSuggestion, ResumeChoice, SearchResult, Session, SessionGroup, SessionInfo, Spend, SshHost, TimelineItem, Wallet } from "./types";
import { sessionProvider, modelName } from "./types";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { toast, dismissToast } from "./components/Toast";
import i18n, { getLang } from "./i18n";
import { PERMISSION_PRESETS, type PermissionMode } from "./permissions";
import { COMMIT_HOLD_MS } from "./lib/gitcmd";
import { pickAutoModel } from "./lib/automodel";

// 把顶级会话 sessionId 移动到 groupId(null=移出分组),插到 beforeId 之前(null=该组末尾)。
// 前端乐观更新与后端持久化用同一套语义,保证拖拽后立即到位、广播回来不跳动。
function applyMove(index: IndexEntry[], sessionId: string, groupId: string | null, beforeId: string | null): IndexEntry[] {
  const arr = index.slice();
  const i = arr.findIndex((e) => e.id === sessionId);
  if (i < 0) return index;
  const entry = { ...arr[i], groupId: groupId ?? null };
  arr.splice(i, 1);
  const isRoot = (e: IndexEntry) => !e.inheritFrom || !arr.some((p) => p.id === e.inheritFrom);
  let j = beforeId ? arr.findIndex((e) => e.id === beforeId) : -1;
  if (j < 0) { // 落到该组末尾:找同组最后一个顶级条目,插其后;没有就压到数组尾
    let last = -1;
    for (let k = 0; k < arr.length; k++) if ((arr[k].groupId ?? null) === (groupId ?? null) && isRoot(arr[k])) last = k;
    j = last < 0 ? arr.length : last + 1;
  }
  arr.splice(j, 0, entry);
  return arr;
}

// 跑完要给 toast 的 git 写操作。只认真正改仓库状态的这几个 —— status/log/diff 之类读命令不吵人。
// commit 排在最前:顶栏的提交命令是 `git add -A && git commit -m '…'`,message 里带 "git push" 字样时优先按提交算。
const GIT_OPS: [RegExp, string][] = [
  [/\bgit\s+commit\b/, "提交"],
  [/\bgit\s+push\b/, "推送"],
  [/\bgit\s+pull\b/, "拉取"],
  [/\bgit\s+merge\b/, "合并"],
  [/\bgit\s+rebase\b/, "变基"],
];
const gitOpLabel = (cmd: string) => GIT_OPS.find(([re]) => re.test(cmd))?.[1];

// 点“允许并记住”时带回来的全部规则建议；同一次授权只会恢复 agent 一次。
export interface RememberChoice { updates: PermissionSuggestion[]; label: string }

// 开发时 sidecar 由 npm run dev 起在 8975;打包后由 Rust 起在 8976。
// 端口分开,装好的 app 和正在跑的 tauri dev 才能并存,不会 EADDRINUSE。
export const SIDECAR_PORT = import.meta.env.DEV ? 8975 : 8976;
const WS_DOWN = "ws-down"; // 断连常驻 toast 的 key,重连时按它收掉

// ws 握手令牌:Rust 每次启动随机生成,只经 tauri command 发给自家 webview —— 浏览器网页调不到 IPC,
// 也就连不上这个固定的 loopback 端口(WebSocket 不受同源策略约束,不校验等于本机任意网页可执行命令)。
// 只取一次,重连复用。拿不到(开发时浏览器直连 / 老 sidecar)就空串,不带 token —— sidecar 侧同样不校验。
const sidecarToken = invoke<string>("sidecar_token").catch(() => "");

// ---------- state ----------
interface State {
  connected: boolean;
  index: IndexEntry[];
  groups: SessionGroup[];
  closed: ClosedEntry[]; // 已关闭会话(首页「最近历史」),sidecar 随 index 一起下发
  sessions: Record<string, Session>;
  activeId: string | null;
  usage: AccountUsage; // 账号级订阅限额(所有会话共享)
  usageKimi: AccountUsage; // Kimi 编程订阅限额(5h/周,独立接口)
  search: SearchResult[];
  git: Record<string, GitInfo>;
  gitLog: Record<string, GitLogData>;   // 分支 Tab:提交拓扑图数据(按会话)
  gitDiff: Record<string, GitDiffData>; // 分支 Tab:最近一次两 ref 对比结果(按会话)
  gitCommitDetail: Record<string, GitCommitDetail>; // 拓扑图点开的那个提交的详情(按会话)
  gitFileDiff: Record<string, { from: string; to: string; file: string; patch: string; clipped?: boolean; error?: string }>; // 对比视图点开的单文件 patch(clipped=文件太大,只给了改动附近的上下文)
  auth: AuthStatus | null;                          // 设置:账号登录状态
  sshHosts: SshHost[];                              // 设置:全局 SSH 主机预设
  sshTests: Record<string, { ok: boolean; detail: string }>; // 预设连通性测试结果(按 host id)
  autoAllow: Record<string, boolean>; // 会话级"自动同意":授权请求自动放行(仅本次运行,不落盘)
  permMode: Record<string, PermissionMode>; // 会话级 SDK 权限模式;与 autoAllow 合起来推导出「权限档位」
  spend: Record<string, Spend>;             // 会话累计花费(按量计费的 provider 用量条显示它)
  wallet: Record<string, Wallet>;           // 按 provider:账户余额 + 今日/本月消费(按量计费的用量条显示它)
  justCreatedId: string | null; // 刚从首页新建的会话 id:侧栏该项播一次入场动效,其余项/首屏不播
  homeModels: ModelInfo[]; // 首页模型切换器的可选列表(无会话,走缓存的 Claude 列表 + 已配置 provider)
  homeModel: string;       // 首页选中的模型:新建会话即以此启动(持久化在 localStorage)
}
// 待发队列上限。再多屏上就排成一列看不清自己排了啥,而且排得越久越可能已经不是当时想问的了。
export const PENDING_MAX = 3;
const HOME_MODELS_ID = "__home__"; // 首页 get_models 的哨兵 sessionId
const HOME_MODEL_KEY = "cc-home-model";
const emptyUsage: AccountUsage = { session: { usedPct: null, resetAt: null }, weekly: { usedPct: null, resetAt: null }, fetchedAt: null, stale: false };
const initial: State = {
  connected: false, index: [], groups: [], closed: [], sessions: {}, activeId: null,
  usage: emptyUsage, usageKimi: emptyUsage,
  search: [], git: {}, gitLog: {}, gitDiff: {}, gitCommitDetail: {}, gitFileDiff: {},
  auth: null, sshHosts: [], sshTests: {}, autoAllow: {}, permMode: {}, spend: {}, wallet: {}, justCreatedId: null,
  homeModels: [], homeModel: (() => { try { return localStorage.getItem(HOME_MODEL_KEY) || "default"; } catch { return "default"; } })(),
};

type Action =
  | { type: "connected"; v: boolean }
  | { type: "index"; index: IndexEntry[]; groups?: SessionGroup[]; closed?: ClosedEntry[] }
  | { type: "groups"; groups: SessionGroup[] }
  | { type: "move_session"; sessionId: string; groupId: string | null; beforeId: string | null }
  | { type: "open"; session: Session }
  | { type: "activate"; id: string }
  | { type: "go_home" }
  | { type: "mark_created"; id: string | null } // 标记/清除刚新建会话(驱动侧栏入场动效)
  | { type: "patch"; id: string; patch: Partial<Session> }
  | { type: "revive"; id: string }   // 断连的会话重新起来了(只解除 closed,不碰运行中的状态)
  | { type: "sdk_init"; id: string; info: SessionInfo; keepModel: boolean } // 回放历史 init 时保留已选模型(旧 init 记的是当时的模型)
  | { type: "append"; id: string; item: TimelineItem }
  | { type: "tool_result"; id: string; toolUseId: string; result: any; isError?: boolean }
  | { type: "decide_permission"; id: string; requestId: string; decision: "allow" | "deny"; answer?: string; remembered?: string }
  | { type: "add_usage"; id: string; costUsd: number; inputTokens: number; outputTokens: number; cacheWrite: number; cacheRead: number }
  | { type: "stream_start"; id: string }               // 开一个流式 agent_text
  | { type: "stream_delta"; id: string; text: string } // 增量追加
  | { type: "stream_stop"; id: string }                // 结束流式
  | { type: "agent_text_dedup"; id: string; text: string; model?: string } // 实时补显 assistant 文本,与刚流式过的去重(本地命令输出无流式);顺带给流式那条回填 model
  | { type: "set_context"; id: string; contextTokens?: number; contextWindow?: number; fromModel?: string; allowShrink?: boolean } // 两者都可省,省的那个保持原值;fromModel = 本次 message_start 的模型,与主模型不符时丢弃;allowShrink = 允许下降(仅压缩用,主流单调递增)
  | { type: "attach_tokens"; id: string; tokensIn: number; tokensInUncached: number; tokensOut: number }
  | { type: "set_usage"; usage: AccountUsage | null; kimiUsage?: AccountUsage | null }
  | { type: "search_results"; results: SearchResult[] }
  | { type: "auth_status"; status: AuthStatus }
  | { type: "ssh_hosts"; hosts: SshHost[] }
  | { type: "ssh_test"; id: string; ok: boolean; detail: string }
  | { type: "set_auto_allow"; id: string; on: boolean }
  | { type: "set_perm_mode"; id: string; mode: PermissionMode }
  | { type: "set_spend"; id: string; spend: Spend }
  | { type: "set_wallet"; wallet: Record<string, Wallet> }
  | { type: "git_info"; id: string; info: GitInfo }
  | { type: "git_log"; id: string; data: GitLogData }
  | { type: "git_diff"; id: string; data: GitDiffData }
  | { type: "git_commit_detail"; id: string; data: GitCommitDetail }
  | { type: "git_file_diff"; id: string; data: { from: string; to: string; file: string; patch: string; clipped?: boolean; error?: string } }
  | { type: "rename"; id: string; title: string }
  | { type: "clear_timeline"; id: string }             // /clear:清空可见对话
  | { type: "terminal_start"; id: string; command: string; cwd: string } // ! 命令乐观回显
  | { type: "terminal_chunk"; id: string; command: string; text: string } // 跑着时的增量输出
  | { type: "resolve_terminal"; id: string; command: string; cwd: string; cwdChanged: boolean; output: string; exitCode: number } // 结果回填
  | { type: "compact_start"; id: string; auto?: boolean }  // 开始压缩上下文
  | { type: "compact_finish"; id: string; patch: Partial<Extract<TimelineItem, { kind: "compact" }>> } // 收尾并回填 token 数
  | { type: "compact_settle"; id: string }                 // 兜底:没等到结束信号就把进度条停下
  | { type: "enqueue_pending"; id: string; item: import("./types").PendingMsg } // 待发入队
  | { type: "remove_pending"; id: string; pid: string }    // 移除某条待发(取消 / 已发出)
  | { type: "set_peer_queue"; id: string; items: { pid: string; text: string }[] } // 别端排在该会话的待发(只读镜像)
  | { type: "remove_session"; id: string }
  | { type: "home_models"; models: ModelInfo[] } // 首页模型列表到货
  | { type: "set_home_model"; model: string };    // 首页选中模型

function reducer(s: State, a: Action): State {
  const upd = (id: string, f: (sess: Session) => Session) =>
    s.sessions[id] ? { ...s, sessions: { ...s.sessions, [id]: f(s.sessions[id]) } } : s;
  switch (a.type) {
    case "connected": return { ...s, connected: a.v };
    case "index": return { ...s, index: a.index, ...(a.groups ? { groups: a.groups } : {}), ...(a.closed ? { closed: a.closed } : {}) };
    case "groups": return { ...s, groups: a.groups };
    case "move_session": return { ...s, index: applyMove(s.index, a.sessionId, a.groupId, a.beforeId) };
    case "rename": {
      const index = s.index.map((e) => (e.id === a.id ? { ...e, title: a.title } : e));
      const sessions = s.sessions[a.id] ? { ...s.sessions, [a.id]: { ...s.sessions[a.id], title: a.title } } : s.sessions;
      return { ...s, index, sessions };
    }
    case "set_usage": {
      // 广播偶尔拿不到额度(usedPct=null)时,保留上一次的有效值,别让用量条突然空掉。
      // 但 fetchedAt/stale 一定要用新的 —— 界面靠它告诉用户"这个数字是几分钟前的了"。
      const keep = (prev: LimitUsage, next: LimitUsage) => next.usedPct === null && prev.usedPct !== null ? prev : next;
      // undefined = 这条消息没带这个 provider(不动);null = 后端明确清掉(如 key 已删)
      const mergeU = (prev: AccountUsage, next: AccountUsage | null | undefined) =>
        next === undefined ? prev : next === null ? emptyUsage : {
          session: keep(prev.session, next.session), weekly: keep(prev.weekly, next.weekly),
          fetchedAt: next.fetchedAt ?? prev.fetchedAt, stale: next.stale ?? false,
        };
      return { ...s, usage: mergeU(s.usage, a.usage), usageKimi: mergeU(s.usageKimi, a.kimiUsage) };
    }
    case "search_results": return { ...s, search: a.results };
    case "auth_status": return { ...s, auth: a.status };
    case "home_models": return { ...s, homeModels: a.models };
    case "set_home_model": { try { localStorage.setItem(HOME_MODEL_KEY, a.model); } catch { /* 隐私模式 */ } return { ...s, homeModel: a.model }; }
    case "ssh_hosts": return { ...s, sshHosts: a.hosts };
    case "ssh_test": return { ...s, sshTests: { ...s.sshTests, [a.id]: { ok: a.ok, detail: a.detail } } };
    case "set_auto_allow": return { ...s, autoAllow: { ...s.autoAllow, [a.id]: a.on } };
    case "set_perm_mode": return { ...s, permMode: { ...s.permMode, [a.id]: a.mode } };
    case "set_spend": return { ...s, spend: { ...s.spend, [a.id]: a.spend } };
    case "set_wallet": return { ...s, wallet: a.wallet };
    case "git_info": return { ...s, git: { ...s.git, [a.id]: a.info } };
    case "git_log": return { ...s, gitLog: { ...s.gitLog, [a.id]: a.data } };
    case "git_diff": return { ...s, gitDiff: { ...s.gitDiff, [a.id]: a.data } };
    case "git_commit_detail": return { ...s, gitCommitDetail: { ...s.gitCommitDetail, [a.id]: a.data } };
    case "git_file_diff": return { ...s, gitFileDiff: { ...s.gitFileDiff, [a.id]: a.data } };
    // /clear:清空可见对话,index 里落盘的 lastUser 一并抹掉 —— 否则列表副标题还挂着清空前的最近消息
    case "clear_timeline": {
      const next = upd(a.id, (x) => ({ ...x, timeline: [], todos: [], contextTokens: 0 }));
      return { ...next, index: next.index.map((e) => (e.id === a.id ? { ...e, lastUser: undefined } : e)) };
    }
    case "set_peer_queue": return upd(a.id, (x) => ({ ...x, peerQueue: a.items }));
    case "enqueue_pending": return upd(a.id, (x) => ((x.pending?.length ?? 0) >= PENDING_MAX ? x : { ...x, pending: [...(x.pending ?? []), a.item] }));
    case "remove_pending": return upd(a.id, (x) => ({ ...x, pending: (x.pending ?? []).filter((p) => p.pid !== a.pid) }));
    case "terminal_start":
      return upd(a.id, (x) => ({
        ...x,
        timeline: [...x.timeline, { kind: "terminal", command: a.command, cwd: a.cwd, output: "", exitCode: 0, pending: true, ts: Date.now() }],
      }));
    // 命令跑着时往待回填那条上追加输出。命令结束后 resolve_terminal 会用完整输出整条覆盖,
    // 所以这里丢包/截断都不会留下痕迹。
    case "terminal_chunk":
      return upd(a.id, (x) => {
        const tl = [...x.timeline];
        for (let i = tl.length - 1; i >= 0; i--) {
          const t = tl[i];
          if (t.kind === "terminal" && t.pending && t.command === a.command) {
            tl[i] = { ...t, output: t.output + a.text };
            return { ...x, timeline: tl };
          }
        }
        return x;
      });
    case "resolve_terminal":
      return upd(a.id, (x) => {
        const tl = [...x.timeline];
        for (let i = tl.length - 1; i >= 0; i--) {
          const t = tl[i];
          if (t.kind === "terminal" && t.pending && t.command === a.command) {
            tl[i] = { ...t, cwd: a.cwd, cwdChanged: a.cwdChanged, output: a.output, exitCode: a.exitCode, pending: false };
            return { ...x, timeline: tl };
          }
        }
        // 没找到待回填项(异常):直接追加
        return { ...x, timeline: [...tl, { kind: "terminal", command: a.command, cwd: a.cwd, cwdChanged: a.cwdChanged, output: a.output, exitCode: a.exitCode, ts: Date.now() }] };
      });
    case "compact_start":
      return upd(a.id, (x) => {
        if (runningCompactAt(x.timeline) >= 0) return x; // 已在压缩中(乐观回显与 SDK status 各来一次)
        return { ...x, timeline: [...x.timeline, { kind: "compact", running: true, auto: a.auto, ts: Date.now() }] };
      });
    // 收尾:压缩中的那条就地回填;若没有(比如自动压缩没经过 status),补一条已完成的
    case "compact_finish":
      return upd(a.id, (x) => {
        const i = runningCompactAt(x.timeline);
        if (i < 0) return { ...x, timeline: [...x.timeline, { kind: "compact", running: false, ts: Date.now(), ...a.patch }] };
        const tl = [...x.timeline];
        tl[i] = { ...tl[i], running: false, ...a.patch } as TimelineItem;
        // 真压成了(有 preTokens)→ 解除重发闩锁,下次再被并轮还能重发一次
        return { ...x, timeline: tl, ...(a.patch.preTokens != null ? { compactRetried: false } : {}) };
      });
    case "compact_settle":
      return upd(a.id, (x) => {
        const i = runningCompactAt(x.timeline);
        if (i < 0) return x;
        const tl = [...x.timeline];
        const t = tl[i] as Extract<TimelineItem, { kind: "compact" }>;
        // 一轮跑完了、压缩却没收到 compact_boundary(没有 preTokens)→ 它压根没执行。
        // 之前这里一律收成"上下文已压缩",配上乐观显示的进度条,等于凭空编了一次成功的压缩:
        // 用户以为压完了,上下文条却纹丝不动。宁可说没做,别谎报。
        const missed = t.preTokens == null;
        // CLI 是按**读取时刻**判定斜杠命令的,不是送达时刻:会话空闲时送进去的 /compact,若正赶上
        // 后台任务把 CLI 唤醒续跑,就会被那一轮读走,记成 queued_command(commandMode:"prompt")当纯文本用掉。
        // 这个窗口在 CLI 那侧,前端的闸关不严。result 到达 = 干净的轮次边界,把它塞回待发队列重发一次
        // (队列的出队条件本就是"彻底空闲")。只重发一次,压缩真做成了才解锁,否则死循环。
        // 队列满了就重发不了(reducer 会把它吞掉)。这种时候必须在错误里说清楚,否则用户看到的是
        // "没执行"而没有下文,不知道自己清一条待发就能重来。
        const full = (x.pending?.length ?? 0) >= PENDING_MAX;
        const retry = missed && !x.compactRetried && !full;
        tl[i] = { ...t, running: false, ...(missed ? { error: i18n.t(
          retry ? "命令被并入了正在跑的那一轮，正在自动重发"
            : full ? "命令被并入了正在跑的那一轮；待发队列已满，没能自动重发 —— 清掉一条待发再试"
            : "命令被并入了正在跑的那一轮，未作为斜杠命令执行") } : {}) };
        if (!retry) return { ...x, timeline: tl };
        return { ...x, timeline: tl, compactRetried: true,
          pending: [...(x.pending ?? []), { pid: "compact-retry", blocks: [{ type: "text", text: "/compact" }], text: "/compact" }] };
      });
    case "remove_session": {
      const { [a.id]: _drop, ...rest } = s.sessions;
      const index = s.index.filter((e) => e.id !== a.id);
      const activeId = s.activeId === a.id ? (index[0]?.id ?? null) : s.activeId;
      return { ...s, sessions: rest, index, activeId };
    }
    case "open":
      return { ...s, sessions: { ...s.sessions, [a.session.id]: a.session }, activeId: a.session.id };
    case "activate":
      return { ...s, activeId: a.id };
    case "go_home":
      return { ...s, activeId: null }; // 回首页(空态):新建按钮不再弹窗,直接展示带背景图的空页面
    case "mark_created":
      return { ...s, justCreatedId: a.id };
    case "patch": return upd(a.id, (x) => ({ ...x, ...a.patch }));
    // 只把「已断开」抬回空闲:此刻可能正有一轮在跑(重连后立刻续跑),别把 running 抹平
    case "revive": return upd(a.id, (x) => (x.status === "closed" ? { ...x, status: "idle" } : x));
    case "sdk_init":
      return upd(a.id, (x) => {
        // 保留带 provider 前缀的第三方选择(kimi/…, deepseek/…):SDK init 只回裸模型 id(如 kimi-k3),
        // 拿它覆盖会丢掉 provider 归属 → sessionProvider 误判成 claude、上下文窗口和 5h/周用量条全串成 Claude 的。
        // 回放历史(keepModel)同样保留已选模型。Claude 原生 id 无斜杠,照常随 init 更新。
        const keep = a.keepModel || !!x.info.model?.includes("/");
        return { ...x, info: { ...a.info, model: keep && x.info.model ? x.info.model : a.info.model } };
      });
    case "append":
      return upd(a.id, (x) => {
        // 一段文字后若紧接工具调用,它是执行中的说明，不是最终交付。
        const timeline = a.item.kind === "tool" ? markLastAgentProgress(x.timeline) : x.timeline;
        return { ...x, timeline: [...timeline, a.item] };
      });
    case "tool_result":
      return upd(a.id, (x) => ({
        ...x,
        timeline: x.timeline.map((t) =>
          t.kind === "tool" && t.id === a.toolUseId ? { ...t, result: a.result, isError: a.isError } : t),
      }));
    case "decide_permission":
      return upd(a.id, (x) => ({
        ...x,
        timeline: x.timeline.map((t) =>
          t.kind === "permission" && t.requestId === a.requestId
            // decidedTs = 被决定的时刻,和 ts(请求时刻)之差 = 用户在这张卡上"做选择"花的等待,
            // 用来从本轮耗时里扣掉。?? 兜底避免重复决定(如 respondPermission 后又收到 permission_resolved 回声)被改晚。
            // answer/remembered 也用 ?? 保底:回声那条 decide_permission 不带 answer,不能拿 undefined 把本地已存的选择冲掉
            // (否则 AskUserQuestion 的作答会显示成"已跳过,未作选择")。
            ? { ...t, decision: a.decision, answer: a.answer ?? t.answer, remembered: a.remembered ?? t.remembered, decidedTs: t.decidedTs ?? Date.now() } : t),
      }));
    case "add_usage":
      return upd(a.id, (x) => ({
        ...x,
        costUsd: x.costUsd + a.costUsd,
        inputTokens: x.inputTokens + a.inputTokens,
        outputTokens: x.outputTokens + a.outputTokens,
        cacheWriteTokens: (x.cacheWriteTokens ?? 0) + a.cacheWrite,
        cacheReadTokens: (x.cacheReadTokens ?? 0) + a.cacheRead,
      }));
    case "stream_start":
      return upd(a.id, (x) => ({
        ...x,
        timeline: [...x.timeline, { kind: "agent_text", text: "", streaming: true, ts: Date.now() }],
      }));
    case "stream_delta":
      return upd(a.id, (x) => ({
        ...x,
        timeline: mapLastStreaming(x.timeline, (t) => ({ ...t, text: t.text + a.text })),
      }));
    case "stream_stop":
      return upd(a.id, (x) => ({
        ...x,
        timeline: mapLastStreaming(x.timeline, (t) => ({ ...t, streaming: false, phase: "final" })),
      }));
    case "agent_text_dedup":
      return upd(a.id, (x) => {
        // 要在"本轮"内回查,不能只看末尾一条:一条 assistant 消息可以带多个 text block(中间夹 tool_use),
        // 而流式早把这些文本按顺序全铺进 timeline 了。只比末尾 → 靠前的 block 认不出来,又追加一遍,
        // 气泡里每段话就出现两遍。
        for (let i = x.timeline.length - 1; i >= 0; i--) {
          const t = x.timeline[i];
          if (t.kind === "user" || t.kind === "result") break; // 越过本轮边界就不用找了
          if (t.kind === "agent_text" && t.text.trim() === a.text.trim()) {
            // 已由流式铺过:只补 model(流式时拿不到),文本不动
            if (a.model && !t.model) {
              const tl = [...x.timeline]; tl[i] = { ...t, model: a.model };
              return { ...x, timeline: tl };
            }
            return x;
          }
        }
        return { ...x, timeline: [...x.timeline, { kind: "agent_text", text: a.text, ts: Date.now(), phase: "final", model: a.model }] };
      });
    case "set_context":
      return upd(a.id, (x) => {
        // 后台微调用(haiku 摘要/安全检查等)也走同一条流,message_start 的上下文比主对话小一个量级,
        // 会把进度条打回 1% 并写坏 localStorage 缓存 —— 模型和主对话不一致的一律丢弃。
        // 1M 模型 id 带 "[1m]" 后缀而 message_start 里是裸 id,比对前剥掉。
        const norm = (s: string) => s.replace(/\[1m\]$/, "");
        if (a.contextTokens != null && a.fromModel && x.info.model && norm(a.fromModel) !== norm(x.info.model)) return x;
        // 单调守卫:后台微调用可能用同一主模型(躲过上面的 model 检查),但它的上下文远小于主对话。
        // 主对话上下文只增不减;唯一合法下降是压缩(allowShrink,走独立路径带 post_tokens)和 /clear(置 0)。
        // 所以非压缩的、比现值小的更新一律当后台噪声丢弃 —— 正是"缓存好值一会儿被打回 1%"的根因。
        if (a.contextTokens != null && !a.allowShrink && a.contextTokens < x.contextTokens) return x;
        // 缓存写入收拢到这里:被丢弃的值不落盘,重开会话回填的才是主对话的真实体积
        if (a.contextTokens != null) saveCtx(a.id, { t: a.contextTokens });
        if (a.contextWindow != null) saveCtx(a.id, { w: a.contextWindow });
        return {
          ...x,
          contextTokens: a.contextTokens ?? x.contextTokens,
          contextWindow: a.contextWindow ?? x.contextWindow,
        };
      });
    case "attach_tokens":
      return upd(a.id, (x) => {
        const tl = [...x.timeline];
        for (let i = tl.length - 1; i >= 0; i--) {
          if (tl[i].kind === "agent_text" && (tl[i] as any).tokensOut === undefined) {
            tl[i] = { ...tl[i], tokensOut: a.tokensOut } as TimelineItem; break;
          }
        }
        for (let i = tl.length - 1; i >= 0; i--) {
          if (tl[i].kind === "user" && (tl[i] as any).tokensIn === undefined) {
            tl[i] = { ...tl[i], tokensIn: a.tokensIn, tokensInUncached: a.tokensInUncached } as TimelineItem; break;
          }
        }
        return { ...x, timeline: tl };
      });
  }
}

function markLastAgentProgress(tl: TimelineItem[]) {
  for (let i = tl.length - 1; i >= 0; i--) {
    const t = tl[i];
    if (t.kind === "agent_text") {
      const copy = [...tl]; copy[i] = { ...t, phase: "progress" }; return copy;
    }
    if (t.kind === "user" || t.kind === "result") break;
  }
  return tl;
}

// 正在压缩中的那条的下标(只可能有一条),没有则 -1
function runningCompactAt(tl: TimelineItem[]) {
  for (let i = tl.length - 1; i >= 0; i--) {
    const t = tl[i];
    if (t.kind === "compact" && t.running) return i;
  }
  return -1;
}

/** 这一轮还没了结吗?任何"发消息"的入口都得先问它一遍,忙就该进待发队列而不是直发。
 *  三个口子缺一不可:status 只在模型说话时是 running,后台任务续跑(bgWait)和压缩中它都已回到 idle。
 *  漏掉压缩那个尤其致命 —— 消息直打进 SDK 会把整个压缩中断掉(Request was aborted)。 */
export const sessionBusy = (s: Session) =>
  s.status === "running" || !!s.bgWait || runningCompactAt(s.timeline) >= 0;

// 更新时间线里最后一个 streaming 的 agent_text
function mapLastStreaming(tl: TimelineItem[], f: (t: any) => any): TimelineItem[] {
  for (let i = tl.length - 1; i >= 0; i--) {
    if (tl[i].kind === "agent_text" && (tl[i] as any).streaming) {
      const copy = [...tl];
      copy[i] = f(tl[i]);
      return copy;
    }
  }
  return tl;
}

// 上下文体积(contextTokens/contextWindow)只在实时 message_start 时能拿到,历史回放拿不到 ——
// 重开会话进度条会掉回 0。缓存到 localStorage,重开时先回填缓存值,等下一轮实时数据再刷新。
function ctxKey(id: string) { return `cc-ctx-${id}`; }
function readCtx(id: string): { t?: number; w?: number } { try { return JSON.parse(localStorage.getItem(ctxKey(id)) || "{}"); } catch { return {}; } }
function saveCtx(id: string, patch: { t?: number; w?: number }) { try { localStorage.setItem(ctxKey(id), JSON.stringify({ ...readCtx(id), ...patch })); } catch {} }

// ---------- SDK 消息 -> 时间线 ----------
function emptySession(id: string, title: string, cwd: string, inheritFrom?: string | null, casual?: boolean): Session {
  const cached = readCtx(id); // 重开时回填上次的上下文体积,进度条不再掉到 0
  return {
    id, title, cwd, termCwd: cwd, ssh: null, resumePrompt: null, status: "idle", timeline: [], todos: [], info: {}, models: [],
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
    contextTokens: cached.t ?? 0, contextWindow: cached.w ?? 200000,
    sessionLimit: { usedPct: null, resetAt: null },
    weeklyLimit: { usedPct: null, resetAt: null },
    inheritFrom, casual,
    bgTasks: [], bgWait: false,
  };
}

// 单调时间戳:历史回放在一个同步循环里跑,多条 Date.now() 会撞同一毫秒,导致多条 user 消息 ts 相同、
// 抽屉按 ts 定位回合时命中第一条而错乱。保证严格递增即可唯一。
// 回放时优先用日志里的真实 timestamp(at) —— 否则重开过的会话,历史消息 ts 全是"回放那一刻",
// 搜索结果(按日志时间)点进来就定位不到,只能落到最后一条。按会话各自单调:全局单调会把旧日志的
// 早时间全顶成"现在+1",等于没用。
const tsSeq = new Map<string, number>();
function nextTs(id: string, at?: string) {
  const raw = at ? +new Date(at) : Date.now();
  const prev = tsSeq.get(id) ?? 0;
  const n = Number.isFinite(raw) && raw > prev ? raw : prev + 1;
  tsSeq.set(id, n);
  return n;
}

function handleSdkMessage(dispatch: (a: Action) => void, id: string, msg: any, live: boolean, stateRef?: MutableRefObject<State>) {
  const ts = nextTs(id, msg.timestamp);
  if (msg.type === "system" && msg.subtype === "init") {
    dispatch({ type: "sdk_init", id, keepModel: !live, info: {
      model: msg.model, tools: msg.tools, mcp_servers: msg.mcp_servers,
      slash_commands: msg.slash_commands, skills: msg.skills,
    } });
    // 新的 CLI 进程:SDK 不会在启动时补发后台任务电平,必须重置为空,等下次 membership 变化再填充。
    // 但**不能**顺手清 bgWait:后台任务的续跑轮自己也会先发一条 init,清了就等于在续跑刚起步时开闸,
    // 待发队列立刻放一条进去 → 撞进那一轮被当纯文本读掉(/compact 于是压根没执行)。
    // 闩锁照旧由续跑的 result 清;进程真的换了、续跑不会来了,有下面 20 秒空闲兜底放闸。
    dispatch({ type: "patch", id, patch: { bgTasks: [] } });
    // 实时 init = CLI 真的跑起来了,断连状态到此解除。少了这一步,重连成功后底部仍挂着
    // 「会话已断开 · 点此重连」(输入框根本不渲染),用户只能得出"点了没反应"的结论 ——
    // status 得等下一条 result 才会变,而没有输入框就永远发不出下一轮。
    if (live) dispatch({ type: "revive", id });
    return;
  }
  // 后台任务电平信号(REPLACE 语义):有任务在跑 → 上一轮没完全了结,待发队列不许出队,等续跑结束的 result 再放行。
  // 空任务集不清闩锁 —— 空信号意味着续跑即将开始,闩锁要等续跑自己的 result 来清,否则又会在续跑前把队列放出去。
  if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
    // 回放历史(!live)必须跳过:日志里的任务早就跑完了,电平没有意义。更要命的是清闩锁的代码在 result 的
    // `if (live)` 分支里 —— 回放会一路把 bgWait 置 true 却永远没人清,重开会话后每条消息都卡在待发区。
    // (SDK 的 resume 是懒的:起进程 + 跑 SessionStart hook,能重置的新 init 要等第一条 prompt 才来。)
    if (!live) return;
    const tasks = Array.isArray(msg.tasks) ? msg.tasks.map((t: any) => String(t.task_id)) : [];
    dispatch({ type: "patch", id, patch: { bgTasks: tasks, ...(tasks.length ? { bgWait: true } : {}) } });
    return;
  }
  // API 退避重发:SDK 每次撞上可重试错误(529 过载、超时…)都会先发这条,再等 retry_delay_ms 重发。
  // 以前这条没人接,于是整个退避期界面上只有一句"正在思考…"(实测 529 能连着退避 3 分多钟),
  // 用户看到的是彻底静默的卡死 —— 只能靠反复重试碰运气。接住它,把"第几次重试"摆到气泡上。
  if (msg.type === "system" && msg.subtype === "api_retry") {
    if (!live) return; // 回放历史没意义:那次重试早有结论了
    dispatch({ type: "patch", id, patch: { apiRetry: { attempt: msg.attempt, max: msg.max_retries, status: msg.error_status ?? null } } });
    return;
  }
  // 压缩上下文:status 报开始,compact_boundary 报压缩前后的 token 数。
  // 注意 status(compact_result:"success") 早于 compact_boundary 到达 —— 不能在它上面收尾,
  // 否则 boundary 带来的 token 数就没有归属,会另起一条空的压缩记录。
  if (msg.type === "system" && msg.subtype === "status") {
    if (msg.status === "compacting") dispatch({ type: "compact_start", id });
    else if (msg.compact_result === "failed") dispatch({ type: "compact_finish", id, patch: { error: msg.compact_error || i18n.t("压缩失败") } });
    return;
  }
  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const md = msg.compact_metadata ?? {};
    dispatch({ type: "compact_finish", id, patch: {
      auto: md.trigger === "auto",
      preTokens: md.pre_tokens, postTokens: md.post_tokens, durationMs: md.duration_ms,
    } });
    if (md.post_tokens != null) dispatch({ type: "set_context", id, contextTokens: md.post_tokens, allowShrink: true });
    return;
  }
  // 流式:文本增量走 stream_event(仅实时会话)。回放历史(!live)必须跳过——旧日志里存了 stream_event,
  // 若照样回放会把流式文本重建一遍,再叠加下面 assistant 的最终文本 → 每段回复显示两次(重复消息根因)。
  if (msg.type === "stream_event") {
    if (!live) return;
    // 子 agent 的流式增量:文本会窜进主气泡,message_start 的小上下文会把进度条打回 1%,整条跳过
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (ev.type === "message_start") {
      // 请求真的通了 → 退避结束,撤掉"第 N 次重试"提示(重试期间不会有 message_start)
      if (stateRef?.current.sessions[id]?.apiRetry) dispatch({ type: "patch", id, patch: { apiRetry: null } });
      const u = ev.message?.usage;
      if (u) {
        const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        dispatch({ type: "set_context", id, contextTokens: ctx, fromModel: ev.message?.model });
      }
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      dispatch({ type: "stream_start", id });
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      dispatch({ type: "stream_delta", id, text: ev.delta.text });
    } else if (ev.type === "content_block_stop") {
      dispatch({ type: "stream_stop", id });
    }
    return;
  }
  if (msg.type === "assistant") {
    // 这条消息由哪个模型产生(会话中途切模型时,逐条据此选头像/名称)。流式先建的 agent_text 无 model,靠 dedup 回填。
    // SDK 给"合成消息"(API 报错等自己造的回复)填的 model 是字面量 "<synthetic>",不是模型 id ——
    // 原样存进时间线,这一轮的头像就按它渲染成绿圈里一个 "<",名字也退回默认品牌名。
    // 当没有 model 处理,交给 groupModel 回退到本会话当前模型(报错那轮用的就是它)。
    const model = msg.message?.model?.startsWith("<") ? undefined : msg.message?.model;
    for (const block of msg.message?.content ?? []) {
      // 实时:正常回复已由 stream_event 显示;但本地命令(/cost /context)只来最终 assistant 消息、无流式,需补显(去重防和流式重复)。回放历史(!live)时直接补完整文本。
      if (block.type === "text" && block.text.trim()) {
        if (live) dispatch({ type: "agent_text_dedup", id, text: block.text, model });
        else dispatch({ type: "append", id, item: { kind: "agent_text", text: block.text, ts, phase: "final", model } });
      } else if (block.type === "tool_use") {
        if (block.name === "TodoWrite" && block.input?.todos) {
          dispatch({ type: "patch", id, patch: { todos: block.input.todos } }); // d: 任务进度
        }
        dispatch({ type: "append", id, item: { kind: "tool", id: block.id, name: block.name, input: block.input, ts, model } });
      }
    }
    if (live) dispatch({ type: "patch", id, patch: { status: "running" } });
    return;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          dispatch({ type: "tool_result", id, toolUseId: block.tool_use_id, result: block.content, isError: block.is_error });
        }
      }
      // 恢复用户消息:回放历史(!live)时是自己发的;实时(live)时是**另一端**发的(sidecar 回显，
      // 已排除发送方，所以不会重复自己的乐观消息)。两种都要渲染，否则手机发的字电脑看不到。
      if (content.some((b: any) => b.type === "text" || b.type === "image")) {
        dispatch({ type: "append", id, item: { kind: "user", blocks: content, ts } });
      }
    }
    return;
  }
  if (msg.type === "result") {
    dispatch({ type: "compact_settle", id }); // 压缩没等到结束信号时兜底收尾,别让进度条一直转
    dispatch({ type: "append", id, item: {
      kind: "result", costUsd: msg.total_cost_usd ?? 0, durationMs: msg.duration_ms ?? 0,
      usage: msg.usage, isError: msg.is_error ?? false, aborted: msg.aborted ?? false, ts,
    } });
    const inTok = (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0);
    const outTok = msg.usage?.output_tokens ?? 0;
    // 静默回合:usage 全 0 的 result —— 压缩、控制指令这类根本没调模型的轮次也会发一条。
    // 它必须整条跳过,不能拿去标记消息:发出消息后马上会收到这么一条,气泡上就挂出"输入 0 tokens";
    // 等真正的 result 回来时,这条 user 已经被标记过了(attach_tokens 只认最近一条"没标记过"的),
    // 真实数字于是错记到更早的消息上 —— 一条假 0 会把后面所有消息的 token 全串一位。
    // (AgentTurnCard 的 aggregateRound 早就按这条规矩把静默回合当不存在,这里之前漏了。)
    const silent = inTok === 0 && outTok === 0 && !msg.aborted && !msg.is_error;
    if (!silent) {
      dispatch({ type: "add_usage", id, costUsd: msg.total_cost_usd ?? 0, inputTokens: inTok, outputTokens: outTok,
        cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0, cacheRead: msg.usage?.cache_read_input_tokens ?? 0 });
      // 每条消息 token(2.4):本轮 in 记到最近 user,out 记到最近 agent
      // 未命中缓存的输入 = 新读 + 新建缓存(cache_read 才是命中,不计)
      const inUncached = (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0);
      dispatch({ type: "attach_tokens", id, tokensIn: inTok, tokensInUncached: inUncached, tokensOut: outTok });
    }
    // 上下文窗口大小(2.1)。modelUsage 按模型名分桶,子 agent 用的小模型(haiku 200k)也会占一个桶,
    // 取第一个可能拿到 200k 而不是主模型的 1M —— 取最大值。
    // 这里只更新窗口,不动 contextTokens:result.usage 是整轮所有 API 调用(含子 agent)的累加,
    // 能轻松超过上下文窗口,拿它填进度条会爆表。上下文体积由 message_start / compact_boundary 负责。
    const windows = Object.values(msg.modelUsage ?? {}).map((mu: any) => mu?.contextWindow).filter(Boolean) as number[];
    if (windows.length) dispatch({ type: "set_context", id, contextWindow: Math.max(...windows) });
    if (live) {
      // freshDone: 仅本次启动软件后真正完成的轮次才置 true,驱动列表绿色✅;历史 reopen 的 idle 不点亮
      // 本轮若还挂着后台任务(bgTasks 非空)→ 轮次未完全了结,bgWait 保持;后台任务清空后的续跑 result 才放行队列。
      // 用户中断(aborted)时必清闩锁:SDK 可能先回 result 再发后台任务清空信号,不清的话闩锁会卡死队列。
      // 还挂着后台任务 = 这一轮压根没完:绿✅ 和"任务完成"提醒都得压住,等后台任务清空后的续跑 result 再放。
      // (不压的话:列表里画着 ✅、dock 跳一下、"叮"一声,可用户点进去看到的是"后台任务运行中·已跑 3min")
      const hasBg = (stateRef?.current.sessions[id]?.bgTasks?.length ?? 0) > 0;
      const done = !msg.aborted && !hasBg;
      dispatch({ type: "patch", id, patch: { status: "idle", freshDone: done, apiRetry: null, ...(msg.aborted || !hasBg ? { bgWait: false } : {}) } });
      if (done) { notify(i18n.t("任务完成"), i18n.t("花费 ${{cost}}", { cost: (msg.total_cost_usd ?? 0).toFixed(4) })); alertUser(); } // d: 完成提醒 + dock 跳动(不在前台时才跳) + 提示音
    }
  }
}

// dock 跳动提醒(窗口在前台时系统本来就不跳)。用户可在设置里关掉,默认开 ——
// 只有显式存过 "0" 才算关,不然第一次启动读到 null 就成了默认关。
// 所有跳动都必须走 bounceDock:直接 invoke 会绕开这个开关,新增提醒点时最容易漏(自检盯着这条)。
export const DOCK_BOUNCE_KEY = "ChatCode-dock-bounce";
export const dockBounceOn = () => localStorage.getItem(DOCK_BOUNCE_KEY) !== "0";
const bounceDock = () => { if (dockBounceOn()) invoke("bounce_dock").catch(() => {}); };

// 提示音。WebAudio 现场合成两声「叮」,不带音频文件 —— 少一个要打进包、要管路径的资产。
// 不需要任何系统权限(放音不是录音,TCC 不管),也不受「系统设置 › 通知」里那个播放声音开关摆布,
// 所以它比挂在桌面通知上的声音更听话:用户在这儿关了就是关了。
// 前台也响,正好补上 dock 跳动的空档 —— 窗口在最前时 macOS 根本不跳。
export const SOUND_KEY = "ChatCode-alert-sound";
export const soundOn = () => localStorage.getItem(SOUND_KEY) !== "0";
let actx: AudioContext | null = null;
export const playDing = () => {
  if (!soundOn()) return;
  try {
    actx ??= new AudioContext();
    // 用户还没碰过界面时 AudioContext 是 suspended,这会儿排的音会攒着、等 resume 的瞬间一起炸响。
    // 所以先 resume 再排音;已经 running 的话这个 promise 立即 resolve,不多花一帧。
    actx.resume().then(() => {
      const at = actx!.currentTime;
      [[880, at], [1320, at + 0.09]].forEach(([f, t0]) => {
        const o = actx!.createOscillator(), g = actx!.createGain();
        o.frequency.value = f;                                  // sine 是默认波形
        g.gain.setValueAtTime(0.0001, t0);                      // 指数斜坡碰不得 0,从极小值起
        g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);   // 1ms 太冲会「啪」,10ms 起音干净
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
        o.connect(g).connect(actx!.destination);
        o.start(t0); o.stop(t0 + 0.36);
      });
    }).catch(() => {});
  } catch { /* WebAudio 不可用就安静点,不值得为提示音报错 */ }
};

// 提醒统一出口:再加提醒点时调这一个,不会漏掉任何一路开关(同 sessionBusy 那次的教训)。
const alertUser = () => { bounceDock(); playDing(); };

function notify(title: string, body: string) {
  try {
    if (Notification.permission === "granted") new Notification(title, { body });
    else if (Notification.permission !== "denied") Notification.requestPermission();
  } catch { /* Tauri webview 里需要 notification 插件,骨架先降级为角标 */ }
}

// ---------- context ----------
// 只放方法(state 走 StateCtx)。这里每一个都必须只吃 ref / dispatch / setState 这类稳定引用 ——
// 一旦有谁直接闭包捕获了 state,下面那个 useMemo([]) 就会把它冻在首帧的旧值上。要读实时状态走 stateRef。
interface Api {
  dispatch: (a: Action) => void;
  createSession: (cwd: string, resume?: string | null, title?: string, inheritFrom?: string | null, casual?: boolean, model?: string) => void;
  // 空态输入框:建会话并把首条消息暂存,等 session_created 回来自动发出。cwd 为空 = 闲聊会话。
  startSessionWithMessage: (cwd: string, blocks: any[]) => void;
  requestHomeModels: () => void;        // 首页拉取模型列表
  setHomeModel: (model: string) => void; // 首页选中模型(持久化,新会话以此启动)
  reopenSession: (id: string) => void;
  restoreSession: (id: string) => void;
  restartSession: (id: string) => void;
  chooseResume: (id: string, choice: ResumeChoice) => void;
  // 返回 false = 与 sidecar 断连、这条没发出去。调用方必须据此保住原文(别清输入框)。
  sendMessage: (id: string, blocks: any[], meta?: { html?: string; imgs?: Record<string, { media_type: string; data: string }> }) => boolean;
  // 返回 false = 队列已满、这条没进去。调用方必须据此提示用户并保住原文(别清输入框)。
  // at:定时发送的时刻(ms),到点前不出队;不给就是普通排队(agent 一空闲就发)
  enqueuePending: (id: string, item: { blocks: any[]; text: string; html?: string; imgs?: Record<string, { media_type: string; data: string }>; at?: number }) => boolean;
  cancelPending: (id: string, pid: string) => void;
  respondPermission: (id: string, requestId: string, behavior: "allow" | "deny", message?: string, remember?: RememberChoice) => void;
  interrupt: (id: string) => void;
  setModel: (id: string, model: string, label?: string) => void; // label:模型表还没到时(刚配好 key)由调用方给出显示名
  requestModels: (id: string) => void;
  clearContext: (id: string) => void;
  runTerminal: (id: string, command: string) => void;
  sshReconnect: (id: string) => void;
  sshClose: (id: string) => void;
  configureSsh: (id: string, config: { host: string; username?: string; port?: string; keyPath?: string }) => void;
  searchMessages: (query: string, sessionId?: string, kind?: "all" | "user" | "agent") => void;
  requestAuthStatus: () => void;
  syncUiLang: (lang: string) => void; // 语言切换后同步给 sidecar
  refreshUsage: () => void; // 限额窗口重置时即时拉一次新用量
  authAction: (provider: "claude" | "github", action: "login" | "logout") => void;
  setProviderKey: (provider: string, apiKey: string) => void; // 存/清 其他 LLM provider 的 API key(本地 settings)
  setProviderConfig: (provider: string, config: { baseUrl?: string; smallFast?: string; models?: any[] } | null) => void; // 覆盖/重置 provider 的 baseUrl/模型表
  setCnEndpoint: (on: boolean) => void;                       // 国内节点总开关(GLM/Qwen/MiniMax 换国内域名)
  listSshHosts: () => void;
  saveSshHost: (host: SshHost) => void;
  deleteSshHost: (id: string) => void;
  testSshHost: (host: SshHost) => void;
  requestGitInfo: (id: string) => void;
  stopTask: (id: string, taskId: string) => void; // 停 agent 起的后台任务(SDK 侧,没有 pid 可杀)
  requestGitLog: (id: string) => void;
  requestGitDiff: (id: string, from: string, to: string) => void;
  requestGitCommitDetail: (id: string, hash: string) => void;
  requestGitFileDiff: (id: string, from: string, to: string, file: string) => void;
  compareBranches: (id: string, base: string, head: string) => void;
  suggestCommit: (id: string, force?: boolean) => Promise<string>; // commit 弹窗:总结待提交改动;无新对话复用缓存,force 强制重跑
  askBtw: (id: string, text: string) => Promise<string>; // 抽屉侧问:走 CLI 的 side_question,任务跑着也能问,不排队、不进主线上下文
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setAutoAllow: (id: string, on: boolean) => void; // 会话级"自动同意"
  setPermissionPreset: (id: string, key: string) => void; // 权限档位:一次写「自动同意」+ SDK 权限模式两个旋钮
  moveSession: (sessionId: string, groupId: string | null, beforeId: string | null) => void; // 拖拽排序 / 进出分组
  createGroup: (name: string) => void;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => void; // 删组:组内会话回落到未分组
}
// 状态和方法分两个 context。方法那半身份永远不变(见下面 api 的 useMemo),所以只调方法的组件
// 用 useApi() 订阅它,就彻底不跟着 state 走了 —— 以前它俩挤在一个 context 里,
// 想要一个 authAction 也得连着整个 state 一起订上,任何一次 dispatch(用量 15s 一拍、别的会话在流式、
// 钱包 60s 一拍)都把这些组件重渲一遍。
const StateCtx = createContext<State>(null!);
const ApiCtx = createContext<Api>(null!);
// 既要 state 又要方法:照旧。返回的对象每次新建不要紧,重渲染只由 useContext 的订阅决定。
export const useStore = () => ({ ...useContext(ApiCtx), state: useContext(StateCtx) });
// 只要方法:用这个。少订一个 context,state 再怎么变也不惊动。
export const useApi = () => useContext(ApiCtx);

// ---------- 历史图片按需取 ----------
// 历史里的图片只有引用(见 ContentBlock 的 cc_blob),真数据留在 sidecar。这里给非 React 处
// (ImgTag 的 hover/点击)一条不经 context 的取数通道:模块级持有 ws 的 send + 一张 promise 缓存,
// 同一张图取多少次都只发一次请求、只在内存留一份 dataURL。
let blobSend: ((o: any) => void) | null = null;
const blobCache = new Map<string, Promise<string | null>>();       // 只放缩略图:一张几 KB,命中频繁(滚动来回划),留着划算
let fullHit: { id: string; p: Promise<string | null> } | null = null; // 原图一张能到几 MB,全缓下来内存只涨不降 —— 只留最近看的那张
const blobWaiters = new Map<string, (v: string | null) => void>();
const dropBlob = (id: string, full: boolean) => { if (full) { if (fullHit?.id === id) fullHit = null; } else blobCache.delete(id); };

export function fetchBlob(key: string, mediaType: string, full: boolean): Promise<string | null> {
  const id = `${key}:${full ? "full" : "thumb"}`;
  // 原图这一格同时兼作"飞行中"去重:连点两下不会发两次请求
  const hit = full ? (fullHit?.id === id ? fullHit.p : undefined) : blobCache.get(id);
  if (hit) return hit;
  const p = new Promise<string | null>((resolve) => {
    if (!blobSend) { resolve(null); return; }
    blobWaiters.set(id, resolve);
    blobSend({ type: "blob_get", key, mediaType, full });
    // 兜底:sidecar 没回(重启/断线)就当取不到,别让 hover 一直转圈。缓存也一并清掉,下次可重试。
    setTimeout(() => { if (blobWaiters.delete(id)) { dropBlob(id, full); resolve(null); } }, 20000);
  });
  if (full) fullHit = { id, p }; else blobCache.set(id, p);
  return p;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // commit 自动总结的待响应 promise(按 sessionId 存,一个会话同时最多一个弹窗)
  const commitWaiters = useRef(new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void }>());
  // 侧问的待响应 promise。按 rid 存而不是按 sessionId:侧问不占主线,同一会话可以连着问好几条,
  // 后一条不该把前一条的回答顶掉(commit 总结那种"一个弹窗一条"的按会话存法在这里不成立)。
  const btwWaiters = useRef(new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void }>());
  // 启动预取只做一次:连上后首个 index 到达时,异步暖各会话 git 分支状态 + 5h/周用量。断线重连会重置。
  const prefetched = useRef(false);
  // 重连后待对表:下一份 index 用来把本地"运行中"和 sidecar 的真状态校齐(见 index 分支)。
  const resync = useRef(false);
  // 空态输入框"发消息即建会话":会话 id 由 sidecar 生成、异步回来,先把首条消息暂存,等 session_created 到了再补发。
  const pendingFirst = useRef<any[] | null>(null);
  // 同目录重复建会话的拦截:标题只取目录 basename,同一目录建两次就是两条同名会话,
  // 侧栏根本分不出谁是谁。新建前先问一句,给"打开已有"的出口。
  const [dupAsk, setDupAsk] = useState<{ existing: IndexEntry; count: number; proceed: () => void } | null>(null);

  // 自动放行一条授权请求(等价于点"允许",不写规则文件)。函数声明,给下面 [] 依赖的 ws 回调闭包用。
  function autoAllowNow(id: string, requestId: string) {
    dispatch({ type: "decide_permission", id, requestId, decision: "allow" });
    dispatch({ type: "patch", id, patch: { status: "running" } });
    send({ type: "permission_response", sessionId: id, requestId, behavior: "allow" });
  }

  useEffect(() => {
    let stop = false;
    async function connect() {
      const token = await sidecarToken;
      if (stop) return;
      const ws = new WebSocket(`ws://127.0.0.1:${SIDECAR_PORT}${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      wsRef.current = ws;
      ws.onopen = () => {
        dispatch({ type: "connected", v: true });
        resync.current = true; // 见下面 index 分支:重连后拿 sidecar 的真状态校一次
        dismissToast(WS_DOWN);
        send({ type: "set_lang", lang: getLang() }); // 让 sidecar 一上来就按当前语言出消息
      };
      ws.onerror = () => console.warn("[ws] 出错 readyState=", ws.readyState); // 紧跟着必有 onclose,这里只留个痕
      ws.onclose = (ev) => {
        console.warn(`[ws] 断开 code=${ev.code} reason=${ev.reason || "(空)"} wasClean=${ev.wasClean}`);
        dispatch({ type: "connected", v: false });
        prefetched.current = false;
        // 断连当下就把转圈停掉:那轮的 turn_ended 会丢在断线里,不停就一直转到天荒地老,
        // 而用户要等到手动发下一条才知道断了。真相以重连后的第一份 index 为准 ——
        // 那边会把「其实还在跑」的会话恢复回 running(见下面 resync 的两个方向)。
        for (const s of Object.values(stateRef.current.sessions))
          if (s.status === "running") dispatch({ type: "patch", id: s.id, patch: { status: "idle" } });
        toast(i18n.t("与后端断开 —— 正在重连,这期间发不出消息"), "error", WS_DOWN); // 带 key = 常驻,重连时收掉
        if (!stop) setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        switch (m.type) {
          case "index":
            dispatch({ type: "index", index: m.sessions, groups: m.groups, closed: m.closed });
            // 重连后的第一份 index 兼作状态对表:断线期间那轮多半已经结束,turn_ended 却丢在断线里,
            // 界面就一直转圈。只在重连这一次做 —— 平时 index 可能比 user_message 先到,
            // 会把刚起的轮次错判成空闲,把待发队列提前放出去。
            if (resync.current) {
              resync.current = false;
              for (const e of m.sessions) {
                const s = stateRef.current.sessions[e.id];
                if (!s) continue;
                if (s.status === "running" && e.status !== "running")
                  dispatch({ type: "patch", id: e.id, patch: { status: "idle", bgWait: false, bgTasks: [] } });
                // 反向也要校:onclose 把转圈一律停了,可 sidecar 那边这轮多半还在跑 —— 不恢复就成了
                // 「界面空闲、后台在跑」,待发队列会当成空闲把下一条插进去。
                else if (s.status !== "running" && e.status === "running")
                  dispatch({ type: "patch", id: e.id, patch: { status: "running" } });
              }
            }
            // 启动后异步暖缓存:切到哪个会话都不再"Git…"闪一下,底部用量条也立刻有数。只在首个 index 触发。
            if (!prefetched.current) {
              prefetched.current = true;
              send({ type: "usage_refresh" }); // 5h / 周用量即时拉一次,不等下一拍轮询
              for (const e of m.sessions) if (!e.casual && e.cwd) send({ type: "git_info", sessionId: e.id });
            }
            break;
          case "usage": dispatch({ type: "set_usage", usage: m.usage, kimiUsage: m.kimiUsage }); break;
          // 别端排在这个会话上的待发,只读显示。手机走 sidecar 真队列(msg_queue),别的前端走镜像(peer_pending),
          // 两条通路都指向「对端队列」这一栏 —— 本机自己的队列是前端 pending,不会经这两条回来,不重复。
          case "msg_queue":
          case "peer_pending": dispatch({ type: "set_peer_queue", id: m.sessionId, items: m.items || [] }); break;
          case "auth_status": {
            const prev = stateRef.current.auth;
            dispatch({ type: "auth_status", status: m.status });
            // 刚配好第一把第三方 key → 自动选中这家的模型(判断见 pickAutoModel)
            const pick = pickAutoModel(prev, m.status, stateRef.current.homeModel);
            if (pick) {
              dispatch({ type: "set_home_model", model: pick.value }); // 新会话以此启动
              send({ type: "get_models", sessionId: HOME_MODELS_ID }); // 首页选择器的列表补上这家
              // 打开着的会话也顺手切过去(displayName 直接给:models 广播可能还没到,否则条子会显示原始 id)
              const aid = stateRef.current.activeId;
              if (aid) api.setModel(aid, pick.value, modelName(stateRef.current.homeModels, pick));
            }
            break;
          }
          case "ssh_hosts": dispatch({ type: "ssh_hosts", hosts: m.hosts }); break;
          case "ssh_host_test":
            dismissToast(`ssh-test:${m.id}`); // 结果到了,收掉「正在测试…」
            dispatch({ type: "ssh_test", id: m.id, ok: m.ok, detail: m.detail });
            break;
          case "auth_action_result":
            if (m.manual) window.alert(`本机无法自动拉起登录窗口,请在终端手动执行:\n${m.manual}`);
            break;
          case "search_results": dispatch({ type: "search_results", results: m.results }); break;
          case "git_info": dispatch({ type: "git_info", id: m.sessionId, info: m.info }); break;
          case "git_log": dispatch({ type: "git_log", id: m.sessionId, data: { commits: m.commits, heads: m.heads } }); break;
          case "git_diff": dispatch({ type: "git_diff", id: m.sessionId, data: { from: m.from, to: m.to, ahead: m.ahead, behind: m.behind, files: m.files, error: m.error } }); break;
          case "commit_suggest": {
            const w = commitWaiters.current.get(m.sessionId);
            if (w) { commitWaiters.current.delete(m.sessionId); m.ok ? w.resolve(m.message) : w.reject(new Error(m.error || i18n.t("生成失败"))); }
            break;
          }
          case "btw_reply": {
            const w = btwWaiters.current.get(m.rid);
            if (w) { btwWaiters.current.delete(m.rid); m.error ? w.reject(new Error(m.error)) : w.resolve(m.text || ""); }
            break;
          }
          // clipped 要带上:漏了的话「文件较大,只显示改动附近」那行提示永远不显示,用户会以为看到的是全文
          case "git_file_diff": dispatch({ type: "git_file_diff", id: m.sessionId, data: { from: m.from, to: m.to, file: m.file, patch: m.patch, clipped: m.clipped, error: m.error } }); break;
          case "git_commit_detail": dispatch({ type: "git_commit_detail", id: m.sessionId, data: {
            hash: m.hash, parents: m.parents, author: m.author, email: m.email, date: m.date,
            subject: m.subject, body: m.body, files: m.files || [], error: m.error } }); break;
          case "git_compare":
            dispatch({ type: "append", id: m.sessionId, item: { kind: "system", text: m.text, ts: Date.now() } }); break;
          case "models":
            if (m.sessionId === HOME_MODELS_ID) dispatch({ type: "home_models", models: m.models });
            else dispatch({ type: "patch", id: m.sessionId, patch: { models: m.models } });
            break;
          case "session_deleted": dispatch({ type: "remove_session", id: m.sessionId }); break;
          // 「最近历史」恢复完成:条目已随前一条 index 回到列表,这里照常走重开(拉历史/接上下文)
          case "session_restored": api.reopenSession(m.sessionId); break;
          // 连上远程后 termCwd 会被远程命令写成 "user@host:/path";一断开就得清掉,
          // 否则目录栏一直挂着远程路径。清空即回落到本地项目目录(各处都按 termCwd || cwd 取)。
          case "ssh_status": dispatch({ type: "patch", id: m.sessionId,
            patch: { ssh: m.ssh, ...(m.ssh?.status === "connected" ? {} : { termCwd: undefined }) } }); break;
          case "resume_prompt":
            dispatch({ type: "patch", id: m.sessionId, patch: { resumePrompt: { tokens: m.tokens, ageMs: m.ageMs } } });
            break;
          case "system_note":
            dispatch({ type: "append", id: m.sessionId, item: { kind: "system", text: m.text, ts: Date.now() } });
            break;
          case "terminal_chunk":
            dispatch({ type: "terminal_chunk", id: m.sessionId, command: m.command, text: m.text });
            break;
          case "terminal_result": {
            // git 写操作跑完给一句反馈。顶栏按钮、分支面板、节点菜单发的命令都汇到这条通路,
            // 一处覆盖所有入口(各按钮自己盯 busy 标志的老做法总有漏的,而且失败也会谎报成功)。
            const opRaw = gitOpLabel(m.command);
            const op = opRaw ? i18n.t(opRaw) : "";
            const tail = (m.output || "").trim().split("\n").pop() || m.command;
            // commit 成功的这句压后到流光跑完再说(分支页那条线最短亮 COMMIT_HOLD_MS)——
            // 提交常常几百毫秒就完事,提示先弹、线还在跑,读起来像"说完成了但还没完"。失败不压:错误要立刻见人。
            const say = () => toast(m.exitCode === 0 ? i18n.t("已{{op}}", { op }) : i18n.t("{{op}}失败：{{tail}}", { op, tail }), m.exitCode === 0 ? "success" : "error");
            if (op) { if (m.exitCode === 0 && /\bgit\s+commit\b/.test(m.command)) setTimeout(say, COMMIT_HOLD_MS); else say(); }
            // 首页分支页(id 形如 home:<路径>)没有消息流可打印输出,失败会静默 —— 用 toast 兜一下
            else if (m.sessionId.startsWith("home:") && m.exitCode !== 0)
              toast(i18n.t("命令失败({{code}})：{{tail}}", { code: m.exitCode, tail }), "error");
            dispatch({ type: "resolve_terminal", id: m.sessionId, command: m.command, cwd: m.cwd, cwdChanged: m.cwdChanged, output: m.output, exitCode: m.exitCode });
            if (m.cwd) dispatch({ type: "patch", id: m.sessionId, patch: { termCwd: m.cwd } }); // 目录栏跟随 !cd
            send({ type: "git_info", sessionId: m.sessionId }); // 命令(commit/pull…)后立刻刷新,别等 15s 轮询
            send({ type: "git_log", sessionId: m.sessionId }); // 分支 Tab 的拓扑图同步刷新(merge/commit 会改变图)
            break;
          }
          case "session_created": {
            const name = m.title || (m.cwd || "").split("/").filter(Boolean).pop() || i18n.t("新会话");
            const sess = emptySession(m.sessionId, name, m.cwd, m.inheritFrom, m.casual);
            // 首页选的模型要立刻落进 info.model(同 reopenSession 的做法)。不落的话这里是空,
            // 随后 sdk_init 只回裸 id(deepseek-v4-flash),sdk_init 里那个"带斜杠才保留"的判断就守不住,
            // provider 归属丢失 → sessionProvider 兜底判成 claude → DeepSeek 会话也显示 5h/周用量条。
            const homeModel = stateRef.current.homeModel;
            if (homeModel && homeModel !== "default") sess.info.model = homeModel;
            const fromEmpty = !!pendingFirst.current; // 这条会话来自空态输入框(有暂存的首条消息)
            // 空态 → 会话:让空态输入框"变形扩宽"成会话输入框。用浏览器原生 View Transition(合成器 morph,
            // 不动 width、不 layout thrashing),两个输入框共享 view-transition-name 由浏览器配对插值。
            // flushSync 逼 React 在 VT 回调里同步换好 DOM,VT 才能抓到"新"快照。曲线/时长在 CSS 里调。
            const openNow = () => dispatch({ type: "open", session: sess });
            // 暂存的首条消息必须在 open 之后再发:sendMessage 往 sessions[id] 追加用户气泡,
            // 而 open 会用空 timeline 的 emptySession 覆盖该会话。fromEmpty 走异步 VT 回调时,
            // 若在回调外同步发,append 会先于 open 落地(或落到还不存在的会话上),随后被 open 抹掉 → 首条消息丢失。
            const sendFirst = () => { if (pendingFirst.current) { api.sendMessage(m.sessionId, pendingFirst.current); pendingFirst.current = null; } };
            // reduced-motion 不在这里拦截:仍走 VT,但 CSS 会把它降级成"只淡入淡出、无位移"(gentler, not zero)。
            const startVT = fromEmpty ? document.startViewTransition?.bind(document) : undefined;
            if (startVT) startVT(() => flushSync(() => { openNow(); sendFirst(); }));
            else { openNow(); sendFirst(); }
            // 模型列表补一次:sidecar 起 agent 时就广播过 models,但 fromEmpty 时 open 被推迟到
            // View Transition 回调里执行,那条广播往往先到、落在还不存在的会话上被 upd 丢掉,而且不会重发。
            // 列表空了,模型显示名/上下文窗口/provider 判定全部退化。
            send({ type: "get_models", sessionId: m.sessionId });
            dispatch({ type: "index", index: [
              { id: m.sessionId, title: name, cwd: m.cwd, sdkSessionId: null, createdAt: Date.now(), inheritFrom: m.inheritFrom ?? null, casual: m.casual ?? false, model: sess.info.model },
              ...stateRef.current.index,
            ] });
            // 首页新建的会话:侧栏顶部那条播一次入场动效(仅新项,不打扰已有项)。900ms 后清标记,防 stale 重播。
            if (fromEmpty) { dispatch({ type: "mark_created", id: m.sessionId }); setTimeout(() => dispatch({ type: "mark_created", id: null }), 900); }
            break;
          }
          case "history":
            for (const msg of m.messages) handleSdkMessage(dispatch, m.sessionId, msg, false, stateRef);
            dispatch({ type: "patch", id: m.sessionId, patch: { loadingHistory: false } }); // 回放完毕,撤下"加载中"
            break;
          case "blob": { // 历史图片的按需取数回包(见 fetchBlob)
            const id = `${m.key}:${m.full ? "full" : "thumb"}`;
            const w = blobWaiters.get(id);
            if (w) { blobWaiters.delete(id); w(m.data ? `data:${m.media_type};base64,${m.data}` : null); }
            break;
          }
          case "session_ctx": // 重开时日志实算的上下文体积,回填进度条(单调守卫挡掉比现值小的)
            dispatch({ type: "set_context", id: m.sessionId, contextTokens: m.tokens });
            break;
          case "sdk":
            handleSdkMessage(dispatch, m.sessionId, m.message, true, stateRef);
            break;
          case "permission_request": {
            dispatch({ type: "append", id: m.sessionId, item: {
              kind: "permission", requestId: m.requestId, toolName: m.toolName, input: m.input,
              suggestions: m.suggestions, blockedPath: m.blockedPath, ts: Date.now(),
            } });
            // "自动同意"在这里落地(而不是在界面里),后台会话——没被打开、没在渲染——才同样生效。
            // AskUserQuestion 是要人选处理方案的提问卡,永远不自动答。
            if (stateRef.current.autoAllow[m.sessionId] && m.toolName !== "AskUserQuestion") {
              autoAllowNow(m.sessionId, m.requestId);
              break;
            }
            dispatch({ type: "patch", id: m.sessionId, patch: { status: "waiting" } });
            notify(i18n.t("需要你确认"), i18n.t("{{tool}} 等待授权", { tool: m.toolName }));
            alertUser(); // 会话待处理,dock 跳动 + 提示音
            break;
          }
          case "auto_approve": // sidecar 广播的开关状态(任一端切换都同步过来)
            dispatch({ type: "set_auto_allow", id: m.sessionId, on: !!m.on });
            break;
          case "perm_mode": // 权限模式:自己切的、CLI 启动时报的、另一端切的,都从这里回来
            dispatch({ type: "set_perm_mode", id: m.sessionId, mode: m.mode });
            break;
          case "spend": // 会话累计花费(sidecar 逐轮累加并落盘,重开会话会补发一条)
            dispatch({ type: "set_spend", id: m.sessionId, spend: m.spend });
            break;
          case "wallet": // 账户余额 + 今日/本月消费(按 provider),连上即发一次,之后随消费/轮询更新
            dispatch({ type: "set_wallet", wallet: m.wallet || {} });
            break;
          case "permission_resolved": // 另一端已处理这条授权,关掉本端还挂着的卡片
            dispatch({ type: "decide_permission", id: m.sessionId, requestId: m.requestId,
              decision: m.behavior === "deny" ? "deny" : "allow" });
            break;
          case "session_error":
            dispatch({ type: "append", id: m.sessionId, item: { kind: "system", text: i18n.t("错误: {{err}}", { err: m.error }), ts: Date.now() } });
            dispatch({ type: "patch", id: m.sessionId, patch: { status: "closed", loadingHistory: false } });
            break;
          // sidecar 那轮已经没了(重建 query / 打断兜底),但不会再有 result 来解锁 —— 手动放闸,
          // 否则 status 永远卡在运行中:打断点了没反应、待发队列也永远发不出去
          case "turn_ended":
            dispatch({ type: "patch", id: m.sessionId, patch: { status: "idle", bgWait: false, bgTasks: [] } });
            break;
          case "session_closed":
            dispatch({ type: "patch", id: m.sessionId, patch: { status: "closed" } });
            break;
        }
      };
    }
    connect();
    return () => { stop = true; wsRef.current?.close(); };
  }, []);

  // 只在 OPEN 时发。`?.` 只挡了 null:socket 还在 CONNECTING 时 send() 会抛
  // InvalidStateError("The object is in an invalid state."),冒到 React 里就是整屏错误页
  // (InfoPanel 挂载即调 requestGitInfo,重连窗口期一撞就炸)。发不出去就丢——
  // git_info/用量这类都是轮询,下一轮自己会补上。
  // 返回值 = 到底发出去没有:发消息/打断这种"一次性、丢了就没了"的调用必须看它,
  // 否则界面按发成功往下演(气泡贴上、转圈),而 sidecar 根本没收到。
  const send = (obj: any) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  };
  blobSend = send; // 给 fetchBlob 用(ImgTag 在 context 外调)

  // 依赖数组空的:下面这些方法只碰 send / dispatch / stateRef / 各 waiters ref / setDupAsk,全是稳定引用。
  // 身份一变就白拆 context 了(消费者照样每次重渲染),所以这里宁可 disable 掉 exhaustive-deps
  // 也不让 state 溜进依赖 —— 要读实时状态一律走 stateRef.current。
  const api = useMemo<Api>(() => ({
    dispatch,
    createSession(cwd, resume, title, inheritFrom, casual, model) {
      // resume = 要接续的 SDK 会话(恢复上下文);inheritFrom = 母会话条目 id(仅用于列表树形归属)
      const fire = () => send({ type: "create_session", cwd, resume, title, inheritFrom, casual, model });
      // 「开启子会话」(带 resume/inheritFrom)和闲聊(无目录)本就该新开,不拦;只拦"同目录再来一条平级新会话"
      const dup = cwd && !resume && !inheritFrom && !casual
        ? stateRef.current.index.filter((e) => e.cwd === cwd && !e.casual)
        : [];
      if (dup.length) { setDupAsk({ existing: dup[0], count: dup.length, proceed: fire }); return; }
      fire();
    },
    startSessionWithMessage(cwd, blocks) {
      const base = cwd.trim();
      pendingFirst.current = blocks;
      const model = stateRef.current.homeModel;
      api.createSession(base, null, undefined, null, !base, model && model !== "default" ? model : undefined); // 无目录 = 闲聊会话
    },
    requestHomeModels() { send({ type: "get_models", sessionId: HOME_MODELS_ID }); },
    setHomeModel(model) { dispatch({ type: "set_home_model", model }); },
    reopenSession(id) {
      const entry = stateRef.current.index.find((e) => e.id === id);
      if (!entry) return;
      // 前端已有该会话 timeline 时别再要 history:否则每次重新选中已打开的会话都会把整段历史再 append 一遍 → 满屏重复消息
      const haveHistory = !!stateRef.current.sessions[id];
      if (!haveHistory) {
        const sess = emptySession(id, entry.title, entry.cwd, entry.inheritFrom, entry.casual);
        if (entry.model) sess.info.model = entry.model; // 显示上次选的模型,不等 init
        // 有过历史(index 存了 lastUser)才标"加载中";全新空会话 timeline 本就该空,不显示 spinner
        if (entry.lastUser) sess.loadingHistory = true;
        dispatch({ type: "open", session: sess });
      } else {
        dispatch({ type: "activate", id });
      }
      send({ type: "reopen_session", sessionId: id, haveHistory });
    },
    // 首页「最近历史」点一条:sidecar 把条目搬回 index 后回 session_restored,那时再 reopen
    // (要等新 index 到了,reopenSession 才在 state.index 里找得到这条)
    restoreSession(id) {
      send({ type: "restore_session", sessionId: id });
    },
    restartSession(id) {
      send({ type: "restart_session", sessionId: id });
    },
    chooseResume(id, choice) {
      dispatch({ type: "patch", id, patch: { resumePrompt: null } });
      if (choice === "summary") dispatch({ type: "compact_start", id }); // 立刻给反馈,不等 SDK 的 status
      // 取消 = 只是不把历史当上下文发给模型(sidecar 侧 resume=undefined),前端历史照常留着给用户看
      send({ type: "reopen_session", sessionId: id, choice });
    },
    sendMessage(id, blocks, meta) {
      // 恢复选项菜单还开着就直接发消息 = 完整恢复:先补发 choice=full 让 sidecar 起会话,再发消息
      // (sidecar 按序处理 ws 消息,reopen 会同步 sessions.set,后到的 user_message 一定能命中)
      if (stateRef.current.sessions[id]?.resumePrompt) {
        dispatch({ type: "patch", id, patch: { resumePrompt: null } });
        send({ type: "reopen_session", sessionId: id, choice: "full" });
      }
      // 先发再记账。反过来(先贴气泡 + 置 running 再发)在断连时就是那个"卡住"的样子:
      // 消息静默丢了,界面却一直转圈,点打断也没人收 —— 只能重启 app 才解得开。
      if (!send({ type: "user_message", sessionId: id, content: blocks })) {
        dispatch({ type: "append", id, item: { kind: "system", text: i18n.t("⚠ 与后端断开,这条没发出去 —— 正在重连,请稍后重发"), ts: nextTs(id) } });
        return false;
      }
      // composerHtml/Imgs:仅前端留存,给"编辑"按钮完整还原图片/引用 chip(blocks 里引用已并进纯文本,不可逆)
      dispatch({ type: "append", id, item: { kind: "user", blocks, ts: nextTs(id), composerHtml: meta?.html, composerImgs: meta?.imgs } });
      dispatch({ type: "patch", id, patch: { status: "running" } });
      return true;
    },
    enqueuePending(id, item) {
      // 满没满在这里判(读实时 state),不让调用方拿渲染快照自己判 —— 快照过期时 reducer 会
      // 静默吞掉这条,而调用方已经清空了输入框,用户写的东西就凭空没了。
      if ((stateRef.current.sessions[id]?.pending?.length ?? 0) >= PENDING_MAX) return false;
      dispatch({ type: "enqueue_pending", id, item: { pid: String(nextTs(id)), ...item } });
      return true;
    },
    cancelPending(id, pid) {
      dispatch({ type: "remove_pending", id, pid });
    },
    respondPermission(id, requestId, behavior, message, remember) {
      // message:deny 时回给 agent 的文本(AskUserQuestion 用它把用户的选择传回)
      // remember:把当前授权对应的全部 suggestion 一次性回填给 SDK 落成规则
      dispatch({ type: "decide_permission", id, requestId, decision: behavior,
        answer: behavior === "deny" ? message : undefined, remembered: remember?.label });
      dispatch({ type: "patch", id, patch: { status: "running" } });
      send({ type: "permission_response", sessionId: id, requestId, behavior, message,
        updatedPermissions: remember?.updates });
      // 授权卡片里的 setMode 建议(如"本次会话自动接受所有文件编辑")是在 SDK 内部改模式的,
      // 它不回报,我们不记就永远不知道 —— 权限档位会一直显示旧档。跟着记一份,档位才推得准。
      const modeSug = remember?.updates.find((u) => u.type === "setMode");
      if (modeSug?.type === "setMode") {
        dispatch({ type: "set_perm_mode", id, mode: modeSug.mode as PermissionMode });
        send({ type: "set_perm_mode", sessionId: id, mode: modeSug.mode });
      }
    },
    setAutoAllow(id, on) {
      dispatch({ type: "set_auto_allow", id, on }); // 乐观更新;sidecar 会广播 auto_approve 回来对齐
      // 自动同意的执行下沉到 sidecar:开启后它对本会话所有授权请求直接放行(桌面/手机都不弹卡片),
      // 并把当下卡着的待授权一并放行 + 广播 permission_resolved 关掉各端卡片。
      send({ type: "set_auto_approve", sessionId: id, on });
    },
    // 档位只是"一次写两个旋钮"的快捷方式:各自仍走各自的正规入口,不另开一条状态。
    // 所以任何单独改动(比如授权卡片里点"本次会话自动接受所有文件编辑")照样能被推导成新档位或 custom。
    setPermissionPreset(id, key) {
      const preset = PERMISSION_PRESETS.find((p) => p.key === key);
      if (!preset) return; // custom 是推导态,不是可选项
      dispatch({ type: "set_auto_allow", id, on: preset.auto }); // 两处都乐观更新;sidecar 随后广播回来对齐
      dispatch({ type: "set_perm_mode", id, mode: preset.mode });
      send({ type: "set_auto_approve", sessionId: id, on: preset.auto });
      send({ type: "set_perm_mode", sessionId: id, mode: preset.mode });
    },
    // 轮次已经 idle、只是挂着退不出的后台任务时,SDK 那边没有正在跑的 query,interrupt 是空操作 ——
    // bgWait 闩锁就再也没人清了(它只由 result 清,而 result 不会再来)。所以本地必须同时放闸:
    // "打断"在这个态下的语义就是"不等这些后台任务了"。SDK 之后真报了新任务,电平会自己填回来。
    interrupt(id) {
      const sent = send({ type: "interrupt", sessionId: id });
      dispatch({ type: "patch", id, patch: { bgWait: false, bgTasks: [] } });
      // 断连时 sidecar 收不到,那"打断"就必须在本地兑现:否则按钮点下去毫无反应,
      // 而这个态恰恰是最容易点它的时候(界面转圈不动就是因为断了)。
      if (!sent) {
        dispatch({ type: "patch", id, patch: { status: "idle" } });
        dispatch({ type: "append", id, item: { kind: "system", text: i18n.t("⚠ 与后端断开,已就地停止 —— 正在重连,请稍后重发"), ts: nextTs(id) } });
      }
    },
    setModel(id, model, labelHint) {
      const sess = stateRef.current.sessions[id];
      const hit = sess?.models?.find((m) => m.value === model);
      const label = labelHint ?? (hit && sess ? modelName(sess.models, hit) : model);
      dispatch({ type: "append", id, item: { kind: "system", text: i18n.t("⚙ 模型已切换为 {{label}}", { label }), ts: Date.now() } });
      if (sess) dispatch({ type: "patch", id, patch: { info: { ...sess.info, model } } });
      send({ type: "set_model", sessionId: id, model });
      // 切到有订阅额度的 provider(Claude/Kimi):5h/周用量条这才显示,立刻探一次,别等下一轮广播才有数
      if (sess && ["claude", "kimi"].includes(sessionProvider({ ...sess, info: { ...sess.info, model } }))) send({ type: "usage_refresh" });
    },
    requestModels(id) { send({ type: "get_models", sessionId: id }); },
    clearContext(id) {
      saveCtx(id, { t: 0 }); // 上下文清空,缓存也归零,重开别回填旧值
      dispatch({ type: "clear_timeline", id }); // 清空可见对话,匹配 CLI /clear
      send({ type: "clear_context", sessionId: id });
    },
    runTerminal(id, command) {
      const cwd = stateRef.current.sessions[id]?.termCwd || stateRef.current.sessions[id]?.cwd || "";
      dispatch({ type: "terminal_start", id, command, cwd }); // 乐观回显,不等 sidecar
      // 分支图要在 commit/push/pull 期间点亮连线流光。命令从顶栏、分支面板、节点菜单三处发起,
      // 这里是唯一汇合点 —— 统一广播一次,免得每个入口各自设一遍状态(总有漏的)。
      window.dispatchEvent(new CustomEvent("cc-git-op", { detail: { id, command } }));
      send({ type: "terminal_command", sessionId: id, command });
    },
    sshReconnect(id) { send({ type: "ssh_reconnect", sessionId: id }); },
    sshClose(id) { send({ type: "ssh_close", sessionId: id }); },
    configureSsh(id, config) { send({ type: "ssh_configure", sessionId: id, ...config }); },
    searchMessages(query, sessionId, kind) { send({ type: "search_messages", query, sessionId, kind }); },
    requestAuthStatus() { send({ type: "auth_status" }); },
    syncUiLang(lang) { send({ type: "set_lang", lang }); }, // 语言切换后让 sidecar 同步出消息
    refreshUsage() { send({ type: "usage_refresh" }); },
    authAction(provider, action) { send({ type: "auth_action", provider, action }); },
    setProviderKey(provider, apiKey) { send({ type: "set_provider_key", provider, apiKey }); },
    setProviderConfig(provider, config) { send({ type: "set_provider_config", provider, config: config ?? {} }); },
    setCnEndpoint(on) { send({ type: "set_cn_endpoint", on }); },
    listSshHosts() { send({ type: "ssh_hosts" }); },
    saveSshHost(host) { send({ type: "ssh_host_save", host }); },
    deleteSshHost(id) { send({ type: "ssh_host_delete", id }); },
    // 测一次要三四秒,期间界面没任何反应 —— 挂个常驻 toast,收到结果时按 host id 精确收掉
    testSshHost(host) {
      if (host.id) {
        toast(i18n.t("正在测试…"), "info", `ssh-test:${host.id}`);
        // 兜底:ssh 那边最长 15s 就回包,但连接断了就永远回不来 —— 别让常驻 toast 挂死在屏上
        setTimeout(() => dismissToast(`ssh-test:${host.id}`), 20000);
      }
      send({ type: "ssh_host_test", host });
    },
    requestGitInfo(id) { send({ type: "git_info", sessionId: id }); },
    stopTask(id, taskId) { send({ type: "stop_task", sessionId: id, taskId }); },
    requestGitLog(id) { send({ type: "git_log", sessionId: id }); },
    requestGitDiff(id, from, to) { send({ type: "git_diff", sessionId: id, from, to }); },
    requestGitCommitDetail(id, hash) { send({ type: "git_commit_detail", sessionId: id, hash }); },
    requestGitFileDiff(id, from, to, file) { send({ type: "git_file_diff", sessionId: id, from, to, file }); },
    compareBranches(id, base, head) { send({ type: "git_compare", sessionId: id, base, head }); },
    suggestCommit(id, force) {
      return new Promise<string>((resolve, reject) => {
        commitWaiters.current.get(id)?.reject(new Error(i18n.t("已被新的请求取代"))); // 旧的未决请求作废
        commitWaiters.current.set(id, { resolve, reject });
        send({ type: "commit_suggest", sessionId: id, force: !!force });
      });
    },
    askBtw(id, text) {
      return new Promise<string>((resolve, reject) => {
        const rid = crypto.randomUUID();
        btwWaiters.current.set(rid, { resolve, reject });
        send({ type: "btw", sessionId: id, rid, text });
        // 兜底:sidecar 重启/断线时那条回包永远不来,气泡会一直转圈。到点作废,用户可重问。
        setTimeout(() => { if (btwWaiters.current.delete(rid)) reject(new Error(i18n.t("等待回答超时"))); }, 120000);
      });
    },
    deleteSession(id) {
      try { localStorage.removeItem(ctxKey(id)); } catch {} // 会话没了,缓存的上下文体积跟着走(id 不复用,留着永远读不到)
      dispatch({ type: "remove_session", id }); // 乐观移除,sidecar 再广播确认
      send({ type: "delete_session", sessionId: id });
    },
    renameSession(id, title) {
      dispatch({ type: "rename", id, title }); // 乐观改名,sidecar 落盘后再广播 index
      send({ type: "rename_session", sessionId: id, title });
    },
    moveSession(sessionId, groupId, beforeId) {
      dispatch({ type: "move_session", sessionId, groupId, beforeId }); // 乐观重排,sidecar 落盘后广播确认
      send({ type: "move_session", sessionId, groupId, beforeId });
    },
    createGroup(name) { send({ type: "create_group", name }); }, // 组的增删改直接以 sidecar 广播为准
    renameGroup(id, name) {
      dispatch({ type: "groups", groups: stateRef.current.groups.map((g) => g.id === id ? { ...g, name } : g) });
      send({ type: "rename_group", id, name });
    },
    deleteGroup(id) {
      dispatch({ type: "groups", groups: stateRef.current.groups.filter((g) => g.id !== id) });
      send({ type: "delete_group", id });
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps -- 见上:身份必须永远不变

  // 定时待发到点的那一刻没有任何 state 变化,下面的出队 effect 不会自己重跑 —— 有定时项时每 15s 打一拍。
  // 用 interval 而不是精确 setTimeout:睡一夜那种长定时会被后台节流/系统睡眠掐停,醒来根本不响;
  // interval 在唤醒后立刻补一拍,最多晚一拍就发出去。
  const [timedTick, setTimedTick] = useState(0);
  const hasTimedPending = Object.values(state.sessions).some((s) => s.pending?.some((p) => p.at));
  useEffect(() => {
    if (!hasTimedPending) return;
    const iv = setInterval(() => setTimedTick((n) => n + 1), 15_000);
    return () => clearInterval(iv);
  }, [hasTimedPending]);

  // 待发队列自动出队:某会话变空闲(agent 完成上一轮)、没有后台任务、且上一轮已彻底了结(含后台续跑)时,发出队首。
  // bgWait = 上一轮还挂着后台任务,轮次未完全了结 —— 不能放队列出去,否则会在后台任务续跑前把下一条消息切进来。
  // 压缩上下文期间 status 也是 idle,同样要按住:压到一半插进新一轮,压缩就白做了。
  // sendMessage 会把 status 立即置回 running,所以本 effect 不会对同一会话重复触发。
  useEffect(() => {
    for (const s of Object.values(state.sessions)) {
      const compacting = s.timeline.some((t) => t.kind === "compact" && t.running);
      // 断连时不出队:sendMessage 会失败,而这条已经从队列里摘掉了 —— 用户排的消息就凭空没了。
      if (state.connected && s.status === "idle" && !s.bgWait && !compacting && (s.bgTasks?.length ?? 0) === 0 && s.pending && s.pending.length > 0) {
        // 定时消息没到点就跳过它,取后面第一条到点的 —— 否则一条约在凌晨的消息会把整条队列堵到凌晨
        const next = s.pending.find((p) => !p.at || p.at <= Date.now());
        if (!next) continue;
        dispatch({ type: "remove_pending", id: s.id, pid: next.pid });
        api.sendMessage(s.id, next.blocks, { html: next.html, imgs: next.imgs });
        // 排队发出的 /compact 也要起进度条:它同时是"这轮到底压没压成"的判据 —— 没有这条,
        // result 上的 compact_settle 找不到进行中的压缩,既不报"被并入了正在跑的那一轮",也不会自动重发。
        if (next.blocks.length === 1 && next.blocks[0]?.type === "text" && next.blocks[0].text === "/compact")
          dispatch({ type: "compact_start", id: s.id });
      }
    }
  }, [state.sessions, state.connected, timedTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // 把本机待发队列镜像广播给别端(手机/另一台电脑)只读显示。本机队列是纯前端 pending,
  // 不进 sidecar,不广播的话别端根本不知道 —— 就是「手机看不到 PC 排队」那个问题。
  // 放这个 effect 里而不是逐个 enqueue/cancel/出队点手动发:pending 变化的入口太多(入队、取消、
  // 自动出队、断线重连后重建),一处监听全覆盖。空快照只在「刚从非空清空」时补一次,让对端清掉那栏;
  // 平时(一直空)不发,免得每次 state 刷新给每个会话刷一串空包。
  const peerSentSig = useRef(new Map<string, string>());
  useEffect(() => {
    for (const s of Object.values(state.sessions)) {
      const items = (s.pending ?? []).map((p) => ({ pid: p.pid, text: p.text }));
      const sig = JSON.stringify(items);
      const prev = peerSentSig.current.get(s.id);
      if (sig === prev) continue;                       // 内容没变,别重发
      if (items.length === 0 && prev === undefined) continue; // 从没发过又是空的:跳过,不刷空包
      peerSentSig.current.set(s.id, sig);
      send({ type: "peer_pending", sessionId: s.id, items });
    }
  }, [state.sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // bgWait 闩锁兜底。闩锁只由「后台任务续跑的 result」清,可后台任务退出后 SDK 不一定再起一轮 ——
  // 那条 result 永远不来,闩锁就把待发队列锁死:界面上 status 是 idle、后台任务条也没了(bgTasks 已被
  // 空电平清空),用户看着完全空闲,发出去的每条消息却都进排队区,只能手点「不等了」才解得开。
  // 空闲 + 无后台任务连续 20 秒就认定续跑不会来了,自己放闸(真有续跑时它的第一条 assistant 就把
  // status 打回 running,计时器随即被下面的 else 撤掉)。
  // 计时器按会话存在 ref 里,不用 effect 的 cleanup 重建:state.sessions 会被别的会话的流式刷新
  // 带着变,cleanup 版每次刷新都重置计时,20 秒永远等不到。
  const bgWaitTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = bgWaitTimers.current;
    for (const s of Object.values(state.sessions)) {
      const stuck = !!s.bgWait && s.status === "idle" && (s.bgTasks?.length ?? 0) === 0;
      if (stuck && !timers.has(s.id)) {
        timers.set(s.id, window.setTimeout(() => {
          timers.delete(s.id);
          const cur = stateRef.current.sessions[s.id];
          if (cur?.bgWait && cur.status === "idle" && (cur.bgTasks?.length ?? 0) === 0) {
            // 走到这儿说明续跑轮确实不会来了 —— 那"轮次完成"就是此刻。
            // 上面 result 那次因为挂着后台任务把 ✅ 和提醒压住了(见 hasBg),欠的这一次在这里补,
            // 否则这种会话永远不点亮、也永远不响,用户以为还在跑。
            // 能走到 stuck 就一定欠着:用户中断(aborted)那条路会当场清掉 bgWait,压根进不来。
            dispatch({ type: "patch", id: s.id, patch: { bgWait: false, freshDone: true } });
            notify(i18n.t("任务完成"), i18n.t("后台任务已结束"));
            alertUser();
          }
        }, 20_000));
      } else if (!stuck && timers.has(s.id)) {
        clearTimeout(timers.get(s.id)); timers.delete(s.id);
      }
    }
    for (const id of [...timers.keys()]) // 会话被删/关掉,计时器一起收
      if (!state.sessions[id]) { clearTimeout(timers.get(id)); timers.delete(id); }
  }, [state.sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // 打开该目录已有的会话(而不是再建一条同名的)。空态输入框暂存的首条消息一并送进去。
  const openExisting = (id: string) => {
    setDupAsk(null);
    if (stateRef.current.sessions[id]) dispatch({ type: "activate", id });
    else api.reopenSession(id);
    const blocks = pendingFirst.current;
    pendingFirst.current = null;
    if (blocks) api.sendMessage(id, blocks);
  };

  // ApiCtx 在外、StateCtx 在内:api 的 value 永不变,state 变时 React 只需要重跑内层那个 Provider。
  return <ApiCtx.Provider value={api}><StateCtx.Provider value={state}>
    {children}
    {dupAsk && <ConfirmDialog
      title={i18n.t("该目录已有 {{count}} 个会话", { count: dupAsk.count })}
      body={<>{i18n.t("「{{title}}」", { title: dupAsk.existing.title })}{dupAsk.existing.lastUser ? <>{i18n.t("·最近：{{text}}", { text: dupAsk.existing.lastUser.slice(0, 40) })}</> : null}<br />
        {i18n.t("新建会话标题同样取目录名,建出来两条重名、上下文各自独立。")}</>}
      cancelLabel={i18n.t("打开已有")} confirmLabel={i18n.t("仍要新建")} danger={false}
      onCancel={() => openExisting(dupAsk.existing.id)}
      onConfirm={() => { setDupAsk(null); dupAsk.proceed(); }} />}
  </StateCtx.Provider></ApiCtx.Provider>;
}

export { emptySession };
