#!/usr/bin/env node
// agent 环境清洗自检(自带 sidecar,直接跑):
//   node sidecar/agent-env.check.mjs
//
// env-leak.check 只管 `!` 终端命令;这条管 agent 本身 —— claude CLI 会把自己的 env 原样交给 Bash 工具,
// 所以 CLI 拿到什么,agent 跑的命令就能读到什么。曾经漏过 CHAT_CODE_PORT/TOKEN(自检脚本读了它们,
// 把测试会话建进了用户正在用的 App)和 CHAT_CODE_RELAY_URL/HOST_TOKEN(测试 sidecar 冒充本机登上 relay)。
//
// 做法:CHAT_CODE_CLAUDE_BIN 指向一个假 CLI,它只把收到的 env 写进文件就退出。不起真模型、不花钱。
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

const PORT = 8900 + Math.floor(Math.random() * 90); // 避开开发 8975 / 打包 8976
const TOKEN = "agentenv-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-agentenv-"));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "cc-agentenv-cwd-"));
const DUMP = path.join(DATA, "env.json");
const FAKE = path.join(DATA, "fake-claude.mjs");
fs.writeFileSync(FAKE, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(DUMP)}, JSON.stringify(process.env));\nprocess.exit(0);\n`);

const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
  env: {
    ...process.env, CHAT_CODE_TOKEN: TOKEN, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA,
    CHAT_CODE_CLAUDE_BIN: FAKE, CHAT_CODE_RELAY_URL: "", CHAT_CODE_HOST_TOKEN: "",
    CHAT_CODE_LEAK_PROBE: "x", DT_NOTIFY_KEY: "leaktest-key", DT_NOTIFY_URL: "",
    AGENTENV_KEEP_ME: "1", // 普通变量(代表用户自己的 provider key 之类)必须照常传
  },
  stdio: "ignore",
});
const bye = (msg, code) => {
  srv.kill();
  for (const d of [DATA, CWD]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  console.log(msg);
  process.exit(code);
};
setTimeout(() => bye("✗ 超时:假 CLI 没被拉起来", 1), 30000);

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  ws.on("open", () => ws.send(JSON.stringify({ type: "create_session", cwd: CWD, title: "agent-env-check" })));
  const poll = setInterval(() => {
    if (!fs.existsSync(DUMP)) return;
    let env;
    try { env = JSON.parse(fs.readFileSync(DUMP, "utf8")); } catch { return; } // 还没写完
    clearInterval(poll);
    const leaked = Object.keys(env).filter((k) => /^(CHAT_CODE_|DT_NOTIFY_)/.test(k));
    if (leaked.length) bye(`✗ ChatCode 自己的变量漏给了 agent:${leaked.join(", ")}`, 1);
    if (env.AGENTENV_KEEP_ME !== "1" || !env.PATH) bye("✗ 普通变量没传给 agent —— 过滤太狠,provider key 也会被削掉", 1);
    console.log("✓ agent 拿不到 CHAT_CODE_* / DT_NOTIFY_*");
    console.log("✓ 普通变量(PATH 等)照常传递");
    bye("all ok", 0);
  }, 200);
}, 2500); // 等 sidecar 起来
