#!/usr/bin/env node
// 「切模型被 CLI 拒」的自检。
// 症状:协作模式(settings.advisorModel)下从 Haiku 4.5 切到 Haiku 5.5,界面提示已切换、底栏也变了,
// 一发消息底栏又跳回 4.5、回复也是 4.5。实测 CLI 2.1.285 挂着 advisor 时 setModel("claude-haiku-5-5") 会拒
// ("isn't described by this version's model catalog"),同一个 id 用 --model 启动却正常;sidecar 把拒绝吞了。
// 修法:被拒 → 记 modelRestart,下一条消息前 resume 重启,spawnAgent 从 index 读新模型进 options。
//
// 跑法:node scripts/model-switch.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SIDECAR = readFileSync("sidecar/server.mjs", "utf8");
const setModelCase = SIDECAR.slice(SIDECAR.indexOf('case "set_model"'), SIDECAR.indexOf('case "set_effort"'));

// 1. 拒绝分支不能是空函数
assert.ok(!/setModel\?\.\([^;]*\)\?\.then\?\.\([^;]*,\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(setModelCase), "setModel 的拒绝又被 () => {} 吞掉了");
assert.ok(/sess\.modelRestart = true;/.test(setModelCase), "setModel 被拒时要记 modelRestart");
assert.ok(/sess\.modelRestart = false; syncEffort/.test(setModelCase), "setModel 成功要清掉 modelRestart(防旧标记误触发重启)");

// 2. 下一条消息前重启,且本轮不算结束(keepRunning=true)
assert.ok(/else if \(sess\.modelRestart\) \{\s*\n(?:\s*\/\/.*\n)?\s*sess\.modelRestart = false;\s*\n\s*await restartAgent\(ws, sess, m\.sessionId, true\);/.test(SIDECAR),
  "modelRestart 后的下一条消息要先 restartAgent(keepRunning=true)");

// 3. 重启靠的是 spawnAgent 从 index 读模型:set_model 必须在调 setModel 之前落盘
assert.ok(setModelCase.indexOf("saveIndex(idx)") > -1 && setModelCase.indexOf("saveIndex(idx)") < setModelCase.indexOf("setModel?.("), "set_model 要先落 index 再 setModel");
assert.ok(/const savedModel = idxEntry\?\.model;/.test(SIDECAR), "spawnAgent 不再从 index 取模型了,重启就切不过去");

console.log("✓ model-switch: setModel 被拒 → 下一条消息前按新模型重启");
