// pushCmd 自检。跑法(零新依赖):
//   npx esbuild src/lib/gitcmd.check.ts --bundle --format=esm | node --input-type=module
import { pushCmd, pushTargets, lanesFor, unpushedFor } from "./gitcmd";

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

// —— pushTargets:哪几条连线该长出 push 按钮 ——
const eqList = (got: string[], want: string[], name: string) => eq(got.join(","), want.join(","), name);
const RS = ["origin/main", "private/oss"];
// 两边都推完(sha 一致、ahead 0):一颗按钮都不该剩 —— 这条是这个函数存在的理由
eqList(pushTargets({ sha: "4899f82", ahead: 0 }, RS, "origin/main", { "origin/main": "4899f82", "private/oss": "4899f82" }), [], "全推完");
// 刚提交,两边都落后
eqList(pushTargets({ sha: "b0b0b0b", ahead: 1 }, RS, "origin/main", { "origin/main": "4899f82", "private/oss": "4899f82" }),
  RS, "两边都可推");
// 只推了上游:剩下的非上游那条还得留着按钮
eqList(pushTargets({ sha: "b0b0b0b", ahead: 0 }, RS, "origin/main", { "origin/main": "b0b0b0b", "private/oss": "4899f82" }),
  ["private/oss"], "只剩非上游");
// 远端 ref 还不存在(从没推过):sha 查不到 = 有得推
eqList(pushTargets({ sha: "b0b0b0b", ahead: 0 }, ["private/oss"], undefined, {}), ["private/oss"], "远端没这条 ref");

// —— lanesFor:竖脊扇出,一个远端一条 lane ——
const REMOTES = ["origin", "private"];
const REFS = ["origin/main", "private/oss", "private/cloud"];
const laneStr = (ls: ReturnType<typeof lanesFor>) => ls.map((l) => `${l.remote}:${l.ref || "-"}${l.isUpstream ? "*" : ""}`).join(",");
// oss 的上游是 origin/main(名字对不上也认),private 那条靠同名兜底 —— 这是本仓库的真实形状
eq(laneStr(lanesFor("oss", REMOTES, REFS, "origin/main")), "origin:origin/main*,private:private/oss", "上游 + 同名兜底");
// 没设上游:两边都只能同名匹配,origin 里没有 cloud → ref 缺失,那条走「新建」
eq(laneStr(lanesFor("cloud", REMOTES, REFS, undefined)), "origin:-,private:private/cloud", "无上游时同名兜底 + 缺失");
// upstream 只属于它自己那个远端:private 那条不能把 origin/main 抢过去当上游
eq(laneStr(lanesFor("main", REMOTES, ["origin/main"], "origin/main")), "origin:origin/main*,private:-", "上游不跨远端");
// 单远端:退化成一条 lane,和改版前的行为一致
eq(laneStr(lanesFor("main", ["origin"], ["origin/main"], "origin/main")), "origin:origin/main*", "单远端");

// —— unpushedFor:琥珀点按选中仓库算 ——
// c3 ← c2 ← c1。origin 停在 c2(c3 没推),private 还停在 c1(c2/c3 都没推)
const CS = [{ hash: "c3", parents: ["c2"] }, { hash: "c2", parents: ["c1"] }, { hash: "c1", parents: [] }];
const HS = [{ name: "origin/main", sha: "c2", remote: true }, { name: "private/oss", sha: "c1", remote: true },
  { name: "oss", sha: "c3", remote: false }];
const upStr = (s: Set<string>) => [...s].sort().join(",");
// 同一份历史,切远端得出不同集合 —— 这条是这个函数存在的理由
eq(upStr(unpushedFor(CS, HS, "origin")), "c3", "相对 origin 只差 c3");
eq(upStr(unpushedFor(CS, HS, "private")), "c2,c3", "相对 private 差两条");
// 选中的远端一条 ref 都没有:全部算未推(而不是"没远端就不标")
eq(upStr(unpushedFor(CS, HS, "backup")), "c1,c2,c3", "选中远端没有任何 ref");
// 不筛(null):任一远端能走到就算已推 —— 旧行为
eq(upStr(unpushedFor(CS, HS, null)), "c3", "不筛时退回旧行为");

console.log("全部通过");
