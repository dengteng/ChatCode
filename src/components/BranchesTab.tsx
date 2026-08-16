import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RotateCw, ChevronRight, ChevronDown, Cloud, X, FileDiff, Plus, ArrowUp } from "lucide-react";
import { createPortal } from "react-dom";
import { openUrl } from "../native";
import { html as diffToHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import type { Session, GitLogData, GitCommit, GitBranch } from "../types";
import { useStore } from "../store";
import { q, pushCmd, pushTargets } from "../lib/gitcmd";
import { ConfirmDialog } from "./ConfirmDialog";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";

// 统一 diff 渲染:把 git 的 unified patch 交给 diff2html,得到行内(word 级)高亮 + 行号的可视化视图。
// 空 patch = 无文本差异(如仅权限变化/二进制)。样式在 styles.css 的 .d2h-wrap 里对齐主题。
function DiffHtml({ patch }: { patch: string }) {
  const { t } = useTranslation();
  const out = useMemo(
    () => patch.trim() ? diffToHtml(patch, { drawFileList: false, matching: "words", outputFormat: "line-by-line" }) : "",
    [patch],
  );
  if (!out) return <div className="muted branches-empty">{t("（无文本差异）")}</div>;
  return <>
    <div className="d2h-legend">{t("左列=改前行号")} · {t("右列=改后行号")} · <span className="d2h-lg-ins">{t("diff.added")}</span> <span className="d2h-lg-del">{t("diff.deleted")}</span></div>
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
  const [menu, setMenu] = useState<{ ref: string; remote: boolean; x: number; y: number } | null>(null);
  // newbranch 的 ref = 来源分支(弹窗里可改),target = 建到本地还是远程;rename/upstream 的 ref = 被操作的分支
  const [prompt, setPrompt] = useState<{ kind: "rename" | "newbranch" | "upstream"; ref: string; val: string; target?: "local" | "remote" } | null>(null);
  const [compareFrom, setCompareFrom] = useState<string | null>(null); // 已选对比左端,等点第二个节点选右端
  const [compareView, setCompareView] = useState<{ from: string; to: string } | null>(null);
  const [wtFile, setWtFile] = useState<string | null>(null); // 工作区单文件 diff 弹窗:正在查看的文件
  const lastChanged = useRef<ReturnType<typeof parseStatus>>([]); // 暂存区折叠退场时还得渲染的最后一份文件列表
  const [pushing, setPushing] = useState(false); // 映射图上的 push 进行中:禁二次点击 + 菊花
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
  const commitFlow = useMinHold(commitBusy);
  const pushFlow = useMinHold(syncing === "push");
  const pullFlow = useMinHold(syncing === "pull");
  // 结果提示不在这儿做:store 的 terminal_result 统一按命令报「已提交/已推送/…失败」,
  // 三处入口一视同仁,失败也不会被谎报成成功。

  useEffect(() => { requestGitLog(session.id); }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setConfirm(null); setMenu(null); setPrompt(null); setCompareFrom(null); setCompareView(null); setWtFile(null); }, [session.id]);

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
  const repoWeb = webUrl(git.remoteUrl);          // 远程仓库网页地址(ssh/git → https)
  // 拓扑顶上那行 url 是哪个远端的(后端按当前分支上游选,这里同一套回退跟着算,只为显示个名字)。
  // 多远端时不标名字,光看 url 得逐字比域名和仓库名才知道换了仓库。
  const urlRemote = git.local.find((b) => b.name === current)?.upstream?.split("/")[0] || remoteName;
  // 点分支标签:对比拾取中 → 选它当对端;否则开菜单
  const onChip = (ref: string, remote: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (compareFrom) { if (ref !== compareFrom) doCompare(compareFrom, ref); else setCompareFrom(null); return; }
    setConfirm(null); setPrompt(null);
    setMenu({ ref, remote, x: e.clientX, y: e.clientY });
  };

  const submitPrompt = () => {
    if (!prompt) return;
    const v = prompt.val.trim();
    if (!v) return;
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
      {/* -d 只删"已合并"的分支,有未合并提交时 git 会拒绝(这是它在护着你)。
          所以再给一条 -D:仅当分支还有提交没进当前分支时才需要,单列一条并说清后果。 */}
      {!isCur && dItem(`del:${ref}`, t("删除分支"), `git branch -d ${q(ref)}`)}
      {!isCur && dItem(`delf:${ref}`, t("强制删除分支（含未合并提交）"), `git branch -D ${q(ref)}`)}
    </>;
  };

  return (
    <div className="info-scroll branches-tab" style={{ "--brz-link-w": `${MAP_LINK_W}px` } as React.CSSProperties}>
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
          <div className={`brz-collapse ${dirty ? "open" : ""}`}>
            <div className="brz-collapse-in">
              <div className={`sync-link ${commitFlow ? "flow-down" : ""}`}>
                <span className="sync-wire" />
                {/* 提交进行中:按钮撤掉换成等高的线段 —— 它这时既点不动又正好挡住流光,留着只剩噪音 */}
                {commitFlow ? <span className="sync-wire wire-gap" /> : <div className="sync-hub">
                  <button className="sync-act commit" title={t("提交改动")} onClick={onCommit}>
                    <span>commit <em>{t("{{count}} 处", { count: exiting.length })}</em></span>
                  </button>
                </div>}
                <span className="sync-wire" />
                <span className="sync-arrow" />
              </div>
            </div>
          </div>

          {/* ② 本地 ↔ 远程分支映射:一横行一对(左=本地、右=远程),连线水平表示上游映射。
              映射上的画实线相连;未映射的一侧是半截虚线(到中间截断),端头"+"号,点击直接新建对端分支。
              行序以本地为主:main→当前→有映射→无映射(组内按名排);没配对的远程分支按名排追加在最后 */}
          <section className="sync-zone">
            {compareFrom && <div className="branches-pick-hint">{t("选择要与")} <b>{compareFrom}</b> {t("对比的另一个分支节点…")} <button className="ghost" onClick={() => setCompareFrom(null)}><X size={12} /> {t("取消")}</button></div>}
            <BranchMap local={git.local} remote={git.remote} remoteSha={git.remoteSha} remoteName={remoteName} hasRemote={git.remotes.length > 0} multiRemote={git.remotes.length > 1}
              current={current} dirty={dirty} picking={compareFrom} onChip={onChip} onRun={run}
              pushing={pushing} pushFlow={pushFlow} pullFlow={pullFlow}
              onNew={(target) => { setConfirm(null); setMenu(null); setPrompt({ kind: "newbranch", target, ref: current || git.local[0]?.name || "HEAD", val: "" }); }}
              onPush={(cmd) => { if (pushing) return; setPushing(true); runTerminal(session.id, cmd); }} />
          </section>

          {/* ③ 提交拓扑:本地 + 远程提交历史(琥珀点=未推送) */}
          <section className="sync-zone">
            <div className="sync-zone-h">
              <span className="sec-label">{t("提交拓扑")}</span>
              <span style={{ flex: 1 }} />
              <button className="ghost" title={t("刷新")} onClick={() => requestGitLog(session.id)}><RotateCw size={13} /></button>
            </div>
            {git.remoteUrl && <button className="branches-subline" title={repoWeb ? t("在浏览器打开远程仓库") : git.remoteUrl} disabled={!repoWeb} onClick={() => repoWeb && openUrl(repoWeb)}>
              {multiRemote && <b className="branches-subline-remote">{urlRemote}</b>}{git.remoteUrl}</button>}
            {log?.commits.length
              ? <div className="branches-graph"><Graph log={log} current={current} dirty={dirty} picking={compareFrom} onChip={onChip} /></div>
              : <div className="muted branches-empty">{t("暂无提交记录")}</div>}
          </section>
          <div className="branches-hint muted">{t("点分支标签查看可做的操作 · 琥珀点=未推送")}</div>
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
              {prompt.kind === "rename" ? t("改名 {{ref}}", { ref: prompt.ref }) : prompt.kind === "newbranch" ? t("新建{{type}}分支", { type: prompt.target === "remote" ? t("远程") : t("本地") }) : t("设 {{ref}} 的上游", { ref: prompt.ref })}
            </div>
            {prompt.kind === "upstream"
              ? <select className="git-map-input" autoFocus value={prompt.val} onChange={(e) => setPrompt({ ...prompt, val: e.target.value })}>
                  <option value="">{t("选择远程分支")}</option>
                  {git.remote.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              : <input className="git-map-input" autoFocus value={prompt.val} placeholder={prompt.kind === "rename" ? t("新名字") : t("新分支名")}
                  onChange={(e) => setPrompt({ ...prompt, val: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Escape") setPrompt(null); if (e.key === "Enter" && !e.nativeEvent.isComposing) submitPrompt(); }} />}
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
              <button type="button" className="hi" disabled={!prompt.val.trim()} onClick={submitPrompt}>{t("确定")}</button>
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
                : <DiffHtml patch={fileDiff!.patch} />}
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}

// 本地 ↔ 远程分支映射图:一横行一对(左=本地、右=远程),同行等高,连线永远水平。
//   - 行序以本地为主:main → 当前分支 → 有映射的本地 → 无映射的本地(组内按名排);没配对的远程分支按名排追加在最后。
//   - 有映射:行中间画水平实线;当前分支的连线 accent 加粗。
//   - 未映射:缺的那一端照样占一格,画成虚线框的「新建」标签,连线也走虚线、箭头指向它;
//     点标签直接建出对端(缺远程→推送并跟踪 / 缺本地→检出并跟踪)。
//   - 两列标题右侧各有一个"+":开弹窗新建本地 / 远程分支,可选来源 ref。
// tag 全列等宽、随抽屉宽度自适应,超长按当前宽度省略号截断。
// 连线带尺寸:主干够宽才塞得下 46px 的 push 药丸,分叉段够宽才塞得下单推的 ↑ 和箭头
// (两侧 tag 是 flex:1,连线带越宽 tag 越短)
const MAP_LINK_W = 84, FORK_X = 52, linkW = MAP_LINK_W;
// 右格 chip 的高和间距(和 .brz-tag 的 min-height / .brz-cell.multi 的 gap 一致)。
// ponytail: 写死不测量 —— chip 是 nowrap+省略号,永远单行 26px,一个 ResizeObserver 换不来任何东西。
const CHIP_H = 26, CHIP_GAP = 4, PITCH = CHIP_H + CHIP_GAP;
const MAP_LINK_H = CHIP_H;
const TAIL = 26; // 传输光点的尾迹长度(px,svg 用户坐标)
function BranchMap({ local, remote, remoteSha, remoteName, hasRemote, multiRemote, current, dirty, picking, onChip, onRun, pushing, pushFlow, pullFlow, onPush, onNew }:
  { local: GitBranch[]; remote: string[]; remoteSha?: Record<string, string>; remoteName: string; hasRemote: boolean; multiRemote: boolean; current: string; dirty: boolean;
    picking: string | null; onChip: (ref: string, remote: boolean, e: React.MouseEvent) => void; onRun: (cmd: string) => void;
    pushing: boolean; pushFlow: boolean; pullFlow: boolean; onPush: (cmd: string) => void; onNew: (target: "local" | "remote") => void }) {
  const { t } = useTranslation();
  const CY = MAP_LINK_H / 2;
  const remoteSet = new Set(remote);
  const shortOf = (r: string) => r.split("/").slice(1).join("/");
  // 上游绑定是独占的:被谁认领过的远程分支不再被同名规则抢去别的行。
  // (反过来两条本地分支共用一个 upstream 是合法的,那它就该在两行都出现 —— 这是事实,不是重复。)
  const upstreams = new Set(local.map((b) => b.upstream).filter((u) => u && remoteSet.has(u)));
  // 一个本地分支对应的远程 = 它的 upstream + 所有同名、且没被别人认领的远程分支。
  // git 只存得下一个 upstream,但「oss 同时推 origin/main 和 private/oss」是常态;
  // 只画 upstream 那一条,等于在界面上宣称另一个远端不存在 —— 用户照着这张图判断推没推,就会漏推。
  const rsOf = (b: GitBranch) => [
    ...(b.upstream && remoteSet.has(b.upstream) ? [b.upstream] : []),   // upstream 排头:push 默认去它那
    ...remote.filter((r) => !upstreams.has(r) && shortOf(r) === b.name),
  ];
  const localRank = (b: GitBranch) =>
    b.name === "main" ? 0 : b.name === current ? 1 : (rsOf(b).length ? 2 : 3);
  const localSorted = [...local].sort((a, b) => localRank(a) - localRank(b) || a.name.localeCompare(b.name));
  // 一本地一行,带上它映射的全部远程(上游已删 [gone] 的不算);没配对的远程分支按名排追加在最后
  const rows: { l?: GitBranch; rs: string[] }[] = localSorted.map((b) => ({ l: b, rs: rsOf(b) }));
  const paired = new Set(rows.flatMap((x) => x.rs));
  for (const r of [...remote].sort((a, b) => a.localeCompare(b))) if (!paired.has(r)) rows.push({ rs: [r] });

  const tagTitle = (b: GitBranch) =>
    `${b.name}${b.name === current ? t("（当前）") : ""}${b.gone ? t(" · 上游 {{up}} 已在远程删除", { up: b.upstream }) : b.upstream ? `${t(" · 上游 {{up}}", { up: b.upstream })}${b.upstreamAuthor ? t("（{{author}}）", { author: b.upstreamAuthor }) : ""}${b.ahead ? ` ↑${b.ahead}` : ""}${b.behind ? ` ↓${b.behind}` : ""}` : t(" · 未跟踪")}${t(" · 点击查看操作")}`;

  const tagCls = (name: string, remote: boolean) =>
    `brz-tag ${remote ? "remote" : `local ${name === current ? "cur" : ""}`} ${picking && picking !== name ? "pick-target" : ""} ${picking === name ? "pick-self" : ""}`;

  // 半截 stub 连线:对端还不存在时用(配虚线「新建」标签),箭头指向要被创建的那一端。
  const wire = (dir: "right" | "left", cur: boolean, dashed: boolean) => {
    const cls = (base: string) => `${base}${cur ? " cur" : ""}${dashed ? " dash" : ""}`;
    const [x1, x2, dotX, tipX, tailX] = dir === "right"
      ? [0, linkW - 7, 1, linkW, linkW - 8] : [linkW, 7, linkW - 1, 0, 8];
    return (
      <svg className="brz-map-svg" width={linkW} height={MAP_LINK_H}>
        <line x1={x1} y1={CY} x2={x2} y2={CY} className={cls("brz-map-line")} />
        <circle cx={dotX} cy={CY} r={2.5} className={cls("brz-map-dot")} />
        <path d={`M ${tailX} ${CY - 4} L ${tipX} ${CY} L ${tailX} ${CY + 4} Z`} className={cls("brz-map-head")} />
      </svg>
    );
  };

  // 一对多映射的连线:本地端引一条主干到 FORK_X,再分叉到每个远程 chip 的中线,一个远端一条线。
  // 一条线画完所有远端(把 rs 挤在一格里)读不出"分别推到哪几个";分叉画出来,每条线上就能各挂一个
  // 单推按钮,主干上挂一次推全部 —— 图形和可做的操作是同一套结构。
  // beam(传输中的流光)只跑主干:那是所有目标共用的一段,推一个还是推全部都成立。
  // 光束必须和线画在同一个 svg 里 —— 之前是另起一个 absolute svg 盖上去,半像素定位差就永远对不齐。
  const fan = (ys: number[], dashed: boolean[], cur: boolean, beam?: "out" | "in") => {
    const h = ys[ys.length - 1] + CHIP_H / 2, cy = h / 2;  // 行是 align-items:center,本地那一格的中线就是 h/2
    const endX = linkW - 7, R = 6;
    const cls = (base: string, d: boolean) => `${base}${cur ? " cur" : ""}${d ? " dash" : ""}`;
    const allDash = dashed.every(Boolean);
    return (
      <svg className="brz-map-svg" width={linkW} height={h}>
        <line x1={0} y1={cy} x2={FORK_X} y2={cy} className={cls("brz-map-line", allDash)} />
        <circle cx={1} cy={cy} r={2.5} className={cls("brz-map-dot", allDash)} />
        {ys.map((y, i) => (
          <g key={i}>
            {/* 拐角走 6px 圆角:直角在 1.5px 线宽上会顶出一个小方块,圆角才读得出是"从主干分出去的" */}
            <path fill="none" className={cls("brz-map-line", dashed[i])} d={Math.abs(y - cy) < 1
              ? `M ${FORK_X} ${cy} H ${endX}`
              : `M ${FORK_X} ${cy} V ${y - Math.sign(y - cy) * R} Q ${FORK_X} ${y} ${FORK_X + R} ${y} H ${endX}`} />
            <path d={`M ${linkW - 8} ${y - 4} L ${linkW} ${y} L ${linkW - 8} ${y + 4} Z`} className={cls("brz-map-head", dashed[i])} />
          </g>
        ))}
        {beam && <>
          <defs>
            {/* userSpaceOnUse:水平线的 bbox 高为 0,objectBoundingBox 渐变在这种退化 bbox 上不可靠 */}
            <linearGradient id="brz-beam-grad" gradientUnits="userSpaceOnUse" x1={-TAIL} y1={0} x2={0} y2={0}>
              <stop offset="0%" className="brz-beam-s0" />
              <stop offset="100%" className="brz-beam-s1" />
            </linearGradient>
            <clipPath id="brz-beam-clip"><rect x={0} y={0} width={FORK_X} height={h} /></clipPath>
          </defs>
          {/* in(pull)= 把整组镜像翻过去:光点从右往左,尾迹跟着甩到右边,不用第二套动画 */}
          <g clipPath="url(#brz-beam-clip)" transform={beam === "in" ? `translate(${FORK_X} 0) scale(-1 1)` : undefined}>
            <g className="brz-beam" style={{ "--beam-run": `${FORK_X}px` } as React.CSSProperties}>
              <line x1={-TAIL} y1={cy} x2={0} y2={cy} className="brz-beam-tail" />
              <circle cx={0} cy={cy} r={2.4} className="brz-beam-dot" />
            </g>
          </g>
        </>}
      </svg>
    );
  };
  // 缺失的一端画成虚线「新建」标签:点它就建出来。左=从远程检出本地,右=把本地推成远程分支。
  const newTag = (side: "local" | "remote", title: string, onClick: () => void) => (
    <button className={`brz-tag brz-tag-new ${side}`} title={title} onClick={onClick}>
      {side === "remote" && <Cloud size={9} className="brz-tag-ico" />}
      <span className="brz-tag-name">{t("新建")}</span>
    </button>
  );
  // 远程行缺本地端:同名本地分支已存在(只是没设上游)→ 设上游;否则检出并跟踪
  const newLocalCmd = (r: string) => {
    const short = r.split("/").slice(1).join("/");
    return local.some((b) => b.name === short)
      ? `git branch --set-upstream-to=${q(r)} ${q(short)}` : `git switch -c ${q(short)} --track ${q(r)}`;
  };

  return (
    <div className="brz-map">
      <div className="brz-row brz-head">
        <div className="brz-cell brz-col-label sec-label">{t("本地分支")}
          <button className="ghost brz-add" title={t("新建本地分支")} onClick={() => onNew("local")}><Plus size={12} /></button>
        </div>
        <div className="brz-link" style={{ width: linkW }} />
        <div className="brz-cell brz-col-label sec-label">{t("远程分支")}
          <button className="ghost brz-add" title={t("新建远程分支")} disabled={!hasRemote} onClick={() => onNew("remote")}><Plus size={12} /></button>
        </div>
      </div>
      {!local.length && <span className="muted brz-empty">{t("暂无本地分支")}</span>}
      {!remote.length && <span className="muted brz-empty">{t("暂无远程分支")}</span>}
      {rows.map(({ l: b, rs }) => {
        const isCur = b?.name === current;
        const r = rs[0];
        // 只有 upstream 那条才是 git 认的映射:裸 `git push` 只去它那儿。同名匹配来的(private/oss)
        // 画成虚线 —— 画实线等于替 git 承诺了一件它不会做的事,用户就会以为一次 push 两边都到了。
        const up = b?.upstream && rs.includes(b.upstream) ? b.upstream : undefined;
        const ys = rs.map((_, i) => CHIP_H / 2 + i * PITCH);   // 每个远程 chip 的中线 y(svg 坐标)
        // push 按钮只给当前分支这一行,且只给"确实还有东西可推"的远端(判定见 pushTargets)。
        const pushable = isCur && b ? pushTargets(b, rs, up, remoteSha) : [];
        const showPush = pushable.length > 0 && !pushFlow && !pushing;
        return (
          <div className="brz-row" key={b?.name ?? r}>
            <div className="brz-cell">{b ? (
              <button data-ref={b.name} title={tagTitle(b)} className={`${tagCls(b.name, false)} ${b.gone ? "gone" : ""}`} onMouseDown={(e) => onChip(b.name, false, e)}>
                <span className="brz-tag-name">{b.name}</span>
                {isCur && dirty && <span className="cg-ref-dirty" title={t("有未提交改动")}>*</span>}
              </button>
            ) : r ? newTag("local", t("从 {{r}} 新建本地分支", { r }), () => onRun(newLocalCmd(r))) : null}</div>
            <div className="brz-link" style={{ width: linkW }}>
              {/* push/pull 进行中:当前分支这行的连线自己长出光点(push 左→右,pull 右→左);
                  平时不放,免得静态界面一直在动 */}
              {b && rs.length > 0 && fan(ys, rs.map((rr) => rr !== up), isCur,
                isCur ? (pushFlow ? "out" : pullFlow ? "in" : undefined) : undefined)}
              {b && !rs.length && hasRemote && wire("right", false, true)}
              {!b && r && wire("left", false, true)}
              {/* 主干上的 push 药丸:一次推到这一行映射的全部远端(单远端时就是推那一个)。
                  推送进行中撤掉它,连线只留左→右的流光 —— 按钮压在线上会把光束截断。 */}
              {b && showPush && (
                <button className="brz-push" style={{ left: FORK_X / 2 }}
                  title={pushable.length > 1
                    ? t("一次推到全部 {{n}} 个远端:{{list}}", { n: pushable.length, list: pushable.join("、") })
                    : t("推送到 {{r}}:{{cmd}}", { r: pushable[0], cmd: pushCmd(b.name, pushable[0]) })}
                  onClick={(e) => { e.stopPropagation(); onPush(pushable.map((rr) => pushCmd(b.name, rr)).join(" && ")); }}>
                  <span>push</span>
                </button>
              )}
              {/* 分叉线上各挂一个 ↑:只推这一条。主干那颗是"全推",两个都在,才既能单推又能同时推。
                  只有一个目标时不放 —— 和主干药丸重复。 */}
              {b && showPush && pushable.length > 1 && rs.map((rr, i) => pushable.includes(rr) && (
                <button key={rr} className="brz-push-one" style={{ left: (FORK_X + linkW - 7) / 2, top: ys[i] }}
                  title={t("只推到 {{r}}:{{cmd}}", { r: rr, cmd: pushCmd(b.name, rr) })}
                  onClick={(e) => { e.stopPropagation(); onPush(pushCmd(b.name, rr)); }}>
                  <ArrowUp size={11} />
                </button>
              ))}
            </div>
            {/* 一个本地分支挂多个远端时,右格竖着排 —— 行高跟着长,连线正对这一组的中线 */}
            <div className={`brz-cell ${rs.length > 1 ? "multi" : ""}`}>{rs.length ? rs.map((rr) => (
              <button key={rr} data-ref={rr} className={`${tagCls(rr, true)} ${rr === up ? "" : "loose"}`} onMouseDown={(e) => onChip(rr, true, e)}
                title={rr === up ? t("{{r}} · 点击查看操作", { r: rr }) : t("{{r}} · 同名远程分支,不是上游:裸 git push 不会推到这里,用连线上的按钮推", { r: rr })}>
                <Cloud size={9} className="brz-tag-ico" />
                {/* 多远端时必须标出前缀:origin/main 和 private/main 光看 main 完全分不清是哪个仓库。
                    前缀 flex:none,挤压时先截主名,别把"是谁家的"这个信息截掉。单远端时前缀是纯噪音,不显示。 */}
                {multiRemote && <span className="brz-tag-remote">{rr.split("/")[0]}/</span>}
                <span className="brz-tag-name">{rr.split("/").slice(1).join("/")}</span>
              </button>
            )) : b && hasRemote ? newTag("remote", t("把 {{name}} 推成远程分支", { name: b.name }), () => onRun(`git push -u ${q(remoteName)} ${q(b.name)}`)) : null}</div>
          </div>
        );
      })}
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

function Graph({ log, current, dirty, picking, onChip }: { log: GitLogData; current: string; dirty: boolean; picking: string | null; onChip: (ref: string, remote: boolean, e: React.MouseEvent) => void }) {
  const { t } = useTranslation();
  const { rows, edges, laneCount } = useMemo(() => buildGraph(log.commits), [log.commits]);
  const headsBySha = useMemo(() => {
    const m = new Map<string, { name: string; remote: boolean }[]>();
    for (const h of log.heads) { const a = m.get(h.sha) || []; a.push({ name: h.name, remote: h.remote }); m.set(h.sha, a); }
    return m;
  }, [log.heads]);
  // 未推送 = 从任一远程 ref 沿父链走不到的提交(只在本地)。没有远程 ref 时不标(否则全标,没意义)。
  const unpushed = useMemo(() => {
    const remoteShas = log.heads.filter((h) => h.remote).map((h) => h.sha);
    if (!remoteShas.length) return new Set<string>();
    const byHash = new Map(log.commits.map((c) => [c.hash, c]));
    const onRemote = new Set<string>();
    const stack = [...remoteShas];
    while (stack.length) {
      const h = stack.pop()!;
      if (onRemote.has(h)) continue;
      onRemote.add(h);
      for (const p of byHash.get(h)?.parents || []) if (!onRemote.has(p)) stack.push(p);
    }
    return new Set(log.commits.filter((c) => !onRemote.has(c.hash)).map((c) => c.hash));
  }, [log.commits, log.heads]);
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
function DiffView({ current, other, diff, fileDiff, onBack, onRefresh, onFile }: { current: string; other: string; diff?: { from: string; to: string; ahead: number; behind: number; files: { file: string; add: number | null; del: number | null }[]; error?: string }; fileDiff?: { from: string; to: string; file: string; patch: string; error?: string }; onBack: () => void; onRefresh: () => void; onFile: (file: string) => void }) {
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
                  {isOpen && <div className="branches-file-patch">{ready ? (fileDiff.error ? <span className="branches-diff-err">{t("无法读取:{{error}}", { error: fileDiff.error })}</span> : <DiffHtml patch={fileDiff.patch} />) : <span className="muted">{t("加载中…")}</span>}</div>}
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
