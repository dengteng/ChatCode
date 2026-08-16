# 分支面板：竖直贯通脊 设计稿

日期：2026-08-16 · 状态：待实现 · 涉及文件：`src/components/BranchesTab.tsx`、`src/lib/gitcmd.ts`、`src/lib/gitcmd.check.ts`、`src/styles.css`

## 目标

现在的分支页是三段横竖混排：暂存区 →（竖线）→ 本地↔远程分支映射（**横**着连，一行一个本地分支）→ 提交拓扑（`git log --all`，全仓库混在一起）。

一个本地分支可以对应多个远端（本仓库：`origin` = ChatCode.git，`private` = ChatCode-cloud.git），横排的行模型撑不住这个关系，远程分支区和提交拓扑还各画了一份远端信息。

改成一条从上到下贯通的脊：工作区 → 本地分支 → 一个或多个远端 → 该远端的提交拓扑。

---

## §1 布局与行模型

```
① 暂存区（不动）
   │ commit ⟵ 已有的竖线，不动
② 分支带：  main   ⟨oss⟩   cloud        ← ⟨⟩=聚焦，其余小 chip，点了换聚焦
   │
   ├────┬────┐  扇出
   ↑    ↑       ← 每条线一个远端，单推
  push            ← 分叉点，全推
   │    │
③ ┌origin──┐ ┌private─┐                ← 仓库 tab = 扇出落点 = 切换器
   │ main   │ │ oss    │                ← 副标题：该仓库里对应的远程分支名
   └────────┘ └────────┘
④ github.com/dengteng/ChatCode.git      ← 跟选中 tab 走
   ● 提交拓扑（远程 chip 只画选中仓库的）
```

两个新状态，都只在 `BranchesTab` 组件里，不进全局 store：

```ts
const [focus, setFocus] = useState<string | null>(null);   // 看哪个本地分支，null = 跟 git.current
const [repo,  setRepo]  = useState<string | null>(null);   // 看哪个远端，null = 跟聚焦分支的上游所在远端
```

**聚焦不切 git 分支** —— 只换视角，不跑 `git switch`。切分支仍走 chip 的右键菜单（现有 `onChip` 菜单不动）。理由：这页以只读视图为主，点一下就改工作区状态太重。

行模型从「本地分支 × 远程分支」的横行，改成「远端 × 一条 lane」：

```ts
type RepoLane = {
  remote: string;        // origin
  ref?: string;          // origin/main —— 该仓库里对应聚焦分支的远程分支；没有就是 undefined
  isUpstream: boolean;   // 决定实线/虚线，规则和现在一样
  pushable: boolean;     // 复用已有的 pushTargets
};
```

lane 对**每个远端**都出一条，包括在那个仓库里还没有对应分支的（`ref === undefined`）—— 那条画虚线、tab 显示「新建」，点 push 就是 `git push -u origin cloud`。现有那个「把本地推成远程分支」的入口不能丢。

`ref` 的选法：先认 upstream，upstream 不在这个远端就退回同名匹配，都没有就 `undefined`。

## §2 扇出几何与 push 按钮

扇出转成竖的：主干从聚焦 chip 底部往下走到 `FORK_Y`，横向摊开到各 tab 的中心 x，再各自往下一小段落到 tab 顶（拐角仍走 6px 圆角）。现有常量（`BranchesTab.tsx:328-332`）`MAP_LINK_W = 84`、`FORK_X = 52`、`CHIP_H = 26`、`CHIP_GAP = 4`、`PITCH = CHIP_H + CHIP_GAP`、圆角 `R = 6`（`:387`）里，横向那几个换成纵向对应值：`FORK_X → FORK_Y`、`MAP_LINK_W → MAP_LINK_H`。

按钮归属和现在**语义完全一致**，只是位置转了 90°：

- 分叉点那颗 `push` 药丸 = 推到全部 `pushable` 的 lane（`cmd1 && cmd2`）
- 每条下落段上一颗 ↑ = 只推这条
- `pushable` 仍由 `pushTargets(head, refs, upstream, remoteSha)` 算，逻辑一行不改，自检也留着
- 只有一个可推目标时不画 ↑（和药丸重复），这条规则保留

传输流光仍只跑主干那一段 —— 它是所有目标共用的，推一个还是推全部都成立。

**聚焦的不是当前分支时，整组 push 按钮不画。** `git push` 推的是你实际所在的分支，给一个非当前分支画 push 按钮等于骗人。那种情况 tab 仍可切、拓扑仍可看，只是没有写操作。

## §3 拓扑过滤

`Graph` 加一个 prop：`repo: string | null`。改两处，别的不动。

**① 远程 chip 只留选中仓库的**（`headsBySha` 构建处，现 `BranchesTab.tsx:547-551`）

```ts
for (const h of log.heads) {
  if (h.remote && repo && !h.name.startsWith(repo + "/")) continue;   // 只这一行
  ...
}
```

本地 ref 全留 —— 它们不属于任何远端，藏了反而看不出 `main`/`cloud` 停在哪。

**② `unpushed` 改成「相对选中仓库」**（现 `BranchesTab.tsx:553-566`）

```ts
const remoteShas = log.heads
  .filter((h) => h.remote && (!repo || h.name.startsWith(repo + "/")))
  .map((h) => h.sha);
```

这条是切换器的**真正价值**，不是装饰。现在的写法是「任一远端能走到就算已推」，两个远端时天然误报：推了 `origin` 没推 `private`，琥珀点就灭了，可 `private` 里根本没有。切到 private 就该看见一串琥珀。

**③ commits 本身不过滤**，仍是 `git log --all`。

> ponytail：切仓库只换染色和 chip，不换骨架。过滤 commit 集要重跑 reachability + 重算 lane 布局，切一下整张图行数和泳道全跳，读的人得重新找位置；而「哪些提交属于 origin」这个信息，琥珀点已经答了。真需要「只看这个仓库有的」再说。

`repo === null`（仓库没配 remote）时全部退回现在的行为，一个分支都不少画。

拓扑过滤本身 sidecar 不用改 —— `log.heads` 里已经有 `name` + `remote`，前缀匹配是纯前端的事。

**实现时补的一处**：地址行要跟着 tab 换，而 `gitInfo` 只给了一条 `remoteUrl`（当前分支上游那个远端的）。切到 private 还挂着 origin 的地址，等于告诉用户这些提交推去了另一个仓库。所以 sidecar 加了 `remoteUrls: Record<远端名, url>`（`urlByRemote` 本来就在，只是没往外给），`remoteUrl` 保留当兜底。

## §4 动效

先把话说直：**push 不产生新提交**。「拓扑图上新增一条提交记录」，真实发生的是远程 chip `origin/main` 从旧的那一行**挪到**新的那一行，同时中间几行的琥珀点熄灭。要新增行的是 commit，不是 push。

动效按真实事件设计，三段：

1. **推送中** —— 主干那段跑流光。现成的 `.flow-down` 直接复用，不写新东西。
2. **落地** —— `onRun` 回来后刷 git + log，新位置的远程 chip 用 220ms `@keyframes` 淡入 + 轻微上浮（`translateY(-3px) → 0`）。
3. **熄灯** —— 熄灭的琥珀点走 300ms `transition: fill`，从 `#d58b00` 渐到 lane 色；`.cg-unpushed` 那个「未推送」标签同时淡出。

`@media (prefers-reduced-motion: reduce)` 里全部归零 —— 这条不省。

> ponytail：不做 FLIP 位移（chip 从旧行「飞」到新行）。跨 DOM 节点测 rect + transform + 刷新时机对齐，一堆代码换 0.3s 的一次性观感。淡入够看懂发生了什么。

## §5 自检

几何和渲染不测（测了也只是把代码抄一遍）。抽两个纯函数进 `src/lib/gitcmd.ts`，自检塞现成的 `src/lib/gitcmd.check.ts`，跑法不变：

```sh
npx esbuild src/lib/gitcmd.check.ts --bundle --format=esm | node --input-type=module
```

```ts
lanesFor(focus, remotes, remoteRefs, upstream) → RepoLane[]
unpushedFor(commits, heads, repo) → Set<string>
```

`lanesFor` 四条：上游优先于同名、上游缺位时同名兜底、仓库里没这条分支时 `ref === undefined`（画虚线走「新建」）、单远端。

`unpushedFor` 三条：**同一份提交历史切 origin / private 得出不同集合**（这条是它存在的理由）、选中远端没有对应 ref 时全部算未推、`repo === null` 时退回旧行为。

`pushTargets` 那 4 条自检原样留着，`pushCmd` 5 条也不动。加上新的 7 条 = 16 条。外加 `npx tsc --noEmit` 和 `node scripts/i18n-check.mjs`。

## 实现后追加的偏差（2026-08-16 落地时）

- **`.cg-unpushed`「未推送」标签没有退场淡出**，只有入场。退场要把节点留在 DOM 里再删，宽度会占着位把同行内容顶开；为一个 0.3s 的效果换这套机制不值。琥珀点的 `fill` 过渡照做了，熄灭这件事仍然是渐变的。
- **没有本地对应物的远程分支不再单独占一行**（原来的横排图会给它们补一行「新建本地」）。它们仍在提交拓扑里以 chip 出现，点开菜单就能「检出到本地并跟踪」。代价：得先把仓库 tab 切到它所在的远端才看得见。
- **`unpushedFor` 的空集守卫拆成两种**：`repo=null` 且一条远程 ref 都没有 → 不标（"这仓库还没远端"）；选中了某个远端而它没有任何 ref → **全标**（那些提交确实一条都没推过去）。原来合并处理，自检直接把这条抓出来了。
- **竖线①（暂存区→分支）改成整宽居中**，对齐竖脊主干。原来它只占左半边、对准横排图的「本地分支」列，那张图已经没了。

## 第二轮调整（2026-08-16 看到实物后）

装上看过之后改的三处，都是设计稿里没想周全的：

**① 分叉线上的按钮箭头朝下。** 原来画的是 `ArrowUp`（沿用横排图的「往右上游推」）。竖脊里本地在上、远端在下，push 是往下走的，朝上的箭头和线的方向对着干。

**② 光束跟着这次 push 的目标走，不再只跑主干。** §2 里写的「beam 只跑主干 —— 那是所有目标共用的一段」在两个远端时读不出来：点了单条 ↑，光在分叉口就没了，看着像推送半路断了。现在：

- 每条被推的 lane 画一条光束，走的是「主干 + 自己那条分叉」的完整路径；多条时主干段完全重合，看起来是一束光下来、到分叉口分成几束。
- 点主干药丸 = 全部可推的 lane，点某条 ↑ = 只那条。哪几条由 `BranchSpine` 内部的 `beamTo` 记着（点按钮时写，只喂光束）。终端里手敲 `git push` 时 `beamTo` 是空的，退回「所有还能推的」。
- 实现从 `transform: translateX` + 旋转坐标系换成 `stroke-dashoffset` 沿路径跑。位移动画只会走直线，穿不过 90° 拐角；dash 是贴路径长算的，拐弯圆角自动跟。虚线周期 = 尾长 + 全长，同时只有一段在线上。pull 靠 `animation-direction: reverse` 反着跑，仍不用第二套 keyframes。
- **代价：尾迹的渐隐没了**，降级成实心圆头短线。渐变得沿路径方向走，而路径要拐弯，一条 `linearGradient` 撑不住；要真做得按段切渐变或上 `offset-path`。竖线①那颗（CSS 渐变画的）不受影响，两处现在略有差异。

**③ 远端那组补了段落标题，两个「新建」入口换成虚线框。**

```
本地分支
  main  ⟨oss⟩  cloud  ┆+ 新建┆
         │
远程分支  ├────┐
      ┌origin─┐ ┌private┐ ┆+ 新建┆
```

- 「本地分支」标题右边那个小 `+` 撤掉，改成排在 chip 队尾的虚线框（第一行 `+`，第二行「新建」）—— 读作「这一排的下一个」，不是标题的附属。
- tab 下面那行灰字「新建远程分支」撤掉，改成同一排右端的虚线框。原来它和 tab 不在一个层级上，读起来像脚注。
- 左边补「远程分支」段落标题，和「本地分支」呼应。
- **左右两个侧槽必须等宽**（`SIDE_W = 62`）：只在右边加一格的话整排左移半格，主干跟着偏出容器中线，和上面竖线①错开。所以左边那个标题槽同时是右边虚线框的配重。扇出的 x 全是纯算的（`rowW = total + (SIDE_W + TAB_GAP) * 2`，`cx = rowW / 2`），`SIDE_W` 在 JS 和 CSS（`--side-w`）各写一份，改一处得改两处。

## 已知天花板

- 「同名兜底」只认同名。`oss ⇢ private/feature-x` 这种手工对应认不出来，git 也没地方存第二个上游。
- `pushTargets` 只判「sha 相等 = 没得推」，不判分叉。远端跑在前面时按钮还在，点了 git 自己拒 non-fast-forward。
- 拓扑仍是 `git log --all -n80`，切仓库不改条数。
- 聚焦非当前分支时没有任何写操作入口，只能看。
- 光束的循环周期不随路径长度变：三个以上远端时中间那条比两边短，同一时刻走的距离不一样，主干段会略微错开。两个远端左右对称，看不出来。
- `SIDE_W` 在 `BranchesTab.tsx` 和 `styles.css` 各存一份，靠注释保持同步。
