// lib/timeline.ts 的自检。跑法(零新依赖,同 memtext.check.ts):
//   npx esbuild src/lib/timeline.check.ts --bundle --format=esm | node --input-type=module
//
// 这些函数以前埋在 Chat.tsx 里,只能靠 scripts/*.check.mjs 拿正则扫源码 —— 那种断言锁的是
// "代码长什么样",改个变量名就红,真算错了反倒不吭声。搬到 lib/ 就是为了换成下面这种真调用。
import {
  aggregateRound, failedEdits, groupTurns, latestTodos, nextSteps, pendingBgTasks, permWaitMs,
  turnCopyText, usedMemories, usedSkillsMcp, workFeed,
} from "./timeline";
import type { TimelineItem } from "../types";

let n = 0;
const ok = (cond: boolean, name: string) => {
  if (!cond) throw new Error(`✗ ${name}`);
  n++;
};
const eq = (got: unknown, want: unknown, name: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`✗ ${name}\n  got : ${g}\n  want: ${w}`);
  n++;
};
// 造 timeline 条目。字段随 kind 变,这里不较真类型,只要跑起来的形状对。
const it = (o: any): TimelineItem => ({ ts: 0, ...o }) as TimelineItem;
const t = ((k: string, p?: any) => (p ? `${k}:${JSON.stringify(p)}` : k)) as any;

// ---------- groupTurns:回合切分 ----------
{
  const groups = groupTurns([
    it({ kind: "user", text: "a" }),
    it({ kind: "tool", name: "Bash" }),
    it({ kind: "terminal", command: "git status", output: "" }), // 用户自己跑的命令:独立成组
    it({ kind: "agent_text", text: "接着说" }),                   // 但不能因此把这轮切成两半
    it({ kind: "result" }),
  ]);
  eq(groups.map((g) => Object.keys(g)[0]), ["user", "agent", "solo"], "终端命令独立成组,且不切断 agent 回合");
  eq((groups[1] as any).agent.length, 3, "终端之后的 agent 动作要回到同一回合(含 result)");

  // 落单 result:前面没有任何 agent 动作(压缩、控制指令的静默轮次)。自成一组会渲染出空僵尸气泡。
  eq(groupTurns([it({ kind: "user" }), it({ kind: "result" })]).length, 1, "落单 result 要丢掉,不能自成一张卡");
  // 新的用户消息才关掉上一回合
  const two = groupTurns([it({ kind: "user" }), it({ kind: "agent_text", text: "x" }), it({ kind: "user" }), it({ kind: "agent_text", text: "y" })]);
  eq(two.length, 4, "第二条用户消息要另起一回合");
}

// ---------- permWaitMs / aggregateRound:耗时要扣掉等人的时间 ----------
{
  const items = [
    it({ kind: "permission", ts: 1000, decidedTs: 4000, decision: "allow" }), // 等了 3s
    it({ kind: "result", ts: 10_000, durationMs: 0, usage: { output_tokens: 5 } }),
  ];
  eq(permWaitMs(items, 10_000), 3000, "已作答的授权:算 ts → decidedTs");
  eq(permWaitMs([it({ kind: "permission", ts: 1000 })], 6000), 5000, "还挂着的授权:算到此刻");
  eq(permWaitMs([it({ kind: "permission", ts: 1000, decision: "allow" })], 6000), 0, "已决定但没记 decidedTs 的不算等待");

  const r = aggregateRound(items, 1000)!; // 回合从 1000 开始,到最后一条 result 的 10000
  eq(r.durationMs, 6000, "墙上时间 9s 扣掉 3s 等人 = 6s");
  eq(aggregateRound(items, 0)!.durationMs, 0, "startTs 缺省(0)时墙上时间不算,只剩 sumDur");

  // 回放历史:所有 ts 都是回放那一瞬,墙上时间≈0,要退回累加各 result 自带的 durationMs
  const replay = aggregateRound([
    it({ kind: "result", ts: 500, durationMs: 1200, usage: { output_tokens: 1 } }),
    it({ kind: "result", ts: 500, durationMs: 800, usage: { output_tokens: 1 } }),
  ], 500)!;
  eq(replay.durationMs, 2000, "墙上时间为 0 时退回累加 durationMs");
  eq(replay.usage.output_tokens, 2, "一回合多条 result 的 token 要累加");

  // 全 0 token 且没中断没报错 = 静默轮次(压缩/控制指令),不该渲染结算行
  eq(aggregateRound([it({ kind: "result", ts: 1, usage: {} })], 0), null, "静默轮次返回 null");
  ok(aggregateRound([it({ kind: "result", ts: 1, usage: {}, aborted: true })], 0) !== null, "中断的轮次即使 0 token 也要显示");
  eq(aggregateRound([it({ kind: "agent_text", text: "x" })], 0), null, "没有 result 就没有结算");
}

// ---------- failedEdits:只有"发起过且全失败"才算落空 ----------
{
  const edit = (isError: boolean) => it({ kind: "tool", name: "Edit", result: "r", isError });
  eq(failedEdits([edit(true), edit(true)]), { failed: 2, allFailed: true }, "全失败 = 落空");
  eq(failedEdits([edit(true), edit(false)]), { failed: 1, allFailed: false }, "部分成功不算落空");
  eq(failedEdits([]), { failed: 0, allFailed: false }, "没发起过写文件工具,别误报");
  eq(failedEdits([it({ kind: "tool", name: "Edit" })]), { failed: 0, allFailed: false }, "还没回结果的不算");
}

// ---------- pendingBgTasks:认启动标记,别认正文里提到的词 ----------
{
  const launch = it({
    kind: "tool", name: "Bash", ts: 7, input: { description: "跑构建" },
    result: "Command running in background with ID: abc123. Output is being written to: /tmp/x.log",
  });
  const tasks = pendingBgTasks([launch], t);
  eq(tasks.length, 1, "shell 后台任务要认出来");
  eq([tasks[0].id, tasks[0].kind, tasks[0].out, tasks[0].ts], ["abc123", "shell", "/tmp/x.log", 7], "id / 类型 / 输出文件 / 起点都要带上");

  // 本轮里又去读过它 → 已了结,不该继续悬着
  const readBack = it({ kind: "tool", name: "Read", input: { file_path: "/tmp/tasks/abc123.output" }, result: "…" });
  eq(pendingBgTasks([launch, readBack], t).length, 0, "本轮又读过它就算了结");

  // 光提到 agentId 不算:分析类会话的工具结果里常出现这个词
  eq(pendingBgTasks([it({ kind: "tool", name: "Bash", result: "日志里写着 agentId: fake999,仅供参考" })], t).length, 0,
    "没有启动标记的裸 agentId 不能算后台任务(否则提示永远挂着)");
  eq(pendingBgTasks([it({ kind: "tool", name: "Bash", result: "Async agent launched successfully\nagentId: zz9" })], t)[0].kind, "agent",
    "子 agent 的启动标记要认");
  eq(pendingBgTasks([it({ kind: "tool", name: "Bash", isError: true, result: "Command running in background with ID: e1. Output is being written to: /tmp/e.log" })], t).length, 0,
    "报错的工具压根没跑起来");
}

// ---------- nextSteps:末尾那行「本轮建议」 ----------
{
  const say = (text: string) => [it({ kind: "agent_text", text })];
  eq(nextSteps(say("正文\n本轮建议：提交并推送 | 加个测试")), ["提交并推送", "加个测试"], "半角竖线分隔");
  eq(nextSteps(say("**本轮建议**：甲｜乙")), ["甲", "乙"], "强调只包标签、全角竖线也要认");
  eq(nextSteps(say("本轮建议：1 | 2 | 3 | 4")), ["1", "2", "3"], "最多留 3 条");
  eq(nextSteps(say("本轮建议：早的\n后面还有话\n本轮建议：晚的")), ["晚的"], "从后往前找,取最后一行");
  eq(nextSteps(say("没有建议行")), [], "没有就空数组");
}

// ---------- turnCopyText:复制时抹掉「本轮小结」那行 ----------
{
  eq(turnCopyText([it({ kind: "agent_text", text: "正文\n本轮小结：做了 X" })]), "正文", "小结行是给 commit 汇总用的,复制时要抹掉");
  eq(turnCopyText([it({ kind: "agent_text", text: "一段" }), it({ kind: "agent_text", text: "二段" })]), "一段\n\n二段", "一回合多段正文按序拼接");
}

// ---------- usedMemories:MEMORY.md 是索引,不算引用 ----------
{
  const read = (p: string, body = "---\nname: x\n---\n正文") => it({ kind: "tool", name: "Read", input: { file_path: p }, result: body });
  eq(usedMemories([read("/Users/me/.claude/projects/p/memory/a.md")]).length, 1, "读记忆文件 = 引用");
  eq(usedMemories([read("/Users/me/.claude/projects/p/memory/MEMORY.md")]).length, 0, "MEMORY.md 是索引,每次都翻,不算引用某条");
  eq(usedMemories([read("/tmp/memory/a.md")]).length, 0, "不在 .claude 下的不算");
  // 同一文件既读又写 = 更新(rank: write/edit > read)
  const both = usedMemories([
    read("/Users/me/.claude/projects/p/memory/a.md"),
    it({ kind: "tool", name: "Write", input: { file_path: "/Users/me/.claude/projects/p/memory/a.md", content: "新正文" } }),
  ]);
  eq([both.length, both[0].action], [1, "write"], "既读又写按更新算,且只留一条");
}

// ---------- usedSkillsMcp:没回结果的要标成"正在跑" ----------
{
  const r = usedSkillsMcp([
    it({ kind: "tool", name: "Skill", input: { skill: "ponytail" }, result: "done" }),
    it({ kind: "tool", name: "SlashCommand", input: { command: "/code-review 高" } }), // 还没回结果
    it({ kind: "tool", name: "mcp__pencil__open_document", result: "ok" }),
  ]);
  eq(r.skills, ["ponytail", "code-review"], "斜杠和参数都要剥掉,只留名字");
  eq([...r.activeSkills], ["code-review"], "没回结果的才算正在跑");
  eq(r.mcps, ["pencil"], "mcp__<server>__<tool> 取中间那段");
}

// ---------- latestTodos:TodoWrite 覆盖,Task* 增量 ----------
{
  eq(latestTodos([
    it({ kind: "tool", name: "TodoWrite", input: { todos: [{ content: "旧", status: "completed" }] } }),
    it({ kind: "tool", name: "TodoWrite", input: { todos: [{ content: "新", status: "pending" }] } }),
  ], t), [{ content: "新", status: "pending" }], "TodoWrite 是整份快照,直接覆盖");

  eq(latestTodos([
    it({ kind: "tool", name: "TaskCreate", input: { taskId: "1", subject: "甲" } }),
    it({ kind: "tool", name: "TaskCreate", input: { taskId: "2", subject: "乙" } }),
    it({ kind: "tool", name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } }),
  ], t), [{ content: "甲", status: "pending" }, { content: "乙", status: "in_progress" }], "Task* 按 taskId 增量重放");

  // taskId 缺省时按出现顺序从 1 起补号(SDK 就是这么分配的)
  eq(latestTodos([
    it({ kind: "tool", name: "TaskCreate", input: { subject: "甲" } }),
    it({ kind: "tool", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }),
  ], t)[0].status, "completed", "没给 taskId 时按顺序补号");
}

// ---------- workFeed:活流封顶 + 抹小结行 ----------
{
  const long = Array.from({ length: 300 }, (_, i) => `行${i}`).join("\n");
  eq(workFeed([it({ kind: "agent_text", text: long })], t).length, 200, "尾部封顶 200 行,防长会话 DOM 爆炸");
  eq(workFeed([it({ kind: "agent_text", text: "正文\n本轮小结：X" })], t), [{ t: "正文" }], "活流里也不显示小结行");
  eq(workFeed([it({ kind: "tool", name: "TodoWrite", input: { todos: [] } })], t), [], "todo 系记账工具不算'在干活'");
  const edit = workFeed([it({ kind: "tool", name: "Edit", result: "ok", input: { file_path: "/Users/me/p/a.ts", old_string: "旧", new_string: "新" } })], t);
  eq(edit, [{ t: "Edit ~/p/a.ts", c: "head" }, { t: "- 旧", c: "del" }, { t: "+ 新", c: "add" }], "Edit 展开成增删行,home 目录缩成 ~");
  eq(workFeed([it({ kind: "tool", name: "Bash", input: { command: "ls" } })], t)[0].t, "▶ Bash ls", "还没回结果的动作带 ▶");
}

console.log(`✓ timeline 自检通过(${n} 条)`);
