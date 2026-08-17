#!/bin/sh
# 发行版打包:Developer ID 签名 + 公证 + 装订,产出别人下载就能装的 .dmg。
#
# 和 CLAUDE.md 里那条日常打包命令是两回事:
#   日常   Apple Development 证书 —— 只在本机有效,别人下载会被 Gatekeeper 拦成「已损坏」。
#   发行   Developer ID Application 证书 + 公证(notarize) + 装订(staple) —— 才是对外分发那条链。
#
# 前置(只做一次):
#   1. developer.apple.com → Certificates → 新建 "Developer ID Application",下载双击装进钥匙串。
#      注意不是 "Apple Distribution"(那个只给 App Store 用,直链下载不认)。
#   2. appleid.apple.com 生成 App 专用密码,然后存成钥匙串档案:
#      xcrun notarytool store-credentials chatcode-notary \
#        --apple-id <你的 Apple ID> --team-id <TeamID> --password <App 专用密码>
#
# 用法:  sh scripts/release-dmg.sh              # 默认分架构出两个包(arm64 + intel)
#        ARCHS=arm64 sh scripts/release-dmg.sh  # 只出 Apple Silicon 那个
#        ARCHS=universal sh scripts/release-dmg.sh  # 老的二合一单包
#   凭据:默认读钥匙串档案 chatcode-notary,可用 NOTARY_PROFILE 覆盖;
#         也支持 APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID 三件套。
#
# 为什么默认分架构而不是 universal:包里那份内置 Node 是 217MB 的双架构二进制,
# 任何一台机器上有一半是永远不会执行的死重量(arm64 切片 107MB / x86_64 110MB)。
# 分开出包后单个 dmg 从 100MB 掉到 55MB 上下,代价是发布页要放两个链接。
# ponytail: 没做 CI、没做版本号自动同步、没做增量公证,也没做「按 UA 自动选包」的下载页,一条直线跑完就行。
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

APP_NAME="ChatCode"
ARCHS="${ARCHS:-arm64 x64}"
VERSION="$(node -p "require('./package.json').version")"

# --- 1. 证书 ---------------------------------------------------------------
IDENT="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')"
[ -n "$IDENT" ] || { echo "钥匙串里没有 Developer ID Application 证书。见本文件顶部前置步骤 1。"; exit 1; }
export APPLE_SIGNING_IDENTITY="$IDENT"
echo "==> 签名身份: $IDENT"

# --- 2. 公证凭据(先验,别等构建完 8 分钟才发现没配)------------------------
PROFILE="${NOTARY_PROFILE:-chatcode-notary}"
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  NOTARY_ARGS="--keychain-profile $PROFILE"
elif [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
  NOTARY_ARGS="--apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $APPLE_TEAM_ID"
else
  echo "没有可用的公证凭据(钥匙串档案 '$PROFILE' 不存在,APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID 也没给)。见前置步骤 2。"
  exit 1
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
DMGS=""

for ARCH in $ARCHS; do
  # 三张表对齐:rust target / 内置 node 的架构名 / dmg 文件名后缀。
  # 文件名用 intel 而不是 x64 —— 下载页给的是人看的,写 x64 会有人以为自己的 M 系列该下这个。
  case "$ARCH" in
    arm64)     TARGET="aarch64-apple-darwin"; NODE_ARCHS="arm64";      SUFFIX="arm64" ;;
    x64|intel) TARGET="x86_64-apple-darwin";  NODE_ARCHS="x64";        SUFFIX="intel" ;;
    universal) TARGET="universal-apple-darwin"; NODE_ARCHS="arm64 x64"; SUFFIX="universal" ;;
    *) echo "不认识的架构 '$ARCH'(只认 arm64 / x64 / universal)"; exit 1 ;;
  esac
  APP="src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
  # 产物放 release/ 而不是 dist/ —— dist/ 是 vite 的输出目录且 emptyOutDir 默认开,
  # 下一轮架构的 npm run build 会把它清空,连带把上一轮打好、公证好的 dmg 一并删掉
  # (单架构时最后一步才出 dmg,所以这个坑只有分架构循环才会踩到)。
  DMG="release/$APP_NAME-$VERSION-$SUFFIX.dmg"

  # --- 3. 构建 -------------------------------------------------------------
  # NODE_ARCHS 要 export:tauri 的 beforeBuildCommand 里那条 npm run fetch:node 是子进程,
  # 靠继承环境变量才知道这一轮该抓哪个架构的 node(它自己会按架构判断要不要重抓)。
  export NODE_ARCHS
  echo "==> 构建 $SUFFIX($TARGET,内置 node: $NODE_ARCHS)"
  npx tauri build --target "$TARGET"

  # 公证要求 hardened runtime。tauri 默认带,但签错了这里就早死,别扔给公证服务猜。
  codesign -dvvv "$APP" 2>&1 | grep -q "Authority=Developer ID Application" \
    || { echo "签名不是 Developer ID,重来"; exit 1; }
  codesign -d --verbose=4 "$APP" 2>&1 | grep -q "flags=.*runtime" \
    || { echo "缺 hardened runtime,公证一定被拒"; exit 1; }
  # 内置 node 的架构必须和包一致:错了的话签名/公证全都能过,用户装上才发现是白窗口。
  # 两边都排序后再比 —— lipo 吐的是 "x86_64 arm64",按 NODE_ARCHS 写的是 "arm64 x86_64",
  # 直接比字符串会把 universal 这条正确的路也判成不符。
  norm() { for a in $1; do if [ "$a" = x64 ]; then echo x86_64; else echo "$a"; fi; done | sort | tr '\n' ' '; }
  GOT="$(norm "$(lipo -archs "$APP/Contents/Resources/resources/node")")"
  [ "$GOT" = "$(norm "$NODE_ARCHS")" ] \
    || { echo "包内 node 架构($GOT)与目标 $NODE_ARCHS 不符"; exit 1; }

  # --- 4. 公证 .app,并把票据装订进去 --------------------------------------
  # 装订到 .app 上:用户把 app 拖出 dmg 后即使断网,Gatekeeper 也能就地验票。
  echo "==> 公证 .app($SUFFIX)"
  ditto -c -k --keepParent "$APP" "/tmp/$APP_NAME-notarize.zip"
  xcrun notarytool submit "/tmp/$APP_NAME-notarize.zip" $NOTARY_ARGS --wait
  xcrun stapler staple "$APP"

  # --- 5. 出 dmg,再签、再公证、再装订 -------------------------------------
  # dmg 本身也要过 Gatekeeper —— 里面的 app 合法不代表这张盘合法。
  # hdiutil 而不是 tauri 的 dmg target:后者用 AppleScript 驱动 Finder 美化窗口,无 GUI 授权时 -1712 超时。
  echo "==> 出 dmg($SUFFIX)"
  mkdir -p release "/tmp/$APP_NAME-dmg"
  rm -rf "/tmp/$APP_NAME-dmg"/*
  cp -R "$APP" "/tmp/$APP_NAME-dmg/"
  ln -s /Applications "/tmp/$APP_NAME-dmg/Applications"   # 让用户能直接拖过去
  hdiutil create -volname "$APP_NAME" -srcfolder "/tmp/$APP_NAME-dmg" -ov -format UDZO "$DMG"
  codesign --force --sign "$IDENT" "$DMG"
  xcrun notarytool submit "$DMG" $NOTARY_ARGS --wait
  xcrun stapler staple "$DMG"

  # --- 6. 自检:模拟用户下载后的那次 Gatekeeper 判定 ------------------------
  spctl -a -t open --context context:primary-signature -vv "$DMG"
  spctl -a -vv "$APP"
  DMGS="$DMGS $DMG"
done

echo
echo "可分发:"
for d in $DMGS; do echo "  $(du -h "$d" | cut -f1)  $d"; done
