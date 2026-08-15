// 侧栏底部"插件 · MCP · Skills"里那些名字是 agent 在 init 里上报的(只有名字,没有说明),
// 所以说明得自己从磁盘上找:技能读 SKILL.md 的 frontmatter,插件读 plugin.json,MCP 读配置文件。
// Claude Code 自带的内置技能(code-review / verify / loop …)是编进二进制的,本地没有 SKILL.md,
// 这类只能显示"内置技能"。
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import i18n from "./i18n";

export type McpScope = "user" | "local" | "project";
export interface Ext { name: string; desc: string; path?: string; marketplace?: string; on?: boolean }
export interface Exts {
  plugins: Ext[]; skills: string[]; mcp: string[];
  skillDesc: Record<string, string>; skillPath: Record<string, string>;
  skillOn: Record<string, boolean>; // 停用的 skill(SKILL.md 改名成 .off)也列出来,只是标灰
  skillProject: Record<string, string>; // 项目级 skill(<cwd>/.claude/skills)→ 项目目录名;用户级/插件的没有这项
  mcpDesc: Record<string, string>; mcpUrl: Record<string, string>;
  // 没这项 = 本地没有配置文件(claude.ai 云端连接器,或配置已被删掉的残影)。
  // cwd:local/project 级的 `claude mcp` 命令必须在那个项目目录里跑(它改的是该项目的配置);user 级没有。
  mcpMeta: Record<string, { scope: McpScope; on: boolean; config: any; cwd?: string }>;
}

const readText = (path: string) => invoke<string>("read_file", { path }).catch(() => "");
const subDirs = (path: string) =>
  invoke<[string, boolean][]>("list_dir", { path })
    .then((rows) => rows.filter(([n, isDir]) => isDir && !n.startsWith(".")).map(([n]) => n))
    .catch(() => [] as string[]);
const parseJson = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// SKILL.md 开头的 YAML frontmatter 里的 description。常写成 `>` 折行块,续行是缩进的,要一起收上来。
function skillDesc(md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!fm) return "";
  const lines = fm[1].split("\n");
  const i = lines.findIndex((l) => /^description\s*:/.test(l));
  if (i < 0) return "";
  const head = lines[i].replace(/^description\s*:\s*/, "").trim();
  const parts = /^[>|][-+]?$/.test(head) || !head ? [] : [head]; // `>` / `|` 本身不是内容
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
  return parts.join(" ").replace(/^["']|["']$/g, "");
}

// 停用一个 skill = 把 SKILL.md 改名成 SKILL.md.off:claude 扫不到就不加载,我们照样能列出来并一键恢复。
const SKILL_OFF = ".off";

async function skillsIn(dir: string, prefix = ""): Promise<Ext[]> {
  const names = await subDirs(dir);
  return Promise.all(names.map(async (n) => {
    const path = `${dir}/${n}/SKILL.md`;
    const md = await readText(path);
    if (md) return { name: prefix + n, desc: skillDesc(md), path, on: true };
    const off = await readText(path + SKILL_OFF);
    return { name: prefix + n, desc: skillDesc(off), path: off ? path + SKILL_OFF : path, on: !off };
  }));
}

// mcpServers 配置 → 一句话说明(走什么协议、连到哪)
const mcpLine = (cfg: any): string =>
  cfg?.url ? `${cfg.type || "http"} · ${cfg.url}`
    : cfg?.command ? `stdio · ${[cfg.command, ...(cfg.args ?? [])].join(" ")}`
    : "";

// cwd 可传多个:项目级 skill 装在 <cwd>/.claude/skills 下,只扫一个目录的话,
// 别的项目会话上报的 skill 在磁盘上找不到,就会显示成"没有按钮的一行"。
export async function loadExtensions(cwd: string | string[]): Promise<Exts> {
  const home = (await homeDir()).replace(/\/$/, "");
  const cwds = [...new Set(([] as string[]).concat(cwd).filter(Boolean))];

  // 插件:installed_plugins.json 记了安装目录,说明在 <installPath>/.claude-plugin/plugin.json。
  // 插件自带的技能也挂在那儿(显示成 plugin:skill,和 agent 上报的名字一致)。
  const plugins: Ext[] = [];
  const skills: Ext[] = [];
  const installed = parseJson(await readText(`${home}/.claude/plugins/installed_plugins.json`));
  const enabledPlugins = parseJson(await readText(`${home}/.claude/settings.json`)).enabledPlugins ?? {};
  for (const [key, entries] of Object.entries<any>(installed.plugins ?? {})) {
    const [name, marketplace = ""] = key.split("@");
    const on = enabledPlugins[key] !== false;
    const installPath: string | undefined = (entries as any[])?.[0]?.installPath;
    if (!installPath) { plugins.push({ name, desc: "", marketplace, on }); continue; }
    const manifest = parseJson(await readText(`${installPath}/.claude-plugin/plugin.json`));
    // 点击开内置编辑器看 README.md;有的插件没有 README,读得到才给路径,免得开出个空编辑器
    const readmePath = `${installPath}/README.md`;
    const hasReadme = !!(await readText(readmePath)).trim();
    plugins.push({ name, desc: manifest.description || "", path: hasReadme ? readmePath : undefined, marketplace, on });
    skills.push(...await skillsIn(`${installPath}/skills`, `${name}:`));
  }
  skills.push(...await skillsIn(`${home}/.claude/skills`));      // 用户级
  const skillProject: Record<string, string> = {};
  for (const c of cwds) {                                        // 项目级:记下来自哪个项目,列表里打标签
    const proj = c.replace(/\/+$/, "").split("/").pop() || c;
    for (const s of await skillsIn(`${c}/.claude/skills`)) { skillProject[s.name] = proj; skills.push(s); }
  }

  // MCP:用户级在 ~/.claude.json(全局 + 按项目),项目级在 <cwd>/.mcp.json。claude.ai 的连接器是云端下发的,本地没配置。
  // 每个 cwd 都要扫:只扫当前项目的话,别的项目会话上报的 MCP 在磁盘上找不到配置,
  // 就会被当成"云端连接器"——列表里没开关也没删除键,想删删不掉。
  // scope 名字跟 `claude mcp add/remove -s` 一致,启停时原路装回;跨项目的还得带上 cwd。
  const userCfg = parseJson(await readText(`${home}/.claude.json`));
  const bySource: [McpScope, Record<string, any>, string | undefined][] = [
    ["user", userCfg.mcpServers ?? {}, undefined],
  ];
  // 倒着扫,让当前项目(cwds[0])最后写入 —— 同名时以当前项目那份为准
  for (const c of [...cwds].reverse()) {
    bySource.push(["local", userCfg.projects?.[c]?.mcpServers ?? {}, c]);
    bySource.push(["project", parseJson(await readText(`${c}/.mcp.json`)).mcpServers ?? {}, c]);
  }

  const skillDescMap: Record<string, string> = {};
  const skillPathMap: Record<string, string> = {};
  const skillOnMap: Record<string, boolean> = {};
  for (const s of skills) {
    if (s.desc) skillDescMap[s.name] = s.desc;
    if (s.path) { skillPathMap[s.name] = s.path; skillOnMap[s.name] = s.on !== false; }
  }
  const mcpDescMap: Record<string, string> = {};
  const mcpUrlMap: Record<string, string> = {};
  const mcpMeta: Exts["mcpMeta"] = {};
  // 先铺停用存档,再让磁盘上真实存在的配置覆盖(存档若因删除失败而残留,以真实配置为准)
  for (const [name, it] of Object.entries(await readMcpStash())) mcpMeta[name] = { scope: it.scope, on: false, config: it.config, cwd: it.cwd };
  for (const [scope, servers, at] of bySource) {
    for (const [name, cfg] of Object.entries<any>(servers)) mcpMeta[name] = { scope, on: true, config: cfg, cwd: at };
  }
  for (const [name, m] of Object.entries(mcpMeta)) { mcpDescMap[name] = mcpLine(m.config); if (m.config?.url) mcpUrlMap[name] = m.config.url; }

  // 磁盘扫描到的全部名字(不只带说明的),供设置页在无会话时也能列出 Skills / MCP
  const skillNames = [...new Set(skills.map((s) => s.name))];
  return { plugins, skills: skillNames, mcp: Object.keys(mcpMeta), skillDesc: skillDescMap, skillPath: skillPathMap, skillOn: skillOnMap, skillProject, mcpDesc: mcpDescMap, mcpUrl: mcpUrlMap, mcpMeta };
}

// ---- 插件市场 ----
// 市场清单已经在磁盘上:known_marketplaces.json 列出已加的市场(github repo + 本地 clone 路径),
// 每个市场 clone 里 .claude-plugin/marketplace.json 的 plugins[] 就是可装列表。装/卸/加源壳调 claude CLI。
export interface MarketPlugin {
  name: string; marketplace: string; desc: string;
  author: string; category: string; homepage: string;
  installed: boolean; enabled: boolean; installPath?: string;
}

// 第三方市场种子:一键 `marketplace add`。名字随便,repo 是 github owner/name 或 URL。
export const SEED_MARKETPLACES: { name: string; repo: string; desc: string }[] = [
  { name: "claude-plugins-official", repo: "anthropics/claude-plugins-official", desc: "官方插件目录" },
  { name: "ponytail", repo: "DietrichGebert/ponytail", desc: "ponytail 懒人模式" },
  { name: "caveman", repo: "JuliusBrussee/caveman", desc: "caveman 压缩输出" },
  { name: "claude-hud", repo: "jarrodwatts/claude-hud", desc: "状态栏 HUD" },
];

const auth = (name: any): string =>
  typeof name === "string" ? name : name?.name || "";

export async function loadMarketplace(): Promise<MarketPlugin[]> {
  const home = (await homeDir()).replace(/\/$/, "");
  const installed = parseJson(await readText(`${home}/.claude/plugins/installed_plugins.json`));
  const installedMap = installed.plugins ?? {}; // "name@marketplace" → [{ installPath, ... }]
  const enabledMap = parseJson(await readText(`${home}/.claude/settings.json`)).enabledPlugins ?? {};
  const known = parseJson(await readText(`${home}/.claude/plugins/known_marketplaces.json`));

  const out: MarketPlugin[] = [];
  for (const [mkt, info] of Object.entries<any>(known)) {
    const loc = info?.installLocation;
    if (!loc) continue;
    const manifest = parseJson(await readText(`${loc}/.claude-plugin/marketplace.json`));
    for (const p of manifest.plugins ?? []) {
      if (!p?.name) continue;
      const key = `${p.name}@${mkt}`;
      const inst = installedMap[key]?.[0];
      out.push({
        name: p.name, marketplace: mkt, desc: p.description || "",
        author: auth(p.author), category: p.category || "", homepage: p.homepage || "",
        installed: !!inst, enabled: enabledMap[key] !== false, installPath: inst?.installPath,
      });
    }
  }
  return out;
}

export async function marketplaceNames(): Promise<string[]> {
  const home = (await homeDir()).replace(/\/$/, "");
  return Object.keys(parseJson(await readText(`${home}/.claude/plugins/known_marketplaces.json`)));
}

// cwd:`claude mcp add/remove -s local|project` 改的是"当前目录那个项目"的配置,
// 所以跨项目的 MCP 必须在它自己的目录里执行,否则删到别人头上(或者压根找不到)。
async function runClaude(args: string[], cwd?: string): Promise<void> {
  const [code, out, err] = await invoke<[number, string, string]>("run_claude", { args, cwd });
  if (code !== 0) throw new Error((err || out || i18n.t("退出码 {{code}}", { code })).trim());
}

export const installPlugin = (name: string, marketplace: string) =>
  runClaude(["plugin", "install", `${name}@${marketplace}`]);
export const uninstallPlugin = (name: string, marketplace: string) =>
  runClaude(["plugin", "uninstall", "-y", `${name}@${marketplace}`]);
export const enablePlugin = (name: string, marketplace: string) =>
  runClaude(["plugin", "enable", `${name}@${marketplace}`]);
export const disablePlugin = (name: string, marketplace: string) =>
  runClaude(["plugin", "disable", `${name}@${marketplace}`]);
export const addMarketplace = (repo: string) =>
  runClaude(["plugin", "marketplace", "add", repo]);
export const removeMarketplace = (name: string) =>
  runClaude(["plugin", "marketplace", "remove", name]);

// 从 github 仓库装 skill 到 ~/.claude/skills/。只认 github 地址;非 skill 仓库后端会报错。返回装好的名字。
export const installSkillGit = (url: string) =>
  invoke<string[]>("install_skill_git", { url });

// ---- 已装扩展的启停 / 删除 ----

// skill:停用 = SKILL.md ↔ SKILL.md.off 改名;删除 = 整个 skill 目录删掉。
// path 传列表里那份(可能已经是 .off)。
export const setSkillOn = (path: string, on: boolean) => {
  const md = path.replace(/\.off$/, "");
  return invoke<void>("rename_path", on ? { from: md + SKILL_OFF, to: md } : { from: md, to: md + SKILL_OFF });
};
export const removeSkill = (path: string) =>
  invoke<void>("remove_path", { path: path.replace(/\/SKILL\.md(\.off)?$/, "") });

// MCP:claude 没有"停用"命令,只有 add/remove。
// 停用 = 配置原样存进 ~/.chat-code/disabled-mcp.json 再 `mcp remove`;启用 = 按原 scope `mcp add-json` 装回。
type McpStash = Record<string, { scope: McpScope; config: any; cwd?: string }>;
const stashPath = async () => `${(await homeDir()).replace(/\/$/, "")}/.chat-code/disabled-mcp.json`;
const readMcpStash = async (): Promise<McpStash> => parseJson(await readText(await stashPath()));
const writeMcpStash = async (s: McpStash) =>
  invoke<void>("write_file", { path: await stashPath(), content: JSON.stringify(s, null, 2) });

export async function setMcpOn(name: string, scope: McpScope, config: any, on: boolean, cwd?: string) {
  const stash = await readMcpStash();
  if (on) {
    const it = stash[name] || { scope, config, cwd };
    await runClaude(["mcp", "add-json", "-s", it.scope, name, JSON.stringify(it.config)], it.cwd ?? cwd);
    delete stash[name];
  } else {
    stash[name] = { scope, config, cwd }; // 先存档再删,删失败也不丢配置
    await writeMcpStash(stash);
    await runClaude(["mcp", "remove", "-s", scope, name], cwd);
    return;
  }
  await writeMcpStash(stash);
}

export async function removeMcp(name: string, scope: McpScope, on: boolean, cwd?: string) {
  if (on) await runClaude(["mcp", "remove", "-s", scope, name], cwd);
  const stash = await readMcpStash();
  if (stash[name]) { delete stash[name]; await writeMcpStash(stash); }
}
