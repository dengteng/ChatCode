// 文件式记忆扫描:读 ~/.claude/projects/<项目编码>/memory/ 下的 *.md + MEMORY.md 索引,
// 解析 frontmatter,并检测"索引漂移"(文件在但 MEMORY.md 没登记 / 索引有但文件已删)。
// 记忆中心面板(InfoPanel 的"记忆"tab)用它。
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";

export type MemoryType = "user" | "feedback" | "project" | "reference" | "other";

export interface MemoryEntry {
  file: string;            // 文件名,如 feedback_push_remote.md
  path: string;            // 绝对路径
  title: string;           // frontmatter name / 首个 # 标题 / 文件名
  description: string;     // frontmatter description
  type: MemoryType;
  originSessionId?: string;
  body: string;            // 去掉 frontmatter 的正文
  mtime: number;           // 最后修改(ms)
  indexed: boolean;        // 是否登记进 MEMORY.md
}

// MEMORY.md 索引里写着、但没有独立记忆文件的条目(如"活文档:仓库内 docs/xxx"这种指针行)。
// 它们也是记忆,只是内容直接写在索引里,要一并展示。
export interface IndexNote { title: string; hook: string }

export interface MemoryScan {
  dir: string;             // memory 目录绝对路径
  custom: boolean;         // 是否由 autoMemoryDirectory 改过位置(已同步到别处)
  entries: MemoryEntry[];  // 有独立文件的记忆,按 mtime 倒序
  indexNotes: IndexNote[]; // 仅写在 MEMORY.md 索引里、无独立文件的记忆
  orphanIndex: string[];   // 索引里带 .md 链接、但文件已不存在的条目
  hasIndex: boolean;       // 是否存在 MEMORY.md
}

const readText = (path: string) => invoke<string>("read_file", { path }).catch(() => "");

// 项目绝对路径 → ~/.claude/projects/<编码>/memory
// 编码同 Claude Code:所有非字母数字字符(/ . _ 空格…)都换成 -,否则 dt_projects 这类带下划线的路径会扫错目录。
export function memoryDirFor(home: string, cwd: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return `${home.replace(/\/$/, "")}/.claude/projects/${enc}/memory`;
}

// Claude Code 原生设置 autoMemoryDirectory:项目 .claude/settings.local.json 优先,其次 ~/.claude/settings.json。
// 设了就是整个记忆目录(不再按项目分子目录),支持 ~/ 前缀。不读 .claude/settings.json —— Claude Code 出于安全忽略它。
async function readJson(path: string): Promise<Record<string, any> | null> {
  const raw = await readText(path);
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const expandHome = (p: string, home: string) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p).replace(/\/+$/, "");

export async function resolveMemoryDir(cwd: string): Promise<{ dir: string; custom: boolean }> {
  const home = (await homeDir()).replace(/\/$/, "");
  for (const f of [`${cwd}/.claude/settings.local.json`, `${home}/.claude/settings.json`]) {
    const v = (await readJson(f))?.autoMemoryDirectory;
    if (typeof v === "string" && v.trim()) return { dir: expandHome(v.trim(), home), custom: true };
  }
  return { dir: memoryDirFor(home, cwd), custom: false };
}

// 气泡里认"引用记忆"要知道改过位置的记忆目录。每张历史卡片都会问,按项目缓存一份。
// ponytail: 手改 settings.local.json 后要重开 app 才生效;经 syncMemoryTo 改的会自动刷新
const customDirCache = new Map<string, Promise<string | undefined>>();
export function useCustomMemoryDir(cwd?: string): string | undefined {
  const [dir, setDir] = useState<string>();
  useEffect(() => {
    if (!cwd) return;
    let p = customDirCache.get(cwd);
    if (!p) { p = resolveMemoryDir(cwd).then((r) => (r.custom ? r.dir : undefined)); customDirCache.set(cwd, p); }
    let alive = true;
    p.then((d) => { if (alive) setDir(d); });
    return () => { alive = false; };
  }, [cwd]);
  return dir;
}

// 项目同步名的默认值:git origin 的仓库名(两台电脑同一仓库 → 同一份记忆),没有 remote 就用目录名
export async function defaultSyncName(cwd: string): Promise<string> {
  const cfg = await readText(`${cwd}/.git/config`);
  const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg)?.[1];
  const name = (url ?? cwd).replace(/\/+$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "");
  return name || "project";
}

// MEMORY.md 合并:以目标为底,补上本地独有的行(按整行去重),两边的索引条目都不丢
export function mergeIndex(target: string, local: string): string {
  const have = new Set(target.split("\n").map((l) => l.trim()).filter(Boolean));
  const extra = local.split("\n").filter((l) => l.trim() && !have.has(l.trim()));
  if (!extra.length) return target;
  return `${target.replace(/\n*$/, "")}${target.trim() ? "\n" : ""}${extra.join("\n")}\n`;
}

// 把本项目记忆改存到 <root>/<name>:先把现有记忆并进去,再写 autoMemoryDirectory 进 .claude/settings.local.json。
// 同步本身交给 root 所在的同步盘(Obsidian 库 / iCloud / Dropbox…),ChatCode 只负责指过去。
// 旧目录原样保留不删,出问题随时能回退(删掉那行设置即可)。
export async function syncMemoryTo(cwd: string, root: string, name: string): Promise<string> {
  const home = (await homeDir()).replace(/\/$/, "");
  const target = `${root.replace(/\/+$/, "")}/${name}`;
  const settingsPath = `${cwd}/.claude/settings.local.json`;
  const settingsRaw = await readText(settingsPath);
  let settings: Record<string, any> = {};
  if (settingsRaw.trim()) {
    try { settings = JSON.parse(settingsRaw); } catch { throw new Error(".claude/settings.local.json 不是合法 JSON,先手动修好"); }
  }
  const { dir: from } = await resolveMemoryDir(cwd);
  if (from !== target) {
    const rows = await invoke<[string, boolean, number][]>("read_dir_meta", { path: from }).catch(() => [] as [string, boolean, number][]);
    for (const [file, isDir] of rows) {
      if (isDir || !/\.md$/i.test(file)) continue;
      const mine = await readText(`${from}/${file}`);
      const theirs = await readText(`${target}/${file}`);
      if (file === "MEMORY.md") { await invoke("write_file", { path: `${target}/${file}`, content: mergeIndex(theirs, mine) }); continue; }
      if (theirs === mine) continue;
      // 目标已有同名但内容不同(另一台电脑写过):两份都留,本机这份加后缀,人工合并
      const dst = theirs ? `${target}/${file.replace(/\.md$/i, "")}.local-copy.md` : `${target}/${file}`;
      await invoke("write_file", { path: dst, content: mine });
    }
  }
  const short = target.startsWith(`${home}/`) ? `~/${target.slice(home.length + 1)}` : target;
  await invoke("write_file", { path: settingsPath, content: JSON.stringify({ ...settings, autoMemoryDirectory: short }, null, 2) + "\n" });
  // 每台电脑的同步盘路径不同,这个文件绝不能进 git
  const hasGit = (await invoke<[string, boolean, number][]>("read_dir_meta", { path: `${cwd}/.git` }).catch(() => [])).length > 0;
  const gi = await readText(`${cwd}/.gitignore`);
  if (hasGit && !/^\/?\.claude\/(settings\.local\.json|\*)?\s*$/m.test(gi)) {
    await invoke("write_file", { path: `${cwd}/.gitignore`, content: `${gi.replace(/\n*$/, "")}${gi.trim() ? "\n" : ""}.claude/settings.local.json\n` });
  }
  customDirCache.delete(cwd);
  return target;
}

// frontmatter 里取某个标量字段(顶层或 metadata 下)
function fmField(fm: string, key: string): string {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m");
  const m = re.exec(fm);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

function parseMemory(file: string, path: string, raw: string, mtime: number, indexed: boolean): MemoryEntry {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const fm = fmMatch ? fmMatch[1] : "";
  const body = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();
  const name = fmField(fm, "name");
  const h = /^#\s+(.+)$/m.exec(body);
  const rawType = fmField(fm, "type").toLowerCase();
  const type: MemoryType = ["user", "feedback", "project", "reference"].includes(rawType) ? (rawType as MemoryType) : "other";
  return {
    file, path, body, mtime, indexed,
    title: name || (h ? h[1].trim() : file.replace(/\.md$/i, "")),
    description: fmField(fm, "description"),
    type,
    originSessionId: fmField(fm, "originSessionId") || undefined,
  };
}

interface IndexItem { title: string; file: string | null; hook: string }
// 解析 MEMORY.md 的每条 `- ...` 索引行:
//   `- [标题](file.md) — 钩子`  → 有独立文件
//   `- 活文档:仓库内 \`docs/x\` — 钩子` → 无 .md 链接,内容直接写在索引里
function parseIndex(md: string): IndexItem[] {
  const items: IndexItem[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    const link = /\[([^\]]+)\]\(([^)]+\.md)\)\s*(.*)$/.exec(text);
    if (link) {
      items.push({ title: link[1].trim(), file: link[2].split("/").pop()!, hook: link[3].replace(/^[—–-]\s*/, "").trim() });
    } else {
      const [head, ...rest] = text.split(/\s+[—–-]\s+/);
      items.push({ title: head.replace(/`/g, "").trim(), file: null, hook: rest.join(" — ").trim() });
    }
  }
  return items;
}

export async function scanMemories(cwd: string): Promise<MemoryScan> {
  const { dir, custom } = await resolveMemoryDir(cwd);
  const rows = await invoke<[string, boolean, number][]>("read_dir_meta", { path: dir }).catch(() => [] as [string, boolean, number][]);
  const indexRaw = await readText(`${dir}/MEMORY.md`);
  const hasIndex = !!indexRaw.trim();
  const idxItems = parseIndex(indexRaw);
  const indexedSet = new Set(idxItems.map((i) => i.file).filter(Boolean) as string[]);

  const mdFiles = rows.filter(([n, isDir]) => !isDir && /\.md$/i.test(n) && n !== "MEMORY.md");
  const entries = await Promise.all(mdFiles.map(async ([file, , mtime]) => {
    const path = `${dir}/${file}`;
    return parseMemory(file, path, await readText(path), mtime, indexedSet.has(file));
  }));
  entries.sort((a, b) => b.mtime - a.mtime);

  const present = new Set(mdFiles.map(([n]) => n));
  // 索引里带 .md 链接、但磁盘上已无该文件
  const orphanIndex = [...indexedSet].filter((f) => !present.has(f));
  // 仅写在索引里、没有独立文件的记忆(既非文件、也非坏链)
  const indexNotes: IndexNote[] = idxItems.filter((i) => !i.file && i.title).map((i) => ({ title: i.title, hook: i.hook }));
  return { dir, custom, entries, indexNotes, orphanIndex, hasIndex };
}
