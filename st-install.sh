#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

REPO=${STSYNC_REPO:-https://github.com/lingyidaze/stsync}

fail() { echo "✗ $*" >&2; exit 1; }
is_termux() { case "${PREFIX:-}" in *com.termux*) true ;; *) false ;; esac; }

NEED=
command -v git >/dev/null 2>&1 || NEED="$NEED git"
command -v node >/dev/null 2>&1 || NEED="$NEED nodejs"
if [ -n "$NEED" ]; then
    if is_termux; then
        echo "▶ 安装缺少的组件：$NEED"
        # shellcheck disable=SC2086
        pkg install -y $NEED || fail "安装失败，请手动运行：pkg install$NEED"
    else
        fail "缺少$NEED，请先安装后再运行"
    fi
else
    echo "✓ git、node 已安装，跳过"
fi

is_st() { [ -f "$1/server.js" ] && grep -q '"name": *"sillytavern"' "$1/package.json" 2>/dev/null; }

ST=
if [ $# -gt 0 ]; then
    is_st "$1" || fail "$1 不是 SillyTavern 文件夹"
    ST=$(cd "$1" && pwd)
else
    for d in "$PWD" "$HOME/SillyTavern" "$HOME/sillytavern" "$HOME"/* "$HOME"/*/*; do
        if [ -d "$d" ] && is_st "$d"; then ST=$(cd "$d" && pwd); break; fi
    done
fi
[ -n "$ST" ] || fail "没有找到 SillyTavern。请把文件夹路径写在命令最后，例如：... | sh -s -- ~/SillyTavern"
echo "▶ 找到 SillyTavern：$ST"

fingerprint() { cat "$ST/plugins/stsync/"* "$ST/config.yaml" 2>/dev/null | cksum; }
BEFORE=$(fingerprint)
CHANGED=0

EXT="$ST/data/default-user/extensions/stsync"
if [ -d "$EXT/.git" ]; then
    git -C "$EXT" fetch -q --depth 1 origin || fail "检查更新失败，请检查网络"
    if [ "$(git -C "$EXT" rev-parse HEAD)" = "$(git -C "$EXT" rev-parse '@{u}')" ]; then
        echo "✓ STSync 扩展已是最新，跳过"
    else
        echo "▶ 更新 STSync 扩展"
        git -C "$EXT" reset -q --hard '@{u}'
        CHANGED=1
    fi
else
    echo "▶ 下载 STSync 扩展"
    rm -rf "$EXT"
    mkdir -p "$(dirname "$EXT")"
    git clone -q --depth 1 "$REPO" "$EXT"
    CHANGED=1
fi

OUT=$(node "$EXT/st-plugin/install.mjs" "$ST" 2>&1) || { echo "$OUT" >&2; fail "安装服务端插件失败"; }
echo "$OUT" | grep -E '^(✓|!)' || true
[ "$(fingerprint)" = "$BEFORE" ] || CHANGED=1

echo
if [ "$CHANGED" = 0 ]; then
    echo "全部已就绪，无需重启 SillyTavern。"
else
    echo "最后一步：重启 SillyTavern。"
    echo "  Termux：在运行 SillyTavern 的窗口按 Ctrl+C 停止，再运行 cd \"$ST\" && ./start.sh"
    echo "  之后在扩展页打开 STSync，填写服务器地址和 API Key。"
fi
echo "卸载：curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/st-uninstall.sh | sh"
