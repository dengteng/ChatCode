// CHAT_CODE_DATA_DIR=$(mktemp -d) node sidecar/blobs.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import blobs.mjs 之前定好数据目录:模块加载时就把 BLOB_DIR 算死了
process.env.CHAT_CODE_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "cc-blobs-"));
const { externalizeImages, inlineImages, isBlobRef } = await import("./blobs.mjs");

const data = Buffer.from("fake-png-bytes".repeat(500)).toString("base64"); // 够大,才看得出外置真的变小了
const img = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

// 顶层图 + 工具结果里嵌的图,两处都要外置
const msg = { type: "user", message: { role: "user", content: [
  img(),
  { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "看图" }, img()] },
] } };
const out = externalizeImages(msg);
assert.ok(isBlobRef(out.message.content[0]), "顶层图没外置");
assert.ok(isBlobRef(out.message.content[1].content[1]), "工具结果里的图没外置");
assert.equal(out.message.content[1].content[0].text, "看图");
assert.equal(msg.message.content[0].source.type, "base64"); // 不改原对象
assert.ok(JSON.stringify(out).length < JSON.stringify(msg).length);

// 同一张图两处 = 同一个 key(按内容 hash 去重)
assert.equal(out.message.content[0].source.key, out.message.content[1].content[1].source.key);

// 还原回内联,两处都要还原
const back = inlineImages(out);
assert.equal(back.message.content[0].source.data, data);
assert.equal(back.message.content[1].content[1].source.data, data);

// 没有图的消息原样返回
const plain = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
assert.equal(externalizeImages(plain), plain);
assert.equal(inlineImages(plain), plain);

console.log("blobs ok");
