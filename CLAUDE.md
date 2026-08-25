# chat-code

## 打包规矩（重要）
- **每次完成改代码的任务后都自动打包**，不用等用户开口。
- 改完代码只打包，**不要**自动 quit app / `pkill` / 覆盖 `/Applications`。
  原因：会搞坏用户其他会话里正在执行的任务。
- **必须签名打包**，禁止打 adhoc 包。打包命令固定这一条：
  ```sh
  export APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')"
  [ -n "$APPLE_SIGNING_IDENTITY" ] || { echo "无可用签名证书，停手"; exit 1; }
  PATH="$HOME/.cargo/bin:$PATH" npx tauri build
  ```
  （`cargo` 在 `~/.cargo/bin`，不在默认 PATH；身份从 keychain 现取，真名不落仓库）
- 为什么非签不可：adhoc 包在 TCC 里靠 cdhash 认身份，每次重打包 cdhash 变，
  屏幕录制/麦克风授权全部失效并重新弹窗（「隐私与安全性」里那行是残留旧记录）。
  用开发者证书后 csreq 认 `com.chatcode.app` + 证书，重打包授权不掉。
- 打完 `codesign -dvvv <app>` 自检：必须是 `Identifier=com.chatcode.app` +
  `Authority=Apple Development: …`，出现 `Signature=adhoc` 就是没签上，重来。
- 打完只告诉用户新包路径，用户自己装：
  `src-tauri/target/release/bundle/macos/ChatCode.app`
- 签名身份**不写进 `tauri.conf.json` / `package.json`**（会把开发者真名 + 证书 ID 提交进仓库）。

## 产品介绍图出完就上传（重要）
- 用 `product-intro-pic` skill 出完一期图后**自动上传**，不用等用户开口：
  ```sh
  node scripts/publish-pics.mjs           # 传全部期(未改动的自动跳过)
  node scripts/publish-pics.mjs 13-功能特性横版   # 只传这一期
  node scripts/publish-pics.mjs drop chatcode/12-   # 标删一批(前缀匹配)
  ```
- 传到 tt-knowledge 的 `dengtengly@gmail.com` 空间，vault 路径 `chatcode/<期目录>/<文件>`。
  **前缀只留一层 `chatcode/`**：客户端文件列表是单行截断的，前缀长了每行都是相同的那截，
  看不出是哪一期哪张图（一开始写成 `packages/chatcode/product-intro/`，列表里全糊成一样）。
- 客户端没有通用文件夹折叠 —— `knowledge.tsx` 里只硬编码了 `images/` 前缀折叠成
  「文章采集的图片」，其余一律平铺。要真正的分组得改 tt-knowledge 那个项目。
- 和 fortune-signal-app 的 `publish-apk.mjs` 同一套：`scripts/vault.mjs` 是从那边原样搬来的，
  凭据共用 `~/.chatcode-publish.json`（已登录，别重登 —— refresh token 是轮换式的，
  重登会把另一端顶下线）。
- 增量靠 `out/.published.json` 记 `mtime:size`，跟着产物走、在 `.gitignore` 里。
  图改了重跑即可，不会全量重传。

## 架构速记
- 前端 Tauri webview（`src/`）连 `ws://127.0.0.1:PORT`（开发 8975 / 打包 8976）。
- 后端 sidecar（`sidecar/server.mjs`）：每会话一个 SDK `query`，走 `@anthropic-ai/claude-agent-sdk`。
  打包版被 esbuild 打进 `src-tauri/resources/sidecar.mjs`（**注释会被剥掉**，别 grep 注释验证 bundle）。
- 用量条数据源：sidecar 的 `usageProbe`（无 prompt 常驻 query）读 SDK `/api/oauth/usage`，
  取 `five_hour` / `seven_day` 的 `utilization`。空闲会话的 GET 会回退到旧响应头快照（偏低），**只认探针**。
- 原生能力（文件选择器等）走 `src-tauri/src/main.rs` 的 `#[tauri::command]`。
  阻塞型对话框（`blocking_pick_folder`）必须放 `async` + `spawn_blocking`，否则主线程自死锁卡死。
