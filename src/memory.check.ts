// memory.ts 合并逻辑自检。跑法:
//   npx esbuild src/memory.check.ts --bundle --format=esm | node --input-type=module
import { mergeIndex } from "./memory";

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`✗ ${msg}\n  got : ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`);
  n++;
};

eq(mergeIndex("", "- [A](a.md) — x\n"), "- [A](a.md) — x\n", "目标为空:整份拿过去");
eq(mergeIndex("- [A](a.md) — x\n", "- [A](a.md) — x\n"), "- [A](a.md) — x\n", "完全相同:原样不动");
eq(mergeIndex("- [A](a.md) — x\n", "- [B](b.md) — y\n"), "- [A](a.md) — x\n- [B](b.md) — y\n", "两边各有一条:并集,目标在前");
eq(mergeIndex("- [A](a.md) — x", "  - [A](a.md) — x  \n\n- [B](b.md) — y"), "- [A](a.md) — x\n- [B](b.md) — y\n", "去重忽略首尾空白,空行不搬");
console.log(`✓ memory 自检通过(${n} 条)`);
