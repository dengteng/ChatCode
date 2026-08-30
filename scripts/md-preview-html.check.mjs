#!/usr/bin/env node
// md 预览:写在 markdown 里的 HTML 要真渲染,但不能把宿主 webview 交出去。
//
// react-markdown 默认把 HTML 当纯文本贴出来(README 开头那种 <div align="center"> 排版会以标签原文
// 的样子糊在预览顶上)。开 rehypeRaw 才渲染 —— 而 md 可能来自克隆下来的任意仓库,不过滤就是把
// <script> / onerror 放进宿主 webview 跑,那里能碰到 Tauri 的 invoke。所以 raw 后面必须跟 sanitize。
// 顺序还有第三条约束:rehypeLine 打的 data-cc-line(点源码跳转定位靠它)不在 sanitize 白名单里,
// 排在 sanitize 前面会被当场剥掉。
//
// 这三条互相牵制、拆哪条都「看着还行」,所以按 FileEditor 里那套插件真跑一遍管线断言输出。
//
// 跑法:node scripts/md-preview-html.check.mjs
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

// FileEditor 里那份的复刻(改了那边记得同步改这里)
const rehypeLine = () => (tree) => {
  const walk = (n) => {
    if (n.type === "element" && n.position) (n.properties ||= {})["data-cc-line"] = n.position.start.line;
    n.children?.forEach(walk);
  };
  walk(tree);
};

// react-markdown 内部就是这套:remark-rehype 开 allowDangerousHtml,HTML 以 raw 节点留在树里,
// 再由 rehypeRaw 解析成真元素(没有 rehypeRaw 的话这些 raw 节点直接被丢弃/当文本)。
const run = (md) => unified()
  .use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw).use(rehypeSanitize).use(rehypeLine)
  .runSync(unified().use(remarkParse).use(remarkGfm).parse(md));

const find = (n, tag, acc = []) => {
  if (n.type === "element" && n.tagName === tag) acc.push(n);
  n.children?.forEach((c) => find(c, tag, acc));
  return acc;
};
const text = (n) => (n.type === "text" ? n.value : (n.children || []).map(text).join(""));

// ---------- 1. README 开头那段真的渲染出来 ----------
const tree = run(`<div align="center">

**English** · [简体中文](README.zh-CN.md)

<img src="public/logo-rounded.png" width="88" alt="ChatCode">

# ChatCode

</div>
`);
const div = find(tree, "div")[0];
assert.ok(div, "<div> 没渲染成元素 —— rehypeRaw 掉了?");
assert.equal(div.properties.align, "center", "align 属性被剥了(默认白名单里有它,是不是换了 schema)");
const img = find(tree, "img")[0];
assert.ok(img, "<img> 没渲染出来");
assert.equal(img.properties.src, "public/logo-rounded.png", "相对路径的 src 要留着 —— 组件那层要拿它换 base64");
assert.equal(img.properties.width, 88, "width 被剥了");
assert.ok(find(tree, "h1").length === 1, "HTML 块里夹的 markdown 标题也要照常渲染");
// 反面:整段不该再有标签原文漏成文字
assert.ok(!/<div|<img/.test(text(tree)), `预览里还看得见标签原文:${text(tree).slice(0, 80)}`);

// ---------- 2. 危险内容被剥 ----------
const evil = run(`<script>globalThis.__pwned = 1</script>
<img src="x" onerror="globalThis.__pwned = 1">
<a href="javascript:globalThis.__pwned=1">click</a>
`);
assert.equal(find(evil, "script").length, 0, "<script> 没被剥 —— 宿主 webview 里能拿到 Tauri invoke");
assert.equal(find(evil, "img")[0]?.properties.onError ?? null, null, "onerror 没被剥");
assert.equal(find(evil, "a")[0]?.properties.href ?? null, null, "javascript: 链接没被剥");

// ---------- 3. 行号还在(sanitize 之后打才留得住) ----------
assert.ok(div.properties["data-cc-line"], "div 上没有 data-cc-line,点源码跳转定位会失灵");
// 顺序反过来会怎样:sanitize 排在 line 之后,data-* 不在白名单,当场剥掉
const wrong = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw).use(rehypeLine).use(rehypeSanitize)
  .runSync(unified().use(remarkParse).parse("# hi\n"));
assert.ok(!find(wrong, "h1")[0].properties["data-cc-line"],
  "前提变了:sanitize 现在放行 data-* 了,那插件顺序这条约束可以放宽");

// ---------- 4. FileEditor 的接线 ----------
const SRC = readFileSync("src/components/FileEditor.tsx", "utf8");
assert.ok(/rehypePlugins=\{\[\.\.\.rawHtml, rehypeLine\]\}/.test(SRC),
  "md 预览的插件顺序必须是 rawHtml(raw → sanitize) → line(见上面三条约束)");
assert.ok(/components=\{mdComponents\}/.test(SRC), "md 预览要挂 mdComponents(图片换 base64 靠它)");
assert.ok(/const mdComponents = useMdImgComponents\(assets\);/.test(SRC),
  "mdComponents 要把本地相对路径换成读回来的 base64(lib/mdhtml 那份),否则 README 的 logo 是破图");
// md 也得进读盘那条路,否则 assets 里永远没有它的图
assert.ok(/if \(isMd\) return mdImageRefs\(previewText\);/.test(SRC), "refs 里要有 md 分支,不然图片压根不读盘");

// 插件市场那份 README 也要内联:图在插件自己的安装目录下,不读盘就是一排破图。
// hook 必须在 `if (preview)` 那个 early return **之前**调 —— 挪到后面 React 直接报「hook 数量变了」。
const SET = readFileSync("src/components/Settings.tsx", "utf8");
const hookAt = SET.indexOf("useMdImages(");
assert.ok(hookAt > 0 && /useMdImages\(preview\?\.installPath \? `\$\{preview\.installPath\}\/` : ""/.test(SET),
  "市场 README 要按插件安装目录内联图片(dir 得带结尾的 /)");
assert.ok(hookAt < SET.indexOf("if (preview) {"), "useMdImages 调在了 early return 后面,React 会因 hook 数量变化炸掉");
assert.ok(/mkt-readme"><Markdown[^>]*components=\{readmeImgs\}/.test(SET), "市场 README 的 <Markdown> 没挂上内联后的图片组件");

// ---------- 5. 全仓每处 <Markdown> 都过 rawHtml ----------
// 少挂一处不会报错,只是那块的 HTML 静静地糊成标签原文(或者更糟:漏挂 sanitize 那半边)。
// 所以两条一起扫:每个 <Markdown 都得带 rehypePlugins,且引的必须是 rawHtml —— 谁都别再单独 import
// rehypeRaw,那样就能绕开 sanitize 了。
// 扫全 src 而不是列一份文件清单:清单会漏掉将来新加的那个文件,而漏掉正是这条自检要防的事。
const MD_FILES = readdirSync("src", { recursive: true })
  .filter((f) => f.endsWith(".tsx") && f !== "lib/mdhtml.tsx") // mdhtml 自己就是那个定义点,只有它能引
  .map((f) => `src/${f}`);
let seen = 0;
for (const f of MD_FILES) {
  const src = readFileSync(f, "utf8");
  assert.ok(!/from "rehype-raw"/.test(src), `${f} 单独引了 rehype-raw —— 只能用 lib/mdhtml 的 rawHtml,不然 sanitize 可能被漏掉`);
  // 取每个 <Markdown 到它自己那个 '>' 为止(属性值里的花括号不算,箭头函数的 => 也不算)
  for (let i = src.indexOf("<Markdown"); i >= 0; i = src.indexOf("<Markdown", i + 1)) {
    let depth = 0, tag = "";
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && src[j - 1] !== "=") { tag = src.slice(i, j + 1); break; }
    }
    assert.ok(/rehypePlugins=\{(rawHtml|\[\.\.\.rawHtml)/.test(tag),
      `${f} 有一处 <Markdown> 没挂 rawHtml,那块的 HTML 会糊成标签原文:${tag.slice(0, 90)}`);
    seen++;
  }
}
assert.ok(seen >= 5, `只扫到 ${seen} 处 <Markdown>,少了 —— 是不是有文件没列进 MD_FILES`);

console.log(`✅ md-preview-html: HTML 真渲染 / script·onerror·javascript: 被剥 / data-cc-line 留住 / 接线 / 市场 README 内联 / ${seen} 处 Markdown 全挂 rawHtml 全部通过`);
