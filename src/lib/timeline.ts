// 时间线派生:一条会话的 timeline 数组 → 界面要的各种视图(回合分组、活流、结算、待办、
// 记忆引用、后台任务、下一步建议…)。全是纯函数,不碰 React、不碰 DOM。
//
// 从 Chat.tsx 搬出来的,原因不是那个文件太长,是这些函数在里面没法真测 ——
// 只能靠 scripts/*.check.mjs 拿正则去扫源码,或者在脚本里复刻一份跑(两份会漂)。
// 搬到 lib/ 之后直接 import 就能断言,和 memtext.ts / gitcmd.ts 一个待遇。
//
// 要翻译的几个函数一律收 t 参数,不在这里 import i18n:那样自检 bundle 会把整个 i18next
// 拖进来,还得在 node 里把它初始化起来才能跑。
import type { TimelineItem } from "../types";
import { cleanMemory, stripLineNums } from "./memtext";

type T = (key: string, params?: any) => string;

// 用户在授权/提问卡上花的"等选择"时间:卡片出现(ts)→ 作答(decidedTs)。还没答的按到 now 计(正在等)。
// 这段是等人做决定、agent 空转,不该算进本轮耗时,统一从耗时里扣掉。
export function permWaitMs(items: TimelineItem[], now: number): number {
  let w = 0;
  for (const it of items) {
    if (it.kind !== "permission") continue;
    if (it.decidedTs) w += Math.max(0, it.decidedTs - it.ts);
    else if (!it.decision) w += Math.max(0, now - it.ts); // 还挂着 = 此刻仍在等
  }
  return w;
}

// 本轮"落空"检测:agent 发起过写文件工具(Edit/Write/…),但全部回了 is_error →
// 改动多半没落地,却因为轮次整体仍标"成功"而不显眼(agent 常以为改了就往下走)。
// 只在"发起过且全失败"时提示,避免误报;部分成功不算落空。
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export function failedEdits(items: TimelineItem[]) {
  let total = 0, failed = 0;
  for (const it of items) {
    if (it.kind !== "tool" || !EDIT_TOOLS.has(it.name || "") || it.result === undefined) continue;
    total++;
    if (it.isError) failed++;
  }
  return { failed, allFailed: total > 0 && failed === total };
}

// 后台任务检测:Bash(run_in_background) 和异步子 agent 都是"发起完本轮就结束、任务跑完 SDK 才回来续跑",
// 于是气泡结算了、状态回 idle,但这条消息其实还会有下文。
// 不看 input.run_in_background —— 子 agent 默认就是后台,那个字段常常压根不在 input 里。
// 看工具自己回的固定标记最准:Bash 回 "Command running in background with ID: xxx",
// 子 agent 回 "Async agent launched successfully ... agentId: xxx"。
// 必须带真正的启动标记才算 —— 光看裸 "agentId:" 会误命中 agent 正文/报告里提到该词的工具结果
// (分析类会话尤其常见),塞进一个永不被消费的假 id,提示就永远挂着。
// shell 任务顺带给出输出文件路径(边跑边追加,是唯一能看到的真实进度);子 agent 只给 agentId。
const BG_START = /running in background with ID:\s*([\w-]+)\.\s*Output is being written to:\s*(\S+?)\.?(?=\s|$)|Async agent launched[\s\S]*?agentId:\s*([\w-]+)/g;
export type BgTask = { id: string; kind: "shell" | "agent"; title: string; body: string; out?: string; ts?: number };
export function pendingBgTasks(items: TimelineItem[], t: T): BgTask[] {
  const found: BgTask[] = [];
  const done = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    if (it.isError || it.result === undefined) continue; // 被拦下/报错的读取不算了结(它压根没跑)
    // 本轮内又去读/停过它(Read tasks/<id>.output、TaskOutput、TaskStop…),说明已经了结,不算悬着
    const inp = JSON.stringify(it.input ?? "");
    for (const task of found) if (inp.includes(task.id)) done.add(task.id);
    const res = typeof it.result === "string" ? it.result : JSON.stringify(it.result);
    const cmd = String(it.input?.command ?? "");
    // ts = 启动它的那次工具调用的时间,给 bar 上的"已跑 Xmin"当起点(后台任务本身不回时间)
    for (const m of res.matchAll(BG_START)) found.push(m[1]
      ? { id: m[1], kind: "shell", title: String(it.input?.description || cmd.split("\n")[0] || t("后台命令")), body: cmd, out: m[2], ts: it.ts }
      : { id: m[3], kind: "agent", title: String(it.input?.description || it.input?.subagent_type || t("子 agent")), body: String(it.input?.prompt ?? ""), ts: it.ts });
  }
  return found.filter((task) => !done.has(task.id));
}

// 本轮用到的 skill / MCP。running = 工具还没回结果,界面上那枚标签要转圈。
export function usedSkillsMcp(items: TimelineItem[]) {
  const skills = new Set<string>(), mcps = new Set<string>();
  const activeSkills = new Set<string>(), activeMcps = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const n = it.name || "";
    const running = it.result === undefined; // 工具还没回结果 = 正在跑
    if (n === "Skill" || n === "SlashCommand") {
      const s = (it.input?.skill ?? it.input?.command ?? it.input?.name);
      if (s) { const name = String(s).replace(/^\//, "").split(/\s+/)[0]; skills.add(name); if (running) activeSkills.add(name); }
    } else if (n.startsWith("mcp__")) {
      const server = n.split("__")[1];
      if (server) { mcps.add(server); if (running) activeMcps.add(server); }
    }
  }
  return { skills: [...skills], mcps: [...mcps], activeSkills, activeMcps };
}

// 记忆引用:agent 用 Read 读了 ~/.claude/projects/<项目>/memory/ 下的某条记忆文件 = 在本轮回复里"引用"了它。
// MEMORY.md 是索引(每次都会翻),不算引用某条具体记忆,排除掉。
const MEMORY_FILE_RE = /\/memory\/([^/]+\.md)$/i;
export function memoryFileOf(path: unknown): string | null {
  if (typeof path !== "string" || !path.includes(".claude")) return null;
  const m = MEMORY_FILE_RE.exec(path);
  if (!m || /^MEMORY\.md$/i.test(m[1])) return null;
  return m[1];
}
// 工具结果内容可能是字符串、{text}、或 [{type:"text",text}] 数组,统一抽成纯文本。
export function toolResultText(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("");
  if (typeof result === "object") return result.text ?? "";
  return String(result);
}
export type MemAction = "read" | "write" | "edit";
export interface MemRef { file: string; title: string; body: string; action: MemAction }
// 一轮里对记忆文件的所有动作:Read=引用,Write/Edit=更新。同一文件按"更新 > 引用"合并(既读又写算更新)。
export function usedMemories(items: TimelineItem[]): MemRef[] {
  const map = new Map<string, MemRef>();
  const rank: Record<MemAction, number> = { read: 0, write: 1, edit: 1 };
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const action: MemAction | null = it.name === "Read" ? "read"
      : it.name === "Write" ? "write"
      : it.name === "Edit" || it.name === "MultiEdit" ? "edit" : null;
    if (!action) continue;
    const file = memoryFileOf(it.input?.file_path);
    if (!file) continue;
    const raw = action === "read" ? stripLineNums(toolResultText(it.result)).trim()
      : action === "write" ? String(it.input?.content ?? "").trim() : ""; // edit 拿不到全文,留空,点开去编辑器看
    const { title, body } = cleanMemory(raw, file); // 剥 system-reminder + frontmatter,顺带取标题

    const prev = map.get(file);
    if (!prev || rank[action] >= rank[prev.action]) {
      map.set(file, { file, title: title || prev?.title || file, body: body || prev?.body || "", action });
    }
  }
  return [...map.values()];
}

// 一整回合的正文:和气泡里 segments 的取法一致(正文常被工具调用切成好几段 agent_text)
export const turnText = (items: TimelineItem[]) =>
  items.filter((it) => it.kind === "agent_text" && it.text.trim()).map((it) => (it as any).text.trim()).join("\n\n");

// 「本轮小结」那行是给 commit 弹窗汇总用的(sidecar 从会话日志里读),对用户是噪音 —— 渲染时抹掉。
// 只改渲染用的字符串,timeline 里的 text 原样保留:sidecar 的汇总照常工作,前端去重也不受影响。
export const SUMMARY_LINE_RE = /^[\s>*#`\-]*本轮小结\**\s*[：:]/;
export const stripSummary = (text: string) => text.split("\n").filter((l) => !SUMMARY_LINE_RE.test(l)).join("\n").trim();
// 复制/贴回输入框用的正文:和屏幕上看到的一致(同样抹掉小结行)。
// turnText 本身不能动 —— nextSteps 要从原文里认「本轮建议」那行,跨轮摘要也用它。
export const turnCopyText = (items: TimelineItem[]) => stripSummary(turnText(items));

// agent 按系统提示(sidecar 的 NEXT_STEPS_INSTRUCTION)在回复末尾留的一行「本轮建议：A | B」。
// 这行照常显示在正文里,这里只是把它再解析成一排可点的快捷指令 —— 不改 timeline 里的 text,
// 免得撞上 agent_text_dedup 按 text 全等回查那套去重(改了文本气泡会出现两遍)。
// 标签两侧各留一处 `\**`:`**本轮建议**：A | B` 这种(强调只包标签、冒号在外)也要认,
// 少认这一种整排快捷指令就不出来。与 sidecar 的 SUMMARY_RE 同一套写法。
const NEXT_RE = /^[\s>*#`\-]*本轮建议\**\s*[：:]\**\s*(.+?)\s*\**$/;
export function nextSteps(items: TimelineItem[]): string[] {
  const lines = turnText(items).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(NEXT_RE);
    if (m) return m[1].split(/[|｜]/).map((s) => s.replace(/[*`]/g, "").trim()).filter(Boolean).slice(0, 3);
  }
  return [];
}

// 把线性时间线按"用户消息"切成回合:每条用户消息独立成组,其后到下一条用户消息之间的
// 所有 agent 动作(请求执行、回复、结果…)归到一个 agent 组,渲染时包进一个气泡。
export type Turn = { user: TimelineItem } | { agent: TimelineItem[] } | { solo: TimelineItem };
export function groupTurns(items: TimelineItem[]): Turn[] {
  const groups: Turn[] = [];
  // agent 的当前回合:只有新的用户消息才算结束。中间插进来的终端命令(commit/push)、系统提示
  // 单独成组显示,但不能把这一轮切成两半 —— 切了的话,正在跑的那组就不再是"最后一组",
  // 气泡从"进行中"掉成一张还没内容的完成卡(看着像消息消失了),等 agent 再出声才另起一张。
  let open: Extract<Turn, { agent: TimelineItem[] }> | null = null;
  for (const item of items) {
    if (item.kind === "user") { groups.push({ user: item }); open = null; continue; }
    // 终端命令(InfoPanel git 按钮 / ! shell)是用户主动跑的,系统提示(清空上下文/切模型/git 对比)、
    // 压缩上下文(/compact)也都不是 agent 的"回复",各自独立成组;否则会被并进 agent 卡里 ——
    // 看不见正文,副标题还误显示"正在思考…"(卡片只认 agent 动作)。compact 自带进度/结果卡,单独渲染。
    if (item.kind === "terminal" || item.kind === "system" || item.kind === "compact") { groups.push({ solo: item }); continue; }
    if (open) { open.agent.push(item); continue; }
    // 落单的 result(压缩、控制指令等静默轮次结束时也会发一条,前面没有任何 agent 动作)不能自成一张卡:
    // 那样会渲染出一张空的"Claude 的回复 / 正在思考…"僵尸气泡,永远停在那。丢掉即可,它本就没有正文可展示。
    if (item.kind === "result") continue;
    open = { agent: [item] };
    groups.push(open);
  }
  return groups;
}

// 把一回合内所有 SDK result 聚合成单条结算:总时长(prompt 到收尾的墙上时间)+ 累计 token。
// 全 0 token 且非中断/报错 = 静默回合(压缩、控制指令等),返回 null 让调用方不渲染。
export function aggregateRound(items: TimelineItem[], startTs: number): (TimelineItem & { kind: "result" }) | null {
  const results = items.filter((it): it is TimelineItem & { kind: "result" } => it.kind === "result");
  if (!results.length) return null;
  const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, cache_read_output_tokens: 0, cache_creation_output_tokens: 0 };
  let costUsd = 0, aborted = false, isError = false;
  for (const r of results) {
    const u = r.usage || {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_output_tokens += u.cache_read_output_tokens ?? 0;
    usage.cache_creation_output_tokens += u.cache_creation_output_tokens ?? 0;
    costUsd += r.costUsd ?? 0;
    if (r.aborted) aborted = true;
    if (r.isError) isError = true;
  }
  const totalIn = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (totalIn + usage.output_tokens === 0 && !aborted && !isError) return null;
  const lastTs = results[results.length - 1].ts;
  // 墙上时间(prompt 到收尾)对实时会话准;回放历史时全部 ts 都是回放瞬间,差值≈0,
  // 退回累加各 result 的 duration_ms(日志里保留了真实耗时)。取两者较大即可两头兼容。
  const wall = startTs ? Math.max(0, lastTs - startTs) : 0;
  const sumDur = results.reduce((a, r) => a + (r.durationMs || 0), 0);
  const waitMs = permWaitMs(items, lastTs); // 扣掉等用户选择/授权的空等时间
  const durationMs = Math.max(0, Math.max(wall, sumDur) - waitMs);
  return { kind: "result", costUsd, durationMs, usage, isError, aborted, ts: lastTs };
}

// 工具入参压成一行给界面显示(命令、文件路径、搜索式、URL,都没有就空着)。
export function summarizeInput(name: string, input: any): string {
  if (!input) return "";
  if (name === "Bash") return input.command ?? "";
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  return "";
}

const TODO_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]; // todo 系记账工具,不算"在干活"
const shortPath = (p?: string) => (p || "").replace(/^\/Users\/[^/]+/, "~");

// 右栏活流:把本回合的正文 + 每个工具动作的完整内容(命令 + 输出、改了哪些代码的增删行)按时间顺序
// 抹平成带样式的多行日志。最新活动从底部冒出、把旧行往上挤;尾部封顶防长会话 DOM 爆炸,max-height 再裁一层。
export type FeedLine = { t: string; c?: string }; // c: head/add/del/out/cmd → 上色
export function workFeed(items: TimelineItem[], t: T): FeedLine[] {
  const out: FeedLine[] = [];
  // 单块正文按行拆。先按尾部截一刀再拆:整份 out 最后也只留 slice(-200),
  // 而浏览器测试的一条 take_snapshot 结果能有 5 万字符,整份拆成行等于每次都白造上千个字符串再扔掉。
  const body = (s: any): string[] => {
    const str = String(s ?? "").replace(/\s+$/, "");
    // 多截一点(200 行 × 保守 200 字符)再按行切,切完丢掉可能被拦腰截断的首行
    const cut = str.length > 40_000 ? str.slice(-40_000).split("\n").slice(1) : str.split("\n");
    return cut.length > 200 ? cut.slice(-200) : cut;
  };
  for (const it of items) {
    if (it.kind === "agent_text" && it.text?.trim()) {
      for (const l of it.text.trim().split("\n")) { if (!SUMMARY_LINE_RE.test(l)) out.push({ t: l }); }
    } else if (it.kind === "tool" && !TODO_TOOLS.includes(it.name)) {
      const run = it.result === undefined, pre = run ? "▶ " : "";
      const file = it.input?.file_path, inp = it.input ?? {};
      if (it.name === "Edit" && inp.old_string != null) {
        out.push({ t: `${pre}Edit ${shortPath(file)}`, c: "head" });
        for (const l of body(inp.old_string)) out.push({ t: `- ${l}`, c: "del" });
        for (const l of body(inp.new_string)) out.push({ t: `+ ${l}`, c: "add" });
      } else if (it.name === "Write" && inp.content != null) {
        out.push({ t: `${pre}Write ${shortPath(file)}`, c: "head" });
        for (const l of body(inp.content)) out.push({ t: `+ ${l}`, c: "add" });
      } else if (it.name === "Read") {
        const n = typeof it.result === "string" ? it.result.split("\n").length : 0;
        out.push({ t: `${pre}Read ${shortPath(file)}${n ? ` · ${t("{{n}} 行", { n })}` : ""}`, c: "head" });
      } else {
        const name = it.name === "Task" ? t("子 agent") : it.name;
        const detail = summarizeInput(it.name, it.input);
        const cmd = detail.split("\n");
        out.push({ t: `${pre}${name}${cmd[0] ? " " + cmd[0] : ""}`, c: "head" });
        for (const l of cmd.slice(1)) out.push({ t: l, c: "cmd" }); // 多行命令的后续行
        if (typeof it.result === "string" && it.result.trim()) for (const l of body(it.result)) out.push({ t: l, c: "out" });
      }
    } else if (it.kind === "terminal") {
      out.push({ t: `$ ${it.command}`, c: "head" });
      if (it.output.trim()) for (const l of body(it.output)) out.push({ t: l, c: "out" });
    }
  }
  return out.slice(-200); // 尾部封顶
}

// 阶段清单:重放本回合的 TodoWrite / TaskCreate / TaskUpdate,得到最新任务快照。
// TodoWrite 的 input.todos 是整份快照,直接覆盖;TaskCreate/Update 增量重放(SDK 的 taskId 从 1 起顺序分配)。
export type TodoRow = { content: string; status: string };
export function latestTodos(items: TimelineItem[], t: T): TodoRow[] {
  let todos: TodoRow[] = [];
  const idToIdx = new Map<string, number>();
  let seq = 0;
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const input = it.input ?? {};
    if (it.name === "TodoWrite" && Array.isArray(input.todos)) {
      todos = input.todos.map((x: any) => ({ content: String(x.content ?? ""), status: String(x.status ?? "pending") }));
      idToIdx.clear(); seq = 0;
    } else if (it.name === "TaskCreate") {
      todos.push({ content: String(input.subject ?? input.description ?? "").trim() || t("任务"), status: String(input.status ?? "pending") });
      idToIdx.set(String(input.taskId ?? ++seq), todos.length - 1);
    } else if (it.name === "TaskUpdate" && input.taskId != null) {
      const idx = idToIdx.get(String(input.taskId));
      if (idx !== undefined && todos[idx]) {
        if (input.status) todos[idx].status = String(input.status);
        const c = String(input.subject ?? "").trim();
        if (c) todos[idx].content = c;
      }
    }
  }
  return todos;
}
