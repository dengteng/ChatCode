// 桌面端历史分页。以前重开会话把整份日志(大会话 40MB+)一次发给前端:sidecar 序列化 + 发送要 6 秒,
// 前端解析 + 回放再卡主线程 2 秒,这期间输入框点不动。前端本来就只渲染最近几十轮,
// 所以改成先发最近 HIST_ROUNDS 轮,往上翻 / 搜索跳转到更早的消息时再按需要一段(history_older)。
//
// 「一轮」从一条真人消息起算(tool_result 也是 type:user,不算)。切点永远落在真人消息上,
// 这样 tool_use 和它的 tool_result 一定在同一段里,前端分段回放配得上对。
// 下标是对「已过滤日志」(isCaptionEcho 剔掉之后)的下标;日志只追加不改写,早先的下标一直有效。
import { isBlobRef, isInlineImg } from "./blobs.mjs";

export const HIST_ROUNDS = 40;

const isPrompt = (m) => m?.type === "user"
  && !(Array.isArray(m.message?.content) && m.message.content.some((b) => b?.type === "tool_result"));

/** [0, end) 里有几轮(前端「还有 N 轮」用) */
export function countRounds(log, end) {
  let n = 0;
  for (let i = 0; i < end; i++) if (isPrompt(log[i])) n++;
  return n;
}

/**
 * 从 before 往前取一段:至少 rounds 轮;给了 untilTs(毫秒)就一直往前取到那一刻所在的轮为止
 * (搜索结果跳转:一次拿够,不用一页页往回翻)。返回 { messages, before: 这段的起点, more: 更早还剩几轮 }。
 */
export function historyChunk(log, before, rounds = HIST_ROUNDS, untilTs) {
  before = Math.max(0, Math.min(before, log.length));
  let start = 0, n = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (!isPrompt(log[i])) continue;
    n++;
    const ts = +new Date(log[i].timestamp || 0);
    // 时间戳缺失(NaN)按「已经够早」处理,别因为一条坏数据一路翻到头
    const reached = !untilTs || !(ts > untilTs);
    if (n >= rounds && reached) { start = i; break; }
  }
  return { messages: log.slice(start, before), before: start, more: start > 0 ? countRounds(log, start) : 0 };
}

// ---------- 手机端历史:按「气泡」切 ----------
// 手机一条消息 = 一个气泡:user 一泡;连续的 assistant 归为一个 agent 泡(工具/思考收进该泡的"工作过程")。
// 口径必须跟手机 extractLines(tt-center mobile/src/protocol.ts)一致:这边多算一个手机不显示的泡,
// 手机拿到的就比要的少,会误判「日志到头了」—— 压缩过的会话里接续摘要、/compact 的
// <local-command-*> 回显都是 user 消息,以前被算成泡,手机翻到压缩点就提示「没有更早的消息了」。
const COMPACT_SUMMARY = "This session is being continued from a previous conversation";
const LOCAL_CMD = /^<local-command-[\w-]+>/;
const userText = (c) => (typeof c === "string" ? c : c.filter((b) => b?.type === "text").map((b) => b.text || "").join(""));
const hiddenUser = (c) => {
  const t = userText(c).trimStart();
  return t.startsWith(COMPACT_SUMMARY) || LOCAL_CMD.test(t);
};

/** 该消息属于 'user' / 'agent'(含工具/note) / null(不显示) */
export function bubbleRole(m) {
  if (!m) return null;
  if (m.type === "user") {
    const c = m.message?.content;
    if (typeof c === "string") return c && !hiddenUser(c) ? "user" : null;
    if (Array.isArray(c)) {
      const hasBubble = c.some((b) => b?.type === "text" || isInlineImg(b) || isBlobRef(b));
      return hasBubble && !hiddenUser(c) ? "user" : null; // 纯 tool_result 的 user 消息不成泡
    }
    return null;
  }
  if (m.type === "assistant") {
    const c = m.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "text" || b?.type === "tool_use")) return "agent";
    return null;
  }
  if (m.type === "result" && m.subtype && m.subtype !== "success") return "agent";
  if (m.type === "system_note" || m.type === "session_error") return "agent";
  return null;
}

/** 最近 limit 个气泡的原始消息,more = 更早还有没有。手机按 more 决定还往不往前翻 */
export function mobileBubbles(log, limit) {
  const bubbles = []; // { kind, msgs:[] }
  for (const m of log) {
    const role = bubbleRole(m);
    if (!role) continue; // tool_result / system / rate_limit 等不成泡,直接丢
    if (role === "user") { bubbles.push({ kind: "user", msgs: [m] }); continue; }
    let last = bubbles[bubbles.length - 1];
    if (!last || last.kind !== "agent") { last = { kind: "agent", msgs: [] }; bubbles.push(last); }
    last.msgs.push(m);
  }
  return { messages: bubbles.slice(-limit).flatMap((b) => b.msgs), more: bubbles.length > limit };
}

/**
 * [0, end) 这段没发给前端的用量合计。口径和前端 handleSdkMessage 处理 result 时一致
 * (含缓存的输入、跳过全 0 的静默回合),否则会话右下角的 token 总数会随分页变小。
 */
export function usageBase(log, end) {
  const b = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, workMs: 0 };
  for (let i = 0; i < end; i++) {
    const m = log[i];
    if (m?.type !== "result") continue;
    const u = m.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const outTok = u.output_tokens ?? 0;
    if (inTok === 0 && outTok === 0 && !m.aborted && !m.is_error) continue;
    b.costUsd += m.total_cost_usd ?? 0;
    b.inputTokens += inTok;
    b.outputTokens += outTok;
    b.cacheWrite += u.cache_creation_input_tokens ?? 0;
    b.cacheRead += u.cache_read_input_tokens ?? 0;
    b.workMs += m.duration_ms ?? 0;
  }
  return b;
}
