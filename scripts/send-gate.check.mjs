#!/usr/bin/env node
// 「发消息前先看轮次了结没」这道闸的自检。漏一个入口的代价很实:压缩期直发会把整个压缩
// 打断(Request was aborted),用户白等几分钟。闸的定义复刻一份跑三种忙态,再断言
// 全部 sendMessage 调用点都在闸后面。和 preview-sync.check.mjs 同一套路。
//
// 跑法:node scripts/send-gate.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const STORE = readFileSync("src/store.tsx", "utf8");
const CHAT = readFileSync("src/components/Chat.tsx", "utf8");
const COMPOSER = readFileSync("src/components/Composer.tsx", "utf8");

// ---------- 1. sessionBusy:和 store.tsx 里那份保持一致 ----------
const sessionBusy = (s) =>
  s.status === "running" || !!s.bgWait || s.timeline.some((t) => t.kind === "compact" && t.running);

const sess = (over) => ({ status: "idle", timeline: [], ...over });

assert.equal(sessionBusy(sess({})), false, "空闲会话不该算忙");
assert.equal(sessionBusy(sess({ status: "running" })), true, "模型说话时算忙");
assert.equal(sessionBusy(sess({ bgWait: true })), true, "后台任务续跑算忙(此时 status 已回 idle)");
// 这条就是本次的 bug:压缩期 status 是 idle,只拦 running 就会漏
assert.equal(sessionBusy(sess({ timeline: [{ kind: "compact", running: true }] })), true, "压缩中算忙");
assert.equal(sessionBusy(sess({ timeline: [{ kind: "compact", running: false }] })), false, "压缩完就不忙了");

// ---------- 2. 闸只有一处定义 ----------
assert.ok(/export const sessionBusy = \(s: Session\) =>/.test(STORE), "sessionBusy 要从 store 导出,别各处各写一份");
for (const [name, src] of [["Chat.tsx", CHAT], ["Composer.tsx", COMPOSER]]) {
  assert.ok(/sessionBusy/.test(src), `${name} 没引用 sessionBusy`);
  assert.ok(!/session\.status === "running" \|\| session\.bgWait/.test(src),
    `${name} 还留着手写的三条件闸 —— 改闸时必漏一处,收敛到 sessionBusy`);
}

// ---------- 3. 每个 sendMessage 调用点都在闸后面 ----------
// 直发绕过闸 = 压缩被打断。新增发送入口时这条会立刻挂掉。
for (const [name, src] of [["Chat.tsx", CHAT], ["Composer.tsx", COMPOSER]]) {
  const lines = src.split("\n");
  lines.forEach((ln, i) => {
    if (!/\bsendMessage\(session\.id/.test(ln)) return;
    // 往上找 40 行内有没有这道闸(闸后面紧跟 return,所以走到 sendMessage 就一定是空闲)
    const before = lines.slice(Math.max(0, i - 40), i).join("\n");
    assert.ok(/sessionBusy\(session\)/.test(before),
      `${name}:${i + 1} 的 sendMessage 前面没有 sessionBusy 闸,忙时会直接打进 SDK`);
  });
}

// ---------- 4. 队列满了不许静默 ----------
// 上限判断收在 enqueuePending 里(读实时 state):调用方拿渲染快照自己判会有过期窗口,
// 那时 reducer 静默吞掉、调用方却已经清空输入框,用户写的东西就没了。
assert.ok(/if \(\(stateRef\.current\.sessions\[id\]\?\.pending\?\.length \?\? 0\) >= PENDING_MAX\) return false;/.test(STORE),
  "enqueuePending 要自己判满并返回 false");
for (const [name, src] of [["Chat.tsx", CHAT], ["Composer.tsx", COMPOSER]]) {
  assert.ok(!/pending\?\.length \?\? 0\) >= 3/.test(src), `${name} 还在用渲染快照判队列满`);
  // 每个 enqueuePending 都要接返回值(取反判、或当三元的条件),丢了就是静默失败
  for (const m of src.matchAll(/(.{0,12})enqueuePending\(session\.id/g)) {
    assert.ok(/!$|\(\s*$/.test(m[1].trim()) || /toast\($/.test(m[1].trim()),
      `${name}: enqueuePending 的返回值没人接 —— 满了会静默丢消息(前文:"${m[1].trim()}")`);
  }
}
assert.ok(/待发已满（最多 \{\{n\}\} 条）/.test(CHAT) && /待发已满（最多 \{\{n\}\} 条）/.test(COMPOSER),
  "满了要 toast 提示,且条数用 PENDING_MAX 插值(别把 3 写死进文案)");
const EN = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
assert.ok(EN["待发已满（最多 {{n}} 条）"], "en.json 缺「待发已满」的插值版词条");

console.log("✓ send-gate 自检通过");
