// 自检:用户自己发的 shell 命令跑着的时候,git_info 的后台 fetch 必须让路。
// 为什么值得一个 e2e:这条路是「commit 完立刻点 push」最常走的一步 —— terminal_result 会顺手刷 git_info,
// 后台 `git fetch --prune` 就正好压在 push 头上,两条连接抢同一个远端,用户看到的是"点了 push 干等好几秒"。
// 反向也得测:计数不回零的话后台刷新就被永久掐死了,顶栏的 领先/落后 会一直是旧的。
//
// 跑法:node sidecar/gitfetch.e2e.mjs   (自己起一个临时 sidecar,跑完清掉,约 15s)
import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PORT = 8988;
const SID = `home:${REPO}`; // home: 前缀 → resolveCwd 直接用这个路径,不必造一个真会话

const env = { ...process.env, CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: "/tmp/cc-gitfetch-e2e" };
delete env.CHAT_CODE_TOKEN; // 不带令牌起 = 不校验,省去握手
const sidecar = spawn("node", [path.join(HERE, "server.mjs")], { env, stdio: "ignore" });
const bye = (code) => { sidecar.kill(); process.exit(code); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只认我们自己那条(maybeFetch 的固定参数),不至于把用户手敲的 git fetch 算进来
const fetching = () => { try { return execFileSync("pgrep", ["-fl", "git.*fetch --quiet --prune"]).toString().trim(); } catch { return ""; } };

await sleep(4000); // 等 sidecar 起来
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
ws.on("error", (e) => { console.error("连不上临时 sidecar:", e.message); bye(1); });
ws.on("open", async () => {
  let during = "";
  ws.send(JSON.stringify({ type: "terminal_command", sessionId: SID, command: "sleep 3" }));
  await sleep(300);
  for (let i = 0; i < 6; i++) { // 那条 sleep 还在跑的 ~2.4s 里反复戳 git_info
    ws.send(JSON.stringify({ type: "git_info", sessionId: SID }));
    await sleep(400);
    during ||= fetching();
  }
  assert.strictEqual(during, "", `命令跑着时仍起了后台 fetch:${during}`);
  console.log("OK 用户命令跑着时没有后台 fetch");

  await sleep(1500); // 等命令结束,计数归零
  let after = "";
  for (let i = 0; i < 10 && !after; i++) { ws.send(JSON.stringify({ type: "git_info", sessionId: SID })); await sleep(150); after = fetching(); }
  assert.ok(after, "命令跑完后仍不 fetch —— 计数没回零,后台刷新被永久掐死了");
  console.log("OK 命令跑完后后台 fetch 恢复:", after.split("\n")[0]);
  bye(0);
});
setTimeout(() => { console.error("超时"); bye(1); }, 40000);
