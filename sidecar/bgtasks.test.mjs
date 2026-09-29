// node sidecar/bgtasks.test.mjs
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgTracker } from "./bgtasks.mjs";

const dir = mkdtempSync(join(tmpdir(), "bgt-"));
const out = join(dir, "b1.output");
const toolUse = (id, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
const toolResult = (id, content, extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });

// shell:从 tool_result 抠出 id 和输出路径,命令/标题按 tool_use_id 反查
{
  const t = createBgTracker(() => 1000);
  t.observe(toolUse("tu1", { command: "npm run build\n--verbose", description: "构建" }));
  assert.equal(t.observe(toolResult("tu1", `Command running in background with ID: b1. Output is being written to: ${out}`)), true);
  const [x] = t.list([{ task_id: "b1", task_type: "local_bash", description: "npm run build" }]);
  assert.deepEqual(x, { id: "b1", kind: "shell", title: "构建", body: "npm run build\n--verbose", out, startedAt: 1000 });
}

// 前台超时转后台的写法、content 是块数组的写法都要认
{
  const t = createBgTracker();
  t.observe(toolUse("tu2", { command: "sleep 999" }));
  t.observe(toolResult("tu2", [{ type: "text", text: `Command was moved to the background (ID: b2). Output is being written to: ${out}.` }]));
  const [x] = t.list([{ task_id: "b2" }]);
  assert.equal(x.out, out, "末尾的句号不能算进路径");
  assert.equal(x.title, "sleep 999", "没 description 用命令首行");
}

// Workflow:标题取启动回执里的 Summary
{
  const t = createBgTracker();
  t.observe(toolResult("tu9", "Workflow launched in background. Task ID: w1\nSummary: 电视品牌技术目录\nTranscript dir: /tmp/wf"));
  const [x] = t.list([{ task_id: "w1", task_type: "local_workflow" }]);
  assert.deepEqual([x.kind, x.title], ["workflow", "电视品牌技术目录"]);
}

// 子 agent:标题取 description,正文是 prompt;task_progress/notification 补摘要
{
  const t = createBgTracker();
  t.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu3", name: "Agent", input: { description: "查资料", prompt: "去查 X", subagent_type: "general" } }] } });
  t.observe(toolResult("tu3", "Async agent launched successfully.\nagentId: a9 (internal ID)"));
  t.observe({ type: "system", subtype: "task_progress", task_id: "a9", summary: "读了 3 个文件", last_tool_name: "Read" });
  const [x] = t.list([{ task_id: "a9", task_type: "local_agent" }]);
  assert.equal(x.kind, "agent");
  assert.equal(x.title, "查资料");
  assert.equal(x.body, "去查 X");
  assert.equal(x.summary, "读了 3 个文件");
  assert.deepEqual(t.tail("a9"), { text: "读了 3 个文件", size: 0, noFile: true }, "子 agent 没输出文件,给摘要");
}

// task_started 只补空缺,不盖掉 tool_result 那边拿到的更全的标题
{
  const t = createBgTracker();
  t.observe(toolUse("tu4", { command: "make", description: "编译" }));
  t.observe(toolResult("tu4", `Command running in background with ID: b4. Output is being written to: ${out}`));
  t.observe({ type: "system", subtype: "task_started", task_id: "b4", description: "make", task_type: "local_bash" });
  assert.equal(t.list([{ task_id: "b4" }])[0].title, "编译");
  // 反过来:先 task_started(还没 tool_result)也能先有个标题
  t.observe({ type: "system", subtype: "task_started", task_id: "a5", description: "跑测试", subagent_type: "x" });
  assert.equal(t.list([{ task_id: "a5" }])[0].kind, "agent");
  assert.equal(t.list([{ task_id: "a5" }])[0].title, "跑测试");
}

// 电平里有、详情里没有:照列占位,不能漏
{
  const t = createBgTracker();
  const [x] = t.list([{ task_id: "zz", task_type: "local_agent", description: "神秘任务" }]);
  assert.equal(x.id, "zz"); assert.equal(x.kind, "agent"); assert.equal(x.title, "神秘任务");
}

// 报错的 tool_result 不算启动;普通正文里提到 agentId 也不算
{
  const t = createBgTracker();
  t.observe(toolUse("tu6", { command: "x" }));
  assert.equal(t.observe(toolResult("tu6", `Command running in background with ID: b6. Output is being written to: ${out}`, { is_error: true })), false);
  assert.equal(t.observe(toolResult("tu6", "报告里写着 agentId: foo")), false);
  assert.equal(t.tail("b6").error, "没有这个任务的记录");
}

// tail:只读末尾,截断时丢掉不完整的第一行;路径只从记录里来
{
  writeFileSync(out, "第一行\n" + "x".repeat(50) + "\n最后一行\n");
  const t = createBgTracker();
  t.observe(toolUse("tu7", { command: "x" }));
  t.observe(toolResult("tu7", `Command running in background with ID: b7. Output is being written to: ${out}`));
  assert.equal(t.tail("b7").text, "第一行\n" + "x".repeat(50) + "\n最后一行\n");
  const r = t.tail("b7", 20);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "最后一行\n");
  const t2 = createBgTracker();
  t2.observe(toolUse("tu8", { command: "x" }));
  t2.observe(toolResult("tu8", `Command running in background with ID: b8. Output is being written to: ${join(dir, "nope")}`));
  assert.match(t2.tail("b8").error, /还没生成/);
}

console.log("ok");
