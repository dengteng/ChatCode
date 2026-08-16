// pushCmd 自检。跑法(零新依赖):
//   npx esbuild src/lib/gitcmd.check.ts --bundle --format=esm | node --input-type=module
import { pushCmd } from "./gitcmd";

const eq = (got: string, want: string, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}\n  got : ${got}\n  want: ${want}`);
  console.log(`✓ ${name}`);
};

// 本地名 ≠ 上游名 —— 裸 `git push` 在 push.default=simple 下会 fatal,这条是这个函数存在的理由
eq(pushCmd("oss", "origin/main"), "git push 'origin' 'oss:main'", "名字对不上的上游");
// 同名的常规情况,行为和裸 push 一致
eq(pushCmd("main", "origin/main"), "git push 'origin' 'main:main'", "同名上游");
// 非上游的同名远端:私有远端也得推得到
eq(pushCmd("oss", "private/oss"), "git push 'private' 'oss:oss'", "非上游远端");
// 分支名带斜杠:只有第一段是远端名,剩下的整段是远程分支名
eq(pushCmd("feat/x", "origin/feat/x"), "git push 'origin' 'feat/x:feat/x'", "带斜杠的分支名");
// 引号转义:分支名里的单引号不能把命令劈开
eq(pushCmd("a'b", "origin/a'b"), `git push 'origin' 'a'\\''b:a'\\''b'`, "单引号转义");

console.log("全部通过");
