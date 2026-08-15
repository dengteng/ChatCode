#!/usr/bin/env node
// en.json 完整性检查 —— 中文当键这套策略的固有税:改一句中文文案,en.json 里那条就静默变孤儿,
// 英文用户继续看旧翻译或直接看到新中文,而且没有任何报错。这个脚本就是那道缺失的报错。
//
// 查三样:
//   1. 孤儿键   en.json 有、src 里已经找不到这句中文 → 多半是文案改过忘了同步
//   2. 未译键   src 里 t("中文") 了、en.json 没有        → 新写的文案漏翻
//   3. ID 键    zh.json / en.json 两边键集合必须一致,且代码里真被引用
//
// 跑法:node scripts/i18n-check.mjs   (有问题 exit 1,可直接挂 CI / pre-commit)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const EN = "src/i18n/en.json";
const ZH = "src/i18n/zh.json";
const hasCJK = (s) => /[一-龥]/.test(s);

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    if (statSync(fp).isDirectory()) walk(fp, out);
    else if (/\.(tsx?|mjs)$/.test(f)) out.push(fp);
  }
  return out;
}

const files = walk(SRC);
const en = JSON.parse(readFileSync(EN, "utf8"));
const zh = JSON.parse(readFileSync(ZH, "utf8"));

const sources = files.map((f) => [f, readFileSync(f, "utf8")]);

// 某个键的文本在源码里出没出现过。用"转义后的形态"直接子串匹配 —— 不解析 JS 语法。
// 为什么不老老实实抽字符串字面量:一个正则抽不准(模板串里的 ${} 会让引号配对错位,
// 一处错位就把整段源码当成一条字面量,后面全乱)。而这里只需要"有没有",子串匹配就够,
// 还顺带覆盖了配置数组(BUILTIN_COMMANDS / THEMES / TABS)那种中文留定义处、渲染处才 t(label) 的写法。
// 代价:写在注释里的同一句中文也算数(漏报),比误报 378 条强。
function appears(key) {
  const esc = JSON.stringify(key).slice(1, -1); // 真换行 → 源码里的 \n
  // 两种形态都试:esc 命中双引号写法,key 原样命中单引号写法(键里带 " 时就是这么写的)
  return sources.some(([, src]) => src.includes(esc) || src.includes(key));
}

// t("…") / i18n.t("…") 的显式键,附带出处,用于报「未译」
const tCalls = new Map();
for (const [f, src] of sources) {
  for (const m of src.matchAll(/\b(?:i18n\.)?t\(\s*"((?:[^"\\\n]|\\.)*)"/g)) {
    let key; try { key = JSON.parse(`"${m[1]}"`); } catch { continue; } // 源码里的 \n 还原成真换行,才跟 json 对得上
    if (!tCalls.has(key)) tCalls.set(key, `${f}:${src.slice(0, m.index).split("\n").length}`);
  }
}

const idKeys = new Set(Object.keys(zh));           // ID 键(同形不同义那几条),中文在 zh.json 里
const orphans = Object.keys(en).filter((k) => (idKeys.has(k) ? !tCalls.has(k) : !appears(k)));
const missing = [...tCalls].filter(([k]) => hasCJK(k) && !(k in en));
const zhOnly = Object.keys(zh).filter((k) => !(k in en));
// 长得像 ID 键(全小写点分,如 diff.added)却没进 zh.json —— 中文模式下会直接把键名显示出来。
// 不能靠"没中文字符"来判:en.json 里本来就有 "Agent"、"claude.ai" 这种键即原文的条目。
const idNoZh = [...tCalls.keys()].filter((k) => /^[a-z0-9]+(\.[a-z0-9]+)+$/.test(k) && !(k in zh));

const say = (title, rows) => { if (rows.length) console.log(`\n${title} (${rows.length})\n` + rows.map((r) => "  " + r).join("\n")); };

say("孤儿键 —— en.json 有,src 里找不到这句中文(文案改过?)", orphans.map((k) => `${JSON.stringify(k)}  →  ${JSON.stringify(en[k])}`));
say("未译键 —— t() 用了,en.json 没有", missing.map(([k, at]) => `${JSON.stringify(k)}  @ ${at}`));
say("ID 键缺英文 —— zh.json 有,en.json 没有", zhOnly);
say("ID 键缺中文 —— t() 用了,zh.json 没有(中文模式会露出键名)", idNoZh);

const bad = orphans.length + missing.length + zhOnly.length + idNoZh.length;
console.log(bad ? `\n✗ ${bad} 处待处理  (en.json ${Object.keys(en).length} 键 / ID 键 ${idKeys.size})`
                : `✓ en.json 干净 (${Object.keys(en).length} 键 / ID 键 ${idKeys.size})`);
process.exit(bad ? 1 : 0);
