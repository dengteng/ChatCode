import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RotateCw, ChevronRight, ChevronDown, Cloud, X, FileDiff, Plus, ArrowDown } from "lucide-react";
import { createPortal } from "react-dom";
import { openUrl } from "../native";
import { html as diffToHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import type { Session, GitLogData, GitCommit, GitBranch } from "../types";
import { useStore } from "../store";
import { q, pushCmd, pushTargets, lanesFor, unpushedFor, COMMIT_HOLD_MS, type RepoLane } from "../lib/gitcmd";
import { ConfirmDialog } from "./ConfirmDialog";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";

// 统一 diff 渲染:把 git 的 unified patch 交给 diff2html,得到行内(word 级)高亮 + 行号的可视化视图。
// 空 patch = 无文本差异(如仅权限变化/二进制)。样式在 styles.css 的 .d2h-wrap 里对齐主题。
function DiffHtml({ patch, clipped }: { patch: string; clipped?: boolean }) {
  const { t } = useTranslation();
  const out = useMemo(
    () => patch.trim() ? diffToHtml(patch, { drawFileList: false, matching: "words", outputFormat: "line-by-line" }) : "",
    [patch],
  );
  if (!out) return <div className="muted branches-empty">{t("（无文本差异）")}</div>;
  return <>
    <div className="d2h-legend">{t("左列=改前行号")} · {t("右列=改后行号")} · <span className="d2h-lg-ins">{t("diff.added")}</span> <span className="d2h-lg-del">{t("diff.deleted")}</span>
      {clipped && <> · <span className="d2h-lg-clip">{t("文件较大，只显示改动附近")}</span></>}</div>
    <div className="d2h-wrap" dangerouslySetInnerHTML={{ __html: out }} />
  </>;
}

// 布尔量的"最短亮灯时长"闩锁:active 一置真就至少保持 ms 毫秒再落下。
// 用途:commit/push/pull 常常几百毫秒就跑完,连线上的流光一闪而过等于没有 —— 兜底让人看清。
// 1.4s = 光束跑完一整趟多一点;原来 3s 是纯多余的等待。
function useMinHold(active: boolean, ms = 1400) {
  const [held, setHeld] = useState(active);
  useEffect(() => {
    if (active) { setHeld(true); return; }
    if (!held) return;
    const t = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(t);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return held;
}

// 「分支」Tab:以提交拓扑图为唯一主线。点分支标签(节点)弹出该分支状态下可做的操作,所有操作都在图里。
//   - 本地分支节点:切换/合并/rebase/push/pull/覆盖/推送跟踪/设上游/新建/改名/删除/对比/(当前分支还有 commit/丢弃/查看改动)
//   - 远程分支节点:检出/对比/删除远程
//   - 分支对比"不限本地/远程":点节点菜单「对比…」→ 再点另一个节点选对端
// 写操作全走 runTerminal(输出进主窗口时间线,完事自动刷新 git_info + git_log);危险操作两步确认。
export function BranchesTab({ session, onCommit, committing }: { session: Session; onCommit: () => void; committing?: boolean }) {
  const { t } = useTranslation();
  const { state, runTerminal, requestGitLog, requestGitDiff, requestGitFileDiff } = useStore();
  const git = state.git[session.id];
  const log = state.gitLog[session.id];
  const diff = state.gitDiff[session.id];
  const fileDiff = state.gitFileDiff[session.id];
  const [confirm, setConfirm] = useState<{ cmd: string; label: string } | null>(null); // 待弹窗确认的危险操作
  // kind="repo" 时 ref = 远端名(不是分支名),菜单换成远端管理那一组
  const [menu, setMenu] = useState<{ ref: string; remote: boolean; x: number; y: number; kind?: "repo" } | null>(null);
  // newbranch 的 ref = 来源分支(弹窗里可改),target = 建到本地还是远程;rename/upstream 的 ref = 被操作的分支
  // remote* 三种的 ref = 远端名;remoteadd 是唯一要两个输入框的(名字 val + URL val2)
  const [prompt, setPrompt] = useState<{ kind: "rename" | "newbranch" | "upstream" | "remoteadd" | "remotename" | "remoteurl"; ref: string; val: string; val2?: string; target?: "local" | "remote" } | null>(null);
  const [compareFrom, setCompareFrom] = useState<string | null>(null); // 已选对比左端,等点第二个节点选右端
  const [compareView, setCompareView] = useState<{ from: string; to: string } | null>(null);
  const [wtFile, setWtFile] = useState<string | null>(null); // 工作区单文件 diff 弹窗:正在查看的文件
  const lastChanged = useRef<ReturnType<typeof parseStatus>>([]); // 暂存区折叠退场时还得渲染的最后一份文件列表
  const [pushing, setPushing] = useState(false); // 映射图上的 push 进行中:禁二次点击 + 菊花
  // 竖线①要对准当前分支 chip 的上边缘正中,而 chip 的中心不在容器中线上(宽度随名字变)。
  // 由竖脊量好偏移送上来,这里整条线平移过去。
  const [stemDx, setStemDx] = useState(0);
  // 竖脊只画一条本地分支。focus/repo 都是**纯视角**,不改仓库状态,所以留在组件里不进全局 store;
  // null = 跟着 git 走(聚焦当前分支 / 选当前分支上游那个远端),用户点过才钉住。
  const [focus, setFocus] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<"push" | "pull" | null>(null); // 本地↔远程连线上要放流光的方向
  const [committingOp, setCommittingOp] = useState(false); // 顶栏发起的 commit(不走 committing 这个 prop)
  // git 信息刷新 = 上一条写操作跑完(terminal_result 会立刻重拉 git_info),菊花停在这里
  useEffect(() => { setPushing(false); setSyncing(null); setCommittingOp(false); }, [git]);
  // 三处入口(顶栏 / 本面板按钮 / 节点菜单)发的 git 命令都汇到 store.runTerminal 的这条广播
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: string; command: string };
      if (d?.id !== session.id) return;
      if (/\bgit\s+push\b/.test(d.command)) setSyncing("push");
      else if (/\bgit\s+(pull|fetch)\b/.test(d.command)) setSyncing("pull");
      else if (/\bgit\s+commit\b/.test(d.command)) setCommittingOp(true);
    };
    window.addEventListener("cc-git-op", on);
    return () => window.removeEventListener("cc-git-op", on);
  }, [session.id]);
  // 流光只在 commit / push / pull 真正进行时点亮,且至少亮 useMinHold 那么久
  const commitBusy = !!committing || committingOp;
  // commit 那条单独给 3s:它只有一条线,光束跑一趟就没了,1.4s 眼睛还没跟上就结束。
  // 成功提示也压后同样长(store 的 terminal_result),不然提示先到、线还在跑。
  const commitFlow = useMinHold(commitBusy, COMMIT_HOLD_MS);
  const pushFlow = useMinHold(syncing === "push");
  const pullFlow = useMinHold(syncing === "pull");
  // 结果提示不在这儿做:store 的 terminal_result 统一按命令报「已提交/已推送/…失败」,
  // 三处入口一视同仁,失败也不会被谎报成成功。

  useEffect(() => { requestGitLog(session.id); }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 真切了分支(git switch 跑完)就松开钉住的聚焦,主脊跟到新分支上。
  // 不松开的话:切过去了,脊还画着旧分支,push 按钮因为"聚焦≠当前"整组消失,像是坏了。
  useEffect(() => { setFocus(null); }, [git?.current]);
  useEffect(() => { setConfirm(null); setMenu(null); setPrompt(null); setCompareFrom(null); setCompareView(null); setWtFile(null); setFocus(null); setRepo(null); }, [session.id]);

  // 工作区「查看改动」:拉 HEAD vs 工作区的单文件 patch,弹窗里用 diff2html 渲染(不再糊进终端)
  const viewWorktree = (path: string) => { setWtFile(path); requestGitFileDiff(session.id, "HEAD", "WORKTREE", path); };
  const wtReady = wtFile && fileDiff && fileDiff.file === wtFile && fileDiff.to === "WORKTREE";

  const closeMenu = () => { setMenu(null); setPrompt(null); setConfirm(null); };
  const run = (cmd: string) => { runTerminal(session.id, cmd); closeMenu(); };
  // 危险操作:关掉菜单 + 打开弹窗二次确认(不再 inline),确认在弹窗里 run
  const danger = (label: string, cmd: string) => { setMenu(null); setPrompt(null); setConfirm({ cmd, label }); };
  const doCompare = (from: string, to: string) => { setCompareView({ from, to }); requestGitDiff(session.id, from, to); setCompareFrom(null); setMenu(null); };

  if (!git) return <div className="info-scroll"><div className="muted branches-empty">{t("正在读取 Git 状态…")}</div></div>;
  if (!git.isRepo) return <div className="info-scroll"><div className="muted branches-empty">{t("当前目录不是 Git 仓库。在活动页可关联远程仓库。")}</div></div>;

  const current = git.current || "";
  const changed = parseStatus(git.status);
  const dirty = changed.length > 0;
  // 折叠退场那 260ms 里还得有内容撑着高度,所以留一份最后的非空列表
  if (dirty) lastChanged.current = changed;
  const exiting = dirty ? changed : lastChanged.current;
  const remoteName = git.remotes.includes("origin") ? "origin" : (git.remotes[0] || "origin");
  const multiRemote = git.remotes.length > 1;
  // 聚焦分支:用户点过就用他钉的那条,那条被删掉了(或没点过)就跟当前分支
  const focusName = (focus && git.local.some((b) => b.name === focus) ? focus : "") || current || git.local[0]?.name || "";
  // 选中的仓库:同理,默认跟聚焦分支的上游走 —— 站在上游是 private/cloud 的分支上却默认显示 origin,
  // 等于告诉用户这些提交推去了另一个仓库。
  const urlRemote = (repo && git.remotes.includes(repo) ? repo : "")
    || git.local.find((b) => b.name === focusName)?.upstream?.split("/")[0] || remoteName;
  const repoUrl = git.remoteUrls?.[urlRemote] || git.remoteUrl;
  const repoWeb = webUrl(repoUrl);                // 远程仓库网页地址(ssh/git → https)
  const graphRepo = git.remotes.length ? urlRemote : null;
  // 点分支标签:对比拾取中 → 选它当对端;否则开菜单
  const onChip = (ref: string, remote: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (compareFrom) { if (ref !== compareFrom) doCompare(compareFrom, ref); else setCompareFrom(null); return; }
    setConfirm(null); setPrompt(null);
    setMenu({ ref, remote, x: e.clientX, y: e.clientY });
  };
  // 右键仓库 tab:远端本身的增删改在这里(git remote 那组),和分支菜单共用同一个弹层
  const onRepoMenu = (name: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setConfirm(null); setPrompt(null);
    setMenu({ ref: name, remote: false, kind: "repo", x: e.clientX, y: e.clientY });
  };
  const newRemote = () => { setConfirm(null); setMenu(null); setPrompt({ kind: "remoteadd", ref: "", val: "", val2: "" }); };

  const submitPrompt = () => {
    if (!prompt) return;
    const v = prompt.val.trim();
    if (!v) return;
    // 新加的远端在 fetch 之前没有任何 refs,泳道是空的,看着像没加上 —— 加完顺手拉一次
    if (prompt.kind === "remoteadd") { const u = (prompt.val2 || "").trim(); if (u) run(`git remote add ${q(v)} ${q(u)} && git fetch ${q(v)} --prune`); return; }
    if (prompt.kind === "remotename") return run(`git remote rename ${q(prompt.ref)} ${q(v)}`);
    if (prompt.kind === "remoteurl") return run(`git remote set-url ${q(prompt.ref)} ${q(v)}`);
    if (prompt.kind === "rename") run(`git branch -m ${q(prompt.ref)} ${q(v)}`);
    // 建远程分支 = 把来源 ref 推到远程的新分支名下(不带 -u:来源不一定是想跟踪它的那条本地分支)
    else if (prompt.kind === "newbranch") run(prompt.target === "remote"
      ? `git push ${q(remoteName)} ${q(`${prompt.ref}:refs/heads/${v}`)}`
      : `git switch -c ${q(v)} ${q(prompt.ref)}`);
    else if (prompt.kind === "upstream") run(`git branch --set-upstream-to=${q(v)} ${q(prompt.ref)}`);
  };

  // 菜单项按分支状态生成
  const menuBody = () => {
    if (!menu) return null;
    const { ref, remote } = menu;
    // 一律 onMouseDown 而非 onClick:WKWebView 里输入框(contenteditable)聚焦时,落在别处的第一次
    // 点击只用来挪光标/切焦点,不派发 click —— 表现就是"菜单里的操作要点两次才生效"。
    // 按下即执行也正是原生菜单的行为。(Composer 的 chip 早前踩过同一个坑)
    const item = (label: string, onMouseDown: () => void) => <button className="bmenu-item" onMouseDown={onMouseDown}>{label}</button>;
    const dItem = (_key: string, label: string, cmd: string) =>
      <button className="bmenu-item danger" onMouseDown={() => danger(label, cmd)}>{label}</button>;
    // 输入类操作(改名/新建/设上游)统一走居中弹窗,不再挤在点击位置的小菜单里
    const openPrompt = (kind: "rename" | "newbranch" | "upstream") =>
      { setPrompt({ kind, ref, val: kind === "rename" ? ref : "", target: kind === "newbranch" ? "local" : undefined }); setMenu(null); };

    // 远端管理:git remote 那组。--prune 顺带清掉远端已删分支留下的幽灵 remote/xxx
    if (menu.kind === "repo") return <>
      <div className="bmenu-head"><Cloud size={11} /> {ref} <span className="muted">{t("远端")}</span></div>
      {item(t("拉取远端信息"), () => run(`git fetch ${q(ref)} --prune`))}
      {item(t("重命名远端…"), () => { setPrompt({ kind: "remotename", ref, val: ref }); setMenu(null); })}
      {item(t("修改 URL…"), () => { setPrompt({ kind: "remoteurl", ref, val: git.remoteUrls?.[ref] || "" }); setMenu(null); })}
      {dItem(`rmremote:${ref}`, t("移除远端"), `git remote remove ${q(ref)}`)}
    </>;

    if (remote) {
      const short = ref.split("/").slice(1).join("/");
      const rname = ref.split("/")[0];
      const hasLocal = git.local.some((b) => b.name === short);
      return <>
        <div className="bmenu-head"><Cloud size={11} /> {ref} <span className="muted">{t("远程")}</span></div>
        {item(t("分支对比…"), () => { setCompareFrom(ref); setMenu(null); })}
        {!hasLocal && item(t("检出到本地并跟踪"), () => run(`git switch -c ${q(short)} --track ${q(ref)}`))}
        {dItem(`delr:${ref}`, t("删除远程分支"), `git push ${q(rname)} --delete ${q(short)}`)}
      </>;
    }

    const b = git.local.find((x) => x.name === ref);
    const isCur = ref === current;
    const up = b?.upstream, ahead = b?.ahead || 0, behind = b?.behind || 0;
    return <>
      <div className="bmenu-head">{ref}{isCur && <span className="muted"> {t("当前")}</span>}{up ? <span className="muted"> → {up}{ahead ? ` ↑${ahead}` : ""}{behind ? ` ↓${behind}` : ""}</span> : <span className="muted"> {t("未跟踪")}</span>}</div>
      {isCur && dirty && item(t("查看改动（{{count}}）", { count: changed.length }), () => run("git diff"))}
      {isCur && dirty && item("commit", () => { onCommit(); closeMenu(); })}
      {isCur && dirty && dItem("discard", t("丢弃改动"), "git reset --hard HEAD")}
      {!isCur && item(t("切换到它"), () => run(`git switch ${q(ref)}`))}
      {!isCur && dItem(`merge:${ref}`, t("合并进 {{current}}", { current }), `git merge ${q(ref)}`)}
      {!isCur && dItem(`rebase:${ref}`, t("rebase 当前到它"), `git rebase ${q(ref)}`)}
      {isCur && up && ahead > 0 && item("push", () => run("git push"))}
      {isCur && up && ahead > 0 && behind > 0 && dItem("fpush", t("force push（--force-with-lease）"), "git push --force-with-lease")}
      {isCur && up && behind > 0 && item("pull", () => run("git pull"))}
      {isCur && up && behind > 0 && dItem("reset", t("用远程覆盖本地"), `git fetch ${q(remoteName)} && git reset --hard ${q(up)}`)}
      {!up && item(t("推送并跟踪"), () => run(`git push -u ${q(remoteName)} ${q(ref)}`))}
      {!up && item(t("设上游…"), () => openPrompt("upstream"))}
      {item(t("分支对比…"), () => { setCompareFrom(ref); setMenu(null); })}
      {item(t("基于它新建分支…"), () => openPrompt("newbranch"))}
      {item(t("改名…"), () => openPrompt("rename"))}
      {/* 加远端不是分支操作,但挂这里:本地分支排永远画得出来,而仓库 tab 排在零远端时整排不画 ——
          放那儿的话,最需要「新建远端」的那一刻恰好没有入口。 */}
      {item(t("新建远端…"), newRemote)}
      {/* -d 只删"已合并"的分支,有未合并提交时 git 会拒绝(这是它在护着你)。
          所以再给一条 -D:仅当分支还有提交没进当前分支时才需要,单列一条并说清后果。 */}
      {!isCur && dItem(`del:${ref}`, t("删除分支"), `git branch -d ${q(ref)}`)}
      {!isCur && dItem(`delf:${ref}`, t("强制删除分支（含未合并提交）"), `git branch -D ${q(ref)}`)}
    </>;
  };

  return (
    <div className="info-scroll branches-tab">
      {compareView ? (
        <section className="branches-card branches-graph-card">
          <DiffView current={compareView.from} other={compareView.to} diff={diff} fileDiff={fileDiff}
            onBack={() => setCompareView(null)}
            onRefresh={() => requestGitDiff(session.id, compareView.from, compareView.to)}
            onFile={(file) => requestGitFileDiff(session.id, compareView.from, compareView.to, file)} />
        </section>
      ) : (
        <>
          {/* ① 暂存区:工作区改动 */}
          <section className="sync-zone">
            <div className="sync-zone-h">
              <span className="sec-label">{t("暂存区")}</span>
              <span style={{ flex: 1 }} />
              {dirty && <span className="branches-changed-ops">
                <button className="dangr" title={t("git reset --hard HEAD（丢弃全部改动,不可逆）")} onClick={() => danger(t("丢弃全部改动"), "git reset --hard HEAD")}>{t("丢弃改动")}</button>
              </span>}
            </div>
            {/* commit 完成 → 文件行清空 → 下方整块内容瞬间上移,是这一页最刺眼的跳变。
                改成 grid 0fr↔1fr 折叠(退场时渲染 exiting 里留的最后一份列表,否则内容先消失、盒子塌成空的再收) */}
            <div className={`brz-collapse ${dirty ? "open" : ""}`}>
              <div className="brz-collapse-in">
                {exiting.map((f) => <div key={f.path} className="branches-file"><b className={`st st-${f.status[0]}`}>{f.status}</b><span title={f.path}>{f.path}</span>
                  <button className="ghost" title={t("查看改动")} onClick={() => viewWorktree(f.path)}><FileDiff size={13} /></button></div>)}
              </div>
            </div>
            {!dirty && <div className="muted">{t("工作区干净")}</div>}
          </section>

          {/* 竖线①(暂存区→本地分支):只有待提交改动时才画,线垂直对准左侧「本地分支」列中心
              —— 指明这些改动是 commit 到当前本地分支的。线上挂 commit 按钮。
              流光(flow-down)只在真的 commit 进行时点亮:平时一直流会让人以为有活在跑。 */}
          {/* commitFlow 也算"展开":commit 一成功 git 就刷新、dirty 立刻变 false,只看 dirty 的话
              这条线连着流光一起被折叠掉 —— 光才跑了几百毫秒就没了,比 push 那条(竖脊常驻)短一大截。
              留到 commitFlow 落下再收,COMMIT_HOLD_MS 那 3s 才真的看得见。 */}
          <div className={`brz-collapse ${dirty || commitFlow ? "open" : ""}`}>
            <div className="brz-collapse-in">
              {/* 线要平移到当前分支 chip 的中线上,而当前分支现在可能排在任意一格(顺序固定后不再钉最左)。
                  直接平移会把线上的 commit 按钮推出容器(外层 .brz-collapse-in 是 overflow:hidden,截掉就没了),
                  所以两头都夹一下:±50% 是容器半宽(线到左/右边缘),再各留 42px 给按钮的一半。 */}
              <div className={`sync-link ${commitFlow ? "flow-down" : ""}`} style={{ transform: `translateX(clamp(calc(-50% + 42px), ${stemDx}px, calc(50% - 42px)))` }}>
                <span className="sync-wire" />
                {/* 提交进行中:按钮撤掉换成等高的线段 —— 它这时既点不动又正好挡住流光,留着只剩噪音 */}
                {commitFlow ? <span className="sync-wire wire-gap" /> : <div className="sync-hub">
                  {/* 只写 commit:改动条数上面暂存区那排文件已经逐条列着,按钮再报一遍只是把自己撑宽 */}
                  <button className="sync-act commit" title={t("提交改动（{{count}} 处）", { count: exiting.length })} onClick={onCommit}>
                    <span>commit</span>
                  </button>
                </div>}
                <span className="sync-wire" />
                {/* 延长段:跨过 gap + 「本地分支」标题带,把箭头一路送到当前分支 chip 的上边缘正中 */}
                <span className="sync-wire sync-stem" />
                <span className="sync-arrow" />
              </div>
            </div>
          </div>

          {/* ② 竖脊:聚焦的本地分支 → 扇出到每个远端 → 落到下面的仓库 tab(同时是拓扑的切换器) */}
          <section className="sync-zone">
            {compareFrom && <div className="branches-pick-hint">{t("选择要与")} <b>{compareFrom}</b> {t("对比的另一个分支节点…")} <button className="ghost" onClick={() => setCompareFrom(null)}><X size={12} /> {t("取消")}</button></div>}
            <BranchSpine local={git.local} remote={git.remote} remoteSha={git.remoteSha} remotes={git.remotes}
              current={current} focus={focusName} repo={graphRepo} dirty={dirty} picking={compareFrom}
              onChip={onChip} onFocus={setFocus} onRepo={setRepo} onRun={run}
              onRepoMenu={onRepoMenu}
              pushing={pushing} pushFlow={pushFlow} pullFlow={pullFlow}
              onNew={(target) => { setConfirm(null); setMenu(null); setPrompt({ kind: "newbranch", target, ref: focusName || "HEAD", val: "" }); }}
              onPush={(cmd) => { if (pushing) return; setPushing(true); runTerminal(session.id, cmd); }}
              onStem={setStemDx}
              // 地址行由外面给、在脊里渲染:它讲的是"上面选中的那个远端在哪",贴着 tab 才读得出这层关系。
              // 传节点而不是 4 个数据 prop —— 拼这行要 repoUrl/repoWeb/multiRemote/urlRemote,全塞进 BranchSpine 是给它塞它不管的事。
              urlLine={repoUrl ? <div className="brz-url-row">
                <button className="branches-subline" title={repoWeb ? t("在浏览器打开远程仓库") : repoUrl} disabled={!repoWeb} onClick={() => repoWeb && openUrl(repoWeb)}>
                  {multiRemote && <b className="branches-subline-remote">{urlRemote}</b>}{repoUrl}</button>
              </div> : null} />
          </section>

          {/* ③ 提交拓扑:本地 + 远程提交历史。琥珀点跟着上面选中的仓库 tab 走。
              标题去掉了 —— 上面地址行已经交代了"在看哪个远端",再来个「提交拓扑」只是重复地把图往下推。 */}
          <section className="sync-zone brz-graph-zone">
            {log?.commits.length
              ? <div className="branches-graph"><Graph log={log} repo={graphRepo} current={current} dirty={dirty} picking={compareFrom} onChip={onChip} /></div>
              : <div className="muted branches-empty">{t("暂无提交记录")}</div>}
          </section>
          <div className="branches-hint muted">{multiRemote
            ? t("点本地分支标签切换、右键看操作 · 琥珀点=还没推到 {{repo}}", { repo: urlRemote })
            : t("点本地分支标签切换、右键看操作 · 琥珀点=未推送")}</div>
        </>
      )}
      {menu && createPortal(
        <>
          <div className="bmenu-backdrop" onMouseDown={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
          <div className="bmenu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 320) }} onMouseDown={(e) => e.stopPropagation()}>
            {menuBody()}
          </div>
        </>, document.body)}
      {prompt && createPortal(
        <div className="commit-modal-overlay" onMouseDown={() => setPrompt(null)}>
          <div className="commit-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="commit-modal-title">
              {prompt.kind === "rename" ? t("改名 {{ref}}", { ref: prompt.ref })
                : prompt.kind === "newbranch" ? t("新建{{type}}分支", { type: prompt.target === "remote" ? t("远程") : t("本地") })
                : prompt.kind === "remoteadd" ? t("新建远端")
                : prompt.kind === "remotename" ? t("重命名远端 {{ref}}", { ref: prompt.ref })
                : prompt.kind === "remoteurl" ? t("修改 {{ref}} 的 URL", { ref: prompt.ref })
                : t("设 {{ref}} 的上游", { ref: prompt.ref })}
            </div>
            {prompt.kind === "upstream"
              ? <select className="git-map-input" autoFocus value={prompt.val} onChange={(e) => setPrompt({ ...prompt, val: e.target.value })}>
                  <option value="">{t("选择远程分支")}</option>
                  {git.remote.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              : <input className="git-map-input" autoFocus value={prompt.val}
                  placeholder={prompt.kind === "rename" || prompt.kind === "remotename" ? t("新名字")
                    : prompt.kind === "remoteadd" ? t("远端名（如 origin）")
                    : prompt.kind === "remoteurl" ? t("仓库 URL") : t("新分支名")}
                  onChange={(e) => setPrompt({ ...prompt, val: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Escape") setPrompt(null); if (e.key === "Enter" && !e.nativeEvent.isComposing) submitPrompt(); }} />}
            {/* 新建远端要两截:名字 + URL。分两个框而不是让用户按空格拼一行 —— URL 里本来就可能带空格转义 */}
            {prompt.kind === "remoteadd" && <>
              <div className="git-map-sublabel">{t("仓库 URL")}</div>
              <input className="git-map-input" value={prompt.val2 || ""} placeholder="git@github.com:user/repo.git"
                onChange={(e) => setPrompt({ ...prompt, val2: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Escape") setPrompt(null); if (e.key === "Enter" && !e.nativeEvent.isComposing) submitPrompt(); }} />
            </>}
            {/* 来源(照搬 GitHub 的 Create a branch):新分支从哪个 ref 拉出来,本地/远程 ref 都能选 */}
            {prompt.kind === "newbranch" && <>
              <div className="git-map-sublabel">{t("来源")}</div>
              <select className="git-map-input" value={prompt.ref} onChange={(e) => setPrompt({ ...prompt, ref: e.target.value })}>
                {git.local.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                {git.remote.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </>}
            <div className="commit-modal-actions">
              <button type="button" onClick={() => setPrompt(null)}>{t("取消")}</button>
              <button type="button" className="hi" disabled={!prompt.val.trim() || (prompt.kind === "remoteadd" && !(prompt.val2 || "").trim())} onClick={submitPrompt}>{t("确定")}</button>
            </div>
          </div>
        </div>, document.body)}
      {confirm && <ConfirmDialog title={t("确认{{label}}?", { label: confirm.label })} body={<>{t("将执行")} <code>{confirm.cmd}</code>{t(",危险操作不可撤销。")}</>}
        onConfirm={() => run(confirm.cmd)} onCancel={() => setConfirm(null)} />}
      {wtFile && createPortal(
        <div className="wtdiff-shade" onClick={() => setWtFile(null)}>
          <div className="wtdiff-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wtdiff-head"><b title={wtFile}>{wtFile}</b><button className="ghost" title={t("关闭")} onClick={() => setWtFile(null)}><X size={15} /></button></div>
            <div className="wtdiff-body">
              {!wtReady ? <div className="muted branches-empty">{t("加载中…")}</div>
                : fileDiff!.error ? <div className="branches-diff-err">{t("无法读取:{{error}}", { error: fileDiff!.error })}</div>
                : <DiffHtml patch={fileDiff!.patch} clipped={fileDiff!.clipped} />}
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}

// 竖脊:工作区 →(竖线①)→ 本地分支 →(扇出)→ 各远端 →(下方)提交拓扑,从上到下一条链路。
//   - 顶上一排本地分支 chip:高亮的那个是**聚焦**分支(默认跟当前分支)。点一下只换视角,不跑 git switch
//     —— 这页以只读为主,点标签就改工作区状态太重;切分支仍在 chip 的右键菜单里。
//   - 中段扇出:一个远端一条线,落到下面对应的仓库 tab。upstream 那条画实线(git 认的映射),
//     同名兜底来的画虚线 —— 画实线等于替 git 承诺一件它不会做的事,用户会以为一次 push 两边都到了。
//   - 主干上一颗 push 药丸(推全部)、每条分叉上一颗 ↑(只推这条)。聚焦的不是当前分支时整组不画:
//     `git push` 推的是你实际所在的分支,给别的分支画 push 按钮等于骗人。
//   - 底下一排仓库 tab 既是扇出的落点,也是提交拓扑的切换器(选中谁,下面就按谁算未推送、显示谁的地址)。
// tab 固定宽:宽度写死才能纯算出每条线的 x,不用 ResizeObserver 去量容器。
// ponytail: 远端多到排不下时横向溢出,不做换行/自适应 —— 一个仓库配三个以上远端本就罕见。
const TAB_W = 118, TAB_GAP = 10;
// 右侧槽:挂「新建」虚线框。左边那格配重槽拆了 —— 整排改成左对齐(和上面 chip 排、和三个标题同一条左线),
// 不再有"落在容器中线"这回事,主干直接对准聚焦 chip 的中线。
const SIDE_W = 46;
const FORK_Y = 34, DROP_H = 40, FAN_H = FORK_Y + DROP_H; // 主干高 / 分叉后下落段高
const TAIL = 26; // 传输光点的尾迹长度(px,svg 用户坐标)
function BranchSpine({ local, remote, remoteSha, remotes, current, focus, repo, dirty, picking, onChip, onFocus, onRepo, onRun, onRepoMenu, pushing, pushFlow, pullFlow, onPush, onNew, urlLine, onStem }:
  { local: GitBranch[]; remote: string[]; remoteSha?: Record<string, string>; remotes: string[]; current: string; focus: string; repo: string | null; dirty: boolean;
    picking: string | null; onChip: (ref: string, remote: boolean, e: React.MouseEvent) => void; onFocus: (name: string) => void; onRepo: (name: string) => void;
    onRun: (cmd: string) => void; onRepoMenu: (name: string, e: React.MouseEvent) => void;
    pushing: boolean; pushFlow: boolean; pullFlow: boolean; onPush: (cmd: string) => void;
    onNew: (target: "local" | "remote") => void; urlLine: React.ReactNode; onStem: (dx: number) => void }) {
  const { t } = useTranslation();
  // 这次 push 点的是哪几个远端。只喂光束用,不进全局 —— 推完 pushFlow 一落就没人读了。
  const [beamTo, setBeamTo] = useState<string[] | null>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState({ focus: 0, cur: 0, w: 0 }); // chip 中心距竖脊左边的距离(px) + 竖脊宽
  useLayoutEffect(() => {
    const band = bandRef.current, root = band?.parentElement;
    if (!band || !root) return;
    const box = root.getBoundingClientRect();
    const at = (name: string) => {
      const el = band.querySelector(`[data-ref="${CSS.escape(name)}"]`) as HTMLElement | null;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2 - box.left);   // 整排左对齐了,一律按"距左边多远"量
    };
    const next = { focus: at(focus), cur: at(current), w: Math.round(box.width) };
    setDx((p) => (p.focus === next.focus && p.cur === next.cur && p.w === next.w ? p : next));
    // 竖线①那块仍是居中布局(它在竖脊外面,拿不到这个左边),换算成"相对中线"的偏移给它
    onStem(next.cur - next.w / 2);
  });
  const b = local.find((x) => x.name === focus);
  const isCur = focus === current;
  // 顶排顺序:main → 其余按名排。**不掺当前分支** —— 切一次分支就整排重洗的话,
  // 刚点的那个标签会从手指底下跑到最左边,下一次要点谁得重新找。位置固定,肌肉记忆才立得住。
  const rank = (x: GitBranch) => (x.name === "main" ? 0 : 1);
  const localSorted = [...local].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  // 上游那条 lane 同理排最左:它是当前分支真正映射到的远程分支,和上面第一格的 chip 对齐着读。
  // sort 稳定,其余远端保持 remotes 的原顺序。
  const lanes = lanesFor(focus, remotes, remote, b?.upstream)
    .sort((x, y) => Number(y.isUpstream) - Number(x.isUpstream));
  const laneRefs = lanes.map((l) => l.ref).filter(Boolean) as string[];
  const up = lanes.find((l) => l.isUpstream)?.ref;
  // push 按钮只给当前分支,且只给"确实还有东西可推"的远端(判定见 pushTargets)。
  // ref 还不存在的远端(从没推过)也算可推:那次 push 会把分支建出来。
  const pushable = isCur && b ? new Set(pushTargets(b, laneRefs, up, remoteSha)) : new Set<string>();
  const pushCmdFor = (l: RepoLane) => l.ref
    ? pushCmd(focus, l.ref)
    : `git push ${up ? "" : "-u "}${q(l.remote)} ${q(focus)}`;  // 远端还没这条分支:顺手建出来
  const canPush = (l: RepoLane) => isCur && !!b && (l.ref ? pushable.has(l.ref) : true);
  const pushLanes = lanes.filter(canPush);
  const showPush = pushLanes.length > 0 && !pushFlow && !pushing;

  const total = lanes.length * TAB_W + Math.max(0, lanes.length - 1) * TAB_GAP;
  const rowW = total + SIDE_W + TAB_GAP;                  // 整排宽 = tab 组 + 右侧「新建」槽
  // 主干 x = 聚焦那个 chip 的中线(距竖脊左边多远)—— 线要从这条分支底边正中长出来才读得通。
  // chip 宽度随分支名变,只能量。上面竖线①同样按 dx.cur 平移(它指的是当前分支)。
  // ponytail: 每次渲染量一遍(值没变就不 setState),不上 ResizeObserver —— 抽屉宽变了会重渲染,够用。
  const cx = dx.focus;
  const tabX = (i: number) => i * (TAB_W + TAB_GAP) + TAB_W / 2;  // 第 i 个 tab 的中心 x(整排左对齐,左边不再留配重槽)
  const beam = isCur ? (pushFlow ? "out" : pullFlow ? "in" : undefined) : undefined;
  // 光束跑哪几条:点主干药丸=这次推的全部远端,点某条 ↑=只那条。在终端手敲 git push 时 beamTo 为空,
  // 退回"所有还能推的" —— 光束是进度指示,宁可多画一条也不能一条不画。
  const beamLanes = beam === "in" ? lanes.filter((l) => l.isUpstream)   // pull 只来自上游那条
    : lanes.filter((l) => (beamTo ? beamTo.includes(l.remote) : canPush(l)));
  const beamShow = beamLanes.length ? beamLanes : lanes;

  const tagTitle = (x: GitBranch) =>
    `${x.name}${x.name === current ? t("（当前）") : ""}${x.gone ? t(" · 上游 {{up}} 已在远程删除", { up: x.upstream }) : x.upstream ? `${t(" · 上游 {{up}}", { up: x.upstream })}${x.upstreamAuthor ? t("（{{author}}）", { author: x.upstreamAuthor }) : ""}${x.ahead ? ` ↑${x.ahead}` : ""}${x.behind ? ` ↓${x.behind}` : ""}` : t(" · 未跟踪")}${t(" · 点击切换到它,右键查看操作")}`;

  // 扇出:主干竖着下来到 FORK_Y,横向摊到各 tab 中心,再落一小段到 tab 顶。拐角走 6px 圆角
  // —— 直角在 1.5px 线宽上会顶出个小方块,圆角才读得出是"从主干分出去的"。
  // 光束和线画在同一个 svg 里 —— 另起一个 absolute svg 盖上去,半像素定位差就永远对不齐。
  const R = 6, tipY = FAN_H;
  // 一条 lane 的完整走线。y0=FORK_Y 画的是分叉段(主干另画),y0=0 画的是"主干+分叉"整条 —— 光束要跑的就是后者:
  // 推到哪个远端,光就顺着哪条线一路走到那个 tab,不能在分叉口停下。
  // 圆角半径按横移距离收:主干挪到 chip 中线后,某条 lane 可能离主干只有几 px,固定 6px 会把线折回去
  const rOf = (x: number) => Math.min(R, Math.abs(x - cx));
  const forkPath = (x: number, y0: number) => Math.abs(x - cx) < 1
    ? `M ${cx} ${y0} V ${tipY - 7}`
    : `M ${cx} ${y0} V ${FORK_Y} H ${x - Math.sign(x - cx) * rOf(x)} Q ${x} ${FORK_Y} ${x} ${FORK_Y + rOf(x)} V ${tipY - 7}`;
  // 整条走线的长度(圆角按 1/4 圆算)。光束靠 stroke-dashoffset 跑,得知道跑多远才停。
  const forkLen = (x: number) => Math.abs(x - cx) < 1 ? tipY - 7
    : FORK_Y + (Math.abs(x - cx) - rOf(x)) + (Math.PI * rOf(x)) / 2 + (tipY - 7 - FORK_Y - rOf(x));
  return (
    <div className="brz-spine">
      <div className="brz-spine-h">
        <span className="sec-label">{t("本地分支")}</span>
      </div>
      {!local.length && <span className="muted brz-empty">{t("暂无本地分支")}</span>}
      <div className="brz-band" ref={bandRef}>
        {localSorted.map((x) => (
          <button key={x.name} data-ref={x.name}
            className={`brz-tag local ${x.name === current ? "cur" : ""} ${x.name === focus ? "focus" : ""} ${x.gone ? "gone" : ""} ${picking && picking !== x.name ? "pick-target" : ""} ${picking === x.name ? "pick-self" : ""}`}
            title={tagTitle(x)}
            // 一律 onMouseDown,不用 onClick:WKWebView 里输入框聚焦时,落在别处的第一次点击只用来切焦点、
            // 不派发 click —— 表现就是"要点两次才生效"(菜单项早前踩过同一个坑)。
            // 左键=切到这条分支(顺手先聚焦,git switch 跑完前脊就已经指过去了);
            // 对比拾取中左键也走 onChip,否则选不了对端。
            // ponytail: 工作区脏时 git 自己会拒绝并把原因打进时间线,这里不预判 —— 它的判断比我们准。
            onMouseDown={(e) => {
              if (picking) onChip(x.name, false, e);
              else if (e.button === 0) { onFocus(x.name); if (x.name !== current) onRun(`git switch ${q(x.name)}`); }
            }}
            // 右键菜单挂 contextmenu 而不是 mousedown(button===2):触控板「辅助点按」/ 部分鼠标在
            // WKWebView 里只派发 contextmenu,右键 mousedown 不到,表现就是"右键完全没反应"。
            onContextMenu={(e) => { e.preventDefault(); onChip(x.name, false, e); }}>
            <span className="brz-tag-name">{x.name}</span>
            {x.name === current && dirty && <span className="cg-ref-dirty" title={t("有未提交改动")}>*</span>}
          </button>
        ))}
        {/* 建分支的入口从标题旁的小 + 挪到这里:和 chip 排在一起,读作"这一排的下一个",而不是标题的附属。
            本地这排是横的(+ 新建 并排):chip 只有 26px 高,竖排两行的框会比旁边高出一截,读作另一种东西 */}
        <button className="brz-new inline" title={t("新建本地分支")} onClick={() => onNew("local")}>
          <Plus size={12} /><span>{t("新建")}</span>
        </button>
      </div>
      {/* 画布至少要包住主干:聚焦的 chip 可能排在很靠右的位置(名字长的一串),svg 只有 tab 排那么宽的话
          主干和它的圆角会被裁掉半截。多出来的宽度是透明的,不影响布局。 */}
      {!!lanes.length && (
        <div className="brz-fan" style={{ width: Math.max(rowW, cx + 8) }}>
          <svg className="brz-map-svg" width={Math.max(rowW, cx + 8)} height={FAN_H}>
            <line x1={cx} y1={0} x2={cx} y2={FORK_Y} className={`brz-map-line ${isCur ? "cur" : ""}`} />
            <circle cx={cx} cy={1} r={2.5} className="brz-map-dot" />
            {lanes.map((l, i) => {
              const x = tabX(i), dash = !l.isUpstream;
              const cls = `brz-map-line ${isCur ? "cur" : ""} ${dash ? "dash" : ""}`;
              return (
                <g key={l.remote}>
                  <path fill="none" className={cls} d={forkPath(x, FORK_Y)} />
                  <path d={`M ${x - 4} ${tipY - 8} L ${x} ${tipY} L ${x + 4} ${tipY - 8} Z`} className={`brz-map-head ${dash ? "dash" : ""}`} />
                </g>
              );
            })}
            {/* 光束:每条被推的 lane 一条,走的是"主干 + 自己那条分叉"的整条线。多条时主干那段完全重合,
                看起来就是一束光下来、到分叉口分成几束 —— 正是 push 实际在做的事。
                实现走 stroke-dashoffset:一段 TAIL 长的实线在 (TAIL + 全长) 的虚线周期里向前挪,
                拐弯和圆角自动跟着路径走。pull 反向,靠 animation-direction: reverse。
                ponytail: 尾迹从"渐隐渐变"降级成实心圆头短线 —— 渐变得沿路径方向走,而路径要拐 90°,
                一条 linearGradient 撑不住;要真做得按段切渐变或上 offset-path,不值这 0.3 秒。 */}
            {beam && beamShow.map((l) => {
              const x = tabX(lanes.indexOf(l));
              return <path key={l.remote} className={`brz-beam ${beam}`} fill="none" d={forkPath(x, 0)}
                // --beam-end 是 -全长,直接由 JS 给出:CSS 里 calc(var() * -1) 作用在无单位数上,各引擎认得不齐
                style={{ "--beam-len": `${forkLen(x)}`, "--beam-end": `${-forkLen(x)}`, "--beam-tail": `${TAIL}` } as React.CSSProperties} />;
            })}
          </svg>
          {/* 主干上的 push 药丸:一次推到全部还有东西可推的远端。推送进行中撤掉 —— 按钮压在线上会截断光束。
              只有"全部 lane 都还能推"时才挂在主干上:推完其中一个远端后主干那颗还留着,读起来像"还要全推一次",
              可它实际只推剩下那条 —— 那种时候按钮该待在剩下那条分叉线上。 */}
          {showPush && b && pushLanes.length === lanes.length && (
            <button className="brz-push" style={{ left: cx, top: FORK_Y / 2 }}
              title={pushLanes.length > 1
                ? t("一次推到全部 {{n}} 个远端:{{list}}", { n: pushLanes.length, list: pushLanes.map((l) => l.remote).join("、") })
                : t("推送到 {{r}}:{{cmd}}", { r: pushLanes[0].ref || pushLanes[0].remote, cmd: pushCmdFor(pushLanes[0]) })}
              onClick={(e) => { e.stopPropagation(); setBeamTo(pushLanes.map((l) => l.remote)); onPush(pushLanes.map(pushCmdFor).join(" && ")); }}>
              <span>push</span>
            </button>
          )}
          {/* 分叉线上各挂一个 ↑:只推这一条。多远端时一直画 —— 主干那颗"全推"只在全都能推时才在,
              它一撤,这排就是唯一入口,位置也正好指出剩的是哪条。单远端时不画:和主干药丸重复。 */}
          {showPush && b && lanes.length > 1 && lanes.map((l, i) => canPush(l) && (
            <button key={l.remote} className="brz-push-one" style={{ left: tabX(i), top: FORK_Y + DROP_H / 2 }}
              title={t("只推到 {{r}}:{{cmd}}", { r: l.ref || l.remote, cmd: pushCmdFor(l) })}
              onClick={(e) => { e.stopPropagation(); setBeamTo([l.remote]); onPush(pushCmdFor(l)); }}>
              {/* 箭头朝下:这张图是本地在上、远端在下,push 是往下走的 */}
              <ArrowDown size={11} />
            </button>
          ))}
        </div>
      )}
      {/* 仓库 tab:扇出的落点 + 提交拓扑的切换器。副标题是这个仓库里对应聚焦分支的那条远程分支;
          还没有就是虚线的「新建」—— 占住位说明"这里本该有条分支",点一下(经 push 按钮)就建出来。
          外面这层撑满宽度,标题绝对定位钉在左边:tab 排是定宽居中的,远端一多就比抽屉宽、两头溢出,
          标题跟着排走就会被裁掉。钉在容器左边才和「暂存区」「本地分支」对齐,也永远看得见。 */}
      <div className="brz-remote">
        <span className="sec-label brz-remote-h">{t("远程分支")}</span>
        {/* 全局 fetch 钉在抽屉最右、和标题同一行:它作用于所有远端,不属于居中那排 tab 里的任何一个。
            「新建远端」不在这里 —— 见本地分支右键菜单(那里一个远端都没有时也还在)。 */}
        <button className="ghost brz-remote-op" title={t("拉取全部远端信息（git fetch --all --prune）")} onClick={() => onRun("git fetch --all --prune")}><RotateCw size={11} /></button>
        {!lanes.length ? <div className="muted brz-empty brz-remote-empty">{t("暂无远程仓库")}</div> : (
        <div className="brz-tabs" style={{ width: rowW, gap: TAB_GAP, "--side-w": `${SIDE_W}px` } as React.CSSProperties}>
          <div className="brz-tabrow" style={{ gap: TAB_GAP }}>
          {lanes.map((l) => (
            <button key={l.remote} className={`brz-tab ${l.remote === repo ? "sel" : ""} ${l.ref ? "" : "empty"} ${l.isUpstream ? "up" : ""}`}
              style={{ width: TAB_W }} title={(l.ref
                ? (l.isUpstream ? t("{{r}} · 上游,裸 git push 去这里", { r: l.ref }) : t("{{r}} · 同名远程分支,不是上游:裸 git push 不会推到这里", { r: l.ref }))
                : t("{{remote}} 里还没有 {{name}} 分支", { remote: l.remote, name: focus })) + t(" · 右键管理远端")}
              onMouseDown={() => onRepo(l.remote)}
              onContextMenu={(e) => onRepoMenu(l.remote, e)}>
              <b className="brz-tab-remote">{l.remote}</b>
              <span className="brz-tab-ref" data-ref={l.ref || ""}
                // 副标题那半是个能点的分支节点(有 ref 才有):走原来那套菜单(检出/对比/删远程)。
                // stopPropagation 拦住外层的切仓库 —— 一次点击又切视图又弹菜单,读不出自己按了什么。
                onMouseDown={(e) => { if (l.ref) { e.stopPropagation(); onChip(l.ref, true, e); } }}
                // 右键落在副标题上要的是分支菜单,别让它冒到 tab 上被远端菜单顶掉
                onContextMenu={(e) => { if (l.ref) { e.preventDefault(); e.stopPropagation(); onChip(l.ref, true, e); } }}>
                <Cloud size={9} className="brz-tag-ico" />{l.ref ? l.ref.split("/").slice(1).join("/") : t("新建")}
              </span>
            </button>
          ))}
          </div>
          {/* 右侧槽:建远程分支的入口。原来是 tab 下面一行灰字,和 tab 不在一个层级上,读起来像脚注;
              摆成同一排的虚线框才读得出"这里可以再多一个远端分支"。 */}
          <button className="brz-new brz-side" title={t("新建远程分支")} onClick={() => onNew("remote")}>
            <Plus size={12} /><span>{t("新建")}</span>
          </button>
        </div>
        )}
        {urlLine}
      </div>
      {/* 远程行缺本地端的老入口:同名本地分支已存在(只是没设上游)→ 设上游;否则检出并跟踪。
          现在挂在聚焦分支上:它有远程同名分支却没设上游时,提示一下就能补。 */}
      {b && !b.upstream && laneRefs.length > 0 && (
        <button className="ghost brz-spine-tip" onClick={() => onRun(`git branch --set-upstream-to=${q(laneRefs[0])} ${q(focus)}`)}>
          {t("{{name}} 还没有上游,设为 {{ref}}", { name: focus, ref: laneRefs[0] })}
        </button>
      )}
    </div>
  );
}

// 自绘紧凑泳道图:泳道算法把每个提交分到一条 lane(分叉占新 lane、合并回收),完全控宽,适配窄抽屉。
const LANE_W = 14, ROW_H = 52, DOT_R = 4;
const LANE_COLORS = ["#3b82f6", "#e5484d", "#2e9c58", "#d58b00", "#8b5cf6", "#0891b2", "#db2777", "#65a30d"];
const laneColor = (i: number) => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];

function buildGraph(commits: GitCommit[]) {
  const rowOf = new Map<string, number>(); commits.forEach((c, i) => rowOf.set(c.hash, i));
  const colOf = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const rows: { c: GitCommit; col: number }[] = [];
  const takeLane = (h: string) => { let e = lanes.indexOf(null); if (e === -1) { e = lanes.length; lanes.push(null); } lanes[e] = h; return e; };
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    if (col === -1) col = takeLane(c.hash);
    colOf.set(c.hash, col);
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.hash) lanes[i] = null; // 合并:收拢同名 lane
    rows.push({ c, col });
    const ps = c.parents;
    if (!ps.length) lanes[col] = null;
    else { lanes[col] = ps[0]; for (let k = 1; k < ps.length; k++) if (lanes.indexOf(ps[k]) === -1) takeLane(ps[k]); }
  }
  const edges: { fromRow: number; fromCol: number; toRow: number; toCol: number }[] = [];
  for (const { c, col } of rows) for (const p of c.parents) {
    const pr = rowOf.get(p); if (pr === undefined) continue; // 父提交超出拉取范围,不画
    edges.push({ fromRow: rowOf.get(c.hash)!, fromCol: col, toRow: pr, toCol: colOf.get(p)! });
  }
  const laneCount = Math.max(1, ...rows.map((r) => r.col + 1));
  return { rows, edges, laneCount };
}

function Graph({ log, repo, current, dirty, picking, onChip }: { log: GitLogData; repo: string | null; current: string; dirty: boolean; picking: string | null; onChip: (ref: string, remote: boolean, e: React.MouseEvent) => void }) {
  const { t } = useTranslation();
  const { rows, edges, laneCount } = useMemo(() => buildGraph(log.commits), [log.commits]);
  // 远程 chip 只画选中仓库的(切换器在上面的仓库 tab)。本地 ref 全留 —— 它们不属于任何远端,
  // 藏了反而看不出 main/cloud 停在哪。
  const headsBySha = useMemo(() => {
    const m = new Map<string, { name: string; remote: boolean }[]>();
    for (const h of log.heads) {
      if (h.remote && repo && h.name.split("/")[0] !== repo) continue;
      const a = m.get(h.sha) || []; a.push({ name: h.name, remote: h.remote }); m.set(h.sha, a);
    }
    return m;
  }, [log.heads, repo]);
  // 未推送(琥珀点)也按选中仓库算 —— 判定和自检见 gitcmd.ts 的 unpushedFor
  const unpushed = useMemo(() => unpushedFor(log.commits, log.heads, repo), [log.commits, log.heads, repo]);
  const gutter = laneCount * LANE_W;
  const x = (col: number) => LANE_W / 2 + col * LANE_W;
  const y = (row: number) => ROW_H / 2 + row * ROW_H;
  return (
    <div className={`cg ${picking ? "picking" : ""}`} style={{ position: "relative", paddingLeft: gutter }}>
      <svg className="cg-svg" width={gutter} height={rows.length * ROW_H} style={{ position: "absolute", left: 0, top: 0 }}>
        {edges.map((e, i) => {
          const x1 = x(e.fromCol), y1 = y(e.fromRow), x2 = x(e.toCol), y2 = y(e.toRow);
          const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` // 同 lane:直线
            : `M${x1} ${y1} C ${x1} ${y1 + ROW_H * 0.6}, ${x2} ${y2 - ROW_H * 0.6}, ${x2} ${y2}`; // 跨 lane:平滑曲线
          return <path key={i} d={d} fill="none" stroke={laneColor(Math.min(e.fromCol, e.toCol))} strokeWidth={1.5} />;
        })}
        {rows.map((r, i) => <circle key={i} cx={x(r.col)} cy={y(i)} r={DOT_R} fill={unpushed.has(r.c.hash) ? "#d58b00" : laneColor(r.col)} stroke="var(--panel)" strokeWidth={1.5} />)}
      </svg>
      {rows.map((r) => {
        const refs = headsBySha.get(r.c.hash) || [];
        const isUnpushed = unpushed.has(r.c.hash);
        return (
          <div key={r.c.hash} className={`cg-row ${isUnpushed ? "unpushed" : ""}`} style={{ height: ROW_H }} title={`${r.c.hash.slice(0, 8)}  ${r.c.author}  ${r.c.subject}${isUnpushed ? `  ${t("(未推送)")}` : ""}`}>
            {/* 上行=这条提交的身份(分支标签 / 作者 / 时间),下行=说明文字。
                说明常被截断,和身份挤一行时先牺牲的总是身份,分两行谁都不用让。 */}
            <div className="cg-row-top">
              <span className="cg-meta">{r.c.author} · {fmtDate(r.c.date)}</span>
              {refs.map((rf) => (
                <button key={rf.name} className={`cg-ref ${rf.name === current ? "cur" : ""} ${rf.remote ? "remote" : "local"} ${picking && picking !== rf.name ? "pick-target" : ""} ${picking === rf.name ? "pick-self" : ""}`}
                  onMouseDown={(e) => onChip(rf.name, rf.remote, e)} title={picking ? (picking === rf.name ? t("对比左端") : t("与 {{picking}} 对比", { picking })) : t("{{name}} · 点击查看操作", { name: rf.name })}>
                  {rf.remote && <Cloud size={9} className="cg-ref-ico" />}{rf.name}
                  {rf.name === current && dirty && <span className="cg-ref-dirty" title={t("有未提交改动")}>*</span>}
                </button>
              ))}
              {isUnpushed && <span className="cg-unpushed">{t("未推送")}</span>}
            </div>
            <span className="cg-subject">{r.c.subject || t("(无提交说明)")}</span>
          </div>
        );
      })}
    </div>
  );
}
function fmtDate(d: string) { return new Date(d).toLocaleString(i18n.language === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

// 对比视图:两 ref 各自独有提交数 + 文件级 +/− 统计;点文件名内联展开该文件 patch
function DiffView({ current, other, diff, fileDiff, onBack, onRefresh, onFile }: { current: string; other: string; diff?: { from: string; to: string; ahead: number; behind: number; files: { file: string; add: number | null; del: number | null }[]; error?: string }; fileDiff?: { from: string; to: string; file: string; patch: string; clipped?: boolean; error?: string }; onBack: () => void; onRefresh: () => void; onFile: (file: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null); // 当前展开看正文的文件
  const stale = !diff || diff.from !== current || diff.to !== other; // 结果还没回来/是上一次的
  useEffect(() => { setOpen(null); }, [current, other]); // 换对比对象收起展开
  const toggle = (file: string) => { if (open === file) { setOpen(null); return; } setOpen(file); onFile(file); };
  return (
    <div className="branches-diff">
      <div className="branches-sec-h graph-h">
        <button className="ghost" onClick={onBack} title={t("返回拓扑图")}><ArrowLeft size={13} /></button>
        {t("对比")} <b>{current}</b> ⇄ <b>{other}</b>
        <button className="ghost" title={t("刷新")} onClick={onRefresh}><RotateCw size={13} /></button>
      </div>
      {stale ? <div className="muted branches-empty">{t("正在比较…")}</div>
        : diff.error ? <div className="branches-diff-err">{diff.error}</div>
        : <>
          <div className="branches-diff-counts">
            <span className="branches-chip ahead">{t("{{a}} 独有 {{n}} 个提交", { a: current, n: diff.ahead })}</span>
            <span className="branches-chip behind">{t("{{a}} 独有 {{n}} 个提交", { a: other, n: diff.behind })}</span>
          </div>
          {diff.files.length
            ? diff.files.map((f) => {
                const bin = f.add === null;
                const isOpen = open === f.file;
                const ready = isOpen && fileDiff && fileDiff.file === f.file;
                return <div key={f.file} className={`branches-file-wrap ${isOpen ? "open" : ""}`}>
                  <div className={`branches-file diffline ${bin ? "" : "clickable"}`} onClick={bin ? undefined : () => toggle(f.file)} title={bin ? f.file : t("点击查看改动")}>
                    <span>{!bin && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}{f.file}</span>
                    <span className="branches-diff-nums">
                      {bin ? <i className="muted">{t("二进制")}</i> : <><b className="add">+{f.add}</b> <b className="del">−{f.del}</b></>}
                    </span>
                  </div>
                  {isOpen && <div className="branches-file-patch">{ready ? (fileDiff.error ? <span className="branches-diff-err">{t("无法读取:{{error}}", { error: fileDiff.error })}</span> : <DiffHtml patch={fileDiff.patch} clipped={fileDiff.clipped} />) : <span className="muted">{t("加载中…")}</span>}</div>}
                </div>;
              })
            : <div className="muted">{t("无文件差异")}</div>}
        </>}
    </div>
  );
}

// git status --short 解析。宽松匹配:sidecar 对整块 trim 过,首行前导空格被削,定长 slice(3) 会吃掉首行路径首字母。
function parseStatus(status?: string): { status: string; path: string }[] {
  if (!status) return [];
  return status.split("\n").filter(Boolean).map((line) => {
    const m = line.match(/^\s*(\S{1,2})\s+(.*)$/);
    return m ? { status: m[1], path: m[2].trim() } : { status: "?", path: line.trim() };
  });
}

// git 远程地址 → 可在浏览器打开的 https 网页地址。scp 式 ssh(git@host:owner/repo)、ssh:// 都转成 https;
// 已是 http(s) 直接用;认不出的返回 null(按钮置灰)。
function webUrl(u?: string): string | null {
  if (!u) return null;
  const s = u.trim().replace(/\.git$/, "");
  const scp = s.match(/^[\w.-]+@([^:]+):(.+)$/); // git@github.com:owner/repo
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = s.replace(/^ssh:\/\/[\w.-]+@/, "https://").replace(/^git:\/\//, "https://");
  return /^https?:\/\//.test(ssh) ? ssh : null;
}
