// unwrapSoftBreaks 自检。跑法(零新依赖):
//   npx esbuild src/lib/unwrap.check.ts --bundle --format=esm | node --input-type=module
import { unwrapSoftBreaks as u, htmlHasBlocks as hb } from "./unwrap";

const is = (got: boolean, want: boolean, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}: got ${got}`);
  console.log(`✓ ${name}`);
};

const eq = (got: string, want: string, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  console.log(`✓ ${name}`);
};

// 中文排版折行 -> 并成一行(续行的缩进去掉,中文间不补空格)
eq(u("如果这个产品一次任务由多个步骤组成，在 llm.usage 的\n  data 里再平铺两个标量：任务标识和步骤名"),
   "如果这个产品一次任务由多个步骤组成，在 llm.usage 的data 里再平铺两个标量：任务标识和步骤名", "中文折行合并");
// 段落之间的空行保留(行长按真实栏宽写,下同:短于 COLUMN_MIN 的整段本就不参与合并)
eq(u("第一段的文字够长够长够长够长够长够长够长够长够长够长够长够长\n接着还是第一段\n\n第二段的文字够长够长够长够长够长够长够长够长够长够长够长够长"),
   "第一段的文字够长够长够长够长够长够长够长够长够长够长够长够长接着还是第一段\n\n第二段的文字够长够长够长够长够长够长够长够长够长够长够长够长", "空行分段保留");
// 列表:每项各自成行,项内续行才并
eq(u("- 第一项写得很长很长很长很长很长很长很长很长很长很长很长很长很长\n  这是它的续行\n- 第二项"),
   "- 第一项写得很长很长很长很长很长很长很长很长很长很长很长很长很长这是它的续行\n- 第二项", "列表项与续行");
// 多行 shell 命令:短行 + 代码尾,一行都不并
eq(u("cd /tmp\nls -la\nnpm run build"), "cd /tmp\nls -la\nnpm run build", "shell 命令不动");
// 代码围栏整段不动
eq(u("```js\nconst a = 1;\nconst b = 2;\n```"), "```js\nconst a = 1;\nconst b = 2;\n```", "围栏代码不动");
// 缩进代码块不动
eq(u("    if (x) {\n        doSomething();\n    }\n    return x;"), "    if (x) {\n        doSomething();\n    }\n    return x;", "缩进代码不动");
// 英文折行:并的时候补一个空格
eq(u("This paragraph is long enough that a narrow column had to wrap it onto\nsomething else entirely"),
   "This paragraph is long enough that a narrow column had to wrap it onto something else entirely", "英文折行补空格");
// 手敲的短句列表:每行都远没到任何栏宽,一行都不许并(前两行短侥幸留住、第三行起全被吸走的老 bug)
eq(u("提升写报告的效率\n提升写会议纪要的效率\n提升产品方案的产出效率和质量\n提升产品原型的产出和验证速度\n提升设计稿的产出效率和质量\n降低日常协作和项目管理的成本"),
   "提升写报告的效率\n提升写会议纪要的效率\n提升产品方案的产出效率和质量\n提升产品原型的产出和验证速度\n提升设计稿的产出效率和质量\n降低日常协作和项目管理的成本", "短句列表不动");
// 真折行连着三行以上:每条原始行都到顶格,该一路并到段末那条短行为止
eq(u("窄栏里的一段话被截成好几行窄栏里的一段话被截成好几行\n第二行也是顶格的第二行也是顶格的第二行也是顶格\n最后这行没写满"),
   "窄栏里的一段话被截成好几行窄栏里的一段话被截成好几行第二行也是顶格的第二行也是顶格的第二行也是顶格最后这行没写满", "三行折行连并");
// 长短句混排:长行是真被截断的,短行(段末)不许把下一行吸上来
eq(u("这一行长到顶格了这一行长到顶格了这一行长到顶格了这一行长到顶格了\n被截下来的续行\n另起的一句短的\n再来一句短的"),
   "这一行长到顶格了这一行长到顶格了这一行长到顶格了这一行长到顶格了被截下来的续行\n另起的一句短的\n再来一句短的", "段末短行不吸下一行");
// 一串链接 + 一句说明:链接各占一行,后面那句也不许被吸上去
eq(u("https://github.com/acme/repo-a/pull/8\nhttps://github.com/acme/repo-b/pull/33\n再review这两个pr"),
   "https://github.com/acme/repo-a/pull/8\nhttps://github.com/acme/repo-b/pull/33\n再review这两个pr", "链接列表不动");
// 绝对路径同理
eq(u("/Users/me/Projects/repo-a\n/Users/me/Projects/repo-b"),
   "/Users/me/Projects/repo-a\n/Users/me/Projects/repo-b", "路径列表不动");
// 代码块「复制」按钮拿到的是裸命令(没有围栏、没有缩进):行尾对齐的注释是关键线索,一行都不许并
eq(u("git fetch origin\ngit checkout main          # 或 master/develop\ngit pull origin main       # 更新主分支到最新"),
   "git fetch origin\ngit checkout main          # 或 master/develop\ngit pull origin main       # 更新主分支到最新", "带对齐注释的命令不动");
// 行尾注释(不带多空格对齐)同样阻断合并
eq(u("const timeoutMillis = 30000; // 三十秒后放弃重试\nconst retries = 3"),
   "const timeoutMillis = 30000; // 三十秒后放弃重试\nconst retries = 3", "行尾注释不并");

// htmlHasBlocks:剪贴板 HTML 里有块级结构 → 换行是结构性的,调用方跳过合并
is(hb('<meta charset="utf-8"><ol><li>ws 握手</li><li>写 0600</li></ol>'), true, "有序列表算块级");
is(hb("<p>第一段</p><p>第二段</p>"), true, "段落算块级");
is(hb("一行<br>两行"), true, "br 算块级");
is(hb('<span style="color:#fff">纯行内片段</span>'), false, "行内 span 不算");
is(hb("<div><span>WebKit 包一层 div</span></div>"), false, "div 不算(WebKit 什么都套)");
is(hb("<pre>git fetch origin\ngit pull</pre>"), false, "pre 不算(代码照旧走折行判定)");
is(hb(""), false, "空 HTML 不算");
console.log("all ok");
