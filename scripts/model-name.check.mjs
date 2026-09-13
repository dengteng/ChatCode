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
  const own = /^default\b/i.test(m.displayName) ? "" : withVer(m).replace(/\s*[(（].*$/, "").trim();
  const short = (hit ? withVer(hit).replace(/\s*[(（].*$/, "").trim() : own || (real ?? "")).trim();
  return short || t("默认");
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

// —— 核心:default 直接给出它实际跑的那个模型名(带版本号),不包「默认 (…)」——
// 这个名字会出现在底部模型条、气泡头、额度提示里,那些地方问的都是"现在用哪个模型"。
assert.equal(modelName(LIST, by("default")), "Opus 5");
assert.ok(!modelName(LIST, by("default")).includes("recommended"), "recommended 对用户零信息量,必须换掉");
assert.ok(!/[(（]/.test(modelName(LIST, by("default"))), "default 那条不许再带括号 —— 「默认」只作为菜单标注出现");

// —— 非 default:补版本号,其余原样 ——
assert.equal(modelName(LIST, by("sonnet")), "Sonnet 5");
assert.equal(modelName(LIST, by("claude-fable-5[1m]")), "Fable 5");
assert.equal(modelName(LIST, by("opus[1m]")), "Opus 5 (1M context)"); // 用户显式选的 1M,括号该留着
// 日期戳不是版本号:claude-haiku-4-5-20251001 只能出 4.5
assert.equal(modelName(LIST, by("haiku")), "Haiku 4.5");

// —— 只有 default 一条:不能匹配到自己,否则又绕回英文原名 ——
const ONLY = [LIST[0]];
assert.equal(modelName(ONLY, ONLY[0]), "claude-opus-5[1m]", "查不到就退回裸 id,也好过 recommended");

// —— 去重后菜单里只剩 default 一条(实际常态):sidecar 已把规范名盖到它自己的 displayName 上 ——
const NAMED = { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Opus 5" };
assert.equal(modelName([NAMED], NAMED), "Opus 5", "菜单第一行不许出现裸 id claude-opus-5[1m]");

// —— 非 claude 家族:切不出版本就别猜,原样用 SDK 的名字 ——
assert.equal(modelName([], { value: "deepseek-v4-pro", resolvedModel: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }), "DeepSeek V4 Pro");
// displayName 自带数字了就不加第二遍(括号里的 1M 不算 —— 那是上下文窗口)
assert.equal(modelName([], { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" }), "Opus 4.8");

// —— 连 resolvedModel 都没有(老缓存 / 第三方 provider):只说「默认」,不编 ——
assert.equal(modelName([], { value: "default", displayName: "Default (recommended)" }), "Default");

// ---------- 菜单一行:modelRow / modelProvider / providerBrand ----------
assert.ok(SRC.includes("export function modelRow"), "types.ts 的 modelRow 已漂移");

const modelRow = (models, m) => ({
  name: modelName(models, m).replace(/\s*[(（].*$/, "").trim(),
  note: m.value === "default" ? t("默认") : "",
});
const modelProvider = (m) => m.provider || (m.value.includes("/") ? m.value.split("/")[0] : "claude");

// 括号只留一种用途:标「默认」。名字要和别的行对齐成裸模型名,否则一行里会出现两层括号
assert.deepEqual(modelRow(LIST, by("default")), { name: "Opus 5", note: "Default" });
// 去重后只剩 default 自己时也一样(名字来自 sidecar 盖上去的 displayName)
assert.deepEqual(modelRow([NAMED], NAMED), { name: "Opus 5", note: "Default" });
// 其余一律没有括号 —— 重复入口已在 sidecar 去重,不再需要靠标注区分选哪条
assert.deepEqual(modelRow(LIST, by("opus[1m]")), { name: "Opus 5", note: "" });
assert.deepEqual(modelRow(LIST, { value: "claude-opus-5", model: "claude-opus-5", displayName: "Opus 5", description: "claude-opus-5 · 手动指定" }),
  { name: "Opus 5", note: "" });
// 第三方:版本号写在 displayName 里(不是括号补充),原样显示
assert.deepEqual(modelRow([], { value: "deepseek/deepseek-flash", displayName: "DeepSeek V4.1 Flash", description: "deepseek-flash · 快 · 看图" }),
  { name: "DeepSeek V4.1 Flash", note: "" });

// ---------- 底部模型条:modelLabel / modelInList ----------
// 模型条上的名字必须和菜单里那一行一模一样 —— 用户照着菜单选的,两处叫法不同会以为是两个模型。
assert.ok(SRC.includes("export function modelLabel"), "types.ts 的 modelLabel 已漂移");
assert.ok(SRC.includes("modelRow(session.models, byId).name"), "模型条必须复用菜单那一行的名字,别自己另算一份");
assert.ok(SRC.includes('startsWith(`claude-${fam}`)'), "modelInList 的家族名兜底已漂移:选过 opus[1m] 的会话会显示成裸别名");

const base = (s) => String(s ?? "").replace(/\[.*$/, "").replace(/-\d{8}$/, "");
const modelInList = (models, v) => {
  const hit = models.find((m) => m.value === v || m.resolvedModel === v || m.model === v);
  if (hit || !v) return hit;
  const byBase = models.find((m) => base(m.resolvedModel ?? m.model ?? m.value) === base(v));
  if (byBase) return byBase;
  const fam = base(v).toLowerCase();
  if (fam.includes("-") || fam.includes("/")) return undefined;
  return models.find((m) => base(m.resolvedModel ?? m.model ?? m.value).toLowerCase().startsWith(`claude-${fam}`));
};
const modelLabel = (models, cur) => {
  const byId = cur ? modelInList(models, cur) : undefined;
  if (cur) return byId ? modelRow(models, byId).name : cur;
  const def = models.find((m) => m.value === "default") ?? models[0];
  return def ? modelRow(models, def).name : "";
};

// 去重后的真实菜单:三条入口只剩 default 一条
const MENU = [{ value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Opus 5", contextWindow: 1_000_000 }];
assert.equal(modelLabel(MENU, "opus[1m]"), "Opus 5", "别名对不上任何一行时要按家族名兜住,不能吐 opus[1m]");
assert.equal(modelLabel(MENU, "opus"), "Opus 5");
assert.equal(modelLabel(MENU, "claude-opus-5"), "Opus 5", "老会话存的固定 id 靠归一化找回");
assert.equal(modelLabel(MENU, "default"), "Opus 5", "用默认模型时也报模型名,不报「默认」");
assert.equal(modelLabel(MENU, ""), "Opus 5", "SDK init 还没到(info.model 为空)时按默认行显示,不干等");
// 家族名兜底不许串到别家:带 / 的第三方 id 查不到就老实吐原值
assert.equal(modelLabel(MENU, "deepseek/deepseek-flash"), "deepseek/deepseek-flash");
// 也不许把 sonnet 兜到 opus 上
assert.equal(modelLabel(MENU, "sonnet"), "sonnet");

// provider:SDK 上报的 claude 模型没有 provider 字段,靠 value 里有没有斜杠兜底
assert.equal(modelProvider({ value: "opus[1m]" }), "claude");
assert.equal(modelProvider({ value: "deepseek/deepseek-flash" }), "deepseek");
assert.equal(modelProvider({ value: "kimi/k3", provider: "kimi" }), "kimi");

// ---------- 菜单去重:sidecar 的 dedupeModels ----------
// 规则本体在 sidecar/server.mjs,同样没法直接 import(整个文件一 import 就起服务),照抄一份再断言源码没漂移。
const SIDECAR = readFileSync("sidecar/server.mjs", "utf8");
assert.ok(SIDECAR.includes("function dedupeModels"), "server.mjs 的 dedupeModels 已漂移");
assert.ok(SIDECAR.includes("dedupeModels([...merged"), "去重必须发生在广播前,否则菜单还是重复的");
// 别名行的精确 key 对不上手工表,必须按 baseModelId 再查一次,否则 default 行退回英文原名 → 去重后成裸 id
assert.ok(SIDECAR.includes("manualBy.get(baseModelId(b))"),
  "server.mjs 丢了 baseModelId 兜底:菜单第一行会显示成 claude-opus-5[1m]");

const baseModelId = (m) => String(m?.resolvedModel || m?.model || m?.value || "").replace(/\[.*$/, "").replace(/-\d{8}$/, "");
const dedupeModels = (list) => {
  const out = [], at = new Map();
  for (const m of list) {
    const k = baseModelId(m), i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push({ ...m }); continue; }
    const keep = out[i];
    keep.contextWindow = Math.max(keep.contextWindow || 0, m.contextWindow || 0) || undefined;
    keep.vision = keep.vision ?? m.vision;
  }
  return out;
};

// [1m] 后缀、尾部日期戳都不算不同的模型
assert.equal(baseModelId({ resolvedModel: "claude-opus-5[1m]" }), "claude-opus-5");
assert.equal(baseModelId({ model: "claude-haiku-4-5-20251001" }), "claude-haiku-4-5");
// SDK 的 fable 上报成 "claude-fable-5-1[1m]",和手工表的 "claude-fable-5-1" 必须归一
assert.equal(baseModelId({ value: "claude-fable-5-1[1m]", model: "claude-fable-5-1" }), "claude-fable-5-1");

// default / opus[1m] / 手工 claude-opus-5 三条同一个模型 → 只剩排最前的 default
const DUP = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", contextWindow: 1_000_000 },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
  { value: "claude-opus-5", model: "claude-opus-5", displayName: "Opus 5" },
  { value: "claude-sonnet-5", model: "claude-sonnet-5", displayName: "Sonnet 5" },
  { value: "deepseek/deepseek-flash", model: "deepseek-flash", displayName: "DeepSeek V4.1 Flash", vision: true },
];
const DEDUP = dedupeModels(DUP);
assert.deepEqual(DEDUP.map((m) => m.value), ["default", "sonnet", "deepseek/deepseek-flash"], "同一个模型只能剩一条,且留的是排最前的别名");
// default 那条 SDK 不给窗口,合并时要把别名的 1M 捡回来,否则显示成 200k
assert.equal(DEDUP[0].contextWindow, 1_000_000);
// 不同 provider 的模型不能被误合(第三方 id 本来就各不相同)
assert.equal(DEDUP[2].vision, true);

// 去重把固定 id 从菜单里拿掉后,老会话仍存着它 —— modelInList 必须能归一化找回来
assert.ok(SRC.includes("base(m.resolvedModel ?? m.model ?? m.value) === base(modelValue)"),
  "modelInList 的归一化兜底已漂移:丢了它,选过 claude-opus-5 的老会话头会显示成裸 id");

// ---------- supportedModels 只收 Claude 的行:sidecar 的 isClaudeModel ----------
// 在 DeepSeek 会话里问 supportedModels,打的是 DeepSeek 的 anthropic 兼容端点,它会答自家模型。
// 放进来的连锁伤:裸 id 行挂 Anthropic logo → 去重时排在前面把 catalog 正品挤掉 → vision/价格/正式名全丢。
assert.ok(SIDECAR.includes("const isClaudeModel ="), "server.mjs 的 isClaudeModel 已漂移");
assert.ok(SIDECAR.includes("claude = claude.filter(isClaudeModel)"), "SDK 现答的那份必须过滤,否则脏行当场进菜单");
assert.ok(SIDECAR.includes("claudeModels ?? []).filter(isClaudeModel)"), "读缓存也要过滤,否则上一版存下的脏数据永远赖着");

const isClaudeModel = (m) => /^(claude-|default$|opus|sonnet|haiku|fable)/.test(String(m?.resolvedModel || m?.model || m?.value || ""));
// 真 Claude:具体 id 和别名都要留
assert.ok(isClaudeModel({ value: "default", resolvedModel: "claude-opus-5[1m]" }));
assert.ok(isClaudeModel({ value: "opus[1m]", resolvedModel: "claude-opus-5[1m]" }));
assert.ok(isClaudeModel({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }));
assert.ok(isClaudeModel({ value: "sonnet" }), "别名行万一不带 resolvedModel 也不能误杀");
// 第三方端点答回来的:一律不收
assert.ok(!isClaudeModel({ value: "deepseek-flash", displayName: "deepseek-flash" }));
assert.ok(!isClaudeModel({ value: "deepseek-v4-pro" }));
assert.ok(!isClaudeModel({ value: "glm-4.6" }));
assert.ok(!isClaudeModel({ value: "kimi-k2.7-code" }));
// 过滤必须发生在去重之前:两条的 baseModelId 都是 "deepseek-flash",脏行排在前面就被留下,
// catalog 那条的 value/displayName/provider 一起陪葬(vision 会被合并捡回,但没人能查到这条了)。
const POLLUTED = [{ value: "deepseek-flash", displayName: "deepseek-flash" }, DUP[5]];
const KEPT = dedupeModels(POLLUTED)[0];
assert.equal(KEPT.displayName, "deepseek-flash", "脏行排前面确实会顶掉正式名 —— 所以必须在入表前就滤掉");
// 真正卡死图片的一环:会话存的是 "deepseek/deepseek-flash",在只剩裸 id 的列表里查不到 →
// vision 无从得知 → 退回 provider 的 vision:false → 明明能看图的 V4.1 Flash 被输入框拦下
assert.equal(modelInList([KEPT], "deepseek/deepseek-flash"), undefined);
// 过滤只作用在 SDK 那半边(catalog 的第三方行本来就该留着,它们不走 supportedModels)
const CLEAN = dedupeModels([...POLLUTED.slice(0, 1).filter(isClaudeModel), DUP[5]]);
assert.equal(CLEAN[0].displayName, "DeepSeek V4.1 Flash", "滤干净后留下的是 catalog 那条");
assert.equal(modelInList(CLEAN, "deepseek/deepseek-flash")?.vision, true, "查得到,vision 才跟得上");

// ---------- 模型菜单:当前模型复制一份钉最前 ----------
const COMPOSER = readFileSync("src/components/Composer.tsx", "utf8");
assert.ok(COMPOSER.includes("const menuModels ="), "Composer 的 menuModels 已漂移");
assert.ok(COMPOSER.includes("cur ? [cur, ...session.models] : session.models"),
  "原列表必须原样保留在后面 —— 只在最前面加一份副本,不许挪动/删减原有条目");
assert.ok(COMPOSER.includes("{menuModels.map("), "菜单要渲染 menuModels,不是 session.models");
assert.ok(COMPOSER.includes("modelMenu && menuModels.length > 0") && COMPOSER.includes("menuModels[palIdx % n].value"),
  "↑↓/⏎ 必须走同一份 menuModels,否则键盘选中项和眼睛看到的差一行");

console.log("✅ model-name: default 解析 / 非 default 原样 / 自匹配排除 / 无解析兜底 / 菜单单行 / 模型条同名 / 别名家族兜底 / 重复入口去重 / 只收 Claude 行 / 当前模型钉顶 全部通过");
