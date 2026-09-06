// resumeAt 自检。跑法(零新依赖):
//   npx esbuild src/lib/autoresume.check.ts --bundle --format=esm | node --input-type=module
import { resumeAt, RESUME_GRACE } from "./autoresume";

const eq = (got: number | null, want: number | null, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}\n  got : ${got}\n  want: ${want}`);
  console.log(`✓ ${name}`);
};

const now = 1_800_000_000_000; // 2027-01-15 前后,毫秒
const sec = now / 1000;

eq(resumeAt(now + 600_000, now), now + 600_000 + RESUME_GRACE, "毫秒时刻 → 加缓冲");
eq(resumeAt(sec + 600, now), now + 600_000 + RESUME_GRACE, "秒时刻 → 换算成毫秒再加缓冲");
eq(resumeAt(now - 600_000, now), null, "恢复时刻已过去 → 不排");
eq(resumeAt(now - 30_000, now), now - 30_000 + RESUME_GRACE, "刚过去不到一个缓冲 → 还在未来,照排");
eq(resumeAt(null, now), null, "没给恢复时刻 → 不排");
eq(resumeAt(0, now), null, "0 当没给");
console.log("all ok");
