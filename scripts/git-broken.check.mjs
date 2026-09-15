#!/usr/bin/env node
// gitInfo 里「git 跑不起来」vs「这儿确实不是仓库」的分流自检。
// 规则本体在 sidecar/server.mjs 的 gitInfo(那文件一 import 就起服务,没法直接引),照抄一份再断言源码没漂移
// —— 和 model-name.check.mjs / scroll-stick.check.mjs 同一套路。
//
// 症结(2026-09-16 实测):macOS 更新后没同意 Xcode 许可,`git` 一律以 69 退出。目录里明明有 .git,
// gitInfo 却只看 ok 不看原因,回 isRepo:false —— 面板写"当前目录不是 Git 仓库",用户点「关联」,
// 关联本身也是跑 git、同样失败,面板还是那句话。看上去就是"关联完不刷新"。
//
// 跑法:node scripts/git-broken.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRV = readFileSync("sidecar/server.mjs", "utf8");
assert.ok(SRV.includes("/not a git repository/i.test(why)"), "gitNfo 的故障分流已漂移:必须按 git 原话区分,不能一律当非仓库");
assert.ok(SRV.includes("...(broken ? { error: why } : {})"), "环境故障必须把 git 原话带给前端");

const TS = readFileSync("src/types.ts", "utf8");
assert.ok(/error\?: string;/.test(TS.slice(TS.indexOf("export interface GitInfo"), TS.indexOf("export interface GitInfo") + 900)),
  "GitInfo.error 没了,前端收不到故障原因");

// 两个展示位都要认 error,少一个就会继续谎报"不是 Git 仓库"
assert.ok(readFileSync("src/components/BranchesTab.tsx", "utf8").includes("git.error ? t(\"Git 命令执行失败"), "分支面板没区分故障");
assert.ok(readFileSync("src/components/Chat.tsx", "utf8").includes("git.error ? ("), "顶栏没区分故障,仍然给出点了也没用的「关联」按钮");
// 关联命令整条用 `;` 串,末尾必须复核一次,否则前面全炸也照样打印 ✓
assert.ok(readFileSync("src/components/Chat.tsx", "utf8").includes("git rev-parse --git-dir >/dev/null ||"), "关联命令收尾没复核,会谎报成功");
assert.ok(readFileSync("src/store.tsx", "utf8").includes('[/\\bgit\\s+init\\b/, "关联仓库"]'), "关联失败没有 toast 兜底");

// 规则本体(照抄):rev-parse 失败时判定是否为环境故障
const broken = (stderr) => {
  const why = (stderr || "").trim().split("\n")[0];
  return why && !/not a git repository/i.test(why) ? why : "";
};

// —— 真·非仓库:git 的原话,不算故障 ——
assert.equal(broken("fatal: not a git repository (or any of the parent directories): .git"), "");
assert.equal(broken("fatal: Not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary."), "");
// —— Xcode 许可没同意:git 二进制罢工,必须报出来(这一条就是本次 bug 的现场) ——
assert.equal(broken("You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license."),
  "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.");
// —— 仓库存在但坏了 / 权限不足:同样是故障,不能说成"没有仓库" ——
assert.equal(broken("fatal: detected dubious ownership in repository at '/x'"), "fatal: detected dubious ownership in repository at '/x'");
assert.equal(broken("error: could not lock config file .git/config: Permission denied"), "error: could not lock config file .git/config: Permission denied");
// —— 只取首行:后面的建议文字挤在顶栏一行里读不了 ——
assert.equal(broken("fatal: boom\nhint: try this\nhint: or that"), "fatal: boom");
// —— 没有 stderr(spawn 失败等):没话可说就退回"不是仓库",别显示一行空错误 ——
assert.equal(broken(""), "");
assert.equal(broken(undefined), "");
assert.equal(broken("   \n  "), "");

console.log("✅ git-broken: 非仓库不误报故障 / Xcode 许可等故障如实报出 / 只取首行 / 空 stderr 不显示空错误 全部通过");
