// 自检:任务跑着的时候 askSideQuestion 到底能不能插进去。
// 这是整个「btw 顺便问问」的地基 —— 若它要等本轮跑完才回,这功能就等于没做。
// 跑法:node sidecar/btw.e2e.mjs   (要能连上模型,约 30s)
import assert from "node:assert";
import { query } from "@anthropic-ai/claude-agent-sdk";

const queue = (async function* () {
  yield { type: "user", message: { role: "user", content: "Run the bash command `sleep 12` and then reply DONE." }, parent_tool_use_id: null, session_id: "probe" };
  await new Promise(() => {}); // 不结束队列,模拟常驻会话
})();

const q = query({ prompt: queue, options: { permissionMode: "bypassPermissions", cwd: process.cwd() } });

assert.strictEqual(typeof q.askSideQuestion, "function", "SDK 没有 askSideQuestion —— 这版 SDK 不支持侧问");

let running = false, sideAt = 0, turnEndAt = 0;
const loop = (async () => {
  for await (const m of q) {
    if (m.type === "assistant") running = true;
    if (m.type === "result") { turnEndAt = Date.now(); break; }
  }
})();

// 等到本轮确实在跑(agent 已开始动作),再插侧问
while (!running) await new Promise((r) => setTimeout(r, 300));
await new Promise((r) => setTimeout(r, 1500)); // 让它进到 sleep 里

const t0 = Date.now();
const r = await q.askSideQuestion("Reply with exactly the word PONG and nothing else.");
sideAt = Date.now();
console.log(`侧问耗时 ${sideAt - t0}ms,回答:`, JSON.stringify(r?.response));
assert.ok(r?.response, "侧问没有回答");
assert.strictEqual(turnEndAt, 0, "侧问是等本轮跑完才回的 —— 没有真正并发,功能不成立");

await loop;
console.log(`本轮在侧问之后 ${turnEndAt - sideAt}ms 才结束 —— 并发成立`);
await q.interrupt?.().catch(() => {});
console.log("OK 跑着的时候能顺便问");
process.exit(0);
