// 抽屉「btw 顺便问问」:任务跑着的时候临时问一句,不打断 agent。
// 底层是 CLI 的 side_question(控制通道),和主线消息走两条路 —— 主线消息在 sidecar 会排队
// 等本轮跑完,侧问不会。代价也在这:CLI 对侧问硬拒所有工具、maxTurns:1,
// 所以它只能拿"已经在这个会话上下文里的东西"+ 模型自身知识作答,不会去读文件、跑命令。
//
// 不做持久化(用户明确要求):历史只活在内存,且 CLI 侧 skipTranscript,主会话 transcript 也不留痕。
// 模块级 Map 存而不是组件 state —— 抽屉一关组件就卸载,存组件里切个 tab 就全没了。
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApi } from "../store";

type Turn = { q: string; a?: string; err?: string };

// 按会话存,随进程消亡。切 tab / 关抽屉 / 切会话再回来都还在,重启软件就没了。
const history = new Map<string, Turn[]>();

// 消息区划选后点「顺便问问」寄来的草稿。那一刻抽屉可能还没开、本组件还没挂载,
// 没法直接 setState —— 先寄存在这里,组件挂载时(useState 初值)取走;
// 已经挂载的情况靠下面那个 cc-open-btw 监听接。同一条事件两边只有一边能取到(takeDraft 取完即清)。
let pendingDraft = "";
const takeDraft = () => { const d = pendingDraft; pendingDraft = ""; return d ? `${d}\n` : ""; }; // 末尾补换行:粘完光标落到新的一行,直接接着写问题
export function stashBtwDraft(text: string) {
  pendingDraft = text;
  window.dispatchEvent(new CustomEvent("cc-open-btw")); // App 接住:把抽屉切到本 tab 并打开
}

export function BtwTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { askBtw } = useApi();
  const [turns, setTurns] = useState<Turn[]>(() => history.get(sessionId) ?? []);
  const [text, setText] = useState(takeDraft);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 光标挪到末尾(草稿末尾那个换行的下一行)。等一帧:此刻 textarea 的 value 还是上一次渲染的。
  const focusEnd = () => requestAnimationFrame(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  });

  // 已经挂着的时候又划选一段点「顺便问问」:接在当前草稿后面,不覆盖用户已经敲的字
  useEffect(() => {
    const onDraft = () => { setText((cur) => cur + takeDraft()); focusEnd(); };
    window.addEventListener("cc-open-btw", onDraft);
    return () => window.removeEventListener("cc-open-btw", onDraft);
  }, []);
  useEffect(() => { if (text) focusEnd(); }, []); // 挂载时就带着草稿(抽屉是被「顺便问问」现开的),事件已经过去了,这里补焦点

  useEffect(() => { setTurns(history.get(sessionId) ?? []); setBusy(false); }, [sessionId]);
  // 每次列表变化滚到底:新问题和回答都追加在末尾,不滚就看不见
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [turns, busy]);

  const put = (next: Turn[]) => { history.set(sessionId, next); setTurns(next); };

  const ask = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    setBusy(true);
    const asked = [...(history.get(sessionId) ?? []), { q }];
    put(asked);
    try {
      const a = await askBtw(sessionId, q);
      put(asked.map((x, i) => (i === asked.length - 1 ? { ...x, a } : x)));
    } catch (e: any) {
      put(asked.map((x, i) => (i === asked.length - 1 ? { ...x, err: String(e?.message || e) } : x)));
    } finally {
      setBusy(false);
    }
  };

  return <div className="btw-tab">
    <div className="btw-note">{t("在这里随便问一句,不会打断正在跑的任务。它只能基于当前会话已有的上下文回答,不会读文件、不会跑命令。")}</div>
    <div className="btw-list" ref={listRef}>
      {turns.map((turn, i) => <div className="btw-turn" key={i}>
        <div className="btw-q">{turn.q}</div>
        {turn.a !== undefined && <div className="btw-a">{turn.a || t("(没有回答)")}</div>}
        {turn.err && <div className="btw-a err">{turn.err}</div>}
        {turn.a === undefined && !turn.err && <div className="btw-a wait"><LoaderCircle size={12} className="ico-spin" /> {t("思考中…")}</div>}
      </div>)}
    </div>
    <div className="btw-input">
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        // Enter 发送、Shift+Enter 换行(同主输入框);输入法组合中的 Enter 是在选字,不能当发送
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(); } }}
        placeholder={t("顺便问一句…")}
        rows={2}
        spellCheck={false}
      />
      <button className="hi" disabled={!text.trim() || busy} onClick={ask}>{busy ? <LoaderCircle size={12} className="ico-spin" /> : t("问")}</button>
    </div>
  </div>;
}
