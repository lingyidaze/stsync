#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

NODE_VERSION=v24.22.3
MIN_NODE=22.15.0
TTSYNC_VERSION=v2.6.0
TTSYNC_LISTEN=127.0.0.1:18443
REPO_TARBALL="https://codeload.github.com/lingyidaze/stsync/tar.gz/${STSYNC_REF:-main}"
BASE=/srv/stsync
OPT=/opt/stsync
PORT=8443
HOST=
TAURITAVERN=1
WORKSPACE=

usage() {
    cat <<'EOF'
安装 / 升级 STSync 服务端（Debian / Ubuntu，root）
  curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/install.sh | sudo sh -s -- [参数]
  sh install.sh [参数]（在仓库目录中）
参数：--port 端口（默认 8443）  --host IP或域名  --no-tauritavern
      --workspace 目录   直接使用服务器上某个 SillyTavern / Luker 的数据（例如 /luker）
重复运行会自动跳过已完成的步骤，可直接用来升级。卸载：sh /opt/stsync/uninstall.sh
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT=$2; shift 2 ;;
        --host) HOST=$2; shift 2 ;;
        --no-tauritavern) TAURITAVERN=0; shift ;;
        --workspace) WORKSPACE=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
done

step() { echo; echo "▶ $*"; }
skip() { echo "  ✓ $*，跳过"; SKIPPED="$SKIPPED
  · $*"; }
fail() { echo "✗ $*" >&2; exit 1; }
ver_ge() { [ "$(printf '%s
%s
' "${2#v}" "${1#v}" | sort -V | head -n1)" = "${2#v}" ]; }
SKIPPED=
CHANGED=0

[ "$(id -u)" = 0 ] || fail "请用 root 运行：在命令最前面加上 sudo"
command -v apt-get >/dev/null 2>&1 || fail "目前只支持 Debian / Ubuntu 系统"
command -v systemctl >/dev/null 2>&1 || fail "需要 systemd（常见的云服务器系统都有）"
case "$PORT" in ''|*[!0-9]*) fail "端口无效：$PORT" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "端口无效：$PORT"
case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64) ARCH=arm64 ;;
    *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

if [ -n "$WORKSPACE" ]; then
    WORKSPACE=$(cd "$WORKSPACE" 2>/dev/null && pwd) || fail "目录不存在：$WORKSPACE"
    [ -f "$WORKSPACE/server.js" ] && [ -d "$WORKSPACE/data" ] || fail "$WORKSPACE 不是 SillyTavern / Luker 的根目录（应包含 server.js 和 data/）"
fi
config_value() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$BASE/config.json" 2>/dev/null | head -n1; }
[ -n "$WORKSPACE" ] || WORKSPACE=$(config_value workspace)
[ -n "$WORKSPACE" ] || WORKSPACE=$BASE/workspace
if [ "$WORKSPACE" = "$BASE/workspace" ]; then
    EXTERNAL=0
    RUN_AS=stsync:stsync
else
    EXTERNAL=1
    RUN_AS=$(stat -c %U:%G "$WORKSPACE/data")
fi
RUN_USER=${RUN_AS%%:*}
RUN_GROUP=${RUN_AS#*:}

step "[1/6] 安装基础工具"
MISSING=
for pair in curl:curl openssl:openssl xz:xz-utils tar:tar sha256sum:coreutils ss:iproute2; do
    command -v "${pair%%:*}" >/dev/null 2>&1 || MISSING="$MISSING ${pair#*:}"
done
[ -f /etc/ssl/certs/ca-certificates.crt ] || MISSING="$MISSING ca-certificates"
if [ -z "$MISSING" ]; then
    skip "基础工具已齐全"
else
    echo "  安装：$MISSING"
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $MISSING >/dev/null 2>&1 || {
        apt-get update -qq >/dev/null
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $MISSING >/dev/null
    } || fail "安装基础工具失败"
fi
[ -n "$HOST" ] || HOST=$(curl -fsS4 --max-time 10 https://api.ipify.org) || fail "无法自动获取公网 IP，请用 --host 指定"
if [ ! -f "$BASE/config.json" ] && ss -Htln "sport = :$PORT" | grep -q .; then
    fail "端口 $PORT 已被占用，请用 --port 换一个"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
SRC=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -z "$SRC" ] || [ ! -f "$SRC/engine/bin/stsync-engine.mjs" ] || [ ! -f "$SRC/server/stsync" ]; then
    step "[2/6] 下载 STSync"
    curl -fsSL "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1 || fail "下载 STSync 失败"
    SRC=$TMP
else
    step "[2/6] 使用本地代码：$SRC"
fi

step "[3/6] 准备 Node.js（需要 ≥ v$MIN_NODE）"
mkdir -p "$OPT"
CUR_NODE=$("$OPT/node/bin/node" --version 2>/dev/null || true)
SYS_NODE=$(command -v node 2>/dev/null || true)
[ -n "$SYS_NODE" ] && SYS_NODE=$(readlink -f "$SYS_NODE")
if [ -n "$CUR_NODE" ] && ver_ge "$CUR_NODE" "$MIN_NODE"; then
    skip "Node.js $CUR_NODE 已就绪"
elif [ -n "$SYS_NODE" ] && case "$SYS_NODE" in /root/*|/home/*|"$OPT"/*) false ;; *) true ;; esac     && ver_ge "$("$SYS_NODE" --version)" "$MIN_NODE"; then
    rm -rf "$OPT/node" && mkdir -p "$OPT/node/bin"
    ln -s "$SYS_NODE" "$OPT/node/bin/node"
    CHANGED=1
    skip "检测到系统 Node.js $("$SYS_NODE" --version)（$SYS_NODE）"
else
    echo "  下载 Node.js $NODE_VERSION"
    T="node-$NODE_VERSION-linux-$ARCH.tar.xz"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$T" -o "$TMP/$T"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/node.sha256"
    (cd "$TMP" && grep " $T\$" node.sha256 | sha256sum -c - >/dev/null) || fail "Node.js 校验失败"
    rm -rf "$OPT/node.new" && mkdir "$OPT/node.new"
    tar -xJf "$TMP/$T" -C "$OPT/node.new" --strip-components=1
    rm -rf "$OPT/node" && mv "$OPT/node.new" "$OPT/node"
    CHANGED=1
fi

step "[4/6] 安装 STSync 同步引擎"
if [ -d "$OPT/engine" ] && diff -rq "$SRC/engine" "$OPT/engine" >/dev/null 2>&1; then
    skip "同步引擎已是最新"
else
    rm -rf "$OPT/engine.new"
    cp -r "$SRC/engine" "$OPT/engine.new"
    rm -rf "$OPT/engine" && mv "$OPT/engine.new" "$OPT/engine"
    CHANGED=1
fi
for f in server/stsync:/usr/local/sbin/stsync uninstall.sh:$OPT/uninstall.sh; do
    if ! cmp -s "$SRC/${f%%:*}" "${f#*:}"; then install -m 0750 "$SRC/${f%%:*}" "${f#*:}"; fi
done
chown -R -h root:root "$OPT" && chmod -R go-w "$OPT"

id stsync >/dev/null 2>&1 || useradd -r -M -d "$BASE" -s /usr/sbin/nologin stsync
install -d -m 0755 "$BASE"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0700 "$BASE/state"
[ "$EXTERNAL" = 1 ] || install -d -o stsync -g stsync -m 0700 "$BASE/workspace"
[ "$EXTERNAL" = 0 ] || [ -d "$WORKSPACE/public/scripts/extensions/third-party" ] \
    || install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0755 "$WORKSPACE/public/scripts/extensions/third-party"
cd "$BASE"
if [ ! -f "$BASE/config.json" ]; then
    CHANGED=1
    "$OPT/node/bin/node" "$OPT/engine/bin/stsync-engine.mjs" --base "$BASE" \
        init --workspace "$WORKSPACE" --url "https://$HOST:$PORT" --listen "0.0.0.0:$PORT" >/dev/null
    FRESH=1
else
    FRESH=0
fi
rc=0
"$OPT/node/bin/node" -e '
    const fs = require("fs"); const [f, ws, runAs, external] = process.argv.slice(1);
    const text = fs.readFileSync(f, "utf8"); const c = JSON.parse(text);
    const moved = c.workspace !== ws;
    c.workspace = ws; c.runAs = runAs; c.trash = external === "1";
    const next = JSON.stringify(c, null, 2);
    if (next !== text) fs.writeFileSync(f, next);
    process.exitCode = moved ? 4 : next !== text ? 3 : 0;' "$BASE/config.json" "$WORKSPACE" "$RUN_AS" "$EXTERNAL" || rc=$?
if [ "$rc" = 4 ]; then
    rm -f "$BASE/state/index.json"
    echo "  云端数据目录改为：$WORKSPACE"
fi
[ "$rc" = 0 ] || CHANGED=1
[ "$EXTERNAL" = 0 ] || echo "  云端数据与 $WORKSPACE 共用，服务以 $RUN_AS 身份运行"

step "[5/6] 安装 TauriTavern 兼容组件"
if [ "$TAURITAVERN" = 1 ]; then
    if [ "$("$OPT/tt-sync/tt-sync" --version 2>/dev/null | sed 's/^tt-sync /v/')" = "$TTSYNC_VERSION" ]; then
        skip "tt-sync 已是 $TTSYNC_VERSION"
    else
        CHANGED=1
        B="tt-sync-linux-$ARCH"
        curl -fsSL "https://github.com/Darkatse/TT-Sync/releases/download/$TTSYNC_VERSION/$B" -o "$TMP/$B"
        curl -fsSL "https://github.com/Darkatse/TT-Sync/releases/download/$TTSYNC_VERSION/SHA256SUMS.txt" -o "$TMP/tt-sync.sha256"
        (cd "$TMP" && grep "$B\$" tt-sync.sha256 | sha256sum -c - >/dev/null) || fail "tt-sync 校验失败"
        install -d -m 0755 "$OPT/tt-sync"
        install -m 0755 "$TMP/$B" "$OPT/tt-sync/tt-sync"
    fi
    install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0700 "$BASE/tauritavern"
    if [ -f "$BASE/tauritavern/config.toml" ]; then
        skip "tt-sync 已初始化"
    else
        CHANGED=1
        chown -R "$RUN_AS" "$BASE/tauritavern"
        runuser -u "$RUN_USER" -- "$OPT/tt-sync/tt-sync" --quiet --state-dir "$BASE/tauritavern" \
            --config-file "$BASE/tauritavern/config.toml" \
            init --path "$WORKSPACE" --layout silly-tavern \
            --public-url "https://$HOST:$PORT" --listen "$TTSYNC_LISTEN" >/dev/null
    fi
    if ! grep -qx "workspace_path = \"$WORKSPACE\"" "$BASE/tauritavern/config.toml"; then
        sed -i "s#^workspace_path = .*#workspace_path = \"$WORKSPACE\"#" "$BASE/tauritavern/config.toml"
        CHANGED=1
    fi
    "$OPT/node/bin/node" -e '
        const fs = require("fs"); const f = process.argv[1];
        const text = fs.readFileSync(f, "utf8"); const c = JSON.parse(text);
        c.tauritavern = { enabled: true, binary: process.argv[2] + "/tt-sync/tt-sync", stateDir: process.argv[3] + "/tauritavern",
            configFile: process.argv[3] + "/tauritavern/config.toml", upstream: "https://" + process.argv[4] };
        const next = JSON.stringify(c, null, 2);
        if (next !== text) { fs.writeFileSync(f, next); process.exitCode = 3; }' "$BASE/config.json" "$OPT" "$BASE" "$TTSYNC_LISTEN" || CHANGED=1
else
    echo "  已跳过（--no-tauritavern）"
fi
chown -R "$RUN_AS" "$BASE/state"
[ ! -d "$BASE/tauritavern" ] || chown -R "$RUN_AS" "$BASE/tauritavern"
[ "$EXTERNAL" = 1 ] || chown -R stsync:stsync "$BASE/workspace"
chown "root:$RUN_GROUP" "$BASE/config.json"
[ ! -f "$BASE/apikey" ] || chown "root:$RUN_GROUP" "$BASE/apikey"
chmod 0640 "$BASE/config.json"

step "[6/6] 启动服务"
if [ "$EXTERNAL" = 1 ]; then
    UMASK=0022
    WS_RW="$WORKSPACE/data $WORKSPACE/public/scripts/extensions/third-party"
else
    UMASK=0077
    WS_RW=$BASE/workspace
fi
sandbox() {
    cat <<EOF
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$BASE
Restart=on-failure
RestartSec=5
UMask=$UMASK
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ProtectProc=invisible
ProcSubset=pid
RemoveIPC=yes
PrivateUsers=yes
DevicePolicy=closed
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @mount @debug @swap @reboot @module @raw-io @obsolete @cpu-emulation
SystemCallErrorNumber=EPERM
LimitNOFILE=8192
EOF
}

{
    cat <<EOF
[Unit]
Description=STSync sync engine
After=network-online.target stsync-tauritavern.service
Wants=network-online.target

[Service]
Environment=NODE_ENV=production
ExecStart=$OPT/node/bin/node $OPT/engine/bin/stsync-engine.mjs --base $BASE serve
ReadWritePaths=$BASE/state $WS_RW$( [ "$TAURITAVERN" = 1 ] && echo " $BASE/tauritavern" )
MemoryMax=2G
TasksMax=256
CPUQuota=200%
EOF
    sandbox
    printf '\n[Install]\nWantedBy=multi-user.target\n'
} > "$TMP/stsync.service"

if [ "$TAURITAVERN" = 1 ]; then
    {
        cat <<EOF
[Unit]
Description=STSync TauriTavern compatibility (official tt-sync, localhost only)
After=network-online.target
Before=stsync.service

[Service]
ExecStart=$OPT/tt-sync/tt-sync --state-dir $BASE/tauritavern --config-file $BASE/tauritavern/config.toml serve
ReadWritePaths=$BASE/tauritavern $WS_RW
MemoryDenyWriteExecute=yes
MemoryMax=1G
TasksMax=128
CPUQuota=100%
EOF
        sandbox
        printf '\n[Install]\nWantedBy=multi-user.target\n'
    } > "$TMP/stsync-tauritavern.service"
fi

UNITS=stsync.service
[ "$TAURITAVERN" = 1 ] && UNITS="stsync-tauritavern.service $UNITS"
for u in $UNITS; do
    if ! cmp -s "$TMP/$u" "/etc/systemd/system/$u"; then
        install -m 0644 "$TMP/$u" "/etc/systemd/system/$u"
        CHANGED=1
    fi
done
for u in $UNITS; do
    systemctl is-enabled -q "$u" 2>/dev/null || { systemctl daemon-reload; systemctl enable "$u" >/dev/null 2>&1; CHANGED=1; }
    systemctl is-active -q "$u" || CHANGED=1
done
if [ "$CHANGED" = 0 ]; then
    skip "服务运行中且没有变化"
else
    systemctl daemon-reload
    for u in $UNITS; do systemctl restart "$u"; done
    sleep 1
    systemctl is-active -q stsync.service || { journalctl -u stsync --no-pager -n 20 >&2; fail "STSync 服务启动失败"; }
    echo "  服务已启动"
fi
/usr/local/sbin/stsync firewall | sed 's/^/  /'

PUBLIC_PORT=$("$OPT/node/bin/node" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).listen.split(":").pop())' "$BASE/config.json")
echo
echo "==================== 安装完成 ===================="
[ "$FRESH" = 0 ] && echo "（这是升级：已保留原来的端口、地址、API Key 和数据）"
[ -n "$SKIPPED" ] && printf '本次跳过的已完成步骤：%s
' "$SKIPPED"
/usr/local/sbin/stsync key
echo
echo "下一步："
echo "  1. 如果云服务器控制台有「安全组 / 防火墙」，放行 TCP 端口 $PUBLIC_PORT"
echo "  2. 在酒馆的扩展页打开 STSync，填入上面的服务器地址和 API Key"
echo "  3. 所有设备都连好后，运行 stsync lock 关闭新设备接入"
echo "以后管理服务器：运行 stsync；重新运行本脚本可升级（已完成的步骤会自动跳过）"
