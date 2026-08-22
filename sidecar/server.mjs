// Sidecar: 包住 Claude Agent SDK 的 WebSocket 桥。
// 前端(浏览器/Tauri webview)连 ws://127.0.0.1:8975,每个 session 独立跑一个 SDK query,天然支持并行任务。
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PROVIDERS, providerOf, modelArg, envForModel, extraModels, resolvedProvider, endpointsOf, variantsOf, setProxyPort, isCnMachine, sanitizeCatalogModels } from "./providers.mjs";
import { accumulate, emptySpend, priceTable, ledgerAdd, ledgerStats } from "./spend.mjs";
import { startProxy } from "./openai-proxy.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

// Finder / Tauri 拉起的进程通常没有用户 zsh 的 Homebrew PATH。补齐常见目录，
// 让 sidecar、! 终端命令以及 Claude Code 子进程看到相同的 gh / brew 等可执行文件。
const commonBinDirs = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")].filter((dir) => fs.existsSync(dir));
const currentPath = (process.env.PATH || "").split(":").filter(Boolean);
process.env.PATH = [...commonBinDirs.filter((dir) => !currentPath.includes(dir)), ...currentPath].join(":");

// 打包后的 app 由 Rust 侧 spawn 本进程,并用环境变量注入这三项:
//   PORT       —— 打包版走 8976,避开开发时占着 8975 的那个 sidecar,两者可并存
//   DATA_DIR   —— 开发调试时指到临时目录,免得把真实会话搞乱
//   CLAUDE_BIN —— SDK 默认从 node_modules 里解析原生 CLI,但打包后没有 node_modules,
//                 必须显式告诉它 claude 可执行文件在哪(见 spawnAgent 的 pathToClaudeCodeExecutable)
const PORT = Number(process.env.CHAT_CODE_PORT) || 8975;
// 打包版这个 env 一定有(Rust 那边 data_dir() 注入,老目录 ~/.chat-code 的改名也在那做)。
// 这里的默认值只给「不经 Rust、直接 node sidecar/server.mjs」的裸跑用,不做改名。
const DATA_DIR = process.env.CHAT_CODE_DATA_DIR || path.join(os.homedir(), ".ChatCode");
const CLAUDE_BIN = process.env.CHAT_CODE_CLAUDE_BIN || undefined;
// 老数据目录名。目录本身由 Rust 那边改名搬走了,但 index 里存的 cwd 还是老路径 —— loadIndex 里改写
const OLD_DATA_DIR = path.join(os.homedir(), ".chat-code");
const SESS_DIR = path.join(DATA_DIR, "sessions");
const SSH_DIR = path.join(DATA_DIR, "ssh"); // SSH ControlMaster 套接字
const INDEX = path.join(DATA_DIR, "index.json");
const GROUPS = path.join(DATA_DIR, "groups.json"); // 会话分组定义(顺序=数组顺序)
const SETTINGS = path.join(DATA_DIR, "settings.json");
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(SSH_DIR, { recursive: true });

// 超过这个上下文体积,重开会话时先问"从摘要恢复还是完整恢复"(对齐 CLI 的 --resume 提示)
const RESUME_ASK_TOKENS = 100_000;

// ---------- 手机推送:任务完成/需审批 → App 全局悬浮窗(data-only 推送) ----------
// 配置(env):DT_NOTIFY_URL + DT_NOTIFY_KEY 两个都填才发,缺一静默跳过。
// URL 不设默认值:写死一个域名,别人配了自己的 key 也会打到那台机器上。
const NOTIFY_URL = process.env.DT_NOTIFY_URL || "";
const NOTIFY_KEY = process.env.DT_NOTIFY_KEY || "";
const NOTIFY_TOPIC = process.env.DT_NOTIFY_TOPIC || "chatcode";
async function pushOverlay(title, body) {
  if (!NOTIFY_URL || !NOTIFY_KEY) return; // 未配置:静默 no-op
  try {
    await fetch(`${NOTIFY_URL}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-notify-key": NOTIFY_KEY },
      body: JSON.stringify({ topic: NOTIFY_TOPIC, title, body: body || tr("点击查看"), overlay: true }),
    });
  } catch {}
}

// ---------- 子进程环境清洗 ----------
// 起子进程一律用清洗过的 env:名字里带 KEY / SECRET / TOKEN / PASSWORD / CREDENTIAL 的一概不带出去。
// 最要命的是 CHAT_CODE_TOKEN —— ws 握手令牌(见下面 TOKEN 那段)。一条 `!env`、或 agent 跑的任何
// 打印环境的命令,输出都会原样回到聊天记录里;令牌一旦露出去,浏览器里任意网页就能连上这个固定的
// loopback 端口发 terminal_command。DT_NOTIFY_KEY、用户自己的各家 API key 同理。
// 两个例外:claude CLI 自己要拿 provider key 干活(spawnAgent 保持全量 env);
// 个别命令确实靠某个 token 认证的(gh 的 GH_TOKEN),由调用方显式白名单传回。
// 注意 `bash -lc` 是登录 shell,会重新 source 用户 profile —— 用户自己 export 的那些照样在,
// 被挡掉的只是 ChatCode 这个进程额外带的。
const SENSITIVE_ENV = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i;
function safeEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SENSITIVE_ENV.test(k)) out[k] = v;
  for (const [k, v] of Object.entries(extra || {})) if (v != null) out[k] = v;
  return out;
}

// ---------- SSH:ControlMaster 持久连接,每命令复用(仅密钥认证,无 TTY 不支持交互式密码) ----------
const sshSock = (id) => path.join(SSH_DIR, `${id}.sock`);
function sshCtl(id, ssh, extra) {
  const a = ["-o", `ControlPath=${sshSock(id)}`];
  if (ssh.port) a.push("-p", String(ssh.port));
  if (ssh.keyPath) a.push("-i", ssh.keyPath, "-o", "IdentitiesOnly=yes");
  return [...a, ...extra];
}
function parseSsh(rest) { // "!ssh [-p 端口] user@host" -> {target, port}
  const toks = rest.trim().split(/\s+/);
  let port = null, target = null;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "-p" && toks[i + 1]) { port = toks[i + 1]; i++; }
    else if (!toks[i].startsWith("-") && !target) target = toks[i];
  }
  return { target, port };
}
const pubSsh = (ssh) => (ssh ? { host: ssh.target, status: ssh.status, port: ssh.port, keyPath: ssh.keyPath } : null);
function persistSsh(id, ssh) {
  const idx = loadIndex(); const e = idx.find((x) => x.id === id);
  if (e) { e.ssh = ssh ? { target: ssh.target, port: ssh.port, keyPath: ssh.keyPath } : null; saveIndex(idx); }
}
function sshConnect(id, ssh, cb) {
  const args = ["-o", `ControlPath=${sshSock(id)}`, "-o", "ControlMaster=auto",
    "-o", "ControlPersist=30m", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new"];
  if (ssh.port) args.push("-p", String(ssh.port));
  if (ssh.keyPath) args.push("-i", ssh.keyPath, "-o", "IdentitiesOnly=yes");
  args.push("-fN", ssh.target);
  execFile("ssh", args, { timeout: 25000, env: safeEnv() }, cb);
}
function sshExit(id, ssh, cb) {
  execFile("ssh", sshCtl(id, ssh, ["-O", "exit", ssh.target]), { env: safeEnv() }, () => { try { fs.unlinkSync(sshSock(id)); } catch {} cb && cb(); });
}
function sshBroadcast(id, ssh) {
  const payload = JSON.stringify({ type: "ssh_status", sessionId: id, ssh: pubSsh(ssh) });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}
// 建立 SSH master 连接(!ssh 或重连按钮触发)
function sshDial(ws, sess, id, target, port) {
  sess.ssh = { target, port, keyPath: sess.ssh?.keyPath, status: "connecting", cwd: sess.ssh?.cwd || "" };
  persistSsh(id, sess.ssh);
  sshBroadcast(id, sess.ssh);
  sshExit(id, sess.ssh, () => sshConnect(id, sess.ssh, (err, _so, stderr) => {
    if (!sess.ssh || sess.ssh.target !== target) return; // 期间被改/关
    sess.ssh.status = err ? "error" : "connected";
    persistSsh(id, sess.ssh);
    sshBroadcast(id, sess.ssh);
    // cwd 走回落链,不能裸取 termCwd:断开 SSH 时它被置成 undefined(见 ssh_close 分支),
    // JSON 序列化会把 undefined 字段整个丢掉,前端 item.cwd 变 undefined,渲染时 .startsWith 崩掉整页。
    send(ws, { type: "terminal_result", sessionId: id, command: `ssh ${target}`, cwd: sess.termCwd || sess.agentCwd || resolveCwd(id),
      output: err ? tr("SSH 连接失败: {{detail}}", { detail: (stderr || err.message || "").trim() || tr("检查主机/密钥") }) : tr("✅ 已连接 {{target}},后续 ! 命令在远端执行", { target }),
      exitCode: err ? 1 : 0 });
  }));
}
// 在远端跑一条命令(复用 master),追踪远端 cwd
function sshRun(ws, sess, id, command) {
  const cwd = sess.ssh.cwd || "";
  const script = `${cwd ? `cd ${JSON.stringify(cwd)} 2>/dev/null; ` : ""}${command}\n__ec=$?; printf '\\0%s\\0%s' "$PWD" "$__ec"`;
  execFile("ssh", sshCtl(id, sess.ssh, [sess.ssh.target, script]), { timeout: 30000, maxBuffer: 4 << 20, env: safeEnv() }, (err, stdout, stderr) => {
    let output = stdout || "", newCwd = sess.ssh.cwd, ec = err?.code ?? 0;
    const parts = output.split("\0");
    if (parts.length >= 3) { output = parts[0]; newCwd = parts[1].trim() || newCwd; ec = Number(parts[2]) || 0; }
    if (stderr) output += stderr;
    if (err && err.killed) output += `\n${tr("[命令超时,已终止]")}`;
    // master 掉线检测
    if (/Control socket connect|Connection closed|not exist|Broken pipe|Connection refused/i.test(stderr || "")) {
      sess.ssh.status = "disconnected"; persistSsh(id, sess.ssh); sshBroadcast(id, sess.ssh);
    } else sess.ssh.cwd = newCwd;
    send(ws, { type: "terminal_result", sessionId: id, command, cwd: `${sess.ssh.target}:${newCwd || "~"}`, cwdChanged: false, output, exitCode: ec });
  });
}

// ---------- 持久化(f: 跨 session 继承历史) ----------
function loadIndex() {
  let idx;
  try { idx = JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch { return []; }
  // 迁移旧数据:早期 fork 误把 inheritFrom 存成母会话的 sdkSessionId,改回母会话条目 id
  const bySdk = new Map(idx.filter((e) => e.sdkSessionId).map((e) => [e.sdkSessionId, e.id]));
  let dirty = false;
  for (const e of idx) {
    if (e.inheritFrom && bySdk.has(e.inheritFrom)) e.inheritFrom = bySdk.get(e.inheritFrom);
    // 早期把默认标题落盘成字面"新会话",与前端显示的目录名不一致;重启/重装会暴露。愈合成目录名。
    if (e.title === "新会话" && e.cwd) e.title = e.cwd.split("/").filter(Boolean).pop() || e.title;
    // 老会话没落盘 lastUser:从日志回填一次(写回 index,下次不再扫日志)
    if (e.lastUser === undefined) { e.lastUser = lastUserFromLog(e.id); dirty = true; }
    // 数据目录改名(~/.chat-code → ~/.ChatCode)只搬了文件,index 里的 cwd 还指着老路径。
    // 闲聊会话的工作目录就在数据目录里面,不改写就整条失效:spawn 报 ENOENT,而 SDK 会把它
    // 归咎于 claude 可执行文件("native binary … exists but failed to launch"),
    // 用户点「重连」只会一遍遍收到同一句风马牛不相及的报错。改写幂等,只动前缀。
    if (e.cwd?.startsWith(OLD_DATA_DIR + path.sep)) { e.cwd = DATA_DIR + e.cwd.slice(OLD_DATA_DIR.length); dirty = true; }
  }
  if (dirty) saveIndex(idx);
  return idx;
}
function saveIndex(idx) { fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2)); }
function loadGroups() { try { return JSON.parse(fs.readFileSync(GROUPS, "utf8")); } catch { return []; } }
function saveGroups(g) { fs.writeFileSync(GROUPS, JSON.stringify(g, null, 2)); }

// commit 小结水位:记录每个会话「已提交到第几条本轮小结」,下次 commit 只汇总其后的新小结。
const COMMIT_WM = path.join(DATA_DIR, "commit-watermark.json");
function loadCommitWm() { try { return JSON.parse(fs.readFileSync(COMMIT_WM, "utf8")); } catch { return {}; } }
function saveCommitWm(w) { try { fs.writeFileSync(COMMIT_WM, JSON.stringify(w)); } catch {} }
// 追加进系统提示:让 agent 每完成一轮实际任务,就在回复末尾留一句可解析的中文小结(commit 时直接汇总,免二次 LLM)。
const COMMIT_SUMMARY_INSTRUCTION =
  "【提交小结约定】每当你完成用户交办的一轮实际任务(涉及代码/文件改动,或有明确产出)后," +
  "请在该轮回复的最末尾、单独另起一行,输出一句不超过 60 字的中文小结,格式严格为:\n" +
  "本轮小结：<这轮做了什么>\n" +
  "要求:该行必须独占一行且位于整条回复的最后;只有真正完成一轮任务时才输出;" +
  "纯提问、纯解释、被中途打断、或仅做澄清时,不要输出该行;同一条回复里至多一行小结。";
// 追加进系统提示:让 agent 顺手把「用户下一步最可能要我干什么」也写出来,前端解析成一排可点的快捷指令。
// 走主 query 顺带输出,不额外起 LLM 调用 —— agent 刚干完这活,比任何外部模型都清楚下一步是什么。
// 行前缀刻意不叫「本轮小结」:SUMMARY_RE 只认小结,建议行不会被误汇进 commit message。
const NEXT_STEPS_INSTRUCTION =
  "【下一步建议约定】每轮回复结束时,若你能明确判断用户接下来最可能让你做什么," +
  "就在回复末尾单独另起一行(若该轮有「本轮小结」行,则放在小结行**之前**),输出:\n" +
  "本轮建议：<指令1> | <指令2>\n" +
  "要求:1-3 条,用 | 分隔;每条都必须是能原样发给你、你收到后可直接执行的祈使句,不超过 14 字" +
  '(例:"提交并推送"、"修掉第 3 条"、"给这段加测试");' +
  '不要写"要不要…""是否需要…"这类问句,也不要写需要用户补充信息才能执行的模糊指令;' +
  "判断不出明确下一步时,直接不输出这行。";
// 闲聊会话:工作目录是我们后台建的临时空目录(~/.ChatCode/casual/<id>),对用户没有意义。
// 让 agent 别把这个路径暴露/评论出来(不说"当前工作目录 … 不是 git 仓库"之类),就当普通对话。
const CASUAL_INSTRUCTION =
  "【闲聊模式】这是一个不绑定任何项目的闲聊会话,当前工作目录只是后台自动分配的临时空目录,与用户无关。" +
  "不要在回复里提及、展示或评价这个工作目录/路径,也不要说它不是 git 仓库、没有代码之类的话。" +
  "若用户确实需要处理某个项目,再请对方给出该项目的实际路径。";

// 从落盘日志汇总各轮「本轮小结」。容忍模型给行首加了 markdown 强调符。相邻重复只保留一条。
// 只保留「本轮真的改过文件」的小结:一轮里出现过改文件的工具调用(Write/Edit/MultiEdit/NotebookEdit)才算 ——
// 纯提问/解释/诊断那种没动文件的轮次即便留了小结也不汇进 commit 信息(commit 是给"文件改动"配说明的)。
// `\**` 出现在标签两侧各一次:模型写 `**本轮小结**：xxx`(强调只包标签、冒号在外)相当常见,
// 弱一点的模型尤其爱这么写。少认这一种,commit 汇总就整条空掉、悄悄退回"拿用户原话凑"。
const SUMMARY_RE = /^[\s>*#`\-]*本轮小结\**\s*[：:]\**\s*(.+?)\s*\**$/;
const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// agent 自己跑的提交命令(独立成条,躲过 echo "git commit" 这类字符串误伤)
const GIT_COMMIT_RE = /(?:^|&&|\|\||;|\|)\s*git\s+(?:-C\s+\S+\s+)?commit\b/;
// 返回 [{ text, files }]:files 是这一轮改过的文件路径,给 buildCommitMessage 按仓库过滤用
// (同一会话里可能有几轮跑去改了别的项目的代码,那些小结不该混进本仓库的 commit)。
// 条目数 = 小结条数,和以前一致 —— 水位(COMMIT_WM)是按条数存的,口径不能变。
function collectRoundSummaries(id) {
  const out = [];
  let roundChanged = false; // 当前这一轮(自上条真人消息起)有没有改过文件
  let roundCommitted = false; // 这一轮 agent 自己提交过:本轮随后的小结也已进仓库,不收
  let roundFiles = []; // 本轮改过的文件(和 out 里的条目共享引用:轮末再改的文件也算进这一轮)
  for (const msg of readLog(id)) {
    if (msg?.type === "user") {
      // 工具结果也走 type:"user"(带 tool_result),不算新一轮;真人 prompt(字符串或纯 text/image 块)才重置
      const c = msg.message?.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b?.type === "tool_result");
      if (!isToolResult) { roundChanged = false; roundCommitted = false; roundFiles = []; } // 新数组,别 clear:已 push 的条目还引用着旧的
      continue;
    }
    if (msg?.type !== "assistant" || !Array.isArray(msg.message?.content)) continue;
    // 先扫这条里有没有改文件的工具调用(可能和小结在同一条,也可能在本轮更早的消息里)
    for (const b of msg.message.content) {
      if (b?.type === "tool_use" && FILE_EDIT_TOOLS.has(b.name)) {
        roundChanged = true;
        const p = b.input?.file_path ?? b.input?.notebook_path; // NotebookEdit 用的是 notebook_path
        if (typeof p === "string" && p) roundFiles.push(p);
      }
      // agent 中途自己 commit 了:之前汇总的小结都已在这次提交里,清空不再汇进弹窗
      if (b?.type === "tool_use" && b.name === "Bash" && GIT_COMMIT_RE.test(String(b.input?.command ?? ""))) { out.length = 0; roundCommitted = true; }
    }
    if (!roundChanged || roundCommitted) continue; // 本轮还没动过文件 / 已提交过 → 这条里的小结先不收
    const text = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    for (const line of text.split("\n")) {
      const mm = line.match(SUMMARY_RE);
      if (mm) { const s = mm[1].trim(); if (s && out[out.length - 1]?.text !== s) out.push({ text: s, files: roundFiles }); }
    }
  }
  return out;
}
// 会话运行状态(内存态,不落盘):列表左侧图标据此显示 转圈/待审批/完成/空闲。
// running=本轮在跑;waiting=有待批准的授权;done=本次启动后完成过一轮(绿✅);其余空闲(未开/历史)。
function sessionStatus(id) {
  const s = sessions.get(id);
  if (!s) return "idle";
  if (s.running) return "running";
  if (s.activePermission || s.permissionQueue?.length) return "waiting";
  if (s.freshDone) return "done";
  return "idle";
}
function indexWithStatus() {
  return loadIndex().map((e) => ({ ...e, status: sessionStatus(e.id) }));
}
// 会话列表 + 分组一起广播给所有客户端(索引/顺序/分组/运行状态任一变化都走这里)
function broadcastIndex() {
  const payload = JSON.stringify({ type: "index", sessions: indexWithStatus(), groups: loadGroups() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}
// 把顶级会话移到 groupId(null=移出),插到 beforeId 之前(null=该组末尾)。与前端 applyMove 语义一致。
function moveSessionInIndex(idx, sessionId, groupId, beforeId) {
  const i = idx.findIndex((e) => e.id === sessionId);
  if (i < 0) return idx;
  const [entry] = idx.splice(i, 1);
  entry.groupId = groupId ?? null;
  const isRoot = (e) => !e.inheritFrom || !idx.some((p) => p.id === e.inheritFrom);
  let j = beforeId ? idx.findIndex((e) => e.id === beforeId) : -1;
  if (j < 0) {
    let last = -1;
    for (let k = 0; k < idx.length; k++) if ((idx[k].groupId ?? null) === (groupId ?? null) && isRoot(idx[k])) last = k;
    j = last < 0 ? idx.length : last + 1;
  }
  idx.splice(j, 0, entry);
  return idx;
}
// 日志只为"重开会话时回放"存在,前端回放用不上的一律不落盘 —— 存了既撑大文件,
// 回放时还要为每条走一遍 handleSdkMessage + dispatch。
//
// system 走白名单:前端(store.tsx 的 handleSdkMessage)只认这四种子类型,其余(hook_started /
// hook_response / task_* / thinking_tokens / api_retry …)回放时一个分支都不匹配,纯噪音。
// ⚠️ 前端新加 system 子类型的处理时,记得同步加进这里,否则历史里翻不到。
const KEEP_SYSTEM = new Set(["init", "status", "compact_boundary", "background_tasks_changed"]);
function keepInLog(msg) {
  if (msg?.type === "stream_event") return false;       // 流式增量:只用于实时显示,存了回放还会重复一遍
  if (msg?.type !== "system") return true;
  return KEEP_SYSTEM.has(msg.subtype);
}
// tool_use_result 是 SDK 附在 user 消息顶层的结构化结果,与 message.content 里的 tool_result 并存。
// 前端从来不读它(全仓库零命中),而 Edit 这类工具会把**整份文件原文** + patch 塞进来 ——
// 老日志里它一个字段就占了三分之二体积。落盘时丢掉。
function stripForLog(msg) {
  const m = externalizeImages(msg);
  if (m?.tool_use_result === undefined) return m;
  const { tool_use_result, ...rest } = m;
  return rest;
}
function appendLog(id, msg) {
  if (!keepInLog(msg)) return;
  // 补落盘时间:SDK 回的 assistant/tool_result 自己不带 timestamp,搜索结果就显示不出发送时间
  if (!msg.timestamp) msg = { ...msg, timestamp: new Date().toISOString() };
  fs.appendFileSync(path.join(SESS_DIR, `${id}.jsonl`), JSON.stringify(stripForLog(msg)) + "\n");
}
// ---------- 图片外置(blob) ----------
// 贴进来的截图动辄几 MB,base64 直接写进 JSONL 会让日志滚到几百 MB:重开会话时整份要读盘、
// 解析、走 WebSocket、前端再 parse —— 加载卡十秒的另一半就是它。而桌面气泡里只显示一个
// "图片N" 标签,hover 才出预览、点击才开大图,99% 的时间根本用不到图片数据。
// 所以落盘时把 base64 抽到 blobs/<sha1>,日志里只留引用;要看图时前端按 key 现取(blob_get)。
// 按内容 hash 存 = 天然去重,同一张图贴多少次都只占一份磁盘。
const BLOB_DIR = path.join(DATA_DIR, "blobs");
const isBlobRef = (b) => b?.type === "image" && b.source?.type === "cc_blob";
const isInlineImg = (b) => b?.type === "image" && b.source?.type === "base64";

function blobPut(b64) {
  const key = crypto.createHash("sha1").update(b64).digest("hex");
  const file = path.join(BLOB_DIR, key);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(BLOB_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
  }
  return key;
}
function blobGet(key) {
  // key 来自前端,拼进路径前必须校死:只认 40 位十六进制,杜绝 ../ 穿越读到任意文件
  if (!/^[a-f0-9]{40}$/.test(String(key || ""))) return null;
  try { return fs.readFileSync(path.join(BLOB_DIR, key)).toString("base64"); } catch { return null; }
}
// 落盘前把内联图换成引用。只动 user 消息的 image 块,其余原样。
function externalizeImages(m) {
  const c = m?.message?.content;
  if (!Array.isArray(c) || !c.some(isInlineImg)) return m;
  const content = c.map((b) => {
    if (!isInlineImg(b)) return b;
    try {
      return { ...b, source: { type: "cc_blob", media_type: b.source.media_type, key: blobPut(b.source.data), bytes: b.source.data.length } };
    } catch { return b; } // 写盘失败(磁盘满/权限):照原样内联落盘,宁可日志大也别把图弄丢
  });
  return { ...m, message: { ...m.message, content } };
}
// 还原成内联图。手机端历史(shrinkImages)和迁移校验要用;桌面端不走这条。
function inlineImages(m) {
  const c = m?.message?.content;
  if (!Array.isArray(c) || !c.some(isBlobRef)) return m;
  const content = c.map((b) => {
    if (!isBlobRef(b)) return b;
    const data = blobGet(b.source.key);
    return data ? { ...b, source: { type: "base64", media_type: b.source.media_type, data } } : b;
  });
  return { ...m, message: { ...m.message, content } };
}

function readLog(id) {
  try {
    const log = fs.readFileSync(path.join(SESS_DIR, `${id}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // 老日志里 SDK 回吐的 assistant/tool_result 没有 timestamp(appendLog 统一补时间是后加的)。
    // 缺一条就够坏事:前端 nextTs 见没时间就退回 Date.now(),把游标顶到"现在",于是它后面
    // 每一条真实时间戳都比游标早、全被顶成"现在+k" —— 整段历史的日期被冲平,只剩时分。
    // 就近借相邻消息的时间补上:先向前借(取前面最近一条),开头那截没得借的再向后借。
    let t;
    for (const m of log) { if (m?.timestamp) t = m.timestamp; else if (t && m) m.timestamp = t; }
    t = undefined;
    for (let i = log.length - 1; i >= 0; i--) { const m = log[i]; if (m?.timestamp) t = m.timestamp; else if (t && m) m.timestamp = t; }
    return log;
  } catch { return []; }
}
// 从落盘日志取最新一条用户消息文本(给列表副标题;老会话没存 lastUser 时回填用)
function lastUserFromLog(id) {
  const log = readLog(id);
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type !== "user") continue;
    const c = msg.message?.content;
    if (typeof c === "string") { const t = c.trim(); if (t) return t; continue; }
    if (Array.isArray(c)) {
      const t = c.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (t) return t;
      if (c.some((b) => b.type === "image")) return "[图片]";
    }
  }
  return "";
}
// 从落盘日志取最近若干条「用户任务」文本(给 commit 自动总结当线索)。时间正序返回。
// 只要用户真正下达的任务:跳过纯工具结果、空消息、以及 /compact 之类的斜杠命令。
function recentUserTasksFromLog(id, limit = 8) {
  const log = readLog(id);
  const tasks = [];
  for (let i = log.length - 1; i >= 0 && tasks.length < limit; i--) {
    const msg = log[i];
    if (msg?.type !== "user") continue;
    const c = msg.message?.content;
    let t = "";
    if (typeof c === "string") t = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b.type === "tool_result")) continue; // 纯工具结果不是用户任务
      t = c.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    }
    t = t.trim();
    if (!t || t.startsWith("/")) continue;
    tasks.push(t.slice(0, 300)); // 单条截断,防止某次超长输入把 prompt 撑爆
  }
  return tasks.reverse();
}

// 手机端历史:按"气泡"取最近 N 个,并剥掉重内容。
// 手机一条消息 = 一个气泡:user 一泡;连续的 assistant 归为一个 agent 泡(工具/思考收进该泡的"工作过程")。
// 之前 limit 切的是原始 SDK 消息(thinking/tool_use/tool_result/system 各算一条),一个回合能拆十几条,
// 最近 10 条原始消息 ≈ 1 个气泡,所以手机只看到一条。改成按气泡切。
// 同时剥掉重内容:工具入参(可能是整份文件)、tool_result 正文、thinking —— 这些是"点开气泡才看的详情",
// 列表阶段不传,既修气泡数量又大幅缩小 payload(避免大会话卡死/OOM)。
function bubbleRole(m) {
  // 复刻手机 extractLines 的角色判断:返回该消息属于 'user' / 'agent'(含工具/note) / null(不显示)
  if (!m) return null;
  if (m.type === "user") {
    const c = m.message?.content;
    if (typeof c === "string") return c ? "user" : null;
    if (Array.isArray(c)) {
      const hasBubble = c.some((b) => b?.type === "text" || isInlineImg(b) || isBlobRef(b));
      return hasBubble ? "user" : null; // 纯 tool_result 的 user 消息不成泡
    }
    return null;
  }
  if (m.type === "assistant") {
    const c = m.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "text" || b?.type === "tool_use")) return "agent";
    return null;
  }
  if (m.type === "result" && m.subtype && m.subtype !== "success") return "agent";
  if (m.type === "system_note" || m.type === "session_error") return "agent";
  return null;
}
function trimHeavy(m) {
  if (m.type === "assistant" && Array.isArray(m.message?.content)) {
    const content = m.message.content
      .filter((b) => b.type === "text" || b.type === "tool_use") // 丢 thinking
      .map((b) => (b.type === "tool_use" ? { ...b, input: {} } : b)); // 去掉工具入参(可能是整份文件内容)
    return { ...m, message: { ...m.message, content } };
  }
  return m; // user(含图片)、note 类原样保留
}
// 手机端历史里的图片转缩略图。手机气泡里就显示这么一张小图,把几 MB 的原图推过跨境链路纯属浪费 ——
// 进会话慢的大头就是它。用 macOS 自带的 sips 转 512px JPEG(ChatCode 只打 macOS 包),不引任何图形库;
// 按内容 hash 缓存,同一张图重开多少次会话都只转一次。桌面端不走这条路,拿的仍是原图。
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
const THUMB_PX = 512;
const THUMB_MIN = 64 * 1024; // base64 比这还小的本来就不占带宽,原样发

async function thumbFor(b64, mediaType) {
  const orig = { media_type: mediaType, data: b64 };
  if (!b64 || b64.length < THUMB_MIN || process.platform !== "darwin") return orig;
  const key = crypto.createHash("sha1").update(b64).digest("hex").slice(0, 16);
  const out = path.join(THUMB_DIR, `${key}.jpg`);
  const src = path.join(THUMB_DIR, `${key}.src`);
  try {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    if (!fs.existsSync(out)) {
      fs.writeFileSync(src, Buffer.from(b64, "base64"));
      await new Promise((res, rej) =>
        execFile("sips", ["-s", "format", "jpeg", "-Z", String(THUMB_PX), src, "--out", out], { timeout: 15000, env: safeEnv() }, (e) => (e ? rej(e) : res())));
    }
    const data = fs.readFileSync(out).toString("base64");
    return data.length < b64.length ? { media_type: "image/jpeg", data } : orig; // 转完反而更大(小图/已压过):用原图
  } catch { return orig; } // sips 缺席/图坏了:照原样发,别因为省流量把图弄没
  finally { try { fs.unlinkSync(src); } catch {} }
}

async function shrinkImages(m0) {
  // 日志里现在存的是 blob 引用,先还原成内联再压 —— 手机端够不着本机 blobs 目录,必须把数据塞进消息里
  const m = inlineImages(m0);
  const c = m?.message?.content;
  if (m?.type !== "user" || !Array.isArray(c)) return m;
  if (!c.some(isInlineImg)) return m;
  const content = await Promise.all(c.map(async (b) => {
    if (!isInlineImg(b)) return b;
    const t = await thumbFor(b.source.data, b.source.media_type);
    return { ...b, source: { ...b.source, media_type: t.media_type, data: t.data } };
  }));
  return { ...m, message: { ...m.message, content } };
}

// 缩略图缓存只涨不降,启动时清一次 30 天前的
setTimeout(() => {
  try {
    const cutoff = Date.now() - 30 * 86400_000;
    for (const f of fs.readdirSync(THUMB_DIR))
      if (fs.statSync(path.join(THUMB_DIR, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(THUMB_DIR, f));
  } catch {}
}, 5000);

// 老日志里可能已写进 SDK 回吐的图片占位("[Image: original …]" 纯文本),回放时丢掉,别再露出来。
const isCaptionEcho = (msg) => msg?.type === "user" && Array.isArray(msg.message?.content)
  && msg.message.content.some((b) => b.type === "text" && /^\[Image: original .*to original image/.test(b.text || ""))
  && !msg.message.content.some((b) => b.type === "image" || b.type === "tool_result");

async function buildMobileHistory(log, limit) {
  const bubbles = []; // { kind, msgs:[] }
  for (const m of log) {
    const role = bubbleRole(m);
    if (!role) continue; // tool_result / system / rate_limit 等不成泡,直接丢
    if (role === "user") { bubbles.push({ kind: "user", msgs: [m] }); continue; }
    let last = bubbles[bubbles.length - 1];
    if (!last || last.kind !== "agent") { last = { kind: "agent", msgs: [] }; bubbles.push(last); }
    last.msgs.push(m);
  }
  return Promise.all(bubbles.slice(-limit).flatMap((b) => b.msgs).map(trimHeavy).map(shrinkImages));
}

// ---------- 对话检索 / Git 项目状态 ----------
function searchText(msg) {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.map((b) => {
    if (b.type === "text") return { kind: msg.type === "assistant" ? "agent" : "user", text: b.text };
    if (b.type === "tool_use") return { kind: "tool", text: `${b.name} ${JSON.stringify(b.input ?? {})}` };
    return null;
  }).filter(Boolean);
}
// 命中片段:关键词往往在正文很靠后的位置,从头截 260 字经常一个字都看不到。
// 这里以命中处为中心开窗,关键词落在窗口左 1/3(后文比前文有用),两端加省略号。
// 前置量只留 24 字:结果行是两行截断(CSS -webkit-line-clamp:2),命中往前挪 1/3 个窗口(约 79 字)
// 就被挤到第三行,那一行看不到关键词。
const SNIP = 240, LEAD = 24;
function snippet(text, at) {
  const start = Math.max(0, at - LEAD);
  const end = start + SNIP;
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
// kind: "all" | "user" | "agent"(含它发起的工具调用)
function findMessages(query, sessionId, kind) {
  const q = String(query || "").trim().toLocaleLowerCase();
  if (!q) return [];
  const out = [];
  for (const entry of loadIndex()) {
    if (sessionId && entry.id !== sessionId) continue;
    // 只有 ChatCode 自己落盘的 user 消息带 timestamp(见 appendLog),SDK 回的 assistant/tool_result 没有。
    // 新日志已在 appendLog 统一补上;老日志退回"同一轮里最近一条带时间的消息",精度到一轮,够用。
    let lastTs;
    for (const msg of readLog(entry.id)) {
      if (msg.timestamp) lastTs = msg.timestamp;
      for (const part of searchText(msg)) {
        if (kind === "user" ? part.kind !== "user" : kind === "agent" ? part.kind === "user" : false) continue;
        const text = part.text.replace(/\s+/g, " ").trim();
        const at = text.toLocaleLowerCase().indexOf(q);
        if (at < 0) continue;
        out.push({ sessionId: entry.id, title: entry.title, kind: part.kind, text: snippet(text, at), ts: msg.timestamp || lastTs });
        if (out.length >= 100) return out;
      }
    }
  }
  return out;
}
// 把 ssh 原始 stderr(含 @@@ banner)映射成简短可读的中文提示
function sshErrHint(raw, keyPath) {
  const s = String(raw || "");
  const perm = s.match(/Permissions (\d{4})/);
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(s))
    return tr("私钥权限过于开放{{perm}},运行 chmod 600 {{path}}", { perm: perm ? `(${perm[1]})` : "", path: keyPath || tr("<私钥路径>") });
  if (/Permission denied|publickey/i.test(s)) return tr("认证被拒:公钥未加入服务器 authorized_keys,或用户名不对");
  if (/Connection refused/i.test(s)) return tr("连接被拒:检查主机地址与端口,以及 SSH 服务是否运行");
  if (/Connection timed out|Operation timed out|timed out/i.test(s)) return tr("连接超时:检查网络或主机是否可达");
  if (/Could not resolve hostname|Name or service not known/i.test(s)) return tr("无法解析主机名:检查地址拼写");
  if (/No such file|Identity file.*not accessible/i.test(s)) return tr("找不到私钥文件:{{path}}", { path: keyPath || "" });
  if (/Host key verification failed/i.test(s)) return tr("主机密钥校验失败:known_hosts 中的指纹与服务器不符");
  // 兜底:去掉 @@@ banner 行,取首条有效信息
  const line = s.split("\n").map((l) => l.trim())
    .find((l) => l && !/^@+$/.test(l) && !/WARNING:|IT IS (POSSIBLE|REQUIRED)|someone|offending|add correct/i.test(l));
  return (line || tr("连接失败")).slice(0, 160);
}
// timeout:默认 12s(面板类查询可以慢慢等);挡在用户消息前面的调用要自己传短值,别让人干等。
function execOut(bin, args, cwd, env, timeout = 12000) {
  return new Promise((resolve) => execFile(bin, args, { cwd, timeout, maxBuffer: 2 << 20, env: safeEnv(env) }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), err })));
}
// 后台节流 fetch:upstream:track 只反映上次 fetch 到的 remote ref,不刷新就永远"已同步"。
// 每仓库最多 30s fetch 一次,不阻塞 git_info(下一轮 15s 轮询就能读到新 ahead/behind)。
// GIT_TERMINAL_PROMPT=0:需要认证的私库直接快速失败,不弹交互卡死。
const lastFetch = new Map();
function maybeFetch(repo) {
  const now = Date.now();
  if (now - (lastFetch.get(repo) || 0) < 30000) return;
  lastFetch.set(repo, now);
  // --prune:远端已删的分支,本地 refs/remotes 会一直留着(git fetch 默认不删),
  // 分支页的"远程 N"就比 GitHub 上多出一堆早已删掉的分支。
  execOut("git", ["fetch", "--quiet", "--prune"], repo, { GIT_TERMINAL_PROMPT: "0" });
}
function trackCounts(track = "") {
  const ahead = Number((track.match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((track.match(/behind (\d+)/) || [])[1] || 0);
  // "[gone]" = 配了上游、但远程那条分支已经没了(PR 合并后自动删是最常见的)。
  // 它不带 ahead/behind 数字,不单独标出来就会显示成 ↑0 ↓0,和"已同步"长得一模一样。
  return { ahead, behind, gone: /\bgone\b/.test(track) };
}
// 各类 git_* / terminal_command 的工作目录解析。
// HOME_SID 前缀:首页选好目录、还没建会话时也要能看分支页,那边拿 "home:<绝对路径>" 当会话 id 发同样的请求,
// 路径直接编在 id 里(前端 store 的 state.git 本来就按会话 id 存,这样一行不用改)。真会话 id 走原来的解析。
const HOME_SID = "home:";
function resolveCwd(sessionId) {
  if (typeof sessionId === "string" && sessionId.startsWith(HOME_SID)) return sessionId.slice(HOME_SID.length);
  const sess = sessions.get(sessionId);
  return sess?.termCwd || loadIndex().find((e) => e.id === sessionId)?.cwd || os.homedir();
}
async function gitInfo(cwd, sessionId) {
  const root = await execOut("git", ["rev-parse", "--show-toplevel"], cwd);
  const github = await ghInfo(cwd);
  if (!root.ok) return { cwd, isRepo: false, local: [], remote: [], remotes: [], github, runtime: await runtimeInfo(cwd, sessionId) };
  const repo = root.stdout.trim();
  maybeFetch(repo); // 后台刷新 remote-tracking ref,让顶部 领先/落后 计数不至于长期过期
  const [current, status, locals, remote, remotesV, runtime] = await Promise.all([
    // --no-optional-locks:status 默认会把刷新后的索引写回去,要抢 .git/index.lock。这是 15s 一轮的后台轮询,
    // 撞上用户正在跑的 git add/commit 就让对方报 "index.lock: File exists"。只读轮询不需要那把锁。
    execOut("git", ["branch", "--show-current"], repo), execOut("git", ["--no-optional-locks", "status", "--short"], repo),
    execOut("git", ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(objectname:short)", "refs/heads"], repo),
    execOut("git", ["for-each-ref", "--format=%(refname:short)\t%(objectname:short)\t%(authorname)", "refs/remotes"], repo),
    // `git remote -v` 一条顶原来的 `git remote` + `git remote get-url origin` 两条:名字和 url 一起给。
    // 每个远端两行(fetch/push),push 行在后、直接覆盖 —— 界面上那个地址回答的是"推到哪",按 push url 取才对。
    execOut("git", ["remote", "-v"], repo), runtimeInfo(repo, sessionId),
  ]);
  const urlByRemote = new Map(remotesV.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, rest] = line.split("\t");
    return [name, (rest || "").replace(/\s+\((fetch|push)\)$/, "")];
  }));
  const remoteRows = remote.stdout.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const shaByRemote = new Map(remoteRows.map(([name, sha]) => [name, sha]));
  const authorByRemote = new Map(remoteRows.map(([name, , author]) => [name, author]));
  const local = locals.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, upstream, track, sha] = line.split("\t");
    return { name, upstream: upstream || undefined, sha, upstreamSha: upstream ? shaByRemote.get(upstream) : undefined,
      upstreamAuthor: upstream ? authorByRemote.get(upstream) || undefined : undefined, ...trackCounts(track) };
  });
  const curName = current.stdout.trim();
  const cur = local.find((b) => b.name === curName);
  // 顺手喂给 gitBrief 的缓存:面板每 15s 就跑一次这条 status,发消息那一刻没必要再扫一遍工作树。
  {
    const marks = [cur?.ahead && `ahead ${cur.ahead}`, cur?.behind && `behind ${cur.behind}`, cur?.gone && "gone"].filter(Boolean);
    cacheStatus(repo, cur?.sha, curName + (cur?.upstream ? `...${cur.upstream}` : "") + (marks.length ? ` [${marks.join(", ")}]` : ""),
      status.stdout.split("\n").filter(Boolean));
  }
  // 提交拓扑顶上那行仓库地址跟着**当前分支的上游**走。钉死 origin 在多远端仓库里会张冠李戴:
  // 站在上游是 private/cloud 的分支上,却挂着 origin 的 url,等于告诉用户这些提交推去了另一个仓库。
  // 没上游(新分支/detached)再退回 origin,还没有就取第一个远端。
  const urlRemote = cur?.upstream?.split("/")[0];
  return { cwd, isRepo: true, root: repo, current: curName, status: status.stdout.trim(), local,
    // 远程跟踪分支必含 "remote/branch" 的斜杠;origin/HEAD 的短名会塌成裸 "origin"(远程名,非分支),用斜杠过滤掉
    remote: remoteRows.map(([name]) => name).filter((x) => x && x.includes("/") && !/\/HEAD$/.test(x)), remotes: [...urlByRemote.keys()],
    // 每个远程跟踪分支的 sha。界面判断"这条还有东西可推吗"要用:git 只给 upstream 算 ahead/behind,
    // 同名撞上的非上游远端(oss → private/oss)一个数都没有,只能拿 sha 和本地 head 比。
    remoteSha: Object.fromEntries(shaByRemote),
    // 每个远端的 url。拓扑区的仓库切换器切到哪个远端,地址行就得跟着换 —— 只给一条 remoteUrl 的话,
    // 切到 private 还挂着 origin 的地址,等于告诉用户这些提交推去了另一个仓库。
    remoteUrls: Object.fromEntries(urlByRemote),
    remoteUrl: (urlRemote && urlByRemote.get(urlRemote)) || urlByRemote.get("origin") || [...urlByRemote.values()][0], github, runtime };
}
// 分支 Tab 的提交拓扑图数据:全部分支的提交(含 parents,供前端画分叉线)+ 各分支头(全长 sha,和 %H 对齐)。
async function gitLog(cwd, limit = 80) {
  const root = await execOut("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) return { commits: [], heads: [] };
  const repo = root.stdout.trim();
  const [log, heads] = await Promise.all([
    execOut("git", ["log", "--all", "--date-order", `-n${limit}`, "--format=%H\t%P\t%an\t%aI\t%s"], repo),
    // 用全名 %(refname) 判本地/远程:refs/remotes/ 前缀 = 远程跟踪引用(不靠名字有无斜杠猜,feature/x 也带斜杠)
    execOut("git", ["for-each-ref", "--format=%(refname)\t%(objectname)", "refs/heads", "refs/remotes"], repo),
  ]);
  const commits = log.stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, parents, author, date, ...rest] = line.split("\t");
    return { hash, parents: (parents || "").split(" ").filter(Boolean), author, date, subject: rest.join("\t") };
  });
  const headRows = heads.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"))
    .map(([ref, sha]) => ({ name: ref.replace(/^refs\/(heads|remotes)\//, ""), sha, remote: ref.startsWith("refs/remotes/") }))
    .filter(({ name }) => name && !/\/HEAD$/.test(name) && name !== "origin");
  return { commits, heads: headRows };
}

// 两 ref 对比:左右各独有提交数 + 逐文件 +n/-n(三点 = 相对共同祖先,分支对比语义)。
async function gitDiff(cwd, from, to) {
  const root = await execOut("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) return { from, to, ahead: 0, behind: 0, files: [] };
  const repo = root.stdout.trim();
  const [counts, numstat] = await Promise.all([
    execOut("git", ["rev-list", "--left-right", "--count", `${from}...${to}`], repo),
    execOut("git", ["diff", "--numstat", `${from}...${to}`], repo),
  ]);
  const [left, right] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  const files = numstat.stdout.split("\n").filter(Boolean).map((line) => {
    const [add, del, ...name] = line.split("\t");
    return { file: name.join("\t"), add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) }; // "-" = 二进制
  });
  return { from, to, ahead: left, behind: right, files, error: counts.ok ? undefined : counts.stderr.trim().slice(0, 200) };
}

// 每轮随用户消息注入的系统上下文,统一走这里去重。
// 为什么必须去重:SDK query 是长驻的,每轮 push 的 user 消息全部留在上下文里。同一类 note 每轮重发,
// 到第 20 轮就堆了 20 份自相矛盾的旧快照(早期那份说"3 处未提交",最新那份说"干净"),
// 模型完全可能引用过时的那一份 —— 这正是本功能要治的病。顺带每轮几百 token 也白烧。
// 内容没变就发一句极短的"同上轮":让"没变"是显式事实,而不是让模型从"这轮没提"里猜。
function noteOnChange(sess, kind, key, full, unchanged) {
  if (!sess.notes) sess.notes = new Map();
  const prev = sess.notes.get(kind);
  sess.notes.set(kind, key);
  return prev === key ? unchanged : full;
}

// gitBrief 的 status 缓存。存的是 `status --short` 那份行数组 + 当时的 HEAD sha。
const STATUS_TTL = 30000;
const statusCache = new Map(); // repo -> { at, sha, head, files }
function cacheStatus(repo, sha, head, files) { statusCache.set(repo, { at: Date.now(), sha, head, files }); }

// 每轮随用户消息注入的本地 git 现状(分支/未推送数/工作区改动/最近提交)。
// 为什么要:用户常在别的窗口、别的会话里手动 commit / push / 切分支,agent 只按"自己做过什么"推断,
// 就会说出"还有 3 个未提交改动,一起推吗"这种早已过时的话。
// 为什么不放 systemPrompt:那是 prompt 缓存的最前缀,内容一变整段缓存全废;
// per-message 注入只出现在当前这条新消息里,历史前缀原样命中。
// --no-optional-locks:只读,不去抢 .git/index.lock(用户可能正手动 git add)。
// 超时给得短:这段挡在"用户按回车"和"agent 开跑"之间,读不到宁可不注入,也不能让人干等。
async function gitBrief(cwd, sess) {
  const root = await execOut("git", ["rev-parse", "--show-toplevel"], cwd, null, 3000);
  if (!root.ok) return null;
  const repo = root.stdout.trim();
  // log 每轮都真跑:只读 refs,不扫工作树,几毫秒。顺带拿 HEAD sha 给缓存做新鲜度校验 ——
  // 光靠 TTL 会漏掉"用户刚手动 commit 完就来问"这个正是要治的场景,HEAD 一变就强制重扫。
  const log = await execOut("git", ["log", "-8", "--format=%h %ad %an: %s", "--date=format:%m-%d %H:%M"], repo, null, 3000);
  const commits = log.stdout.trim();
  const headSha = (commits.split("\n")[0] || "").split(" ")[0];
  const short = (s) => String(s || "").slice(0, 7);
  let st = statusCache.get(repo);
  if (!st || Date.now() - st.at > STATUS_TTL || (headSha && short(st.sha) !== short(headSha))) {
    const sb = await execOut("git", ["--no-optional-locks", "status", "-sb", "--porcelain"], repo, null, 2500);
    if (!sb.ok) return null;
    const lines = sb.stdout.split("\n").filter(Boolean);
    cacheStatus(repo, headSha, (lines[0] || "").replace(/^## /, ""), lines.slice(1)); // 首行 "## main...origin/main [ahead 1]"
    st = statusCache.get(repo);
  }
  // 只在改动不多时列文件名。多了只给数:我们的目的是纠正它对"提交/推送状态"的错误记忆,
  // 不是替它执行 git —— 真要看是哪些文件,它自己跑一条 status 就有,没必要每轮塞几千 token 进去。
  const staged = st.files.filter((l) => l[0] && l[0] !== " " && l[0] !== "?").length;
  const work = !st.files.length ? "干净(无未提交改动)"
    : `${st.files.length} 处改动${staged ? `(其中 ${staged} 处已暂存)` : ""}`
      + (st.files.length <= 10 ? `\n${st.files.join("\n")}` : "(要看具体是哪些文件,自己跑 git status)");
  const full = `[系统提示·本地 Git 现状(本轮实时读取)] ${repo}\n`
    + `分支:${st.head || "(未知)"}\n工作区:${work}\n最近提交:\n${commits || "(无提交)"}\n`
    + "判断「是否已提交/已推送/有无未提交改动」一律以上面这份为准 —— 用户可能在本会话之外手动操作过,不要凭对话记忆推断。";
  return noteOnChange(sess, "git", `${repo}|${st.head}|${st.files.join("\n")}|${commits}`, full,
    "[系统提示·本地 Git] 与上一轮完全相同:分支、工作区、提交历史均无变化,仍以上一轮那份为准。");
}

// 单文件在两 ref 间的 patch 正文(三点语义,和 gitDiff 的文件列表一致)。独立窗口点文件时按需拉,不走终端。
async function gitFileDiff(cwd, from, to, file) {
  const root = await execOut("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) return { from, to, file, patch: "", error: "非 git 仓库" };
  // -U999999 = 全文上下文:diff 里带上整份文件,而非只有改动的几行片段(用户要看完整文件)。
  // 但 package-lock.json 这种上万行的文件,全文会让 diff2html 吐出上万行 DOM,弹窗直接卡死 ——
  // 超过 CLIP_LINES 就重跑一次 git 默认的 3 行上下文,前端标注「已截断」。
  //   实测 package-lock.json 一次 npm install:全文 8089 行 → -U3 844 行。
  // ponytail: 上限是「改动本身就上万行」(整份生成文件被重写),-U3 也救不了,那时才谈虚拟滚动。
  // to === "WORKTREE":工作区未提交改动(HEAD vs 工作区),两点语义;否则两 ref 三点对比
  const CLIP_LINES = 2000;
  const run = (ctx) => execOut("git", to === "WORKTREE"
    ? ["diff", ctx, from, "--", file]
    : ["diff", ctx, `${from}...${to}`, "--", file], root.stdout.trim());
  let r = await run("-U999999");
  let clipped = false;
  if (r.ok && countLines(r.stdout) > CLIP_LINES) {
    const narrow = await run("-U3");
    if (narrow.ok) { r = narrow; clipped = true; }
  }
  return { from, to, file, patch: r.stdout, clipped, error: r.ok ? undefined : r.stderr.trim().slice(0, 200) };
}
// 只数换行,不 split —— 十几万行的 patch 切成数组光分配就够慢的。
function countLines(s) {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

// 仓库根:会话 cwd 可能是子目录,按 cwd 前缀判断会漏掉同仓库另一个目录下的改动。非 git 仓库就用 cwd 兜底。
async function repoRoot(cwd) {
  const r = await execOut("git", ["rev-parse", "--show-toplevel"], cwd);
  return realpath(r.ok ? r.stdout.trim() : cwd);
}
// macOS 上 /tmp、/var 是符号链接:rev-parse 给的是真实路径,工具日志里的路径可能不是,不解析就永远匹配不上。
// 文件可能已被删掉(realpathSync 直接抛) —— 退到还在的祖先目录上解,再把剩下那截拼回去。
function realpath(p) {
  try { return fs.realpathSync(p); } catch {}
  const up = path.dirname(p);
  return up === p ? p : path.join(realpath(up), path.basename(p));
}
function underRoot(file, cwd, root) {
  const a = realpath(path.resolve(cwd, file)); // 相对路径极少见,按会话 cwd 解
  return a === root || a.startsWith(root + path.sep);
}
// commit 信息 = 汇总各轮 AI 已写好的「本轮小结」(距上次提交的部分)。纯文本处理,不再跑一次 LLM。
// force=true 时忽略水位,汇总本会话全部小结(手动「重新汇总」)。都没有小结时回退到最近用户任务清单。
async function buildCommitMessage(cwd, id, force) {
  const all = collectRoundSummaries(id);
  // 水位是条数计数:agent 自己提交后旧小结被丢弃、总数变少,旧水位可能比总数还大 —— 失效就从头算,别一刀切没
  // (过滤放在 slice 之后:水位存的是「全部小结」里的位置,先过滤会让下标对不上)
  const wm = loadCommitWm()[id] || 0;
  const from = force || wm > all.length ? 0 : wm;
  const root = await repoRoot(cwd);
  // 只留改动落在本仓库里的轮次:一轮同时改了本仓库和别的项目也留(确有本仓库的改动)。
  // files 为空 = 拿不到路径(旧日志/新工具),判断不了就别扔。
  const pending = all.slice(from)
    .filter((e) => !e.files.length || e.files.some((f) => underRoot(f, cwd, root)))
    .map((e) => e.text);
  if (pending.length) return pending.length === 1 ? pending[0] : pending.map((s) => `- ${s}`).join("\n");
  // 兜底:旧会话没留小结 / 本轮无产出 —— 用最近几条用户任务凑一条,仍然不调 AI
  const tasks = recentUserTasksFromLog(id).slice(-5);
  return tasks.length ? tasks.join("；") : "";
}

// 纯交互式 shell:cwd 命中只是因为用户在这个目录开了个终端,不是"会话跑起来的进程",
// 列出来只会淹没真正想找的那个,而且误杀掉是用户自己的终端。
const SHELL_NAMES = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish", "login"]);

async function runtimeInfo(cwd, sessionId) {
  const [processes, listeners, cwds, docker] = await Promise.all([
    execOut("ps", ["-axo", "pid=,ppid=,etime=,command="], cwd), // ppid 用来剔掉本进程的子孙(见下)
    execOut("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], cwd),
    // 按进程**真正的工作目录**认领,不能只看命令行文本:后台起的 `npm run dev` 命令行里
    // 根本没有项目路径,光比 command 就整个漏掉 —— 这就是"会话进程(0)"却明明有后台任务在跑的原因。
    // -Fpn 输出是 p<pid> / fcwd / n<path> 三行一组;全用户扫一遍约 0.2s,和另外两条并发跑。
    execOut("lsof", ["-u", String(process.getuid?.() ?? ""), "-a", "-d", "cwd", "-Fpn"], cwd),
    dockerContainers(cwd),
  ]);
  // lsof 报的是解析完符号链接的真实路径(macOS 上 /tmp → /private/tmp),cwd 得先拉平再比,
  // 否则整条链路看着都对、就是一个也匹配不上。realpath 失败(目录没了)就退回原值。
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* 目录已不在,按原值比 */ }
  const inCwd = new Set();
  let curPid = null;
  for (const line of cwds.stdout.split("\n")) {
    if (line[0] === "p") curPid = line.slice(1);
    else if (line[0] === "n" && curPid) {
      const p = line.slice(1);
      if (p === real || p.startsWith(`${real}/`)) inCwd.add(curPid); // 子目录也算(构建常在 src-tauri 里跑)
    }
  }
  // 我们自己起的那一坨要剔掉:SDK 的 claude 子进程、以及它拉起的各 MCP server,cwd 全是会话目录,
  // 按 cwd 认领就成了"用户的活跃后台任务" —— 刚聊一句的闲聊会话也报"5 个活跃进程",
  // 还怂恿用户去杀自己的 agent(闲聊目录本就是空临时目录,住户只有这些)。
  // 按进程树认,不按命令行认:凡祖先是本 sidecar 的一律不算。
  const rows0 = processes.stdout.split("\n").map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return null;
    const [, pid, ppid, elapsed, command] = m;
    return { pid, ppid, elapsed, command, name: command.split(/\s+/).slice(0, 2).join(" ") };
  }).filter(Boolean);
  const kids = new Map();
  for (const r of rows0) kids.set(r.ppid, [...(kids.get(r.ppid) || []), r.pid]);
  const mine = new Set();
  for (const queue = [String(process.pid)]; queue.length; ) {
    for (const k of kids.get(queue.pop()) || []) if (!mine.has(k)) { mine.add(k); queue.push(k); }
  }
  const rows = rows0
    .filter((row) => !mine.has(row.pid) && row.pid !== String(process.pid))
    .filter((row) => inCwd.has(row.pid) || row.command.includes(cwd))
    .filter((row) => !SHELL_NAMES.has(row.command.split(/\s+/)[0].split("/").pop()))
    .slice(0, 20);
  const pids = new Set(rows.map((row) => row.pid));
  const ports = listeners.stdout.split("\n").slice(1).map((line) => {
    const cols = line.trim().split(/\s+/); const pid = cols[1]; const name = cols[0]; const address = cols.at(-2) || "";
    const m = address.match(/:(\d+)$/); return m && pids.has(pid) ? { process: name, port: m[1] } : null;
  }).filter(Boolean).slice(0, 12);
  // docker 容器不在本目录进程树里(端口由 Docker VM/后端转发),上面按 cwd/PID 的匹配全漏。并入探到的容器:
  // 容器当"进程"(名字 + Up 状态),其对外发布端口当"监听端口"。
  const procs = rows.map(({ pid, elapsed, name }) => ({ pid, elapsed, name }));
  // agent 自己起的后台任务:上面按 cwd/进程树一个也捞不到(它们是本 sidecar 的子孙,连同 MCP 一起被剔了)。
  // 用 SDK 报的清单补回来 —— 有 owner 有 id,不用猜。停止走 q.stopTask(taskId),不是 kill pid(拿不到 pid)。
  for (const t of sessions.get(sessionId)?.bgTasks ?? [])
    procs.unshift({ pid: `task:${t.task_id}`, task: t.task_id, elapsed: t.task_type || "task", name: t.description || t.task_type || t.task_id });
  for (const c of docker) {
    procs.push({ pid: c.id, elapsed: c.status, name: `🐳 ${c.name}` });
    for (const p of c.ports) ports.push({ process: c.name, port: p });
  }
  return { processes: procs.slice(0, 20), ports: ports.slice(0, 20) };
}
// 探本项目相关的运行中 docker 容器:compose 工作目录落在 cwd 内(或反之同一项目树)的才算。
// docker 没装/守护进程没起时 execOut 静默失败返回空,不影响其余运行时信息。
async function dockerContainers(cwd) {
  const SEP = "\x1f"; // 不可见分隔符,避开端口串里的逗号/空格
  const out = await execOut("docker", ["ps", "--no-trunc", "--format",
    `{{.ID}}${SEP}{{.Names}}${SEP}{{.Label "com.docker.compose.project.working_dir"}}${SEP}{{.Status}}${SEP}{{.Ports}}`], cwd);
  if (!out.ok || !out.stdout.trim()) return [];
  const within = (dir) => dir && (dir === cwd || dir.startsWith(cwd + "/") || cwd.startsWith(dir + "/"));
  const list = [];
  for (const line of out.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, workdir, status, portsStr] = line.split(SEP);
    if (!within(workdir)) continue;
    // "127.0.0.1:8080->80/tcp, :::9000->9000/tcp" → 取对外发布的宿主端口 [8080, 9000]
    const ports = [...new Set([...(portsStr || "").matchAll(/:(\d+)->/g)].map((m) => m[1]))];
    list.push({ id: (id || "").slice(0, 12), name: name || "container", status: status || "", ports });
  }
  return list;
}
async function ghInfo(cwd) {
  const version = await execOut("gh", ["--version"], cwd);
  if (!version.ok) return { installed: false, loggedIn: false, detail: "未安装 gh" };
  // gh 认证可以来自 GH_TOKEN/GITHUB_TOKEN 环境变量,被 safeEnv 挡掉的话这类用户会显示成"未登录"。
  // 只有 gh 自己需要,显式白名单传回(它就是这个 token 的正主,不算外泄)。
  const auth = await execOut("gh", ["auth", "status"], cwd,
    { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN });
  const raw = `${auth.stdout}\n${auth.stderr}`;
  const account = (raw.match(/account\s+([^\s]+)/i) || raw.match(/Logged in to .* account ([^\s]+)/i) || [])[1];
  return { installed: true, loggedIn: auth.ok, account, detail: raw.trim().slice(0, 300) };
}
// 「优先国内节点」没有显式设过时按机器所在地给默认(见 providers.mjs 的 isCnMachine)。
// 只在 undefined 时补:用户手动勾/取消后 settings 里是显式 true/false,判断不再介入。
// 已经探到端点的老用户不受影响 —— resolvedProvider 优先用探测记录,候选顺序只在没记录时说话。
// 语言取 env,取不到就用 settings.lang(界面语言,前端一连上就 set_lang 落盘)——
// GUI 启动的进程 macOS 不给 LANG(实测为空),只靠 env 会把中文界面的用户全判成海外。
const SYS_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })();
function loadSettings() {
  let s;
  try { s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { s = {}; }
  if (s.cnEndpoint === undefined) s.cnEndpoint = isCnMachine(SYS_TZ, process.env.LC_ALL || process.env.LANG || s.lang || "");
  return s;
}
// 0600:settings.json 存着第三方 provider 的 API Key 明文,默认 0644 等于同机任何进程都能读。
// mode 只在**新建**时生效,已存在的文件得显式 chmod 一次(老用户的 0644 也就跟着收紧了)。
function saveSettings(s) {
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2), { mode: 0o600 });
  try { fs.chmodSync(SETTINGS, 0o600); } catch {}
}

// ---------- 远程模型清单 ----------
// 目的只有一个:装了 dmg 的用户不重装也能用上新模型(各家上新比发版快)。
// 清单是仓库里的一份静态 JSON,只带模型元数据 —— 拉下来 sanitize 后才用,**改不了 baseUrl**
// (为什么这条是死线,见 providers.mjs 的「安全边界」)。
//
// 三条自我约束:
//   · 不在启动路径上:延后 4 秒、异步、失败静默。内置表是地板,拉不到只是没有新模型,不是故障。
//   · 一天最多一次:清单一周才动一回,每次启动都拉是纯浪费。
//   · 不上报任何东西:只是 GET 一个公开文件,没有 body、没有 query、不带 key。
// 两个源同时发、谁先成谁算(Promise.any):raw.githubusercontent 在国内经常被污染,jsDelivr 有时又慢,
// 与其猜哪个通(那正是 baseUrlCN 那套要解决的问题),不如都发出去 —— 反正是同一个只读文件。
const CATALOG_URLS = [
  "https://raw.githubusercontent.com/dengteng/ChatCode/main/catalog/models.json",
  "https://cdn.jsdelivr.net/gh/dengteng/ChatCode@main/catalog/models.json",
];
const CATALOG_TTL = 86400_000; // 一天

async function refreshCatalog() {
  const s = loadSettings();
  if (Date.now() - (s.modelCatalogAt || 0) < CATALOG_TTL) return;
  const get = async (url) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  let j;
  try { j = await Promise.any(CATALOG_URLS.map(get)); } catch { return; } // 两个源都不通:静默,下次再说
  // 形状不对就整份丢掉,别把半份垃圾写进 settings —— 宁可没有清单,也不要一份烂的赖在那儿。
  if (!j || typeof j.providers !== "object" || Array.isArray(j.providers)) return;
  const catalog = {};
  for (const [id, list] of Object.entries(j.providers)) {
    if (!PROVIDERS[id] || id === "claude") continue; // 只认识的家;claude 的列表来自 SDK,不受清单管
    const clean = sanitizeCatalogModels(id, list);
    if (clean.length) catalog[id] = clean;
  }
  // 时间戳照记:清单是空的(比如全被 sanitize 掉了)也算这次拉过了,别每次启动重打。
  saveSettings({ ...loadSettings(), modelCatalog: catalog, modelCatalogAt: Date.now() });
}
// 新清单不主动推给前端:reportModels 每次都现读 settings,用户下次打开模型菜单就是新的。
setTimeout(() => { refreshCatalog().catch(() => {}); }, 4000);

// ---------- 多语言:中文原文当键(与前端同一策略) ----------
// zh 是默认语言,不建词典,tr() 直接回中文原文,零回归;en 命中 EN_DICT 才替换。
// 插值统一用 {{var}}:tr("已切换到 {{label}}(换 provider 会开启全新对话)", { label }）。
// 语言由前端连上后 set_lang 同步,落 settings.json 持久化 —— 重启后首条消息就本地化,不依赖前端先到。
let LANG = loadSettings().lang === "en" ? "en" : "zh";
const EN_DICT = {
  // ---- system_note ----
  "🧹 上下文已清空,开始全新对话": "🧹 Context cleared, starting a fresh conversation",
  "⚠️ 原对话上下文无法恢复,已在当前目录开启全新上下文继续": "⚠️ Couldn't restore the previous conversation, started fresh in the current directory",
  "⛔ 打断没生效,已强制重启 agent(上下文保留)": "⛔ Interrupt didn't take, force-restarted the agent (context kept)",
  "🔀 已切换到 {{label}}(换 provider 会开启全新对话)": "🔀 Switched to {{label}} (switching provider starts a new conversation)",
  // ---- 审批 / 推送 ----
  "用户拒绝了此操作": "The user declined this action",
  "需要审批": "Approval needed",
  "任务完成": "Task finished",
  "点击查看": "Tap to view",
  "{{title}} 已完成": "{{title}} finished",
  "{{title}}：Agent 请求执行 {{tool}}": "{{title}}: agent requests to run {{tool}}",
  // ---- SSH ----
  "SSH 连接失败: {{detail}}": "SSH connection failed: {{detail}}",
  "检查主机/密钥": "check host/key",
  "✅ 已连接 {{target}},后续 ! 命令在远端执行": "✅ Connected to {{target}}, subsequent ! commands run remotely",
  "[命令超时,已终止]": "[command timed out, terminated]",
  "私钥权限过于开放{{perm}},运行 chmod 600 {{path}}": "Private key permissions too open{{perm}}, run chmod 600 {{path}}",
  "<私钥路径>": "<private key path>",
  "认证被拒:公钥未加入服务器 authorized_keys,或用户名不对": "Authentication denied: public key not in the server's authorized_keys, or username is wrong",
  "连接被拒:检查主机地址与端口,以及 SSH 服务是否运行": "Connection refused: check the host address/port and whether the SSH service is running",
  "连接超时:检查网络或主机是否可达": "Connection timed out: check your network or whether the host is reachable",
  "无法解析主机名:检查地址拼写": "Could not resolve hostname: check the address spelling",
  "找不到私钥文件:{{path}}": "Private key file not found: {{path}}",
  "主机密钥校验失败:known_hosts 中的指纹与服务器不符": "Host key verification failed: known_hosts fingerprint doesn't match the server",
  "连接失败": "Connection failed",
  "用法: !ssh [-p 端口] user@host": "Usage: !ssh [-p port] user@host",
  "✅ 已切回本地目录,后续 ! 命令在本地执行": "✅ Switched back to local directory, subsequent ! commands run locally",
  "退出远程连接": "Exit remote connection",
  "📁 已将 agent 工作目录切到 {{target}}(在该目录重开上下文,之前的对话记忆不带过来)": "📁 Switched agent working directory to {{target}} (context restarts there, previous memory is not carried over)",
  "📁 已将 agent 工作目录设为 {{target}}": "📁 Set agent working directory to {{target}}",
  // ---- 会话错误 ----
  "暂无可汇总的改动小结": "No changes to summarize",
  "会话不存在或已被删除,请新建会话重试": "Session doesn't exist or was deleted; create a new one and retry",
  "会话重建失败,请重开该会话": "Session rebuild failed; reopen the session",
  "未指定项目目录,已取消新建会话(不再默认落到用户主目录)": "No project directory given; canceled new session (no longer defaults to home)",
  "项目目录必须是绝对路径: {{path}}": "Project directory must be an absolute path: {{path}}",
  "无法创建项目目录 {{dir}}: {{err}}": "Could not create project directory {{dir}}: {{err}}",
  "无法创建闲聊临时目录: {{err}}": "Could not create casual-chat temp directory: {{err}}",
  "无法重建闲聊临时目录 {{dir}}: {{err}}": "Could not recreate casual-chat temp directory {{dir}}: {{err}}",
  "工作目录不存在: {{dir}} —— 目录被删或改名了。恢复该目录后再重连,或新建一个会话。":
    "Working directory is gone: {{dir}} — it was deleted or renamed. Restore it and reconnect, or start a new session.",
  "闲聊": "Casual",
  "新会话": "New session",
  "会话": "session",
  "错误: {{err}}": "Error: {{err}}",
  "{{title}}：Agent 请求执行 {{tool}}": "{{title}}: agent requests to run {{tool}}",
  "{{title}} 已完成": "{{title}} finished",
};
function tr(s, params) {
  let out = LANG === "en" && EN_DICT[s] ? EN_DICT[s] : s;
  if (params) for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{{${k}}}`, String(v));
  return out;
}
// 语言只在 ws 层用(前端 set_lang 同步过来),但 tr() 被各消息发送点共用。
function setLang(l) {
  LANG = l === "en" ? "en" : "zh";
  const s = loadSettings();
  if (s.lang !== LANG) { s.lang = LANG; saveSettings(s); }
}
// 模型描述形如 "deepseek-v4-flash · 快" —— 只译 ` · ` 后的中文标签,model id 保持原样。
const EN_MODEL_TAGS = { "快": "fast", "最强": "best", "稳": "stable", "编码": "coding", "通用": "general", "手动指定": "manual" };
function localizeModelDesc(desc) {
  if (!desc || LANG !== "en") return desc;
  const i = desc.lastIndexOf(" · ");
  if (i < 0) return desc;
  const tag = desc.slice(i + 3);
  return EN_MODEL_TAGS[tag] ? `${desc.slice(0, i)} · ${EN_MODEL_TAGS[tag]}` : desc;
}

// ---------- 设置:账号登录状态 / 交互式登录 / SSH 主机预设 ----------
// Claude 登录态:API Key 环境变量优先;否则问 CLI 自己(`claude auth status`)。
// 为什么不用钥匙串探针:老版本遗留的 "Claude Code-credentials"(acct=unknown)空壳项
// 不随 `claude /logout` 删除,直接探钥匙串会让已退出登录的用户永远显示"已登录";
// 而查询真实走的是同一份账户凭据(Claude Code-credentials-<hash>),CLI 自己判定最准。
async function claudeAuth() {
  let bin = CLAUDE_BIN;
  if (!bin) {
    const which = await execOut("which", ["claude"]);
    bin = which.ok ? "claude" : "";
  }
  const installed = !!bin;
  if (process.env.ANTHROPIC_API_KEY) return { installed, loggedIn: true, method: "API Key（环境变量）" };
  if (!installed) return { installed, loggedIn: false, method: "" };
  const auth = await execOut(bin, ["auth", "status", "--json"]);
  try {
    const st = JSON.parse(auth.stdout);
    const method = st.authMethod === "oauth_token" ? "Claude 订阅（OAuth）" : st.authMethod || "";
    return { installed, loggedIn: !!st.loggedIn, method };
  } catch {
    // CLI 报错/非 JSON(网络挂、CLI 异常)按未登录处理,设置面板不至于卡死在旧状态
    return { installed, loggedIn: false, method: "" };
  }
}
// GitHub 登录态:gh auth status(全局,与工作目录无关)。
async function githubAuth() {
  const version = await execOut("gh", ["--version"]);
  if (!version.ok) return { installed: false, loggedIn: false, detail: "未安装 gh CLI" };
  const auth = await execOut("gh", ["auth", "status"]);
  const raw = `${auth.stdout}\n${auth.stderr}`;
  const account = (raw.match(/account\s+([^\s]+)/i) || [])[1];
  return { installed: true, loggedIn: auth.ok, account, detail: raw.trim().slice(0, 300) };
}
async function authStatus() {
  const [claude, github] = await Promise.all([claudeAuth(), githubAuth()]);
  claudeLoggedIn = claude.loggedIn; // 登录/登出后前端都会调这里,用量探针据此起停(见 isClaudeLoggedIn)
  const settings = loadSettings();
  const keys = settings.providerKeys || {};
  const providers = {};
  for (const p of Object.values(PROVIDERS)) {
    if (p.id === "claude") continue;
    const r = resolvedProvider(p.id, settings);
    // 除配置态外,把传输方式 + 解析后的 baseUrl/models + 出厂默认一并给前端,设置面板据此渲染可编辑项
    // 默认值也得按「选中的候选」给:Kimi 的订阅端点和平台端点连模型表都不一样,
    // 拿 provider 级的默认去填配置页会填出另一套端点的模型。
    providers[p.id] = {
      label: p.label, configured: !!keys[p.id], transport: p.transport,
      baseUrl: r.baseUrl, defaultBaseUrl: r.baseUrl, models: r.models,
      defaultModels: r.models, smallFast: r.smallFast,
      // vision: 端点收不收图片(输入框据此拦图);cnAvailable: 有国内候选可切;
      // subscriptionUsage: 订阅制(用量条显示 5h/周额度)还是按量计费(显示余额 + 本会话花费)——
      // 这条随探测结果变,同一家换把 key 就可能翻面。
      vision: p.vision, baseUrlCN: p.baseUrlCN,
      cnAvailable: variantsOf(p.id, settings).some((v) => v.cn) || !!p.baseUrlCN,
      subscriptionUsage: !!r.subscriptionUsage,
    };
  }
  return { claude, github, providers, cnEndpoint: !!settings.cnEndpoint };
}

// 新发布但 SDK supportedModels 还没上报(后端按账户放量,菜单里看不到)的 Claude 模型手动补进来。
// 后端给账户开了就能直接用;没开则选中后 SDK 报错——和 CLI 里 `claude --model claude-opus-5` 同理。
// SDK 的 supportedModels 没上报、或还没问到时的兜底表。首装第一次用(缓存也空)时,菜单至少有这几个。
// 与 SDK 上报重复的会在下面按 key 去重,不会出现两份。
const CLAUDE_MANUAL_MODELS = [
  { value: "claude-opus-5", model: "claude-opus-5", displayName: "Opus 5", description: "claude-opus-5 · 手动指定", provider: "claude", contextWindow: 1_000_000 },
  { value: "claude-sonnet-5", model: "claude-sonnet-5", displayName: "Sonnet 5", description: "claude-sonnet-5 · 手动指定", provider: "claude" },
  { value: "claude-opus-4-8", model: "claude-opus-4-8", displayName: "Opus 4.8", description: "claude-opus-4-8 · 手动指定", provider: "claude" },
  { value: "claude-haiku-4-5-20251001", model: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "claude-haiku-4-5 · 手动指定", provider: "claude" },
];
const modelKey = (m) => m?.value || m?.resolvedModel || m?.model;
// /model 菜单 = Claude 动态模型(SDK 上报)+ 已配置 key 的其他 provider 静态模型。
// DeepSeek 会话的 q.supportedModels() 打的是 DeepSeek endpoint、多半拿不到,失败就退回上次缓存的 Claude 列表。
// 落盘缓存:首页(还没开任何会话)问模型列表时没有 q 可问,纯内存变量在 sidecar 刚起时是空的,
// 菜单就只剩手工表那一条 Opus 5。存进 settings,重启后照样能列出上次拿到的 Claude 全家桶。
let lastClaudeModels = loadSettings().claudeModels ?? [];
async function reportModels(ws, sessionId, q) {
  let claude = [];
  // supportedModels 打的是当前会话 endpoint;DeepSeek 未必实现,加超时兜底别把菜单卡住
  try { claude = (await Promise.race([q?.supportedModels?.(), new Promise((r) => setTimeout(() => r([]), 3000))])) ?? []; } catch {}
  if (claude.length && JSON.stringify(claude) !== JSON.stringify(lastClaudeModels)) {
    lastClaudeModels = claude;
    saveSettings({ ...loadSettings(), claudeModels: claude });
  }
  const base = claude.length ? claude : lastClaudeModels;
  // SDK 已上报的就不重复补(将来菜单补上后自动不再手动加),但 supportedModels 不带 contextWindow,
  // 直接原样用会让 opus5 的 1M 掉回默认 200k —— 所以把手工表里知道的窗口大小合并上去。
  const manualBy = new Map(CLAUDE_MANUAL_MODELS.flatMap((m) => [[m.value, m], [m.model, m]]));
  const merged = base.map((b) => {
    const m = manualBy.get(modelKey(b)) || manualBy.get(b.model);
    return m?.contextWindow && !b.contextWindow ? { ...b, contextWindow: m.contextWindow } : b;
  });
  const have = new Set(base.map(modelKey));
  const manual = CLAUDE_MANUAL_MODELS.filter((m) => !have.has(m.value) && !base.some((b) => modelKey(b) === m.model));
  // 广播而非单播:改 settings/key 或重开会话时,所有客户端(桌面/手机)的该会话列表都同步更新,
  // 不再只发给触发的那个连接 —— 否则别的端一直用旧快照(kimi 新增模型选了却显示旧窗口)。
  broadcast({ type: "models", sessionId, models: [...merged, ...manual, ...extraModels(loadSettings())].map((m) => ({ ...m, description: localizeModelDesc(m.description) })) });
}
// AppleScript 字符串转义(仅 macOS)
const asStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// 交互式登录/登出:OAuth 需浏览器+交互,webview 内做不了 —— macOS 拉起系统 Terminal 跑真实命令。
// 返回是否成功拉起;非 macOS 返回命令让前端提示用户手动执行。
function launchInTerminal(cmd) {
  if (process.platform !== "darwin") return Promise.resolve({ ok: false, manual: cmd });
  return execOut("osascript", ["-e", "tell application \"Terminal\" to activate",
    "-e", `tell application "Terminal" to do script ${asStr(cmd)}`]).then((r) => ({ ok: r.ok, manual: r.ok ? null : cmd }));
}
// provider/action -> 实际命令。login 走各自 CLI 的交互式登录;logout 同理。
function authCommand(provider, action) {
  if (provider === "github") return action === "logout" ? "gh auth logout" : "gh auth login --web";
  if (provider === "claude") return action === "logout" ? "claude /logout" : "claude"; // claude TUI:未登录会走 OAuth,已登录内输 /logout
  return null;
}

const loadSshHosts = () => loadSettings().sshHosts ?? [];
function saveSshHosts(hosts) { saveSettings({ ...loadSettings(), sshHosts: hosts }); }

const inputTokensOf = (u) =>
  (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

// 会话最后的上下文体积(单次请求送进模型的 token)。
// 不能取 result.usage —— 那是整轮所有 API 调用(含子 agent)的累加,能轻松超过上下文窗口。
// 原实现找 stream_event/message_start,但流式增量从不落盘(见 appendLog 处注释),那条路永远是 0,
// 重开后端拿不到实算值,前端 localStorage 缓存一丢(覆盖安装)进度条就只剩个零头。
// 改从落盘的 assistant 消息取:最后一条主对话 assistant 的 message.usage 输入侧 ≈ 当时的上下文体积。
// 子 agent(parent_tool_use_id)和小模型微调用(标题/安全检查等)按主模型过滤,过滤不了才退回最近一条。
function contextSize(messages) {
  const norm = (s) => String(s ?? "").replace(/\[1m\]$/, "");
  let mainModel = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "system" && m.subtype === "init" && m.model) { mainModel = norm(m.model); break; }
  }
  let fallback = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // 压缩是最后一个上下文事件:之后 assistant 的 usage 都是压缩前的体积,得用压缩后的
    if (m.type === "system" && m.subtype === "compact_boundary" && m.compact_metadata?.post_tokens != null)
      return m.compact_metadata.post_tokens;
    if (m.type !== "assistant" || m.parent_tool_use_id) continue;
    const tokens = inputTokensOf(m.message?.usage);
    if (!tokens) continue;
    if (!fallback) fallback = tokens;
    if (mainModel && norm(m.message?.model) === mainModel) return tokens;
  }
  return fallback;
}

// ---------- 订阅限额:SDK 原生 /usage 控制接口 ----------
// 不读取钥匙串，也不调用未公开 OAuth 接口。Claude Code 会把已经授权的订阅用量
// 通过这个控制接口返回；API key 会明确返回 rate_limits_available:false。
//
// 这个控制请求 = CLI 现场 GET /api/oauth/usage —— 实时的账户级数据,不消耗任何模型额度。
// (只有那个请求失败时,CLI 才退回到 anthropic-ratelimit-* 响应头攒出来的旧快照。)
// 所以:1) 问一个会话就够了,不必把所有会话都问一遍(那是 N 个 HTTP 请求换同一份数据);
//      2) 也不需要"取最大值"来防倒退 —— 服务端给什么就是什么。
// 只有第一个会话查不到时才顺延到下一个(那多半是它自己的 OAuth 刷新出了问题)。
// 启动即回显上次落盘的用量,免得进会话后盯着空进度条等 CLI init(要几十秒)。
// 保留原 fetchedAt,界面显示"更新于 X前"(不标 stale,这不是刷新失败,只是旧),拿到新数据即覆盖。
let lastUsage = loadSettings().lastUsage || null;
// Kimi 编程订阅用量(5h/周)—— 走 Kimi 自家 GET {baseUrl}/v1/usages,不经 SDK。同样落盘回显。
let lastKimiUsage = loadSettings().lastKimiUsage || null;

// 专用用量探针:没有任何活跃会话时,账户级用量本来就没人去刷(usageSources 为空 → 数字冻结,
// 界面停在几小时前的旧值)。这里起一个不发任何 prompt、不烧额度的常驻 SDK query,专门问 /usage。
// 一旦有真实会话在跑,就把探针停掉,不额外占一个 CLI 进程。
let usageProbe = null; // { q, queue, ready }

// Claude 登录态缓存:refreshSubscriptionUsage 每 15-60s 跑一次,不能每拍都 spawn 一次 `claude auth status`。
// null = 还没查过。authStatus() 每次跑完会顺手刷新它(登录/登出后前端都会调),所以不会一直停在旧值。
let claudeLoggedIn = null;
async function isClaudeLoggedIn() {
  if (claudeLoggedIn === null) claudeLoggedIn = (await claudeAuth()).loggedIn;
  return claudeLoggedIn;
}
// 停掉探针,放掉那个 CLI 子进程。end() 让 prompt 迭代器收尾,SDK 随之退出子进程。
function stopUsageProbe() {
  const p = usageProbe;
  if (!p) return;
  usageProbe = null;
  try { p.queue.end(); } catch {}
}

function ensureUsageProbe() {
  if (usageProbe) return usageProbe;
  try {
    const queue = makeInputQueue(); // 永不 push、永不 end:CLI 起来后一直待命,只走控制通道问用量
    const q = query({
      prompt: queue,
      options: {
        cwd: os.homedir(),
        ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
        stderr: () => {},
      },
    });
    const probe = { q, queue, ready: false };
    usageProbe = probe;
    // 必须消费迭代器,SDK 才会真正拉起 CLI 子进程。以前把 ready 挂在"收到第一条消息"上 —— 但无 prompt 的
    // query 可能一条消息都不发(没配 hook 时连 hook_started 都没有),ready 就永远 false,探针形同虚设,
    // usageSources 永远落到空闲会话的低快照(这正是打包版用量卡在错值的根因)。改成:只管消费迭代器把子
    // 进程拉起来,readiness 交给下面的定时器 —— 给子进程几秒预热后直接置 ready,靠 GET /usage 本身探活。
    (async () => { try { for await (const _ of q) {} } catch {} finally { if (usageProbe === probe) usageProbe = null; } })();
    // 子进程起来后控制通道有 ~5-15s 预热期(期间 rate_limits 为空,refresh 会跳过)。置 ready 后做有界重试,
    // 拿到真实窗口即止;拿不到就交给 60s/15s 常规轮询继续补。
    setTimeout(() => {
      if (usageProbe !== probe) return;
      probe.ready = true;
      let tries = 0;
      const kick = async () => {
        if (usageProbe !== probe) return;
        await refreshSubscriptionUsage();
        const got = lastUsage && (lastUsage.session?.usedPct != null || lastUsage.weekly?.usedPct != null);
        if (!got && ++tries < 8) setTimeout(kick, 4000); // 预热没过就 4s 再试,最多 8 次(~32s)
      };
      kick();
    }, 4000);
  } catch (e) { console.error("[usage] 探针启动失败:", e); usageProbe = null; }
  return usageProbe;
}

function usageSources() {
  // 全部数据源一起上,逐个试、合并取窗口内最大值(见下方 refreshSubscriptionUsage)。
  // 为什么不能只挑一个:SDK 的 GET /api/oauth/usage 控制通道极不稳,常年返回 rate_limits:null
  //(实测无 prompt 探针 90s 全 null 都可能);而空闲会话有时又只给一份偏低的旧快照(5%/14%)。
  // 单一数据源经常一直刷不上。多源并试,谁偶尔拿到真值就直接采用。
  // 探针常驻兜"没有任何会话"的场景(不发 prompt、不烧额度)。
  const idle = [...sessions.values()].filter((s) => s?.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET && !s.running);
  const probe = ensureUsageProbe();
  return probe ? [...idle, probe] : idle;
}
async function refreshSubscriptionUsage() {
  // 没登录 Claude 就别往下走。这里问的是 Claude 账户的订阅额度,没登录本来就读不到 ——
  // 而 usageSources() 会顺手 ensureUsageProbe() 拉起一个常驻 CLI 子进程去打 Anthropic 的
  // /api/oauth/usage。只用 DeepSeek/Kimi/GLM 的用户(尤其国内)因此白养一个连不上的进程,
  // 重试完还转入 60s 永久轮询。第三方模型的用量/余额自有各家的接口,不经这条路。
  if (!(await isClaudeLoggedIn())) {
    stopUsageProbe();
    return null;
  }
  const sources = usageSources();
  if (!sources.length) return null; // 没有可用数据源(探针还在启动):留着上一份,别把用量条清空
  const errs = [];
  // /usage 端点在真实 app 里间歇性返回 rate_limits:null,还有多个源(空闲会话快照 + 探针)读数常不一致 ——
  // 有的拿到新窗口、有的还回着旧窗口的过期快照。用窗口感知的 better() 统一合并(源内 + 跨轮同一套):
  //   · resetAt 是窗口身份(保留原始时刻,哪怕刚过去,别抹成 null,否则换窗判定失灵、旧值永远赖着);
  //   · 换到更新的窗口(resetAt 明显靠后)才采新值 —— 允许 util 下降(重置了);
  //   · 见到更旧的窗口(某个源回了过期快照)一律忽略,绝不倒退 —— 这是"值一直来回跳"的根因;
  //   · 同一窗口内 util 只增,取较大者,避免抖动式回退。
  const NEWER = 120_000; // resetAt 相差超过 2min 才算换窗,躲开秒级抖动
  const WIN_PERIOD = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 }; // 窗口全长:超过它还没推进的快照死透了
  const better = (a, b) => {
    if (!b || b.usedPct === null) return a || b;         // b 没数据:留 a
    if (!a || a.usedPct === null) return b;               // a 没数据:用 b
    const ar = a.resetAt ?? 0, br = b.resetAt ?? 0;
    if (br > ar + NEWER) return b;                         // b 是更新的窗口(已重置)→ 采 b(可降)
    if (br < ar - NEWER) return a;                         // b 是更旧的窗口(过期快照)→ 忽略,别倒退
    const usedPct = Math.max(a.usedPct, b.usedPct);        // 同窗:利用率只增,取大
    const resetAt = (b.resetAt && b.resetAt > Date.now()) ? b.resetAt
                  : (a.resetAt && a.resetAt > Date.now()) ? a.resetAt : Math.max(ar, br) || null;
    return { usedPct, resetAt };
  };
  // 本轮真值:5h / 周各自独立累计(某源可能只回其一),按 better 收敛到"最新窗口"读数。
  const live = { session: null, weekly: null };
  let got = false; // 本轮是否至少拿到一份有效读数
  let unavailable = false; // 见到明确的"非订阅会话"
  for (const s of sources) {
    const tag = s === usageProbe ? "probe" : `sess:${s.id ?? "?"}`;
    let j;
    const t0 = Date.now();
    try { j = await s.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.call(s.q); }
    catch (e) { errs.push(String(e?.message ?? e)); continue; }
    // 只在拿到真值时记一行,方便日后排查;null 的常态不刷屏(失败汇总仍走下面的 [usage] 刷新失败)。
    if (j?.rate_limits?.five_hour) console.error(`[usage] ${tag} ${Date.now() - t0}ms 5h=${j.rate_limits.five_hour.utilization}% 7d=${j.rate_limits.seven_day?.utilization}%`);
    if (j && !j.rate_limits_available) { unavailable = true; errs.push("非订阅会话"); continue; }
    if (!j?.rate_limits) { errs.push("响应里没有 rate_limits"); continue; }
    const pick = (key) => {
      const usedPct = j.rate_limits[key]?.utilization ?? null;
      const resetAt = toMs(j.rate_limits[key]?.resets_at) || null; // 保留原始重置时刻(可能刚过去)当窗口身份;是否显示倒计时由前端判断在不在未来
      const bogus = usedPct === 0 && !resetAt; // 0% 且完全没有重置时刻 = 超时回退的假快照,当没拿到
      // resetAt 已过去超过整整一个窗口周期:这份快照死透了,当没拿到 —— 否则旧窗口身份永远赖着,
      // better() 的「绝不倒退」反而挡住新值,前端永远停在"刷新中"
      const dead = resetAt && Date.now() - resetAt > WIN_PERIOD[key];
      return (bogus || dead) ? { usedPct: null, resetAt: null } : { usedPct, resetAt };
    };
    const nextS = pick("five_hour"), nextW = pick("seven_day");
    if (nextS.usedPct === null && nextW.usedPct === null) { errs.push("空快照"); continue; }
    if (nextS.usedPct !== null) live.session = better(live.session, nextS);
    if (nextW.usedPct !== null) live.weekly = better(live.weekly, nextW);
    got = true;
  }
  if (got) {
    // 跨轮同样走 better:换窗才前进(倒计时结束后拿到新窗口即刷新、可降),旧窗口过期快照被忽略(不闪回)。
    // 本轮没拿到的那一半(better 返回 null)沿用上一份,避免闪空。
    lastUsage = {
      session: better(lastUsage?.session, live.session) ?? lastUsage?.session ?? null,
      weekly: better(lastUsage?.weekly, live.weekly) ?? lastUsage?.weekly ?? null,
      fetchedAt: Date.now(), stale: false,
    };
    // 拿到的"新值"窗口本身已结束超过 10min(API 卡在过去,只回旧窗口快照):这份数据实质已死,
    // 标 stale 让界面变灰显示旧百分比,而不是永远"刷新中"。stale 会触发 15s 快节奏轮询尽快恢复。
    const winDead = (w) => w?.resetAt && Date.now() - w.resetAt > 10 * 60_000;
    if (winDead(lastUsage.session) || winDead(lastUsage.weekly)) lastUsage = { ...lastUsage, stale: true };
    broadcastUsage();
    return lastUsage;
  }
  // 没有任何真值,但明确是非订阅会话(且此前也没有过真值):提示不可用
  if (unavailable && !lastUsage) return unavailableUsage("当前会话不是 Claude 订阅会话（API key / Bedrock / Vertex 无订阅额度）");
  // 本轮所有源都没给出有效数据:继续显示旧值,久刷不上才标 stale
  console.error("[usage] 刷新失败:", errs.join(" | "));
  // 单次刷新失败(常见:live GET /usage 的 5s 超时)不立刻标 stale —— 否则进度条蓝柱会"闪一下变灰"再恢复。
  // 数据还在宽限期内(上次成功刷新不到 5min)就继续当它有效;真的久刷不上(>5min)才变灰提示数据旧了。
  if (lastUsage) {
    const reallyStale = !lastUsage.fetchedAt || Date.now() - lastUsage.fetchedAt > 5 * 60_000;
    lastUsage = { ...lastUsage, stale: reallyStale };
    broadcastUsage();
  }
  return lastUsage;
}
function unavailableUsage(reason) {
  lastUsage = {
    session: { usedPct: null, resetAt: null, unavailableReason: reason },
    weekly: { usedPct: null, resetAt: null, unavailableReason: reason },
    fetchedAt: Date.now(), stale: false,
  };
  broadcastUsage();
  return lastUsage;
}
function toMs(iso) { return iso ? Date.parse(iso) : null; }

// ---------- Kimi 编程订阅用量:GET {baseUrl}/v1/usages ----------
// Bearer 就是 settings.providerKeys.kimi。响应里 usage = 周额度,limits[] 的 300 分钟窗 = 5h。
async function refreshKimiUsage() {
  const settings = loadSettings();
  const key = settings?.providerKeys?.kimi;
  const def = resolvedProvider("kimi", settings);
  // key 被清了、或探出来这把 key 属于开放平台(按 token 计费,没有额度窗口):旧值一并清,别留着误导。
  // 平台那边的钱由余额接口 + 本地账本负责显示,不走这条。
  if (!key || !def?.kimiUsageApi) {
    if (lastKimiUsage) { lastKimiUsage = null; broadcastUsage(); }
    return null;
  }
  const base = (def.baseUrl || "").replace(/\/+$/, "");
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    let r;
    try { r = await fetch(`${base}/v1/usages`, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal }); }
    finally { clearTimeout(t); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // 值是字符串,自己算百分比;resetTime 只认未来(同 Claude 的规矩,别把倒计时冻在过去)
    const pick = (d) => {
      if (!d) return { usedPct: null, resetAt: null };
      const limit = Number(d.limit), used = Number(d.used);
      const usedPct = limit > 0 && Number.isFinite(used) ? (used / limit) * 100 : null;
      const ms = toMs(d.resetTime);
      return { usedPct, resetAt: ms && ms > Date.now() ? ms : null };
    };
    const five = j.limits?.find((l) => l.window?.timeUnit === "TIME_UNIT_MINUTE" && Number(l.window?.duration) === 300) ?? j.limits?.[0];
    lastKimiUsage = { session: pick(five?.detail), weekly: pick(j.usage), fetchedAt: Date.now(), stale: false };
  } catch (e) {
    console.error("[usage] kimi 刷新失败:", e?.message ?? e);
    if (!lastKimiUsage) return null; // 从来没有过数据:不广播,界面保持加载态
    // 同 Claude:单次失败不标 stale,超过 5min 刷不上才变灰
    lastKimiUsage = { ...lastKimiUsage, stale: !lastKimiUsage.fetchedAt || Date.now() - lastKimiUsage.fetchedAt > 5 * 60_000 };
  }
  broadcastUsage();
  return lastKimiUsage;
}

// ---------- 按量计费 provider 的钱包:账户余额 + 今日/本月消费 ----------
// 余额来自 provider 自家接口(目前只有 DeepSeek 声明了 balanceApi):
//   GET {baseUrl 去掉 /anthropic}/user/balance,Bearer = settings.providerKeys[id]
//   → { balance_infos: [{ currency: "CNY", total_balance: "110.00", ... }] }
// 今日/本月**不是**接口来的:各家都没有消费查询 API,由本地账本按单价累计(spend.mjs 的 ledger)。
// 所以这两个数只覆盖 ChatCode 里发生的花费,别的客户端烧的算不进来 —— 前端 tooltip 里说清楚。
let lastBalance = {}; // { [provider]: { balance, balanceCurrency, fetchedAt, error } }
async function refreshBalances() {
  const settings = loadSettings();
  let changed = false;
  for (const p of Object.values(PROVIDERS)) {
    // 有没有余额接口是**选中的候选**说了算,不是 provider 说了算 —— 同一家的订阅端点没有余额,
    // 平台端点才有(Kimi 就是这样)。探到哪个变体就按哪个来。
    const def = resolvedProvider(p.id, settings);
    const api = def?.balanceApi;
    const key = settings?.providerKeys?.[p.id];
    if (!api || !key) { if (lastBalance[p.id]) { delete lastBalance[p.id]; changed = true; } continue; } // 没接口/key 清了:余额一并清,别留着误导
    const base = (def.baseUrl || "").replace(/\/anthropic\/?$/, "").replace(/\/+$/, "");
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      let r;
      try { r = await fetch(`${base}${api.path}`, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal }); }
      finally { clearTimeout(t); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const info = api.pick(j) || {};
      const bal = Number(info.balance);
      if (!Number.isFinite(bal)) throw new Error("响应里没有余额");
      lastBalance[p.id] = { balance: bal, balanceCurrency: info.currency === "CNY" ? "¥" : (info.currency === "USD" ? "$" : info.currency || ""), fetchedAt: Date.now() };
    } catch (e) {
      // 拉不到就留着上一份并标 error(界面变灰),绝不把余额显示成 0 —— 那会被当成"欠费了"
      lastBalance[p.id] = { ...(lastBalance[p.id] || {}), error: String(e?.message ?? e) };
    }
    changed = true;
  }
  if (changed) broadcastWallet();
}

// ---------- 端点探测:这把 key 该打哪个域名,自动定 ----------
// GLM/Qwen/MiniMax 的国际站和国内站是两套账号,同一把 key 只在其中一边有效,打错那边一律 401。
// 以前靠「使用国内节点」总开关手勾:勾错的症状是"配了 key 还是用不了",且毫无线索。
// 现在存 key 时逐个候选端点发一次最小 messages 请求(max_tokens 1,成本可忽略),
// 谁不回 401/403/404 就记谁到 settings.providerEndpoint[id],后续所有请求都走它。
//
// 只有一个候选就不探 —— 没得选,白花一次请求还白烧一次钱。
// transport:"openai" 的那几家(Grok/OpenAI/Gemini)没有国内域名,永远只有一个候选,走不到这里;
// 真走到了这个探针也不适用(它们收的是 /v1/chat/completions,不是 /v1/messages)。
// 全部候选都不通(key 无效 / 网络断)就删掉记录回落到开关 —— 宁可回落,也不留一条可能错的映射。
// ponytail: 串行探,候选最多两个;并发省不下多少,还容易两边同时撞限流。
async function probeEndpoint(providerId) {
  const settings = loadSettings();
  const key = settings?.providerKeys?.[providerId];
  const cands = endpointsOf(providerId, settings);
  const def = PROVIDERS[providerId];
  if (!key || cands.length < 2 || def?.transport === "openai") return null;
  // 探测请求得带个真模型 id:发 undefined 上去有的端点照样回 200(实测 kimi.com/coding 就是),
  // 那就等于白探。models 从 resolved 取 —— PROVIDERS 上的 def.models 对声明了 variants 的家是空的。
  const r0 = resolvedProvider(providerId, settings);
  const model = r0?.smallFast || r0?.models?.[0]?.model;
  if (!model) return null;
  let hit = null;
  for (const base of cands) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      let r;
      try {
        r = await fetch(`${base.replace(/\/+$/, "")}/v1/messages`, {
          method: "POST",
          // 各家认的鉴权头不统一(有的 x-api-key,有的 Bearer),两个都带上,多余的那个会被忽略
          headers: { "content-type": "application/json", "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          signal: ac.signal,
        });
      } finally { clearTimeout(t); }
      // 401/403 = key 不属于这个端点;404 = 这个端点没有这条路由。其余(含 400 参数不对)都说明鉴权过了。
      if (r.status === 401 || r.status === 403 || r.status === 404) continue;
      // z.ai 实测:鉴权失败时可能回 HTTP 200 但 body 是 {"success":false,"code":1001,…},
      // 只看状态码会把它当成探通。再看一眼 body 里的失败标记。
      const body = await r.text().catch(() => "");
      if (/"success"\s*:\s*false/.test(body)) continue;
      hit = base;
      break;
    } catch (e) {
      console.error(`[probe] ${providerId} ${base} 探测失败:`, e?.message ?? e);
    }
  }
  const s = loadSettings(); // 重新读:探测期间用户可能改过别的设置
  s.providerEndpoint = { ...(s.providerEndpoint || {}) };
  if (hit) s.providerEndpoint[providerId] = hit; else delete s.providerEndpoint[providerId];
  saveSettings(s);
  return hit;
}

// 存/换/清 key 与改 baseUrl 后的统一善后:探端点 → 端点定了再刷用量和余额(它们都按 baseUrl 打)。
function reprobeProvider(providerId, ws) {
  probeEndpoint(providerId).finally(() => {
    authStatus().then((status) => send(ws, { type: "auth_status", status })).catch(() => {});
    // 探完模型表可能整套换掉(Kimi 订阅端点和平台端点是两套模型 id),/model 菜单得重报一次,
    // 否则菜单里还挂着另一套端点的模型,选中直接 404
    for (const [sid, sess] of sessions) reportModels(ws, sid, sess.q);
    // 无条件刷:探完可能从「有额度窗口」变成「有余额」(反之亦然),两边都得跑一趟把不再适用的那份清掉
    if (providerId === "kimi") refreshKimiUsage();
    refreshBalances();
  });
}

function walletPayload() {
  const ledger = loadSettings().spendLedger || {};
  const now = Date.now();
  const out = {};
  for (const id of new Set([...Object.keys(ledger), ...Object.keys(lastBalance)])) {
    out[id] = { ...ledgerStats(ledger, id, now), ...(lastBalance[id] || {}) };
  }
  return out;
}
function broadcastWallet() { broadcast({ type: "wallet", wallet: walletPayload() }); }

function broadcastUsage() {
  // 两边都没有过数据才不广播。有过但被清空(换成按量计费的 key / key 被清)必须推一次 null,
  // 否则前端一直挂着旧的额度窗口 —— 那个数字已经不属于当前这把 key 了。
  if (!lastUsage && !lastKimiUsage && !loadSettings().lastKimiUsage) return;
  try { saveSettings({ ...loadSettings(), lastUsage, lastKimiUsage }); } catch {} // 落盘,下次启动即回显
  const payload = JSON.stringify({ type: "usage", usage: lastUsage, kimiUsage: lastKimiUsage });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(payload);
}

// ---------- 用户输入队列:streaming input 模式的 async iterable ----------
function makeInputQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(v) { items.push(v); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift();
        if (ended) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

// ---------- session 管理 ----------
const sessions = new Map(); // id -> { queue, q, sdkSessionId, pendingPerms: Map }

// Claude 可以并发提出多个工具授权。SDK 层允许并行，但 UI 同时显示多张卡片
// 容易让用户误以为重复弹窗，因此在桥接层串行化为“一次确认一个”。
function showNextPermission(ws, sess, id) {
  if (sess.activePermission) return;
  const next = sess.permissionQueue.shift();
  if (!next) return;
  sess.activePermission = next.requestId;
  broadcast({ type: "permission_request", sessionId: id, ...next }); // 电脑端/手机都弹卡片,任一端都能批准
  broadcastIndex(); // 列表图标转「待审批」
  const title = loadIndex().find((e) => e.id === id)?.title || "会话";
  pushOverlay(tr("需要审批"), tr("{{title}}：Agent 请求执行 {{tool}}", { title, tool: next.toolName })); // 手机悬浮窗(前台由 App 自行忽略)
}

function startSession(ws, { id, cwd, resume, compactFirst }) {
  const home = cwd || os.homedir();
  const sess = {
    queue: null, sdkSessionId: resume ?? null, pendingPerms: new Map(), permissionQueue: [], activePermission: null,
    autoApprove: !!(loadIndex().find((e) => e.id === id)?.autoApprove), // 会话级自动同意,持久化在 index
    permMode: loadIndex().find((e) => e.id === id)?.permMode || "default", // SDK 权限模式,同样持久化
    termCwd: home,      // ! 终端当前目录
    agentCwd: home,     // agent(SDK query)当前工作目录
    pendingCwd: null,   // 终端 !cd 后待同步给 agent 的目录
    generation: 0,      // query 代数,重启时 +1,旧循环据此判断是否已被取代
    hadUserTurn: !!resume, // 是否已有对话历史(有历史则不能迁移 cwd:SDK 按目录存 transcript)
    running: false,         // 本轮是否还在跑(收到 result 即结束)
    msgQueue: [],           // agent 忙时压在这儿的用户消息,本轮跑完依次送进去(见 enqueueMsg / drainMsgQueue)
    freshDone: false,       // 本次启动后完成过一轮(非中断)→ 列表绿✅

    userInterrupted: false, // 用户按了停止:本轮 result 标记为"用户终止"而非"出错"
    bgTasks: [],        // SDK 报的后台任务清单(见 background_tasks_changed);进程面板的权威来源
    ssh: null,          // SSH 连接 { target, port, status, cwd }
  };
  // 恢复上次的 SSH 连接信息(状态先置 disconnected,由用户点重连)
  const entry = loadIndex().find((e) => e.id === id);
  if (entry?.ssh?.target) sess.ssh = { target: entry.ssh.target, port: entry.ssh.port, keyPath: entry.ssh.keyPath, status: "disconnected", cwd: "" };
  sessions.set(id, sess);
  spawnAgent(ws, sess, { id, resume });
  // "从摘要恢复":SDK 没有原生的 resume-from-summary,先 resume 全量上下文再立刻 /compact,
  // 让后续每轮只带摘要。代价是压缩这一次要读完整上下文。
  if (compactFirst) pushTurn(sess, userMessage(sess, "/compact"));
}

const userMessage = (sess, text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  session_id: sess.sdkSessionId ?? "",
});

// 送一轮进 agent。running 让 interrupt 知道当下有没有东西可打断。
function pushTurn(sess, msg) {
  sess.running = true;
  sess.freshDone = false; // 新一轮开始,清掉上一轮的完成态
  sess.userInterrupted = false; // 新一轮开始,清掉上一轮的打断标记
  sess.queue.push(msg);
  broadcastIndex(); // 列表图标转「运行中」
}

// 花费账本:每轮 result 把 token 累加进 index 条目(落盘,重启后还在),并广播给所有客户端。
// 被用户中断的轮次照样算 —— token 已经烧掉了,不会因为按了停止就退钱。
// 只有按量计费的 provider 会显示它(订阅制那两个额度窗口另有来源),但一律记账:
// 中途换 provider 也不会丢账,而且不记的话切过去才开始记就成了一笔糊涂账。
function bumpSpend(id, msg) {
  const idx = loadIndex();
  const e = idx.find((x) => x.id === id);
  if (!e) return;
  const settings = loadSettings();
  const table = priceTable(settings);
  const model = modelArg(e.model || "");
  e.spend = accumulate(e.spend ?? emptySpend(), msg, table, model);
  saveIndex(idx);
  broadcast({ type: "spend", sessionId: id, spend: e.spend });
  // 同一条 result 再单独算一遍「本轮」花费,记进 provider × 自然日的账本 —— 用量条的今日/本月靠它。
  // 单算一遍而不是拿累计差值:累计值可能被别处改写,差值会把整段历史当成本轮记进今天。
  const turn = accumulate(emptySpend(), msg, table, model);
  if (turn.cost > 0) {
    saveSettings({ ...settings, spendLedger: ledgerAdd(settings.spendLedger, providerOf(e.model || ""), turn.cost, turn.currency, Date.now()) });
    broadcastWallet();
  }
}

// 创建/重建 agent 的 SDK query。重建时旧循环因 generation 过期而不触发清理。
function spawnAgent(ws, sess, { id, resume }) {
  const queue = makeInputQueue();
  sess.queue = queue;
  // 换了 query = 上下文重来(切模型/切目录/清空/重连都走这),之前发过的 note 在新上下文里不存在,
  // 去重记录必须清掉重发全文。seed "off":重启时若没连 SSH,首轮不该冒出一句"连接已断开"。
  sess.notes = new Map([["ssh", "off"]]);
  const gen = ++sess.generation;
  let stderrBuf = ""; // 捕获 CLI stderr:退出码 1 时的真实原因(如 "No conversation found")
  // 恢复上次选的模型:直接进 query options,启动即生效("default" 不传,用 SDK 默认)。
  // 之前用 spawn 后补发 setModel,CLI 未就绪时会被静默吞掉,导致重开后回到默认模型。
  const idxEntry = loadIndex().find((e) => e.id === id);
  // cwd 不在了就先处理掉,别让 spawn 去撞 ENOENT —— SDK 会把 spawn 的任何失败都算到
  // claude 可执行文件头上(报 "native binary … exists but failed to launch"),用户按「点此重连」
  // 只会一次次收到同一句与真实原因无关的报错,查不出是目录没了。
  // 闲聊的临时目录本就是一次性的,重建即可;项目目录被删/改名不能替用户凭空造,直接说清是哪个目录。
  if (!fs.existsSync(sess.agentCwd)) {
    let err = null;
    if (idxEntry?.casual) {
      try { fs.mkdirSync(sess.agentCwd, { recursive: true }); }
      catch (e) { err = tr("无法重建闲聊临时目录 {{dir}}: {{err}}", { dir: sess.agentCwd, err: e.message }); }
    } else {
      err = tr("工作目录不存在: {{dir}} —— 目录被删或改名了。恢复该目录后再重连,或新建一个会话。", { dir: sess.agentCwd });
    }
    if (err) {
      // 删掉会话再报错:留着一个没人消费 queue 的空壳,之后发消息会静默掉进黑洞;
      // 删了则前端显示「点此重连」,下次重连会走 startSession 重新起。
      sessions.delete(id);
      broadcast({ type: "session_error", sessionId: id, error: err });
      broadcast({ type: "session_closed", sessionId: id });
      return;
    }
  }
  const savedModel = idxEntry?.model;
  // 闲聊会话额外追加"别暴露临时工作目录"的约定
  const sysAppend = [COMMIT_SUMMARY_INSTRUCTION, NEXT_STEPS_INSTRUCTION, ...(idxEntry?.casual ? [CASUAL_INSTRUCTION] : [])].join("\n\n");
  // 非 Claude provider(如 DeepSeek):注入 ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL,复用 Claude Code CLI 走它的兼容 API。
  // env 会整体替换 process.env(SDK 不自动合并),必须自己摊平。model 传去掉前缀的真实 id。
  const provEnv = envForModel(savedModel, loadSettings());
  const q = query({
    prompt: queue,
    options: {
      cwd: sess.agentCwd,
      includePartialMessages: true, // 流式:发 stream_event 增量
      // 保留 Claude Code 默认系统提示,仅追加「每轮留一句小结」的约定,供 commit 汇总用(不额外多跑一次 LLM)
      systemPrompt: { type: "preset", preset: "claude_code", append: sysAppend },
      ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}), // 打包版必须显式给
      ...(Object.keys(provEnv).length ? { env: { ...process.env, ...provEnv } } : {}),
      ...(resume ? { resume } : {}),
      ...(savedModel && savedModel !== "default" ? { model: modelArg(savedModel) } : {}),
      // 权限模式跟模型同理:进 options 才能"启动即生效"。启动后补 setPermissionMode 会在 CLI
      // 就绪前被静默吞掉 —— 重开会话就悄悄退回逐条审批,用户以为档位还在。
      ...(idxEntry?.permMode && idxEntry.permMode !== "default" ? { permissionMode: idxEntry.permMode } : {}),
      stderr: (m) => { stderrBuf += m; if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192); },
      // 权限走前端确认:agent 请求 -> 前端弹卡片 -> 用户点允许/拒绝
      // blockedPath/decisionReason 也要带上:被拦是因为"命令没放行"还是"路径在项目外",
      // 决定了用户该点哪个建议(前者加 Bash 规则,后者必须放行目录)
      canUseTool: (toolName, input, { suggestions, blockedPath, decisionReason } = {}) =>
        new Promise((resolve) => {
          // 会话级"自动同意"：直接放行,不排队、不广播卡片(桌面/手机都不弹)。
          // AskUserQuestion 是要人选处理方案的提问卡,永不自动答。
          if (sess.autoApprove && toolName !== "AskUserQuestion") {
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          const requestId = crypto.randomUUID();
          sess.pendingPerms.set(requestId, { resolve, input, toolName });
          sess.permissionQueue.push({ requestId, toolName, input, suggestions, blockedPath, decisionReason });
          showNextPermission(ws, sess, id);
        }),
    },
  });
  sess.q = q;
  sess.bgTasks = []; // 后台任务清单是 CLI 进程级的:换了进程就清零,等新进程自己再报

  // 上报可用模型(/model 选择器用)。注意:init 消息要等第一条用户输入才发,不能挂在 init 上,
  // 否则新会话没发消息前列表一直空。supportedModels 是控制请求,空队列即可 resolve。
  reportModels(ws, id, q);

  sess.loopDone = (async () => {
    try {
      for await (let msg of q) {
        if (gen !== sess.generation) break; // 已被重启,停止转发旧循环消息
        if (msg.type === "system" && msg.subtype === "init") {
          sess.sdkSessionId = msg.session_id;
          const idx = loadIndex();
          const entry = idx.find((e) => e.id === id);
          // 同步落盘 sdkSessionId 与 agent 的真实工作目录:重连要按同一目录 resume,否则找不到 transcript
          if (entry) { entry.sdkSessionId = msg.session_id; entry.cwd = sess.agentCwd; saveIndex(idx); }
          // CLI 报的权限模式才是真的(我们传进去的它可能拒了/改了),按它对齐并广播,别让界面显示一个假档位。
          // 每次 init 都广播(不只在变化时):这是"CLI 真的以这个模式起来了"的唯一凭据。
          if (msg.permissionMode) {
            sess.permMode = msg.permissionMode;
            broadcast({ type: "perm_mode", sessionId: id, mode: sess.permMode });
          }
          // Claude Code 初始化完成后，原生 /usage 才能读取订阅窗口。
          refreshSubscriptionUsage();
        }
        // agent 起的后台活(bash &、subagent…)由 SDK 报,整份替换(level 语义,不是增量事件)。
        // 这是「本会话跑起来的进程」的**权威**来源:它们正是本 sidecar 的子孙,
        // 按进程树剔自己人时会被一起剔光 —— 光靠 cwd/进程树只能猜,猜不出归属。
        if (msg.type === "system" && msg.subtype === "background_tasks_changed") sess.bgTasks = msg.tasks ?? [];
        // 用户主动打断也走 error 路径,与真实报错无法从 subtype 区分,靠自己记的标记
        if (msg.type === "result") {
          if (sess.userInterrupted) msg = { ...msg, aborted: true };
          else { const title = loadIndex().find((e) => e.id === id)?.title || tr("会话"); pushOverlay(tr("任务完成"), tr("{{title}} 已完成", { title })); } // 用户主动中断不推
          sess.running = false;
          sess.freshDone = !msg.aborted; // 完成过一轮(非中断)→ 列表绿✅
          sess.userInterrupted = false;
          bumpSpend(id, msg); // 花费账本(按量计费的 provider 靠它显示用量);内含 saveIndex
          broadcastIndex(); // 列表图标转「完成/空闲」
          refreshSubscriptionUsage();
          drainMsgQueue(id, sess); // 本轮跑完 → 放出排队的下一条(手机在不在线都照跑)
        }
        // SDK 会把我们发的这轮输入原样回吐一条 user 消息,且大图会被降级成
        // "[Image: original …]" 文本占位。真实输入我们已在 user_message 分支落盘+广播过,
        // 这条回吐既重复又把图变成文字,直接丢掉(带 tool_result 的 user 消息是真结果,必须保留)。
        const inputEcho = msg.type === "user" && Array.isArray(msg.message?.content)
          && msg.message.content.some((b) => b.type === "text" || b.type === "image")
          && !msg.message.content.some((b) => b.type === "tool_result");
        if (inputEcho) continue;
        appendLog(id, msg); // 该不该落盘由 keepInLog 统一判(流式增量、回放用不上的 system 都会被挡掉)
        broadcast({ type: "sdk", sessionId: id, message: msg }); // 发给所有客户端(含手机),前端各自按 sessionId 过滤
      }
    } catch (e) {
      if (gen !== sess.generation) return; // 已被重启,旧循环的报错忽略
      // resume 到找不到 transcript 的目录会 exit 1(常因历史 cwd 与当前不符)——自动降级为全新上下文继续,而不是把会话卡死在“已断开”
      if (resume && /No conversation found/i.test(stderrBuf)) {
        sess.sdkSessionId = null;
        const idx = loadIndex();
        const entry = idx.find((e) => e.id === id);
        if (entry) { entry.sdkSessionId = null; saveIndex(idx); }
        broadcast({ type: "system_note", sessionId: id, text: tr("⚠️ 原对话上下文无法恢复,已在当前目录开启全新上下文继续") });
        spawnAgent(ws, sess, { id, resume: undefined });
        return; // 已重建,不走下面的清理
      }
      const detail = stderrBuf.trim().split("\n").filter(Boolean).slice(-3).join(" · ");
      broadcast({ type: "session_error", sessionId: id, error: detail ? `${e} — ${detail}` : String(e) });
    }
    if (gen === sess.generation) { // 非重启导致的自然结束才清理
      broadcast({ type: "session_closed", sessionId: id });
      sessions.delete(id);
    }
  })();
}

// 强制收尾本轮 —— 重建 query 会用 generation 作废旧循环,那条 result 永远不会再来,
// running 就一直挂着:前端 status 卡在「运行中」,打断按钮点了没反应,待发队列也永远放不出去。
// 所以凡是绕过 result 结束一轮的路径(重启 / 打断兜底)都要显式收尾并通知前端。
function endTurn(id, sess) {
  sess.running = false;
  sess.userInterrupted = false;
  broadcastIndex();
  broadcast({ type: "turn_ended", sessionId: id });
  drainMsgQueue(id, sess);
}

// ---------- 待发队列(agent 忙时压在 sidecar 这边) ----------
// 队列必须在这台一直开着的机器上,不能在手机 App 的内存里:手机息屏就收不到"本轮跑完了",
// 消息会一直躺到用户下次打开 App。上限 3,与两端 UI 一致。
const MSG_QUEUE_MAX = 3;
const queueText = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b.type === "text").map((b) => b.text).join(" ").trim()
  || ((Array.isArray(content) && content.some((b) => b.type === "image")) ? "[图片]" : "");

function broadcastMsgQueue(id, sess) {
  broadcast({ type: "msg_queue", sessionId: id, items: sess.msgQueue.map((x) => ({ pid: x.pid, text: x.text })) });
}

function enqueueMsg(ws, sess, m) {
  if (sess.msgQueue.length >= MSG_QUEUE_MAX) {
    send(ws, { type: "system_note", sessionId: m.sessionId, text: tr("待发已满(最多 {{n}} 条)", { n: MSG_QUEUE_MAX }) });
    return;
  }
  // pid 由 sidecar 发,两端都拿这个来取消 —— 手机自己编的 id 换台设备就对不上了
  sess.msgQueue.push({ pid: `${Date.now()}-${sess.msgQueue.length}`, text: queueText(m.content), ws, m });
  broadcastMsgQueue(m.sessionId, sess);
}

function drainMsgQueue(id, sess) {
  const next = sess.msgQueue.shift();
  if (!next) return;
  broadcastMsgQueue(id, sess);
  // 不带发送方 ws:排队期间发送方没有乐观渲染过这条(它当时只画了「排队中」那一行),
  // 广播给所有端才看得到气泡;当初那条连接多半也已经断了(手机息屏)。
  deliverUserMessage(null, next.m);
}

// 把一条用户消息真正送进 agent(落盘 + 回显 + 注入动态上下文 + pushTurn)。
// 单独抽出来是因为 agent 忙的时候这条消息要先躺进 sess.msgQueue,等本轮跑完再原样走一遍这里。
function deliverUserMessage(ws, m) {
  let sess = sessions.get(m.sessionId);
  if (!sess) {
    // 会话不在内存里(最常见:sidecar 重启 / 换过进程,前端仍以为会话是活的)—— 别再静默丢消息。
    // 用落盘的 index 记录自动 resume 起会话(sdkSessionId 恢复上下文;失效时 spawnAgent 会兜底开新上下文),
    // 再把这条消息送进去;连记录都没有(会话已删)才回错误让前端提示重连。
    const entry = loadIndex().find((e) => e.id === m.sessionId);
    if (!entry) { send(ws, { type: "session_error", sessionId: m.sessionId, error: tr("会话不存在或已被删除,请新建会话重试") }); return; }
    startSession(ws, { id: m.sessionId, cwd: entry.cwd, resume: entry.sdkSessionId ?? undefined });
    sess = sessions.get(m.sessionId);
    if (!sess) { send(ws, { type: "session_error", sessionId: m.sessionId, error: tr("会话重建失败,请重开该会话") }); return; }
  }
  sess.running = true; // 同步置位:重建 agent 期间(下面的 await)点停止也要算数
  sess.turnStart = Date.now(); // 打包产物上传的时间水位:只收本轮之后新出的文件
  const userMsg = {
    type: "user",
    message: { role: "user", content: m.content }, // content: [{type:'text'...},{type:'image'...}]
    parent_tool_use_id: null,
    session_id: sess.sdkSessionId ?? "",
  };
  // 每轮随消息注入的动态上下文(只进模型输入,不落盘/不回显)。
  // 为什么不塞 systemPrompt:那是 prompt 缓存的最前缀,SSH 断连/git 提交一变就把整段缓存冲掉;
  // per-message 注入只影响当前这条新消息,之前的历史前缀照样命中。
  // 斜杠命令(/compact、/code-review high …)整条会被 CLI 当命令行解析,命令名之后的内容就是参数 ——
  // 给 /compact 尾巴上挂一段 git 状态,就变成"照这段状态去压缩上下文"。这类消息一律原样发,不注入任何东西。
  // 用 (\s|$) 收尾:绝对路径开头的普通消息("/Users/tou/x 这个文件…")不会被误判成命令。
  const body = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
  const isSlashCmd = body.length === 1 && body[0]?.type === "text"
    && /^\/[a-zA-Z][\w-]*(\s|$)/.test(String(body[0].text || "").trim());
  const notes = [];
  if (!isSlashCmd) {
    const s = sess.ssh?.status === "connected" ? sess.ssh : null;
    const prefix = s && `ssh -o ControlPath=${sshSock(m.sessionId)}`
      + (s.port ? ` -p ${s.port}` : "")
      + (s.keyPath ? ` -i ${s.keyPath} -o IdentitiesOnly=yes` : "")
      + ` ${s.target}`;
    // 连上/换机器时发全文;一直连着就不重发(全文还躺在历史里);断开要主动说一声 ——
    // 原先断开是"什么都不发",agent 只会继续以为远端还连着。
    const note = noteOnChange(sess, "ssh", s ? `${s.target}|${s.port || ""}|${s.cwd || ""}` : "off",
      s ? `[系统提示·SSH] 本会话已连接远端服务器 ${s.target}${s.cwd ? `(远端当前目录 ${s.cwd})` : ""}。`
          + `你的工具默认在本机执行;要在该远端跑命令,用下面这个复用已建连接(master 已就绪,无需再认证)的前缀:\n`
          + `${prefix} '<remote command>'\n`
          + `例:${prefix} 'cat /path/to/.env'。不要再假设不知道主机名/路径。`
        : "[系统提示·SSH] 远端连接已断开,后续命令一律在本机执行,不要再用之前那个 ssh 前缀。",
      null);
    if (note) notes.push(note);
  }
  appendLog(m.sessionId, userMsg);
  // 会话列表副标题要"始终显示最新用户消息"(重启后内存无 timeline,得靠 index 落盘)。把这条文本存进 index 并广播。
  {
    const txt = (Array.isArray(m.content) ? m.content : [])
      .filter((b) => b.type === "text").map((b) => b.text).join(" ").trim()
      || ((Array.isArray(m.content) && m.content.some((b) => b.type === "image")) ? "[图片]" : "");
    if (txt) {
      const idx = loadIndex();
      const entry = idx.find((e) => e.id === m.sessionId);
      if (entry && entry.lastUser !== txt) { entry.lastUser = txt; saveIndex(idx); broadcastIndex(); }
    }
  }
  // 把这条用户消息回显给**除发送方外**的所有客户端，否则另一端(如手机发、电脑看)永远看不到对方发的字。
  // 发送方自己已乐观渲染，排除它避免重复。
  broadcastExcept(ws, { type: "sdk", sessionId: m.sessionId, message: userMsg });
  // 若终端里 !cd 过:把 agent 重建到该目录。总是迁移(不管有没有历史)——
  // agent 的 cwd 只能通过重启 query 真正改变。代价:Claude Code 按目录存 transcript,
  // 无法跨目录接续,所以有历史时是在新目录重开上下文(前端 timeline 仍保留,便于回看)。
  (async () => {
    if (sess.pendingCwd && sess.pendingCwd !== sess.agentCwd) {
      const target = sess.pendingCwd;
      const hadHistory = sess.hadUserTurn;
      sess.pendingCwd = null;
      await restartAgentCwd(ws, sess, m.sessionId, target, true); // 下面马上 pushTurn,本轮不算结束
      send(ws, { type: "system_note", sessionId: m.sessionId, text: hadHistory
        ? tr("📁 已将 agent 工作目录切到 {{target}}(在该目录重开上下文,之前的对话记忆不带过来)", { target })
        : tr("📁 已将 agent 工作目录设为 {{target}}", { target }) });
    }
    sess.hadUserTurn = true;
    // git 现状放在**用户文本之后**:它可能有几十行,搁最前面会把用户真正问的那句挤到很远;
    // 且这是"事实校正",紧贴问题后面近因更强。取 cwd 必须在上面的 pendingCwd 迁移之后。
    const brief = isSlashCmd ? null : await gitBrief(sess.agentCwd || resolveCwd(m.sessionId), sess);
    const content = [...notes.map((text) => ({ type: "text", text })), ...body,
      ...(brief ? [{ type: "text", text: brief }] : [])];
    // 送给 agent 的带注入;日志/回显仍用干净的 userMsg
    pushTurn(sess, content.length === body.length ? userMsg : { ...userMsg, message: { role: "user", content } });
  })();
}

// 用新 cwd 重建 agent —— 打通终端 !cd 与 agent。
// 不 resume,直接在新目录起一个全新 query。Claude Code 按工作目录存 transcript,
// 跨目录 resume 会失败退出,所以迁移目录必然是新上下文(有历史时会丢 agent 记忆)。
// keepRunning:调用方紧接着就 pushTurn(!cd 后发消息那条路),别把本轮标成结束,否则前端会闪一下空闲、
// 把待发队列提前放出去。其余场景都要收尾。
async function restartAgentCwd(ws, sess, id, newCwd, keepRunning = false) {
  const oldQ = sess.q;
  const oldQueue = sess.queue;
  const oldLoop = sess.loopDone;
  sess.generation++;            // 立即作废旧循环:不再转发消息、不做清理
  sess.agentCwd = newCwd;
  sess.sdkSessionId = null;     // 全新会话,丢弃旧 session id
  try { oldQ?.interrupt?.(); } catch {}
  oldQueue?.end();
  await Promise.race([oldLoop, new Promise((r) => setTimeout(r, 5000))]); // 等旧进程退出
  spawnAgent(ws, sess, { id, resume: undefined });
  if (!keepRunning) endTurn(id, sess);
}

// 原地重启 agent(不换目录),用来让新装/启用的插件 · Skills · MCP 生效。
// resume 回原 sdkSessionId 保住上下文;工作中的会话不该调这个(前端只对空闲会话触发)。
async function restartAgent(ws, sess, id) {
  const oldQ = sess.q;
  const oldQueue = sess.queue;
  const oldLoop = sess.loopDone;
  const resume = sess.sdkSessionId ?? undefined;
  sess.generation++;            // 立即作废旧循环
  try { oldQ?.interrupt?.(); } catch {}
  oldQueue?.end();
  await Promise.race([oldLoop, new Promise((r) => setTimeout(r, 5000))]);
  spawnAgent(ws, sess, { id, resume });
  endTurn(id, sess);
}

function send(ws, obj) {
  // ws 可能是 null:待发队列里的消息重放时,当初那条连接早断了(手机息屏),这时只走 broadcast
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

// 会话级输出（agent 流式回复、系统提示、报错、关闭、权限卡片）要发给**所有**连接的客户端，
// 而不是只发给最先 spawn 该会话的那个 ws——否则第二个连到同一活会话的客户端（如手机经 relay
// 接入电脑已打开的会话）发消息能进队列被处理，回复却只回给电脑端，自己永远收不到。
// 前端各自按 sessionId 过滤，广播是安全的（index/usage 本就是这么广播的）。
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

// 同 broadcast 但跳过发送方(用于用户消息回显：发送方已乐观渲染，别再回一份造成重复)。
function broadcastExcept(except, obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c !== except && c.readyState === 1) c.send(s);
}

// ---------- 本地 Anthropic→OpenAI 转译代理 ----------
// 供 Grok / OpenAI-Codex / Gemini 这类只有 OpenAI 兼容端点的 provider 用。端口 = ws 端口 + 100(仅本机)。
const PROXY_PORT = PORT + 100;
setProxyPort(PROXY_PORT);
startProxy({
  port: PROXY_PORT,
  // 按 providerId 给出真正的上游 OpenAI 兼容 baseUrl(合并用户覆盖)
  getUpstream: (id) => { const r = resolvedProvider(id, loadSettings()); return r ? { baseUrl: r.baseUrl } : null; },
});
console.log(`[sidecar] openai-proxy http://127.0.0.1:${PROXY_PORT}`);

// ---------- WebSocket 协议 ----------
// 握手令牌。WebSocket 不受同源策略约束 —— 不校验的话,用户浏览器里任意网页都能连上这个固定的
// loopback 端口,发 terminal_command(落到 bash -lc)或改 provider 的 baseUrl 把 key 和 prompt
// 引走。令牌由 Rust 每次启动随机生成、经 tauri command 只给自家 webview(网页拿不到 IPC)。
// 没设 CHAT_CODE_TOKEN = `npm run dev` 直接起的 sidecar,不校验,开发时浏览器可直连。
const TOKEN = process.env.CHAT_CODE_TOKEN || "";
const tokenOk = (t) => {
  const a = Buffer.from(String(t || "")), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const wss = new WebSocketServer({
  port: PORT,
  host: "127.0.0.1",
  ...(TOKEN ? { verifyClient: ({ req }) => tokenOk(new URL(req.url, "ws://x").searchParams.get("token")) } : {}),
});
wss.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`[sidecar] 端口 ${PORT} 已被占用 —— 可能有上次残留的 sidecar 进程`);
  else console.error("[sidecar]", e);
  process.exit(1);
});
console.log(`[sidecar] ws://127.0.0.1:${PORT}`);

// 步骤C：可选的 relay 出站桥。配了 relay 地址 + host 密钥才启用，让手机经 relay 远程接入本机会话。
// 桥把每个手机 cid 映射成一条本地 ws 客户端，现有会话 handler 无需改动。
if (process.env.CHAT_CODE_RELAY_URL && process.env.CHAT_CODE_HOST_TOKEN) {
  // 稳定机器 id:机器名会被 macOS 网络环境改(同一台机多个名字,relay 注册表就记成多台)。
  // 生成一次落进 settings.json,relay 按 id 去重,机器名只当显示用(改名自动跟随)。
  const st0 = loadSettings();
  if (!st0.hostId) { st0.hostId = crypto.randomUUID(); try { saveSettings(st0); } catch {} }
  import("./relay-bridge.mjs")
    .then((m) => m.startRelayBridge({
      port: PORT,
      relayUrl: process.env.CHAT_CODE_RELAY_URL,
      hostToken: process.env.CHAT_CODE_HOST_TOKEN,
      hostId: st0.hostId,
      // 多 host 路由用:上报本机当前在跑的会话,relay 据此选「最近有活跃会话」的那台转发
      getActiveSessions: () => [...sessions.values()].filter((s) => s?.running).map((s) => s.sdkSessionId).filter(Boolean),
    }))
    .catch((e) => console.error("[relay-bridge] 启动失败:", e.message));
}

// 由 app 拉起时(Rust 会注入 CHAT_CODE_PORT):父进程一旦消失就自杀。
// 否则 app 被强杀/崩溃后 node 子进程会被孤儿化并一直占着端口,下次启动直接 EADDRINUSE。
if (process.env.CHAT_CODE_PORT) {
  setInterval(() => { if (process.ppid === 1) process.exit(0); }, 2000).unref();
}

// 定时刷新订阅限额(账户级,广播给所有窗口)。跑起来的时候额度掉得快 —— 一轮就能吃掉几个百分点,
// 60s 一刷会明显落后于 Claude 官方客户端;而这个请求不花额度,加密不亏。空闲时没人烧额度,慢点无所谓。
const USAGE_POLL_BUSY = 15_000, USAGE_POLL_IDLE = 60_000;
function scheduleUsagePoll() {
  // stale 时也按 busy 的快节奏轮询,尽快从"刷不上的旧快照"里恢复(探针需要几拍才热起来)。
  const busy = [...sessions.values()].some((s) => s.running) || lastUsage?.stale;
  setTimeout(async () => {
    await refreshSubscriptionUsage();
    refreshKimiUsage(); // 独立 HTTP,不和 Claude 探针互相拖慢
    scheduleUsagePoll(); // 下一拍的快慢由"刷新完之后"的忙闲状态决定
  }, busy ? USAGE_POLL_BUSY : USAGE_POLL_IDLE).unref();
}
scheduleUsagePoll();
// 首拍要等一整个 IDLE(60s),这期间界面只能拿落盘的旧快照顶着 —— 那是上次退出时的值,开机看就是没刷新。
// 启动即异步拉一次(不 await,不挡建连),顺手把探针提前拉起来预热(它 4s 后自己重试到拿真值为止)。
refreshSubscriptionUsage();
refreshKimiUsage();
// 账户余额单独一个慢拍:它只随消费变化,不需要跟着 5h 额度那种 15s 快节奏刷。
refreshBalances();
setInterval(refreshBalances, 60_000).unref();

wss.on("connection", (ws) => {
  send(ws, { type: "index", sessions: indexWithStatus(), groups: loadGroups() });
  if (lastUsage || lastKimiUsage) send(ws, { type: "usage", usage: lastUsage, kimiUsage: lastKimiUsage });
  else { refreshSubscriptionUsage(); refreshKimiUsage(); }
  send(ws, { type: "wallet", wallet: walletPayload() }); // 今日/本月来自落盘账本,新窗口开着就有

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    switch (m.type) {
      case "search_messages": {
        send(ws, { type: "search_results", results: findMessages(m.query, m.sessionId, m.kind) });
        break;
      }
      case "usage_refresh": { // 前端在限额窗口重置那一刻请求即时刷新,不必干等下一拍轮询
        refreshSubscriptionUsage();
        refreshKimiUsage();
        break;
      }
      case "stop_task": { // 停止 agent 起的后台任务(进程面板的「停止」按钮;这类没有 pid,杀不了)
        sessions.get(m.sessionId)?.q?.stopTask(m.taskId).catch(() => {});
        break;
      }
      case "git_info": {
        const cwd = resolveCwd(m.sessionId);
        gitInfo(cwd, m.sessionId).then((info) => send(ws, { type: "git_info", sessionId: m.sessionId, info }));
        break;
      }
      case "git_log": {
        const cwd = resolveCwd(m.sessionId);
        gitLog(cwd, m.limit).then((data) => send(ws, { type: "git_log", sessionId: m.sessionId, ...data }));
        break;
      }
      case "git_diff": {
        const cwd = resolveCwd(m.sessionId);
        gitDiff(cwd, m.from, m.to).then((data) => send(ws, { type: "git_diff", sessionId: m.sessionId, ...data }));
        break;
      }
      case "commit_suggest": { // commit 弹窗打开时:汇总各轮 AI 已写的「本轮小结」回填输入框(不再二次调 AI,秒回)
        const cwd = resolveCwd(m.sessionId);
        buildCommitMessage(cwd, m.sessionId, !!m.force).then((message) =>
          send(ws, { type: "commit_suggest", sessionId: m.sessionId, ok: !!message, message, error: message ? undefined : tr("暂无可汇总的改动小结") }));
        break;
      }
      case "git_file_diff": {
        const cwd = resolveCwd(m.sessionId);
        gitFileDiff(cwd, m.from, m.to, m.file).then((data) => send(ws, { type: "git_file_diff", sessionId: m.sessionId, ...data }));
        break;
      }
      case "git_compare": {
        const cwd = resolveCwd(m.sessionId);
        (async () => {
          const [stat, log] = await Promise.all([
            execOut("git", ["--no-optional-locks", "diff", "--stat", `${m.base}...${m.head}`], cwd), // 同上:只读比较,别去抢 index.lock
            execOut("git", ["log", "--oneline", `${m.base}..${m.head}`], cwd),
          ]);
          const body = stat.ok ? `分支比较 ${m.base} … ${m.head}\n\n提交差异:\n${log.stdout.trim() || "（无新增提交）"}\n\n文件差异:\n${stat.stdout.trim() || "（无文件差异）"}` : `无法比较分支：${stat.stderr.trim() || "请确认分支存在"}`;
          send(ws, { type: "git_compare", sessionId: m.sessionId, text: body });
        })();
        break;
      }
      case "create_session": {
        const id = crypto.randomUUID();
        const isCasual = !!m.casual;

        let cwd;
        if (isCasual) {
          // 闲聊: 创建临时目录作为 agent 工作空间,删除会话时一并清理
          cwd = path.join(DATA_DIR, "casual", id);
          try { fs.mkdirSync(cwd, { recursive: true }); }
          catch (e) { send(ws, { type: "session_error", sessionId: id, error: tr("无法创建闲聊临时目录: {{err}}", { err: e.message }) }); break; }
        } else {
          // cwd 必须由前端明确给出。以前是 `m.cwd || os.homedir()`：cwd 为空时会静默把会话建到用户主目录,
          // agent 随后就在 ~ 里乱建文件、甚至克隆出多余仓库(如 ~/chat-code)。改为空 cwd 直接拒绝,不再兜底 home。
          const raw = String(m.cwd ?? "").trim();
          if (!raw) { send(ws, { type: "session_error", sessionId: id, error: tr("未指定项目目录,已取消新建会话(不再默认落到用户主目录)") }); break; }
          cwd = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
          if (!path.isAbsolute(cwd)) { send(ws, { type: "session_error", sessionId: id, error: tr("项目目录必须是绝对路径: {{path}}", { path: raw }) }); break; }
          // 新建项目空间时允许输入尚不存在的末级目录；失败则把明确原因返回给前端。
          try { fs.mkdirSync(cwd, { recursive: true }); }
          catch (e) { send(ws, { type: "session_error", sessionId: id, error: tr("无法创建项目目录 {{dir}}: {{err}}", { dir: cwd, err: e.message }) }); break; }
        }

        const title = m.title || (isCasual ? tr("闲聊") : cwd.split("/").filter(Boolean).pop() || tr("新会话"));
        const idx = loadIndex();
        idx.unshift({
          id, title, cwd,
          sdkSessionId: null, createdAt: Date.now(),
          inheritFrom: m.inheritFrom ?? null, // 母会话条目 id(树形归属),与 resume(SDK 上下文)区分
          ...(m.model && m.model !== "default" ? { model: m.model } : {}), // 首页选的模型:spawnAgent 启动即按此(savedModel)
          ...(isCasual ? { casual: true } : {}),
        });
        saveIndex(idx);
        startSession(ws, { id, cwd, resume: m.resume });
        send(ws, { type: "session_created", sessionId: id, cwd, title, resume: m.resume ?? null, inheritFrom: m.inheritFrom ?? null, casual: isCasual || undefined });
        break;
      }
      case "blob_get": {
        // 历史里的图片按需取:hover 预览只要 512px 缩略图(thumbFor 带 hash 缓存),
        // 点开大图才回原图。取不到就回 data:null,前端显示"图片已失效",别让它一直转圈。
        const data = blobGet(m.key);
        if (!data) { send(ws, { type: "blob", key: m.key, full: !!m.full, data: null }); break; }
        if (m.full) { send(ws, { type: "blob", key: m.key, full: true, media_type: m.mediaType || "image/png", data }); break; }
        thumbFor(data, m.mediaType || "image/png")
          .then((t) => send(ws, { type: "blob", key: m.key, full: false, media_type: t.media_type, data: t.data }));
        break;
      }
      case "restart_session": {
        // 让新装/启用的插件 · Skills · MCP 生效:原地重启活会话的 SDK query。
        // 只对内存里活着且不在跑的会话生效;工作中的由前端拦下不发,防打断任务。
        const s = sessions.get(m.sessionId);
        if (s && !s.running) restartAgent(ws, s, m.sessionId);
        break;
      }
      // 手机滑到顶要更早的消息:只重发一份更大的 history,不碰会话本身
      // (reopen_session 会顺带起会话 / 弹恢复卡 / 回一串状态包,翻个历史不该有这些动静)。
      case "more_history": {
        const entry = loadIndex().find((e) => e.id === m.sessionId);
        if (!entry) return;
        const log = readLog(entry.id).filter((msg) => !isCaptionEcho(msg));
        buildMobileHistory(log, m.limit || 20).then((messages) => send(ws, { type: "history", sessionId: entry.id, messages }));
        break;
      }
      case "reopen_session": {
        // f: 继承历史 —— 用 SDK 的 resume 接上原来的上下文
        const entry = loadIndex().find((e) => e.id === m.sessionId);
        if (!entry) return;
        const log = readLog(entry.id).filter((msg) => !isCaptionEcho(msg));
        // haveHistory: 前端已渲染过该会话就别再回 history,避免重新选中已打开会话时整段历史被再 append 一遍(重复消息)
        // limit(手机端传):按气泡取最近 N 个并剥重内容(见 buildMobileHistory)。
        // 整份日志可达数十 MB(含全尺寸 base64 图/整份文件的工具入参)，一次性发给手机会 OOM 闪退或被 relay 丢帧卡加载。桌面不传 limit，仍取全量。
        // 手机那份要转缩略图(异步),桌面同步走原路。history 晚一点到不影响后面的 session_ctx 等包。
        if (!m.choice && !m.haveHistory) {
          if (m.limit) buildMobileHistory(log, m.limit).then((messages) => send(ws, { type: "history", sessionId: entry.id, messages }));
          else send(ws, { type: "history", sessionId: entry.id, messages: log });
        }
        // 重开先按日志实算的上下文体积回填进度条,别等下一轮 message_start(否则重启后占比掉到 1%)
        const tokens = contextSize(log);
        if (tokens) send(ws, { type: "session_ctx", sessionId: entry.id, tokens });
        if (!sessions.has(entry.id)) {
          // 大会话完整恢复会吃掉可观的额度,先问一句(除非用户选过"不再询问")
          if (!m.choice && entry.sdkSessionId && tokens >= RESUME_ASK_TOKENS && !loadSettings().resumeAlwaysFull) {
            send(ws, { type: "resume_prompt", sessionId: entry.id, tokens, ageMs: Date.now() - (entry.createdAt ?? Date.now()) });
            break; // 等前端回一条带 choice 的 reopen_session 再真正启动
          }
          // 取消 = 这一轮开全新对话:不接历史上下文(resume: undefined),但旧日志一个字都不动 ——
          // 用户明确要留着旧记录。代价是下次重开这个会话仍会按旧历史体积再弹一次恢复卡,这是用户接受的。
          const fresh = m.choice === "fresh";
          startSession(ws, {
            id: entry.id, cwd: entry.cwd,
            resume: fresh ? undefined : (entry.sdkSessionId ?? undefined),
            compactFirst: m.choice === "summary",
          });
        }
        const s = sessions.get(entry.id);
        // 回显当前"自动同意"开关(内存优先,未启动则读持久化的 index),让重连端同步显示
        send(ws, { type: "auto_approve", sessionId: entry.id, on: s ? !!s.autoApprove : !!entry.autoApprove });
        send(ws, { type: "msg_queue", sessionId: entry.id, items: (s?.msgQueue || []).map((x) => ({ pid: x.pid, text: x.text })) }); // 重连要看到还压着的待发
        send(ws, { type: "perm_mode", sessionId: entry.id, mode: s?.permMode || entry.permMode || "default" });
        if (entry.spend) send(ws, { type: "spend", sessionId: entry.id, spend: entry.spend }); // 花费是落盘累计,重开要接上
        if (s?.ssh) send(ws, { type: "ssh_status", sessionId: entry.id, ssh: pubSsh(s.ssh) }); // 恢复 SSH 显示
        // 模型列表只在 spawnAgent 时推过一次;重开(尤其是换个客户端连上来)要补一份,
        // 否则 /model 菜单是空的,上下文窗口也判断不出 1M。
        reportModels(ws, entry.id, s?.q);
        // 当前卡着的那张授权/提问卡只在发生时广播过一次。手机(m.limit)可能是事后才连上/重启进来的,
        // 补发一份,否则 AskUserQuestion 在手机上永远看不到、会话就一直卡着。桌面走 timeline 回放,不补。
        if (m.limit && s?.activePermission) {
          const p = s.pendingPerms.get(s.activePermission);
          if (p) send(ws, { type: "permission_request", sessionId: entry.id, requestId: s.activePermission, toolName: p.toolName, input: p.input });
        }
        break;
      }
      case "user_message": {
        // agent 正忙:消息压在 sidecar 这边排队,本轮跑完自动送进去。
        // 以前排队是压在手机 App 的内存里 —— 手机一息屏/切后台就没人盯着"跑完了没",
        // 晚上发的消息能一直躺到第二天早上重新打开 App 才发出去。
        const q = sessions.get(m.sessionId);
        if (q?.running) { enqueueMsg(ws, q, m); break; }
        deliverUserMessage(ws, m);
        break;
      }
      case "cancel_queued": {
        const sess = sessions.get(m.sessionId);
        if (!sess) return;
        sess.msgQueue = sess.msgQueue.filter((x) => x.pid !== m.pid);
        broadcastMsgQueue(m.sessionId, sess);
        break;
      }
      case "permission_response": {
        const sess = sessions.get(m.sessionId);
        const pending = sess?.pendingPerms.get(m.requestId);
        if (!pending) return;
        sess.pendingPerms.delete(m.requestId);
        if (sess.activePermission === m.requestId) sess.activePermission = null;
        else sess.permissionQueue = sess.permissionQueue.filter((p) => p.requestId !== m.requestId);
        pending.resolve(
          m.behavior === "allow"
            // updatedPermissions:用户点了"允许并记住",把 SDK 给的那条 suggestion 回填,
            // SDK 据此落规则(addRules -> .claude/settings.local.json;setMode/addDirectories -> 本会话)
            ? { behavior: "allow", updatedInput: pending.input,
                ...(m.updatedPermissions?.length ? { updatedPermissions: m.updatedPermissions } : {}) }
            : { behavior: "deny", message: m.message || tr("用户拒绝了此操作") }
        );
        // 广播"该请求已处理",让另一端(如手机)的授权卡片自动消失,而不是一直挂着
        broadcast({ type: "permission_resolved", sessionId: m.sessionId, requestId: m.requestId, behavior: m.behavior });
        showNextPermission(ws, sess, m.sessionId);
        broadcastIndex(); // 队列空了→图标转回「运行中」
        break;
      }
      case "interrupt": {
        const sess = sessions.get(m.sessionId);
        // 服务端这轮其实早结束了(点得晚了 / 前端 status 漏更新卡在运行中):
        // 别静默 break —— 那正是「按钮点了没反应」的样子。回一条收尾让前端自愈。
        if (!sess?.running) { broadcast({ type: "turn_ended", sessionId: m.sessionId }); break; }
        // 第二次点:上一次的 interrupt 没能让 CLI 吐出 result(卡死),硬拔重启 query。
        // resume 回原 sdkSessionId,上下文不丢;restartAgent 内部会 endTurn 通知前端。
        if (sess.userInterrupted) {
          broadcast({ type: "system_note", sessionId: m.sessionId, text: tr("⛔ 打断没生效,已强制重启 agent(上下文保留)") });
          restartAgent(ws, sess, m.sessionId).catch(() => endTurn(m.sessionId, sess));
          break;
        }
        sess.userInterrupted = true; // 让随后那条 result 显示成"用户终止运行"
        sess.q?.interrupt?.()?.catch?.(() => {}); // CLI 已死时会 reject,别掀翻 sidecar
        break;
      }
      case "get_models": {
        reportModels(ws, m.sessionId, sessions.get(m.sessionId)?.q);
        break;
      }
      case "set_model": {
        // 落盘所选模型,重开软件后按此启动(否则每次回到 SDK 默认)
        const idx = loadIndex();
        const entry = idx.find((e) => e.id === m.sessionId);
        const prev = entry?.model;
        if (entry) { entry.model = m.model; saveIndex(idx); }
        const sess = sessions.get(m.sessionId);
        // 换 provider(如 Claude ↔ DeepSeek)必须带新 env 重启 query —— setModel 只能在同一 provider 内切模型,
        // 且换 provider = 新对话(Claude 的上下文接不到 DeepSeek)。同 provider 内切模型仍走 setModel,保上下文。
        if (sess && providerOf(prev) !== providerOf(m.model)) {
          const label = PROVIDERS[providerOf(m.model)]?.label ?? providerOf(m.model);
          broadcast({ type: "system_note", sessionId: m.sessionId, text: tr("🔀 已切换到 {{label}}(换 provider 会开启全新对话)", { label }) });
          restartAgentCwd(ws, sess, m.sessionId, sess.agentCwd);
        } else {
          sess?.q?.setModel?.(m.model === "default" ? undefined : modelArg(m.model))?.catch?.(() => {});
        }
        break;
      }
      case "set_provider_key": {
        // 存本地 settings(明文,仅本机),绝不进仓库/keychain。空 key = 清除。
        const s = loadSettings();
        s.providerKeys = { ...(s.providerKeys || {}) };
        s.providerEndpoint = { ...(s.providerEndpoint || {}) };
        delete s.providerEndpoint[m.provider]; // 换/清 key:旧探测结果对新 key 未必成立,一律作废重探
        if (m.apiKey) s.providerKeys[m.provider] = String(m.apiKey); else delete s.providerKeys[m.provider];
        saveSettings(s);
        authStatus().then((status) => send(ws, { type: "auth_status", status }));
        // 新配置的 provider 模型要能立刻在 /model 菜单里选到
        for (const [sid, sess] of sessions) reportModels(ws, sid, sess.q);
        // 探端点(哪个域名认这把 key)→ 探完再刷用量/余额,顺带把定下来的 baseUrl 推给前端
        reprobeProvider(m.provider, ws);
        break;
      }
      case "set_provider_config": {
        // 覆盖某 provider 的 baseUrl / 模型表(存本地 settings.providerConfig)。空 patch = 清除覆盖回默认。
        const s = loadSettings();
        s.providerConfig = { ...(s.providerConfig || {}) };
        const patch = m.config || {};
        const clean = {};
        if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) clean.baseUrl = patch.baseUrl.trim();
        if (typeof patch.smallFast === "string" && patch.smallFast.trim()) clean.smallFast = patch.smallFast.trim();
        if (Array.isArray(patch.models) && patch.models.length) clean.models = patch.models;
        if (Object.keys(clean).length) s.providerConfig[m.provider] = clean;
        else delete s.providerConfig[m.provider];
        saveSettings(s);
        authStatus().then((status) => send(ws, { type: "auth_status", status }));
        for (const [sid, sess] of sessions) reportModels(ws, sid, sess.q);
        // 手填了 baseUrl 就只剩一个候选(probeEndpoint 直接跳过);清空覆盖则候选恢复成两个,重探
        reprobeProvider(m.provider, ws);
        break;
      }
      case "set_cn_endpoint": {
        // 国内节点开关:GLM/Qwen/MiniMax 的国际域名在国内要么慢要么连不上,各家另有一套国内域名。
        // 现在它只是探测的**优先顺序**(见 endpointsOf) —— 两边都认这把 key 时听它的,
        // 只有一边认时以探测为准。切了就把相关 provider 的旧探测结果作废重探。
        const s = loadSettings();
        s.cnEndpoint = !!m.on;
        s.providerEndpoint = { ...(s.providerEndpoint || {}) };
        const affected = Object.values(PROVIDERS).filter((p) => p.baseUrlCN && s.providerKeys?.[p.id]).map((p) => p.id);
        for (const id of affected) delete s.providerEndpoint[id];
        saveSettings(s);
        authStatus().then((status) => send(ws, { type: "auth_status", status }));
        for (const id of affected) reprobeProvider(id, ws);
        break;
      }
      case "set_lang": {
        // 前端语言切换同步过来,持久化后所有后续消息按此语言出
        setLang(m.lang);
        break;
      }
      case "set_perm_mode": {
        // SDK 权限模式(default / acceptEdits / plan …)。与"自动同意"是两个独立旋钮,
        // 前端把它们打包成「权限档位」一个选择器,但写入仍各走各的正规入口(见 permissions.ts)。
        const mode = String(m.mode || "default");
        const sess = sessions.get(m.sessionId);
        if (sess) sess.permMode = mode;
        const idx = loadIndex();
        const entry = idx.find((e) => e.id === m.sessionId);
        if (entry) { entry.permMode = mode; saveIndex(idx); }
        // 会话没起来也要落盘 + 广播:下次 spawnAgent 会把它带进 options
        sess?.q?.setPermissionMode(mode).catch(() => {});
        broadcast({ type: "perm_mode", sessionId: m.sessionId, mode });
        break;
      }
      case "set_auto_approve": {
        // 会话级"自动同意"。任一端(桌面/手机)可开关,落 index 持久化,广播给所有端同步。
        const on = !!m.on;
        const sess = sessions.get(m.sessionId);
        if (sess) sess.autoApprove = on;
        const idx = loadIndex();
        const entry = idx.find((e) => e.id === m.sessionId);
        if (entry) { entry.autoApprove = on; saveIndex(idx); }
        broadcast({ type: "auto_approve", sessionId: m.sessionId, on });
        // 开启时把当下卡着的授权一并放行(否则还得手点一次),并让各端卡片消失
        if (on && sess) {
          for (const [rid, p] of sess.pendingPerms) {
            if (p.toolName === "AskUserQuestion") continue; // 提问卡保留
            p.resolve({ behavior: "allow", updatedInput: p.input });
            sess.pendingPerms.delete(rid);
            broadcast({ type: "permission_resolved", sessionId: m.sessionId, requestId: rid, behavior: "allow" });
          }
          sess.permissionQueue = sess.permissionQueue.filter((q) => q.toolName === "AskUserQuestion");
          // 仅当"当前显示的卡片"确实被抽干(不再 pending)才清指针并 surface 下一张;
          // 若当前正是提问卡(未被抽干),保持原样,别误清或重复弹出。
          if (sess.activePermission && !sess.pendingPerms.has(sess.activePermission)) {
            sess.activePermission = null;
            showNextPermission(ws, sess, m.sessionId);
          }
        }
        break;
      }
      case "clear_context": {
        // /clear:在同一目录重起一个全新 query,丢弃旧上下文(SDK 无 clear 方法,靠重启实现)
        const sess = sessions.get(m.sessionId);
        if (sess) {
          try { fs.writeFileSync(path.join(SESS_DIR, `${m.sessionId}.jsonl`), ""); } catch {} // 清历史,重连不再带回旧对话
          const wm = loadCommitWm(); if (m.sessionId in wm) { delete wm[m.sessionId]; saveCommitWm(wm); } // 日志清空,小结水位一并归零
          // 列表副标题的 lastUser 也一起抹掉并广播,否则侧栏还挂着清空前的最近消息
          {
            const idx = loadIndex();
            const entry = idx.find((e) => e.id === m.sessionId);
            if (entry && entry.lastUser) { delete entry.lastUser; saveIndex(idx); broadcastIndex(); }
          }
          restartAgentCwd(ws, sess, m.sessionId, sess.agentCwd);
          send(ws, { type: "system_note", sessionId: m.sessionId, text: tr("🧹 上下文已清空,开始全新对话") });
        }
        break;
      }
      case "terminal_command": {
        // ! 前缀的 shell 命令 —— 非交互式执行,捕获输出;末尾打印 PWD 与退出码,让 cd 在会话内持久
        const sess = sessions.get(m.sessionId);
        // !ssh user@host -> 建立持久连接;已连则命令跑远端
        const sshM = m.command.trim().match(/^ssh\s+(.+)/);
        if (sess && sshM) {
          const { target, port } = parseSsh(sshM[1]);
          if (!target) send(ws, { type: "terminal_result", sessionId: m.sessionId, command: m.command, cwd: sess.termCwd || sess.agentCwd || resolveCwd(m.sessionId), output: tr("用法: !ssh [-p 端口] user@host"), exitCode: 1 });
          else sshDial(ws, sess, m.sessionId, target, port);
          break;
        }
        if (sess?.ssh?.status === "connected") { sshRun(ws, sess, m.sessionId, m.command); break; }
        // termCwd 为空(如刚断开 SSH 被清空)时回落到会话项目目录,而不是家目录 —— 否则命令跑在 ~/,PWD 回传后 dir-bar 被切到根目录
        const cwd0 = sess?.termCwd || sess?.agentCwd || resolveCwd(m.sessionId);
        const script = `${m.command}\n__ec=$?; printf '\\0%s\\0%s' "$PWD" "$__ec"`;
        execFile("bash", ["-lc", script], { cwd: cwd0, timeout: 30000, maxBuffer: 4 << 20, env: safeEnv() }, (err, stdout, stderr) => {
          let output = stdout || "", newCwd = cwd0, ec = err?.code ?? 0;
          const parts = output.split("\0");
          if (parts.length >= 3) { output = parts[0]; newCwd = parts[1].trim() || cwd0; ec = Number(parts[2]) || 0; }
          if (stderr) output += stderr;
          if (err && err.killed) output += `\n${tr("[命令超时,已终止]")}`;
          if (sess) {
            sess.termCwd = newCwd;
            // 打通 agent:标记待同步目录,下次给 agent 发消息前再重建其 query(避免每次 cd 都重启)
            sess.pendingCwd = newCwd !== sess.agentCwd ? newCwd : null;
          }
          // commit 成功:推进小结水位到当前条数,下次 commit 只汇总此后的新小结(不重复已提交的)
          if (ec === 0 && /\bgit\b[\s\S]*\bcommit\b/.test(m.command) && !/--dry-run/.test(m.command)) {
            const wm = loadCommitWm(); wm[m.sessionId] = collectRoundSummaries(m.sessionId).length; saveCommitWm(wm);
          }
          send(ws, { type: "terminal_result", sessionId: m.sessionId, command: m.command, cwd: newCwd, cwdChanged: newCwd !== cwd0, output, exitCode: ec });
        });
        break;
      }
      case "ssh_reconnect": {
        const sess = sessions.get(m.sessionId);
        const info = sess?.ssh || loadIndex().find((e) => e.id === m.sessionId)?.ssh;
        if (sess && info?.target) sshDial(ws, sess, m.sessionId, info.target, info.port);
        break;
      }
      case "ssh_configure": {
        const sess = sessions.get(m.sessionId);
        const host = String(m.host || "").trim();
        const username = String(m.username || "").trim();
        const port = String(m.port || "").trim() || undefined;
        const keyPath = String(m.keyPath || "").trim() || undefined;
        if (!sess || !host) break;
        // 允许用户填 user@host，也允许将账号拆开填写；拆开填写优先。
        const target = username ? `${username}@${host.replace(/^.*@/, "")}` : host;
        sess.ssh = { target, port, keyPath, status: "disconnected", cwd: sess.ssh?.cwd || "" };
        persistSsh(m.sessionId, sess.ssh);
        sshDial(ws, sess, m.sessionId, target, port);
        break;
      }
      case "ssh_close": {
        const sess = sessions.get(m.sessionId);
        const wasConnected = !!sess?.ssh;
        if (sess?.ssh) sshExit(m.sessionId, sess.ssh, () => {});
        if (sess) { sess.ssh = null; sess.termCwd = undefined; } // 清掉远端 cwd,回落本地项目目录
        persistSsh(m.sessionId, null);
        sshBroadcast(m.sessionId, null);
        // 对齐"切到远端"的提示:切回本地也给一条,否则用户不知道命令已回到本地执行
        if (wasConnected) {
          const local = loadIndex().find((e) => e.id === m.sessionId)?.cwd || os.homedir();
          send(ws, { type: "terminal_result", sessionId: m.sessionId, command: tr("退出远程连接"), cwd: local, cwdChanged: true,
            output: tr("✅ 已切回本地目录,后续 ! 命令在本地执行"), exitCode: 0 });
        }
        break;
      }
      case "auth_status": {
        authStatus().then((status) => send(ws, { type: "auth_status", status }));
        break;
      }
      case "auth_action": {
        // provider: 'claude'|'github', action: 'login'|'logout' —— 拉起系统 Terminal 跑交互式命令
        const cmd = authCommand(m.provider, m.action);
        if (!cmd) break;
        launchInTerminal(cmd).then((r) => {
          send(ws, { type: "auth_action_result", provider: m.provider, action: m.action,
            ok: r.ok, manual: r.manual, cmd });
          // 交互完成需要时间;延迟刷新一次状态,前端也可自行再拉
          setTimeout(() => authStatus().then((status) => send(ws, { type: "auth_status", status })), 4000);
        });
        break;
      }
      case "ssh_hosts": {
        send(ws, { type: "ssh_hosts", hosts: loadSshHosts() });
        break;
      }
      case "ssh_host_save": {
        // host: { id?, label, host, username?, port?, keyPath? } —— id 为空则新增
        const hosts = loadSshHosts();
        const h = m.host || {};
        if (h.id) {
          const i = hosts.findIndex((x) => x.id === h.id);
          if (i >= 0) hosts[i] = { ...hosts[i], ...h };
          else hosts.push(h);
        } else {
          hosts.push({ ...h, id: crypto.randomUUID() });
        }
        saveSshHosts(hosts);
        send(ws, { type: "ssh_hosts", hosts });
        break;
      }
      case "ssh_host_delete": {
        const hosts = loadSshHosts().filter((x) => x.id !== m.id);
        saveSshHosts(hosts);
        send(ws, { type: "ssh_hosts", hosts });
        break;
      }
      case "ssh_host_test": {
        // 用密钥非交互探活:BatchMode 拒绝密码提示,10s 超时
        const h = m.host || {};
        const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
        if (h.port) args.push("-p", String(h.port));
        if (h.keyPath) args.push("-i", h.keyPath.replace(/^~/, os.homedir()), "-o", "IdentitiesOnly=yes");
        const target = h.username ? `${h.username}@${h.host}` : h.host;
        args.push(target, "echo ok");
        execFile("ssh", args, { timeout: 15000, env: safeEnv() }, (err, stdout, stderr) => {
          send(ws, { type: "ssh_host_test", id: h.id, ok: !err && /ok/.test(stdout || ""),
            detail: err ? sshErrHint(stderr || err.message || "", h.keyPath) : "" });
        });
        break;
      }
      case "close_session": {
        const sess = sessions.get(m.sessionId);
        sess?.queue.end();
        break;
      }
      case "rename_session": {
        const idx = loadIndex();
        const entry = idx.find((e) => e.id === m.sessionId);
        if (entry) {
          entry.title = m.title;
          saveIndex(idx);
          broadcastIndex();
        }
        break;
      }
      case "move_session": {
        const idx = moveSessionInIndex(loadIndex(), m.sessionId, m.groupId ?? null, m.beforeId ?? null);
        saveIndex(idx);
        broadcastIndex();
        break;
      }
      case "create_group": {
        const groups = loadGroups();
        groups.push({ id: crypto.randomUUID(), name: String(m.name || "新分组").trim() || "新分组" });
        saveGroups(groups);
        broadcastIndex();
        break;
      }
      case "rename_group": {
        const groups = loadGroups();
        const g = groups.find((x) => x.id === m.id);
        if (g) { g.name = String(m.name || "").trim() || g.name; saveGroups(groups); broadcastIndex(); }
        break;
      }
      case "delete_group": {
        saveGroups(loadGroups().filter((g) => g.id !== m.id));
        // 组内会话回落到未分组,顺序保持不变
        const idx = loadIndex();
        for (const e of idx) if (e.groupId === m.id) e.groupId = null;
        saveIndex(idx);
        broadcastIndex();
        break;
      }
      case "delete_session": {
        // 关闭并从列表彻底移除:结束运行 + 删索引 + 删历史文件
        sessions.get(m.sessionId)?.queue.end();
        sessions.delete(m.sessionId);
        const idx = loadIndex();
        const entry = idx.find((e) => e.id === m.sessionId);
        const filtered = idx.filter((e) => e.id !== m.sessionId);
        saveIndex(filtered);
        try { fs.unlinkSync(path.join(SESS_DIR, `${m.sessionId}.jsonl`)); } catch {}
        // 闲聊会话: 递归删除临时工作目录,不占磁盘
        if (entry?.casual) {
          try { fs.rmSync(entry.cwd, { recursive: true, force: true }); } catch {}
        }
        for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: "session_deleted", sessionId: m.sessionId }));
        break;
      }
    }
  });
});
