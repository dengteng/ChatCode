// relay 断了但 TCP 还挂着时，桥必须自己发现并重连。
//
// 真实故障（2026-08-30）：relay 判死走 ws.terminate()，不发 close frame；网络路径
// 已断的话本机收不到 FIN，on("close") 永远不触发，手机那头一直「电脑离线」。
// 这里用 autoPong:false 的假 relay 复现「连着但不回 pong」，断言桥会重连。
//
// 跑：node sidecar/relay-heartbeat.test.mjs
import assert from "assert";
import { WebSocketServer } from "ws";
import { startRelayBridge } from "./relay-bridge.mjs";

process.env.CHAT_CODE_RELAY_BEAT_MS = "150";   // 25s 等不起

let conns = 0;
const wss = new WebSocketServer({ port: 0, autoPong: false });   // 收到 ping 装死
wss.on("connection", () => conns++);
await new Promise((r) => wss.once("listening", r));

const bridge = startRelayBridge({
  port: 1,                                  // 本地 sidecar 不需要，没 app_open 就不会连
  relayUrl: `ws://127.0.0.1:${wss.address().port}`,
  hostToken: "t",
  hostName: "test-host",
  getActiveSessions: () => [],
});

// 首连 + 心跳判死(150*2) + 退避重连(1000) → 2s 足够看到第二次连接
await new Promise((r) => setTimeout(r, 2000));
bridge.stop();
wss.close();

assert.ok(conns >= 2, `不回 pong 时桥没重连（只连了 ${conns} 次）`);
console.log(`ok — ${conns} 次连接，心跳判死后确实重连了`);
