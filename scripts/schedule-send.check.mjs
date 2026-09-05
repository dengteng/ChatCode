#!/usr/bin/env node
// 定时发送的两条规矩。都是"回归了界面看不出来、只有半夜那条没发出去才发现"的那类:
//   1) 出队要取「队列里第一条到点的」,不是队首 —— 一条约在凌晨 5 点的消息若堵在队首,
//      后面手打的普通消息也会被压到凌晨才发。
//   2) 定时项存在时必须有心跳重跑出队 effect:到点那一刻没有任何 state 变化,
//      光靠 state.sessions 变化触发的话,消息会一直躺在队列里到下次有人说话。
// 跑法:node scripts/schedule-send.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const STORE = readFileSync("src/store.tsx", "utf8");
const COMPOSER = readFileSync("src/components/Composer.tsx", "utf8");

// ---------- 1. 出队挑选:和 store 里那份保持一致 ----------
const pickDue = (pending, now) => pending.find((p) => !p.at || p.at <= now);

const NOW = 1_000_000;
const timed = { pid: "a", at: NOW + 3600_000 };
const plain = { pid: "b" };
const due = { pid: "c", at: NOW - 1 };

assert.equal(pickDue([plain, timed], NOW).pid, "b", "普通消息该照常出队");
assert.equal(pickDue([timed], NOW), undefined, "没到点的定时消息不该出队");
assert.equal(pickDue([timed, plain], NOW).pid, "b", "定时消息不该把它后面的普通消息一起堵住");
assert.equal(pickDue([timed, due], NOW).pid, "c", "已到点的那条该发出去");
assert.equal(pickDue([due, plain], NOW).pid, "c", "到点的定时消息按队列顺序优先");

// ---------- 2. 源码里的闸就是上面这份 ----------
assert.ok(/s\.pending\.find\(\(p\) => !p\.at \|\| p\.at <= Date\.now\(\)\)/.test(STORE),
  "出队又变回只取队首了 —— 一条定时消息会把整条队列堵到它那个点");
assert.ok(/if \(!next\) continue;/.test(STORE), "挑不到到点的消息时必须跳过本会话,别拿 undefined 去发");

// ---------- 3. 心跳:有定时项时才起,且出队 effect 吃这个 tick ----------
assert.ok(/const hasTimedPending = [^\n]*p\.at\)/.test(STORE), "没有'队列里有没有定时项'的判断,心跳无从谈起");
assert.ok(/setInterval\(\(\) => setTimedTick/.test(STORE),
  "定时心跳必须是 interval:长 setTimeout 会被系统睡眠掐停,睡一夜的定时永远不响");
assert.ok(/\[state\.sessions, state\.connected, timedTick\]/.test(STORE), "出队 effect 没吃 timedTick,心跳打了也白打");

// ---------- 4. 定时发送必须走队列,且跳过前端就地执行的那些命令 ----------
assert.ok(/if \(at !== undefined \|\| sessionBusy\(session\)\)/.test(COMPOSER),
  "定时消息没进待发队列 —— 会当场发出去");
assert.ok(/if \(imgCount === 0 && at === undefined\)/.test(COMPOSER),
  "定时发送没跳过 ! 终端命令 / \\/model 这类前端拦截 —— 点「定时」会立刻执行终端命令");

console.log("✓ 定时发送自检通过");
