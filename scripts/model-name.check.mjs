#!/usr/bin/env node
// default 模型显示名的自检。规则本体在 src/types.ts 的 modelName()(tsx/ts 没法直接 import),
// 这里照抄一份再断言源码没漂移 —— 和 bg-progress.check.mjs 同一套路。
// 样本是 ~/.ChatCode/settings.json 里 SDK 真实上报的 claudeModels,不是手编的。
//
// 跑法:node scripts/model-name.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/types.ts", "utf8");
assert.ok(SRC.includes("export function modelName"), "types.ts 的 modelName 已漂移");
assert.ok(SRC.includes('x.value !== "default"'), "必须排除 default 自身,否则会匹配到自己绕回英文原名");
assert.ok(SRC.includes('replace(/\\s*[(（].*$/'), "必须剥掉被引用模型自己的括号补充,否则括号会套两层");
assert.ok(SRC.includes('i18n.t("默认")'), "「默认」必须走 t(),否则不跟界面语言");
assert.ok(SRC.includes("function modelVer"), "types.ts 的 modelVer 已漂移");
assert.ok(SRC.includes("/^\\d{1,2}$/.test(s)"), "版本段必须限死 1~2 位,否则尾部日期戳会被当成版本号");

const t = (s) => (s === "默认" ? "Default" : s); // 模拟 en 界面
const modelVer = (id) => {
  const segs = (id ?? "").replace(/\[.*$/, "").split("-").slice(2);
  const v = [];
  for (const s of segs) { if (!/^\d{1,2}$/.test(s)) break; v.push(s); }
  return v.join(".");
};
const withVer = (m) => {
  const i = m.displayName.search(/\s*[(（]/);
  const head = (i < 0 ? m.displayName : m.displayName.slice(0, i)).trim();
  if (/\d/.test(head)) return m.displayName;
  const ver = modelVer(m.resolvedModel ?? m.model ?? m.value);
  return ver ? `${head} ${ver}${i < 0 ? "" : m.displayName.slice(i)}` : m.displayName;
};
const modelName = (models, m) => {
  if (m.value !== "default") return withVer(m);
  const real = m.resolvedModel;
  const hit = real ? models.find((x) => x.value !== "default" && (x.value === real || x.resolvedModel === real || x.model === real)) : undefined;
  const short = (hit ? withVer(hit).replace(/\s*[(（].*$/, "") : real ?? "").trim();
  return short ? `${t("默认")} (${short})` : t("默认");
};

// SDK 真实上报的那份列表
const LIST = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)" },
  { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
];
const by = (v) => LIST.find((m) => m.value === v);

// —— 核心:default 要说清自己实际跑哪个(带版本号),且不能套两层括号 ——
assert.equal(modelName(LIST, by("default")), "Default (Opus 5)");
assert.ok(!modelName(LIST, by("default")).includes("recommended"), "recommended 对用户零信息量,必须换掉");
assert.ok(!/\(.*\(/.test(modelName(LIST, by("default"))), "「Default (Opus (1M context))」这种套娃不许出现");

// —— 非 default:补版本号,其余原样 ——
assert.equal(modelName(LIST, by("sonnet")), "Sonnet 5");
assert.equal(modelName(LIST, by("claude-fable-5[1m]")), "Fable 5");
assert.equal(modelName(LIST, by("opus[1m]")), "Opus 5 (1M context)"); // 用户显式选的 1M,括号该留着
// 日期戳不是版本号:claude-haiku-4-5-20251001 只能出 4.5
assert.equal(modelName(LIST, by("haiku")), "Haiku 4.5");

// —— 只有 default 一条:不能匹配到自己,否则又绕回英文原名 ——
const ONLY = [LIST[0]];
assert.equal(modelName(ONLY, ONLY[0]), "Default (claude-opus-5[1m])", "查不到就退回裸 id,也好过 recommended");

// —— 非 claude 家族:切不出版本就别猜,原样用 SDK 的名字 ——
assert.equal(modelName([], { value: "deepseek-v4-pro", resolvedModel: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }), "DeepSeek V4 Pro");
// displayName 自带数字了就不加第二遍(括号里的 1M 不算 —— 那是上下文窗口)
assert.equal(modelName([], { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" }), "Opus 4.8");

// —— 连 resolvedModel 都没有(老缓存 / 第三方 provider):只说「默认」,不编 ——
assert.equal(modelName([], { value: "default", displayName: "Default (recommended)" }), "Default");

console.log("✅ model-name: default 解析 / 防套娃 / 非 default 原样 / 自匹配排除 / 无解析兜底 全部通过");
