#!/usr/bin/env node
// 拒答回退提示的接线自检。逻辑部分(短名、分组)在 src/lib/model-fallback.check.ts。
// 症状:Opus 5.5 拒答后服务端改由 4.8 作答、CLI 把会话锁在 4.8,ChatCode 却把 SDK 给的 fallback 块丢了,
// 用户只看到底部模型名悄悄变成 4.8,以为是 App 擅自换模型。
//
// 跑法:node scripts/model-fallback.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const STORE = readFileSync("src/store.tsx", "utf8");
const CHAT = readFileSync("src/components/Chat.tsx", "utf8");
const COMPOSER = readFileSync("src/components/Composer.tsx", "utf8");

assert.ok(/block\.type === "fallback" && block\.from\?\.model && block\.to\?\.model/.test(STORE), "store 没把 assistant 里的 fallback 块收进时间线");
assert.ok(/kind: "fallback", from: block\.from\.model, to: block\.to\.model/.test(STORE), "fallback 条目字段漂移了");
assert.ok(CHAT.includes('it.kind === "fallback"') && CHAT.includes('className="bubble-note model-fallback"'), "回复卡片里没渲染回退提示");
// 底部标记要按「当前模型 == 最近一次回退的 to」判:用户切回原模型后必须自动消失
assert.ok(COMPOSER.includes('(session.info.model ?? "").replace(/\\[.*$/, "") === fallbackTo.to'), "「已回退」标记的判据漂移了");
assert.ok(COMPOSER.includes('className="model-fallback-tag"'), "底部模型名旁没有「已回退」标记");

console.log("✓ model-fallback: store 收块 / 卡片提示 / 底部标记 接线完整");
