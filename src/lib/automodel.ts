import type { AuthStatus, ModelInfo, ProviderState } from "../types";

// 第一次配好第三方 key 时,替用户把模型选好(新用户不知道还要去 /model 菜单再选一次,
// 不选就还挂在 Claude 默认模型上,一发消息就报未登录)。返回该选哪个模型,null = 不插手。
//
// 三个前提缺一不动手:
//  ① prev 有值 —— 启动时的首份 auth_status 里 configured 是老配置,不是"刚配好";
//  ② 没登录 Claude —— 登了就有可用模型,不该被顶掉;
//  ③ homeModel 还是 "default" —— 用户从没自己选过模型。配第二家 key 时它已不是 default,自然不再插手。
export function pickAutoModel(prev: AuthStatus | null, next: AuthStatus | null, homeModel: string): ModelInfo | null {
  if (!prev || !next || next.claude?.loggedIn || homeModel !== "default") return null;
  const prevProvs = prev.providers ?? {};
  const fresh = Object.entries<ProviderState>(next.providers ?? {})
    .find(([id, p]) => p?.configured && !prevProvs[id]?.configured && p.models?.[0]?.value);
  return fresh?.[1].models?.[0] ?? null;
}
