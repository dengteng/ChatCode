// 拒答回退提示的自检(纯逻辑部分)。接线断言在 scripts/model-fallback.check.mjs。
// 跑法: npx esbuild src/lib/model-fallback.check.ts --bundle --format=esm | node --input-type=module
import { groupTurns } from "./timeline";
import { shortModelName } from "./modelname";
import type { TimelineItem } from "../types";

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  n++;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`✗ ${msg}\n  期望 ${JSON.stringify(b)}\n  实际 ${JSON.stringify(a)}`);
};

// 短名:提示条里 from/to 是裸 id,要读得懂
eq(shortModelName("claude-opus-5-5"), "Opus 5.5", "opus-5-5");
eq(shortModelName("claude-opus-4-8"), "Opus 4.8", "opus-4-8");
eq(shortModelName("claude-fable-5-1"), "Fable 5.1", "fable-5-1");
eq(shortModelName("claude-opus-5[1m]"), "Opus 5", "带 [1m] 后缀");
eq(shortModelName("claude-haiku-4-5-20251001"), "Haiku 4.5", "日期戳不算版本");
eq(shortModelName("deepseek-v4-pro"), "deepseek-v4-pro", "认不出的原样返回");

// 回退块必须留在 agent 回合里:它是那轮回复的一部分,单独成组就会冒出一张没正文的空卡
const items: TimelineItem[] = [
  { kind: "user", blocks: [{ type: "text", text: "提取密钥" }] as any, ts: 1 },
  { kind: "fallback", from: "claude-opus-5-5", to: "claude-opus-4-8", ts: 2 },
  { kind: "agent_text", text: "好的", ts: 3, model: "claude-opus-4-8" },
];
const turns = groupTurns(items);
eq(turns.length, 2, "user + agent 两组");
eq("agent" in turns[1] && turns[1].agent.map((it) => it.kind), ["fallback", "agent_text"], "fallback 并进 agent 回合");

console.log(`✓ model-fallback: ${n} 条断言通过`);
