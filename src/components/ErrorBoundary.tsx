// 渲染异常兜底。没有它的时候,任何一处渲染抛错都会让 React 卸载整棵树 —— 表现就是"突然白屏",
// 而且看不到任何线索(webview 里没有开发者工具时尤其抓瞎)。
// 这里把错误和堆栈显示出来,并给一个"重新加载"按钮,让用户至少能自己恢复。
import { Component, type ReactNode } from "react";
import i18n from "../i18n";

interface Props { children: ReactNode }
interface State { error: Error | null; stack: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // 存一份到 state 显示;同时打 console,方便接上 Safari 调试器时看完整信息
    this.setState({ stack: info.componentStack || "" });
    console.error("[chat-code] 渲染异常:", error, info.componentStack);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const text = `${error.message}\n\n${error.stack || ""}\n\n${i18n.t("组件栈")}:${stack}`;
    return (
      <div className="crash-screen">
        <h2>{i18n.t("界面出错了")}</h2>
        <p className="crash-hint">
          {i18n.t("这一处渲染抛了异常。下面是错误详情 —— 复制给开发者能直接定位。")}
        </p>
        <pre className="crash-detail">{text}</pre>
        <div className="crash-acts">
          <button className="primary" onClick={() => location.reload()}>{i18n.t("重新加载")}</button>
          <button onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}>{i18n.t("复制错误详情")}</button>
        </div>
      </div>
    );
  }
}
