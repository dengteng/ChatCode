#!/usr/bin/env node
// 弹窗按钮一律走 btnPress(见 src/lib/utils.ts),不能挂裸 onClick。
// 背景:WKWebView 里输入框聚焦时 / 窗口未聚焦时,落在别处的第一次 click 根本不派发(只用来移焦点)。
// 弹窗里还多一层:内层普遍挂着 onMouseDown={e => e.stopPropagation()} 挡住"点遮罩关闭",
// click 一丢就两头都不响应 —— 表现是"点第一次完全没反应,再点一次才行"。这坑仓库踩过四回。
//
// 管的范围:全仓所有 <button>/<Button>。弹窗按钮排另外定点盯防(点错代价最大、按钮挨得最近)。
//
// 跑法:node scripts/dialog-press.check.mjs
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert";

const read = (p) => readFileSync(p, "utf8");

// ---------- 1. btnPress 本体 ----------
const UTILS = read("src/lib/utils.ts");
const impl = /export const btnPress = \(fn[\s\S]*?\n\}\);/.exec(UTILS);
assert.ok(impl, "btnPress 不见了(挪走了就把这条指到新位置)");
assert.ok(/onMouseDown:[\s\S]*?e\.preventDefault\(\); e\.stopPropagation\(\); fn\(\);/.test(impl[0]),
  "btnPress 必须在 mousedown 就跑 fn —— 这才是绕开被吞的 click 的那一下");
assert.ok(/onKeyDown:[\s\S]*?e\.key === "Enter" \|\| e\.key === " "/.test(impl[0]),
  "键盘要自己接:<button> 原生只把 Enter/Space 变成 click,而 click 这条路只做 stopPropagation");
assert.ok(/onKeyDown:[\s\S]*?e\.preventDefault\(\); e\.stopPropagation\(\); fn\(\);/.test(impl[0]),
  "onKeyDown 里也要 stopPropagation:权限卡 / AskUser 卡 / ResumeCard 的容器自己接 Enter,不拦就按钮和容器各跑一次");
assert.ok(!/onClick:[^\n]*fn\(\)/.test(impl[0]),
  "onClick 里不许再调 fn —— 鼠标那一下会 mousedown+click 各跑一次(不卸载的按钮就实打实执行两遍)");

// ---------- 2. 所有"弹窗按钮排"里不许有裸 onClick ----------
// 认这几个 class:改布局时新排也套同名 class,自检自动跟着覆盖到。
const ROW_CLASS = /className="(commit-modal-actions|workspace-actions|kill-dialog-ops|settings-form-actions)"/;
const FILES = ["src/components/Sidebar.tsx", "src/components/Settings.tsx", "src/components/BranchesTab.tsx",
  "src/components/Chat.tsx", "src/components/ConfirmDialog.tsx", "src/components/UpdateDialog.tsx"];
let rows = 0, buttons = 0;
for (const f of FILES) {
  const lines = read(f).split("\n");
  lines.forEach((line, i) => {
    if (!ROW_CLASS.test(line)) return;
    rows++;
    // 按钮排都很短:从这行往下取到收尾的 </div>(同一行就收尾的也吃得下)
    const chunk = [];
    for (let j = i; j < lines.length && j < i + 12; j++) {
      chunk.push(lines[j]);
      if (/<\/div>/.test(lines[j])) break;
    }
    const text = chunk.join("\n");
    buttons += (text.match(/<button/g) || []).length;
    assert.ok(!/onClick=/.test(text),
      `${f}:${i + 1} 弹窗按钮排里还有裸 onClick,一律 {...btnPress(...)}:\n${text}`);
    assert.ok(/\{\.\.\.btnPress\(/.test(text), `${f}:${i + 1} 这排按钮一个都没走 btnPress`);
  });
}
assert.ok(rows >= 8, `只扫到 ${rows} 排弹窗按钮,少于预期(挪走/改名了就更新 ROW_CLASS)`);

// ---------- 3. 两个纯弹窗组件:整个文件就是弹窗,全文不许有裸 onClick ----------
for (const f of ["src/components/ConfirmDialog.tsx", "src/components/UpdateDialog.tsx"]) {
  assert.ok(!/onClick=/.test(read(f)), `${f} 整个文件就是一个弹窗,不该出现 onClick`);
}

// ---------- 3b. 全仓 <button>/<Button>:一个裸 onClick 都不许有 ----------
// 放行两类:纯拦截的 onClick={(e) => e.stopPropagation()};以及下面 ALLOW 里逐条记了原因的例外。
// 目前一条都不需要 —— 真要留 onClick 就往这儿加 [文件, 该按钮标签里的一段特征字符串] 并写清为什么。
// 已知一处"故意不迁"(不是 <button>,扫不到,记在这里免得下次重新判一遍):
//   · Chat.tsx 的 path-token(span):选区要到 mouseup 才定得下来,mousedown 时判不出用户是在划选还是在点。
const ALLOW = [];
// 只看 <button> 自己的属性段,不能按整行扫:一行里常常既有按钮又有别的可点 span/div
// (比如 InfoPanel 的端口行),按行扫会把 span 的 onClick 记到按钮头上。
// 从 <button 起按花括号深度找配对的 '>' —— 属性值里的 {...} 内部不算结束。
function* tags(src) {
  for (const m of src.matchAll(/<(button|Button)\b/g)) {
    let depth = 0;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) { yield [m.index, src.slice(m.index, i + 1)]; break; }
    }
  }
}
let scanned = 0, migrated = 0;
const tsx = readdirSync("src/components").filter((f) => f.endsWith(".tsx")).map((f) => `src/components/${f}`);
for (const f of tsx) {
  const body = read(f);
  migrated += (body.match(/\{\.\.\.btnPress\(/g) || []).length;
  for (const [at, tag] of tags(body)) {
    if (!/onClick=/.test(tag)) continue;
    scanned++;
    if (/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(tag)) continue;
    if (ALLOW.some(([af, needle]) => af === f && tag.includes(needle))) continue;
    const ln = body.slice(0, at).split("\n").length;
    assert.fail(`${f}:${ln} 按钮还挂着裸 onClick,改走 btnPress(要留就往 ALLOW 里加一条并写明原因):\n  ${tag.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}
assert.ok(migrated >= 90, `全仓只有 ${migrated} 处 btnPress,比预期少 —— 是不是被批量回退了?`);

// ---------- 3c. 右键菜单项 ----------
// 菜单是"按下即执行"的原生语义,而且这里 click 被吞的概率最高(菜单多半是在输入框聚焦时右键唤出的)。
const SIDEBAR_SRC = read("src/components/Sidebar.tsx");
assert.ok(/const menuItem = \(fn[\s\S]{0,200}?role: "menuitem", tabIndex: 0, \.\.\.btnPress\(fn\)/.test(SIDEBAR_SRC),
  "侧栏菜单项要走 menuItem(btnPress + role/tabIndex —— 它们是 div,不给 tabIndex 就聚不了焦,键盘分支收不到事件)");
for (const [f, cls] of [["src/components/Sidebar.tsx", "ctx-item"], ["src/components/BranchesTab.tsx", "bmenu-item"]]) {
  const body = read(f);
  for (const m of body.matchAll(new RegExp(`className="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, "g"))) {
    assert.ok(!/onClick=/.test(m[0]),
      `${f} 的 .${cls} 还挂着裸 onClick,菜单要按下即执行:\n  ${m[0].replace(/\s+/g, " ").slice(0, 160)}`);
  }
}
// 菜单外壳:点外面要在 mousedown 那一拍就关,否则下层(会话行也是 mousedown 激活)先响应,菜单慢一步才消失。
assert.ok(/window\.addEventListener\("mousedown", close\)/.test(SIDEBAR_SRC), "右键菜单要在 mousedown 关闭,不能等 click");
assert.ok(/className="ctx-menu" role="menu"[^>]*onMouseDown=\{\(ev\) => ev\.stopPropagation\(\)\}/.test(SIDEBAR_SRC),
  "菜单容器要拦 mousedown —— 上面那条改成 mousedown 关闭后,不拦的话点菜单空白处会把菜单关掉");

// ---------- 4. 弹窗外壳上的关闭/切页按钮 ----------
const SETTINGS = read("src/components/Settings.tsx");
assert.ok(/\{\.\.\.btnPress\(onClose\)\} aria-label=\{t\("关闭设置"\)\}/.test(SETTINGS), "设置面板的关闭 × 要走 btnPress");
assert.ok(/className=\{tab === k \? "sel" : ""\} \{\.\.\.btnPress\(\(\) => setTab\(k\)\)\}/.test(SETTINGS),
  "设置左侧 tab 要走 btnPress(原来只有 onMouseDown,纯键盘切不了页)");
const BRANCHES = read("src/components/BranchesTab.tsx");
assert.ok(/title=\{t\("关闭"\)\} \{\.\.\.btnPress\(\(\) => setWtFile\(null\)\)\}/.test(BRANCHES), "worktree diff 弹窗的关闭 × 要走 btnPress");

// ---------- 5. 两个 required 表单:保存要过校验,又不能吃掉第一次点击 ----------
// 直接调 onSave 会绕开 required 的"请填写此字段";只留 type="submit" 则靠 click 触发,照样被吞。
// requestSubmit() 两头都要。
for (const [f, needle] of [
  ["src/components/Chat.tsx", /className="ssh-save" type="submit" \{\.\.\.btnPress\(\(\) => formRef\.current\?\.requestSubmit\(\)\)\}/],
  ["src/components/Settings.tsx", /className="primary" type="submit" \{\.\.\.btnPress\(\(\) => formRef\.current\?\.requestSubmit\(\)\)\}/],
]) assert.ok(needle.test(read(f)), `${f} 的表单保存按钮要 btnPress + requestSubmit()`);

// ---------- 6. btnPress 存在的前提还在 ----------
const SIDEBAR = read("src/components/Sidebar.tsx");
assert.ok(/className="workspace-shade" onMouseDown=/.test(SIDEBAR), "遮罩仍应是 mousedown 关闭(btnPress 的前提)");
assert.ok(/className="workspace-dialog kill-dialog" onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(SIDEBAR),
  "弹窗内层仍应拦住 mousedown,否则点按钮会连带把弹窗关掉");

console.log(`✅ dialog-press: btnPress 语义(含键盘+拦冒泡) / 全仓 ${migrated} 处 btnPress、${scanned} 颗按钮仍带 onClick(均已豁免) / ${rows} 排弹窗按钮共 ${buttons} 颗 / 右键菜单项 / 两处表单校验 / 前提不变 全部通过`);
