#!/usr/bin/env node
// 「任务完成提醒」开关的自检。两个坑:
//   1. 默认值 —— localStorage 头一次读到的是 null,写成 === "1" 就变成默认关,用户什么都没干提醒先没了;
//   2. 漏闸 —— 再加提醒点时直接 invoke("bounce_dock"),关掉的开关对新入口不生效(同 sessionBusy 那次)。
// 和 send-gate.check.mjs 同一套路:布尔逻辑复刻一份跑,接线只能断言源码。
//
// 跑法:node scripts/dock-bounce.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const STORE = readFileSync("src/store.tsx", "utf8");
const SETTINGS = readFileSync("src/components/Settings.tsx", "utf8");

// ---------- 1. 默认开:只有显式存过 "0" 才算关 ----------
const dockBounceOn = (stored) => stored !== "0";
assert.equal(dockBounceOn(null), true, "没存过时要默认开");
assert.equal(dockBounceOn("1"), true, "存了 1 是开");
assert.equal(dockBounceOn("0"), false, "存了 0 是关");
assert.equal(dockBounceOn(""), true, "空串(隐私模式/写坏)按默认开处理,别静默关掉提醒");

// ---------- 2. 所有跳动都走同一道闸 ----------
assert.ok(/const bounceDock = \(\) => \{ if \(dockBounceOn\(\)\) invoke\("bounce_dock"\)/.test(STORE),
  "跳动要收敛到 bounceDock 一处");
for (const m of STORE.matchAll(/invoke\("bounce_dock"\)/g)) {
  const before = STORE.slice(Math.max(0, m.index - 60), m.index);
  assert.ok(/if \(dockBounceOn\(\)\) $/.test(before),
    "有个 invoke(\"bounce_dock\") 没过开关 —— 用户关了它照跳");
}
assert.ok(/const alertUser = \(\) => \{ bounceDock\(\); playDing\(\); \};/.test(STORE),
  "提醒要有统一出口 alertUser(跳动 + 提示音),否则加提醒点时准漏一路");
assert.ok((STORE.match(/alertUser\(\);/g) || []).length >= 2,
  "两个提醒点(任务完成 / 等待授权)都要走 alertUser");

// ---------- 2b. 提示音同样有闸,且不许绕过 ----------
assert.ok(/export const soundOn = \(\) => localStorage\.getItem\(SOUND_KEY\) !== "0";/.test(STORE),
  "提示音也得默认开(!== \"0\"),写成 === \"1\" 就成了默认关");
assert.ok(/export const playDing = \(\) => \{\n\s*if \(!soundOn\(\)\) return;/.test(STORE),
  "playDing 头一行就要过开关");
for (const m of STORE.matchAll(/new AudioContext\(\)/g)) {
  assert.ok(/actx \?\?= $/.test(STORE.slice(Math.max(0, m.index - 9), m.index)),
    "AudioContext 只能有 actx ??= 那一个:每响一次新建一个,几十次后 macOS 直接不给音频节点了");
}
// suspended 状态下排的音会攒着,等 resume 的瞬间一起炸响 —— 必须先 resume 再排
assert.ok(/actx\.resume\(\)\.then\(/.test(STORE), "要先 resume 再排音,否则冷启动会攒一堆音一起响");

// ---------- 3. 设置页接线 ----------
assert.ok(/\["notify", "通知提醒"\]/.test(SETTINGS), "设置侧栏缺「通知提醒」入口");
assert.ok(/\{tab === "notify" && <NotifyTab \/>\}/.test(SETTINGS), "notify tab 没接上内容");
assert.ok(/useState\(dockBounceOn\)/.test(SETTINGS) && /useState\(soundOn\)/.test(SETTINGS),
  "勾选态要读实际生效的那个值,别在设置页另写一份默认值");
assert.ok(/localStorage\.setItem\(DOCK_BOUNCE_KEY, v \? "1" : "0"\)/.test(SETTINGS),
  "写入要和 dockBounceOn 的读法对上(存 \"0\" 才是关)");
assert.ok(/localStorage\.setItem\(SOUND_KEY, v \? "1" : "0"\)/.test(SETTINGS), "提示音写入的读法也要对上");
assert.ok(/export const DOCK_BOUNCE_KEY = "ChatCode-dock-bounce";/.test(STORE), "键名要从 store 导出,别两边各写一份字符串");
assert.ok(/export const SOUND_KEY = "ChatCode-alert-sound";/.test(STORE), "提示音键名同样从 store 导出");
assert.ok(/if \(v\) playDing\(\);/.test(SETTINGS), "勾上时要响一声当试听(也顺便在用户手势里解锁 AudioContext)");

const EN = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
for (const k of ["通知提醒", "任务完成提醒", "完成时让 Dock 图标跳动", "完成时播放提示音"]) {
  assert.ok(EN[k], `en.json 缺词条「${k}」`);
}

console.log("✓ dock-bounce 自检通过");
