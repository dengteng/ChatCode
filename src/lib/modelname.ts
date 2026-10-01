// 模型 id 的纯字符串处理,零依赖(types.ts 会拉起 i18n,node 自检里 import 不动它)。

// 模型 id → 版本号("claude-opus-5[1m]" → "5"、"claude-haiku-4-5-20251001" → "4.5")。
// SDK 报的 displayName 只有家族名("Opus"/"Sonnet"),可同叫 Opus 的 4.8 和 5 是两个模型 ——
// 用户想知道的正是"几代",光看家族名等于没说。
// 切法:先扔掉 [1m] 这类后缀,按 - 切,跳过 "claude" 和家族名,吃连续的 1~2 位数字段。
// 尾巴上的日期戳(20251001)就是靠"最多 2 位"停下的,不然会得到 "4.5.20251001"。
// 非 claude 家族(deepseek-v4-pro 之类)第三段就不是纯数字,直接返回空 —— 不猜,原样用 displayName。
export function modelVer(id?: string): string {
  const segs = (id ?? "").replace(/\[.*$/, "").split("-").slice(2);
  const v: string[] = [];
  for (const s of segs) { if (!/^\d{1,2}$/.test(s)) break; v.push(s); }
  return v.join(".");
}

// 裸模型 id → 短名("claude-opus-5-5" → "Opus 5.5")。给拿不到会话模型清单的地方用(如回退提示的 from/to);
// 认不出的原样返回,不猜。
export function shortModelName(id: string): string {
  const fam = /^claude-([a-z]+)-/.exec(id)?.[1];
  const ver = modelVer(id);
  return fam && ver ? `${fam[0].toUpperCase()}${fam.slice(1)} ${ver}` : id;
}
