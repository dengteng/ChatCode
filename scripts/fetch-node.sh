#!/bin/sh
# 把 Node 运行时抓进 src-tauri/resources/node,让 .app 自带解释器 ——
# 否则用户机器没装 Node,应用装上也起不来 sidecar(白窗口 + 日志里一行「找不到 node」)。
#
# 为什么不直接拷本机那个 node:
#   Homebrew 的 node 动态链接 /opt/homebrew 下的 icu4c/openssl,别人机器上没有,一跑就挂。
#   官方 tarball 里那份是自带依赖的,拷哪台机器都能跑。
#
# universal(arm64 + x64 lipo 成一个):release-dmg.sh 出的是 universal 包,
# 只塞 arm64 的话 Intel 用户装上照样起不来 —— 正是这脚本要消灭的那个 bug。
#
# 已存在且版本对就跳过(下载 120MB 不该每次构建都来一遍)。
# ponytail: 没做多版本共存、没做断点续传;删掉 src-tauri/resources/node 就是重来一遍。
set -e
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-v22.23.2}"   # 22 = 现役 LTS(Jod)。升级只改这一行
# 默认两个架构(release-dmg.sh 出的是 universal 包)。本机自用嫌大就 NODE_ARCHS=arm64,
# dmg 能小一半 —— 但那种包给 Intel Mac 用户会退回「找不到 node」。
NODE_ARCHS="${NODE_ARCHS:-arm64 x64}"
OUT="src-tauri/resources/node"
CACHE="${TMPDIR:-/tmp}/chat-code-node"

# 「已就位」得连架构一起看,不能只比版本:分架构出包时 NODE_ARCHS 会变,
# 只比版本就会把上一次留下的那份原样用掉 —— Intel 包里塞 arm64 的 node,
# 用户装上就是白窗口 + 日志一行「找不到 node」,正是这脚本要消灭的那个 bug。
# node 的 x64 在 lipo 里叫 x86_64,两套叫法这里对齐后再比。
WANT_ARCHS="$(for a in $NODE_ARCHS; do if [ "$a" = x64 ]; then echo x86_64; else echo "$a"; fi; done | sort | tr '\n' ' ')"
HAVE_ARCHS="$(lipo -archs "$OUT" 2>/dev/null | tr ' ' '\n' | sort | tr '\n' ' ')"
# 版本要执行 node 才知道,而 arm 机器上跑纯 x86_64 那份未必成(没装 Rosetta 就直接失败)——
# 取不到版本就当没就位重来一遍。tarball 有缓存,代价只是重新解包+签名几秒。
if [ -x "$OUT" ] && [ "$WANT_ARCHS" = "$HAVE_ARCHS" ] && [ "$("$OUT" -v 2>/dev/null)" = "$NODE_VERSION" ]; then
  echo "==> node $NODE_VERSION ($(lipo -archs "$OUT")) 已就位,跳过下载"
else
  mkdir -p "$CACHE" "$(dirname "$OUT")"
  # SHASUMS256.txt 走 https 从 nodejs.org 取,拿它校验两个 tarball ——
  # 下载来的二进制是要被我们签名分发出去的,不校验等于替上游的任何一次投毒背书。
  SUMS="$CACHE/SHASUMS256-$NODE_VERSION.txt"
  [ -f "$SUMS" ] || curl -sfL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$SUMS"

  for ARCH in $NODE_ARCHS; do
    TAR="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
    if [ ! -f "$CACHE/$TAR" ]; then
      echo "==> 下载 $TAR"
      curl -#fL "https://nodejs.org/dist/$NODE_VERSION/$TAR" -o "$CACHE/$TAR"
    fi
    (cd "$CACHE" && grep " $TAR\$" "$SUMS" | shasum -a 256 -c -) \
      || { echo "$TAR 校验失败,已删除,重跑一次"; rm -f "$CACHE/$TAR"; exit 1; }
    tar -xzf "$CACHE/$TAR" -C "$CACHE" "node-$NODE_VERSION-darwin-$ARCH/bin/node"
  done

  # npm 一起带上:引导页要用它装 claude CLI。npm 是纯 JS,不分架构,随便从哪个 tarball 取一份。
  # 只取 lib/node_modules/npm(约 12MB),bin/ 里那两个是软链,用不上 —— 我们直接 node npm/bin/npm-cli.js。
  FIRST_ARCH="$(echo "$NODE_ARCHS" | awk '{print $1}')"
  rm -rf src-tauri/resources/npm
  tar -xzf "$CACHE/node-$NODE_VERSION-darwin-$FIRST_ARCH.tar.gz" -C "$CACHE" \
    "node-$NODE_VERSION-darwin-$FIRST_ARCH/lib/node_modules/npm"
  cp -R "$CACHE/node-$NODE_VERSION-darwin-$FIRST_ARCH/lib/node_modules/npm" src-tauri/resources/npm

  # lipo -create 单个输入也照样输出(不会变胖),所以两种情况一条命令
  IN=""
  for ARCH in $NODE_ARCHS; do IN="$IN $CACHE/node-$NODE_VERSION-darwin-$ARCH/bin/node"; done
  # shellcheck disable=SC2086
  lipo -create $IN -output "$OUT"
  chmod +x "$OUT"
  echo "==> node $NODE_VERSION ($(lipo -archs "$OUT")) → $OUT"
fi

# 签名:嵌在 .app 里的 Mach-O 必须自己带签名,公证服务会逐个查。
# 且必须给 JIT 那几个 entitlement —— hardened runtime 默认禁可写可执行内存,
# V8 起不来,表现是 node 一跑就被系统 kill(Electron 系应用签的也是这几条)。
# 顺序上先签它、后由 tauri 签整个 .app:反过来签会把外层的封印弄失效。
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  codesign --force --options runtime --timestamp \
    --entitlements src-tauri/node.entitlements \
    --sign "$APPLE_SIGNING_IDENTITY" "$OUT"
  echo "==> 已签名内置 node"
else
  echo "==> 未设 APPLE_SIGNING_IDENTITY,内置 node 不签名(本机跑没问题,对外分发必须签)"
fi
