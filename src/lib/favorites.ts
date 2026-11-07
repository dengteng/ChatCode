// 收藏夹:气泡下方点星标,把这条消息存一份到本机 localStorage。设置 →「收藏夹」查看/复制/删除/跳回原消息。
// ponytail: 只存本机,不做云同步;要跨电脑时再挪到 ~/.ChatCode 或同步盘。
import { useEffect, useState } from "react";

export type Favorite = {
  id: string;      // 会话 id + 消息时间戳,用来去重
  sessionId?: string; // 原消息所在会话;老数据没有,从 id 里拆(favSessionId)
  msgTs: number;   // 消息时间戳,跳回原消息时按它定位
  savedAt: number; // 收藏时间
  session: string; // 会话名称
  cwd: string;     // 工作目录
  sender: string;  // 消息发送人
  text: string;    // 消息内容
};

const KEY = "ChatCode-favorites";
const EVT = "cc-favorites-changed";

export function loadFavorites(): Favorite[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

// 存完广播一下:气泡上的星标(实心/空心)跟着变
const save = (list: Favorite[]) => { localStorage.setItem(KEY, JSON.stringify(list)); window.dispatchEvent(new Event(EVT)); };

export const favId = (sessionId: string, msgTs: number) => `${sessionId}:${msgTs}`;
export const favSessionId = (f: Favorite) => f.sessionId ?? f.id.slice(0, f.id.lastIndexOf(":"));

// 已收藏过返回 false,不重复存
export function addFavorite(f: Omit<Favorite, "id" | "savedAt" | "sessionId">, sessionId: string): boolean {
  const id = favId(sessionId, f.msgTs);
  const list = loadFavorites();
  if (list.some((x) => x.id === id)) return false;
  save([{ ...f, id, sessionId, savedAt: Date.now() }, ...list]);
  return true;
}

export function removeFavorite(id: string): Favorite[] {
  const list = loadFavorites().filter((x) => x.id !== id);
  save(list);
  return list;
}

// 已收藏的 id 集合,收藏/取消后自动刷新
export function useFavoriteIds(): Set<string> {
  const read = () => new Set(loadFavorites().map((f) => f.id));
  const [ids, setIds] = useState(read);
  useEffect(() => {
    const on = () => setIds(read());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return ids;
}

// 卡片摘要:去掉 Markdown 记号和多余空白,只留一段纯文本
export function favPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
