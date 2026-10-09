// 协作模式自检(自带 sidecar,起真 CLI,发一句话,花极少额度):
//   node sidecar/collab.e2e.mjs
// 看 CLI 实际用的主模型(init.model)、Opus 顾问有没有被叫(advisor 块 + modelUsage 里出现 opus)、
// 子 agent 是不是 Haiku 5.5(modelUsage 里出现 haiku-5-5)。
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const PORT = 8800 + Math.floor(Math.random() * 90);
const TOKEN = "collab-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-collab-"));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "cc-collab-cwd-"));
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
  env: { ...process.env, CHAT_CODE_TOKEN: TOKEN, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA, DT_NOTIFY_URL: "" },
  stdio: "ignore",
});
const bye = (msg, code) => {
  srv.kill();
  for (const d of [DATA, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(msg);
  process.exit(code);
};
setTimeout(() => bye("✗ 超时", 1), 180000);

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  let sid = null, initModel = null, advisor = false;
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => ws.send(JSON.stringify({ type: "create_session", cwd: CWD, title: "collab-e2e" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "session_created" && !sid) {
      sid = m.sessionId ?? m.id;
      ws.send(JSON.stringify({ type: "user_message", sessionId: sid, content: [{ type: "text", text: "先用 advisor 工具咨询一次(1+1 怎么答);再用 Agent 工具派一个子 agent 回答 2+2;最后只回复 ok。" }] }));
    }
    if (m.type !== "sdk" || m.sessionId !== sid) return;
    const s = m.message;
    if (s.type === "system" && s.subtype === "init") initModel = s.model;
    if (s.type === "assistant") for (const b of s.message.content) if (b.name === "advisor") advisor = true;
    if (s.type === "result") {
      const used = Object.keys(s.modelUsage || {});
      const okMain = /sonnet/.test(initModel || ""), okAdv = advisor && used.some((k) => /opus/.test(k)), okSub = used.some((k) => /haiku-5-5/.test(k));
      bye(`${okMain && okAdv && okSub ? "✓" : "✗"} 主模型=${initModel} advisor被叫=${advisor} modelUsage=${used.join(",")}`, okMain && okAdv && okSub ? 0 : 1);
    }
  });
}, 1500);
