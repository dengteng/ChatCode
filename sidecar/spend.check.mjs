// 花费账本自检(纯函数,秒回):
//   node sidecar/spend.check.mjs
import assert from "node:assert";
import { emptySpend, priceTable, accumulate, effPrice, ledgerAdd, ledgerStats, dayKey } from "./spend.mjs";

// 设置里给 DeepSeek 两个模型填了单价(每 100 万 token,人民币),背景小模型比主模型便宜一个数量级
const settings = {
  providerKeys: { deepseek: "k" },
  providerConfig: {
    deepseek: {
      models: [
        { value: "deepseek/pro", model: "pro", displayName: "Pro", price: { in: 2, out: 3, cacheRead: 0.2, currency: "¥" } },
        { value: "deepseek/flash", model: "flash", displayName: "Flash", price: { in: 0.2, out: 0.3, currency: "¥" } },
      ],
    },
  },
};
const table = priceTable(settings);
assert.strictEqual(table.size, 2);

// 1. 按模型分别计价:主模型 100 万输入 + 100 万输出,小模型 100 万输入
const s = accumulate(emptySpend(), {
  modelUsage: {
    pro: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
    flash: { inputTokens: 1_000_000, outputTokens: 0 },
  },
}, table);
assert.strictEqual(s.in, 2_000_000);
assert.strictEqual(s.out, 1_000_000);
assert.strictEqual(s.cacheRead, 1_000_000);
// pro: 2 + 3 + 0.2 = 5.2;flash: 0.2 → 5.4。混在一起按主模型价算会得 7.2,那就高估了
assert.ok(Math.abs(s.cost - 5.4) < 1e-9, `算出来 ${s.cost}`);
assert.strictEqual(s.currency, "¥");
assert.strictEqual(s.unpriced, false);
console.log("✓ 按模型分别计价(主模型/背景小模型价差不被抹平)");

// 2. 累加:第二轮接着加,不是覆盖
accumulate(s, { modelUsage: { flash: { inputTokens: 1_000_000 } } }, table);
assert.ok(Math.abs(s.cost - 5.6) < 1e-9, `算出来 ${s.cost}`);
console.log("✓ 逐轮累加");

// 3. 没有 modelUsage 细分时退回 result.usage(下划线键名)+ 会话当前模型
const s2 = accumulate(emptySpend(), { usage: { input_tokens: 1_000_000, output_tokens: 0 } }, table, "pro");
assert.strictEqual(s2.in, 1_000_000);
assert.ok(Math.abs(s2.cost - 2) < 1e-9);
console.log("✓ 无细分时退回 result.usage");

// 4. 没填单价:token 照记,金额为 0 并标记 unpriced —— 绝不按猜的价显示钱
const s3 = accumulate(emptySpend(), { modelUsage: { unknown: { inputTokens: 999, outputTokens: 1 } } }, table);
assert.strictEqual(s3.in, 999);
assert.strictEqual(s3.cost, 0);
assert.strictEqual(s3.unpriced, true);
console.log("✓ 无单价只记 token,不编金额");

// 5. 空 usage 不该把账本标脏
const s4 = accumulate(emptySpend(), { modelUsage: { unknown: {} } }, table);
assert.strictEqual(s4.unpriced, false);
console.log("✓ 空 usage 不误标未计价");

// 6. 出厂价:空设置也能查到 DeepSeek 单价(每百万 token,人民币);单位写错会在这里露馅。
// 外层是高峰价,offPeak 是空闲价 —— 必须传定死的时刻进去算,否则这条断言会随跑测的钟点在两个值之间跳。
const stock = priceTable({});
const proPrice = stock.get("deepseek-v4-pro");
assert.strictEqual(proPrice.in, 9);
assert.strictEqual(proPrice.out, 27);
assert.strictEqual(proPrice.cacheRead, 0.3);
assert.strictEqual(proPrice.currency, "¥");
assert.strictEqual(proPrice.offPeak.out, 13.5, "空闲价是五折");
const noon = Date.UTC(2026, 7, 22, 2); // 北京 10:00,高峰
const s5 = accumulate(emptySpend(), { modelUsage: { "deepseek-v4-pro": { inputTokens: 1_000_000, outputTokens: 1_000_000 } } }, stock, "", noon);
assert.ok(Math.abs(s5.cost - 36) < 1e-9 && s5.currency === "¥", `算出来 ${s5.cost}`);
console.log("✓ DeepSeek 出厂价可查且单位正确");

// 7. 日账本:同一天累加、跨月不混入本月、0 元不记账
const t1 = new Date(2026, 7, 15, 10, 0).getTime(); // 2026-08-15 本地时间
const t2 = new Date(2026, 7, 15, 23, 0).getTime();
const t3 = new Date(2026, 7, 14, 9, 0).getTime();
const tPrev = new Date(2026, 6, 31, 9, 0).getTime(); // 上个月
let led = ledgerAdd(undefined, "deepseek", 1.5, "¥", t1);
led = ledgerAdd(led, "deepseek", 0.5, "¥", t2);
led = ledgerAdd(led, "deepseek", 2, "¥", t3);
led = ledgerAdd(led, "deepseek", 99, "¥", tPrev);
led = ledgerAdd(led, "deepseek", 0, "¥", t1); // 没算出钱的轮次不该产生条目
const st = ledgerStats(led, "deepseek", t2);
assert.ok(Math.abs(st.today - 2) < 1e-9, `今日 ${st.today}`);
assert.ok(Math.abs(st.month - 4) < 1e-9, `本月 ${st.month}`); // 上月那 99 不算进来
assert.strictEqual(st.currency, "¥");
assert.strictEqual(ledgerStats(led, "grok", t2).month, 0); // 别家的账不串台
console.log("✓ 日账本:同日累加、按自然月汇总、跨月不串");

// 8. 裁剪:只留最近 70 天,settings.json 不会无限长
let big = {};
for (let i = 0; i < 100; i++) big = ledgerAdd(big, "deepseek", 1, "¥", t1 - i * 86400_000);
assert.strictEqual(Object.keys(big.deepseek).length, 70);
assert.ok(big.deepseek[dayKey(t1)], "最新的一天必须留着");
console.log("✓ 老账目自动裁剪");

// 9. 峰谷分时价:按**北京时间**判,不看本机时区
const tp = { in: 3, out: 9, cacheRead: 0.1, currency: "¥", offPeak: { in: 1.5, out: 4.5, cacheRead: 0.05, peakHours: [[9, 12], [14, 18]] } };
const at = (utcHour, utcMin = 0) => Date.UTC(2026, 7, 22, utcHour, utcMin); // UTC+8 = 北京时间
assert.strictEqual(effPrice(tp, at(0, 59)).in, 1.5, "北京 08:59,还没开峰");
assert.strictEqual(effPrice(tp, at(1)).in, 3, "北京 09:00 整,高峰起点算在内");
assert.strictEqual(effPrice(tp, at(3, 59)).in, 3, "北京 11:59,还在高峰");
assert.strictEqual(effPrice(tp, at(4)).in, 1.5, "北京 12:00 整,午休已是空闲(半开区间)");
assert.strictEqual(effPrice(tp, at(5)).in, 1.5, "北京 13:00,午休空闲");
assert.strictEqual(effPrice(tp, at(6)).in, 3, "北京 14:00,下午高峰");
assert.strictEqual(effPrice(tp, at(10)).in, 1.5, "北京 18:00 整,高峰结束");
assert.strictEqual(effPrice(tp, at(16)).in, 1.5, "北京 00:00(跨日回绕),空闲");
assert.strictEqual(effPrice(tp, at(20)).out, 4.5, "北京 04:00,空闲价连 out 一起换");
assert.strictEqual(effPrice(tp, at(20)).currency, "¥", "offPeak 不写 currency,得从外层继承");
assert.strictEqual(effPrice({ in: 1, out: 2 }, at(20)).in, 1, "没有 offPeak 的家原样返回");
assert.strictEqual(effPrice(undefined, at(20)), undefined, "没价就是没价,别造一个出来");
console.log("✓ 峰谷价按北京时间切换");

// 10. accumulate 认这个:同一笔用量,高峰算出来正好是空闲的两倍
const pt = new Map([["ds", tp]]);
const usage = { modelUsage: { ds: { inputTokens: 1_000_000, outputTokens: 1_000_000 } } };
const peakCost = accumulate(emptySpend(), usage, pt, "", at(2)).cost;   // 北京 10:00
const offCost = accumulate(emptySpend(), usage, pt, "", at(20)).cost;   // 北京 04:00
assert.ok(Math.abs(peakCost - 12) < 1e-9, `高峰 ${peakCost}`);
assert.ok(Math.abs(offCost - 6) < 1e-9, `空闲 ${offCost}`);
console.log("✓ 分时价接进花费累加");

console.log("all ok");
