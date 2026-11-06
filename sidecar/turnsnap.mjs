// execOut 由调用方给(server.mjs 的那个:带 safeEnv,不把 key 漏给 git 起的 filter 进程)。
// 自检: node sidecar/turnsnap.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// 每轮改动卡片:轮首、轮末各拍一张工作区快照(git tree),两张一比就是这一轮改了什么。
// 用临时 index:不碰用户的暂存区,也不抢 .git/index.lock。先拷一份真 index 当 stat 缓存,没动过的文件不用重算哈希。
// 比的是两个时刻的文件内容,和 HEAD 无关:这轮里 agent 自己提交了,改动照样列出来。被 .gitignore 忽略的不算。
// ponytail: 同仓库并行的会话、这一轮期间用户手改的文件都会算进本轮;没被忽略的大文件每轮都要重新哈希,超时就不出卡片。
// tree 对象没有引用,git gc 默认两周后清掉,那时再点老卡片的文件会读不到 diff。
export async function snapTree(execOut, cwd) {
  const r = await execOut("git", ["rev-parse", "--show-toplevel", "--git-path", "index"], cwd, null, 3000);
  if (!r.ok) return null;
  const [root, idx] = r.stdout.trim().split("\n");
  const tmp = path.join(os.tmpdir(), `cc-snap-${crypto.randomUUID()}`);
  try { fs.copyFileSync(path.resolve(cwd, idx), tmp); } catch {} // 新仓库还没有 index,从空的建
  try {
    const env = { GIT_INDEX_FILE: tmp };
    if (!(await execOut("git", ["add", "-A"], root, env, 8000)).ok) return null;
    const t = await execOut("git", ["write-tree"], root, env, 5000);
    return t.ok ? { root, tree: t.stdout.trim() } : null;
  } finally { fs.rmSync(tmp, { force: true }); }
}
// 从轮首快照到现在改了哪些文件。快照拍成了就返回(files 可能为空):commit 小结据此知道这一轮有快照可依,不再按 mtime 猜。
export async function turnChanges(execOut, from, cwd) {
  if (!from) return undefined;
  const to = await snapTree(execOut, cwd);
  if (!to || to.root !== from.root) return undefined;
  if (to.tree === from.tree) return { root: from.root, from: from.tree, to: to.tree, files: [] };
  const r = await execOut("git", ["-c", "core.quotepath=off", "diff", "--numstat", "--no-renames", from.tree, to.tree], from.root, null, 5000);
  if (!r.ok) return undefined;
  const files = r.stdout.split("\n").filter(Boolean).map((line) => {
    const [add, del, ...name] = line.split("\t");
    return { file: name.join("\t"), add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) }; // "-" = 二进制
  });
  return { root: from.root, from: from.tree, to: to.tree, files };
}
