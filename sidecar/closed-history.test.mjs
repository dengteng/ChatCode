// 自检:关闭会话进「最近历史」回收站,能原地恢复;闲聊仍是彻底删;超过 20 条才真删日志。
// 跑法: node sidecar/closed-history.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-closed-"));
const DATA = path.join(tmp, "data"), PORT = 18977;
const SESS = path.join(DATA, "sessions");
fs.mkdirSync(SESS, { recursive: true });

const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const casualCwd = path.join(DATA, "casual", "c1");
fs.mkdirSync(casualCwd, { recursive: true });

// p0 是要来回折腾的那条;p1..p21 用来把回收站撑过 20 条上限
const projIds = ["p0", ...Array.from({ length: 21 }, (_, i) => `p${i + 1}`)];
const entries = [
  ...projIds.map((id) => ({ id, title: id, cwd: repo, sdkSessionId: `sdk-${id}`, createdAt: 1, lastUser: `活儿 ${id}` })),
  { id: "c1", title: "闲聊", cwd: casualCwd, sdkSessionId: "sdk-c1", createdAt: 1, casual: true },
];
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify(entries));
for (const e of entries) fs.writeFileSync(path.join(SESS, `${e.id}.jsonl`), "");

const jsonlExists = (id) => fs.existsSync(path.join(SESS, `${id}.jsonl`));
const readClosed = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "closed.json"), "utf8")); } catch { return []; } };
const readIndex = () => JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));

const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
setTimeout(() => { console.error("超时:sidecar 没回包"); done(1); }, 25000);

// 每步 = 发一条消息,等下一份 index 广播,然后断言磁盘状态
const STEPS = [
  {
    name: "关闭项目会话 → 进回收站,日志留着",
    msg: { type: "delete_session", sessionId: "p0" },
    check: (idx, closedFromWire) => {
      assert.ok(!idx.some((e) => e.id === "p0"), "p0 该从 index 移走");
      const c = readClosed();
      assert.strictEqual(c[0]?.id, "p0");
      assert.strictEqual(c[0]?.sdkSessionId, "sdk-p0", "sdkSessionId 要留着,恢复时靠它接上下文");
      assert.ok(jsonlExists("p0"), "日志不该删 —— 恢复要靠它");
      assert.strictEqual(closedFromWire[0]?.id, "p0", "closed 要随 index 一起下发给客户端");
      assert.strictEqual(closedFromWire[0]?.sdkSessionId, undefined, "下发给客户端的只要渲染字段");
    },
  },
  {
    name: "关闭闲聊会话 → 彻底删,不进回收站",
    msg: { type: "delete_session", sessionId: "c1" },
    check: () => {
      assert.ok(!readClosed().some((e) => e.id === "c1"), "闲聊不该进回收站");
      assert.ok(!jsonlExists("c1"), "闲聊日志该删掉");
      assert.ok(!fs.existsSync(casualCwd), "闲聊临时目录该递归删掉");
    },
  },
  {
    name: "恢复 → 原地搬回 index,id 与日志都不变",
    msg: { type: "restore_session", sessionId: "p0" },
    check: (idx) => {
      const back = idx.find((e) => e.id === "p0");
      assert.ok(back, "p0 该回到 index");
      assert.strictEqual(back.sdkSessionId, "sdk-p0");
      assert.strictEqual(back.closedAt, undefined, "回收站的时间戳不该带进 index");
      assert.ok(!readClosed().some((e) => e.id === "p0"), "恢复后要从回收站移走");
      assert.ok(jsonlExists("p0"));
    },
  },
  // 依次关掉 p1..p21。关到第 21 条(p21)时回收站满 21 条,最早的 p1 当场被挤出去,只剩 [p21..p2]。
  ...Array.from({ length: 21 }, (_, i) => ({
    name: `撑满回收站 ${i + 1}/21`,
    msg: { type: "delete_session", sessionId: `p${i + 1}` },
    silent: true,
    check: () => {},
  })),
  {
    name: "超过 20 条 → 最旧的那条连日志一起淘汰",
    msg: { type: "delete_session", sessionId: "p0" }, // 排到最前,把队尾的 p2 挤出去
    check: () => {
      const c = readClosed();
      assert.strictEqual(c.length, 20, "回收站封顶 20 条");
      assert.strictEqual(c[0].id, "p0", "最新关的排最前");
      assert.deepStrictEqual(c.at(-1).id, "p3", "队尾是还留着的最旧一条");
      assert.ok(!jsonlExists("p1"), "上一步被挤出去的 p1 日志该已删");
      assert.ok(!jsonlExists("p2"), "这一步被挤出去的 p2 日志该删");
      assert.ok(jsonlExists("p3"), "还在回收站里的日志要留着");
    },
  },
];

let i = 0;
const run = (ws) => ws.send(JSON.stringify(STEPS[i].msg));
const onMsg = (ws) => (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "index") return;
  if (!started) { started = true; run(ws); return; } // 第一份 index 是连上时的初始快照
  const step = STEPS[i];
  try {
    step.check(readIndex(), m.closed || []);
    if (!step.silent) console.log(`PASS: ${step.name}`);
  } catch (e) { console.error(`FAIL: ${step.name} —— ${e.message}`); done(1); }
  if (++i < STEPS.length) run(ws); else done(0);
};
let started = false;
const tryConnect = (n = 0) => { // sidecar 起来要一两秒,连不上就重试
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("message", onMsg(ws));
};
tryConnect();
