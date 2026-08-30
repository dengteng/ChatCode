#!/usr/bin/env node
// 「还挂着后台任务时,这一轮不算完」的自检。
//
// SDK 的 result 只代表"模型说完话了",不代表活干完了:agent 起的后台任务还在跑,
// 后面通常还有一轮续跑。之前 result 一到就无条件点亮绿✅、发"任务完成"通知、跳 dock、响提示音 ——
// 用户被叫过去,点进会话看到的却是"后台任务运行中·已跑 3min12s"。
//
// 三处接线缺一不可,而且拆掉任何一处都不会有功能报错(只是又开始骗人),所以在这儿钉住:
//   1. store 的 result 分支:hasBg 时压住 freshDone + 提醒;
//   2. 20 秒兜底:续跑轮确实不来时把欠的那次补上(不补就永远不亮、永远不响);
//   3. 侧栏图标:有后台任务就画转圈,而且要看 bgTasks 不是 bgWait。
//
// 跑法:node scripts/bg-done.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const STORE = readFileSync("src/store.tsx", "utf8");
const SIDEBAR = readFileSync("src/components/Sidebar.tsx", "utf8");

// ---------- 1. 判定逻辑本身(复刻一份跑,真值表比正则可靠) ----------
const done = (aborted, hasBg) => !aborted && !hasBg;
assert.equal(done(false, false), true, "正常收尾:点亮 + 提醒");
assert.equal(done(false, true), false, "还挂着后台任务:这一轮没完,不许点亮也不许提醒");
assert.equal(done(true, false), false, "用户中断:不算完成");
assert.equal(done(true, true), false, "中断且有后台任务:更不算");

// ---------- 2. result 分支:freshDone 和提醒共用同一个判定 ----------
assert.ok(/const done = !msg\.aborted && !hasBg;/.test(STORE),
  "result 分支要先算出 done(= 没中断 且 没挂后台任务),别让 freshDone 和提醒各判各的");
assert.ok(/freshDone: done,/.test(STORE), "绿✅ 要走 done —— 写成 !msg.aborted 就是回到「有后台任务也点亮」的老样子");
assert.ok(/if \(done\) \{ notify\(/.test(STORE), "「任务完成」通知 + alertUser 也要走 done,不能只挡住图标");
assert.ok(!/freshDone: !msg\.aborted\b/.test(STORE), "别再出现 freshDone: !msg.aborted(旧写法,漏掉后台任务这档)");
assert.ok(/const hasBg = \(stateRef\?\.current\.sessions\[id\]\?\.bgTasks\?\.length \?\? 0\) > 0;/.test(STORE),
  "hasBg 要读 bgTasks 的实时值(stateRef,不是闭包里的旧 state)");

// ---------- 3. 20 秒兜底:把压住的那次补回来 ----------
// 兜底触发 = bgWait 挂着 + idle + bgTasks 已空 + 20 秒没动静 = 续跑轮不会来了。
// 能走到这儿就一定欠着一次(aborted 那条路会当场清 bgWait,进不来),所以补发无需再记标记。
const fallback = /if \(cur\?\.bgWait && cur\.status === "idle" && \(cur\.bgTasks\?\.length \?\? 0\) === 0\) \{[\s\S]*?\n\s*\}/.exec(STORE);
assert.ok(fallback, "没找到 bgWait 的 20 秒兜底");
assert.ok(/freshDone: true/.test(fallback[0]), "兜底放闸时要补上绿✅ —— 否则这种会话永远不点亮");
assert.ok(/notify\(/.test(fallback[0]) && /alertUser\(\)/.test(fallback[0]),
  "兜底也要补提醒:result 那次被压住了,续跑轮又不来,不补就一声都没有");
assert.ok(/bgWait: false/.test(fallback[0]), "兜底本来的活(放开待发队列的闸)不能丢");

// ---------- 4. 侧栏状态图标 ----------
assert.ok(/function StatusIcon\(\{ status, freshDone, bg \}/.test(SIDEBAR), "StatusIcon 要收 bg(这一轮还挂着后台任务)");
assert.ok(/if \(status === "running" \|\| bg\)/.test(SIDEBAR), "有后台任务就按「还在跑」画转圈,别落到灰圈或绿✅");
assert.ok(/bg=\{\(live\?\.bgTasks\?\.length \?\? 0\) > 0\}/.test(SIDEBAR),
  "图标要看 bgTasks 不是 bgWait:bgWait 是闩锁,任务清空后还挂一会儿,拿它画会在活干完后继续转;卡住时更是永远转下去");

console.log("✅ bg-done: 判定真值表 / result 压住 ✅+提醒 / 20 秒兜底补发 / 侧栏图标转圈 全部通过");
