import { invoke } from "@tauri-apps/api/core";
import { SIDECAR_PORT } from "../store";

// 独立窗口(编辑器)没有主窗口那条 ws,用到时临时开一条,请求-应答一次就关。reqId 原样带回用来认应答。
export function remoteCall<T = any>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((res, rej) => {
    const reqId = Math.random().toString(36).slice(2);
    let ws: WebSocket | undefined;
    const timer = window.setTimeout(() => done(() => rej(new Error("timeout"))), 40000);
    const done = (f: () => void) => { clearTimeout(timer); ws?.close(); f(); };
    invoke<string>("sidecar_token").catch(() => "").then((token) => {
      ws = new WebSocket(`ws://127.0.0.1:${SIDECAR_PORT}${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      ws.onopen = () => ws!.send(JSON.stringify({ ...msg, reqId }));
      ws.onmessage = (e) => {
        try { const m = JSON.parse(e.data); if (m.reqId === reqId) done(() => (m.ok ? res(m) : rej(new Error(m.error || "failed")))); } catch {}
      };
      ws.onerror = () => done(() => rej(new Error("sidecar")));
    });
  });
}
