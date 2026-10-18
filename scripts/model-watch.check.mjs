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

// Claude 一路:对比对象是后台 claude 组;库里没有 claude 组时不管
{
  const { CLAUDE_SOURCE, claudeOurs, claudeRow } = await import("./model-watch.mjs");
  assert.equal(claudeOurs({ providers: { deepseek: [] } }), null, "后台没有 claude 组就不对比");
  const ours = claudeOurs({ providers: { claude: [{ model: "claude-sonnet-5" }, { model: "claude-old", hidden: true }] } });
  const md = { anthropic: { models: {
    a: m("claude-sonnet-5-5", { name: "Claude Sonnet 5.5", limit: { context: 1000000 }, modalities: { input: ["text", "image"], output: ["text"] } }),
    b: m("claude-sonnet-5", { status: "deprecated" }),
    c: m("claude-gone-before"),
  } } };
  const c = diff(ours, md, { claude: ["claude-gone-before"] }, "2026-10-18", CLAUDE_SOURCE);
  assert.deepEqual(c.added.claude.map(claudeRow), [{ model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", contextWindow: 1000000, vision: true }]);
  assert.deepEqual(c.retired.claude.map((x) => x.id), ["claude-sonnet-5"], "弃用的设隐藏;已隐藏的不报");
  assert.equal(c.added.claude.some((x) => x.id === "claude-gone-before"), false, "见过的(后台删过的)不再加回来");
  assert.equal(c.added.deepseek, undefined, "Claude 那一路不碰第三方");
  console.log("✓ model-watch claude");
}
