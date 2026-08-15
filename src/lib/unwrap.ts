// 粘贴时把「排版折行」并回一段:从别处(终端窄栏、markdown 源、邮件)复制来的文字,
// 每行结尾都带硬换行,贴进宽输入框右边留一大片空白,还得手动删换行。
//
// 只并「同一段落内的续行」,这些结构一律原样保留:
//   空行(段落分隔)、列表/标题/引用/表格行的行首、``` 围栏、缩进代码块。
// 另加两道防误伤(粘多行 shell 命令时最要紧):
//   上一行没被栏宽撑满不并 —— 排版折行的行都是顶到栏边的,命令行/短句普遍短;
//   上一行以代码符号收尾(; { } , \ | && 之类)不并。
//
// 「撑满」按本次粘贴自己推断,不用固定字数:最宽的那行就是栏宽的下界。
// 全段都远短于任何常见栏宽(< COLUMN_MIN)= 根本没有栏在截行,是人手敲的短句列表,整段别动。
// 起因:从编辑器复制 6 行短句(每行 8~14 个汉字),前两行因为够短侥幸留住,第 3 行起全被并成一行。
const COLUMN_MIN = 48;   // 视觉宽,约 24 个汉字 —— 比终端 80 / 邮件 72 / markdown 源都保守
const FULL_RATIO = 0.8;  // 达到栏宽这个比例才算「被截断」,明显没撑满的是段末行,不吸下一行

// 行首即是新块:空行、列表(- * + 1. 1))、标题、引用、表格、URL/绝对路径(粘一串链接时每条要各占一行)
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||[a-z][a-z0-9+.-]*:\/\/|\/[^\s/])/i;
// 行尾像代码或 URL、或挂着行尾注释(# / //),都不是被排版截断的句子
const CODE_TAIL = /(?:[;{},\\|]|&&|\|\||=>|->|:\/\/\S+|(?:^|\s)(?:#|\/\/)[^\n]*)\s*$/;
// 行内出现"多空格对齐"(命令 + 对齐的注释、表格样式的列)= 代码/表格,不是排版折行
const COLUMNS = /\S {2,}\S/;
// 视觉宽度:中日韩全角算 2,其余 1(纯长度会把中文行误判成"太短")
const visWidth = (s: string) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);

// 剪贴板里同时带 text/html 且含块级结构时,text/plain 的换行来自 <li>/<p>/<br> 这些块边界,
// 是**结构性**换行,不是窄栏排版折行 —— 一律原样保留,别并。
// 起因:从渲染好的有序列表复制,WebKit 给的 text/plain 连 "1." 前缀都不带,纯文本判不出是列表,
// 三条会被并成一行。(浏览器里段落的视觉折行本就不进 text/plain,所以这条不会误伤真折行)
// 只认列表/段落/换行/表格/标题/引用:不认 div/span(WebKit 什么都往里套)、不认 pre(代码块该照旧走折行判定)。
export const htmlHasBlocks = (html: string) => /<(?:li|p|br|tr|h[1-6]|blockquote)[\s/>]/i.test(html);

export function unwrapSoftBreaks(src: string): string {
  if (!src.includes("\n")) return src;
  if (src.includes("```")) return src;                   // 有围栏 = 含代码块,整段不动
  const lines = src.split("\n");
  const indented = lines.filter((l) => /^(?:\t| {4})/.test(l)).length;
  if (indented > lines.length * 0.3) return src;         // 大半是缩进块 = 代码,不动
  const column = Math.max(...lines.map((l) => visWidth(l.trimEnd())));
  if (column < COLUMN_MIN) return src;                   // 没有一行被撑满 = 没有栏宽,不是折行

  const out: string[] = [];
  let last = "";   // 上一条**原始**行,不是并完的那条 —— 并完了 out 里那条只会越来越长,
                   // 拿它判「撑满没」就永远成立,一段里只要有一行到顶,后面全被串成一行。
  for (const line of lines) {
    const prev = out[out.length - 1];
    const joinable = prev !== undefined && !!last.trim() && !!line.trim()
      && !BLOCK_START.test(line) && !CODE_TAIL.test(last) && visWidth(last.trim()) >= column * FULL_RATIO
      && !COLUMNS.test(last) && !COLUMNS.test(line);
    last = line;
    if (!joinable) { out.push(line); continue; }
    const cur = line.replace(/^\s+/, "");
    // 英文单词之间要补空格,中文之间直接接上(补了会多出难看的空隙)
    const gap = /[A-Za-z0-9,.;:)\]]$/.test(prev) && /^[A-Za-z0-9([]/.test(cur) ? " " : "";
    out[out.length - 1] = prev.replace(/\s+$/, "") + gap + cur;
  }
  return out.join("\n");
}
