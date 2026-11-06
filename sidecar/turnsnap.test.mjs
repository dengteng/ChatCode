// 自检:每轮改动卡片的快照对比(turnsnap.mjs)。跑法: node sidecar/turnsnap.test.mjs
// 造一个临时仓库,轮首拍快照 → 改文件 / 新建 / 删除 / 改被忽略的 / 中途自己 commit → 轮末比对,
// 断言清单对、用户的暂存区原样不动、非 git 目录不出卡片。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { snapTree, turnChanges } from "./turnsnap.mjs";

const execOut = (bin, args, cwd, env, timeout = 12000) => new Promise((resolve) =>
  execFile(bin, args, { cwd, timeout, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), err })));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-turnsnap-")));
const repo = path.join(tmp, "r");
fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
const w = (f, s) => fs.writeFileSync(path.join(repo, f), s);
try {
  git("init", "-q");
  w(".gitignore", "out.log\n"); w("keep.ts", "a\nb\n"); w("gone.ts", "x\n"); w("中文.md", "旧\n");
  git("add", "-A"); git("commit", "-qm", "init");
  w("staged.ts", "s\n"); git("add", "staged.ts"); // 用户自己暂存了一半:快照不能动它
  const indexBefore = git("diff", "--cached", "--name-only");

  const a = await snapTree(execOut, path.join(repo, "sub")); // 会话目录是子目录也得拍整个仓库
  assert.ok(a?.tree, "轮首快照没拍成");
  assert.strictEqual(a.root, repo);
  assert.deepStrictEqual(await turnChanges(execOut, a, repo), { root: repo, from: a.tree, to: a.tree, files: [] }, "没改动也要回空清单");

  w("keep.ts", "a\nB\nc\n"); w("sub/new.ts", "n\n"); fs.rmSync(path.join(repo, "gone.ts")); w("中文.md", "新\n"); w("out.log", "噪音\n");
  git("commit", "-qm", "agent 中途自己提交", "--", "keep.ts"); // 提交掉的改动照样算进这一轮

  const ch = await turnChanges(execOut, a, path.join(repo, "sub"));
  const got = Object.fromEntries(ch.files.map((f) => [f.file, [f.add, f.del]]));
  assert.deepStrictEqual(got, { "keep.ts": [2, 1], "sub/new.ts": [1, 0], "gone.ts": [0, 1], "中文.md": [1, 1] }, JSON.stringify(got));
  // 卡片里点文件就是这条命令(server.mjs gitFileDiff 的 tree 分支)
  assert.match(git("diff", ch.from, ch.to, "--", "keep.ts"), /\+B/);

  assert.strictEqual(git("diff", "--cached", "--name-only"), indexBefore, "用户的暂存区被快照改了");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "index.lock")), "留下了 index.lock");
  assert.strictEqual(await snapTree(execOut, tmp), null, "非 git 目录应返回 null");
  assert.strictEqual(await turnChanges(execOut, null, repo), undefined, "没轮首快照不出卡片");
  console.log("PASS turnsnap", JSON.stringify(got));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
