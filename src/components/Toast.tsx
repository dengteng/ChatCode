// 全局 toast —— 全 App 唯一一套瞬时反馈。git 已提交/已推送、复制成功、设置里的成败、命令报错,全走这里。
// 用法:import { toast } from "./Toast"; toast("已提交", "success")
// 非 React 处(store / popout / 事件回调)也可继续 dispatchEvent("cc-toast"),两条路进的是同一个队列。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Info, TriangleAlert } from "lucide-react";

export type ToastTone = "success" | "error" | "info";

// key:给"等异步结果"的进度提示用 —— 带 key 的不自动消失,由 dismissToast(key) 收掉(等多久事先不知道);
// 同 key 只留一条,连点也不会叠一摞。
export function toast(text: string, tone: ToastTone = "info", key?: string) {
  window.dispatchEvent(new CustomEvent("cc-toast", { detail: { text, tone, key } }));
}
export function dismissToast(key: string) {
  window.dispatchEvent(new CustomEvent("cc-toast-dismiss", { detail: { key } }));
}

// 停留时长按"读完需要多久"给:报错文案长且要人做决定,给足时间;成功只是确认一下,快进快出。
const HOLD: Record<ToastTone, number> = { success: 2200, info: 2800, error: 4200 };
const ICON: Record<ToastTone, typeof Check> = { success: Check, error: TriangleAlert, info: Info };
const MAX = 3;      // 同屏最多 3 条,再多挤掉最旧的(连点 commit→push 时不至于糊一屏)
const EXIT_MS = 140; // 与 css .toast.leaving 动画时长对齐

type Item = { id: number; text: string; tone: ToastTone; leaving?: boolean };

let seq = 0;

export function ToastHost() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef(new Map<number, number>());
  const keyIds = useRef(new Map<string, number>()); // 带 key 的常驻 toast:key → 当前那条的 id

  // 收起某条:先打 leaving 让它播完退场动画,再从列表里摘掉(直接删会"啪"地消失)
  const dismiss = (id: number) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, leaving: true } : it)));
    const t = window.setTimeout(() => setItems((list) => list.filter((it) => it.id !== id)), EXIT_MS);
    timers.current.set(-id, t);
  };

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { text?: string; tone?: ToastTone; key?: string };
      const text = (d?.text ?? "").trim();
      if (!text) return;
      const key = d?.key;
      if (key && keyIds.current.has(key)) dismiss(keyIds.current.get(key)!); // 同 key 的旧条先收掉
      const item: Item = { id: ++seq, text, tone: d?.tone ?? "info" };
      setItems((list) => [...list.slice(-(MAX - 1)), item]);
      if (key) keyIds.current.set(key, item.id); // 常驻:不排自动收起的定时器
      else timers.current.set(item.id, window.setTimeout(() => dismiss(item.id), HOLD[item.tone]));
    };
    const onDismiss = (e: Event) => {
      const key = (e as CustomEvent).detail?.key;
      const id = key && keyIds.current.get(key);
      if (!id) return;
      keyIds.current.delete(key);
      dismiss(id);
    };
    window.addEventListener("cc-toast", on);
    window.addEventListener("cc-toast-dismiss", onDismiss);
    return () => {
      window.removeEventListener("cc-toast", on);
      window.removeEventListener("cc-toast-dismiss", onDismiss);
      timers.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  if (!items.length) return null;
  return (
    <div className="toast-host">
      {items.map((it) => {
        const Icon = ICON[it.tone];
        return (
          // 报错要打断读屏(assertive),成功/提示不抢话(polite)
          <div key={it.id} className={`toast toast--${it.tone} ${it.leaving ? "leaving" : ""}`}
            role="status" aria-live={it.tone === "error" ? "assertive" : "polite"}
            title={t("点击关闭")} onClick={() => dismiss(it.id)}>
            <span className="toast-icon"><Icon size={13} strokeWidth={2.6} /></span>
            <span className="toast-text">{it.text}</span>
          </div>
        );
      })}
    </div>
  );
}
