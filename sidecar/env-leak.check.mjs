// 子进程环境清洗自检(自带 sidecar,直接跑):
//   node sidecar/env-leak.check.mjs
//
// 验的是 `!` 终端命令看不到本进程的敏感环境变量。最要紧的是 CHAT_CODE_TOKEN:
// 它是 ws 握手令牌,一旦被命令输出带进聊天记录,浏览器里任意网页就能连上这个固定的
// loopback 端口发 terminal_command。PATH 一并验,防止清洗把正常变量也一起削没。
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const PORT = 8900 + Math.floor(Math.random() * 90); // 避开开发 8975 / 打包 8976,也避开并行跑的自己
const TOKEN = "leaktest-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-envleak-"));
// 逐个变量查,别 grep 整个 env(值里可能带换行);未设置就打印 none
const PROBE = 'printf "TOKEN=%s KEY=%s PATH=%s\\n" "${CHAT_CODE_TOKEN:-none}" "${DT_NOTIFY_KEY:-none}" "${PATH:+set}"';

const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
  env: { ...process.env, CHAT_CODE_TOKEN: TOKEN, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA,
         DT_NOTIFY_KEY: "leaktest-key", DT_NOTIFY_URL: "" },
  stdio: "ignore",
});
const bye = (msg, code) => {
  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(msg);
  process.exit(code);
};
setTimeout(() => bye("✗ 超时", 1), 30000);

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => ws.send(JSON.stringify({ type: "terminal_command", sessionId: "envleak-check", command: PROBE })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "terminal_result") return;
    const out = (m.output || "").trim();
    console.log("命令输出:", out);
    if (/TOKEN=(?!none)/.test(out)) bye("✗ CHAT_CODE_TOKEN 漏进了子进程", 1);
    if (/KEY=(?!none)/.test(out)) bye("✗ DT_NOTIFY_KEY 漏进了子进程", 1);
    if (!/PATH=set/.test(out)) bye("✗ PATH 被清洗掉了 —— 过滤太狠", 1);
    console.log("✓ CHAT_CODE_TOKEN / DT_NOTIFY_KEY 未传给子进程");
    console.log("✓ 普通变量(PATH)照常传递");
    bye("all ok", 0);
  });
}, 2500); // 等 sidecar 起来
