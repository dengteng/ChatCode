// 自检:commit 文案只收改动还在待提交文件里的轮次(跨项目、已提交、没动文件的小结都不进)。
// 跑法: node sidecar/commit-summary.test.mjs
// 起一个真 sidecar(临时 DATA_DIR + 临时端口),造两轮假日志,走 WS 要 commit_suggest,断言结果。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-commit-"));
const repoA = path.join(tmp, "A"), repoB = path.join(tmp, "B"), repoC = path.join(tmp, "C");
for (const r of [repoA, repoB, repoC]) { fs.mkdirSync(r); execFileSync("git", ["init", "-q"], { cwd: r }); }

const SID = "s1", DATA = path.join(tmp, "data"), PORT = 18975;
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{ id: SID, cwd: repoA }]));

// 时间窗要包住文件 mtime:待提交文件写在「现在」,落进窗口的轮次用 NOW,窗口外的用 OLD
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now(), OLD = NOW - 3600_000;
const user = (t, ts = NOW - 60_000) => ({ type: "user", timestamp: iso(ts), message: { role: "user", content: t } });
const said = (text, ts = NOW + 60_000) => ({ type: "assistant", timestamp: iso(ts), message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (name, input, ts = NOW + 30_000) => ({ type: "assistant", timestamp: iso(ts), message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
// line = 小结那一行的原样文本(要验各种 markdown 包法都认得出来)
const roundRaw = (file, line, ts = OLD) => [user("干活", ts), tool("Edit", { file_path: file }, ts), said(`好了\n\n${line}`, ts)];
const round = (file, summary, ts) => roundRaw(file, `本轮小结：${summary}`, ts);
const bashRound = (command, summary, ts) => [user("干活", ts), tool("Bash", { command }, ts), said(`好了\n\n本轮小结：${summary}`, ts)];

const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repoA });
// clean.ts 已提交且没再改;其余全是待提交改动(含中文文件名、未跟踪的);ignored.xlsx 被忽略
fs.writeFileSync(path.join(repoA, ".gitignore"), "ignored.xlsx\n");
fs.writeFileSync(path.join(repoA, "clean.ts"), "x");
fs.writeFileSync(path.join(repoA, "中文.md"), "x");
git("add", "-A"); git("commit", "-qm", "init");
for (const f of ["a.ts", "c.ts", "d.ts", "ignored.xlsx"]) fs.writeFileSync(path.join(repoA, f), "y");
fs.writeFileSync(path.join(repoA, "中文.md"), "y");
fs.writeFileSync(path.join(repoB, "b.ts"), "y");
fs.writeFileSync(path.join(repoC, "f.ts"), "y");

const log = (rows) => rows.map((m) => JSON.stringify(m)).join("\n") + "\n";
fs.writeFileSync(path.join(DATA, "sessions", `${SID}.jsonl`), log(
  [...round(path.join(repoA, "a.ts"), "改了A项目"),
   ...round(path.join(repoB, "b.ts"), "改了B项目"),
   ...round(path.join(repoA, "clean.ts"), "改的文件已提交不该进"),
   ...round(path.join(repoA, "ignored.xlsx"), "被忽略的文件不该进"),
   ...round(path.join(repoA, "中文.md"), "中文文件名也要认"),
   ...round(path.join(repoA, "c.ts"), "又改了A项目"),
   // agent 顺手去 B 仓库提交:不能把 A 仓库还没提交的小结清掉
   ...bashRound(`cd ${repoB} && git add -A && git commit -qm x`, "B仓库提交不清A,本身也不进", OLD),
   // 强调只包标签、冒号露在外面 —— 弱模型很爱这么写,少认这一种整条汇总就空掉
   ...roundRaw(path.join(repoA, "d.ts"), "**本轮小结**：粗体标签也要认"),
   // 只用 Bash 改文件(python/sed -i)的轮次:拿不到路径,靠期间有待提交文件被改过认
   ...bashRound("python3 - <<'EOF'\nopen('a.ts','w')\nEOF", "Bash 改的也要认", NOW),
   // 只跑 Bash、期间没有待提交文件变化:启动服务、查数据这类不该进
   ...bashRound("nohup uv run python -m webui &", "本地启动控制台不该进", OLD),
   // heredoc 正文里出现 "git commit" 字样(写补丁脚本/测试数据):不是真提交,不能清掉前面的小结
   ...bashRound("cat > /tmp/p.py <<'EOF'\nsub('cd x && git commit -qm y')\nEOF\npython3 /tmp/p.py", "heredoc 里的字样不算提交", NOW),
   // 没调任何工具的纯问答轮,即便写了小结也不收
   user("问问"), said("答\n\n本轮小结：纯问答不该进")]));
// 全部小结都对不上待提交文件:退文件清单,不能拿用户原话凑
fs.writeFileSync(path.join(DATA, "sessions", "s2.jsonl"), log(bashRound("ls", "只是看了看", OLD)));
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{ id: SID, cwd: repoA }, { id: "s2", cwd: repoC }]));

// 清掉握手令牌和 relay:继承外面的 env 会让本地连接被 verifyClient 拒掉,还会顺手连上真 relay
const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

setTimeout(() => { console.error("超时:sidecar 没回包"); done(1); }, 20000);
const want = new Map([
  [SID, "- 改了A项目\n- 中文文件名也要认\n- 又改了A项目\n- 粗体标签也要认\n- Bash 改的也要认\n- heredoc 里的字样不算提交"],
  ["s2", "修改 f.ts"],
]);
const onMsg = (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "commit_suggest") return;
  try {
    assert.strictEqual(m.message, want.get(m.sessionId));
    console.log("PASS:", m.sessionId, JSON.stringify(m.message));
    want.delete(m.sessionId);
    if (!want.size) done(0);
  } catch (e) { console.error("FAIL:", e.message, "\n实际文案:", JSON.stringify(m.message)); done(1); }
};
const tryConnect = (n = 0) => { // sidecar 起来要一两秒,连不上就重试
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("open", () => { for (const sessionId of want.keys()) ws.send(JSON.stringify({ type: "commit_suggest", sessionId, force: true })); });
  ws.on("message", onMsg);
};
tryConnect();
