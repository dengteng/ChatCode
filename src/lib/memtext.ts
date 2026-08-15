// 记忆文件正文的清洗 + 取标题。纯字符串处理,单独放这里是为了能脱离 React/tauri 自检
// (跑法见 memtext.check.ts)。
//
// Read 一条记忆拿回来的原文长这样:
//   <system-reminder>This memory is 2 days old…</system-reminder>
//   ---
//   name: server-infra
//   description: "…"
//   ---
//   生产服务器 …
// 直接丢给 markdown 渲染会很难看:结尾那行 `---` 被当成 setext 标题的下划线,
// 上面整块 YAML 连同 system-reminder 一起变成两个巨大的 H2。所以渲染前必须剥干净。

// Read 的结果是 cat -n 格式(行号 + Tab + 正文),行号前缀去掉
export const stripLineNums = (s: string) => s.replace(/^\s*\d+\t/gm, "");

// Claude Code 注入的时效提醒,不是记忆内容。它顶在最前面还会挡住 frontmatter,
// 让 memoryTitle 读不到 name 而回退成文件名 —— 所以要第一个剥。
export const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();

// frontmatter 的 name 已经当标题显示了,正文里再铺一遍是噪音
export const stripFrontmatter = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();

// 记忆标题:优先 frontmatter 的 name,其次首个 # 标题,再回退文件名
export function memoryTitle(body: string, file: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  const nm = fm && /^name\s*:\s*(.+)$/m.exec(fm[1]);
  if (nm) return nm[1].trim().replace(/^["']|["']$/g, "");
  const h = /^#\s+(.+)$/m.exec(body);
  return h ? h[1].trim() : file.replace(/\.md$/i, "");
}

// 一步到位:原文 → { title, body }。顺序要紧,先去 reminder 才读得到 frontmatter。
export function cleanMemory(raw: string, file: string): { title: string; body: string } {
  const text = stripReminders(raw);
  return { title: memoryTitle(text || file, file), body: stripFrontmatter(text) };
}
