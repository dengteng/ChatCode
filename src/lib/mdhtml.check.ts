// md 图片内联的路径解析自检。跑法(零新依赖):
//   npx esbuild src/lib/mdhtml.check.ts --bundle --format=esm | node --input-type=module
//
// 这层只管「哪些 src 要读盘、读回来拼成什么 data: URL」。挑得多了会去读一个不存在的文件(不致命,
// 但每开一次 README 白读一轮盘);挑漏了就是一张破图;拼错 MIME 是一张永远加载不出的图。
import { mdImageRefs, localPath, dataUrl, isImg } from "./mdhtml";

const eq = (got: unknown, want: unknown, name: string) => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) throw new Error(`✗ ${name}\n  got : ${g}\n  want: ${w}`);
  console.log(`✓ ${name}`);
};

// 一份 README 里能出现的全部写法
eq(mdImageRefs(`# Demo
![shot](docs/shot.png)
<div align="center"><img src="assets/logo.svg" width="88"></div>
![remote](https://example.com/a.png)
<img src="//cdn.example.com/b.png">
<img src="data:image/png;base64,AAA">
[不是图片](docs/readme.md)
![带 query](docs/shot.png?v=2)
![没扩展名](docs/whatever)
`), ["docs/shot.png", "assets/logo.svg"], "两种写法都收 / 远程·data:·非图片·没扩展名全不要 / ?query 归一后去重");

// 根绝对路径按「md 自己所在目录 = 根」解析(和 html 预览同一套规则)
eq(mdImageRefs(`![](/img/a.png)`), ["img/a.png"], "开头的 / 剥掉,拼 dir 时才不会跑到磁盘根目录");
eq(localPath("#anchor"), null, "纯锚点不是文件");
eq(localPath("asset://x.png"), null, "已经是 asset: 协议的不碰");

// MIME:扩展名和 MIME 不同名的三个必须走映射表,否则 image/svg、image/jpg、image/ico 都加载不出来
eq(dataUrl("a.svg", "AA"), "data:image/svg+xml;base64,AA", "svg 的 MIME 是 image/svg+xml");
eq(dataUrl("a.JPG", "AA"), "data:image/jpeg;base64,AA", "jpg → image/jpeg,且扩展名大小写不敏感");
eq(dataUrl("a.png", "AA"), "data:image/png;base64,AA", "其余按扩展名直接拼");
eq(isImg("a.PNG") && !isImg("a.md"), true, "isImg 认大写扩展名、不认 md");

console.log("✅ mdhtml: 图片引用挑拣 / 路径归一 / data: URL 拼装 全部通过");
