// 步骤C：sidecar ⇄ relay 出站桥。
//
// relay（独立部署的中转服务）在手机与本机之间加了一层信封。本模块把
// 每个手机会话（cid）映射成一条**真实的 loopback ws 客户端**连到本机 sidecar
// （ws://127.0.0.1:PORT）。这样每个手机在 sidecar 眼里就是普通的一个"浏览器窗口"：
// 天然进入 wss.clients、天然收到 index/usage/广播，现有会话 handler 一行都不用改。
//
// 信封协议：
//   host 收：{t:"app_open"|"app_close", cid} / {t:"app_msg", cid, data}
//   host 发：{t:"to_app", cid, data}（回单个手机）/ {t:"broadcast", data}（回全部）
// 本桥只用 to_app（每条 sidecar 输出按 cid 精确回程；广播场景 sidecar 已逐 client 各发一份）。
import { WebSocket } from "ws";
import os from "os";

export function startRelayBridge({ port, relayUrl, hostToken, hostName, hostId, getActiveSessions }) {
  const HOST_URL = `${relayUrl.replace(/\/$/, "")}/host?token=${encodeURIComponent(hostToken)}`;
  // 回连本机 sidecar 也得带握手令牌(同一进程,直接读 env;没设 = 开发模式,不校验)
  const LOCAL_URL = `ws://127.0.0.1:${port}`
    + (process.env.CHAT_CODE_TOKEN ? `?token=${encodeURIComponent(process.env.CHAT_CODE_TOKEN)}` : "");
  // 手机端用来区分「当前连的是哪台电脑」。优先用显式配的名字，否则用机器名。
  const NAME = hostName || process.env.CHAT_CODE_HOST_NAME || os.hostname();
  // 稳定机器 id(生成方:server.mjs 落盘 settings.json)。relay 按它去重 —— 机器名会被 macOS 网络环境改,
  // 按名字注册会把同一台记成多台;id 不变,名字只当显示用。没传就退回名字(旧 sidecar 行为)。
  const ID = hostId || NAME;
  const log = (...a) => console.log("[relay-bridge]", ...a);

  let relay = null;
  let retry = 0;
  let lastActivityAt = 0; // activity 上报节流
  const locals = new Map(); // cid -> { ws, queue: string[] }

  function closeAllLocals() {
    for (const { ws } of locals.values()) { try { ws.close(); } catch {} }
    locals.clear();
  }

  // 为某个手机会话开一条本地 ws；本地未 OPEN 前发来的消息先排队
  function openLocal(cid) {
    if (locals.has(cid)) return;
    const entry = { ws: null, queue: [] };
    locals.set(cid, entry);
    const lws = new WebSocket(LOCAL_URL);
    entry.ws = lws;
    lws.on("open", () => {
      for (const s of entry.queue.splice(0)) { try { lws.send(s); } catch {} }
    });
    // sidecar → 手机：把本地 ws 的每条输出裹成 to_app 回给 relay
    lws.on("message", (buf) => {
      let data; try { data = JSON.parse(buf.toString()); } catch { return; }
      relaySend({ t: "to_app", cid, data });
      // 多 host 路由:有 SDK 轮就说明本会话活跃,上报当前活跃集合(节流,侧车逐 client 各发一份,会重复)
      if (data?.type === "sdk" && data.message) {
        const now = Date.now();
        if (now - lastActivityAt > 5000) { lastActivityAt = now; relaySend({ t: "activity", sessions: (getActiveSessions?.() ?? []) }); }
      }
    });
    lws.on("close", () => { if (locals.get(cid) === entry) locals.delete(cid); });
    lws.on("error", (e) => log(`本地 ws 出错 cid=${cid}:`, e.message));
  }

  function toLocal(cid, data) {
    const entry = locals.get(cid);
    if (!entry) return; // app_msg 早于 app_open：正常情况下 relay 保证顺序，忽略即可
    const s = JSON.stringify(data);
    if (entry.ws?.readyState === 1) { try { entry.ws.send(s); } catch {} }
    else entry.queue.push(s);
  }

  function relaySend(obj) {
    if (relay?.readyState === 1) { try { relay.send(JSON.stringify(obj)); } catch {} }
  }

  function connect() {
    log("连接 relay/host…");
    const ws = new WebSocket(HOST_URL);
    relay = ws;
    ws.on("open", () => { retry = 0; log(`已连上 relay（host 在线，机器名=${NAME}）`); relaySend({ t: "hello", id: ID, name: NAME, sessions: (getActiveSessions?.() ?? []) }); });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === "app_open") openLocal(m.cid);
      else if (m.t === "app_msg") toLocal(m.cid, m.data);
      else if (m.t === "app_close") { const e = locals.get(m.cid); if (e) { try { e.ws.close(); } catch {} locals.delete(m.cid); } }
    });
    ws.on("close", () => {
      relay = null;
      closeAllLocals(); // relay 重连后会补发全部 app_open，旧本地连接清掉避免重复
      const delay = Math.min(1000 * 2 ** retry++, 15000);
      log(`relay 断开，${delay}ms 后重连`);
      setTimeout(connect, delay);
    });
    ws.on("error", (e) => { log("relay 连接出错:", e.message); try { ws.close(); } catch {} });
  }

  connect();
  return { stop() { try { relay?.close(); } catch {} closeAllLocals(); } };
}
