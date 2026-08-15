<div align="center">

[English](README.md) · **简体中文**

<img src="https://chatcode.dengteng.xyz/logo.png" width="88" alt="ChatCode">

# ChatCode

**和 Agent 聊天，指挥他为你实现梦想**

ChatCode 是封装了终端内核的对话式编程客户端，轻量、好用、安全、功能强大。<br>
读文件、改代码、跑测试、Git 操作、Shell 命令，都在一个窗口里搞定。

[![platform](https://img.shields.io/badge/platform-macOS%20·%20Apple%20Silicon-111?style=flat-square)](https://github.com/dengteng/ChatCode/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-111?style=flat-square)](LICENSE)
[![core](https://img.shields.io/badge/core-Claude%20Agent%20SDK-111?style=flat-square)](https://github.com/anthropics/claude-agent-sdk-typescript)
[![models](https://img.shields.io/badge/models-9-111?style=flat-square)](#多模型兼容)

[官网](https://chatcode.dengteng.xyz/) · [下载 macOS 版](https://github.com/dengteng/ChatCode/releases/latest)

<img src="https://chatcode.dengteng.xyz/shots/1.webp" width="880" alt="ChatCode 主界面">

</div>

---

## 快速开始

前提：先装好并登录 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview)（v2+）。所有模型都由它执行，因此能直接用上它整套 harness 工具。

```sh
claude --version   # 确认 CLI 就位
```

然后到 [Releases](https://github.com/dengteng/ChatCode/releases/latest) 下载 `.dmg`，拖进「应用程序」即可。安装包不到 30M，冷启动一两秒。

Claude 走订阅 OAuth，不用填 API Key；其余模型在「设置 → 模型」里配好 key 随时切。

## 功能

### 万能输入框

结合终端命令与交互式界面的双重优势。

- `!` 跑 shell、`@` 找文件、`/` 发命令、`#` 挑 Skill、`↑` 翻上一条，原样保留终端习惯
- 粘贴图片、引用消息，与文本内联混排展示，不占地方，相关性强
- 不想傻等任务完成？最多可以发 3 条排队消息，Agent 完成前序任务后自动按排序执行

### 多模型兼容

Claude 走订阅 OAuth，其余走 Anthropic 兼容直连，共享 Claude 强大的 harness 工具。

- 九种大模型随时切，多个 Agent 真并行
- 每个会话一条独立 query，互不阻塞
- 支持连接 GitHub 与 SSH，本地开发、远程部署一个页面完成

### 项目抽屉

项目右侧抽屉页：分支、文件、记忆、活动。

- 分支：查看暂存区和提交拓扑，代码一键 push/pull，AI 自动生成 commit 文案
- 活动：会话起的进程和端口，用完即停
- 文件与记忆可以在项目内就地查看和编辑

### 省时省心

该你拍板的才打断你，剩下的它自己往下跑。

- 勾选自动同意后，一个任务一干到底，不来回问
- 上下文、5 小时、周用量与重置时间常驻底栏，不浪费每一个 token
- 每轮的耗时、token 消耗、缓存命中都有账

### 轻快的个性化体验

Tauri 打包的原生窗口，不是又一个套壳 Electron。

- 安装包不到 30M，冷启动一两秒
- 常驻内存几十兆，插着电写一天不烫手
- 五套主题，还能丢一张壁纸进来自动取色

### 记忆 · 技能 · MCP

和 Claude Code 同步，还有插件市场。

- Skills、插件、MCP 各成一栏，与 Claude Code 同步
- 市场即搜即装，临时停用、长期卸载都在这儿
- 每项能加备注，装多了也不会忘了它干嘛的
- 本次记了/引用了哪条记忆、用了哪个 Skill，Agent 自己报备

## 界面

20M 体积不大，功能却不少。适合个人 Vibe Coding 或小团队。

<details>
<summary>展开全部 9 张截图</summary>

**分支管理** — AI 生成 commit 内容，在侧栏即可管理暂存区/本地分支/远程分支、提交拓扑

<img src="https://chatcode.dengteng.xyz/shots/6.webp" width="820">

**活动管理** — 查看会话起了哪些进程、占了哪些端口，一键停止省资源，本地调试必备

<img src="https://chatcode.dengteng.xyz/shots/8.webp" width="820">

**@ 引用文件** — @ 唤起项目目录搜索，输入关键词部分匹配文件，发给 AI 让它明白你要改啥

<img src="https://chatcode.dengteng.xyz/shots/3.webp" width="820">

**图片与引用** — 输入框内粘贴图片、插入会话消息引用，内联展示提示词相关性更强

<img src="https://chatcode.dengteng.xyz/shots/4.webp" width="820">

**多模型支持** — Claude 走订阅 OAuth，其余模型走 Anthropic 兼容直连，配好 key 随时切

<img src="https://chatcode.dengteng.xyz/shots/2.webp" width="820">

**插件 · MCP · Skills** — 一站式管理：搜索、安装、临时停用、卸载、加备注

<img src="https://chatcode.dengteng.xyz/shots/5.webp" width="820">

**主题皮肤** — 五套主题配色，支持「自定义背景图」，自动拾色配色

<img src="https://chatcode.dengteng.xyz/shots/9.webp" width="820">

**快捷操作** — 正则解析 url/文件路径，支持快速复制、打开、进入目录

<img src="https://chatcode.dengteng.xyz/shots/7.webp" width="820">

</details>

## 架构

极简架构，一个原生窗口 + 一个本机内核，密钥和代码都不出你的机器。

<img src="https://chatcode.dengteng.xyz/chatcode-architecture.svg" width="900" alt="ChatCode 系统架构图">

```
Tauri webview (React + TypeScript)
        │ ws://127.0.0.1
Node sidecar (sidecar/server.mjs)
        │ @anthropic-ai/claude-agent-sdk（spawn claude CLI，stream-json）
Claude Code harness（工具 / 权限 / hooks / MCP / 会话）
```

会话数据持久化在 `~/.chat-code/`。

## 安全

- 官方端点直连，不改 `baseUrl`，防止 Prompt 注入
- API Key 只落本机，文件权限 `0600`，不上传任何服务器，别的进程读不到
- Claude 免输入 API Key，完全基于 CLI 打造

## 从源码运行

```sh
npm install
npm run dev        # 同时起 sidecar + vite，浏览器打开 http://localhost:5173
npm run tauri dev  # 或者跑 Tauri 窗口（首次会编译 Rust，较慢）
```

## 反馈

反馈 Bug、提需求、想一起做点什么，都欢迎。Issue 通常一天内回。

- [提 Issue](https://github.com/dengteng/ChatCode/issues)
- 邮件 dengteng2025@gmail.com
- [作者主页](https://dengteng.xyz)

作者的其他项目：[Lunaris Fortune Calendar](https://lunaris.dengteng.xyz/)（常驻 Mac 菜单栏的日历日程运势管理工具）· [Stock Review](https://stock.dengteng.xyz/)（每日股票复盘助手）

## License

[MIT](LICENSE)
