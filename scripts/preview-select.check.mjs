#!/usr/bin/env node
// 文件编辑器预览区"能选中复制、不能编辑"的自检。
//   md:  预览是 .app 里的普通 DOM,.app 整体 user-select:none,得在白名单里单独放开;
//        放开的只能是"选",预览节点不许挂 contentEditable。
//   html:预览是 iframe,宿主 CSS 管不到;被预览的页面自己写 user-select:none 时靠注入的样式兜底。
// 跑法:node scripts/preview-select.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const css = readFileSync("src/styles.css", "utf8");
const fe = readFileSync("src/components/FileEditor.tsx", "utf8");

// 白名单那条规则:以 "{ -webkit-user-select: text; user-select: text; }" 收尾的选择器组
const allow = css.match(/([^{}]*)\{\s*-webkit-user-select:\s*text;\s*user-select:\s*text;\s*\}/g) || [];
assert.ok(allow.some((r) => /\.feditor-preview\b/.test(r)),
  "md 预览 .feditor-preview 不在可选白名单里 —— .app 的 user-select:none 会把整块预览封死");

const prev = fe.slice(fe.indexOf('className="feditor-preview md"'));
assert.ok(prev.length > 0, "找不到 md 预览节点");
assert.ok(!/contentEditable/.test(prev.slice(0, prev.indexOf("</div>"))),
  "md 预览挂了 contentEditable —— 要的是只读可选,不是可编辑");

assert.ok(/SCROLL_RUNTIME \+ SELECTABLE_STYLE/.test(fe), "html 预览没注入 SELECTABLE_STYLE");
assert.ok(/user-select:text!important/.test(fe), "SELECTABLE_STYLE 得带 !important,否则压不过页面自己的 user-select:none");

console.log("preview-select: ok");
