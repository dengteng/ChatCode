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
# 用法:  sh scripts/release-dmg.sh
#   凭据:默认读钥匙串档案 chatcode-notary,可用 NOTARY_PROFILE 覆盖;
#         也支持 APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID 三件套。
# ponytail: 没做 CI、没做版本号自动同步、没做增量公证,一条直线跑完就行。
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

APP_NAME="ChatCode"
TARGET="universal-apple-darwin"   # 带上 Intel,否则老 Mac 打不开
APP="src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
VERSION="$(node -p "require('./package.json').version")"
DMG="dist/$APP_NAME-$VERSION.dmg"

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

# --- 3. 构建 ---------------------------------------------------------------
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
echo "==> 构建 universal(两个架构各编一遍,慢)"
npx tauri build --target "$TARGET"

# 公证要求 hardened runtime。tauri 默认带,但签错了这里就早死,别扔给公证服务猜。
codesign -dvvv "$APP" 2>&1 | grep -q "Authority=Developer ID Application" \
  || { echo "签名不是 Developer ID,重来"; exit 1; }
codesign -d --verbose=4 "$APP" 2>&1 | grep -q "flags=.*runtime" \
  || { echo "缺 hardened runtime,公证一定被拒"; exit 1; }

# --- 4. 公证 .app,并把票据装订进去 ----------------------------------------
# 装订到 .app 上:用户把 app 拖出 dmg 后即使断网,Gatekeeper 也能就地验票。
echo "==> 公证 .app"
ditto -c -k --keepParent "$APP" /tmp/$APP_NAME-notarize.zip
xcrun notarytool submit /tmp/$APP_NAME-notarize.zip $NOTARY_ARGS --wait
xcrun stapler staple "$APP"

# --- 5. 出 dmg,再签、再公证、再装订 ---------------------------------------
# dmg 本身也要过 Gatekeeper —— 里面的 app 合法不代表这张盘合法。
# hdiutil 而不是 tauri 的 dmg target:后者用 AppleScript 驱动 Finder 美化窗口,无 GUI 授权时 -1712 超时。
echo "==> 出 dmg"
mkdir -p dist "/tmp/$APP_NAME-dmg"
rm -rf "/tmp/$APP_NAME-dmg"/*
cp -R "$APP" "/tmp/$APP_NAME-dmg/"
ln -s /Applications "/tmp/$APP_NAME-dmg/Applications"   # 让用户能直接拖过去
hdiutil create -volname "$APP_NAME" -srcfolder "/tmp/$APP_NAME-dmg" -ov -format UDZO "$DMG"
codesign --force --sign "$IDENT" "$DMG"
xcrun notarytool submit "$DMG" $NOTARY_ARGS --wait
xcrun stapler staple "$DMG"

# --- 6. 自检:模拟用户下载后的那次 Gatekeeper 判定 --------------------------
spctl -a -t open --context context:primary-signature -vv "$DMG"
spctl -a -vv "$APP"
echo
echo "可分发: $DMG"
