// 手机「后台任务」入口的端到端自检(要真起一轮 agent):
//   mkdir -p /tmp/rt-e2e
//   env -u CHAT_CODE_RELAY_URL -u CHAT_CODE_HOST_TOKEN CHAT_CODE_TOKEN=t123 CHAT_CODE_PORT=18977 \
//     CHAT_CODE_DATA_DIR=/tmp/rt-check-data node sidecar/server.mjs &
//   E2E_PORT=18977 E2E_TOKEN=t123 node sidecar/bgtask-mobile.e2e.mjs
//
// 端口和令牌故意**不读** CHAT_CODE_PORT / CHAT_CODE_TOKEN:在 ChatCode 里开的终端(包括 agent 跑的
// 命令)环境里就带着真 App 的这两个值,读了就会连上正在用的 ChatCode,在真列表里建测试会话。
// relay 那两个也要 unset,不然临时 sidecar 会以同一个机器名连上线上 relay,冒充这台电脑。
//
// 验四件事(手机全靠这几条消息,它看不到时间线也读不了 Mac 上的文件):
//   1. bg_tasks 带上详情 —— 标题、命令、输出路径
//   2. read_task_output 能读到后台命令的实时输出
//   3. 换一个连接 reopen_session(= 手机中途打开会话)会补发 bg_tasks
//   4. stop_task 有回执,停完 bg_tasks 变空
import WebSocket from "ws";

const PORT = process.env.E2E_PORT || "18977";
const TOKEN = process.env.E2E_TOKEN || "t123";
const CWD = process.env.E2E_CWD || "/tmp/rt-e2e";
const url = `ws://127.0.0.1:${PORT}?token=${TOKEN}`;

const ws = new WebSocket(url);
const bye = (msg, code) => { console.log(msg); try { ws.close(); } catch {} process.exit(code); };
setTimeout(() => bye("✗ 超时", 1), 240000);

let sid = null, task = null, step = "wait-task";
ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
ws.on("open", () => ws.send(JSON.stringify({ type: "create_session", cwd: CWD, title: "bgtask-mobile-e2e" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (process.env.E2E_VERBOSE) console.log("  <-", m.type, m.message?.type ?? "", m.message?.subtype ?? "", m.type === "bg_tasks" ? JSON.stringify(m.tasks) : "");
  if (m.type === "session_created") {
    sid = m.sessionId;
    ws.send(JSON.stringify({ type: "set_auto_approve", sessionId: sid, on: true }));
    ws.send(JSON.stringify({ type: "user_message", sessionId: sid, content: [{ type: "text",
      text: "用 Bash 工具、带 run_in_background:true、description 填「数数」，执行 `for i in $(seq 1 300); do echo tick$i; sleep 1; done`。只做这一件事，不要解释，也不要去读它的输出。" }] }));
  }
  if (m.sessionId !== sid) return;

  if (m.type === "bg_tasks" && step === "wait-task" && m.tasks?.length) {
    const t = m.tasks[0];
    if (!t.out) return console.log("… bg_tasks 先到了(还没补到输出路径):", JSON.stringify(t));
    task = t;
    console.log("✓ 1. bg_tasks 带详情:", JSON.stringify(t));
    if (t.title !== "数数" || !/seq 1 300/.test(t.body) || t.kind !== "shell") bye("✗ 详情不对", 1);
    step = "read";
    setTimeout(() => ws.send(JSON.stringify({ type: "read_task_output", sessionId: sid, taskId: task.id })), 3000);
  }
  if (m.type === "task_output" && step === "read") {
    if (!/tick\d/.test(m.text || "")) bye(`✗ 输出里没有 tick: ${JSON.stringify(m)}`, 1);
    console.log(`✓ 2. 读到输出(${m.size} 字节):`, JSON.stringify((m.text || "").trim().split("\n").slice(-2)));
    step = "reopen";
    // 另开一条连接,模拟手机中途打开会话
    const w2 = new WebSocket(url);
    w2.on("open", () => w2.send(JSON.stringify({ type: "reopen_session", sessionId: sid, limit: 50 })));
    w2.on("message", (r2) => {
      const x = JSON.parse(r2);
      if (x.type !== "bg_tasks" || x.sessionId !== sid) return;
      if (!x.tasks?.some((t) => t.id === task.id && t.out)) bye(`✗ reopen 补发的 bg_tasks 不对: ${JSON.stringify(x)}`, 1);
      console.log("✓ 3. reopen_session 补发了 bg_tasks");
      w2.close();
      step = "stop";
      ws.send(JSON.stringify({ type: "stop_task", sessionId: sid, taskId: task.id }));
    });
  }
  if (m.type === "stop_task_result" && step === "stop") {
    if (!m.ok) bye(`✗ 停止失败: ${m.error}`, 1);
    console.log("✓ 4a. stop_task 回执 ok");
    step = "wait-empty";
  }
  if (m.type === "bg_tasks" && (step === "wait-empty" || step === "stop") && !m.tasks?.length) {
    bye("✓ 4b. 停完 bg_tasks 变空 —— 全部通过", 0);
  }
});
