#!/usr/bin/env node
// 「子 agent 还在跑,气泡却变完成态」的自检。
// 症状:主 agent 派出 6 个后台子 agent,每回报一个就续跑一轮。续跑轮结束时气泡变完成态、点绿✅、响「任务完成」,
// 可剩下的子 agent 还在跑。日志里每轮的顺序是:background_tasks_changed(n-1) → init → result。
// 前端收到 init 就清空 bgTasks,于是 result 读到空清单,当成全部完成。
// 修法:sidecar 给每个进程的第一条 init 标 freshProcess,前端只在换进程时清。
//
// 跑法:node scripts/bg-continue.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SIDECAR = readFileSync("sidecar/server.mjs", "utf8");
const STORE = readFileSync("src/store.tsx", "utf8");

// 1. sidecar:每个 query 循环自己一个 firstInit,第一条 init 标 true,之后都标 false
const loop = SIDECAR.slice(SIDECAR.indexOf("sess.loopDone = (async () => {"));
assert.ok(/^sess\.loopDone = \(async \(\) => \{\s*\n\s*let firstInit = true;/.test(loop), "firstInit 要在每个 query 循环开头重置");
assert.ok(/msg = \{ \.\.\.msg, freshProcess: firstInit \};\s*\n\s*firstInit = false;/.test(loop), "init 要标 freshProcess 并把 firstInit 置 false");

// 2. 前端:只有换进程才清 bgTasks,不能无条件清
const init = STORE.slice(STORE.indexOf('dispatch({ type: "sdk_init"'), STORE.indexOf('subtype === "background_tasks_changed"'));
assert.ok(/if \(msg\.freshProcess !== false\) dispatch\(\{ type: "patch", id, patch: \{ bgTasks: \[\] \} \}\);/.test(init), "sdk_init 只在 freshProcess 时清 bgTasks");
assert.ok(!/^\s*dispatch\(\{ type: "patch", id, patch: \{ bgTasks: \[\] \} \}\);/m.test(init), "sdk_init 又在无条件清 bgTasks 了");

// 3. 完成判定仍看 bgTasks:清单非空时不点完成
assert.ok(/const done = !msg\.aborted && !hasBg;/.test(STORE), "result 的完成判定不再看后台任务了");

console.log("✓ bg-continue: 同进程续跑的 init 不清后台任务清单,子 agent 没跑完不算完成");
