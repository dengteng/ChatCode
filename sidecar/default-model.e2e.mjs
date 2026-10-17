// 严格模式的模型菜单自检(自带 sidecar,不起 CLI、不花额度):
//   node sidecar/default-model.e2e.mjs
// 后台配了 claude 组时:菜单就是清单(每个模型只出现一次、按清单顺序),没有 SDK 的 default 别名行,
// 「默认」只是 isDefault 标记 —— 用户设的还在清单里就是它,被隐藏/删了就回到清单第一条。
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert";
import WebSocket from "ws";

const PORT = 8800 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-defmodel-"));
const cat = [
  { model: "claude-fable-5-1", displayName: "Fable 5.1" }, { model: "claude-opus-5-5", displayName: "Opus 5.5" },
  { model: "claude-opus-5", displayName: "Opus 5" }, { model: "claude-sonnet-5", displayName: "Sonnet 5" },
  { model: "claude-opus-4-8", displayName: "Opus 4.8", hidden: true }, { model: "claude-haiku-5-5", displayName: "Haiku 5.5" },
];
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({
  claudeCatalog: cat, modelCatalogAt: Date.now(), // 不让它去拉真远程清单
  // SDK 上次上报的 Claude 列表:带 default / sonnet 别名行(sonnet 解析到清单外的 5.5),严格模式必须把它们挡在菜单外
  claudeModels: [
    { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5[1m]" },
    { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5" },
    { value: "opus[1m]", displayName: "Opus", resolvedModel: "claude-opus-5[1m]" },
  ],
}));
const srv = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
  env: { ...process.env, CHAT_CODE_TOKEN: "t", CHAT_CODE_PORT: String(PORT), CHAT_CODE_DATA_DIR: DATA, DT_NOTIFY_URL: "" }, stdio: "ignore",
});
const bye = (msg, code) => { srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} console.log(msg); process.exit(code); };
setTimeout(() => bye("✗ 超时", 1), 30000);

setTimeout(() => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=t`);
  ws.on("error", (e) => bye(`ERR ${e.message}`, 1));
  const waiters = [];
  ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "models" && m.sessionId === "__home__") waiters.shift()?.(m.models); });
  const models = () => new Promise((res) => { waiters.push(res); ws.send(JSON.stringify({ type: "get_models", sessionId: "__home__" })); });
  const setDef = (model) => ws.send(JSON.stringify({ type: "set_default_model", model }));
  ws.on("open", async () => {
    try {
      const claude = (l) => l.filter((m) => m.provider === "claude" || /^claude-|^default$/.test(m.value));
      let l = claude(await models());
      assert.deepStrictEqual(l.map((m) => m.value), ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"], "菜单 = 清单(没隐藏的,按清单顺序),没有 default / sonnet 5.5 等别名行");
      assert.strictEqual(new Set(l.map((m) => m.displayName)).size, l.length, "没有名字一模一样的两条");
      assert.deepStrictEqual(l.filter((m) => m.isDefault).map((m) => m.value), ["claude-fable-5-1"], "没设默认 = 清单第一条是默认");
      setDef("claude-opus-5"); l = claude(await models());
      assert.deepStrictEqual(l.filter((m) => m.isDefault).map((m) => m.value), ["claude-opus-5"], "用户改了默认:标记跟着走,而且只有一条");
      setDef("claude-opus-4-8"); l = claude(await models());
      assert.deepStrictEqual(l.filter((m) => m.isDefault).map((m) => m.value), ["claude-fable-5-1"], "用户设的被后台隐藏了:回到清单第一条");
      setDef("default"); l = claude(await models());
      assert.deepStrictEqual(l.filter((m) => m.isDefault).map((m) => m.value), ["claude-fable-5-1"], "清掉用户设置:回到清单第一条");
      bye("✓ 严格模式菜单就位", 0);
    } catch (e) { bye(`✗ ${e.message}`, 1); }
  });
}, 1500);
