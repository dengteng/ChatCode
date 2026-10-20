// 历史分页自检:node sidecar/histpage.test.mjs
import assert from "node:assert";
import { historyChunk, countRounds, usageBase, mobileBubbles } from "./histpage.mjs";

// 造 5 轮:每轮 = 真人消息 + assistant(tool_use) + tool_result + result
const log = [{ type: "system", subtype: "init" }];
for (let r = 0; r < 5; r++) {
  log.push({ type: "user", message: { content: `第${r}轮` }, timestamp: new Date(1000 * (r + 1)).toISOString() });
  log.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${r}` }] } });
  log.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${r}` }] } });
  log.push({ type: "result", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 }, total_cost_usd: 0.5, duration_ms: 2000 });
}
log.push({ type: "result", usage: { input_tokens: 0, output_tokens: 0 } }); // 静默回合,不计

assert.strictEqual(countRounds(log, log.length), 5);

// 最近 2 轮:切点落在第 3 轮的真人消息上,tool_use / tool_result 不被切开
const a = historyChunk(log, log.length, 2);
assert.strictEqual(a.messages[0].message.content, "第3轮");
assert.strictEqual(a.more, 3);
assert.ok(a.messages.some((m) => m.message?.content?.[0]?.tool_use_id === "t4"), "最后一轮的 tool_result 在段内");

// 接着往前要 2 轮
const b = historyChunk(log, a.before, 2);
assert.strictEqual(b.messages[0].message.content, "第1轮");
assert.strictEqual(b.messages.at(-1), log[a.before - 1], "两段首尾相接,不重不漏");
assert.strictEqual(b.more, 1);

// 再要:取到头,连开头的 init 也带上,more = 0
const c = historyChunk(log, b.before, 2);
assert.strictEqual(c.before, 0);
assert.strictEqual(c.more, 0);
assert.strictEqual(c.messages[0].subtype, "init");

// 搜索跳转:要 1 轮但目标在第 1 轮(ts=2000),一次取到那一轮
const d = historyChunk(log, log.length, 1, 2000);
assert.strictEqual(d.messages[0].message.content, "第1轮");

// 用量底数:前 3 轮(切点前)= 3 × (110 入 / 1 出 / 0.5 刀),静默回合不算
const base = usageBase(log, a.before);
assert.deepStrictEqual(base, { costUsd: 1.5, inputTokens: 330, outputTokens: 3, cacheWrite: 0, cacheRead: 300, workMs: 6000 });

// 手机气泡:压缩接续摘要、/compact 回显手机不显示,也不能算泡 —— 否则手机拿到的比要的少,
// 误判「到头了」,压缩点之前的消息翻不出来
{
  const u = (content) => ({ type: "user", message: { content } });
  const a = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const mlog = [
    u("最早的问题"), a("最早的回答"),
    u("第二个问题"), a("第二个回答"),
    u([{ type: "text", text: "<local-command-caveat>Caveat…</local-command-caveat>" }]),
    u("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"),
    u("<local-command-stdout>Compacted </local-command-stdout>"),
    u([{ type: "text", text: "This session is being continued from a previous conversation that ran out of context." }]),
    a("接着干"),
    u("压缩后的问题"), a("压缩后的回答"),
  ];
  // 泡:问1 答1 问2 答2 /compact 接着干 问3 答3 = 8 个(/compact 命令本身手机显示成「/compact」,算泡)
  const r = mobileBubbles(mlog, 4);
  assert.deepStrictEqual(r.messages.map((m) => m.message.content[0]?.text ?? m.message.content).slice(-2), ["压缩后的问题", "压缩后的回答"]);
  assert.strictEqual(r.more, true);
  assert.ok(!r.messages.some((m) => JSON.stringify(m).includes("local-command") || JSON.stringify(m).includes("being continued")));
  assert.strictEqual(mobileBubbles(mlog, 8).more, false);
  assert.strictEqual(mobileBubbles(mlog, 7).more, true);
  assert.strictEqual(mobileBubbles(mlog, 8).messages[0].message.content, "最早的问题");
}

console.log("✓ histpage 自检通过");
