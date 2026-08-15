// 本地 Anthropic→OpenAI 转译代理。
// 只有 OpenAI 兼容端点的 provider(Grok / OpenAI-Codex / Gemini),靠它伪装成 Anthropic 端点:
// Claude Code CLI 把请求打到 http://127.0.0.1:<port>/<provider>/v1/messages,
// 本代理翻成 OpenAI /chat/completions 打真正上游,再把结果翻回 Anthropic Messages 格式(含流式)。
// 这样整条 CLI/SDK/前端管线一行不用改,三家非 Anthropic 模型即可复用。
//
// 纯翻译函数(anthropicToOpenAI / openaiMessageToAnthropic / makeSSETranslator)不碰网络,底部有 assert 自测。
import http from "node:http";

const S = (v) => (v == null ? "" : String(v));
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// tool_result.content 可能是字符串或块数组,压成字符串给 OpenAI 的 tool 消息
function stringifyToolContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text : JSON.stringify(b))).join("\n");
  if (c == null) return "";
  return JSON.stringify(c);
}

const mapToolChoice = (tc) => {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return "auto";
};

const mapFinish = (r) => {
  if (r === "tool_calls") return "tool_use";
  if (r === "length") return "max_tokens";
  if (r === "content_filter") return "end_turn";
  return "end_turn"; // stop / null / 其它
};

// Anthropic Messages 请求体 → OpenAI Chat Completions 请求体
export function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system : body.system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === "user") {
      const parts = [];
      const toolMsgs = [];
      for (const b of blocks) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image" && b.source?.type === "base64")
          parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        else if (b.type === "tool_result")
          toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: stringifyToolContent(b.content) });
      }
      if (parts.length) messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
      for (const t of toolMsgs) messages.push(t); // OpenAI 要求 assistant(tool_calls) 后紧跟各 tool 结果
    } else { // assistant
      let text = "";
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use")
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      }
      const am = { role: "assistant", content: text || null };
      if (toolCalls.length) am.tool_calls = toolCalls;
      messages.push(am);
    }
  }
  const out = { model: body.model, messages, stream: !!body.stream };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length)
    out.tools = body.tools
      .filter((t) => t.name && !t.name.startsWith("web_search")) // 内置类工具无 schema,跳过
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
  const tc = mapToolChoice(body.tool_choice);
  if (tc) out.tool_choice = tc;
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

// OpenAI 非流式 message → Anthropic Messages 响应
export function openaiMessageToAnthropic(resp, model, id) {
  const choice = resp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || [])
    content.push({ type: "tool_use", id: tc.id || `toolu_${Math.random().toString(36).slice(2)}`, name: tc.function?.name, input: safeParse(tc.function?.arguments || "{}") });
  return {
    id: resp.id || id || "msg_proxy",
    type: "message", role: "assistant", model,
    content,
    stop_reason: mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0 },
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// 流式翻译器:喂 OpenAI SSE 的每个 data JSON 对象,吐 Anthropic SSE 文本。
// 维护"当前打开的内容块":text 一块,每个 tool_call 一块;按 Anthropic 的 block index 递增。
export function makeSSETranslator(model, id, write) {
  let started = false;
  let blockIndex = -1;            // 已开的最后一个块下标
  let curType = null;             // "text" | "tool" | null
  const toolSlot = new Map();     // OpenAI tool_calls[].index → anthropic block index
  let finish = "stop";
  let usageOut = 0, usageIn = 0;

  const start = () => {
    if (started) return;
    started = true;
    write(sse("message_start", {
      type: "message_start",
      message: { id: id || "msg_proxy", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }));
  };
  const closeCur = () => {
    if (curType == null) return;
    write(sse("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    curType = null;
  };
  const openText = () => {
    closeCur();
    blockIndex++;
    write(sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }));
    curType = "text";
  };
  const openTool = (tcIndex, id2, name) => {
    closeCur();
    blockIndex++;
    toolSlot.set(tcIndex, blockIndex);
    write(sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: id2 || `toolu_${Math.random().toString(36).slice(2)}`, name: name || "", input: {} } }));
    curType = "tool";
  };

  return {
    onChunk(obj) {
      start();
      if (obj.usage) { usageOut = obj.usage.completion_tokens ?? usageOut; usageIn = obj.usage.prompt_tokens ?? usageIn; }
      const choice = obj.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta || {};
      if (typeof d.content === "string" && d.content.length) {
        if (curType !== "text") openText();
        write(sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: d.content } }));
      }
      for (const tc of d.tool_calls || []) {
        const slot = tc.index ?? 0;
        if (!toolSlot.has(slot) || (tc.function?.name && curType !== "tool")) {
          // 新工具调用:首帧带 id + name
          if (!toolSlot.has(slot)) openTool(slot, tc.id, tc.function?.name);
        }
        const bi = toolSlot.get(slot);
        const args = tc.function?.arguments;
        if (args) write(sse("content_block_delta", { type: "content_block_delta", index: bi, delta: { type: "input_json_delta", partial_json: args } }));
      }
    },
    end() {
      start();
      closeCur();
      write(sse("message_delta", { type: "message_delta", delta: { stop_reason: mapFinish(finish), stop_sequence: null }, usage: { input_tokens: usageIn, output_tokens: usageOut } }));
      write(sse("message_stop", { type: "message_stop" }));
    },
  };
}

// 粗略 token 估算(count_tokens 端点用):字符数/4 + 每条消息常数
function estimateTokens(body) {
  let chars = 0;
  const add = (c) => { if (typeof c === "string") chars += c.length; else if (Array.isArray(c)) for (const b of c) chars += (b?.text?.length || b?.content?.length || 0); };
  if (body.system) add(typeof body.system === "string" ? body.system : body.system.map((b) => b.text).join(""));
  for (const m of body.messages || []) add(m.content);
  return Math.max(1, Math.ceil(chars / 4));
}

// 起本地代理。getUpstream(providerId) → { baseUrl } | null。返回 { server, port }。
export function startProxy({ port, getUpstream }) {
  const server = http.createServer((req, res) => {
    // 路径形如 /<provider>/v1/messages 或 /<provider>/v1/messages/count_tokens
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const providerId = parts[0];
    const rest = "/" + parts.slice(1).join("/");
    const auth = req.headers["authorization"] || (req.headers["x-api-key"] ? `Bearer ${req.headers["x-api-key"]}` : "");
    const up = getUpstream(providerId);
    if (!up) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { message: `unknown provider ${providerId}` } })); return; }

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
      // count_tokens:CLI 会调,给个估算即可
      if (rest.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
        return;
      }
      const wantStream = !!body.stream;
      const oaBody = anthropicToOpenAI(body);
      // OpenAI 新接口(gpt-5 系)只认 max_completion_tokens,不认 max_tokens;其余家(Grok/Gemini)仍用 max_tokens
      if (providerId === "openai" && oaBody.max_tokens != null) { oaBody.max_completion_tokens = oaBody.max_tokens; delete oaBody.max_tokens; }
      const target = up.baseUrl.replace(/\/$/, "") + "/chat/completions";
      try {
        const upstream = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify(oaBody),
        });
        if (!upstream.ok) {
          const txt = await upstream.text();
          res.writeHead(upstream.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream ${upstream.status}: ${txt.slice(0, 800)}` } }));
          return;
        }
        const msgId = "msg_" + Math.random().toString(36).slice(2);
        if (!wantStream) {
          const j = await upstream.json();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(openaiMessageToAnthropic(j, oaBody.model, msgId)));
          return;
        }
        // 流式:逐行读 upstream SSE,翻成 Anthropic SSE
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const tr = makeSSETranslator(oaBody.model, msgId, (s) => res.write(s));
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try { tr.onChunk(JSON.parse(data)); } catch {}
          }
        }
        tr.end();
        res.end();
      } catch (e) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `proxy error: ${S(e?.message || e)}` } }));
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, port };
}

// ---- 自测(node sidecar/openai-proxy.mjs 直跑;打包内联后不触发)----
if (process.argv[1] && process.argv[1].endsWith("openai-proxy.mjs")) {
  const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); };
  // 请求翻译:system + tool_use + tool_result 往返成 OpenAI 结构
  const oa = anthropicToOpenAI({
    model: "grok-4", system: "you are x", max_tokens: 100,
    tools: [{ name: "get", description: "d", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "call" }, { type: "tool_use", id: "t1", name: "get", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
    ],
  });
  assert(oa.messages[0].role === "system", "system first");
  assert(oa.messages[2].tool_calls[0].function.name === "get", "tool_call name");
  assert(oa.messages[3].role === "tool" && oa.messages[3].tool_call_id === "t1", "tool result");
  assert(oa.tools[0].type === "function", "tools mapped");
  // 非流式响应翻译
  const an = openaiMessageToAnthropic({ choices: [{ message: { content: "ok", tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"x":1}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 7 } }, "grok-4");
  assert(an.content[0].type === "text" && an.content[1].type === "tool_use", "content blocks");
  assert(an.content[1].input.x === 1, "tool input parsed");
  assert(an.stop_reason === "tool_use", "stop_reason");
  assert(an.usage.input_tokens === 5 && an.usage.output_tokens === 7, "usage");
  // 流式翻译:文本 + 工具增量 → 有 message_start/content_block_start/message_stop
  let outs = "";
  const tr = makeSSETranslator("grok-4", "id1", (s) => (outs += s));
  tr.onChunk({ choices: [{ delta: { content: "He" } }] });
  tr.onChunk({ choices: [{ delta: { content: "llo" } }] });
  tr.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a":' } }] } }] });
  tr.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] });
  tr.end();
  assert(outs.includes("message_start"), "sse message_start");
  assert(outs.includes('"text_delta"') && outs.includes("Hello".slice(0, 2)), "sse text");
  assert(outs.includes('"tool_use"') && outs.includes("input_json_delta"), "sse tool");
  assert(outs.includes("message_stop"), "sse stop");
  console.log("openai-proxy self-test OK");
}
