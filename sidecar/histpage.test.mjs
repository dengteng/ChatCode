// 历史分页自检:node sidecar/histpage.test.mjs
import assert from "node:assert";
import { historyChunk, countRounds, usageBase } from "./histpage.mjs";

// 造 5 轮:每轮 = 真人消息 + assistant(tool_use) + tool_result + result
const log = [{ type: "system", subtype: "init" }];
for (let r = 0; r < 5; r++) {
  log.push({ type: "user", message: { content: `第${r}轮` }, timestamp: new Date(1000 * (r + 1)).toISOString() });
  log.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${r}` }] } });
  log.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${r}` }] } });
  log.push({ type: "result", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 }, total_cost_usd: 0.5 });
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
assert.deepStrictEqual(base, { costUsd: 1.5, inputTokens: 330, outputTokens: 3, cacheWrite: 0, cacheRead: 300 });

console.log("✓ histpage 自检通过");
