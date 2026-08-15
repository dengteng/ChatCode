// 权限档位自检(自带 sidecar,要真起一轮 agent):
//   node sidecar/permmode.e2e.mjs
//
// 验两件事:
//   1. set_perm_mode 落盘 + 广播;
//   2. 会话关掉再被消息唤醒后,CLI **真的**以这个模式起来 —— 它由 spawnAgent 的 options.permissionMode
//      决定,而 SDK init 回报的 permissionMode 是唯一凭据。这条链断了不报错,只会悄悄退回逐条审批。
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const PORT = 8800 + Math.floor(Math.random() * 90);
const TOKEN = "permmode-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-permmode-"));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "cc-permmode-cwd-"));
const WANT = "acceptEdits";

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
setTimeout(() => bye("✗ 超时", 1), 240000);

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  let sid = null, acked = false, reborn = false;
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => ws.send(JSON.stringify({ type: "create_session", cwd: CWD, title: "permmode-e2e" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "session_created") {
      sid = m.sessionId;
      ws.send(JSON.stringify({ type: "set_perm_mode", sessionId: sid, mode: WANT }));
      return;
    }
    // 关掉会话 = 从内存里摘掉;下一条消息会按 index 里的记录重建 query,正好走 spawnAgent 那条路
    if (m.type === "session_closed" && m.sessionId === sid && acked && !reborn) {
      reborn = true;
      ws.send(JSON.stringify({ type: "user_message", sessionId: sid, content: [{ type: "text", text: "回复 ok，不要做别的。" }] }));
      return;
    }
    if (m.type !== "perm_mode" || m.sessionId !== sid) return;
    if (!acked) {                                   // 第一条:set_perm_mode 的回声
      if (m.mode !== WANT) bye(`✗ 广播的模式不对: ${m.mode}`, 1);
      const idx = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
      if (idx.find((e) => e.id === sid)?.permMode !== WANT) bye("✗ 模式没落盘到 index.json", 1);
      console.log(`✓ set_perm_mode 已广播并落盘 (${WANT})`);
      acked = true;
      ws.send(JSON.stringify({ type: "close_session", sessionId: sid }));
      return;
    }
    if (!reborn) return;
    // 第二条:SDK init 回报的真实模式
    if (m.mode !== WANT) bye(`✗ 重建后 CLI 起在了 ${m.mode},options.permissionMode 没生效`, 1);
    console.log(`✓ 重建后 CLI 确认以 ${WANT} 启动`);
    bye("all ok", 0);
  });
}, 2500);
