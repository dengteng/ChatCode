// 开发时 sidecar 由 `npm run dev` 起在 8975,Rust 只管开窗口。
// 打包后没有 npm,Rust 负责把 sidecar 拉起来 —— 这里的麻烦事都源于一点:
// 从 Finder 启动的 GUI 应用不继承登录 shell 的 PATH(只有 /usr/bin:/bin:/usr/sbin:/sbin),
// 所以 node 和 claude 都得自己找出绝对路径。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

const SIDECAR_PORT: &str = "8976"; // 与开发用的 8975 错开,两者可并存

struct Sidecar(Mutex<Option<Child>>);

/// sidecar 的 ws 握手令牌。
///
/// 为什么需要:sidecar 监听的是固定的 loopback 端口,而 WebSocket **不受同源策略约束** ——
/// 用户浏览器里打开的任意网页都能 `new WebSocket("ws://127.0.0.1:8976")` 连上,然后发
/// terminal_command(落到 `bash -lc`)或 set_provider_config(改 baseUrl 把 key 和全部 prompt
/// 引到自己的服务器)。绑 127.0.0.1 只挡住局域网,挡不住本机浏览器。
///
/// 令牌每次启动新生成,只经 `#[tauri::command]` 交给自家 webview —— 网页拿不到 Tauri IPC。
/// 熵取自 /dev/urandom(macOS-only 应用,免掉一个 rand 依赖)。
static SIDECAR_TOKEN: OnceLock<String> = OnceLock::new();
fn sidecar_token_value() -> &'static str {
    SIDECAR_TOKEN.get_or_init(|| {
        use std::io::Read;
        let mut b = [0u8; 32];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut b))
            .expect("读 /dev/urandom 失败,无法生成 sidecar 令牌");
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

/// 前端连 ws 前取令牌。只有 app 自己的 webview 能调 Tauri command。
#[tauri::command]
fn sidecar_token() -> String {
    sidecar_token_value().to_string()
}

/// 登录 shell 里的 PATH。GUI 进程自己的 PATH 里没有 homebrew / ~/.local/bin。
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell).arg("-lc").arg("printf %s \"$PATH\"").output().ok()?;
    let p = String::from_utf8(out.stdout).ok()?;
    if p.trim().is_empty() { None } else { Some(p) }
}

fn is_exec(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }
    #[cfg(not(unix))]
    return p.is_file();
}

/// 先在登录 shell 的 PATH 里找,再退回常见安装位置。
fn which(bin: &str, fallbacks: &[&str], path: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = path {
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let c = Path::new(dir).join(bin);
            if is_exec(&c) {
                return Some(c);
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    for f in fallbacks {
        let c = PathBuf::from(f.replace('~', &home));
        if is_exec(&c) {
            return Some(c);
        }
    }
    None
}

fn log_path() -> PathBuf {
    let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".chat-code");
    let _ = fs::create_dir_all(&dir);
    dir.join("sidecar.log")
}

/// 读 ~/.chat-code/relay.env（每行 KEY=VALUE）里的 relay 配置,注入 sidecar 以启用手机远程会话。
/// 密钥只放这个文件里,不进源码/仓库;文件不存在 = 不启用远程,sidecar 照常本地运行。
/// 只认这两个键,其余忽略,防止把无关变量带进子进程。
fn relay_env() -> Vec<(String, String)> {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = PathBuf::from(&home).join(".chat-code").join("relay.env");
    let Ok(content) = fs::read_to_string(&path) else { return Vec::new(); };
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((k, v)) = line.split_once('=') {
            let (k, v) = (k.trim(), v.trim());
            if matches!(k, "CHAT_CODE_RELAY_URL" | "CHAT_CODE_HOST_TOKEN") && !v.is_empty() {
                out.push((k.to_string(), v.to_string()));
            }
        }
    }
    out
}

/// 起 sidecar。失败原因写进 ~/.chat-code/sidecar.log —— GUI 应用的 stderr 无处可看。
fn spawn_sidecar(script: &Path) -> Result<Child, String> {
    let path = login_path();
    let p = path.as_deref();
    let node = which("node", &["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"], p)
        .ok_or("找不到 node。请安装 Node.js,或确认它在登录 shell 的 PATH 里。")?;
    // SDK 默认从 node_modules 解析原生 CLI,打包后没有 node_modules,必须显式指定
    let claude = which(
        "claude",
        &["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
        p,
    )
    .ok_or("找不到 claude 可执行文件。请先安装 Claude Code。")?;

    let log = File::create(log_path()).map_err(|e| e.to_string())?;
    let errlog = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&node);
    cmd.arg(script)
        .env("CHAT_CODE_PORT", SIDECAR_PORT)
        .env("CHAT_CODE_TOKEN", sidecar_token_value())
        .env("CHAT_CODE_CLAUDE_BIN", &claude)
        // claude 靠 USER 定位钥匙串里的凭据,缺了它会一直报 "Not logged in"
        .env("USER", std::env::var("USER").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default());
    // 有 relay 配置就注入,让 sidecar 拨入 relay、手机可远程接入本机会话
    for (k, v) in relay_env() {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::from(log))
        .stderr(Stdio::from(errlog))
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败: {e}"))
}

/// 在系统默认浏览器打开外链。前端拦截 <a> 点击后调用,避免链接把 webview 导航走、整个 app 界面被网页替换。
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    run_open(vec![url]).await
}

/// 把对话里出现的路径解析成绝对路径:展开开头的 ~,相对路径拼到会话 cwd 上。
/// Command::new 不走 shell,~ 不会自动展开,必须自己处理。
fn resolve_path(path: &str, cwd: Option<&str>) -> String {
    let expanded = if path == "~" {
        std::env::var("HOME").unwrap_or_default()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        path.to_string()
    };
    if expanded.starts_with('/') {
        return expanded;
    }
    let Some(c) = cwd else { return expanded };
    let base = std::path::Path::new(c.trim_end_matches('/'));
    let direct = base.join(&expanded);
    // agent 常在多仓工作区里 cd 到兄弟仓再干活,回话里写的相对路径是相对那边的根
    // (cwd=…/workspace/repo-a,却写 repo-b/docs/x.md,实际在 …/workspace/repo-b/docs/x.md)。
    // 直接拼不存在时往上找几级,谁存在用谁。只对多段路径这么找 —— 光一个文件名太容易撞上同名文件。
    if !direct.exists() && expanded.contains('/') {
        for anc in base.ancestors().skip(1).take(3) {
            let p = anc.join(&expanded);
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
            // agent 回话也常省略仓名(在 openmeter 干活,却写 docs/x.md 而不是 openmeter/docs/x.md),
            // 光拼祖先找不到 → 再试 anc 下的每个兄弟仓目录。多段路径足够具体,撞名风险低。
            if let Ok(rd) = std::fs::read_dir(anc) {
                for entry in rd.flatten() {
                    let p = entry.path().join(&expanded);
                    if p.exists() {
                        return p.to_string_lossy().into_owned();
                    }
                }
            }
        }
    }
    // 裸文件名(无斜杠)且 cwd 根下没有:agent 常省略目录前缀(文件实际在子目录里,如 server/x.py),
    // 不找的话"打开/打开目录"只能落在 cwd 根,文不对题。往下 BFS 找同名文件,取最浅的一个。
    // 只在 cwd 根直下没有时找(根下有就用根下的,同名以近为准);噪音目录跳过,总量封顶防巨树卡死。
    if !direct.exists() && !expanded.contains('/') {
        if let Some(found) = find_file_down(base, &expanded) {
            return found;
        }
        // BFS 没找到:再往祖先和兄弟目录找 —— agent 可能在工作区外的目录生成了文件
        // (如 cwd 在 .chat-code/casual/…,文件实际在 ~/pixel2motion/下)。
        for anc in base.ancestors().skip(1).take(3) {
            let p = anc.join(&expanded);
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
            if let Ok(rd) = std::fs::read_dir(anc) {
                for entry in rd.flatten() {
                    let p = entry.path().join(&expanded);
                    if p.exists() {
                        return p.to_string_lossy().into_owned();
                    }
                }
            }
        }
    }
    direct.to_string_lossy().into_owned()
}

/// 在 root 下按 BFS 找第一个(=最浅)名为 target 的条目。规则同 walk_project:跳隐藏/噪音目录,限量防卡。
fn find_file_down(root: &std::path::Path, target: &str) -> Option<String> {
    const SKIP: [&str; 17] = ["node_modules", "target", "dist", "build", "out", "coverage", "__pycache__", "venv", ".venv", "vendor", "Pods", ".next", ".git", ".svn", ".hg", ".DS_Store", ".fleet"];
    let mut visited = 0usize;
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> = std::collections::VecDeque::from([(root.to_path_buf(), 0)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > 10 || visited >= 20000 { break; }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            visited += 1;
            if visited >= 20000 { break; }
            let name = e.file_name().to_string_lossy().into_owned();
            if SKIP.contains(&name.as_str()) { continue; }
            if name == target { return Some(e.path().to_string_lossy().into_owned()); }
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { queue.push_back((e.path(), depth + 1)); }
        }
    }
    None
}

/// 前端要的同一套解析(内置编辑器打开文件时用),别在 TS 里再实现一遍。
#[tauri::command]
fn resolve_path_cmd(path: String, cwd: Option<String>) -> String {
    resolve_path(&path, cwd.as_deref())
}

/// 跑 `open …` 并等它退出,把失败原因带回去。
/// 原来是 spawn() + `let _ =` 直接丢掉结果:LaunchServices 拒绝、路径不对、open 起不来,
/// 前端一律表现成"点了没反应",连排查的线索都没有。open 只是把请求转交 LaunchServices,
/// 毫秒级返回,所以等它是安全的 —— 但仍放 async + spawn_blocking,不占主线程(同 choose_directory)。
async fn run_open(args: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("open").args(&args).output().map_err(|e| format!("open 起不来:{e}"))?;
        if out.status.success() { return Ok(()); }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("open 失败(exit {:?})", out.status.code()) } else { err })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用默认程序打开文件/目录(.app 会被启动)。
#[tauri::command]
async fn open_path(path: String, cwd: Option<String>) -> Result<(), String> {
    run_open(vec![resolve_path(&path, cwd.as_deref())]).await
}

/// 在 Finder 里定位并选中该文件(打开其所在目录)。
/// 目标不存在时(被移动/删除),回退打开最近的存在祖先目录,避免点了没反应。
#[tauri::command]
async fn reveal_path(path: String, cwd: Option<String>) -> Result<(), String> {
    let resolved = resolve_path(&path, cwd.as_deref());
    let p = std::path::Path::new(&resolved);
    if p.exists() {
        return run_open(vec!["-R".into(), resolved]).await;
    }
    match p.ancestors().find(|a| a.exists()) {
        Some(dir) => run_open(vec![dir.to_string_lossy().into_owned()]).await,
        None => Err(format!("路径不存在:{resolved}")),
    }
}

/// 结束进程。数字 PID → kill;非数字(docker 容器 id)→ docker stop。默认 TERM,给进程收尾机会。
#[tauri::command]
fn kill_pid(pid: String) -> Result<(), String> {
    let ok = if pid.chars().all(|c| c.is_ascii_digit()) {
        Command::new("kill").arg(&pid).status()
    } else {
        Command::new("docker").arg("stop").arg(&pid).status()
    };
    ok.map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err(format!("结束失败(exit {:?})", s.code())) })
}

/// 按端口结束占用它的进程:lsof 查 PID 再 kill。走 sh -c 用管道,一条搞定。
#[tauri::command]
fn kill_port(port: String) -> Result<(), String> {
    if !port.chars().all(|c| c.is_ascii_digit()) { return Err("非法端口".into()); }
    Command::new("sh").arg("-c").arg(format!("lsof -ti tcp:{port} | xargs kill"))
        .status().map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err("端口无占用或结束失败".into()) })
}

/// 在项目目录后台启动一条命令(如 npm run dev)。detach:脱离父进程,关 app 也不连带被杀。
#[tauri::command]
fn spawn_proc(cmd: String, cwd: String) -> Result<(), String> {
    Command::new("sh").arg("-lc").arg(&cmd).current_dir(&cwd)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 跑 `claude plugin ...` 之类的 CLI 命令,捕获退出码 + stdout/stderr 回前端。
/// GUI 进程 PATH 不全,得先拿登录 shell 的 PATH 再找 claude 绝对路径。
/// cwd:`claude mcp -s local|project` 认"当前目录属于哪个项目",跨项目操作必须切过去。
#[tauri::command]
fn run_claude(args: Vec<String>, cwd: Option<String>) -> Result<(i32, String, String), String> {
    let path = login_path();
    let bin = which(
        "claude",
        &["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
        path.as_deref(),
    )
    .ok_or("找不到 claude 可执行文件")?;
    let mut cmd = Command::new(&bin);
    cmd.args(&args);
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(d);
    }
    if let Some(p) = &path {
        cmd.env("PATH", p);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// 原生标题栏跟随 app 内主题。窗口级 setTheme 在 macOS 上不改 NSApp 外观(标题栏仍跟系统),必须 app 级设置。
#[tauri::command]
fn set_app_theme(app: tauri::AppHandle, theme: String) {
    let t = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    let _ = app.set_theme(t);
}

/// 列目录:返回 (名称, 是否目录)，目录在前、按名称排序。仅一层，前端按需展开。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<(String, bool)>, String> {
    let mut v: Vec<(String, bool)> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (e.file_name().to_string_lossy().to_string(), is_dir)
        })
        .collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    Ok(v)
}

/// 输入框 @ 提及用:一次性递归列出项目里的相对路径(文件 + 目录),前端自己做过滤。
/// 每敲一个字符都回 Rust 走一遍磁盘太浪费,索性走一次全量、前端缓存着过滤。
/// 跳过 .git / node_modules / target 这类噪音目录和隐藏目录,并设总量与深度上限,防止在巨型目录里卡死。
#[tauri::command]
fn walk_project(root: String) -> Result<Vec<(String, bool)>, String> {
    const SKIP: [&str; 12] = ["node_modules", "target", "dist", "build", "out", "coverage", "__pycache__", "venv", ".venv", "vendor", "Pods", ".next"];
    const MAX: usize = 20000;
    let base = PathBuf::from(&root);
    if !base.is_dir() { return Err("不是目录".into()); }
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(base, String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        if out.len() >= MAX || depth > 12 { continue; }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP.contains(&name.as_str()) { continue; }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if out.len() >= MAX { break; }
            out.push((child_rel.clone(), is_dir));
            if is_dir { stack.push((e.path(), child_rel, depth + 1)); }
        }
    }
    Ok(out)
}

/// 读文本文件内容(app 内编辑用)。
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 写文本文件内容(app 内保存用)。
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?; // 目录不存在(如同步落地记忆)先建
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// 列目录并带元信息:[(名字, 是否目录, 最后修改 ms)]。记忆中心用它显示"最后更新"。
/// 目录不存在返回空表(记忆目录可能还没建),不当错误。
#[tauri::command]
fn read_dir_meta(path: String) -> Result<Vec<(String, bool, u64)>, String> {
    use std::time::UNIX_EPOCH;
    let Ok(entries) = fs::read_dir(&path) else { return Ok(vec![]) };
    let mut out = Vec::new();
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        let meta = match e.metadata() { Ok(m) => m, Err(_) => continue };
        let mtime = meta.modified().ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64).unwrap_or(0);
        out.push((name, meta.is_dir(), mtime));
    }
    Ok(out)
}

/// 反查一批端口谁在监听:给定端口号,返回 [(端口, 持有进程 PID, 进程名)] —— 只回当前处于 LISTEN 的。
/// 用于把"脱离工作目录"的进程(如 ssh -L 隧道)按端口找回来:它不在项目目录树里,cwd 过滤抓不到,只能按端口反查。
#[tauri::command]
fn probe_ports(ports: Vec<u16>) -> Vec<(u16, String, String)> {
    use std::collections::HashSet;
    if ports.is_empty() { return vec![]; }
    let want: HashSet<u16> = ports.into_iter().collect();
    let Ok(out) = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN"]).output() else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut res = Vec::new();
    let mut seen: HashSet<u16> = HashSet::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 2 { continue; }
        let name = cols[0];
        let pid = cols[1];
        // 倒数第二列是 NAME(地址),形如 127.0.0.1:48888 / *:3000 / [::1]:5173
        let addr = cols[cols.len() - 2];
        if let Some(p) = addr.rsplit(':').next().and_then(|s| s.parse::<u16>().ok()) {
            if want.contains(&p) && seen.insert(p) {
                res.push((p, pid.to_string(), name.to_string()));
            }
        }
    }
    res
}

/// 启动前依赖检测。sidecar 靠 node 起、SDK 靠 claude 二进制干活,缺任一 app 全瘫。
/// 返回 [(依赖名, 是否找到, 找到的绝对路径或"")],前端据此门控引导安装。
#[tauri::command]
fn check_deps() -> Vec<(String, bool, String)> {
    let path = login_path();
    let p = path.as_deref();
    let node = which("node", &["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"], p);
    let claude = which("claude", &["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"], p);
    vec![
        ("node".into(), node.is_some(), node.map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()),
        ("claude".into(), claude.is_some(), claude.map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()),
    ]
}

/// 会话需要用户处理时,让 dock 图标持续跳动直到 app 被激活。app 已在前台时无操作。
#[tauri::command]
fn bounce_dock(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

/// 使用系统原生文件夹选择器(NSOpenPanel)。前端仍保留手动输入,便于浏览器开发模式和远程路径。
/// 原来走 osascript `choose folder`:启动 System Events 慢(几秒才出),且弹窗归 osascript 进程、
/// 不归 app —— 焦点错乱(菊花、要再点一下)。换 tauri-plugin-dialog 的原生面板:秒开、归属 app、焦点正常。
// async + spawn_blocking:同步命令跑在主线程,而 blocking_pick_folder 会把面板派发到主线程再阻塞调用线程
// 等结果 —— 调用线程正是主线程时直接自死锁,整个 app 卡死。放到 blocking 线程池里跑就不占主线程。
#[tauri::command]
async fn choose_directory(app: tauri::AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().set_title("选择项目目录").blocking_pick_folder()?;
        let path = picked.into_path().ok()?;
        let s = path.to_string_lossy().trim_end_matches('/').to_string();
        (!s.is_empty()).then_some(s)
    })
    .await
    .ok()
    .flatten()
}

/// 递归复制目录(跳过 .git,免得把巨大的仓库历史也搬进去)。
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let name = e.file_name();
        if name == ".git" { continue; }
        let (from, to) = (e.path(), dst.join(&name));
        if e.file_type()?.is_dir() { copy_dir(&from, &to)?; }
        else { fs::copy(&from, &to)?; }
    }
    Ok(())
}

/// 扩展管理只该碰 .claude 里的东西 —— 路径不含 `/.claude` 就拒,免得一个笔误把别处抹了。
fn guard_claude(path: &str) -> Result<(), String> {
    if path.contains("/.claude") { Ok(()) } else { Err("只允许操作 .claude 目录下的内容".into()) }
}

/// 删文件或整个目录(卸载 skill 用)。
#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    guard_claude(&path)?;
    let p = PathBuf::from(&path);
    if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) }.map_err(|e| e.to_string())
}

/// 改名(停用 skill = SKILL.md ↔ SKILL.md.off,claude 扫不到就不加载)。
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    guard_claude(&from)?;
    guard_claude(&to)?;
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 从 github 仓库安装 skill 到 ~/.claude/skills/。
/// 只认 github 地址;clone 后扫 SKILL.md:根目录有 = 单个 skill(用仓库名);
/// 否则找 skills/*/SKILL.md = 多个 skill。都没有则不是 skill,报错。
/// 返回装好的 skill 名字列表。
#[tauri::command]
fn install_skill_git(url: String) -> Result<Vec<String>, String> {
    let url = url.trim();
    // 归一化并校验必须是 github,取出 owner/repo
    let stripped = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("github.com/"))
        .ok_or("只支持 github 地址")?;
    let parts: Vec<&str> = stripped.trim_end_matches('/').trim_end_matches(".git").split('/').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("github 地址不完整,应形如 github.com/owner/repo".into());
    }
    let repo = parts[1].to_string();
    let clone_url = format!("https://github.com/{}/{}.git", parts[0], repo);

    let home = std::env::var("HOME").unwrap_or_default();
    let skills_root = PathBuf::from(&home).join(".claude").join("skills");
    fs::create_dir_all(&skills_root).map_err(|e| e.to_string())?;
    let tmp = skills_root.join(format!(".tmp-clone-{}", repo));
    let _ = fs::remove_dir_all(&tmp); // 清残留

    let path = login_path();
    let git = which("git", &["/opt/homebrew/bin/git", "/usr/bin/git", "/usr/local/bin/git"], path.as_deref())
        .ok_or("找不到 git")?;
    let mut cmd = Command::new(&git);
    cmd.args(["clone", "--depth", "1", &clone_url]).arg(&tmp);
    if let Some(p) = &path { cmd.env("PATH", p); }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("clone 失败: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }

    // 收集 (skill 名, 源目录):根目录 SKILL.md → 单个;否则 skills/*/SKILL.md → 多个
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    if tmp.join("SKILL.md").is_file() {
        found.push((repo.clone(), tmp.clone()));
    } else {
        for sub_root in [tmp.join("skills"), tmp.clone()] {
            if let Ok(entries) = fs::read_dir(&sub_root) {
                for e in entries.filter_map(|e| e.ok()) {
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) && e.path().join("SKILL.md").is_file() {
                        found.push((e.file_name().to_string_lossy().to_string(), e.path()));
                    }
                }
            }
            if !found.is_empty() { break; }
        }
    }

    if found.is_empty() {
        let _ = fs::remove_dir_all(&tmp);
        return Err("该仓库不是一个 skill(没找到 SKILL.md)".into());
    }

    let mut names = Vec::new();
    for (name, src) in &found {
        let dst = skills_root.join(name);
        let _ = fs::remove_dir_all(&dst); // 覆盖旧的
        copy_dir(src, &dst).map_err(|e| e.to_string())?;
        names.push(name.clone());
    }
    let _ = fs::remove_dir_all(&tmp);
    Ok(names)
}

/// 关掉 macOS 系统级"智能连字符/引号"替换。否则 WKWebView 里输入或粘贴命令
/// (如 boss login --qrcode)会被改坏:"--" 变 "—"、直引号变弯引号。
/// 必须在建 webview 之前设,写进 app 自己的 NSUserDefaults 即可作用于本进程的 WebKit。
#[cfg(target_os = "macos")]
fn disable_smart_substitution() {
    use objc2_foundation::{NSString, NSUserDefaults};
    let d = NSUserDefaults::standardUserDefaults();
    d.setBool_forKey(false, &NSString::from_str("NSAutomaticDashSubstitutionEnabled"));
    d.setBool_forKey(false, &NSString::from_str("NSAutomaticQuoteSubstitutionEnabled"));
    d.setBool_forKey(false, &NSString::from_str("NSAutomaticTextReplacementEnabled"));
}

fn main() {
    #[cfg(target_os = "macos")]
    disable_smart_substitution();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![open_url, open_path, reveal_path, resolve_path_cmd, kill_pid, kill_port, spawn_proc, run_claude, choose_directory, set_app_theme, list_dir, walk_project, read_file, write_file, read_dir_meta, probe_ports, bounce_dock, check_deps, install_skill_git, remove_path, rename_path, sidecar_token])
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // 开发时 npm run dev 已经起了一个 sidecar,别再起第二个
            if cfg!(debug_assertions) {
                return Ok(());
            }
            use tauri::Manager;
            let script = app
                .path()
                .resolve("resources/sidecar.mjs", tauri::path::BaseDirectory::Resource)?;
            match spawn_sidecar(&script) {
                Ok(child) => {
                    let state: tauri::State<Sidecar> = app.state();
                    *state.0.lock().unwrap() = Some(child);
                }
                Err(e) => {
                    let _ = fs::write(log_path(), format!("[chat-code] {e}\n"));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 关窗口就把 sidecar 一起收掉,否则 node 进程会留下来占着端口
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                // 先把 Child 取出来再用,别让 MutexGuard 的临时值活过 state 本身
                let child = {
                    let state: tauri::State<Sidecar> = app.state();
                    let taken = state.0.lock().unwrap().take();
                    taken
                };
                if let Some(mut child) = child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::resolve_path;

    // agent 省略仓名时(cwd=…/ws/repo-a,路径是相对兄弟仓 repo-b 的),resolve_path 应能找到 repo-b 下的文件
    #[test]
    fn resolves_sibling_repo_path() {
        let ws = std::env::temp_dir().join(format!("chatcode-test-{}", std::process::id()));
        let repo_a = ws.join("repo-a");
        let target = ws.join("repo-b/docs/atisbo/nginx/README-mcp-rollout.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&repo_a).unwrap();
        std::fs::write(&target, b"x").unwrap();
        let got = resolve_path("docs/atisbo/nginx/README-mcp-rollout.md", Some(repo_a.to_str().unwrap()));
        assert_eq!(got, target.to_string_lossy());
        std::fs::remove_dir_all(&ws).unwrap();
    }
}
