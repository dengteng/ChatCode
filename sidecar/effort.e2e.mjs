// effort 档位自检(自带 sidecar,起真 CLI,但不发消息、不花额度):
//   node sidecar/effort.e2e.mjs
//
// 每一步都看 CLI 读回来的 applied(getSettings().applied.effort),不看我们自己记的值 ——
// 档位推没推进 CLI、CLI 降没降档,只有它说了算。
//   1. create_session 带默认档位 max → 启动即 max(options.effort)
//   2. set_effort low → low(applyFlagSettings 中途换档)
//   3. set_effort null(自动)→ 回到 CLI 默认 high
//   4. 自动档 + plan 模式 → xhigh;退出 plan → high
//   5. 选 xhigh 后切到 haiku → CLI 降到 null(haiku 不支持 effort),界面据此显示降档
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const PORT = 8800 + Math.floor(Math.random() * 90);
const TOKEN = "effort-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-effort-"));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "cc-effort-cwd-"));

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
setTimeout(() => bye("✗ 超时", 1), 120000);

// [发出去的消息(首步为 null = create_session 自己触发), 期望的 effort, 期望的 applied]
const STEPS = [
  [null, "max", "max"],
  [{ type: "set_effort", effort: "low" }, "low", "low"],
  [{ type: "set_effort", effort: null }, null, "high"],
  [{ type: "set_perm_mode", mode: "plan" }, null, "xhigh"],
  [{ type: "set_perm_mode", mode: "default" }, null, "high"],
  [{ type: "set_effort", effort: "xhigh" }, "xhigh", "xhigh"],
  [{ type: "set_model", model: "haiku" }, "xhigh", null],
];

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  let sid = null, i = 0;
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => ws.send(JSON.stringify({ type: "create_session", cwd: CWD, title: "effort-e2e", effort: "max" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "session_created") { sid = m.sessionId; return; }
    if (m.type !== "effort" || m.sessionId !== sid) return;
    const [, want, wantApplied] = STEPS[i];
    // 中间态(如 set_effort 未落盘前的回声)不算失败:只认和期望完全一致的那条,其余等超时
    if (m.effort !== want || m.applied !== wantApplied) { console.log(`  · 跳过中间态 effort=${m.effort} applied=${m.applied}`); return; }
    console.log(`✓ 第 ${i + 1} 步: effort=${want ?? "自动"} → CLI 实际 ${wantApplied ?? "不发"}`);
    if (++i === STEPS.length) bye("all ok", 0);
    ws.send(JSON.stringify({ ...STEPS[i][0], sessionId: sid }));
  });
}, 2500);
