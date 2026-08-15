// 云同步落地路径守卫。
//
// 背景:同步下来的条目里 rel/file 都来自服务端响应,而 write_file 对路径零限制、还会自动建父目录。
// 一条 rel = "/../../.zshrc" 或 file = "../../Library/LaunchAgents/x.plist" 就等于持久化 RCE ——
// 服务端被攻破或账号被盗时,同步一次就中招。
//
// 前端没有 node 的 path 模块,这里做纯字符串归一化:折掉 "." / ".." / 重复斜杠,再要求结果仍落在
// root 之内(root 自身或它的子路径)。跳出去、含 NUL、root 不是绝对路径,一律返回 null 由调用方跳过。
export function safeJoin(root: string, ...parts: string[]): string | null {
  const full = [root, ...parts].join("/");
  if (!root.startsWith("/") || full.includes("\0")) return null;
  const segs: string[] = [];
  for (const s of full.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (!segs.length) return null; segs.pop(); continue; }
    segs.push(s);
  }
  const out = "/" + segs.join("/");
  const base = root.replace(/\/+$/, "");
  return out === base || out.startsWith(base + "/") ? out : null;
}
