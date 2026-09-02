// 自检:! 命令跑着时要边跑边回 terminal_chunk(气泡里实时显示日志),
// 且尾巴上那段 \0PWD\0退出码 不能漏进流里。
// 跑法: node sidecar/term-stream.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-termstream-"));
const SID = "s1", DATA = path.join(tmp, "data"), PORT = 18977;
const cwd = path.join(tmp, "repo");
fs.mkdirSync(cwd);
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{ id: SID, cwd }]));

// 第一段输出后睡 1s:结果回包必须在 1s 后,而 chunk 得在此之前就到 —— 这正是"实时"要证明的
const COMMAND = `echo first; sleep 1; echo second >&2`;

const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
setTimeout(() => { console.error("超时:sidecar 没回包"); done(1); }, 20000);

const chunks = [];
const tryConnect = (n = 0) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "terminal_command", sessionId: SID, command: COMMAND })));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "terminal_chunk") chunks.push(m);
    if (m.type !== "terminal_result") return;
    try {
      assert.ok(chunks.length > 0, "一条 terminal_chunk 都没收到 —— 输出没在跑的过程中推出来");
      assert.ok(chunks.every((c) => c.command === COMMAND && c.sessionId === SID), "chunk 的 command/sessionId 对不上,前端认不出该往哪条追加");
      const streamed = chunks.map((c) => c.text).join("");
      assert.match(streamed, /first/, "第一段输出没进流");
      assert.doesNotMatch(streamed, /\0/, "内部分隔符漏进了流");
      assert.doesNotMatch(streamed, new RegExp(fs.realpathSync(cwd)), "尾巴上的 $PWD 漏进了流");
      assert.strictEqual(m.exitCode, 0);
      console.log(`PASS: 收到 ${chunks.length} 条 chunk,共 ${streamed.length} 字符`);
    } catch (e) { console.error(`FAIL: ${e.message}\n实际 chunk:`, JSON.stringify(chunks)); done(1); }
    done(0);
  });
};
tryConnect();
