import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  // 主题跟随 .app[data-theme] —— 不用 shadcn 默认的 .dark 类
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    // 关掉 preflight:项目已有 670 行手写 CSS + 全局 button/input 样式,preflight 的 reset 会把它们全冲掉
    preflight: false,
  },
  theme: {
    extend: {
      // 颜色直接指到既有 CSS 变量,浅/暗主题靠变量自动翻转,shadcn 组件零改动即随主题变色
      colors: {
        background: "var(--bg)",
        foreground: "var(--text)",
        border: "var(--border)",
        input: "var(--border)",
        ring: "var(--accent)",
        primary: { DEFAULT: "var(--accent)", foreground: "#ffffff" },
        secondary: { DEFAULT: "var(--agent)", foreground: "var(--text)" },
        muted: { DEFAULT: "var(--agent)", foreground: "var(--muted)" },
        accent: { DEFAULT: "var(--agent)", foreground: "var(--text)" },
        destructive: { DEFAULT: "#e5484d", foreground: "#ffffff" },
        popover: { DEFAULT: "var(--panel)", foreground: "var(--text)" },
        card: { DEFAULT: "var(--panel)", foreground: "var(--text)" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
