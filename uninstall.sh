#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

BASE=/srv/stsync
OPT=/opt/stsync
YES=0

usage() {
    cat <<'EOF'
卸载 STSync 服务端（root）
  curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/uninstall.sh | sudo sh
  stsync uninstall [--yes]
参数：--yes  不询问，直接卸载
会删除：服务、程序、防火墙规则、系统用户，以及全部云端数据和 API Key（无法恢复）
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes) YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
done

fail() { echo "✗ $*" >&2; exit 1; }
done_() { echo "  ✓ $*"; }
[ "$(id -u)" = 0 ] || fail "请用 root 运行：在命令最前面加上 sudo"

UNITS="stsync.service stsync-tauritavern.service stsync-autolock.timer stsync-autolock.service"
PORT=$(sed -n 's/.*"listen": *"[^"]*:\([0-9]*\)".*/\1/p' "$BASE/config.json" 2>/dev/null | head -n1)
SHARED=$(sed -n 's/.*"workspace": *"\([^"]*\)".*/\1/p' "$BASE/config.json" 2>/dev/null | head -n1)
[ "$SHARED" != "$BASE/workspace" ] || SHARED=

FOUND=
for u in $UNITS; do [ -f "/etc/systemd/system/$u" ] && FOUND=1; done
[ -e "$BASE" ] || [ -e "$OPT" ] || [ -e /usr/local/sbin/stsync ] || id stsync >/dev/null 2>&1 || [ -n "$FOUND" ] \
    || { echo "没有检测到已安装的 STSync，无需卸载。"; exit 0; }

echo "即将卸载 STSync，以下内容会被删除："
echo "  · 服务 stsync / stsync-tauritavern"
[ -n "$PORT" ] && echo "  · 防火墙放行规则 $PORT/tcp 与连接限速规则"
echo "  · 程序 $OPT 与管理命令 /usr/local/sbin/stsync"
echo "  · 云端数据、API Key、服务器证书与已接入设备 $BASE$( [ -d "$BASE/workspace" ] && printf '（%s）' "$(du -sh "$BASE/workspace" 2>/dev/null | cut -f1)" )"
echo "  · 系统用户 stsync"
if [ -n "$SHARED" ]; then
    echo "  （云端数据与 $SHARED 共用，这部分数据会保留，不会删除；STSync 的回收站会被删除）"
    echo "已连接的酒馆设备之后将无法同步。"
else
    echo "已连接的酒馆设备之后将无法同步，云端数据无法恢复。"
fi
if [ "$YES" = 0 ]; then
    [ -r /dev/tty ] || fail "无法交互确认，请加 --yes 参数"
    printf '确定卸载？输入 yes 继续：'
    read -r REPLY </dev/tty || REPLY=
    [ "$REPLY" = yes ] || { echo "已取消"; exit 0; }
fi

echo
for u in $UNITS; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    if [ -f "/etc/systemd/system/$u" ]; then rm -f "/etc/systemd/system/$u"; done_ "已删除 $u"; fi
done
systemctl daemon-reload
systemctl reset-failed $UNITS >/dev/null 2>&1 || true

if command -v ufw >/dev/null 2>&1; then
    for f in /etc/ufw/before.rules /etc/ufw/before6.rules; do
        [ -f "$f" ] && grep -q '^# BEGIN stsync ratelimit' "$f" || continue
        awk '/^# BEGIN stsync ratelimit/ { skip = 1; next } /^# END stsync ratelimit/ { skip = 0; next } !skip' "$f" > "$f.stsync.tmp"
        cat "$f.stsync.tmp" > "$f"
        rm -f "$f.stsync.tmp"
        done_ "已移除 $f 中的限速规则"
    done
    rm -f /etc/ufw/before.rules.stsync.bak /etc/ufw/before6.rules.stsync.bak
    if [ -n "$PORT" ] && ufw status 2>/dev/null | grep -q "^$PORT/tcp .*# STSync"; then
        ufw delete allow "$PORT/tcp" >/dev/null 2>&1 || true
        done_ "已移除防火墙放行 $PORT/tcp"
    fi
    ufw status 2>/dev/null | grep -q '^Status: active' && ufw reload >/dev/null 2>&1 || true
fi

for p in /usr/local/sbin/stsync "$OPT" "$BASE"; do
    if [ -e "$p" ] || [ -L "$p" ]; then rm -rf "$p"; done_ "已删除 $p"; fi
done
if id stsync >/dev/null 2>&1; then
    userdel stsync >/dev/null 2>&1 || true
    done_ "已删除系统用户 stsync"
fi

echo
[ -z "$SHARED" ] || echo "共用的酒馆数据仍在 $SHARED，未做任何改动。"
echo "STSync 已卸载。云服务器控制台「安全组」里为它放行的端口${PORT:+ $PORT} 可以一并关闭。"
echo "酒馆端：在扩展页删除 STSync 扩展，或运行 st-uninstall.sh。"
