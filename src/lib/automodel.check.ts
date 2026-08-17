// pickAutoModel 自检。跑法(零新依赖):
//   npx esbuild src/lib/automodel.check.ts --bundle --format=esm | node --input-type=module
import { pickAutoModel } from "./automodel";
import type { AuthStatus } from "../types";

const eq = (got: string | null, want: string | null, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}\n  got : ${got}\n  want: ${want}`);
  console.log(`✓ ${name}`);
};

const DS = [{ value: "deepseek/deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
            { value: "deepseek/deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }];
const KIMI = [{ value: "kimi/k3", displayName: "Kimi K3" }];
const st = (provs: any, loggedIn = false): AuthStatus =>
  ({ claude: { installed: true, loggedIn, method: "" }, github: { installed: false, loggedIn: false }, providers: provs });

const none = st({ deepseek: { label: "DeepSeek", configured: false, models: DS } });
const ds = st({ deepseek: { label: "DeepSeek", configured: true, models: DS } });

const pick = (p: AuthStatus | null, n: AuthStatus | null, hm = "default") => pickAutoModel(p, n, hm)?.value ?? null;

eq(pick(none, ds), "deepseek/deepseek-v4-flash", "首次配好 key → 选该家第一个模型");
eq(pick(null, ds), null, "启动首份快照不算刚配好");
eq(pick(none, ds, "kimi/k3"), null, "用户已选过模型 → 不顶掉");
eq(pick(ds, ds), null, "同一份状态重播 → 不重复切");
eq(pick(none, st({ deepseek: { label: "DeepSeek", configured: true, models: DS } }, true)), null, "已登录 Claude → 不插手");
// 第二把 key:第一把配好时 homeModel 已被写成 deepseek/…,所以这里天然不动
eq(pick(ds, st({ deepseek: { label: "DeepSeek", configured: true, models: DS },
                 kimi: { label: "Kimi", configured: true, models: KIMI } }), "deepseek/deepseek-v4-flash"),
   null, "配第二家 key → 不插手");
// 模型表为空的 provider(用户把模型表清空了)不该选出个 undefined
eq(pick(st({ x: { label: "X", configured: false, models: [] } }), st({ x: { label: "X", configured: true, models: [] } })),
   null, "模型表为空 → 不选");

console.log("automodel 全部通过");
