// 界面按钮发出去的 git 命令的构造。放这儿是因为顶栏和分支页都要发 push,规则必须是同一套。

export function q(value: string) { return `'${value.replace(/'/g, "'\\''")}'`; }

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
