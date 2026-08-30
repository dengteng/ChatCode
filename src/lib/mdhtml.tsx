import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

/** 让写在 markdown 里的 HTML 真渲染出来,并当场收口。
 *
 * react-markdown 默认不解析 md 里的原始 HTML,`<div align="center">` 这类排版会以标签原文的样子糊在
 * 正文里(README 开头那段最典型)。rehypeRaw 才让它变成真元素。
 *
 * 而这些 md 全是外来的:agent 的回复、克隆下来的仓库、插件市场从 GitHub 拉的 README、写进磁盘的记忆
 * 文件。不过滤就是把 <script> / onerror / javascript: 放进宿主 webview 跑 —— 那里能拿到 Tauri 的
 * invoke。所以 raw 后面必须紧跟 sanitize,两个永远成对出现,别单独引 rehypeRaw。
 * 用默认的 GitHub 白名单:align/width/alt 这些排版属性本来就在里面。
 *
 * 附带的行为变化:白名单外的标签会被脱掉一层壳、只留里面的文字(和 GitHub 一样)。agent 在正文里
 * 写 <Foo>bar</Foo> 时以前显示成标签原文,现在只剩 bar。围栏代码块不受影响。
 *
 * 还要挂别的 rehype 插件就 [...rawHtml, 你的],排在 sanitize **之后** —— 白名单不认 data-*,
 * 放前面打的自定义属性会被当场剥掉(见 FileEditor 的 rehypeLine)。 */
export const rawHtml = [rehypeRaw, rehypeSanitize];

export const ext = (name: string) => name.split(".").pop()?.toLowerCase() || "";
export const IMG_RE = /<img\b[^>]*>/gi;
// md 里的图片两种写法都要收:markdown 的 ![](x.png) 和直接写的 <img src="x.png">
// (README 开头那种 <div align="center"><img …> 居中排版全是后者)。
export const MD_IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
export const isImg = (u: string) => /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i.test(u);
const MIME: Record<string, string> = { svg: "image/svg+xml", jpg: "image/jpeg", ico: "image/x-icon" };
export const dataUrl = (ref: string, b64: string) => `data:${MIME[ext(ref)] || `image/${ext(ref)}`};base64,${b64}`;
// 标签里取本地路径。远程 / data: / 锚点返回 null —— 那些 iframe 自己能取,不碰。
// 顺手去掉 ?v=1 这类 query:磁盘上没有那个文件名。
// "/assets/x.js" 这种根绝对路径也要读盘:srcDoc + sandbox(无 allow-same-origin)的 iframe
// 处于不透明源,"/" 无处可指,交给它取等于取不到 —— Vite 打出来的站正文全靠那支 JS,
// 拿不到就只剩一片白。这里按「html 自己所在目录 = 站点根」解析。
// ponytail: 没做真站点根探测(往上找 index.html 之类)。猜错了读盘失败,预览退化成没样式,和修之前一样,不会更糟。
export const localPath = (u: string | null | undefined): string | null => {
  if (!u || /^(https?:|\/\/|data:|asset:|#)/i.test(u)) return null;
  return u.split(/[?#]/)[0].replace(/^\/+/, "");
};
export const localRef = (tag: string, attr: "href" | "src"): string | null =>
  localPath(tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]);

/** md 里指向磁盘的图片换成 base64,给 <Markdown components={…}> 用。
 *
 * 非用不可的原因:webview 里相对 src 解析到 app 自己的 base(不是这份 md 所在的目录),README 里
 * `![](docs/x.png)` 一律破图。同一份 md 在编辑器预览和插件市场弹窗里都要显示,所以抽在这儿。
 *
 * dir 要带结尾的 "/"。读盘失败(图缺了)不报错,保持原 src、退化成破图 —— 和没这个 hook 时一样,
 * 不该为一张图挡住整篇 README。 */
export const mdImageRefs = (md: string): string[] => [...new Set([
  ...[...md.matchAll(MD_IMG_RE)].map((m) => localPath(m[1])),
  ...(md.match(IMG_RE) || []).map((t) => localRef(t, "src")),
  // 只留认得出的图片扩展名:没扩展名的读回来拼成 data:image 就是一张永远加载不出的图
].filter((r): r is string => !!r && isImg(r)))];

export function useMdImages(dir: string, md: string) {
  const refs = useMemo(() => mdImageRefs(md), [md]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  // 依赖用 join 出来的字符串而不是 refs 本身:数组每次正文变化都是新引用,直接当依赖 = 每次重渲染都读一遍盘
  const refKey = refs.join("|");
  useEffect(() => {
    let alive = true;
    for (const r of refs) {
      invoke<string>("read_file_b64", { path: dir + r })
        .then((c) => alive && setAssets((a) => (a[r] === c ? a : { ...a, [r]: c })))
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [refKey, dir]);
  return useMdImgComponents(assets);
}

/** 已经自己读好盘的地方(FileEditor 的预览把 css/js/图片混在一套 assets 里)直接用这个,
 * 别再走 useMdImages 读第二遍。assets 的 key 是 localPath() 后的相对路径,值是 base64。 */
export function useMdImgComponents(assets: Record<string, string>) {
  return useMemo(() => ({
    // 读盘还没回来时保持原 src(显示成破图),读回来 assets 一变就重渲染
    img: ({ node: _node, ...p }: any) => {
      const r = localPath(p.src);
      return <img {...p} src={r && assets[r] !== undefined ? dataUrl(r, assets[r]) : p.src} />;
    },
  }), [assets]);
}
