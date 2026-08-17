// localStorage 键从 chat-code-* 改名成 ChatCode-*(和数据目录 ~/.ChatCode 对齐)。
// 老用户升级上来那些主题、侧栏宽度、commit 历史都存在老键里,不搬就等于给人恢复出厂设置。
//
// 必须在任何读键的模块之前执行 —— i18n.ts 在 import 阶段就读语言键,
// 所以 main.tsx 里这一行 import 排在 ./i18n 前面,顺序别动。
// ponytail: 只搬不删旧值以外的兼容处理都没做。新键已存在就跳过(第二个窗口重复跑不会覆盖)。
const OLD = "chat-code-";
const NEW = "ChatCode-";

for (const k of Object.keys(localStorage)) {   // 先快照:循环里要删键
  if (!k.startsWith(OLD)) continue;
  const nk = NEW + k.slice(OLD.length);
  const v = localStorage.getItem(k);
  if (v !== null && localStorage.getItem(nk) === null) localStorage.setItem(nk, v);
  localStorage.removeItem(k);
}

export {};
