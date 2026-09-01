// 自检:用户 shell 命令留下后台子孙进程时,结果要立刻回,不能等那个进程死。
// 回归的是 execFile 那版的坑:它等 stdio 管道 EOF,而后台孙进程攥着 stdout 写端不放,
// 于是 `git commit`(仓库有 post-commit hook 起后台打包)要挂满 30s timeout 才回包。
// 跑法: node sidecar/term-bg-proc.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-termbg-"));
const SID = "s1", DATA = path.join(tmp, "data"), PORT = 18976;
const cwd = path.join(tmp, "repo");
fs.mkdirSync(cwd);
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{ id: SID, cwd }]));

const BUDGET = 4000; // 命令本身 0.0x 秒;留足 bash -lc 读 profile 的余量,仍远小于 sleep 8
const CASES = [
  {
    name: "后台孙进程不拖住回包",
    // post-commit hook 的原样形态:子 shell 内重定向,但末尾还有条裸命令,其 stdout 仍指向父管道
    command: `echo hi; ( sleep 8 > /dev/null 2>&1; echo bg ) &`,
    check: (m, ms) => {
      assert.ok(ms < BUDGET, `回包耗时 ${ms}ms,超过 ${BUDGET}ms —— 又在等后台进程放开管道了`);
      assert.strictEqual(m.exitCode, 0);
      assert.match(m.output, /hi/);
      // PWD 尾巴仍被正确解析掉。realpath:macOS 的 /var 是 /private/var 软链,$PWD 回传的是真身
      assert.strictEqual(m.cwd, fs.realpathSync(cwd));
      assert.doesNotMatch(m.output, /\0/); // 分隔符没漏进正文
    },
  },
  { // 换 spawn 后错误对象是手搓的,退出码这条最容易搓错
    name: "非零退出码原样回传",
    command: `echo oops >&2; exit 3`,
    check: (m) => { assert.strictEqual(m.exitCode, 3); assert.match(m.output, /oops/); },
  },
  { // cd 靠尾巴里的 $PWD 持久化,别被新的读取方式弄丢
    name: "cd 后 cwd 跟着变",
    command: `cd /tmp && pwd`,
    // 这条不 realpath:$PWD 是 cd 走过的逻辑路径,显式 `cd /tmp` 就停在 /tmp,不解软链
    check: (m) => { assert.strictEqual(m.cwd, "/tmp"); assert.ok(m.cwdChanged); },
  },
];

const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

setTimeout(() => { console.error("超时:sidecar 没回包"); done(1); }, 20000);

let i = 0, sentAt = 0;
const fire = (ws) => { sentAt = Date.now(); ws.send(JSON.stringify({ type: "terminal_command", sessionId: SID, command: CASES[i].command })); };
const onMsg = (ws) => (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "terminal_result") return;
  const ms = Date.now() - sentAt, c = CASES[i];
  try {
    c.check(m, ms);
    console.log(`PASS(${ms}ms): ${c.name}`);
  } catch (e) { console.error(`FAIL: ${c.name} —— ${e.message}\n实际回包:`, JSON.stringify(m)); done(1); }
  if (++i < CASES.length) fire(ws); else done(0);
};
const tryConnect = (n = 0) => { // sidecar 起来要一两秒,连不上就重试
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("open", () => fire(ws));
  ws.on("message", onMsg(ws));
};
tryConnect();
