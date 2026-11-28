// prosePaths 自检。跑法(零新依赖):
//   npx esbuild src/lib/prosepath.check.ts --bundle --format=esm | node --input-type=module
import { prosePaths } from "./prosepath";

// 和 Chat.tsx 的 proseOk 同形:绝对路径看首段,相对路径看扩展名
const ok = (raw: string) => /^~\//.test(raw) || (raw.startsWith("/") ? /^\/(Users|tmp)\//.test(raw) : /\.(ts|tsx|md|dmg)$/.test(raw));
const eq = (text: string, want: unknown, name: string) => {
  const [g, w] = [JSON.stringify(prosePaths(text, ok)), JSON.stringify(want)];
  if (g !== w) throw new Error(`✗ ${name}\n  got : ${g}\n  want: ${w}`);
  console.log(`✓ ${name}`);
};
const P = (path: string) => ({ path });

eq("公证包已经打好：/Users/a/Luna/Luna.dmg", ["公证包已经打好：", P("/Users/a/Luna/Luna.dmg")], "全角冒号后的绝对路径");
eq("包在 /Users/a/Luna.dmg。装一下", ["包在 ", P("/Users/a/Luna.dmg"), "。装一下"], "全角句号是边界");
eq("见 /Users/a/Luna.dmg已生成", ["见 ", P("/Users/a/Luna.dmg"), "已生成"], "扩展名后紧跟的中文切回正文");
eq("档案在 ~/Vault/关于我.md.", ["档案在 ", P("~/Vault/关于我.md"), "."], "中文文件名保留,句尾点剥掉");
eq("改动在 src/lib/a.ts 和 docs/b.md", ["改动在 ", P("src/lib/a.ts"), " 和 ", P("docs/b.md")], "带斜杠的相对路径");
eq("TCP/IP 和/或 A/B、/api/v1/users", ["TCP/IP 和/或 A/B、/api/v1/users"], "斜杠词与 API 路由不认");
eq("打开 localhost:8080/tmp/a.md 看", ["打开 localhost:8080/tmp/a.md 看"], "URL 里的路径段不认");
eq("Node.js 和 README.md", ["Node.js 和 README.md"], "裸文件名不认");
