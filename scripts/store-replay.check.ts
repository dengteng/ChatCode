// 自检:历史回放走 batch(replayBatch)和逐条 reducer,结果必须一模一样。
// 跑法: npx tsx scripts/store-replay.check.ts [会话日志.jsonl](默认用内置的小样本)
import fs from "node:fs";
const g = globalThis as any;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window ??= g;
g.navigator ??= { language: "zh-CN" };
Date.now = () => 1_790_000_000_000; // 压缩卡片等的 ts 取自 reducer 运行时的 Date.now(),两遍跑的时刻不同,固定住才能逐字比
const { __test: T } = await import("../src/store");

const file = process.argv[2];
const msgs: any[] = file
  ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [
      { type: "user", message: { role: "user", content: "干活" }, timestamp: "2026-10-03T00:00:00Z" },
      { type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "text", text: "先看看" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] } },
      { type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "x", is_error: true }] } },
      { type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "text", text: "好了" }] } },
      { type: "result", subtype: "success", duration_ms: 5, total_cost_usd: 0, usage: {} },
    ];
const ID = "s";
const base = { ...T.initial, sessions: { [ID]: T.emptySession(ID, "t", "/tmp") }, activeId: ID };
const acts: any[] = [];
for (const m of msgs) T.handleSdkMessage((a: any) => acts.push(a), ID, m, false);

let t0 = performance.now();
let seq = base;
if (acts.length < 60000 && !process.env.SKIP_SEQ) for (const a of acts) seq = T.reducer(seq, a);
const seqMs = performance.now() - t0;
t0 = performance.now();
const bat = T.reducer(base, { type: "batch", id: ID, actions: acts });
const batMs = performance.now() - t0;

const a = JSON.stringify(seq.sessions[ID]), b = JSON.stringify(bat.sessions[ID]);
if (a !== b) {
  const sa = seq.sessions[ID] as any, sb = bat.sessions[ID] as any;
  for (const k of Object.keys({ ...sa, ...sb })) if (JSON.stringify(sa[k]) !== JSON.stringify(sb[k])) {
    if (k === "timeline") { const i = sa.timeline.findIndex((x: any, j: number) => JSON.stringify(x) !== JSON.stringify(sb.timeline[j])); console.error(`  timeline 长度 ${sa.timeline.length}/${sb.timeline.length},第 ${i} 条:\n  逐条 ${JSON.stringify(sa.timeline[i])?.slice(0, 300)}\n  batch ${JSON.stringify(sb.timeline[i])?.slice(0, 300)}`); }
    else console.error(`  字段 ${k}: ${JSON.stringify(sa[k])?.slice(0, 200)} vs ${JSON.stringify(sb[k])?.slice(0, 200)}`);
  }
  console.error("✗ batch 和逐条结果不一致"); process.exit(1);
}
console.log(`✓ batch 与逐条一致(${acts.length} 个 action,timeline ${bat.sessions[ID].timeline.length} 条)· 逐条 ${Math.round(seqMs)}ms → batch ${Math.round(batMs)}ms`);
