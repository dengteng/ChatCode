#!/usr/bin/env node
// 每会话浏览位置的锚点算术自检。规则本体在 Chat.tsx 里(没法直接 import),这里照抄一份
// 再断言源码没漂移 —— 和 bg-progress.check.mjs 同一套路。
//
// 跑法:node scripts/scroll-memory.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const CHAT = readFileSync("src/components/Chat.tsx", "utf8");
for (const frag of ["const scrollMem = new Map", "pendingRestore", "capRef.current", "elementFromPoint"])
  assert.ok(CHAT.includes(frag), `Chat.tsx 与本检查已漂移,缺: ${frag}`);

// rowAt = 锚行在滚动层里的位置(row.offsetTop)。浏览器给的是视口坐标,
// 两者的关系恒为 rowTop - elTop === rowAt - scrollTop,下面按这个换算造样本。
const seen = (scrollTop, rowAt) => ({ top: scrollTop, off: rowAt - scrollTop });
// 回来时:把同一行摆回同样的偏移。row 找不到就退回死记的 scrollTop。
const restore = (p, cur, max) => {
  const top = cur.rowAt == null ? p.top : cur.scrollTop + (cur.rowAt - cur.scrollTop) - p.off;
  return Math.max(0, Math.min(top, max));
};

// 离开时:视口停在 4000,视口顶那一行在 3970 —— 被切掉了 30px
const P = seen(4000, 3970);
assert.deepEqual(P, { top: 4000, off: -30 });

// —— 场景 1:离开期间什么都没变(锚行还在 3970),原样回到 4000 ——
// cur.scrollTop 取一个乱七八糟的值,证明结果只由锚行决定、与当前滚到哪无关。
assert.equal(restore(P, { scrollTop: 9000, rowAt: 3970 }, 20000), 4000, "无变化时应精确回到原位");
assert.equal(restore(P, { scrollTop: 0, rowAt: 3970 }, 20000), 4000);

// —— 场景 2:离开期间这个会话又长了消息,窗口把更早的回合挤掉,锚行整体上移 600px ——
// 死记 scrollTop 会指到别的内容上;按锚行对齐才跟得住。
{
  const back = restore(P, { scrollTop: 4000, rowAt: 3370 }, 20000);
  assert.equal(back, 3400, "内容上移后应跟着锚行走,而不是停在旧 scrollTop");
  assert.equal(back, P.top - 600);
}

// —— 场景 3:锚行已经不在渲染窗口里(翻得太久/被 /clear 清空),退回 scrollTop 并夹紧 ——
assert.equal(restore(P, { scrollTop: 0, rowAt: null }, 20000), 4000);
assert.equal(restore(P, { scrollTop: 0, rowAt: null }, 1200), 1200, "内容变短时必须夹到底,不能越界");
assert.equal(restore({ top: -50, off: 0 }, { scrollTop: 0, rowAt: null }, 1200), 0, "不能是负数");

// —— 场景 4:当时就贴着底 → 不恢复位置,回到底看最新 ——
assert.ok(/if \(p && !p\.stick && /.test(CHAT), "贴底的会话必须直接回到底部,而不是恢复旧位置");

console.log("✅ scroll-memory: 原位 / 内容增长 / 锚行丢失 / 贴底 四种情形全部通过");
