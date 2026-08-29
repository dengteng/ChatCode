#!/usr/bin/env node
// 三处「省重复活」的接线自检。它们有个共同麻烦:拆掉之后功能完全正常,只是变慢/变胖 ——
// 没有任何功能信号会告诉你被拆了,所以只能在这儿钉住。
//
// 跑法:node scripts/render-cache.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const CHAT = readFileSync("src/components/Chat.tsx", "utf8");
const STORE = readFileSync("src/store.tsx", "utf8");

// ---------- 1. 回合分组 memo:保住每轮 items 的引用 ----------
// 这是下面两条 memo 能不能命中的前提:每次重建数组的话,[items] 永远是新引用,写了也白写。
assert.ok(/const turns = useMemo\(\(\) => groupTurns\(session\.timeline\), \[session\.timeline\]\);/.test(CHAT),
  "groupTurns 要 memo 在 session.timeline 上 —— 否则下游按 [items] 的 memo 全部落空");
assert.ok(/const groups = turns\.slice\(\);/.test(CHAT),
  "取 turns 必须先拷贝:下面会 push 一个空回合,直接改会污染 memo 存着的那份");
assert.ok(!/const groups = groupTurns\(/.test(CHAT), "别绕过 turns 又现算一遍");

// ---------- 2. 每张卡片的整轮扫描 ----------
for (const [fn, why] of [["usedSkillsMcp", "每张历史卡片每次重渲染都重扫一遍整轮"],
                         ["usedMemories", "同上,而且它还带正则和字符串清洗,更贵"]]) {
  assert.ok(new RegExp(`useMemo\\(\\(\\) => ${fn}\\(items\\), \\[items\\]\\)`).test(CHAT),
    `${fn} 要 memo 在 [items] 上 —— ${why}`);
}

// ---------- 2b. 卡片 memo,和它赖以生效的那几个稳定 prop ----------
// 这块最脆:memo 本身还在、但有人往 props 里塞了个新数组/新箭头函数,就悄没声地全废了,
// 界面一切正常,只是又变回每个 chunk 重渲几十张卡。所以逐个 prop 钉。
assert.ok(/const AgentTurnCard = memo\(function AgentTurnCard\(/.test(CHAT),
  "AgentTurnCard 要 memo:一条长会话几十张卡,每张里头是整树 Markdown");
assert.ok(/const NO_BG: BgTask\[\] = \[\];/.test(CHAT) && /: NO_BG;/.test(CHAT),
  "没有后台任务时要给同一个 NO_BG 常量,现造 [] 会把每张卡的 memo 顶掉");
assert.ok(/const onPerm = useCallback<OnPermission>\(/.test(CHAT),
  "onPerm 要提到组件顶层 useCallback —— 留在渲染 IIFE 里每次都是新函数");
assert.ok(/const settle = useMemo\(\(\) => running \? null : aggregateRound\(items, anchorTs \|\| items\[0\]\?\.ts\), \[running, items, anchorTs\]\);/.test(CHAT),
  "settle 要在卡片内部算:在调用处现算每次都是新对象,memo 白搭");
assert.ok(/const onClick = \(\) => onShowTurn\(anchorTs\);/.test(CHAT),
  "详情回调要卡片内部合成,别让调用方传 () => onShowTurn(anchor)");
// 历史卡片那一支不传 liveInput:它只喂给 running 分支的 WorkBody,传了等于每次上下文一变就全排重渲
// 别用 [^>]* 卡边界:props 里一旦出现箭头函数(正是要抓的那种破坏),`=>` 里的 > 会把匹配提前切断,
// 结果报的是"没找到这一支",而不是真正的原因。
const histCard = /: <AgentTurnCard [\s\S]*?\/>\}/.exec(CHAT);
assert.ok(histCard, "没找到历史卡片那一支的渲染");
assert.ok(!/liveInput=/.test(histCard[0]), "历史卡片不该收 liveInput(只有 running 那支用得上)");
for (const p of ["items={g.agent}", "bgWait={bgWait}", "onShowTurn={onShowTurn}", "onPermission={onPerm}"]) {
  assert.ok(histCard[0].includes(p), `历史卡片缺 ${p} —— props 换了就得回头检查 memo 还成不成立`);
}
assert.ok(!/onClick=\{\(\) =>/.test(histCard[0]), "历史卡片又传回内联箭头了,memo 会失效");

// ---------- 2c. 只用方法的组件不该订阅 state ----------
assert.ok(/export const useApi = \(\) => useContext\(ApiCtx\);/.test(STORE), "useApi 没了:只要方法的组件又得连 state 一起订");
assert.ok(/const api = useMemo<Api>\(\(\) => \(\{/.test(STORE) && /\}\), \[\]\);/.test(STORE),
  "api 要 useMemo 且依赖为空 —— 身份一变,useApi 的消费者照样每次重渲染");
assert.ok(!/^\s+state,\s*dispatch,$/m.test(STORE), "state 不该再挂在 api 上(它走 StateCtx)");

// ---------- 3. 单槽原图缓存:命中/替换/超时清理三条路 ----------
// 复刻 store.tsx 那份的行为,验证"只留最近一张"和"清理只清自己那张"。
let fullHit = null;
const put = (id) => { fullHit = { id, p: `P:${id}` }; };
const get = (id) => (fullHit?.id === id ? fullHit.p : undefined);
const drop = (id) => { if (fullHit?.id === id) fullHit = null; };
put("a:full");
assert.equal(get("a:full"), "P:a:full", "刚存的要命中(连点两下不该发两次请求)");
put("b:full");
assert.equal(get("a:full"), undefined, "换一张后旧的必须让位,否则原图就是只涨不降");
drop("a:full");
assert.equal(get("b:full"), "P:b:full", "超时清理只该清自己那张,不能顺手把当前这张清了");
drop("b:full");
assert.equal(get("b:full"), undefined, "清掉自己那张后要能重试");

assert.ok(/let fullHit: \{ id: string; p: Promise<string \| null> \} \| null = null;/.test(STORE),
  "原图要走单槽,别退回 Map(几 MB 一张,全缓住内存只涨不降)");
assert.ok(/if \(full\) fullHit = \{ id, p \}; else blobCache\.set\(id, p\);/.test(STORE),
  "缩略图进 Map、原图进单槽 —— 两条路都要在");
assert.ok(/dropBlob\(id, full\)/.test(STORE), "超时兜底要按 full 分流清理,不然清了个寂寞");

// ---------- 4. 删会话要带走它的 localStorage ----------
assert.ok(/localStorage\.removeItem\(ctxKey\(id\)\)/.test(STORE),
  "删会话没清 cc-ctx-<id>:会话 id 不复用,这条键之后永远读不到,只增不减");

console.log("✓ render-cache 自检通过");
