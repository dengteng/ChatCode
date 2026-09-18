// 自检:reopen_session 的 session_ctx 要带上下文窗口(ctxWindow),手机端才算得对占比。
// 跑法: node sidecar/ctx-window.test.mjs
//
// 背景:手机端拿到的历史是 buildMobileHistory 裁过的气泡,成功的 result(唯一带 modelUsage 的那种)
// 在 bubbleRole 里就被滤掉了 —— 它自己永远翻不到真窗口,只能吃 200k 默认值。1M 会话因此被放大
// 5 倍:20 万 token 就顶格报「上下文已用 100%,建议压缩」。窗口必须由服务端算好递过去。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ctxwin-"));
const DATA = path.join(tmp, "data"), PORT = 18977;
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });

const S1 = "opus1m", S2 = "glmair";
fs.writeFileSync(path.join(DATA, "index.json"),
  JSON.stringify([{ id: S1, cwd: tmp }, { id: S2, cwd: tmp }]));

const init = (model) => ({ type: "system", subtype: "init", model });
const say = (model, tokens) => ({
  type: "assistant",
  message: { role: "assistant", model, content: [{ type: "text", text: "在的" }], usage: { input_tokens: tokens } },
});
const result = (modelUsage) => ({ type: "result", subtype: "success", modelUsage });

// S1:Opus 1M。modelUsage 这里故意报 200k —— 它确实会这样(桌面端 types.ts 注释记过),
// 所以 [1m] 后缀必须优先于 modelUsage,否则 25% 会被算成 125% 截断显示为 100%。
fs.writeFileSync(path.join(DATA, "sessions", `${S1}.jsonl`),
  [init("claude-opus-5[1m]"),
   say("claude-opus-5[1m]", 250_000),
   result({ "claude-opus-5[1m]": { contextWindow: 200_000 } })].map((m) => JSON.stringify(m)).join("\n") + "\n");

// S2:128k 的第三方主模型 + 跑过子 agent 的 haiku(200k)。取最大值就会错显成 200k。
fs.writeFileSync(path.join(DATA, "sessions", `${S2}.jsonl`),
  [init("glm-4.5-air"),
   say("glm-4.5-air", 64_000),
   result({ "glm-4.5-air": { contextWindow: 128_000 }, "claude-haiku-4-5-20251001": { contextWindow: 200_000 } })]
    .map((m) => JSON.stringify(m)).join("\n") + "\n");

// 清掉握手令牌和 relay:继承外面的 env 会让本地连接被 verifyClient 拒掉,还会顺手连上真 relay
const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA };
for (const k of ["CHAT_CODE_TOKEN", "CHAT_CODE_RELAY_URL", "CHAT_CODE_HOST_TOKEN"]) delete env[k];
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env, stdio: "ignore" });
const done = (code) => { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

setTimeout(() => { console.error("超时:sidecar 没回齐包"); done(1); }, 20000);

const ctx = {}, hist = {};
const check = () => {
  if (!(ctx[S1] && ctx[S2] && hist[S1])) return;
  try {
    // 前提:手机端确实拿不到 result —— 这条塌了,下面两条就没有存在意义了
    assert.ok(!hist[S1].some((m) => m.type === "result"),
      "history 里出现了 result,bug 前提变了,请重新审视 ctxWindow 是否还需要服务端下发");

    assert.strictEqual(ctx[S1].tokens, 250_000, "S1 上下文体积");
    assert.strictEqual(ctx[S1].ctxWindow, 1_000_000, "S1 应按 [1m] 后缀判成 1M,而不是信 modelUsage 的 200k");
    // 真正要防的回归:旧逻辑下这里是 125% → 截断成 100% → 弹压缩提示
    assert.strictEqual(Math.round((ctx[S1].tokens / ctx[S1].ctxWindow) * 100), 25, "S1 占比应是 25%");

    assert.strictEqual(ctx[S2].ctxWindow, 128_000, "S2 应取主模型那一桶,别被子 agent 的 haiku 200k 盖住");
    assert.strictEqual(Math.round((ctx[S2].tokens / ctx[S2].ctxWindow) * 100), 50, "S2 占比应是 50%");

    console.log("PASS: S1 250k/1M=25%(不被 modelUsage 带偏), S2 64k/128k=50%(不被 haiku 盖住)");
    done(0);
  } catch (e) { console.error("FAIL:", e.message); done(1); }
};

const tryConnect = (n = 0) => { // sidecar 起来要一两秒,连不上就重试
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("error", () => { if (n < 40) setTimeout(() => tryConnect(n + 1), 300); else { console.error("连不上 sidecar"); done(1); } });
  ws.on("open", () => {
    for (const id of [S1, S2]) ws.send(JSON.stringify({ type: "reopen_session", sessionId: id, limit: 20 }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "session_ctx") ctx[m.sessionId] = m;
    if (m.type === "history") hist[m.sessionId] = m.messages || [];
    check();
  });
};
tryConnect();
