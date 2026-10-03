// plan 方案批准自检(自带 sidecar,起真 agent,用 haiku 跑一轮,花一点点额度):
//   node sidecar/plan-approve.e2e.mjs
//
// 验前端 PlanCard 那条路:plan 模式下 agent 交方案(ExitPlanMode)→ 批准时带 setMode acceptEdits
// (同前端:permission_response 的 updatedPermissions + set_perm_mode)→ agent 动手写文件,
// 不再为 Write 弹授权卡,文件真的落盘。setMode 没生效的话会卡在 Write 授权或被 plan 模式拦下。
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const PORT = 8800 + Math.floor(Math.random() * 90);
const TOKEN = "plan-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plan-"));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plan-cwd-"));
const FILE = path.join(CWD, "hello.txt");

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
  const send = (o) => ws.send(JSON.stringify(o));
  let sid = null, approved = false;
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => send({ type: "create_session", cwd: CWD, title: "plan-e2e", model: "haiku" }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "session_created") {
      sid = m.sessionId;
      send({ type: "set_perm_mode", sessionId: sid, mode: "plan" });
      send({ type: "user_message", sessionId: sid, content: [{ type: "text", text: `任务:在当前目录创建 hello.txt,内容是 hi。先给一句话方案并调用 ExitPlanMode 提交,批准后再用 Write 写文件。别做别的。` }] });
      return;
    }
    if (m.sessionId !== sid) return;
    if (m.type === "permission_request") {
      if (m.toolName === "ExitPlanMode" && !approved) {
        if (typeof m.input?.plan !== "string") bye("✗ ExitPlanMode 没带 plan 字段,PlanCard 认不出", 1);
        console.log(`✓ 收到方案: ${m.input.plan.slice(0, 60).replace(/\n/g, " ")}…`);
        approved = true;
        send({ type: "permission_response", sessionId: sid, requestId: m.requestId, behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
        send({ type: "set_perm_mode", sessionId: sid, mode: "acceptEdits" });
        return;
      }
      if (approved && /^(Write|Edit)$/.test(m.toolName)) bye(`✗ 批准后写文件还在弹授权(${m.toolName}),setMode 没生效`, 1);
      // 其他工具(如读目录)直接放行,不算失败
      send({ type: "permission_response", sessionId: sid, requestId: m.requestId, behavior: "allow" });
      return;
    }
    if (m.type === "turn_ended" || (m.type === "sdk" && m.message?.type === "result")) {
      if (!approved) bye("✗ 一轮结束了也没交方案(ExitPlanMode)", 1);
      if (fs.existsSync(FILE)) { console.log(`✓ 批准后自动写入 ${path.basename(FILE)},没再弹授权`); bye("all ok", 0); }
    }
  });
}, 2500);
