// 额度用尽后「什么时候自动续跑」的判据。单拎出来是为了能脱开 React 自检(见 autoresume.check.ts)。

// 额度恢复后再多等 1 分钟才发:服务端给的 resetsAt 和本机时钟差几十秒是常事,
// 掐着点发就是再撞一次墙 —— 而这次撞完,队列里已经没有那条续跑了。
export const RESUME_GRACE = 60_000;

// SDK 的 resetsAt 有时给秒、有时给毫秒(和 sidecar 那边 toMs 同一套判据:2001 年之前的毫秒值不可能出现)
const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);

// 返回该排的发送时刻;拿不到恢复时刻、或那一刻已经过去(说明这轮压根不是卡在等额度)时返回 null。
export function resumeAt(resetAt: number | null | undefined, now: number): number | null {
  if (!resetAt) return null;
  const at = toMs(resetAt) + RESUME_GRACE;
  return at > now ? at : null;
}
