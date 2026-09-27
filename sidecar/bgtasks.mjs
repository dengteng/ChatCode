// 后台任务详情追踪:给手机端的「后台任务」入口用。
//
// 桌面端不需要这个 —— 它有完整时间线,自己从 tool_result 里抠标题/命令/输出路径
// (src/lib/timeline.ts liveBgTasks),输出靠 Tauri read_file 直接读本地文件。
// 手机两样都没有:它的历史是 buildMobileHistory 瘦身过的(tool_result 丢了、tool_use 的
// input 清空了),中途打开会话也收不到早先那条 background_tasks_changed,更读不了 Mac 上的文件。
// 所以由 sidecar 在消息流经时把每个任务的详情记下来,手机要时整份发过去,输出按 taskId 代读。
//
// 「哪些任务还在跑」仍以 SDK 的 background_tasks_changed 为准(sess.bgTasks),
// 这里只负责补详情;电平里有、详情里没有的也照列一条占位,宁可朴素不能漏。
import { openSync, readSync, fstatSync, closeSync } from "fs";

// 与 src/lib/timeline.ts 的 BG_START 保持一致(那边的注释解释了三种启动写法)
const BG_START = /(?:running in background with ID:\s*|moved to the background \(ID:\s*)([\w-]+)\)?\.\s*Output is being written to:\s*(\S+?)\.?(?=\s|$)|Async agent launched[\s\S]*?agentId:\s*([\w-]+)/g;
const MAX_TOOL_INPUTS = 300; // 只为反查「哪次工具调用起的这个任务」,留最近这些就够

const resultText = (c) =>
  typeof c === "string" ? c
    : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : "")).join("\n")
      : "";

export function createBgTracker(now = () => Date.now()) {
  const meta = new Map();       // task_id -> { id, kind, title, body, out?, startedAt, summary?, lastTool? }
  const toolInputs = new Map(); // tool_use_id -> { input, ts }

  const merge = (id, patch) => {
    const cur = meta.get(id) ?? { id, kind: "shell", title: "", body: "", startedAt: now() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== "") cur[k] = v;
    meta.set(id, cur);
    return true;
  };

  /** 看一条 SDK 消息。返回 true = 某个任务的详情变了(调用方据此决定要不要重发给手机)。 */
  function observe(msg) {
    if (!msg || typeof msg !== "object") return false;
    let changed = false;
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b?.type !== "tool_use" || !b.id) continue;
        toolInputs.set(b.id, { input: b.input ?? {}, ts: now() });
        if (toolInputs.size > MAX_TOOL_INPUTS) toolInputs.delete(toolInputs.keys().next().value);
      }
    } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b?.type !== "tool_result" || b.is_error) continue;
        const call = toolInputs.get(b.tool_use_id);
        const input = call?.input ?? {};
        for (const m of resultText(b.content).matchAll(BG_START)) {
          const cmd = String(input.command ?? "");
          changed = m[1]
            ? merge(m[1], { kind: "shell", title: String(input.description || cmd.split("\n")[0] || "后台命令"), body: cmd, out: m[2], startedAt: call?.ts })
            : merge(m[3], { kind: "agent", title: String(input.description || input.subagent_type || "子 agent"), body: String(input.prompt ?? ""), startedAt: call?.ts });
        }
      }
    } else if (msg.type === "system" && msg.task_id) {
      const id = String(msg.task_id);
      if (msg.subtype === "task_started") {
        const agent = !!msg.subagent_type || /agent/i.test(msg.task_type ?? "");
        // 只补空缺:tool_result 那边拿到的命令/输出路径更全,别被这里覆盖
        const cur = meta.get(id);
        changed = merge(id, {
          ...(cur ? {} : { kind: agent ? "agent" : "shell" }),
          title: cur?.title ? undefined : msg.description,
          body: cur?.body ? undefined : msg.prompt,
        });
      } else if (msg.subtype === "task_progress") {
        changed = merge(id, { summary: msg.summary, lastTool: msg.last_tool_name });
      } else if (msg.subtype === "task_notification") {
        changed = merge(id, { summary: msg.summary, status: msg.status });
      }
    }
    return changed;
  }

  /** 电平(sess.bgTasks,SDK 原样)配上详情,按电平的顺序。 */
  function list(live) {
    return (live ?? []).map((t) => {
      const id = String(t.task_id);
      const m = meta.get(id);
      if (m) return { ...m, title: m.title || t.description || "后台任务" };
      return { id, kind: /agent/i.test(t.task_type ?? "") ? "agent" : "shell", title: t.description || t.task_type || "后台任务", body: "", startedAt: null };
    });
  }

  /** 读某个任务输出的末尾。路径只从自己记的详情里取 —— 不接受客户端传路径,否则就是任意读文件。 */
  function tail(id, maxBytes = 64 * 1024) {
    const m = meta.get(String(id));
    if (!m) return { error: "没有这个任务的记录" };
    if (!m.out) return { text: m.summary || "", size: 0, noFile: true };
    let fd;
    try {
      fd = openSync(m.out, "r");
      const size = fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      let text = buf.toString("utf8");
      if (len < size) text = text.slice(text.indexOf("\n") + 1); // 截在半行/半个汉字上,丢掉这不完整的第一行
      return { text, size, truncated: len < size };
    } catch (e) {
      return { error: e.code === "ENOENT" ? "输出文件还没生成或已被清理" : e.message };
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  }

  return { observe, list, tail, clear: () => { meta.clear(); toolInputs.clear(); } };
}
