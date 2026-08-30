// 会话日志里 tool_result 的落盘上限。
//
// 为什么要截:实测一条会话日志 97MB,其中 72MB 是 tool_result 正文(5000 条,单条最大 0.68MB)——
// 整份文件、整段 grep 输出原样躺在里面。而它在界面上只是一块 <pre>:当轮看两眼,之后再没人翻。
// 代价却是重开会话要读盘 + JSON.parse + 走 WebSocket + 前端再 parse 这么大一坨。
//
// 截的是**日志**,不是 agent 的上下文:agent 的记忆在 CLI 自己的 transcript 里,resume 照旧完整。
export const LOG_TEXT_CAP = 8000;

export const capText = (s) =>
  s.length <= LOG_TEXT_CAP ? s
    : `${s.slice(0, LOG_TEXT_CAP)}\n…(日志已截断 ${s.length - LOG_TEXT_CAP} 字符;完整输出只在当轮实时可见)`;

// tool_result 的 content 有两种形状:纯字符串,或 [{type:"text"|"image"}]。图片块不碰(另有 blob 外置)。
export function capToolResults(msg) {
  const c = msg?.message?.content;
  if (!Array.isArray(c) || !c.some((b) => b?.type === "tool_result")) return msg;
  const out = c.map((b) =>
    b?.type !== "tool_result" ? b
      : typeof b.content === "string" ? { ...b, content: capText(b.content) }
      : Array.isArray(b.content) ? { ...b, content: b.content.map((x) => (x?.type === "text" ? { ...x, text: capText(x.text ?? "") } : x)) }
      : b);
  return { ...msg, message: { ...msg.message, content: out } };
}
