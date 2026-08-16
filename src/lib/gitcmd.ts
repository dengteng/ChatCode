// 界面按钮发出去的 git 命令的构造。放这儿是因为顶栏和分支页都要发 push,规则必须是同一套。

export function q(value: string) { return `'${value.replace(/'/g, "'\\''")}'`; }

// commit 的流光最短亮多久 / 成功提示压后多久。两处必须同一个数:提示先于流光结束弹出,
// 就成了"还在跑但已经说完成了"。放这儿是因为一处在 BranchesTab、一处在 store 的 terminal_result。
export const COMMIT_HOLD_MS = 3000;

// 把本地分支推到某个远程分支(remoteRef 形如 "origin/main")。
//
// 为什么不发裸 `git push`:它只在「本地分支名 == 上游分支名」时才跑得动。git 默认 push.default=simple,
// 站在 oss...origin/main 这种名字对不上的分支上,裸 push 直接 fatal 并叫你手敲 refspec —— 界面上的
// 按钮不能有"看你 git 配置心情"的行为。显式 refspec 在两种情况下都是同一个结果。
//
// 不带 -u:这个函数也用来推非上游的同名远端(oss → private/oss),顺手改上游等于偷换 `git push` 的默认目标。
// 这一行还有东西可推的远端。upstream 那条 git 自己算了 ahead,直接用;非上游的远端(同名撞上来的,
// 比如 oss → private/oss)git 一个数都不给,只能拿 sha 比:和本地 head 同一个 sha 就是已经推过了。
// ponytail: 只判"相等 = 没得推",不判分叉 —— 远端跑在前面时按钮仍在,点了 git 自己拒 non-fast-forward,
// 比额外为每个远端跑一遍 rev-list(15s 轮询 × 分支数 × 远端数)划算。
export function pushTargets(head: { sha?: string; ahead?: number }, remotes: string[], upstream?: string, remoteSha: Record<string, string> = {}) {
  return remotes.filter((r) => (r === upstream ? (head.ahead || 0) > 0 : !head.sha || remoteSha[r] !== head.sha));
}

export function pushCmd(local: string, remoteRef: string) {
  const [remote, ...rest] = remoteRef.split("/");
  return `git push ${q(remote)} ${q(`${local}:${rest.join("/")}`)}`;
}

// 聚焦的那条本地分支,在每个远端里对应哪条远程分支 —— 分支面板竖脊的扇出就是按这个画的,
// 一个远端一条 lane。没有对应分支的远端**照样出一条**(ref=undefined):那条画虚线、落到「新建」,
// 少画一条等于告诉用户"这个仓库不存在",而它只是还没推过。
// 选法:先认 upstream(git 唯一认的那条),upstream 不在这个远端就退回同名匹配。
export type RepoLane = { remote: string; ref?: string; isUpstream: boolean };
export function lanesFor(focus: string, remotes: string[], remoteRefs: string[], upstream?: string): RepoLane[] {
  return remotes.map((remote) => {
    const up = upstream && upstream.split("/")[0] === remote && remoteRefs.includes(upstream) ? upstream : undefined;
    const same = remoteRefs.find((r) => r.split("/")[0] === remote && r.split("/").slice(1).join("/") === focus);
    return { remote, ref: up || same, isUpstream: !!up };
  });
}

// 提交拓扑里"未推送"(琥珀点)的集合,**相对某一个远端**算:从该远端的 ref 沿父链走不到 = 还没推过去。
// 为什么带 repo:原来是"任一远端能走到就算已推",两个远端时天然误报 —— 推了 origin 没推 private,
// 琥珀点就灭了,可 private 里根本没有这些提交。切到 private 就该看见一串琥珀。
// repo=null(仓库没配 remote / 不筛)时退回旧行为:任一远端都算,且一条远程 ref 都没有时**不标**
// —— 那是"这仓库还没远端",全标琥珀没有信息量。但选中了某个远端而它一条 ref 都没有,是另一回事:
// 那些提交确实一条都没推到那儿,全标才是实话。两种情况都落在 shas.length===0,不能合并处理。
export function unpushedFor(
  commits: { hash: string; parents: string[] }[],
  heads: { name: string; sha: string; remote: boolean }[],
  repo: string | null,
) {
  const shas = heads.filter((h) => h.remote && (!repo || h.name.split("/")[0] === repo)).map((h) => h.sha);
  if (!shas.length) return repo ? new Set(commits.map((c) => c.hash)) : new Set<string>();
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const onRemote = new Set<string>();
  const stack = [...shas];
  while (stack.length) {
    const h = stack.pop()!;
    if (onRemote.has(h)) continue;
    onRemote.add(h);
    for (const p of byHash.get(h)?.parents || []) if (!onRemote.has(p)) stack.push(p);
  }
  return new Set(commits.filter((c) => !onRemote.has(c.hash)).map((c) => c.hash));
}
