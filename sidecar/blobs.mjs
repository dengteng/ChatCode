// ---------- 图片外置(blob) ----------
// 贴进来的截图动辄几 MB,base64 直接写进 JSONL 会让日志滚到几百 MB:重开会话时整份要读盘、
// 解析、走 WebSocket、前端再 parse —— 加载卡十秒的另一半就是它。而桌面气泡里只显示一个
// "图片N" 标签,hover 才出预览、点击才开大图,99% 的时间根本用不到图片数据。
// 所以落盘时把 base64 抽到 blobs/<sha1>,日志里只留引用;要看图时前端按 key 现取(blob_get)。
// 按内容 hash 存 = 天然去重,同一张图贴多少次都只占一份磁盘。
//
// 单独成文件是为了给 scripts/trim-session-logs.mjs 复用(清洗存量日志要用同一套 blobPut)。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// 与 server.mjs 的 DATA_DIR 同一条规则
const DATA_DIR = process.env.CHAT_CODE_DATA_DIR || path.join(os.homedir(), ".ChatCode");
const BLOB_DIR = path.join(DATA_DIR, "blobs");

export const isBlobRef = (b) => b?.type === "image" && b.source?.type === "cc_blob";
export const isInlineImg = (b) => b?.type === "image" && b.source?.type === "base64";

export function blobPut(b64) {
  const key = crypto.createHash("sha1").update(b64).digest("hex");
  const file = path.join(BLOB_DIR, key);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(BLOB_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
  }
  return key;
}
export function blobGet(key) {
  // key 来自前端,拼进路径前必须校死:只认 40 位十六进制,杜绝 ../ 穿越读到任意文件
  if (!/^[a-f0-9]{40}$/.test(String(key || ""))) return null;
  try { return fs.readFileSync(path.join(BLOB_DIR, key)).toString("base64"); } catch { return null; }
}

// 图片藏在两处:用户消息的顶层 image 块,和**工具结果里嵌的** image 块(截图类工具,单张 0.6MB)。
// 只管顶层的话,一个跑截图工具的会话日志照样能涨到几十 MB(实测 43MB 里 42MB 是这种嵌套图)。
function mapImageBlocks(m, fn) {
  const c = m?.message?.content;
  if (!Array.isArray(c)) return m;
  let changed = false;
  const one = (b) => { const r = fn(b); if (r !== b) changed = true; return r; };
  const content = c.map((b) =>
    b?.type === "tool_result" && Array.isArray(b.content)
      ? { ...b, content: b.content.map(one) }
      : one(b));
  return changed ? { ...m, message: { ...m.message, content } } : m;
}

// 落盘前把内联图换成引用。
export const externalizeImages = (m) => mapImageBlocks(m, (b) => {
  if (!isInlineImg(b)) return b;
  try {
    return { ...b, source: { type: "cc_blob", media_type: b.source.media_type, key: blobPut(b.source.data), bytes: b.source.data.length } };
  } catch { return b; } // 写盘失败(磁盘满/权限):照原样内联落盘,宁可日志大也别把图弄丢
});

// 还原成内联图。手机端历史(shrinkImages)和迁移校验要用;桌面端不走这条。
export const inlineImages = (m) => mapImageBlocks(m, (b) => {
  if (!isBlobRef(b)) return b;
  const data = blobGet(b.source.key);
  return data ? { ...b, source: { type: "base64", media_type: b.source.media_type, data } } : b;
});
