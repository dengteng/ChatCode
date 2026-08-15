// 交给系统去打开(Finder 定位 / 默认程序 / 浏览器)的三条命令,统一从这里走。
// 起因:文件树右键「打开目录」点了没反应,而调用点全是 invoke(...).catch(() => {}) ——
// 命令报什么错都被吞掉,界面上零线索,连是"路径不存在"还是"LaunchServices 拒绝"都分不清。
// Rust 那边已改成等 open 退出并回传 stderr,这里负责把它显出来。
import { invoke } from "@tauri-apps/api/core";
import { toast } from "./components/Toast";
import i18n from "./i18n";

const call = (cmd: string, args: Record<string, unknown>) =>
  invoke(cmd, args).catch((e) => toast(`${i18n.t("打开失败")}：${e}`, "error"));

export const openPath = (path: string, cwd?: string) => call("open_path", { path, cwd });
export const revealPath = (path: string, cwd?: string) => call("reveal_path", { path, cwd });
export const openUrl = (url: string) => call("open_url", { url });
