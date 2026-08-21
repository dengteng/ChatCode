// 从 sidecar/providers.mjs 生成远程模型清单 catalog/models.json。
//   node scripts/gen-catalog.mjs
//
// 为什么要生成而不是手写:清单必须和内置表同源。手写就是第二份真相 —— 加模型时忘了同步,
// 老用户拿到的清单反而比新版还旧,且这种不一致没人会发现(两边都"看起来对")。
//
// 加完模型的流程:改 providers.mjs → 跑这个脚本 → 提交。清单在仓库里,推上去老用户当天就能拉到。
// 注意:清单**不含 baseUrl / smallFast / transport**,只有模型元数据 —— 这是死线,不是省事,
// 理由见 providers.mjs 的「安全边界」。这里也只挑那几个字段,即使将来 providers 上加了新字段。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../sidecar/providers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "catalog", "models.json");
const FIELDS = ["model", "displayName", "description", "contextWindow", "vision", "price"];

const providers = {};
for (const p of Object.values(PROVIDERS)) {
  if (p.id === "claude") continue; // claude 的列表来自 SDK supportedModels,不归清单管
  // 声明了 variants 的家(Kimi),p.models 是空的 —— 各候选的模型表不一样,合起来取并集:
  // 清单只是"有哪些模型可选",端点/计费形态照旧由本地那份 variants 决定。
  const lists = p.variants?.length ? p.variants.map((v) => v.models || []) : [p.models || []];
  const seen = new Map();
  for (const list of lists) {
    for (const m of list) {
      if (!m?.model || seen.has(m.model)) continue;
      const clean = {};
      for (const k of FIELDS) if (m[k] !== undefined) clean[k] = m[k];
      seen.set(m.model, clean);
    }
  }
  if (seen.size) providers[p.id] = [...seen.values()];
}

const out = { version: 1, providers };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`写入 ${path.relative(ROOT, OUT)}:${Object.keys(providers).length} 家 / ${Object.values(providers).reduce((n, l) => n + l.length, 0)} 个模型`);
