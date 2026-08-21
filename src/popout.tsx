import { useEffect, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileEditor } from "./components/FileEditor";
import { toast } from "./components/Toast";
import i18n from "./i18n";

// 大图 / 代码编辑器开成独立的原生窗口:可以拖到主窗口外面、和聊天并排看,不再被 app 框住。
// 窗口内容靠 URL hash 路由(index.html#/editor?…),入口在 main.tsx 分流,不加载聊天那一套。
let seq = 0;
const label = (kind: string) => `${kind}-${Date.now()}-${++seq}`;

// WebviewWindow 的构造错误不会抛,只派发 tauri://error —— 不监听就成了"点了没反应"。统一冒泡成 toast。
function watchWindow(w: WebviewWindow) {
  w.once("tauri://error", (e) => {
    console.error("popout window error", e);
    toast(i18n.t("打开窗口失败"), "error");
  });
  w.once("tauri://created", () => { w.setFocus().catch(() => {}); }); // 确保新窗口到前台,别开在主窗口后面
}

export function openEditorWindow(path: string, name: string) {
  watchWindow(new WebviewWindow(label("editor"), {
    url: `index.html#/editor?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
    title: name, width: 1100, height: 760, minWidth: 420, minHeight: 260, focus: true,
  }));
}

// 图片是 data: URL(几百 KB ~ 数 MB),塞不进窗口 URL —— 存起来按 key 传(同源,新窗口读得到)。
// 用 IndexedDB 而非 localStorage:自定义背景图本身就是 MB 级 dataURL 占着 localStorage,再往里写整张图会
// 撑爆 ~5MB 配额,setItem 抛 QuotaExceededError,开窗直接中断 —— 表现就是"点图片没反应"。IndexedDB 配额是
// 上百 MB 且同样同源共享,读取后即删,不留垃圾。
const DB_NAME = "cc-popout", STORE = "img";
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(k: string, v: string) {
  const db = await idb();
  await new Promise((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(v, k); tx.oncomplete = () => res(null); tx.onerror = () => rej(tx.error); });
}
async function idbTake(k: string): Promise<string | null> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite"); const store = tx.objectStore(STORE); const g = store.get(k);
    g.onsuccess = () => { store.delete(k); res((g.result as string) ?? null); }; g.onerror = () => rej(g.error);
  });
}
export async function openImageWindow(src: string, title: string) {
  const key = `img-${Date.now()}-${++seq}`;
  try { await idbPut(key, src); }
  catch { toast(i18n.t("打开图片失败"), "error"); return; }
  watchWindow(new WebviewWindow(label("image"), {
    url: `index.html#/image?k=${encodeURIComponent(key)}`,
    title, width: 900, height: 700, focus: true,
  }));
}

// 独立窗口路由:#/editor?path=…&name=… / #/image?k=…;不匹配就是主窗口,照常渲染 App
export function popoutRoute(): { kind: "editor" | "image"; params: URLSearchParams } | null {
  const m = window.location.hash.match(/^#\/(editor|image)\?(.*)$/);
  return m ? { kind: m[1] as "editor" | "image", params: new URLSearchParams(m[2]) } : null;
}

export function Popout({ kind, params }: { kind: "editor" | "image"; params: URLSearchParams }) {
  // 主题跟主窗口走(同源共享 localStorage);独立窗口有原生标题栏,不留 overlay 的顶部内边距
  const theme = localStorage.getItem("ChatCode-theme") === "light" ? "light" : "dark";
  // 关窗前把焦点还给主窗口:否则 macOS 下主窗口失焦,回去点图片标签的第一下只会激活窗口、被吞掉(看着像没反应)。
  // close() 只是发起关闭,真正的销毁绕道下面的 onCloseRequested(先 hide 再关)。
  const close = () => {
    WebviewWindow.getByLabel("main").then((w) => w?.setFocus()).catch(() => {});
    getCurrentWindow().close();
  };
  // 关窗改成两步:先 hide,隔一小会儿再真销毁。
  // 起因是一次 SIGSEGV:关掉图片浮窗后几秒,主进程崩在 WebKit::DisplayLink::notifyObserversDisplayDidRefresh()
  // (空指针 +0x10,栈里一帧我们的代码都没有)。那个刷新观察者挂在页面上,窗口一销毁页面就没了,而 CVDisplayLink
  // 线程还在遍历观察者链表 —— 拆链表和读链表撞同一帧。先 hide 会让 WebPageProxy 把可见状态打成 0 并摘掉观察者,
  // 等它摘干净了再 close,两件事就不在同一帧了。
  // 这是绕开系统框架里的竞态,不是根治(根在 WebKit,我们打不了补丁)。走 onCloseRequested 而不是只改 close():
  // 标题栏那个红点不经过我们的 close(),不拦在这里就等于只修了 Esc 那一半。
  useEffect(() => {
    const w = getCurrentWindow();
    let leaving = false;
    const un = w.onCloseRequested((e) => {
      if (leaving) return;          // 第二次是下面 setTimeout 里自己调的 close(),放行
      e.preventDefault();
      leaving = true;
      w.hide().catch(() => {});
      setTimeout(() => w.close().catch(() => {}), 120);
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);
  useEffect(() => {
    // Esc 关窗只给图片预览用。编辑器窗口不绑:编辑代码时很容易误点 Esc 把整个窗口关掉、丢失现场。
    if (kind !== "image") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind]);
  return (
    <div className="app popout" data-theme={theme}>
      {kind === "editor"
        ? <FileEditor windowed path={params.get("path") || ""} name={params.get("name") || ""} onClose={close} />
        : <ImageView srcKey={params.get("k") || ""} />}
    </div>
  );
}

function ImageView({ srcKey }: { srcKey: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined); // undefined=读取中
  useEffect(() => { idbTake(srcKey).then(setSrc).catch(() => setSrc(null)); }, [srcKey]);
  if (src === undefined) return <div className="img-window muted">加载中…</div>;
  if (!src) return <div className="img-window muted">图片已失效</div>;
  return <div className="img-window"><img src={src} /></div>;
}
