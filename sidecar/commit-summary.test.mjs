// 自检:同一会话里跨项目的轮次,其「本轮小结」不该混进本仓库的 commit 文案。
// 跑法: node sidecar/commit-summary.test.mjs
// 起一个真 sidecar(临时 DATA_DIR + 临时端口),造两轮假日志,走 WS 要 commit_suggest,断言结果。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-commit-"));
const repoA = path.join(tmp, "A"), repoB = path.join(tmp, "B");
for (const r of [repoA, repoB]) { fs.mkdirSync(r); execFileSync("git", ["init", "-q"], { cwd: r }); }

const SID = "s1", DATA = path.join(tmp, "data"), PORT = 18975;
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{ id: SID, cwd: repoA }]));

const user = (t) => ({ type: "user", message: { role: "user", content: t } });
// line = 小结那一行的原样文本(要验各种 markdown 包法都认得出来)
const roundRaw = (file, line) => [
  user("干活"),
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `好了\n\n${line}` }] } },
];
const round = (file, summary) => roundRaw(file, `本轮小结：${summary}`);
fs.writeFileSync(path.join(DATA, "sessions", `${SID}.jsonl`),
  [...round(path.join(repoA, "a.ts"), "改了A项目"),
   ...round(path.join(repoB, "b.ts"), "改了B项目"),
   ...round(path.join(repoA, "c.ts"), "又改了A项目"),
   // 强调只包标签、冒号露在外面 —— 弱模型很爱这么写,少认这一种整条汇总就空掉
   ...roundRaw(path.join(repoA, "d.ts"), "**本轮小结**：粗体标签也要认")]
    .map((m) => JSON.stringify(m)).join("\n") + "\n");

// 清掉握手令牌和 relay:继承外面的 env 会让本地连接被 verifyClient 拒掉,还会顺手连上真 relay
const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

setTimeout(() => { console.error("超时:sidecar 没回包"); done(1); }, 20000);
const onMsg = (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "commit_suggest") return;
  try {
    // 本仓库三轮都在、顺序不变;B 项目那轮被剔掉
    assert.strictEqual(m.message, "- 改了A项目\n- 又改了A项目\n- 粗体标签也要认");
    console.log("PASS:", JSON.stringify(m.message));
    done(0);
  } catch (e) { console.error("FAIL:", e.message, "\n实际文案:", JSON.stringify(m.message)); done(1); }
};
const tryConnect = (n = 0) => { // sidecar 起来要一两秒,连不上就重试
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "commit_suggest", sessionId: SID, force: true })));
  ws.on("message", onMsg);
};
tryConnect();
