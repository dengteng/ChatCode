/// <reference types="vite/client" />

// View Transitions API —— 部分 TS lib 版本未内置,补一个可选声明(空态输入框 morph 用)
interface ViewTransition { finished: Promise<void>; ready: Promise<void>; updateCallbackDone: Promise<void>; skipTransition(): void; }
interface Document { startViewTransition?: (callback: () => void | Promise<void>) => ViewTransition; }
