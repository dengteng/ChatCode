// cleanMemory 自检。跑法(零新依赖):
//   npx esbuild src/lib/memtext.check.ts --bundle --format=esm | node --input-type=module
import { cleanMemory, stripLineNums } from "./memtext";

const eq = (got: string, want: string, name: string) => {
  if (got !== want) throw new Error(`✗ ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  console.log(`✓ ${name}`);
};

// 真实形态:system-reminder + frontmatter + 正文。两者都要剥掉,标题从 frontmatter 的 name 来
const REAL = `<system-reminder>This memory is 2 days old. Verify against current code.</system-reminder>

---
name: server-infra
description: "生产服务器布局"
metadata:
  type: project
---

生产服务器 203.0.113.10,用户 deployer。
布局(2026-07 确认):`;
eq(cleanMemory(REAL, "server-1.md").title, "server-infra", "标题取 frontmatter 的 name");
eq(cleanMemory(REAL, "server-1.md").body, "生产服务器 203.0.113.10,用户 deployer。\n布局(2026-07 确认):", "正文剥掉 reminder + frontmatter");

// 没有 reminder(Write 的 input.content)也要正常
eq(cleanMemory(`---\nname: solo\n---\n\n正文`, "x.md").title, "solo", "无 reminder 时读 name");
eq(cleanMemory(`---\nname: solo\n---\n\n正文`, "x.md").body, "正文", "无 reminder 时剥 frontmatter");

// name 带引号要去掉
eq(cleanMemory(`---\nname: "带引号"\n---\n正文`, "x.md").title, "带引号", "name 去引号");

// 没 frontmatter:回退到首个 # 标题
eq(cleanMemory(`# 一级标题\n\n正文`, "x.md").title, "一级标题", "无 frontmatter 回退 # 标题");
eq(cleanMemory(`# 一级标题\n\n正文`, "x.md").body, "# 一级标题\n\n正文", "无 frontmatter 时正文不动");

// 什么都没有:回退文件名(去 .md)
eq(cleanMemory("光秃秃的一行", "feedback-long-build.md").title, "feedback-long-build", "全无线索回退文件名");

// 正文里出现的 --- 分隔线不能被当成 frontmatter 尾巴吃掉
eq(cleanMemory(`前言\n\n---\n\n后记`, "x.md").body, "前言\n\n---\n\n后记", "正文中的分隔线保留");

// 空 reminder 之后正文为空 → body 空字符串,不是一堆空白
eq(cleanMemory(`<system-reminder>只有提醒</system-reminder>`, "x.md").body, "", "只有 reminder 时 body 为空");

// cat -n 行号前缀
eq(stripLineNums("     1\t第一行\n     2\t第二行"), "第一行\n第二行", "剥 cat -n 行号");

console.log("all ok");
