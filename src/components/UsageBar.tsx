import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LimitUsage, Session, Spend, Wallet } from "../types";
import { contextWindowOf, sessionProvider } from "../types";
import { useStore } from "../store";
import { PERMISSION_PRESETS, presetOf, type PermissionMode } from "../permissions";

// c: 用量条
//  1) 上下文窗口占比 —— 来自 modelUsage / message_start usage
//  2) session 5h 限额 3) weekly 限额 —— Claude 走 SDK /usage,Kimi 走自家 /v1/usages,按 provider 各取各的
export function UsageBar({ session, auto, mode, onPreset }:
  { session: Session; auto: boolean; mode: PermissionMode; onPreset: (key: string) => void }) {
  const { t } = useTranslation();
  const { state, refreshUsage } = useStore();
  const ctxWindow = contextWindowOf(session);
  const ctxPct = ctxWindow ? Math.min(100, (session.contextTokens / ctxWindow) * 100) : 0;
  // 用量的第二格按 provider 的**声明**二选一(providers.mjs 的 subscriptionUsage):
  //   订阅制(Claude / Kimi 编程套餐)→ 5h + 周两个额度窗口;
  //   按量计费(DeepSeek 等)→ 本会话累计花费/token(sidecar 的 spend.mjs 记账)。
  // 别再往这里写 provider 名单:新接一家只在 providers.mjs 声明一次,这里不用动。
  // 严格按 provider 各取各的数据 —— Kimi 会话绝不显示 Claude 的额度。
  const prov = sessionProvider(session);
  const hasLimits = prov === "claude" || !!state.auth?.providers?.[prov]?.subscriptionUsage;
  const spend = state.spend[session.id];
  const usage = prov === "kimi" ? state.usageKimi : state.usage;
  const { fetchedAt, stale } = usage;
  // 刚切过来还没有该 provider 的数据:立刻探一次,别干等下一轮轮询
  useEffect(() => { if (hasLimits && fetchedAt === null) refreshUsage(); }, [prov, hasLimits, fetchedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="usage-bar">
        {/* 格式:上下文(最大窗口) [进度条] 已用百分比(无小数);token 绝对值挪到 hover 里 */}
        <Meter label={t("上下文({{w}})", { w: fmt(ctxWindow) })} pct={ctxPct}
          detail={`${Math.round(ctxPct)}%`}
          title={`${fmt(session.contextTokens)}/${fmt(ctxWindow)} tokens`} warn={ctxPct > 80} />
        {hasLimits ? <>
          <LimitMeter label="5h" limit={usage.session} fetchedAt={fetchedAt} stale={stale} />
          <LimitMeter label="周" limit={usage.weekly} fetchedAt={fetchedAt} stale={stale} />
        </> : <><SpendChip spend={spend} /><WalletChip w={state.wallet[prov]} /></>}
      </div>
      {/* 挪出 usage-bar(它有 max-width 上限),靠 margin-left:auto 顶到输入框右缘。
          闲聊会话也能调工具(搜索/命令等)触发授权,权限档位一样适用。 */}
      <PermPicker mode={mode} auto={auto} onPreset={onPreset} />
    </>
  );
}

// 权限档位选择器。当前档位由两个旋钮(SDK 权限模式 + 会话级自动同意)**推导**,不另存一份 ——
// 授权卡片里单独点了"本次会话自动接受所有文件编辑"之类,这里会如实变成对应档位或「自定义」。
// 「自定义」只显示、不可选(disabled),选项里永远只有真档位。
function PermPicker({ mode, auto, onPreset }: { mode: PermissionMode; auto: boolean; onPreset: (key: string) => void }) {
  const { t } = useTranslation();
  const cur = presetOf(mode, auto);
  const preset = PERMISSION_PRESETS.find((p) => p.key === cur);
  return (
    <select className={`perm-picker ${cur === "ask" ? "" : "on"}`} value={cur}
      title={preset ? t(preset.desc) : t("当前的权限组合不属于任何档位(多半是在授权卡片里单独改过)")}
      onChange={(e) => onPreset(e.target.value)}>
      {cur === "custom" && <option value="custom" disabled>{t("自定义")}</option>}
      {PERMISSION_PRESETS.map((p) => <option key={p.key} value={p.key}>{t(p.label)}</option>)}
    </select>
  );
}

function Meter({ label, pct, detail, warn, title }: { label: string; pct: number; detail: string; warn?: boolean; title?: string }) {
  return (
    <div className="meter" title={title ?? detail}>
      <div className="meter-label">{label}</div>
      <div className="meter-track"><div className={`meter-fill ${warn ? "warn" : ""}`} style={{ width: `${pct}%` }} /></div>
      <div className="meter-label"><span className="meter-detail">{detail}</span></div>
    </div>
  );
}

function LimitMeter({ label, limit, fetchedAt, stale }:
  { label: string; limit: LimitUsage; fetchedAt: number | null; stale: boolean }) {
  const { t } = useTranslation();
  const { refreshUsage } = useStore();
  const [nudge, setNudge] = useState(0); // 定时器越过重置点后自增,强制本 effect 重跑,切进兜底轮询
  // "剩 2h30m"/"更新于 x 前"要自己走;tick 还当调度 effect 的心跳:长 setTimeout 会被后台节流/系统睡眠
  // 暂停,倒计时(按 Date.now 重渲)已归零它却没响 → 不刷新。每 30s(含睡眠唤醒后)重跑 effect 重判过点。
  const tick = useTicker(limit.resetAt !== null || fetchedAt !== null);
  // 窗口重置那一刻主动拉一次新用量,并把倒计时刷成新窗口 —— 不干等最多 60s 的后端轮询。
  useEffect(() => {
    if (limit.usedPct === null) return; // 压根没数据就不轮询
    const now = Date.now();
    // 有未来的重置点:精确定时到那一刻(+1.5s)主动刷新;setNudge 让 effect 随即重跑,
    // 若届时后端还没给出新窗口(resetAt 仍过期),就落到下面的 15s 兜底轮询,直到新窗口到手。
    if (limit.resetAt && limit.resetAt > now) {
      const t = setTimeout(() => { refreshUsage(); setNudge((n) => n + 1); }, limit.resetAt - now + 1500);
      return () => clearTimeout(t);
    }
    // 无重置点 / 已过期:立即刷 + 每 15s 补刷,直到 /usage 给出新窗口的未来 resets_at(倒计时才显示得出来)
    refreshUsage();
    const iv = setInterval(refreshUsage, 15_000);
    return () => clearInterval(iv);
  }, [limit.resetAt, limit.usedPct, nudge, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (limit.usedPct === null) {
    // 未登录才给状态字;其余(加载中 / 一时拿不到)一律留空,别写"暂不可用"
    const status = limit.unavailableReason?.includes("未登录") ? t("需登录") : "";
    return (
      <div className="meter meter-lim" title={limit.unavailableReason || t("用量加载中")}>
        <div className="meter-label">{t(label)}{status && <> <span className="meter-detail muted">{status}</span></>}</div>
        <div className="meter-track"><div className="meter-fill placeholder" style={{ width: "0%" }} /></div>
      </div>
    );
  }
  const effReset = rollReset(limit.resetAt, label); // 过点后按固定周期推进到下一个未来边界,倒计时立即重启(不干等 API 推进 resets_at)
  const left = effReset ? fmtReset(effReset) : null;
  const pct = Math.min(100, limit.usedPct); // 超额时 API 会回 >100(如 103%),条封顶 100
  const scope = label === "5h" ? t("本 session (5h)") : t("本周");
  // 窗口已经翻篇(resetAt 过点),但服务端还在回上一窗口的 utilization —— 倒计时被本地 rollReset 重启成
  // "剩 4h59m",百分比却还是旧窗口的 94%,连起来读就是"新窗口一开就用掉 94%",纯属误导。
  // 这段时间的真实占用是「未知」,如实标出来,别拿旧数字冒充。上面的 effect 正每 15s 追新值。
  const rolled = limit.resetAt !== null && limit.resetAt <= Date.now();
  // rolled 但已 stale(服务端超过 10min 还只回旧窗口):别永远"刷新中",如实灰显上一窗口的旧百分比
  const showRoll = rolled && !stale;
  // 额度是账户级的:别的客户端烧掉的部分,要等我们下一次刷新才看得到 —— 所以明说这份数字有多旧。
  const age = fetchedAt ? fmtAge(Date.now() - fetchedAt) : null;
  const freshness = stale ? t("⚠︎ 刷新失败,数据停在 {{age}}前", { age: age ?? t("更早") }) : age ? t("更新于 {{age}}前", { age }) : "";
  const detail = rolled ? t("上一窗口 {{pct}}%,新窗口用量待服务端更新", { pct: pct.toFixed(0) }) : t("{{scope}} 已用 {{pct}}%", { scope, pct: pct.toFixed(0) });
  return (
    <div className={`meter meter-lim ${stale ? "stale" : ""} ${showRoll ? "rolled" : ""}`}
      title={`${detail}${left ? ` ${t("· {{left}} 后重置额度", { left })}` : ""}${freshness ? `\n${freshness}` : ""}`}>
      <div className="meter-label">{t(label)}</div>
      <div className="meter-track"><div className={`meter-fill ${!showRoll && pct > 80 ? "warn" : ""}`} style={{ width: `${showRoll ? 0 : pct}%` }} /></div>
      <div className="meter-label"><span className="meter-detail">{showRoll ? t("刷新中") : `${pct.toFixed(0)}%`}</span>{left && <> {t("剩")} <span className="meter-detail">{left}</span></>}</div>
    </div>
  );
}

// 每 30s 重渲染一次,让"剩 2h30m"随时间往下走
function useTicker(on: boolean) {
  const [n, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, [on]);
  return n;
}

// 按量计费 provider 的那一格:只显示本会话花掉的钱。
// 没单价(cost=0)就整格不画 —— token 数聊天区右下角的会话统计已经有了,这里再来一份纯属重复。
// 不给进度条 —— 没有额度上限可比,画个条就是在暗示"用到某个位置会满",那是假的。
function SpendChip({ spend }: { spend?: Spend }) {
  const { t } = useTranslation();
  if (!spend || spend.cost <= 0) return null;
  // unpriced:模型表里有 token 查不到单价,金额只是已计价的那部分,标个 ~ 别让人当全额
  const money = `${spend.unpriced ? "~" : ""}${spend.currency || "$"}${spend.cost.toFixed(spend.cost < 1 ? 3 : 2)}`;
  return (
    <div className="meter meter-spend" title={t("输入 {{i}} · 输出 {{o}} · 缓存读 {{cr}} · 缓存写 {{cw}}", {
      i: fmt(spend.in), o: fmt(spend.out), cr: fmt(spend.cacheRead), cw: fmt(spend.cacheWrite),
    })}>
      <span className="meter-label">{t("本会话")}</span>
      <span className="meter-detail">{money}</span>
    </div>
  );
}

// 账户余额 + 今日/本月消费。余额来自 provider 接口(目前只有 DeepSeek 提供),
// 今日/本月是本地账本 —— 各家都没有消费查询 API,只能按单价自己记,所以只覆盖 ChatCode 里的花费。
// 这点差别必须在 tooltip 里说明:不然用户拿它和官网账单对不上会以为算错了。
function WalletChip({ w }: { w?: Wallet }) {
  const { t } = useTranslation();
  if (!w || (w.balance === undefined && !w.month && !w.today)) return null; // 没余额接口又还没花过钱:不占位
  const cur = w.currency || w.balanceCurrency || "";
  const money = (n: number, c: string) => `${c}${n > 0 && n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
  const title = [
    w.balance !== undefined ? t("账户余额 {{v}}(来自 provider 接口)", { v: money(w.balance, w.balanceCurrency || cur) }) : "",
    t("今日 {{d}} · 本月 {{m}} —— 按模型表单价累计的本机账本,只含 ChatCode 里的花费", { d: money(w.today, cur), m: money(w.month, cur) }),
    w.error ? t("⚠︎ 余额刷新失败:{{e}}(显示的是上一次的值)", { e: w.error }) : "",
  ].filter(Boolean).join("\n");
  return (
    <div className={`meter meter-spend ${w.error ? "stale" : ""}`} title={title}>
      {w.balance !== undefined && <>
        <span className="meter-label">{t("余额")}</span>
        <span className="meter-detail">{money(w.balance, w.balanceCurrency || cur)}</span>
      </>}
      <span className="meter-label">{t("今日")}</span>
      <span className="meter-detail">{money(w.today, cur)}</span>
      <span className="meter-label">{t("本月")}</span>
      <span className="meter-detail">{money(w.month, cur)}</span>
    </div>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`; // 1M 上下文别写成 1000k
  return n > 9999 ? `${(n / 1000).toFixed(0)}k` : String(n);
}
// "更新于 x 前":秒级精度只在最初 60s 有意义,之后按分钟读
function fmtAge(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s `;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m ` : `${Math.floor(min / 60)}h${min % 60}m `;
}
// 窗口固定 5h / 7d 滚动。resetAt 一旦过点(账户 API 常滞后才推进 resets_at),
// 就按周期补到下一个未来边界,让倒计时立即重启,不再卡在"剩 0m"。
// ponytail: 固定周期假设;探针拿到真·新窗口后,后端 better() 会用精确值覆盖显示。
const WIN_PERIOD: Record<string, number> = { "5h": 5 * 3600_000, "周": 7 * 24 * 3600_000 };
function rollReset(resetAt: number | null, label: string): number | null {
  if (!resetAt) return null;
  const now = Date.now();
  if (resetAt > now) return resetAt;
  const p = WIN_PERIOD[label];
  if (!p) return null;
  return resetAt + Math.ceil((now - resetAt) / p) * p;
}
function fmtReset(ts: number) {
  const min = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`; // 周额度动辄上百小时,按天读才有意义
}
