#!/usr/bin/env node
// 「拓扑图点提交看详情」这条链路的自检。和 send-gate.check.mjs 同一套路:把 sidecar 里那几条
// git 命令复刻一份**真跑一遍**,再断言 server.mjs 里写的确实是这几条。
//
// 为什么值得一测:这条链路最容易写成 `git diff <hash>^ <hash>`,而它在两种提交上直接坏掉 ——
//   · 根提交没有 ^,命令 fatal,而根提交恰恰是新仓库里最先能被点到的那个;
//   · 合并提交裸 show 打的是 combined diff,常常一个文件都不打,读起来像"这次没改东西"。
// 两种都不是构造出来的边界,是每个仓库都有的。
//
// 跑法:node scripts/commit-detail.check.mjs   (在本仓库里跑,拿真实提交当样本)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert";

const SRC = readFileSync("sidecar/server.mjs", "utf8");
const STORE = readFileSync("src/store.tsx", "utf8");
const TAB = readFileSync("src/components/BranchesTab.tsx", "utf8");
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });

// ---------- 1. 复刻 sidecar 的三条命令,并钉住 server.mjs 里就是它们 ----------
const META = ["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b"];
const NUMSTAT = ["show", "--first-parent", "--numstat", "--format="];
const PATCH = ["show", "--first-parent", "--format=", "-U3"];
for (const argv of [META, NUMSTAT, PATCH]) {
  const lit = argv.map((a) => JSON.stringify(a)).join(", ");
  // -U3 是 gitFileDiff 按 ctx 传进去的,源码里是变量,只钉前半截
  const want = argv === PATCH ? `${[...PATCH.slice(0, 3)].map((a) => JSON.stringify(a)).join(", ")}, ctx` : lit;
  assert.ok(SRC.includes(want), `sidecar 里没找到这条命令:[${want}]`);
}
assert.ok(!/\["diff",[^\]]*\}\^/.test(SRC), "别用 `<hash>^` 当左端 —— 根提交上会 fatal");

// meta 解析:和 gitCommit 里那份一致(NUL 分隔,body 在最后所以能带换行)
const parseMeta = (out) => {
  const [hash, parents, author, email, date, subject, body] = out.split("\0");
  return { hash: (hash || "").trim(), parents: (parents || "").trim().split(" ").filter(Boolean),
    author, email, date, subject, body: (body || "").replace(/\s+$/, "") };
};
const parseNumstat = (out) => out.split("\n").filter(Boolean).map((line) => {
  const [add, del, ...name] = line.split("\t");
  return { file: name.join("\t"), add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) };
});

// ---------- 2. 三种提交都得出得来东西 ----------
const root = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
const merge = git(["log", "--all", "--merges", "-n1", "--format=%H"]).trim();
const cases = [["普通提交", "HEAD"], ["根提交", root], ...(merge ? [["合并提交", merge]] : [])];

for (const [name, rev] of cases) {
  const meta = parseMeta(git([...META, rev]));
  assert.equal(meta.hash.length, 40, `${name}:%H 该是全长 sha`);
  assert.ok(meta.author && meta.date, `${name}:作者/时间没解析出来`);
  const files = parseNumstat(git([...NUMSTAT, rev]));
  assert.ok(files.length > 0, `${name}:一个文件都没打出来 —— 界面上会显示成"无文件差异"`);
  assert.ok(files.every((f) => f.file && (f.add === null || Number.isFinite(f.add))),
    `${name}:numstat 解析出了空文件名或 NaN`);
  // 单文件 patch 走的是同一条 show,列表里点得开才算通
  const patch = git([...PATCH, rev, "--", files[0].file]);
  assert.ok(patch.includes("diff --git"), `${name}:${files[0].file} 的 patch 是空的`);
  console.log(`✓ ${name} ${meta.hash.slice(0, 8)} · ${files.length} 个文件 · 父 ${meta.parents.length} 个`);
}
// 根提交没父:界面靠这个显示「根提交」,也是不能用 ^ 的原因
assert.equal(parseMeta(git([...META, root])).parents.length, 0, "根提交不该有父提交");

// 提交正文里的换行不能把字段切散(body 排在最后一个 NUL 之后就是为了这个)
const multi = git(["log", "--all", "-n50", "--format=%H %b"]).split("\n").filter((l) => l.trim().length > 45);
if (multi.length) {
  const m = parseMeta(git([...META, multi[0].split(" ")[0]]));
  assert.equal(m.hash.length, 40, "带多行正文的提交把字段切散了");
  console.log("✓ 多行正文的提交字段没被切散");
}

// ---------- 3. 前端接线 ----------
assert.ok(/case "git_commit_detail": dispatch/.test(STORE), "store 没接 git_commit_detail 回包");
// 这条曾经真的漏过:clipped 不透传,「文件较大,只显示改动附近」永远不显示,用户以为看到的是全文
assert.ok(/case "git_file_diff": dispatch[^\n]*clipped: m\.clipped/.test(STORE), "git_file_diff 回包漏了 clipped");
assert.ok(TAB.includes('requestGitFileDiff(session.id, "PARENT", commitView, file)'), "提交详情里点文件没走 PARENT 模式");
assert.ok(/onMouseDown=\{\(e\) => \{ if \(!picking && e\.button === 0\) onCommit\(r\.c\.hash\)/.test(TAB),
  "拓扑图的行没接上「点开看详情」,或者没避开对比拾取态");
console.log("✓ 前端接线齐全");
console.log("全部通过");
