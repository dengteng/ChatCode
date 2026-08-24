#!/usr/bin/env node
// API 出错时那三条界面规则的自检。规则本体在 tsx 里(没法直接 import),这里照抄一份再断言
// 源码没漂移 —— 和 bg-progress.check.mjs 同一套路。
//
// 样本是 ~/.ChatCode/sessions/*.jsonl 里抓的原样报文,不是手编的。
//
// 跑法:node scripts/api-error-ux.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const CHAT = readFileSync("src/components/Chat.tsx", "utf8");
const STORE = readFileSync("src/store.tsx", "utf8");

// ---------- 1. 坏图提示:认出"图被剔除"这句,重试无用 ----------
const BAD_IMAGE = /image in the conversation could not be processed/i;
assert.ok(CHAT.includes("image in the conversation could not be processed"), "Chat.tsx 的 BAD_IMAGE 已漂移");

assert.ok(BAD_IMAGE.test("API Error: an image in the conversation could not be processed and was removed. Re-read the file if you need it."));
// 别把普通报错也认成坏图(那些重试是有意义的)
assert.ok(!BAD_IMAGE.test("API Error: 529 Overloaded. This is a server-side issue, usually temporary"));
assert.ok(!BAD_IMAGE.test("Failed to authenticate: OAuth session expired"));

// ---------- 2. 合成消息不当模型:头像/名字得回退到会话当前模型 ----------
// SDK 给 API 报错那条回复填的 model 是字面量 "<synthetic>",落进时间线会渲染成绿圈里一个 "<"。
const modelOf = (m) => (m?.startsWith("<") ? undefined : m);
assert.ok(STORE.includes('msg.message?.model?.startsWith("<")'), "store.tsx 的合成消息过滤已漂移");

assert.equal(modelOf("<synthetic>"), undefined);      // 529 / 坏图那几条报错
assert.equal(modelOf("claude-fable-5"), "claude-fable-5");
assert.equal(modelOf("claude-opus-5[1m]"), "claude-opus-5[1m]"); // [1m] 是合法后缀,别误伤
assert.equal(modelOf(undefined), undefined);

// ---------- 3. 退避期"本轮耗时"要真的走 ----------
// 请求还没通时组里一个 item 都没有,startTs 只看 items[0] 就会死钉在 0s(实测 529 能退避 3 分多钟)。
const startTsOf = (items, turnStart) => items[0]?.ts ?? turnStart;
assert.ok(CHAT.includes("items[0]?.ts ?? turnStart"), "Chat.tsx 的 startTs 回退已漂移");

const now = 1_000_000;
assert.equal(startTsOf([], undefined), undefined);                    // 连锚点都没有:只能是 0s
assert.equal(startTsOf([], now - 200_000), now - 200_000);            // 空回合 → 回退到发起本轮的用户消息
assert.equal(startTsOf([{ ts: now - 5_000 }], now - 200_000), now - 5_000); // 有动作了就以动作为准
const elapsed = (items, turnStart) => { const s = startTsOf(items, turnStart); return s ? now - s : 0; };
assert.equal(elapsed([], now - 200_000), 200_000, "退避 200s,耗时不该还是 0");

// ---------- 4. 重试提示只在实时会话里出现 ----------
assert.ok(STORE.includes('msg.subtype === "api_retry"'), "store.tsx 没接住 api_retry");
assert.ok(/api_retry[\s\S]{0,400}?if \(!live\) return;/.test(STORE), "api_retry 必须跳过历史回放(那次重试早有结论了)");
assert.ok(/apiRetry: null/.test(STORE), "请求通了/本轮结束时没清掉重试提示 —— 会一直挂着");

console.log("✅ api-error-ux: 坏图提示 / 合成消息模型 / 退避耗时 / api_retry 生命周期 全部通过");
