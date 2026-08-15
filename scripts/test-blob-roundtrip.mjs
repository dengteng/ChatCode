// blob_get 往返自检:起一个隔离 DATA_DIR 的 sidecar,放一张真图进 blobs,
// 走 WebSocket 请缩略图和原图,校验回来的数据。跑法: node scripts/test-blob-roundtrip.mjs
//
// 盯的是历史图片外置(见 server.mjs 的 externalizeImages / blobGet)这条链路:
// 原图必须一字节不差地取回来,缩略图必须真的更小,路径穿越必须被挡。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import assert from "node:assert";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "/tmp/cc-blob-test";
const PORT = 8991;
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, "blobs"), { recursive: true });

// 图要够大才会越过 thumbFor 的 64KB 阈值,拿项目图标放大到 900px 凑数
const big = path.join(DIR, "big.png");
execFileSync("sips", ["-z", "900", "900", path.join(ROOT, "src-tauri/icons/128x128@2x.png"), "--out", big]);
const png = fs.readFileSync(big);
const b64 = png.toString("base64");
const key = crypto.createHash("sha1").update(b64).digest("hex");
fs.writeFileSync(path.join(DIR, "blobs", key), png);
console.log(`测试图 ${(png.length / 1024).toFixed(0)}KB  base64 ${(b64.length / 1024).toFixed(0)}KB`);

// CHAT_CODE_TOKEN 置空:外面 shell 里带了的话 WS 会 401
const sc = spawn("node", [path.join(ROOT, "sidecar/server.mjs")],
  { env: { ...process.env, CHAT_CODE_TOKEN: "", CHAT_CODE_DATA_DIR: DIR, CHAT_CODE_PORT: String(PORT) },
    stdio: ["ignore", "ignore", "pipe"] });
sc.stderr.on("data", (d) => { if (!/\[usage\]/.test(String(d))) process.stderr.write("[sidecar] " + d); });

const done = (code) => { sc.kill("SIGKILL"); process.exit(code); };
setTimeout(() => { console.error("超时"); done(1); }, 40000);

await new Promise((r) => setTimeout(r, 2500));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const got = new Map();
const BAD_KEY = "../../../etc/passwd", MISSING = "0".repeat(40);
ws.on("open", () => {
  for (const [k, full] of [[key, false], [key, true], [BAD_KEY, true], [MISSING, true]])
    ws.send(JSON.stringify({ type: "blob_get", key: k, mediaType: "image/png", full }));
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type !== "blob") return;
  got.set(`${m.key}:${m.full}`, m);
  if (got.size < 4) return;
  try {
    const thumb = got.get(`${key}:false`), full = got.get(`${key}:true`);
    assert.equal(full.data, b64, "原图字节应与磁盘完全一致");
    assert.equal(full.media_type, "image/png");
    assert.ok(thumb.data && thumb.data.length < b64.length, "缩略图应比原图小");
    assert.equal(thumb.media_type, "image/jpeg", "sips 应转成 jpeg");
    assert.equal(got.get(`${BAD_KEY}:true`).data, null, "路径穿越必须被拒");
    assert.equal(got.get(`${MISSING}:true`).data, null, "不存在的 key 应回 null");
    console.log(`缩略图 ${(thumb.data.length / 1024).toFixed(0)}KB,压到原图的 ${(thumb.data.length / b64.length * 100).toFixed(0)}%`);
    console.log("往返自检全过");
    done(0);
  } catch (e) { console.error("FAIL:", e.message); done(1); }
});
ws.on("error", (e) => { console.error("ws 连不上:", e.message); done(1); });
