import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, ChevronDown, ChevronRight, ChevronUp, LoaderCircle, FileText, FileJson, FileCode, FileCode2, File, Folder, FolderOpen, Square, Play, Search } from "lucide-react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealPath } from "../native";
import type { Session, TimelineItem } from "../types";
import { useStore, useApi, type RememberChoice } from "../store";
import { PermissionCard, SkillMcpTags } from "./Chat";
import { usedSkillsMcp } from "../lib/timeline";
import { CommitDialog } from "./CommitDialog";
import { BranchesTab } from "./BranchesTab";
import { MemoryTab } from "./MemoryTab";
import { BtwTab } from "./BtwTab";
import { isEditable } from "./FileEditor";
import { openEditorWindow } from "../popout";
import { onEdgeGlow } from "../lib/edgeGlow";
import { ConfirmDialog } from "./ConfirmDialog";
import { useTranslation } from "react-i18next";

type Tab = "project" | "branches" | "files" | "memory" | "btw";

// 从会话时间线里挑出两类端口,用于把"脱离工作目录、cwd 过滤抓不到"的进程(如 ssh -L 隧道)找回来:
//  - startedPorts:本会话亲手起的 —— agent 跑的命令里 `ssh -L <本地口>:host:port` 的本地转发口(最可靠)
//  - mentionedPorts:仅在正文/输出里出现过的端口(localhost:PORT、http://…:PORT、port PORT),弱关联
// 两者互斥:启动的从"提及"里剔掉。之后交给后端 probe_ports 反查哪些真的在 LISTEN。
function extractSessionPorts(timeline: TimelineItem[]): { startedPorts: Set<number>; mentionedPorts: Set<number> } {
  const started = new Set<number>();
  const mentioned = new Set<number>();
  const ok = (n: number) => n >= 1 && n <= 65535;
  const addMentioned = (text: string) => {
    for (const m of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|端口|\bport)\s*[:：]?\s*(\d{2,5})/gi)) { if (ok(+m[1])) mentioned.add(+m[1]); }
    for (const m of text.matchAll(/https?:\/\/[^\s/]+?:(\d{2,5})/gi)) { if (ok(+m[1])) mentioned.add(+m[1]); }
  };
  const addStarted = (cmd: string) => {
    // -L [bind:]LPORT:host:hport —— LPORT = 第一个纯数字段
    for (const m of cmd.matchAll(/-L\s*(\S+)/g)) {
      const parts = m[1].split(":");
      const lp = /^\d+$/.test(parts[0]) ? parts[0] : parts[1];
      if (lp && ok(+lp)) started.add(+lp);
    }
    addMentioned(cmd);
  };
  for (const it of timeline) {
    if (it.kind === "terminal") { addStarted(it.command); addMentioned(it.output || ""); }
    else if (it.kind === "tool" && it.name === "Bash" && it.input?.command) addStarted(String(it.input.command));
    else if (it.kind === "agent_text") addMentioned(it.text);
    else if (it.kind === "user") for (const b of it.blocks) if (b.type === "text") addMentioned(b.text);
  }
  for (const p of started) mentioned.delete(p); // 互斥:亲手起的不再算"仅提及"
  return { startedPorts: started, mentionedPorts: mentioned };
}

export function InfoPanel({ session, initialTab, memoryTarget, onClose }: { session: Session; initialTab: Tab; memoryTarget?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { state, requestGitInfo, runTerminal, stopTask } = useStore();
  const [tab, setTab] = useState<Tab>(initialTab);
  const git = state.git[session.id];
  useEffect(() => { setTab(initialTab); }, [initialTab, session.id]);
  useEffect(() => { requestGitInfo(session.id); }, [session.id, session.termCwd]);

  const gitAction = (command: string) => { runTerminal(session.id, command); }; // 输出在消息列表的终端条目里看
  // 会话相关端口(cwd 过滤抓不到的:ssh -L 隧道等):从时间线抽启动口/提及口,再交后端反查是否在 LISTEN
  const { startedPorts, mentionedPorts } = useMemo(() => extractSessionPorts(session.timeline), [session.timeline]);
  const [probed, setProbed] = useState<{ port: number; pid: string; process: string }[]>([]);
  const [tick, setTick] = useState(0);
  // 结束/启动进程后延迟重扫运行时(kill/spawn 到生效有滞后,立刻扫还是旧状态)
  const refreshRuntime = () => window.setTimeout(() => { requestGitInfo(session.id); setTick((t) => t + 1); }, 500);
  useEffect(() => {
    const ports = [...new Set([...startedPorts, ...mentionedPorts])];
    if (tab !== "project" || ports.length === 0) { setProbed([]); return; }
    invoke<[number, string, string][]>("probe_ports", { ports })
      .then((rows) => setProbed(rows.map(([port, pid, process]) => ({ port, pid, process }))))
      .catch(() => setProbed([]));
  }, [tab, startedPorts, mentionedPorts, session.id, tick]);
  // 排掉已在"监听端口(工作目录)"里显示过的,避免重复;剩下的按来源标注
  const runtimePortNums = new Set((git?.runtime?.ports ?? []).map((p) => Number(p.port)));
  const extraPorts = probed.filter((p) => !runtimePortNums.has(p.port));

  // 一键停止全部:批量杀是破坏性操作,弹窗二次确认
  const [confirmKill, setConfirmKill] = useState<"proc" | "port" | null>(null);
  const procs = git?.runtime?.processes ?? [];
  const allPorts = [...new Set([...(git?.runtime?.ports ?? []).map((p) => Number(p.port)), ...extraPorts.map((p) => p.port)])];
  // agent 起的后台任务没有 pid,得让 SDK 自己收(kill "task:xxx" 只会失败)
  const stopProc = (p: { pid: string; task?: string }) =>
    p.task ? Promise.resolve(stopTask(session.id, p.task)) : invoke("kill_pid", { pid: p.pid });
  const stopAllProcs = () => { Promise.allSettled(procs.map(stopProc)).finally(refreshRuntime); setConfirmKill(null); };
  const stopAllPorts = () => { Promise.allSettled(allPorts.map((port) => invoke("kill_port", { port: String(port) }))).finally(refreshRuntime); setConfirmKill(null); };
  const [showCommit, setShowCommit] = useState(false);
  const commit = () => setShowCommit(true);
  const [committing, setCommitting] = useState(false); // 提交进行中:分支页 commit 按钮转菊花
  useEffect(() => { setCommitting(false); }, [git]); // git 信息刷新 = 命令跑完

  return <>
    {/* 抽屉式:盖在聊天上,不再挤压 timeline(挤压会让消息列表重排、滚动位置乱跳、宽表格出横向滚动条) */}
    {/* 遮罩用 onMouseDown 而非 onClick:抽屉内输入框/面板持有焦点时,落在遮罩上的第一次点击
        只用来切焦点、不派发 click —— 表现就是"要点两次才关得掉"(面板 tab、菜单项同此处理) */}
    <div className="info-drawer-backdrop" onMouseDown={onClose} />
    <aside className="info-panel edge-glow" onMouseMove={onEdgeGlow}>
    <div className="info-head info-tabhead">
      <button className="ghost info-close" onClick={onClose} aria-label={t("关闭详情面板")}><X size={16} /></button>
      <div className="info-tabs" role="tablist">
        {/* onMouseDown 而非 onClick:首次点击常先 blur 聚焦的输入框、触发重排,click(mouseup)落在移动后的位置丢失 → 要点两次(Settings 的 tab 同此处理) */}
        <button className={tab === "branches" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("branches"); }}>{t("分支")}</button>
        <button className={tab === "files" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("files"); }}>{t("文件")}</button>
        {!session.casual && <button className={tab === "memory" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("memory"); }}>{t("记忆")}</button>}
        <button className={tab === "project" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("project"); }}>{t("活动")}</button>
        <button className={`tab-btw${tab === "btw" ? " selected" : ""}`} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("btw"); }}>{t("btw顺便问问")}</button>
      </div>
    </div>
    {tab === "btw" && <BtwTab sessionId={session.id} />}
    {tab === "project" && <div className="info-scroll">
      {/* 工作目录一栏去掉:聊天页顶栏常驻显示同一个路径,抽屉里再列一遍是重复。首页面板那份留着 —— 那里没有顶栏。 */}
      <InfoSection title={t("会话进程（{{num}}）", { num: procs.length })}
        action={procs.length > 0 && <button className="proc-stop stop-all" title={t("停止列出的全部进程")} onClick={() => setConfirmKill("proc")}><Square size={11} /> {t("停止全部")}</button>}>
        {procs.length ? procs.map((process) => <div className="process-row" key={process.pid}><span title={process.name}>{process.name}</span><span className="muted">{process.elapsed}</span><button className="proc-stop" title={process.task ? t("停止该后台任务") : t("结束进程")} onClick={() => Promise.resolve(stopProc(process)).catch(() => {}).finally(() => refreshRuntime())}><Square size={11} /> {t("停止")}</button></div>) : <div className="muted">{t("未检测到属于此工作目录的活动进程")}</div>}
        <StartProc cwd={session.termCwd || session.cwd} onDone={refreshRuntime} />
      </InfoSection>
      <InfoSection title={t("监听端口")}
        action={allPorts.length > 0 && <button className="proc-stop stop-all" title={t("停止占用列出端口的全部进程")} onClick={() => setConfirmKill("port")}><Square size={11} /> {t("停止全部")}</button>}>
        {git?.runtime?.ports.map((port) => <div className="process-row port-row" key={`${port.process}-${port.port}`}><span title={t("用浏览器打开 http://localhost:{{port}}", { port: port.port })} onClick={() => openUrl(`http://localhost:${port.port}`)}>{port.process}</span><code onClick={() => openUrl(`http://localhost:${port.port}`)}>:{port.port}</code><button className="proc-stop" title={t("结束占用该端口的进程")} onClick={() => invoke("kill_port", { port: String(port.port) }).catch(() => {}).finally(() => refreshRuntime())}><Square size={11} /> {t("停止")}</button></div>)}
        {/* cwd 抓不到、但按端口反查到的:标出来源(本会话启动 / 仅正文提及) */}
        {extraPorts.map((p) => {
          const started = startedPorts.has(p.port);
          return <div className="process-row port-row" key={`x-${p.port}`}>
            <span title={t("用浏览器打开 http://localhost:{{port}}", { port: p.port })} onClick={() => openUrl(`http://localhost:${p.port}`)}>{p.process}</span>
            <code onClick={() => openUrl(`http://localhost:${p.port}`)}>:{p.port}</code>
            <span className={`port-src ${started ? "started" : "mentioned"}`} title={started ? t("本会话运行的命令(如 ssh -L)开启的端口") : t("仅在对话正文/输出里出现过的端口,未必由本会话启动")}>{started ? t("本会话启动") : t("正文提及")}</span>
            <button className="proc-stop" title={t("结束占用该端口的进程")} onClick={() => invoke("kill_port", { port: String(p.port) }).catch(() => {}).finally(() => refreshRuntime())}><Square size={11} /> {t("停止")}</button>
          </div>;
        })}
        {!git?.runtime?.ports.length && extraPorts.length === 0 && <div className="muted">{t("暂无本会话监听端口")}</div>}
      </InfoSection>
      {confirmKill === "proc" && <ConfirmDialog title={t("停止全部 {{num}} 个进程?", { num: procs.length })}
        body={<>{t("会逐一结束「会话进程」里列出的全部进程,不可撤销。")}</>}
        confirmLabel={t("停止 {{num}} 个", { num: procs.length })} onConfirm={stopAllProcs} onCancel={() => setConfirmKill(null)} />}
      {confirmKill === "port" && <ConfirmDialog title={t("停止全部 {{num}} 个端口?", { num: allPorts.length })}
        body={<>{t("会逐一结束占用「监听端口」里列出端口的进程,不可撤销。")}</>}
        confirmLabel={t("停止 {{num}} 个", { num: allPorts.length })} onConfirm={stopAllPorts} onCancel={() => setConfirmKill(null)} />}
    </div>}
    {tab === "branches" && <BranchesTab session={session} onCommit={commit} committing={committing} />}
    {tab === "branches" && showCommit && <CommitDialog scope={session.cwd} sessionId={session.id} onSubmit={(message) => { gitAction(`git add -A && git commit -m ${quote(message)}`); setCommitting(true); setShowCommit(false); }} onCancel={() => setShowCommit(false)} />}
    {tab === "files" && <FilesTab root={session.termCwd || session.cwd} />}
    {tab === "memory" && <MemoryTab cwd={session.cwd} highlight={memoryTarget} />}
    </aside>
  </>;
}

// 首页(无会话)项目详情:选好目录、还没建会话时先看分支/目录/文件/记忆。
// 分支页整套逻辑都按会话 id 取数(state.git[id]、runTerminal(id, …)),这里没有会话,
// 就拿 "home:<绝对路径>" 当 id —— sidecar 的 resolveCwd 认这个前缀,直接把路径当工作目录,
// 前端 store 一行不用改。进程/端口仍要活会话,留在聊天页。
export function HomeInfoPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { state, requestGitInfo, runTerminal } = useStore();
  const [tab, setTab] = useState<Tab>("branches");
  const [copied, setCopied] = useState(false);
  const [showCommit, setShowCommit] = useState(false);
  const [committing, setCommitting] = useState(false);
  // BranchesTab / CommitDialog 只用到 id 和 cwd,其余字段补空壳即可
  const fake = useMemo(() => ({ id: `home:${cwd}`, cwd, termCwd: cwd, timeline: [] } as unknown as Session), [cwd]);
  useEffect(() => { requestGitInfo(fake.id); }, [fake.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCommitting(false); }, [state.git[fake.id]]); // git 信息刷新 = 提交跑完
  const copyPath = async () => { try { await navigator.clipboard.writeText(cwd); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* 剪贴板不可用 */ } };
  return <>
    <div className="info-drawer-backdrop" onMouseDown={onClose} />
    <aside className="info-panel edge-glow" onMouseMove={onEdgeGlow}>
      <div className="info-head info-tabhead">
        <button className="ghost info-close" onClick={onClose} aria-label={t("关闭详情面板")}><X size={16} /></button>
        <div className="info-tabs" role="tablist">
          <button className={tab === "branches" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("branches"); }}>{t("分支")}</button>
          <button className={tab === "files" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("files"); }}>{t("文件")}</button>
          <button className={tab === "memory" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("memory"); }}>{t("记忆")}</button>
          <button className={tab === "project" ? "selected" : ""} onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setTab("project"); }}>{t("活动")}</button>
        </div>
      </div>
      {tab === "project" && <div className="info-scroll">
        <InfoSection title={t("工作目录")}><code className="path-value">{cwd}</code><div className="info-actions"><button onClick={copyPath}>{copied ? t("已复制") : t("复制路径")}</button><button onClick={() => openPath(cwd)}>{t("在 Finder 中打开")}</button></div></InfoSection>
        <InfoSection title={t("运行时信息")}><div className="muted">{t("建会话后可在聊天页查看进程、监听端口等信息。")}</div></InfoSection>
      </div>}
      {tab === "branches" && <BranchesTab session={fake} onCommit={() => setShowCommit(true)} committing={committing} />}
      {tab === "branches" && showCommit && <CommitDialog scope={cwd} sessionId={fake.id} onSubmit={(message) => { runTerminal(fake.id, `git add -A && git commit -m ${quote(message)}`); setCommitting(true); setShowCommit(false); }} onCancel={() => setShowCommit(false)} />}
      {tab === "files" && <FilesTab root={cwd} />}
      {tab === "memory" && <MemoryTab cwd={cwd} />}
    </aside>
  </>;
}

// 文件页:真实目录树 + 顶部搜索框(整棵树按名字过滤);点击可编辑文件另开一个独立窗口编辑,其余交系统默认程序
export function FilesTab({ root }: { root: string }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<[string, boolean][] | null>(null); // walk_project 全量缓存(和 @ 提及同源)
  const [walking, setWalking] = useState(false);
  const q = query.trim().toLowerCase();

  // 首次搜索时才走一遍全量递归(walk_project 已跳过 node_modules/.git/dist 等噪音),之后纯在内存里过滤
  useEffect(() => {
    if (q && all === null && !walking) {
      setWalking(true);
      invoke<[string, boolean][]>("walk_project", { root }).then(setAll).catch(() => setAll([])).finally(() => setWalking(false));
    }
  }, [q, all, walking, root]);
  useEffect(() => { setAll(null); setQuery(""); }, [root]); // 换项目清缓存

  // 匹配相对路径(含目录段),排序:文件名以关键词开头的优先,其次路径越短越靠前;封顶 300 条
  const results = q && all
    ? all.filter(([rel]) => rel.toLowerCase().includes(q))
        .sort((a, b) => {
          const an = a[0].split("/").pop()!.toLowerCase(), bn = b[0].split("/").pop()!.toLowerCase();
          return (an.startsWith(q) ? 0 : 1) - (bn.startsWith(q) ? 0 : 1) || a[0].length - b[0].length;
        }).slice(0, 300)
    : [];

  const open = (path: string, name: string) => {
    if (isEditable(name)) openEditorWindow(path, name);
    else openPath(path);
  };
  // 右键:拦掉 webview 默认菜单(autofill/reload),弹自定义菜单
  const onCtx = (e: React.MouseEvent, path: string, isDir: boolean) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, path, isDir }); };
  // "打开目录":文件夹 → 在文件管理器打开它自己;文件 → 打开其所在目录并选中该文件
  const openDir = () => { if (!menu) return; if (menu.isDir) openPath(menu.path); else revealPath(menu.path, root); setMenu(null); };
  // 点别处 / 右键别处 关掉菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close); window.addEventListener("contextmenu", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("contextmenu", close); };
  }, [menu]);
  return (
    <div className="info-scroll file-tree">
      <div className="file-search">
        <Search size={13} className="file-search-ico" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("搜索文件 / 文件夹…")} spellCheck={false} />
        {query && <button className="file-search-clear" title={t("清空")} onClick={() => setQuery("")}><X size={13} /></button>}
      </div>
      {q ? (
        <div className="file-results">
          {walking && all === null ? <div className="muted tree-note">{t("正在建立索引…")}</div>
            : results.length === 0 ? <div className="muted tree-note">{t("没有匹配「{{query}}」的文件或文件夹", { query: query.trim() })}</div>
            : results.map(([rel, isDir]) => {
                const abs = `${root.replace(/\/$/, "")}/${rel}`;
                const name = rel.split("/").pop()!;
                const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
                return (
                  <div key={rel} className="tree-row file file-result" title={rel}
                    onClick={() => (isDir ? openPath(abs) : open(abs, name))}
                    onContextMenu={(e) => onCtx(e, abs, isDir)}>
                    <span className="tree-ico">{isDir ? <Folder size={14} /> : fileIco(name)}</span>
                    <span className="file-result-name">{name}</span>
                    {dir && <span className="file-result-dir muted">{dir}</span>}
                  </div>
                );
              })}
        </div>
      ) : (
        <div className="tree"><TreeNode path={root} name={root.split("/").filter(Boolean).pop() || root} isDir depth={0} defaultOpen onOpen={open} onCtx={onCtx} /></div>
      )}
      {menu && createPortal(
        <div className="tree-ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button onMouseDown={(e) => { e.preventDefault(); openDir(); }}><FolderOpen size={13} /> {t("打开目录")}</button>
        </div>, document.body)}
    </div>
  );
}

function TreeNode({ path, name, isDir, depth, defaultOpen, onOpen, onCtx }: { path: string; name: string; isDir: boolean; depth: number; defaultOpen?: boolean; onOpen: (path: string, name: string) => void; onCtx: (e: React.MouseEvent, path: string, isDir: boolean) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!!defaultOpen);
  const [kids, setKids] = useState<[string, boolean][] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (isDir && open && kids === null) invoke<[string, boolean][]>("list_dir", { path }).then(setKids).catch((e) => setErr(String(e)));
  }, [isDir, open, kids, path]);
  const pad = { paddingLeft: depth * 14 + 8 };
  if (!isDir) return <div className="tree-row file" style={pad} onClick={() => onOpen(path, name)} onContextMenu={(e) => onCtx(e, path, false)} title={name}><span className="tree-ico">{fileIco(name)}</span>{name}</div>;
  return <>
    <div className="tree-row dir" style={pad} onClick={() => setOpen((o) => !o)} onContextMenu={(e) => onCtx(e, path, true)}><span className="tree-ico">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>{name}</div>
    {open && err && <div className="tree-row muted" style={{ paddingLeft: (depth + 1) * 14 + 8 }}>{t("读取失败")}</div>}
    {open && kids?.map(([n, d]) => <TreeNode key={n} path={`${path}/${n}`} name={n} isDir={d} depth={depth + 1} onOpen={onOpen} onCtx={onCtx} />)}
  </>;
}

function fileIco(name: string) {
  const e = name.split(".").pop()?.toLowerCase();
  const sz = 14;
  if (e === "md") return <FileText size={sz} />;
  if (e === "json") return <FileJson size={sz} />;
  if (e === "py") return <FileCode size={sz} />;
  if (e === "html" || e === "css") return <FileCode2 size={sz} />;
  return <File size={sz} />;
}

function InfoSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) { return <section className="info-section"><div className="info-section-head"><h4>{title}</h4>{action}</div>{children}</section>; }

// 在项目目录后台启动一条命令(如 npm run dev),脱离 app 独立跑;起来后延迟重扫,新进程/端口就会出现在列表里。
function StartProc({ cwd, onDone }: { cwd: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [cmd, setCmd] = useState("");
  const start = () => { const c = cmd.trim(); if (!c) return; invoke("spawn_proc", { cmd: c, cwd }).catch(() => {}).finally(onDone); setCmd(""); };
  return (
    <div className="proc-start">
      <input value={cmd} placeholder={t("启动命令，如 npm run dev")} onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) start(); }} />
      <button className="proc-start-btn" disabled={!cmd.trim()} onClick={start}><Play size={11} /> {t("启动")}</button>
    </div>
  );
}

// 回合详情抽屉:从右侧盖在整个界面上,只展示被点那一轮的 agent 回复,随 timeline 更新流式刷新
export function TurnDrawer({ session, anchor, onClose }: { session: Session; anchor: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { respondPermission } = useApi();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<number | null>(null); // 最多撑开一组
  const execution = turnExecution(session.timeline, anchor);
  const { skills, mcps } = usedSkillsMcp(execution);
  const lastUserTs = [...session.timeline].reverse().find((it) => it.kind === "user")?.ts ?? 0;
  const running = session.status === "running" && anchor === lastUserTs;
  const cwd = session.termCwd || session.cwd;
  const onPerm = (rid: string, b: "allow" | "deny", msg?: string, remember?: RememberChoice) => respondPermission(session.id, rid, b, msg, remember);
  // 末条是待处理授权也要滚到底,否则消息藏在下方看不到
  const hasPendingPerm = execution.some((it) => it.kind === "permission" && !it.decision);
  useEffect(() => { // 换一轮就收起,并默认停在最底部(数据太多时先看最新)
    setExpanded(null);
    const el = scrollRef.current; if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
  }, [anchor]);
  // 执行中/有待授权时跟随最新输出滚到底
  useEffect(() => { if (running || hasPendingPerm) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [session.timeline, running, hasPendingPerm]);
  return <>
    <div className="turn-drawer-backdrop" onMouseDown={onClose} />
    <aside className="turn-drawer edge-glow" onMouseMove={onEdgeGlow}>
      <div className="info-head"><b>{t("本轮回复详情")} · {running ? t("执行中") : t("已结束")}</b><button className="ghost" onClick={onClose} aria-label={t("关闭详情抽屉")}><X size={16} /></button></div>
      {(skills.length > 0 || mcps.length > 0) && <div className="drawer-smbar">{t("本轮用到:")}<SkillMcpTags skills={skills} mcps={mcps} /></div>}
      <div className="info-scroll agent-run" ref={scrollRef}>
        {execution.length ? execution.map((item, index) => (
          <ExecutionItem key={index} item={item} expanded={expanded === index} cwd={cwd}
            onToggle={() => setExpanded((e) => (e === index ? null : index))}
            onPermission={onPerm} />
        )) : <div className="muted">{t("尚无执行记录")}</div>}
        {running && <div className="execution-live thinking"><span><LoaderCircle className="ico-spin" size={13} /> {t("Agent 正在工作…")}</span></div>}
      </div>
    </aside>
  </>;
}

// 只取被点那一轮的执行记录:anchor = 该轮起始用户消息 ts(0/未定义 = 会话开头那轮),截到下一条用户消息前
function turnExecution(timeline: TimelineItem[], anchor?: number) {
  let start = 0;
  if (anchor) {
    const idx = timeline.findIndex((it) => it.kind === "user" && it.ts === anchor);
    if (idx >= 0) start = idx + 1;
  }
  const rest = timeline.slice(start);
  const end = rest.findIndex((it) => it.kind === "user");
  const slice = end >= 0 ? rest.slice(0, end) : rest;
  return slice.filter((it) => it.kind !== "user" && it.kind !== "result");
}

// 每组数据默认限高、不出滚动条,点击撑开看全部(最多撑开一组);流式块限高时最新内容贴底显示。
function ExecutionItem({ item, expanded, onToggle, cwd, onPermission }: { item: TimelineItem; expanded: boolean; onToggle: () => void; cwd: string; onPermission: (rid: string, b: "allow" | "deny", msg?: string, remember?: RememberChoice) => void }) {
  const { t } = useTranslation();
  if (item.kind === "system") return <div className="execution-note">{item.text}</div>;
  if (item.kind === "compact") return <div className="execution-note">{item.running ? t("正在压缩上下文…") : t("上下文已压缩")}</div>;
  // 待处理授权:直接复用完整权限卡(含"允许并记住全部")
  if (item.kind === "permission" && !item.decision) return <PermissionCard item={item} cwd={cwd} onPermission={onPermission} />;
  let title = "", body = "", streaming = false;
  let actions: ReactNode = null;
  const permission = item.kind === "permission";
  if (item.kind === "agent_text") { title = item.streaming ? t("Agent 正在输出") : item.phase === "progress" ? t("执行说明") : t("Agent 回复"); body = item.text || "…"; streaming = !!item.streaming; }
  else if (item.kind === "tool") { title = t("工具 · {{name}}", { name: item.name }) + (item.result !== undefined ? item.isError ? t(" · 失败") : t(" · 完成") : t(" · 运行中")); body = JSON.stringify(item.input, null, 2) + (item.result !== undefined ? `\n\n${typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}` : ""); streaming = item.result === undefined; }
  else if (item.kind === "terminal") { title = t("终端 · {{command}}", { command: item.command }); body = item.pending ? t("运行中…") : item.output || t("（无输出）"); streaming = !!item.pending; }
  else if (permission) { title = t("需要授权 · {{toolName}}", { toolName: item.toolName }); body = JSON.stringify(item.input, null, 2); actions = !item.decision ? <div className="info-actions" onClick={(e) => e.stopPropagation()}><button onClick={() => onPermission(item.requestId, "allow")}>{t("允许")}</button><button onClick={() => onPermission(item.requestId, "deny")}>{t("拒绝")}</button></div> : null; }
  else return null;
  return <ExecutionBlock title={title} body={body} streaming={streaming} expanded={expanded} onToggle={onToggle} actions={actions} permission={permission} />;
}

function ExecutionBlock({ title, body, streaming, expanded, onToggle, actions, permission }:
  { title: string; body: string; streaming: boolean; expanded: boolean; onToggle: () => void; actions: ReactNode; permission: boolean }) {
  const { t } = useTranslation();
  const preRef = useRef<HTMLPreElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // 每次内容变化后测量:限高下 scrollHeight 超过 clientHeight = 被截断,才给"展开"入口与渐隐提示
  useEffect(() => {
    const el = preRef.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  });
  const canToggle = expanded || overflowing;
  return (
    <div className={`execution-entry ${permission ? "permission-entry" : ""} ${expanded ? "expanded" : "clamp"} ${streaming ? "streaming" : ""} ${!expanded && overflowing ? "truncated" : ""}`}>
      {/* toggle 热区 = 整个标题横行(展开/折叠都可点)。放在标题行而非整块:展开后点正文能正常选中复制,不误收起 */}
      <div className={`execution-title ${canToggle ? "clickable" : ""}`} onClick={canToggle ? onToggle : undefined}><span>{title}</span>{canToggle && <button className="block-toggle" onClick={(e) => { e.stopPropagation(); onToggle(); }}>{expanded ? <>{t("收起")} <ChevronUp size={12} /></> : <>{t("展开")} <ChevronDown size={12} /></>}</button>}</div>
      <pre ref={preRef}>{body}</pre>
      {actions}
    </div>
  );
}

function quote(value: string) { return `'${value.replace(/'/g, "'\\''")}'`; }
