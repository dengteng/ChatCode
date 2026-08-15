// 文件式记忆扫描:读 ~/.claude/projects/<项目编码>/memory/ 下的 *.md + MEMORY.md 索引,
// 解析 frontmatter,并检测"索引漂移"(文件在但 MEMORY.md 没登记 / 索引有但文件已删)。
// 记忆中心面板(InfoPanel 的"记忆"tab)用它。
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

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
  const home = (await homeDir()).replace(/\/$/, "");
  const dir = memoryDirFor(home, cwd);
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
  return { dir, entries, indexNotes, orphanIndex, hasIndex };
}
