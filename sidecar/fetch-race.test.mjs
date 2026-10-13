// 自检:用户的 git 命令必须等已在跑的后台 fetch 收尾再开跑。
// 不等的话 git pull 会和后台 fetch 一起改写 .git/FETCH_HEAD,只是落后也报 "divergent branches"。
// 做法:远端 upload-pack 先睡 2s,让 git_info 触发的后台 fetch 慢下来;刚 clone 的仓库没有 FETCH_HEAD,
// 后台 fetch 跑完才会有。git_info 一回包就发 `git rev-parse FETCH_HEAD` —— 等了就能读到,没等就报错。
// 跑法: node sidecar/fetch-race.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fetchrace-"));
const SID = "s1", DATA = path.join(tmp, "data"), PORT = 18978;
const bare = path.join(tmp, "remote.git"), cwd = path.join(tmp, "repo");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
execFileSync("git", ["init", "-q", "--bare", bare]);
execFileSync("git", ["clone", "-q", bare, cwd], { stdio: "pipe" });
git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a");
git(cwd, "push", "-q", "origin", "HEAD");
git(cwd, "config", "remote.origin.uploadpack", "sleep 2; git-upload-pack");
assert.throws(() => git(cwd, "rev-parse", "--verify", "-q", "FETCH_HEAD"), "前提不成立:clone 完就已经有 FETCH_HEAD");
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{ id: SID, cwd }]));

const COMMAND = "git rev-parse --verify -q FETCH_HEAD";
const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
setTimeout(() => { console.error("超时:sidecar 没回包"); done(1); }, 30000);

const tryConnect = (n = 0) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "git_info", sessionId: SID })));
  let sent = false;
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "git_info" && !sent) {
      sent = true; // 此刻后台 fetch 已经起跑(gitInfo 先调 maybeFetch 再读状态),还睡在 upload-pack 里
      ws.send(JSON.stringify({ type: "terminal_command", sessionId: SID, command: COMMAND }));
    }
    if (m.type !== "terminal_result") return;
    try {
      assert.strictEqual(m.exitCode, 0, `git 命令没等后台 fetch 就跑了(读不到 FETCH_HEAD),输出: ${m.output}`);
      console.log("PASS: git 命令等到后台 fetch 跑完才执行");
    } catch (e) { console.error(`FAIL: ${e.message}`); done(1); }
    done(0);
  });
};
tryConnect();
