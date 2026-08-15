// safeJoin 自检。跑法(零新依赖):
//   npx esbuild src/lib/safepath.check.ts --bundle --format=esm | node --input-type=module
import { safeJoin as j } from "./safepath";

const eq = (got: string | null, want: string | null, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  console.log(`✓ ${name}`);
};

const H = "/Users/me/.claude";
// 正常落地
eq(j(H, "/projects/-Users-me-repo/memory", "note.md"), "/Users/me/.claude/projects/-Users-me-repo/memory/note.md", "正常记忆路径");
eq(j(H, "skills", "apple-design/SKILL.md"), "/Users/me/.claude/skills/apple-design/SKILL.md", "正常 skill 路径");
eq(j(H, "//projects///x//", "a.md"), "/Users/me/.claude/projects/x/a.md", "重复斜杠折平");
eq(j(H, "./projects/./x", "a.md"), "/Users/me/.claude/projects/x/a.md", "单点折平");
eq(j(H, "projects/x/..", "a.md"), "/Users/me/.claude/projects/a.md", "内部 .. 折平但仍在 root 内");
eq(j(H, ""), H, "空 part 得到 root 本身");
// 逃逸一律 null
eq(j(H, "/../../..", ".zshrc"), null, "跳出 root");
eq(j(H, "..", "Library/LaunchAgents/evil.plist"), null, "上跳一级");
eq(j(H, "projects/../../../../etc", "passwd"), null, "折平后跳出");
eq(j(H, "/../.claudex", "a.md"), null, "同前缀的兄弟目录不算 root 内");
eq(j(H, "a\0b", "x.md"), null, "含 NUL");
eq(j("relative/root", "a"), null, "root 非绝对路径");
console.log("all ok");
