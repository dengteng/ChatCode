// 按量计费 provider 的花费账本(纯函数,单独一个文件是为了能直接测,见 spend.check.mjs)。
//
// 为什么需要:Claude / Kimi 是订阅制,用量条显示 5h、周两个窗口;DeepSeek 这类按 token 计费的
// 根本没有这套窗口,用量条上那两格就永远空着 —— 用户真正想看的是"这个会话烧了多少"。
//
// 单价**不写死在代码里**:各家调价频繁、还分币种(DeepSeek 计人民币、OpenAI 计美元),
// 和 baseUrl / 模型表同一个理由 —— 放设置里的模型表(price 字段),代码只管算。
// 没填单价就只累计 token,绝不按猜的价格显示金额(显示错的钱比不显示更糟)。
import { PROVIDERS, resolvedProvider } from "./providers.mjs";

const M = 1_000_000; // 单价一律按「每 100 万 token」计,和各家价目表一致

export const emptySpend = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, currency: "", unpriced: false });

// 模型 id -> { in, out, cacheRead?, cacheWrite?, currency? }。取合并后的模型表(用户覆盖优先)。
export function priceTable(settings) {
  const t = new Map();
  for (const p of Object.values(PROVIDERS)) {
    if (p.id === "claude") continue; // 订阅制,不走这条路
    for (const m of resolvedProvider(p.id, settings)?.models ?? []) {
      if (m?.price && m?.model) t.set(m.model, m.price);
    }
  }
  return t;
}

// SDK 的 usage 有两套键名:result.usage 是下划线,modelUsage 里是驼峰。两套都认。
// input_tokens 不含缓存读写,三者分开计价(缓存命中通常便宜一个数量级)。
const norm = (u) => ({
  in: u?.input_tokens ?? u?.inputTokens ?? 0,
  out: u?.output_tokens ?? u?.outputTokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? u?.cacheReadInputTokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? u?.cacheCreationInputTokens ?? 0,
});

// 把一条 result 消息累加进账本(原地改并返回)。
// 优先用 modelUsage 的按模型细分:主模型和背景小模型(ANTHROPIC_SMALL_FAST_MODEL)价差常有一个数量级,
// 混在一起按主模型价算会高估。没有细分才退回 result.usage + 会话当前模型。
// fallbackModel = 去掉 provider 前缀的真实模型 id。
export function accumulate(spend, msg, table, fallbackModel = "") {
  const mu = msg?.modelUsage;
  const parts = mu && Object.keys(mu).length
    ? Object.entries(mu).map(([model, u]) => [model, norm(u)])
    : [[fallbackModel, norm(msg?.usage)]];
  for (const [model, u] of parts) {
    spend.in += u.in; spend.out += u.out; spend.cacheRead += u.cacheRead; spend.cacheWrite += u.cacheWrite;
    const p = table.get(model);
    if (!p) {
      // 这批 token 算不出钱。标记出来,前端据此改说"含未计价部分",别让人把半截数字当全额。
      if (u.in || u.out || u.cacheRead || u.cacheWrite) spend.unpriced = true;
      continue;
    }
    // 缓存读/写没单独标价就按输入价算(多数家的缓存写价 = 输入价)
    spend.cost += (u.in * (p.in ?? 0) + u.out * (p.out ?? 0)
      + u.cacheRead * (p.cacheRead ?? p.in ?? 0) + u.cacheWrite * (p.cacheWrite ?? p.in ?? 0)) / M;
    if (p.currency) spend.currency = p.currency;
  }
  return spend;
}

// ---------- 日账本:provider × 自然日的花费流水 ----------
// 为什么另立一本:per-session 的 spend 回答不了"今天/这个月一共烧了多少"(会话有几十个),
// 而 DeepSeek 这类只提供「账户余额」接口,官方没有消费查询 API —— 今日/本月只能自己记。
// 只记算得出钱的部分:没单价的 token 记进来也是 0,反而让人以为免费。
const KEEP_DAYS = 70; // 够算"本月"还留富余;再老的没人看,别让 settings.json 无限长

export const dayKey = (ts) => {
  const d = new Date(ts); // 本地时区:用户说的"今天"是他日历上的今天,不是 UTC 的
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function ledgerAdd(ledger, provider, cost, currency, ts) {
  if (!(cost > 0)) return ledger || {};
  const book = { ...(ledger?.[provider] || {}) };
  const k = dayKey(ts);
  const cur = book[k] || { cost: 0, currency: "" };
  book[k] = { cost: cur.cost + cost, currency: currency || cur.currency };
  const keys = Object.keys(book).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete book[old];
  return { ...(ledger || {}), [provider]: book };
}

// 今日 / 本月(当前自然月)合计
export function ledgerStats(ledger, provider, ts) {
  const book = ledger?.[provider] || {};
  const today = dayKey(ts), month = today.slice(0, 7);
  let d = 0, m = 0, currency = "";
  for (const [k, v] of Object.entries(book)) {
    if (!k.startsWith(month)) continue;
    m += v?.cost || 0;
    if (k === today) d += v?.cost || 0;
    if (v?.currency) currency = v.currency;
  }
  return { today: d, month: m, currency };
}
