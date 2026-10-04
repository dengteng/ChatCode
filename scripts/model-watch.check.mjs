// node scripts/model-watch.check.mjs
import assert from "node:assert/strict";
import { diff, oursOf } from "./model-watch.mjs";

const m = (id, extra = {}) => ({ id, name: id, tool_call: true, modalities: { input: ["text"], output: ["text"] }, release_date: "2026-09-01", ...extra });
const md = {
  deepseek: { models: {
    a: m("deepseek-new"),
    b: m("deepseek-old", { status: "deprecated" }),
    c: m("deepseek-ancient", { release_date: "2025-01-01" }),
    d: m("deepseek-img", { modalities: { output: ["image"] } }),
  } },
  alibaba: { models: { a: m("qwen9-max"), b: m("glm-9") } },
};
const ours = oursOf({
  deepseek: { models: [{ model: "deepseek-old" }, { model: "deepseek-gone" }, { model: "deepseek-hid", hidden: true }] },
  qwen: { models: [] },
  glm: { models: [{ model: "glm-4.6" }] },
});
const seen = { deepseek: ["deepseek-gone", "deepseek-hid"] };
const r = diff(ours, md, seen, "2026-10-05");

assert.deepEqual(r.added.deepseek.map((x) => x.id), ["deepseek-new"], "只报近期、能对话、没弃用的新模型");
assert.deepEqual(r.added.qwen.map((x) => x.id), ["qwen9-max"], "阿里百炼下挂的 GLM 不算 qwen 的");
assert.deepEqual(r.retired.deepseek.map((x) => x.id), ["deepseek-old", "deepseek-gone"], "弃用的、见过又没了的都报;hidden 的不报");
assert.equal(r.retired.glm, undefined, "整家拉不到时不报没了");
assert.deepEqual(r.seen.glm, [], "整家拉不到时已见表原样保留");
assert.ok(r.seen.deepseek.includes("deepseek-new"), "报过的进已见表");

const again = diff(ours, md, r.seen, "2026-10-05");
assert.equal(again.added.deepseek, undefined, "报过一次就不再报");
console.log("✓ model-watch diff");
