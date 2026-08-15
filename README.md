<div align="center">

**English** · [简体中文](README.zh-CN.md)

<img src="https://chatcode.dengteng.xyz/logo.png" width="88" alt="ChatCode">

# ChatCode

**Chat with an agent. Put it to work on what you actually want built.**

ChatCode is a conversational coding client wrapped around a terminal core — light, easy, safe, and capable.<br>
Read files, edit code, run tests, drive Git, execute shell commands — all in one window.

[![platform](https://img.shields.io/badge/platform-macOS%20·%20Apple%20Silicon-111?style=flat-square)](https://github.com/dengteng/ChatCode/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-111?style=flat-square)](LICENSE)
[![core](https://img.shields.io/badge/core-Claude%20Agent%20SDK-111?style=flat-square)](https://github.com/anthropics/claude-agent-sdk-typescript)
[![models](https://img.shields.io/badge/models-9-111?style=flat-square)](#multi-model-support)

[Website](https://chatcode.dengteng.xyz/) · [Download for macOS](https://github.com/dengteng/ChatCode/releases/latest)

<img src="https://chatcode.dengteng.xyz/shots/1.webp" width="880" alt="ChatCode main window">

</div>

---

## Quick start

Prerequisite: install and sign in to the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) (v2+). Every model runs through it, so they all inherit its full harness of tools.

```sh
claude --version   # confirm the CLI is in place
```

Then grab the `.dmg` from [Releases](https://github.com/dengteng/ChatCode/releases/latest) and drag it into Applications. Under 30 MB, cold start in a second or two.

Claude uses subscription OAuth — no API key needed. Other models take a key under Settings → Models, and you can switch between them at any time.

## Features

### One input box for everything

The reach of terminal commands with the comfort of a real UI.

- `!` runs shell, `@` finds files, `/` sends commands, `#` picks a Skill, `↑` recalls the last message — your terminal habits carry over unchanged
- Paste images and quote messages inline with your text: compact, and tightly tied to what you're asking about
- Don't want to sit and wait? Queue up to 3 messages — the agent works through them in order as it finishes.

### Multi-model support

Claude runs on subscription OAuth; everything else connects directly over Anthropic-compatible endpoints, sharing the same powerful Claude harness.

- Nine models, switchable anytime, with multiple agents genuinely running in parallel
- One independent query per session — nothing blocks anything else
- Connect GitHub and SSH: local development and remote deployment from a single page

### Project drawer

A drawer on the right side of each project: Branches, Files, Memory, Activity.

- **Branches** — inspect the staging area and commit graph, push/pull in one click, let AI write the commit message
- **Activity** — the processes and ports this session started; stop them the moment you're done
- Files and memory can be viewed and edited in place, without leaving the project

### Stays out of your way

It interrupts you for the calls that are actually yours to make, and handles the rest on its own.

- Turn on auto-approve and a task runs start to finish without round trips
- Context, 5-hour and weekly usage, and reset times live in the status bar — no token goes unaccounted for
- Every turn logs its duration, token spend, and cache hits

### Fast and personal

A native Tauri window, not another Electron shell.

- Under 30 MB installed, cold start in a second or two
- Tens of megabytes resident — write all day on battery without your lap getting hot
- Five themes, or drop in a wallpaper and let it pick the palette for you

### Memory · Skills · MCP

In sync with Claude Code, plus a plugin marketplace.

- Skills, plugins, and MCP each get their own tab, synced with Claude Code
- Search and install from the marketplace; disable temporarily or uninstall for good, all in one place
- Annotate each entry so a crowded list still tells you what everything does
- The agent reports which memories it saved or cited and which Skills it used

## Interface

20 MB isn't much space, but there's a lot in it. Built for solo vibe coding or a small team.

<details>
<summary>Expand all 9 screenshots</summary>

**Branch management** — AI-written commit messages; manage the staging area, local and remote branches, and the commit graph right from the sidebar

<img src="https://chatcode.dengteng.xyz/shots/6.webp" width="820">

**Activity** — see which processes a session started and which ports they hold, then stop them in one click; essential for local debugging

<img src="https://chatcode.dengteng.xyz/shots/8.webp" width="820">

**@ file references** — `@` opens a project-wide search; type a fragment to match files and show the AI exactly what you want changed

<img src="https://chatcode.dengteng.xyz/shots/3.webp" width="820">

**Images and quotes** — paste images into the input box and quote earlier messages; inline rendering keeps the prompt tightly focused

<img src="https://chatcode.dengteng.xyz/shots/4.webp" width="820">

**Multi-model** — Claude over subscription OAuth, everything else over Anthropic-compatible direct connections; add a key and switch anytime

<img src="https://chatcode.dengteng.xyz/shots/2.webp" width="820">

**Plugins · MCP · Skills** — one place to search, install, disable, uninstall, and annotate

<img src="https://chatcode.dengteng.xyz/shots/5.webp" width="820">

**Themes** — five color schemes, plus a custom background image with automatic palette extraction

<img src="https://chatcode.dengteng.xyz/shots/9.webp" width="820">

**Quick actions** — URLs and file paths are parsed out for you: copy, open, or jump to the directory

<img src="https://chatcode.dengteng.xyz/shots/7.webp" width="820">

</details>

## Architecture

Deliberately small: one native window plus one local core. Your keys and your code never leave your machine.

<img src="https://chatcode.dengteng.xyz/chatcode-architecture-en.svg" width="900" alt="ChatCode system architecture">

```
Tauri webview (React + TypeScript)
        │ ws://127.0.0.1
Node sidecar (sidecar/server.mjs)
        │ @anthropic-ai/claude-agent-sdk (spawns the claude CLI, stream-json)
Claude Code harness (tools / permissions / hooks / MCP / sessions)
```

Session data is persisted under `~/.chat-code/`.

## Security

- Direct connections to official endpoints, with no `baseUrl` rewriting — closing off a prompt-injection vector
- API keys stay on your machine with `0600` file permissions; nothing is uploaded, and no other process can read them
- Claude needs no API key at all — it's built entirely on the CLI

## Running from source

```sh
npm install
npm run dev        # starts sidecar + vite together; open http://localhost:5173
npm run tauri dev  # or run the Tauri window (the first Rust build is slow)
```

## Feedback

Bug reports, feature requests, or just wanting to build something together — all welcome. Issues usually get a reply within a day.

- [Open an issue](https://github.com/dengteng/ChatCode/issues)
- Email dengteng2025@gmail.com
- [Author's homepage](https://dengteng.xyz)

Other projects by the author: [Lunaris Fortune Calendar](https://lunaris.dengteng.xyz/) (a calendar, schedule, and fortune manager living in the Mac menu bar) · [Stock Review](https://stock.dengteng.xyz/) (a daily stock review assistant)

## License

[MIT](LICENSE)
