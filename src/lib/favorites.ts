// 收藏夹:气泡下方点星标,把这条消息存一份到本机 localStorage。设置 →「收藏夹」查看/复制/删除。
// ponytail: 只存本机,不做云同步;要跨电脑时再挪到 ~/.ChatCode 或同步盘。
export type Favorite = {
  id: string;      // 会话 id + 消息时间戳,用来去重
  msgTs: number;   // 消息时间戳
  savedAt: number; // 收藏时间
  session: string; // 会话名称
  cwd: string;     // 工作目录
  sender: string;  // 消息发送人
  text: string;    // 消息内容
};

const KEY = "ChatCode-favorites";

export function loadFavorites(): Favorite[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

const save = (list: Favorite[]) => localStorage.setItem(KEY, JSON.stringify(list));

// 已收藏过返回 false,不重复存
export function addFavorite(f: Omit<Favorite, "id" | "savedAt">, sessionId: string): boolean {
  const id = `${sessionId}:${f.msgTs}`;
  const list = loadFavorites();
  if (list.some((x) => x.id === id)) return false;
  save([{ ...f, id, savedAt: Date.now() }, ...list]);
  return true;
}

export function removeFavorite(id: string): Favorite[] {
  const list = loadFavorites().filter((x) => x.id !== id);
  save(list);
  return list;
}
