import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type React from "react";

// shadcn 标准工具:合并 className,后者覆盖前者的同类 Tailwind 类
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 动作按钮的按下语义:一律走 mousedown,不用 click。
// WKWebView 里输入框(contenteditable)聚焦时 / 窗口未聚焦时,落在别处的第一次 click **根本不派发**
// —— 只用来移焦点,表现就是"点了没反应,要点两次"。mousedown 不受影响。
// click 仍留一手 stopPropagation:mousedown 上的 stopPropagation 拦不住随后那个 click 冒泡到外层容器。
// 这坑本仓库踩过三回(菜单项、分支 chip、分支图上的 push 按钮),新加动作按钮直接用这个。
export const btnPress = (fn: () => void) => ({
  onMouseDown: (e: React.MouseEvent) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); fn(); } },
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
});
