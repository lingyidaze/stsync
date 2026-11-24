#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

fail() { echo "✗ $*" >&2; exit 1; }

YES=0
ARG=
for a in "$@"; do
    case "$a" in
        -y|--yes) YES=1 ;;
        *) ARG=$a ;;
    esac
done

is_st() { [ -f "$1/server.js" ] && grep -q '"name": *"sillytavern"' "$1/package.json" 2>/dev/null; }

ST=
if [ -n "$ARG" ]; then
    is_st "$ARG" || fail "$ARG 不是 SillyTavern 文件夹"
    ST=$(cd "$ARG" && pwd)
else
    for d in "$PWD" "$HOME/SillyTavern" "$HOME/sillytavern" "$HOME"/* "$HOME"/*/*; do
        if [ -d "$d" ] && is_st "$d" && { [ -e "$d/plugins/stsync" ] || [ -e "$d/data/default-user/extensions/stsync" ]; }; then
            ST=$(cd "$d" && pwd); break
        fi
        [ -z "${ANY:-}" ] && [ -d "$d" ] && is_st "$d" && ANY=$d
    done
    [ -n "$ST" ] || [ -z "${ANY:-}" ] || { echo "没有检测到已安装的 STSync，无需卸载。"; exit 0; }
fi
[ -n "$ST" ] || fail "没有找到装有 STSync 的 SillyTavern。请把文件夹路径写在命令最后，例如：... | sh -s -- ~/SillyTavern"

TARGETS=
for p in "$ST/plugins/stsync" "$ST/data/_stsync" "$ST"/data/*/extensions/stsync; do
    [ -e "$p" ] && TARGETS="$TARGETS
$p"
done
[ -n "$TARGETS" ] || { echo "$ST 中没有安装 STSync，无需卸载。"; exit 0; }

echo "即将从 $ST 删除 STSync："
echo "$TARGETS" | sed '/^$/d; s/^/  · /'
echo "（本机的角色卡、聊天等数据不受影响；云端数据也不会被删除）"
if [ "$YES" = 0 ]; then
    [ -r /dev/tty ] || fail "无法交互确认，请加 --yes 参数"
    printf '确定卸载？[y/N]：'
    read -r REPLY </dev/tty || REPLY=
    case "$REPLY" in y|Y|yes) ;; *) echo "已取消"; exit 0 ;; esac
fi

echo "$TARGETS" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    rm -rf "$p"
    echo "✓ 已删除 $p"
done

CONFIG="$ST/config.yaml"
BACKUP="$CONFIG.bak-stsync"
if [ -f "$BACKUP" ]; then
    OTHERS=$(find "$ST/plugins" -mindepth 1 -maxdepth 1 ! -name '.*' ! -name 'package.json' ! -name 'README*' 2>/dev/null | head -n1)
    if [ -z "$OTHERS" ] && [ -f "$CONFIG" ]; then
        sed 's/^enableServerPlugins:.*$/enableServerPlugins: false/' "$CONFIG" > "$CONFIG.stsync.tmp"
        mv "$CONFIG.stsync.tmp" "$CONFIG"
        rm -f "$BACKUP"
        echo "✓ 已在 config.yaml 中关闭服务端插件功能（安装时由 STSync 打开）"
    else
        rm -f "$BACKUP"
        echo "! 还有其他服务端插件，config.yaml 中的 enableServerPlugins 保持开启"
    fi
fi

echo
echo "STSync 已卸载，重启 SillyTavern 后生效。"
