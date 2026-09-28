// 后台任务上报自检(端到端,要真起一轮 agent):
//   mkdir -p /tmp/rt-e2e
//   env -u CHAT_CODE_RELAY_URL -u CHAT_CODE_HOST_TOKEN CHAT_CODE_TOKEN=t123 CHAT_CODE_PORT=18977 \
//     CHAT_CODE_DATA_DIR=/tmp/rt-check-data node sidecar/server.mjs &
//   E2E_PORT=18977 E2E_TOKEN=t123 node sidecar/bgtask.e2e.mjs
//
// 端口和令牌不读 CHAT_CODE_PORT / CHAT_CODE_TOKEN,理由同 bgtask-mobile.e2e.mjs(读了会连上真 App)。
//
// 验的是:agent 自己起的后台活(Bash run_in_background)必须出现在「会话进程」列表里。
// 它们是本 sidecar 的子孙,按 cwd/进程树认领时会连同 MCP 一起被剔光 —— 只能靠 SDK 报的
// background_tasks_changed 认。这条链路断了不会报错,只会"列表里啥也没有",所以要端到端跑。
import WebSocket from "ws";

const PORT = process.env.E2E_PORT || "18977";
const TOKEN = process.env.E2E_TOKEN || "t123";
if (["8975", "8976"].includes(PORT)) { console.log(`✗ ${PORT} 是 ChatCode 本体的端口,自检只能连临时 sidecar`); process.exit(1); }
const CWD = process.env.E2E_CWD || "/tmp/rt-e2e";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${TOKEN}`);
const bye = (msg, code) => { console.log(msg); ws.close(); process.exit(code); };
setTimeout(() => bye("✗ 超时", 1), 240000);

let sid = null, sawTasks = false;
ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
ws.on("open", () => ws.send(JSON.stringify({ type: "create_session", cwd: CWD, title: "bgtask-e2e" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type === "session_created") {
    sid = m.sessionId;
    ws.send(JSON.stringify({ type: "set_auto_approve", sessionId: sid, on: true })); // 免得卡在授权卡片上
    ws.send(JSON.stringify({ type: "user_message", sessionId: sid,
      content: [{ type: "text", text: "用 Bash 工具、带 run_in_background:true，执行 `sleep 300`。只做这一件事，不要解释。" }] }));
  }
  if (m.type === "sdk" && m.message?.subtype === "background_tasks_changed") {
    console.log("✓ 收到 background_tasks_changed:", JSON.stringify(m.message.tasks));
    if (!m.message.tasks?.length) return;
    sawTasks = true;
    setTimeout(() => ws.send(JSON.stringify({ type: "git_info", sessionId: sid })), 300);
  }
  if (m.type === "git_info" && sawTasks) {
    const rows = m.info?.runtime?.processes ?? [];
    const tasks = rows.filter((r) => r.task);
    if (!tasks.length) bye(`✗ 进程列表里没有 task 行: ${JSON.stringify(rows)}`, 1);
    console.log("✓ 进程列表含后台任务行:", JSON.stringify(tasks));
    ws.send(JSON.stringify({ type: "stop_task", sessionId: sid, taskId: tasks[0].task })); // 停掉,别把 sleep 留在机器上
    console.log("✓ stop_task 已发出（随后应收到一条空 tasks 的 background_tasks_changed）");
    setTimeout(() => bye("all ok", 0), 1500);
  }
});
