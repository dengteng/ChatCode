// 回复正文里没包反引号的路径(`公证包已经打好：/Users/x/Luna.dmg`)也要能 hover 出操作菜单。
// 以前只有 `code` 和链接会变成 PathToken,模型一忘记包反引号,路径就是一段死文字。
//
// 正文比 code 里脏得多,所以规则比 Chat.tsx 的 LINK_RE 紧:
//   - 只认 / 或 ~/ 开头的,和带斜杠的相对路径;裸文件名(Node.js、README.md)不认,正文里误中太多。
//   - 全角标点(，。：（）、)一律当边界:中文正文里路径后面往往直接跟标点,不打空格。
//   - 最终算不算路径由调用方的 ok() 定(文件系统根 / 已知扩展名),这里只管切。
// 前缀用捕获组而不是 (?<!…):老 WKWebView(macOS 13.3 以前)不认 lookbehind,正则字面量直接是语法错误。
const RE = /(^|[^\w\/.~:\-@])(~?\/[^\s<>"'`()　-〿＀-￯]+|[\w.\-@]+(?:\/[\w.\-@]+)+)/g;

export type Piece = string | { path: string };

export function prosePaths(text: string, ok: (raw: string) => boolean): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(RE)) {
    let raw = m[2].replace(/[.,;:!?]+$/, ""); // 句尾标点不属于路径
    // "/Users/x/Luna.dmg已生成":扩展名后面直接跟的中文是正文
    const cut = raw.match(/^(.*\.[A-Za-z]\w{0,7})[⺀-鿿]+$/);
    if (cut) raw = cut[1];
    if (!raw || !ok(raw)) continue;
    const start = m.index! + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    out.push({ path: raw });
    last = start + raw.length;
  }
  if (!out.length) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// rehype 插件:把正文文本节点里的路径换成 <a href=路径>,Chat 的 a 组件本来就把它渲染成 PathToken。
// 排在 sanitize 之后挂(见 lib/mdhtml)。code / pre / a 里的不动 —— 那几处各有自己的识别。
export const rehypeProsePaths = (ok: (raw: string) => boolean) => () => (tree: any) => {
  const walk = (node: any) => {
    if (!node.children || ["code", "pre", "a"].includes(node.tagName)) return;
    node.children = node.children.flatMap((c: any) => {
      if (c.type !== "text") { walk(c); return [c]; }
      const pieces = prosePaths(c.value, ok);
      if (pieces.length === 1 && typeof pieces[0] === "string") return [c];
      return pieces.map((p) => typeof p === "string" ? { type: "text", value: p }
        : { type: "element", tagName: "a", properties: { href: p.path }, children: [{ type: "text", value: p.path }] });
    });
  };
  walk(tree);
};
