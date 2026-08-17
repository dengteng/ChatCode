// 一次性清洗:按 sidecar 现在的落盘规则(server.mjs 的 keepInLog / stripForLog)重写存量日志。
// 删掉回放用不上的 system 消息,和 SDK 附带但前端从不读的 tool_use_result 字段(Edit 那条会把
// 整份文件原文塞进来,老日志里它一个字段就占三分之二体积)。
//
// 用法: node scripts/prune-logs.mjs [--apply]
// 不带 --apply 只统计,不动文件。
//
// 活会话正在追加:先读到 EOF 记下 size,写完临时文件后再 stat,把这期间新增的字节原样拼上去再 rename。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESS = path.join(process.env.CHAT_CODE_DATA_DIR || path.join(os.homedir(), ".ChatCode"), "sessions");
const APPLY = process.argv.includes("--apply");
const mb = (n) => (n / 1048576).toFixed(1) + "M";

// 与 server.mjs 的 KEEP_SYSTEM 保持一致
const KEEP_SYSTEM = new Set(["init", "status", "compact_boundary", "background_tasks_changed"]);

const cutBySubtype = {};
let nCut = 0, nStripped = 0, strippedBytes = 0;

// 返回 null = 整行删掉;否则返回重写后的行(没变就返回原串,省一次 stringify)
function rewrite(line) {
  let m;
  try { m = JSON.parse(line); } catch { return line; } // 解析不了的原样留着,不替用户做主
  if (m?.type === "stream_event" || (m?.type === "system" && !KEEP_SYSTEM.has(m.subtype))) {
    const k = m.type === "system" ? m.subtype : m.type;
    cutBySubtype[k] = (cutBySubtype[k] || 0) + 1;
    nCut++;
    return null;
  }
  if (m?.tool_use_result === undefined) return line;
  const { tool_use_result, ...rest } = m;
  nStripped++;
  strippedBytes += JSON.stringify(tool_use_result).length;
  return JSON.stringify(rest);
}

let totBefore = 0, totAfter = 0, totLines = 0;
for (const name of fs.readdirSync(SESS).filter((f) => f.endsWith(".jsonl"))) {
  const file = path.join(SESS, name);
  const before = fs.statSync(file).size;
  const raw = fs.readFileSync(file, "utf8");
  const sizeAtRead = fs.statSync(file).size;

  const lines = raw.split("\n");
  const trailing = lines[lines.length - 1] === "" ? "" : lines.pop(); // 最后一行可能是半截(正在写)
  const kept = lines.filter(Boolean).map(rewrite).filter((l) => l !== null);
  totLines += lines.filter(Boolean).length;

  const out = kept.join("\n") + "\n" + trailing;
  const after = Buffer.byteLength(out);
  totBefore += before; totAfter += after;
  if (after === before) continue;

  if (APPLY) {
    const tmp = file + ".prune";
    fs.writeFileSync(tmp, out);
    // 清洗期间会话又写了几条 —— 原样补到尾巴上,一个字不丢
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

console.log(`\n删行(按类型):`);
for (const [k, v] of Object.entries(cutBySubtype).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(`\n${APPLY ? "已清洗" : "预演(加 --apply 生效)"}: 删 ${nCut} / ${totLines} 行,`
  + `剥 tool_use_result ${nStripped} 处(省 ${mb(strippedBytes)}),日志 ${mb(totBefore)} → ${mb(totAfter)}`);
