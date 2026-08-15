// 一次性迁移:把老日志里内联的图片 base64 抽到 ~/.chat-code/blobs/<sha1>,日志里只留引用。
// sidecar 已改为落盘即外置(server.mjs 的 externalizeImages),这里补清存量。
// 按内容 hash 存 = 天然去重,同一张图贴过多少次都只占一份磁盘。
//
// 用法: node scripts/externalize-images.mjs [--apply]
// 不带 --apply 只统计,不动文件。
//
// 活会话正在追加:先读到 EOF 记下 size,写完临时文件后再 stat,把这期间新增的字节原样拼上去再 rename。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DATA = process.env.CHAT_CODE_DATA_DIR || path.join(os.homedir(), ".chat-code");
const SESS = path.join(DATA, "sessions");
const BLOBS = path.join(DATA, "blobs");
const APPLY = process.argv.includes("--apply");
const mb = (n) => (n / 1048576).toFixed(1) + "M";

const seen = new Set(); // 已落盘的 hash,统计去重效果
let nImg = 0, nDup = 0, blobBytes = 0;

function externalize(line) {
  if (!line.includes('"base64"')) return line; // 粗筛:绝大多数行没图,省掉 JSON.parse
  let m;
  try { m = JSON.parse(line); } catch { return line; }
  const c = m?.message?.content;
  if (!Array.isArray(c) || !c.some((b) => b?.type === "image" && b.source?.type === "base64")) return line;
  const content = c.map((b) => {
    if (b?.type !== "image" || b.source?.type !== "base64") return b;
    const b64 = b.source.data;
    const key = crypto.createHash("sha1").update(b64).digest("hex");
    nImg++;
    if (seen.has(key)) nDup++;
    else {
      seen.add(key);
      blobBytes += Math.ceil(b64.length * 3 / 4);
      if (APPLY) {
        fs.mkdirSync(BLOBS, { recursive: true });
        const f = path.join(BLOBS, key);
        if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(b64, "base64"));
      }
    }
    return { ...b, source: { type: "cc_blob", media_type: b.source.media_type, key, bytes: b64.length } };
  });
  return JSON.stringify({ ...m, message: { ...m.message, content } });
}

let totBefore = 0, totAfter = 0;
for (const name of fs.readdirSync(SESS).filter((f) => f.endsWith(".jsonl"))) {
  const file = path.join(SESS, name);
  const before = fs.statSync(file).size;
  const raw = fs.readFileSync(file, "utf8");
  const sizeAtRead = fs.statSync(file).size;

  const lines = raw.split("\n");
  const trailing = lines[lines.length - 1] === "" ? "" : lines.pop(); // 最后一行可能是半截(正在写)
  const out = lines.filter(Boolean).map(externalize).join("\n") + "\n" + trailing;
  const after = Buffer.byteLength(out);
  totBefore += before; totAfter += after;
  if (after === before) continue;

  if (APPLY) {
    const tmp = file + ".ext";
    fs.writeFileSync(tmp, out);
    // 迁移期间会话又写了几条 —— 原样补到尾巴上,一个字不丢
    const now = fs.statSync(file).size;
    if (now > sizeAtRead) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(now - sizeAtRead);
      fs.readSync(fd, buf, 0, buf.length, sizeAtRead);
      fs.closeSync(fd);
      fs.appendFileSync(tmp, buf);
    }
    fs.renameSync(tmp, file);
  }
  console.log(`${name}  ${mb(before)} → ${mb(after)}`);
}

console.log(`\n${APPLY ? "已迁移" : "预演(加 --apply 生效)"}: 图 ${nImg} 张(其中 ${nDup} 张重复,不再重复存),`
  + `blobs 占 ${mb(blobBytes)},日志 ${mb(totBefore)} → ${mb(totAfter)}`);
