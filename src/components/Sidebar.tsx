import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, CircleCheck, CircleAlert, Circle, Plus, Search, Settings as SettingsIcon, Blocks, X, GripVertical, FolderPlus, ChevronRight, ChevronDown, Trash2 } from "lucide-react";
import { useStore } from "../store";
import type { VersionCheck } from "../version";
import { onEdgeGlow } from "../lib/edgeGlow";
import { btnPress } from "../lib/utils";
import { ModelAvatar } from "./Avatar";
import { replayBrandIntro } from "./BrandIntro";
import type { IndexEntry, Session } from "../types";

// 品牌 logo 内联 SVG:lucide v1 已移除品牌图标。单色 currentColor,尺寸与其它 lucide 图标一致(14)。
const GithubMark = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

// 会话状态图标:lucide circle 家族,深浅色都协调;运行中用 Framer Motion 旋转
function StatusIcon({ status, freshDone }: { status?: Session["status"]; freshDone?: boolean }) {
  const sz = 15, sw = 2.2;
  if (status === "running")
    // 用纯 CSS 动画(.dot.spin,transform rotate)转圈:合成线程驱动,切换会话主线程再忙也不掉帧;
    // 之前用 framer-motion 的 JS(rAF)动画,重渲染大会话时会被主线程挤掉一帧,肉眼可见"卡一下"。
    // 不写内联 display:flex —— 行内样式压过 hover 的 `> .dot { display:none }`,hover 时菊花躲不掉,
    // 会跟拖拽把手(6 点)并排把会话名往右挤。交给 .dot 的 display:grid 居中,宽度统一 16px。
    return <span className="dot status-running spin"><LoaderCircle size={sz} strokeWidth={sw} /></span>;
  if (status === "waiting")
    return <span className="dot status-waiting"><CircleAlert size={sz} strokeWidth={sw} /></span>;
  if (status === "idle" && freshDone) // 仅本次启动后真正完成过一轮才绿✅;历史 reopen 的 idle 走灰圈
    return <span className="dot status-idle"><CircleCheck size={sz} strokeWidth={sw} /></span>;
  return <span className="dot status-closed"><Circle size={sz} strokeWidth={sw} /></span>; // closed/未开始/历史 idle
}

// b: 会话列表,母子两级(3: 继承关系天然可见)—— 顶级=独立会话,子=从某会话继承而来
export function Sidebar({ onSearch, onOpenSettings, update, onShowUpdate }:
  { onSearch: () => void; onOpenSettings: (tab?: string) => void; update?: VersionCheck | null; onShowUpdate?: () => void }) {
  const { t } = useTranslation();
  const { state, createSession, reopenSession, deleteSession, renameSession, dispatch, requestAuthStatus,
    moveSession, createGroup, renameGroup, deleteGroup, stopTask } = useStore();
  const [cwd, setCwd] = useState("");
  const [casual, setCasual] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // 待确认关闭的会话(Tauri 的 confirm() 不可靠,自己弹);有活跃进程时多给一档"是否一并结束"。
  // procs 是开弹窗那一刻的快照:runtime 靠轮询刷新,若弹窗内容跟着实时值变,
  // 一次刷新落在 mousedown 与 mouseup 之间就会挪动/重挂载按钮,click 直接丢掉(表现为"点一下没反应,再点才行")。
  const [killPrompt, setKillPrompt] = useState<{ e: IndexEntry; procs: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null); // 右键菜单
  const [editId, setEditId] = useState<string | null>(null); // 正在重命名的会话
  const editRef = useRef<HTMLInputElement>(null); // 非受控:DOM 自己管值,避免与 React 重渲染/输入法打架
  const skipCommit = useRef(false); // Esc 取消时跳过 blur 提交
  const composedAt = useRef(0); // WKWebView 里选字的 Enter 落在 compositionend 之后、isComposing 已为 false,靠时间戳挡一下

  // 拖拽:Tauri 开了 dragDropEnabled(Composer 拖图片要用),macOS 原生拖放层会吞掉 WKWebView 的 HTML5
  // 拖拽事件 —— onDrop 根本不触发。所以这里用鼠标指针事件自己实现,绕开原生层。
  // 落点用 data-drop 属性 + elementFromPoint 命中:row=落到该行前,group=落进该分组尾(gid=""为未分组)。
  const drag = useRef<{ id: string; x0: number; y0: number; active: boolean } | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null); // "before:<id>" | "group:<gid>" | "group:" (未分组区)
  const [dragId, setDragId] = useState<string | null>(null); // 正在拖的行 id，用于跟手位移
  const [dragXY, setDragXY] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 }); // 相对起手点的位移

  const resolveDrop = (x: number, y: number): { groupId: string | null; beforeId: string | null } | null => {
    const dz = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-drop]") as HTMLElement | null;
    if (!dz) return null;
    if (dz.dataset.drop === "row") {
      const rid = dz.dataset.id || "";
      if (!rid || rid === drag.current?.id) return null; // 落在自己身上 = 无操作
      return { groupId: dz.dataset.gid || null, beforeId: rid };
    }
    return { groupId: dz.dataset.gid || null, beforeId: null }; // 分组头/分组区/未分组区:追加到该组末尾
  };
  const endDrag = () => { // 统一收尾:摘监听、清拖拽态。丢失 mouseup 时也靠它兜底
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    document.body.classList.remove("dragging-session");
    drag.current = null; setDropHint(null); setDragId(null); setDragXY({ dx: 0, dy: 0 });
  };
  const onDragMove = (ev: MouseEvent) => {
    const st = drag.current; if (!st) return;
    // 左键已松开却还收到 move = 上一次的 mouseup 被吞了(macOS 后台窗口激活那下点击会吃掉 mouseup)。
    // 直接收尾,别让它误抓下一个会话且抓着放不下。
    if (!(ev.buttons & 1)) { endDrag(); return; }
    if (!st.active) { // 超过阈值才算拖拽,避免和点击手柄冲突
      if (Math.abs(ev.clientX - st.x0) + Math.abs(ev.clientY - st.y0) < 5) return;
      st.active = true; document.body.classList.add("dragging-session"); setDragId(st.id);
    }
    setDragXY({ dx: ev.clientX - st.x0, dy: ev.clientY - st.y0 }); // 跟手:被抓的行实时跟鼠标
    const t = resolveDrop(ev.clientX, ev.clientY);
    setDropHint(t ? (t.beforeId ? `before:${t.beforeId}` : `group:${t.groupId ?? ""}`) : null);
  };
  const onDragUp = (ev: MouseEvent) => {
    const st = drag.current;
    endDrag();
    if (!st || !st.active) return;
    const t = resolveDrop(ev.clientX, ev.clientY);
    if (t && t.beforeId !== st.id) moveSession(st.id, t.groupId, t.beforeId);
  };
  const beginDrag = (id: string, ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    drag.current = { id, x0: ev.clientX, y0: ev.clientY, active: false };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
  };
  // 分组折叠态 + 正在重命名的分组(本地态,折叠持久化到 localStorage)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("ChatCode-collapsed-groups") || "[]")); } catch { return new Set(); }
  });
  const toggleCollapse = (gid: string) => setCollapsed((prev) => {
    const next = new Set(prev); next.has(gid) ? next.delete(gid) : next.add(gid);
    localStorage.setItem("ChatCode-collapsed-groups", JSON.stringify([...next]));
    return next;
  });
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const groupEditRef = useRef<HTMLInputElement>(null);
  const [submenuId, setSubmenuId] = useState<string | null>(null); // 右键菜单里"移动到分组"展开的会话 id

  useEffect(() => { // 点击别处 / 按 Esc 关闭右键菜单
    if (!menu) return;
    const close = () => { setMenu(null); setSubmenuId(null); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // 听 mousedown 而不是 click:菜单项本身已经是按下即执行(见 menuItem),关闭也得跟上同一拍 ——
    // 听 click 的话点菜单外面要等到 mouseup 才消失,而下层(会话行也是 mousedown 激活)早就响应完了,
    // 菜单会明显地"慢一步才消失"。菜单自己那块由容器的 onMouseDown 拦掉,点空白处不会误关。
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  // 右键菜单项。走 btnPress 是为了按下即执行 —— click 在 WKWebView 里会被吞掉第一次(见 lib/utils),
  // 菜单里表现就是"点一下没反应,再点才行"。按下即执行也正是原生右键菜单的行为。
  // 每项自己 setMenu(null),不靠 window 那个 click 兜底(容器的 stopPropagation 本来也挡着它)。
  // role/tabIndex 得自己补:这些是 div 不是 button,不给 tabIndex 就聚不了焦,btnPress 的键盘分支收不到事件。
  const menuItem = (fn: () => void) => ({ role: "menuitem", tabIndex: 0, ...btnPress(fn) });
  const startRename = (e: IndexEntry) => { setEditId(e.id); setMenu(null); };
  const commitRename = () => {
    if (skipCommit.current) { skipCommit.current = false; setEditId(null); return; }
    const t = editRef.current?.value.trim();
    if (editId && t) renameSession(editId, t);
    setEditId(null);
  };

  // 连上服务后拉一次账号状态,底部实时显示已登录/未登录
  useEffect(() => { if (state.connected) requestAuthStatus(); }, [state.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // 最近 10 个不重复项目目录(index[0] 最新),新建会话时可一键复用
  const recentDirs = [...new Set(state.index.map((e) => e.cwd).filter(Boolean))].slice(0, 10);
  const roots = state.index.filter((e) => !e.inheritFrom || !state.index.some((p) => p.id === e.inheritFrom));
  const childrenOf = (id: string) => state.index.filter((e) => e.inheritFrom === id);
  // 分组归属:groupId 指向已删除的分组时,按未分组处理
  const groupIds = new Set(state.groups.map((g) => g.id));
  const rootGroup = (e: IndexEntry) => (e.groupId && groupIds.has(e.groupId) ? e.groupId : null);
  const rootsInGroup = (gid: string | null) => roots.filter((r) => rootGroup(r) === gid);
  const commitGroupRename = () => {
    const t = groupEditRef.current?.value.trim();
    if (editGroupId && t) renameGroup(editGroupId, t);
    setEditGroupId(null);
  };
  // 插件 · MCP · Skills 的清单改在设置弹窗的"扩展"页展示(见 Settings 的 ExtensionsTab),侧栏这里只做入口

  // b: 会话副标题显示最后一条消息(微信式),含助手回复/工具,非仅我发的
  // 副标题:始终显示最新一条**用户**消息(不显示 agent/工具/系统,也不回退成目录)。
  // 内存有 timeline 时取 timeline;重启后内存空,用 index 落盘的 lastUser。
  const lastPreview = (e: IndexEntry): string => {
    const s = state.sessions[e.id];
    if (s) {
      for (let i = s.timeline.length - 1; i >= 0; i--) {
        const t = s.timeline[i];
        if (t.kind !== "user") continue;
        const txt = t.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join(" ").trim();
        if (txt) return txt;
        if (t.blocks.some((b) => b.type === "image")) return "[图片]";
      }
    }
    return e.lastUser ?? "";
  };


  // 关闭一律先弹窗确认(删历史不可撤销)。有没有活跃进程只改弹窗里给几个选项,不改这条路径。
  // 调用点直接写在行内的 × 上(btnPress 自带 stopPropagation,不会连带把会话切过去)。
  const procCount = (id: string) => {
    const rt = state.git[id]?.runtime;
    return (rt?.processes.length || 0) + (rt?.ports.length || 0);
  };
  // 关闭会话:killProcs 时先结束其名下所有进程/端口,再删会话历史
  const doClose = (e: IndexEntry, killProcs: boolean) => {
    if (killProcs) {
      const rt = state.git[e.id]?.runtime;
      // agent 起的后台任务没有 pid,交给 SDK 停(会话马上要删,停不掉也不阻塞)
      rt?.processes.forEach((p) => (p.task ? stopTask(e.id, p.task) : invoke("kill_pid", { pid: p.pid }).catch(() => {})));
      rt?.ports.forEach((p) => invoke("kill_port", { port: p.port }).catch(() => {}));
    }
    childrenOf(e.id).forEach((c) => deleteSession(c.id)); // 先删子,避免孤儿
    deleteSession(e.id);
    setKillPrompt(null);
  };

  const chooseFolder = async () => {
    try {
      const picked = await invoke<string | null>("choose_directory");
      if (picked) setCwd(picked);
    } catch {
      // 浏览器开发模式没有原生文件选择器，仍可手动输入本地路径。
    }
  };
  const createWorkspaceSession = () => {
    const base = cwd.trim();
    if (!casual && !base) return;
    createSession(casual ? "" : base, null, undefined, null, casual);
    setWorkspaceOpen(false);
  };

  // 用普通函数内联渲染(不是组件),避免每次 render 生成新组件类型导致整行(含重命名输入框)被卸载重挂
  const renderRow = ({ e, child, last }: { e: IndexEntry; child?: boolean; last?: boolean }) => {
    const live = state.sessions[e.id];
    // 只有顶级会话可拖拽/作为落点(子会话跟随母会话,不独立排序)
    const draggable = !child;
    const gid = rootGroup(e);
    return (
      <div
        key={e.id}
        className={`session-item ${child ? "child" : "root"} ${state.activeId === e.id ? "active" : ""} ${dropHint === `before:${e.id}` ? "drop-before" : ""} ${dragId === e.id ? "dragging" : ""} ${state.justCreatedId === e.id ? "session-item--enter" : ""}`}
        role="button"
        tabIndex={0}
        // 跟手:只跟竖直(横向锁死,列表是竖向重排,横向跟手会让卡飘出侧栏找不着);pointer-events:none 让 elementFromPoint 穿透到下方行判定落点
        style={dragId === e.id ? { transform: `translateY(${dragXY.dy}px)`, zIndex: 50, pointerEvents: "none", willChange: "transform" } : undefined}
        {...(draggable ? { "data-drop": "row", "data-id": e.id, "data-gid": gid ?? "" } : {})}
        // 用 mousedown 而非 click 切换:输入框(contentEditable)聚焦时,WKWebView 里第一次点侧栏
        // 只 blur 编辑器、不把 click 派发到行,导致"点一次没反应"。按下即切,绕开这个坑。
        onMouseDown={(ev) => {
          if (ev.button !== 0) return; // 右键交给 onContextMenu
          if ((ev.target as HTMLElement).closest(".session-actions, .rename-input, .drag-handle")) return; // 关闭按钮/重命名输入/拖拽手柄自理
          // 正在改名时点到输入框以外:下面的 preventDefault 会挡掉 blur,输入框收不到 onBlur → 存不了。
          // 这里主动提交一次,把新名字落地(点其它行/空白都算保存)。
          if (editId) commitRename();
          // 鼠标点行不抢键盘焦点:行是 tabIndex=0 的 div,一旦聚焦,回车就被本行的 onKeyDown 吃掉
          // (只是重新 activate 一次),右侧待授权卡片/输入框反而收不到 ⏎/esc。Tab 键聚焦不受影响。
          ev.preventDefault();
          live ? dispatch({ type: "activate", id: e.id }) : reopenSession(e.id);
          if (draggable) beginDrag(e.id, ev); // 整卡片可拖:阈值内不动=点击(已激活),超阈值才真拖
        }}
        onDoubleClick={(ev) => {
          if ((ev.target as HTMLElement).closest(".session-actions, .rename-input, .drag-handle")) return;
          setEditId(e.id); // 双击整行激活改名
        }}
        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); live ? dispatch({ type: "activate", id: e.id }) : reopenSession(e.id); } }}
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ id: e.id, x: ev.clientX, y: ev.clientY }); }}
      >
        {child && <span className="tree-line">{last ? "└" : "├"}</span>}
        {draggable && (
          // 拖拽手柄:mousedown 起手做指针拖拽(见 beginDrag),阻断冒泡避免触发整行选中/preventDefault
          <span className="drag-handle" onMouseDown={(ev) => beginDrag(e.id, ev)}
            title={t("拖拽排序 / 移入分组")}><GripVertical size={13} /></span>
        )}
        <StatusIcon status={live?.status} freshDone={live?.freshDone} />
        <div className="session-meta">
          <div className="session-title">
            {editId === e.id ? (
              <input className="rename-input" autoFocus ref={editRef} defaultValue={e.title}
                onClick={(ev) => ev.stopPropagation()}
                onFocus={(ev) => ev.currentTarget.select()}
                onBlur={commitRename}
                onCompositionEnd={() => { composedAt.current = Date.now(); }}
                onKeyDown={(ev) => {
                  ev.stopPropagation(); // 否则空格/回车冒泡到整行 onKeyDown 被 preventDefault,打不出空格
                  if (ev.nativeEvent.isComposing) return; // 组合中的回车是选字,不提交
                  if (ev.key === "Enter" && Date.now() - composedAt.current < 250) return; // 刚选完字的 Enter,吞掉
                  if (ev.key === "Enter") { ev.preventDefault(); commitRename(); }
                  else if (ev.key === "Escape") { ev.preventDefault(); skipCommit.current = true; setEditId(null); }
                }} />
            ) : <span className="session-title-text" title={t("双击重命名")}>{e.title}</span>}
          </div>
          {/* 不挂 title:整段 agent 回复当原生 tooltip 弹出来会盖住半个屏幕,列表里那行截断预览已经够了 */}
          <div className="session-cwd">{lastPreview(e) || e.cwd.replace(/^\/Users\/[^/]+/, "~")}</div>
        </div>
        <div className="session-actions">
          <button className="ghost close" title={t("关闭会话")} {...btnPress(() => setKillPrompt({ e, procs: procCount(e.id) }))}><X size={14} /></button>
        </div>
      </div>
    );
  };

  // 侧栏自己也得是拖拽区:红绿灯那条 28px 带上,盖在最上面的是 .sidebar(z-index 101,为了让边缘光压过
  // 标题栏底色),不是 .titlebar-drag(z-index 100)—— 那条拖拽条在侧栏这半边根本吃不到 mousedown。
  // 不带值 = 只有直接命中本元素才拖:这里就是顶部那圈 padding 和列表之间的空隙,子节点照常点。
  return (
    <div className="sidebar edge-glow" onMouseMove={onEdgeGlow} data-tauri-drag-region>
      <div className="sidebar-head" data-tauri-drag-region>
        {/* 品牌标改用 App 图标本体(public/logo.png,和 .app 图标同一张源图),不再是那个 ⌘ 占位符 */}
        {/* 品牌行整块可拖窗。deep = 子树里任意位置按下都算(tauri 2.11 的 drag.js 支持),
            省得给 img/b 各挂一份;里面若有按钮/链接,drag.js 会先判 clickable 自动放行。 */}
        <div className="app-brand" data-tauri-drag-region="deep">
          <img className="app-brand-mark" src="/logo.png" alt="" />
          <b className="app-brand-name">ChatCode</b>
        </div>
        {/* 搜索框与新建按钮并排:搜索框 flex 伸缩,新建按钮定宽 —— 拖动侧栏只有搜索框变 */}
        <div className="search-row">
          <button className="sidebar-search" {...btnPress(onSearch)}><span className="search-l"><Search size={14} /> {t("搜索")}</span> <kbd><span className="kbd-cmd">⌘</span>K</kbd></button>
          <button className="new-session new-group" {...btnPress(() => createGroup(t("新分组")))} title={t("新建分组")} aria-label={t("新建分组")}><FolderPlus size={16} /></button>
          {/* 只有这个入口重播 logo 进场:删完最后一个会话之类也会落到空态,那种不算「开新头」 */}
          <button className="new-session" {...btnPress(() => { replayBrandIntro(); dispatch({ type: "go_home" }); })} title={t("新建会话")} aria-label={t("新建会话")}><Plus size={16} /></button>
        </div>
      </div>
      {/* 列表本身也带一份:.sidebar 那份只在直接命中它时生效,而列表 flex:1 撑满,
          最后一个会话下面那片空白归 .session-list —— 不挂就点不到窗口拖拽。会话行是子节点,照常点。 */}
      <div className="session-list" data-tauri-drag-region>
        {/* 顶级会话按母子树渲染;拖拽手柄可重排、移入分组 */}
        {(() => {
          const renderTree = (e: IndexEntry) => {
            const kids = childrenOf(e.id);
            return (
              <div key={e.id} className={kids.length ? "session-group" : ""}>
                {renderRow({ e })}
                {kids.map((c, i) => renderRow({ e: c, child: true, last: i === kids.length - 1 }))}
              </div>
            );
          };
          const ungrouped = rootsInGroup(null);
          return (
            <>
              {/* 未分组区:也是"移出分组"的落点 */}
              <div className={`group-body ungrouped ${dropHint === "group:" ? "drop-into" : ""}`}
                data-drop="group" data-gid="">
                {ungrouped.map(renderTree)}
              </div>
              {state.groups.map((g) => {
                const members = rootsInGroup(g.id);
                const isCol = collapsed.has(g.id);
                return (
                  <div key={g.id} className="group-block">
                    <div className={`group-header ${dropHint === `group:${g.id}` ? "drop-into" : ""}`}
                      data-drop="group" data-gid={g.id}
                      // 整行可点击折叠/展开;点删除按钮、改名输入框不触发
                      onClick={(ev) => {
                        if (editGroupId === g.id) return;
                        if ((ev.target as HTMLElement).closest(".group-actions, .group-rename")) return;
                        toggleCollapse(g.id);
                      }}>
                      <button className="group-caret" {...btnPress(() => toggleCollapse(g.id))} title={isCol ? t("展开") : t("折叠")}>
                        {isCol ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      </button>
                      {editGroupId === g.id ? (
                        <input className="group-rename" autoFocus ref={groupEditRef} defaultValue={g.name}
                          onFocus={(ev) => ev.currentTarget.select()}
                          onBlur={commitGroupRename}
                          onKeyDown={(ev) => {
                            ev.stopPropagation();
                            if (ev.nativeEvent.isComposing) return;
                            if (ev.key === "Enter") { ev.preventDefault(); commitGroupRename(); }
                            else if (ev.key === "Escape") { ev.preventDefault(); setEditGroupId(null); }
                          }} />
                      ) : (
                        <span className="group-name" onDoubleClick={() => setEditGroupId(g.id)} title={t("双击重命名")}>
                          {g.name} <span className="group-count">{members.length}</span>
                        </span>
                      )}
                      <span className="group-actions">
                        <button className="ghost group-del" title={t("删除分组(会话回到未分组)")} {...btnPress(() => deleteGroup(g.id))}><Trash2 size={13} /></button>
                      </span>
                    </div>
                    {!isCol && (
                      <div className={`group-body ${dropHint === `group:${g.id}` ? "drop-into" : ""}`}
                        data-drop="group" data-gid={g.id}>
                        {members.length ? members.map(renderTree)
                          : <div className="group-empty">{t("拖拽会话到这里")}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          );
        })()}
      </div>
      <div className="global-status">
        {/* Agent 服务:连接状态 + 右侧列出「当前已连接的所有 LLM」的 logo(不是当前会话那一个)。
            连接的 = Claude(始终) + 已配置 key 的其他 provider(auth.providers[*].configured)。 */}
        {(() => {
          const g = state.auth?.github;
          const providers = state.auth?.providers ?? {};
          // claude 始终在;其余按是否配置了 key。dedup 保序。
          const connected = ["claude", ...Object.keys(providers).filter((id) => id !== "claude" && providers[id].configured)];
          return <>
            <button className="footer-row" onMouseDown={(e) => { if (e.button === 0) onOpenSettings(); }} title={t("打开设置")}>
              <span className="footer-row-l">
                <span className={`conn-dot ${state.connected ? "on" : "off"}`} />
                {t("大模型")}
              </span>
              <span className="footer-model-logos">
                {connected.map((id) => (
                  // ModelAvatar 认识各家(有官方图用图,没有的用品牌色字母徽标),别再一律回退 Claude 图
                  <ModelAvatar key={id} model={id} className="footer-brand-badge" />
                ))}
              </span>
            </button>
            <button className="footer-row" onMouseDown={(e) => { if (e.button === 0) onOpenSettings("github"); }} title={t("打开设置")}>
              <span className="footer-row-l"><GithubMark /> GitHub</span>
              <span className="muted">{!g ? "…" : g.loggedIn ? (g.account || t("已登录")) : t("未登录")}</span>
            </button>
          </>;
        })()}
        {/* 点击直接开设置弹窗的"扩展"页看清单,不再在侧栏内联展开 */}
        <button className="footer-row" onMouseDown={(e) => { if (e.button === 0) onOpenSettings("extensions"); }} title={t("查看插件")}>
          <span className="footer-row-l"><Blocks size={14} /> {t("插件")}</span>
        </button>
        <button className="footer-row" onMouseDown={(e) => { if (e.button === 0) onOpenSettings(); }} title={t("设置")}>
          <span className="footer-row-l"><SettingsIcon size={14} /> {t("设置")}</span>
          {/* 有新版时在"设置"右侧挂一个入口:弹窗关掉了也随时能点回来看更新内容 */}
          {update && <span className="footer-update" title={t("发现新版本 v{{version}}", { version: update.latestVersion })}
            onMouseDown={(e) => { e.stopPropagation(); if (e.button === 0) onShowUpdate?.(); }}>{t("新版本")}</span>}
        </button>
      </div>
      {menu && (() => {
        const e = state.index.find((x) => x.id === menu.id);
        if (!e) return null;
        return (
          <div className="ctx-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="ctx-item" {...menuItem(() => startRename(e))}>{t("重命名")}</div>
            {e.sdkSessionId && <div className="ctx-item" {...menuItem(() => { setMenu(null); createSession(e.cwd, e.sdkSessionId, t("续·{{title}}", { title: e.title }), e.id); })}>{t("开启子会话")}</div>}
            {/* 移动到分组:非拖拽的备选路径,后台会话也能归类 */}
            {!e.inheritFrom && (
              <div className="ctx-item has-sub" onMouseEnter={() => setSubmenuId(e.id)} onMouseLeave={() => setSubmenuId(null)}>
                {t("移动到分组")} <ChevronRight size={13} />
                {submenuId === e.id && (
                  <div className="ctx-submenu" role="menu">
                    <div className="ctx-item" {...menuItem(() => { setMenu(null); moveSession(e.id, null, null); })}>{t("移出分组")}</div>
                    {state.groups.length > 0 && <div className="ctx-sep" />}
                    {state.groups.length === 0 && <div className="ctx-item muted-item">{t("先用顶部 📁 新建分组")}</div>}
                    {state.groups.map((g) => (
                      <div key={g.id} className={`ctx-item ${rootGroup(e) === g.id ? "checked" : ""}`}
                        {...menuItem(() => { setMenu(null); moveSession(e.id, g.id, null); })}>{g.name}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="ctx-item danger" {...menuItem(() => { setMenu(null); setKillPrompt({ e, procs: procCount(e.id) }); })}>{t("关闭会话…")}</div>
          </div>
        );
      })()}
      {/* Portal 到 body:自定义主题下 .sidebar 有 backdrop-filter,会成为 fixed 后代的包含块,
          遮罩不 Portal 出去就只盖住侧栏。挂到 body 才能覆盖整个窗口。 */}
      {workspaceOpen && createPortal(
        <div className="workspace-shade" onMouseDown={() => setWorkspaceOpen(false)}>
          <div className="workspace-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="workspace-title">{t("选择项目空间")}</div>
            <p>{t("每个新会话在一个本地目录中运行。选择一个已有目录。")}</p>
            <label className="workspace-casual">
              <input type="checkbox" checked={casual} onChange={(e) => setCasual(e.target.checked)} />
              {t("闲聊（无需项目目录，仅临时对话）")}
            </label>
            {!casual && (
              <label>{t("本地目录")}
                <div className="workspace-path"><input autoFocus value={cwd} placeholder={t("例如 /Users/tou/MyProject")}
                  onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createWorkspaceSession()} />
                  <button onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); chooseFolder(); } }}>{t("选择…")}</button></div>
              </label>
            )}
            {!casual && recentDirs.length > 0 && (
              <div className="workspace-recent">
                <div className="workspace-recent-label">{t("最近目录")}</div>
                <div className="workspace-recent-list">
                  {recentDirs.map((d) => (
                    <button key={d} type="button" className="recent-chip" title={d}
                      {...btnPress(() => setCwd(d))}>{d.split("/").pop() || d}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="workspace-actions"><button {...btnPress(() => setWorkspaceOpen(false))}>{t("取消")}</button><button className="primary" disabled={!casual && !cwd.trim()} {...btnPress(createWorkspaceSession)}>{t("开始会话")}</button></div>
          </div>
        </div>, document.body)}
      {killPrompt && createPortal(
        <div className="workspace-shade" onMouseDown={() => setKillPrompt(null)}>
          <div className="workspace-dialog kill-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="workspace-title">{t("关闭「{{title}}」", { title: killPrompt.e.title })}</div>
            {/* 两种情形共用同一层 dom/class,尺寸自然一致(宽度来自 .workspace-dialog),差别只在中间这几个按钮 */}
            <p>{killPrompt.procs > 0
              ? t("该会话仍有 {{count}} 个活跃进程/端口。关闭后要一并结束它们吗？", { count: killPrompt.procs })
              : t("关闭后该会话的历史将被删除，且无法恢复。")}</p>
            <div className="kill-dialog-ops">
              {killPrompt.procs > 0 ? <>
                <button className="kill-yes" {...btnPress(() => doClose(killPrompt.e, true))}>{t("结束进程并关闭")}</button>
                <button {...btnPress(() => doClose(killPrompt.e, false))}>{t("保留进程，仅关闭")}</button>
              </> : <button className="kill-yes" {...btnPress(() => doClose(killPrompt.e, false))}>{t("确认关闭")}</button>}
              <button className="ghost" {...btnPress(() => setKillPrompt(null))}>{t("取消")}</button>
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}
