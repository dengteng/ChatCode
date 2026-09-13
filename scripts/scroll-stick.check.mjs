#!/usr/bin/env node
// 「跟随底部」开关的自检。规则本体在 src/components/Chat.tsx 的 onTimelineScroll(tsx 没法直接 import),
// 这里照抄一份再断言源码没漂移 —— 和 model-name.check.mjs 同一套路。
//
// 症结:流式回复时内容每帧都在长。只按"离底多远"判跟随的话,用户往上滑的那几十像素还在 80px 以内,
// 跟随不断,下一帧又被钉回底 —— 滑一点被拽回一点,就是肉眼看到的气泡上下抖。
//
// 跑法:node scripts/scroll-stick.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/components/Chat.tsx", "utf8");
assert.ok(SRC.includes("const onTimelineScroll ="), "Chat 的 onTimelineScroll 已漂移");
assert.ok(SRC.includes("el.scrollTop < lastTop.current - 1"), "必须按方向判定:往上翻一律断开跟随,不看离底多远");
assert.ok(SRC.includes("performance.now() - progAt.current < 150"), "编程式滚动必须排除,否则补重绘那 1px 会被当成用户往上翻");
assert.ok(SRC.includes("const markProg ="), "markProg 已漂移");
// 每一处编程式写 scrollTop 都要报备,漏一处那一处就会被当成用户意图
assert.ok(SRC.includes("markProg(); el.scrollTop = el.scrollHeight;"), "钉底没报备");
assert.ok(SRC.includes("markProg(); el.scrollTop = landed;"), "切会话恢复位置没报备");
assert.ok(SRC.includes("markProg(); el.scrollTop = target;"), "往前翻历史的补位没报备");
assert.ok(SRC.includes('markProg(); hit.scrollIntoView({ block: "center" });'), "跳转到某条消息没报备");
// pokeRepaint 两帧都要复查 ok:只查第一帧的话,"第一帧还贴底、第二帧人已翻上去"会把人拽回底部
assert.equal((SRC.match(/if \(!ok\(\)\) return;/g) || []).length, 2, "pokeRepaint 必须两帧各查一次 ok");

// 规则本体(照抄):返回新的 stick
const decide = (stick, { scrollTop, lastTop, dist, prog }) => {
  if (prog) return stick;
  if (scrollTop < lastTop - 1) return false;
  if (dist < 80) return true;
  return stick;
};

// —— 流式中往上翻:哪怕只挪了 30px、还贴在底部附近,也必须断开跟随 ——
assert.equal(decide(true, { scrollTop: 970, lastTop: 1000, dist: 30, prog: false }), false,
  "这一条就是气泡抖动的根:滑 30px 还在 80px 以内,旧规则会保持跟随、下一帧把人拽回底");
// —— 自己滑回底部附近:恢复跟随 ——
assert.equal(decide(false, { scrollTop: 1000, lastTop: 970, dist: 10, prog: false }), true);
// —— 往下滑但离底还远:不恢复(别滑到一半就被接管) ——
assert.equal(decide(false, { scrollTop: 500, lastTop: 400, dist: 900, prog: false }), false);
// —— 编程式滚动一律不改状态 ——
assert.equal(decide(true, { scrollTop: 999, lastTop: 1000, dist: 1, prog: true }), true,
  "补重绘那 1px 是往上的,不排除就等于每次重绘都替用户「往上翻」");
assert.equal(decide(false, { scrollTop: 1000, lastTop: 300, dist: 0, prog: true }), false,
  "钉底自己滚到底,不能借此把跟随重新点亮 —— 否则和用户抢方向盘,一拽一放就是抖");
// —— 1px 抖动不算方向(阈值是 -1):浏览器的亚像素回填不该断开跟随 ——
assert.equal(decide(true, { scrollTop: 999.5, lastTop: 1000, dist: 0.5, prog: false }), true);

// —— 连续帧模拟:流式增长中用户持续往上滑,不能出现"被拽回底部"的帧 ——
let stick = true, top = 1000, height = 1000;
for (let f = 0; f < 20; f++) {
  height += 40;                    // 每帧长 40px 新内容
  top -= 20;                       // 用户每帧往上滑 20px
  stick = decide(stick, { scrollTop: top, lastTop: top + 20, dist: height - top, prog: false });
  assert.equal(stick, false, `第 ${f} 帧跟随又被点亮了,下一帧就会把用户拽回底部`);
}

console.log("✅ scroll-stick: 往上翻即断跟随 / 回底恢复 / 编程式滚动不算意图 / 亚像素不误判 / 连续帧不回拽 全部通过");
