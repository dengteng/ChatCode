// memory.ts 合并逻辑自检。跑法:
//   npx esbuild src/memory.check.ts --bundle --format=esm | node --input-type=module
import { mergeIndex, scanMemories } from "./memory";

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`✗ ${msg}\n  got : ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`);
  n++;
};

eq(mergeIndex("", "- [A](a.md) — x\n"), "- [A](a.md) — x\n", "目标为空:整份拿过去");
eq(mergeIndex("- [A](a.md) — x\n", "- [A](a.md) — x\n"), "- [A](a.md) — x\n", "完全相同:原样不动");
eq(mergeIndex("- [A](a.md) — x\n", "- [B](b.md) — y\n"), "- [A](a.md) — x\n- [B](b.md) — y\n", "两边各有一条:并集,目标在前");
eq(mergeIndex("- [A](a.md) — x", "  - [A](a.md) — x  \n\n- [B](b.md) — y"), "- [A](a.md) — x\n- [B](b.md) — y\n", "去重忽略首尾空白,空行不搬");

// scanMemories 静默补索引:假 Tauri 后端(内存文件系统),invoke 走 window.__TAURI_INTERNALS__
const fs = new Map<string, string>();
(globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (cmd: string, a: any) => {
  if (cmd === "read_file") { if (!fs.has(a.path)) throw new Error("ENOENT"); return fs.get(a.path); }
  if (cmd === "write_file") { fs.set(a.path, a.content); return; }
  if (cmd === "read_dir_meta") {
    const p = a.path.replace(/\/$/, "") + "/"; const out = new Map<string, boolean>();
    for (const k of fs.keys()) if (k.startsWith(p)) { const r = k.slice(p.length); out.set(r.split("/")[0], r.includes("/")); }
    return [...out].map(([name, dir]) => [name, dir, 1]);
  }
  if (cmd.endsWith("resolve_directory")) return "/Users/u";
  throw new Error(`unexpected invoke ${cmd}`);
} } };
const A = "/w/a", D = "/Vault/mem/a";
fs.set(`${A}/.claude/settings.local.json`, JSON.stringify({ autoMemoryDirectory: D }));
fs.set(`${D}/MEMORY.md`, "- [旧](old.md) — 旧钩子\n- [悬空](gone.md) — x\n");
fs.set(`${D}/old.md`, "---\nname: old\ndescription: d0\n---\nb");
fs.set(`${D}/new.md`, "---\nname: new-one\ndescription: 新的一条\n---\nb");
fs.set(`${D}/nodesc.md`, "---\nname: nodesc\n---\nb");
fs.set(`${D}/new.local-copy.md`, "---\nname: c\n---\nb");
const s = await scanMemories(A);
const idx = fs.get(`${D}/MEMORY.md`)!;
eq(idx, "- [旧](old.md) — 旧钩子\n- [悬空](gone.md) — x\n- [new-one](new.md) — 新的一条\n- [nodesc](nodesc.md)\n", "补索引:追加漏登记的,原有行(含悬空行)不动,冲突副本不登记");
eq(s.entries.filter((e) => !e.indexed).map((e) => e.file), ["new.local-copy.md"], "补完的标已索引,只剩冲突副本");
eq(s.orphanIndex, ["gone.md"], "悬空行只告警不删");
await scanMemories(A);
eq(fs.get(`${D}/MEMORY.md`), idx, "再扫一次:幂等");
await scanMemories("/w/none");
eq([...fs.keys()].some((k) => k.startsWith("/w/none")), false, "没有记忆的项目不建文件");
fs.set("/w/b/.claude/settings.local.json", JSON.stringify({ autoMemoryDirectory: "/V/b" }));
fs.set("/V/b/x.md", "---\nname: x\ndescription: dx\n---\n");
await scanMemories("/w/b");
eq(fs.get("/V/b/MEMORY.md"), "- [x](x.md) — dx\n", "没有 MEMORY.md:新建");

console.log(`✓ memory 自检通过(${n} 条)`);
