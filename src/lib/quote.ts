// 引用消息:气泡下方点「引用」→ 输入框上方挂一条引用条 → 发送时作为第一个 text block 打头。
// 格式用 <reply-to> 标签:agent 一眼能读懂「这条是接哪条消息说的」,前端也能稳定认出来、渲染成引用卡片。
// 原文还在会话上下文里,这里只带一段摘录做定位;上下文被压缩过时,摘录就是 agent 唯一能看到的线索,所以给足 500 字。
export type Quote = { from: string; ts: number; text: string };

const MAX = 500;
const RE = /^<reply-to from="([^"]*)"(?: ts="(\d+)")?>\n([\s\S]*?)\n<\/reply-to>\s*/;

export function quoteBlock(q: Quote): string {
  const body = q.text.trim();
  const clip = body.length > MAX ? body.slice(0, MAX) + "…" : body;
  const from = q.from.replace(/"/g, "'");
  return `<reply-to from="${from}" ts="${q.ts}">\n${clip.replace(/<\/reply-to>/g, "</reply_to>")}\n</reply-to>\n\n`;
}

// 拆出打头的引用。没有就原样返回 rest
export function splitQuote(text: string): { quote?: { from: string; ts: number; text: string }; rest: string } {
  const m = text.match(RE);
  if (!m) return { rest: text };
  return { quote: { from: m[1], ts: Number(m[2] || 0), text: m[3] }, rest: text.slice(m[0].length) };
}

export const stripQuote = (text: string) => splitQuote(text).rest;
