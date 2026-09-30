#!/usr/bin/env node
// 「登录失效 → 去终端重新登录 → 回到 ChatCode」这条路的自检。
// 症状:切到别的会话已经能用,失败的那个会话气泡还是红条「登录已失效」,重发也可能还拿着旧 CLI 进程。
// 三处接线缺一不可:sidecar 报凭证写入时刻(credAt)、气泡按它切成「已重新登录 + 重发」、
// 该会话下一条消息先重启 CLI。解析那段照抄一份跑样例,其余断言源码没漂移。
//
// 跑法:node scripts/auth-relogin.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SIDECAR = readFileSync("sidecar/server.mjs", "utf8");
const CHAT = readFileSync("src/components/Chat.tsx", "utf8");

// ---------- 1. 钥匙串 mdat 解析(和 server.mjs 的 claudeCredAt 保持一致) ----------
const RE = /"mdat"<timedate>=\S+\s+"(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z/;
assert.ok(SIDECAR.includes(RE.source), "claudeCredAt 的解析正则漂移了,同步这里的样例");
const parse = (out) => { const m = out.match(RE); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0; };
const sample = `keychain: "/Users/x/Library/Keychains/login.keychain-db"
attributes:
    "cdat"<timedate>=0x32303236303930323034303633385A00  "20260902040638Z\\000"
    "mdat"<timedate>=0x32303236303933303031353430345A00  "20260930015404Z\\000"`;
assert.equal(parse(sample), Date.UTC(2026, 8, 30, 1, 54, 4), "mdat 要按 UTC 解析");
assert.equal(parse("security: SecKeychainSearchCopyNext: The specified item could not be found"), 0, "没这条凭证时返回 0");
// 只读属性:带 -w / -g 会把密钥打出来(-g 还会弹授权框)
assert.ok(/find-generic-password", "-s", "Claude Code-credentials"\]\)/.test(SIDECAR), "读凭证时刻不能带 -w/-g");

// ---------- 2. sidecar:失效后下一条消息先重启 CLI ----------
assert.ok(SIDECAR.includes('msg.error === "authentication_failed") sess.authFailed = true'), "没认 SDK 的 authentication_failed");
assert.ok(/else if \(sess\.authFailed\) \{\s*\n(?:\s*\/\/.*\n)?\s*sess\.authFailed = false;\s*\n\s*await restartAgent\(ws, sess, m\.sessionId, true\);/.test(SIDECAR),
  "登录失效后的下一条消息要先 restartAgent(keepRunning=true),否则还是那个拿着过期令牌的 CLI");
assert.ok(/credAt \}/.test(SIDECAR), "auth_status 的 claude 段要带 credAt");

// ---------- 3. 气泡:按凭证时刻切换,不按 loggedIn ----------
assert.ok(CHAT.includes("(authCredAt ?? 0) > (items[items.length - 1]?.ts ?? 0)"),
  "要拿凭证写入时刻和失败那轮比 —— loggedIn 在令牌服务端过期时仍是 true,靠它会一失败就显示已恢复");
assert.ok(CHAT.includes("onResend={lastIdle ? onResendLast : undefined}"), "重发只挂最后一轮,且传稳定函数(memo)");

console.log("✓ auth-relogin: 凭证时刻解析 / 失效后重启 CLI / 气泡按凭证时刻切换 全部通过");
