// 每天对一遍各家新模型 / 弃用模型,给 .github/workflows/model-watch.yml 用。
//   node scripts/model-watch.mjs <报告.json> <新的已见表.json>
//
// 数据源:models.dev(github.com/sst/models.dev,社区维护的模型库,带上下文、单价、收不收图、是否弃用)。
// 不打各家的 /models 接口:那要在 CI 里放 9 把 API Key,而且大多数家的 /models 只给 id,不给价格和窗口。
//
// 判据:
//   · 新模型 = models.dev 有、内置表没有、已见表里也没有,且近 180 天内发布。
//     已见表(catalog/model-watch-seen.json)记着报过的 id —— 报过一次不管接没接都不再报,
//     否则 OpenAI 那 50 多个模型里不打算接的会天天来一遍。
//   · 该下架 = 内置表里(没标 hidden)的模型在 models.dev 标了 deprecated,或者以前见过、现在没了。
//     从来没在 models.dev 出现过的(Kimi 编程订阅的 k3 / kimi-for-coding)不算没了。
// 报告只带结构化字段(id、名字、日期、窗口、单价、模态),不带 description:报告要喂给 Claude,
// 外部来的自由文本越少,被塞指令的口子越小。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../sidecar/providers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEEN_FILE = path.join(ROOT, "catalog", "model-watch-seen.json");
const RECENT_DAYS = 180;

// ChatCode 的 provider id → models.dev 的 provider id。同一家的国际站 / 国内站都列上,并集去重。
// pick:那个 provider 下还挂着别家模型(阿里百炼也卖 GLM、Kimi),只认自家前缀。
export const SOURCES = {
  deepseek: { from: ["deepseek"] },
  kimi: { from: ["moonshotai", "moonshotai-cn"] },
  glm: { from: ["zai", "zhipuai"] },
  qwen: { from: ["alibaba", "alibaba-cn"], pick: /^qwen/i },
  minimax: { from: ["minimax", "minimax-cn"] },
  grok: { from: ["xai"] },
  openai: { from: ["openai"] },
  gemini: { from: ["google"] },
};

// 能当 ChatCode 对话模型的:会调工具、只出文字。生图 / 语音 / 向量模型接进来也用不了。
const usable = (m) => m?.tool_call === true && JSON.stringify(m?.modalities?.output || ["text"]) === '["text"]';

// 内置表里每家的模型 id(Kimi 这种有 variants 的取并集)和标了 hidden 的那些
export function oursOf(providers = PROVIDERS) {
  const out = {};
  for (const id of Object.keys(SOURCES)) {
    const p = providers[id];
    if (!p) continue;
    const lists = p.variants?.length ? p.variants.map((v) => v.models || []) : [p.models || []];
    const all = new Set(), hidden = new Set();
    for (const m of lists.flat()) {
      if (!m?.model) continue;
      all.add(m.model);
      if (m.hidden) hidden.add(m.model);
    }
    out[id] = { all, hidden };
  }
  return out;
}

const brief = (m) => ({
  id: m.id,
  name: String(m.name || "").slice(0, 60),
  family: m.family,
  release: m.release_date,
  status: m.status,
  context: m.limit?.context,
  vision: (m.modalities?.input || []).includes("image"),
  cost: m.cost, // 美元 / 百万 token,国内家的人民币价要另查官网
});

// 纯函数,方便 check。md = models.dev 的 api.json;seen = { provider: [id…] };today = "YYYY-MM-DD"
export function diff(ours, md, seen, today) {
  const since = new Date(Date.parse(today) - RECENT_DAYS * 86400_000).toISOString().slice(0, 10);
  const added = {}, retired = {}, nextSeen = {};
  for (const [id, src] of Object.entries(SOURCES)) {
    const theirs = new Map();
    for (const pid of src.from) {
      for (const m of Object.values(md?.[pid]?.models || {})) {
        if (!m?.id || (src.pick && !src.pick.test(m.id)) || !usable(m)) continue;
        if (!theirs.has(m.id)) theirs.set(m.id, m);
      }
    }
    // models.dev 某天整家拉不到(改名、接口抽风),别把这家的模型全报成"没了"
    if (!theirs.size) { nextSeen[id] = seen?.[id] || []; continue; }
    const had = new Set(seen?.[id] || []);
    const { all = new Set(), hidden = new Set() } = ours[id] || {};

    const add = [...theirs.values()].filter((m) =>
      !all.has(m.id) && !had.has(m.id) && m.status !== "deprecated" && (m.release_date || "") >= since);
    if (add.length) added[id] = add.map(brief).sort((a, b) => String(b.release).localeCompare(String(a.release)));

    const gone = [...all].filter((x) => !hidden.has(x)).flatMap((x) => {
      const m = theirs.get(x);
      if (m?.status === "deprecated") return [{ id: x, why: "models.dev 标了 deprecated" }];
      if (!m && had.has(x)) return [{ id: x, why: "models.dev 上已经没有这个模型" }];
      return [];
    });
    if (gone.length) retired[id] = gone;

    nextSeen[id] = [...new Set([...had, ...theirs.keys()])].sort();
  }
  return { added, retired, seen: nextSeen };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reportFile, seenOut] = process.argv.slice(2);
  if (!reportFile || !seenOut) { console.error("用法: node scripts/model-watch.mjs <报告.json> <新的已见表.json>"); process.exit(2); }
  const r = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`models.dev HTTP ${r.status}`);
  const md = await r.json();
  const seen = fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : {};
  const { added, retired, seen: next } = diff(oursOf(), md, seen, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(reportFile, JSON.stringify({ added, retired }, null, 2) + "\n");
  fs.writeFileSync(seenOut, JSON.stringify(next, null, 2) + "\n");
  const n = (o) => Object.values(o).reduce((s, l) => s + l.length, 0);
  console.log(`新模型 ${n(added)} 个,该下架 ${n(retired)} 个`);
  for (const [id, l] of Object.entries(added)) console.log(`  + ${id}: ${l.map((m) => m.id).join(", ")}`);
  for (const [id, l] of Object.entries(retired)) console.log(`  - ${id}: ${l.map((m) => m.id).join(", ")}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${n(added) + n(retired) > 0}\nsummary=新模型 ${n(added)} 个,该下架 ${n(retired)} 个\n`);
}
