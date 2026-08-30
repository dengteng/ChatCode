// node sidecar/logcap.test.mjs
import assert from "node:assert/strict";
import { capToolResults, capText, LOG_TEXT_CAP } from "./logcap.mjs";

const long = "x".repeat(LOG_TEXT_CAP + 500);

// 字符串形状:截断且留标注
{
  const m = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: long }] } };
  const o = capToolResults(m);
  assert.ok(o.message.content[0].content.length < long.length);
  assert.match(o.message.content[0].content, /日志已截断 500 字符/);
  assert.equal(m.message.content[0].content, long); // 不改原对象
}

// 数组形状:text 截、image 原样
{
  const img = { type: "image", source: { type: "base64", data: "AAAA" } };
  const m = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: long }, img] }] } };
  const o = capToolResults(m).message.content[0].content;
  assert.ok(o[0].text.length < long.length);
  assert.deepEqual(o[1], img);
}

// 短内容 / 非 tool_result:原样返回(不产生多余拷贝)
{
  const m = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
  assert.equal(capToolResults(m), m);
  assert.equal(capText("hi"), "hi");
  assert.equal(capToolResults({ type: "system", subtype: "init" }).subtype, "init");
}

console.log("logcap ok");
