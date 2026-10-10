// 打断后切模型,再发消息必须用新模型(自带 sidecar,起真 CLI,花几句话的额度):
//   node sidecar/model-switch.e2e.mjs
// 以 init.model / assistant.message.model 为准 —— CLI 实际用谁只有它说了算。
//   A=haiku-5-5 发一条长任务 → 出字后 interrupt → set_model B=haiku-4-5 → 再发一句 → 必须是 B
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const A = process.env.MS_A || "claude-haiku-5-5", B = process.env.MS_B || "claude-haiku-4-5-20251001";
const want = process.env.MS_WANT || "haiku-4-5"; // B 的实际 id 里该有的片段
const PORT = 8800 + Math.floor(Math.random() * 90);
const TOKEN = "ms-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ms-"));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ms-cwd-"));
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
  env: { ...process.env, CHAT_CODE_TOKEN: TOKEN, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA, DT_NOTIFY_URL: "", CHAT_CODE_CLAUDE_BIN: process.env.CHAT_CODE_CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude") },
  stdio: "ignore",
});
const bye = (msg, code) => {
  srv.kill();
  for (const d of [DATA, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(msg); process.exit(code);
};
setTimeout(() => bye("✗ 超时", 1), 150000);
const TOOL = process.env.MS_TOOL === "1"; // 打断时 Bash 工具正在跑
const text = (t) => [{ type: "text", text: t }];

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  const out = (o) => ws.send(JSON.stringify(o));
  let sid = null, phase = "turn1", interrupted = false;
  const switchAndResend = (via) => {
    if (phase !== "turn1") return;
    phase = "turn2";
    console.log(`  · 已打断(经 ${via}),切到 B 并再发一句`);
    out({ type: "set_model", sessionId: sid, model: B });
    setTimeout(() => out({ type: "user_message", sessionId: sid, content: text("只回复两个字:好的") }), 1500);
  };
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => out({ type: "create_session", cwd: CWD, title: "ms-e2e", ...(A === "default" ? {} : { model: A }) }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "session_created") {
      sid = m.sessionId;
      if (TOOL) out({ type: "set_auto_approve", sessionId: sid, on: true });
      out({ type: "user_message", sessionId: sid, content: text(TOOL ? "用 Bash 工具运行 `sleep 90`,不要做别的。" : "用中文写一篇 3000 字的长文,主题随意,不要调用工具。") });
      return;
    }
    if (m.sessionId !== sid) return;
    if (m.type === "turn_ended" && phase === "turn1" && interrupted) { switchAndResend("turn_ended(强制重启路径)"); return; }
    if (m.type === "system_note") console.log("  · note:", m.text);
    if (m.type !== "sdk") return;
    const s = m.message;
    if (s.type === "system" && s.subtype === "init") console.log(`  · init.model=${s.model} (phase=${phase})`);
    const toolSeen = s.type === "assistant" && s.message?.content?.some((b) => b.type === "tool_use");
    if (phase === "turn1" && !interrupted && (TOOL ? toolSeen : s.type === "assistant")) {
      interrupted = true;
      console.log("  · 出字了,打断");
      out({ type: "interrupt", sessionId: sid });
    }
    if (phase === "turn1" && s.type === "result") { switchAndResend("result"); return; }
    if (phase === "turn2" && s.type === "assistant") {
      const used = s.message?.model;
      if (used?.startsWith("<")) { console.log("  · synthetic:", JSON.stringify(s.message?.content)?.slice(0, 200), s.error || ""); return; }
      console.log(`  · 第二轮 assistant.model=${used}`);
      bye(used?.includes(want) ? "✓ 打断后切模型生效" : `✗ 又变回了 ${used}`, used?.includes(want) ? 0 : 1);
    }
  });
}, 2500);
