#!/usr/bin/env node
// 清洗存量会话日志:tool_result 正文按 logcap 的上限截断,内联图(含工具结果里嵌的截图)抽到
// blobs/<sha1>。两件事新日志落盘时都做了,这个脚本只管存量。
//
//   node scripts/trim-session-logs.mjs                 # 全部会话
//   node scripts/trim-session-logs.mjs ~/.ChatCode/sessions/<id>.jsonl   # 指定几份
//
// 可以边跑边清:清洗期间新追加的行会原样接回尾巴(见下面的 delta)。截的只是日志正文,
// agent 上下文在 CLI 自己的 transcript 里,resume 不受影响。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { capToolResults } from "../sidecar/logcap.mjs";
import { externalizeImages } from "../sidecar/blobs.mjs";

const DIR = path.join(process.env.CHAT_CODE_DATA_DIR || path.join(os.homedir(), ".ChatCode"), "sessions");
const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(DIR, f));

const mb = (n) => (n / 1e6).toFixed(1) + "MB";
let before = 0, after = 0;

for (const f of files) {
  const size0 = fs.statSync(f).size; // 只清洗这个位点之前的内容,之后的是"跑着的会话又写进来的"
  if (size0 === 0) continue;         // 空文件:createReadStream 的 end:-1 会直接抛
  const tmp = `${f}.trim`;
  const out = fs.createWriteStream(tmp);
  const write = (s) => out.write(s) || new Promise((r) => out.once("drain", r));
  const rd = readline.createInterface({ input: fs.createReadStream(f, { start: 0, end: size0 - 1 }), crlfDelay: Infinity });
  for await (const line of rd) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { await write(line + "\n"); continue; } // 解析不了的原样留着,别当垃圾丢
    await write(JSON.stringify(capToolResults(externalizeImages(o))) + "\n");
  }
  // 清洗这几秒里 sidecar 可能又追加了几行,原样搬过去。rename 前那几毫秒仍有窗口 ——
  // 丢的最多是一条工具结果的显示,不影响 agent 上下文,不值得为它停掉会话。
  const size1 = fs.statSync(f).size;
  if (size1 > size0) {
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(size1 - size0);
    fs.readSync(fd, buf, 0, buf.length, size0);
    fs.closeSync(fd);
    await write(buf);
  }
  await new Promise((r) => out.end(r));
  const size2 = fs.statSync(tmp).size;
  fs.renameSync(tmp, f);
  before += size1; after += size2;
  console.log(`${path.basename(f)}  ${mb(size1)} → ${mb(size2)}`);
}
console.log(`合计 ${mb(before)} → ${mb(after)}(省 ${mb(before - after)})`);
