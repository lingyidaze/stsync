#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ServerState, writeJsonAtomic } from '../lib/state.mjs';
import { createServer } from '../lib/server.mjs';
import { createBridge } from '../lib/bridge.mjs';

const CONFIG_KEYS = new Set(['listen', 'url', 'workspace']);
const USAGE = `用法：stsync-engine <命令> [--base <目录>]
  serve                            启动同步服务
  init --workspace <目录> --url https://主机:端口 [--listen 0.0.0.0:8443]
  status [--json]                  服务器标识、地址、证书指纹、设备数
  cert                             打印证书 SPKI 指纹
  devices [--json]                 已接入设备
  revoke <设备ID或名称>             断开设备
  config get <键> | set <键> <值>   读写 config.json（listen / url / workspace）`;


function parseArgs(argv) {
    const positional = [];
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) options[arg.slice(2)] = true;
            else {
                options[arg.slice(2)] = next;
                i += 1;
            }
        } else {
            positional.push(arg);
        }
    }
    return { positional, options };
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

function validateUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        fail(`对外地址无效：${value}`);
    }
    if (url.protocol !== 'https:' || (url.pathname && url.pathname !== '/') || url.search || url.username) {
        fail(`对外地址必须是 https://主机[:端口]，不带路径：${value}`);
    }
    return `${url.protocol}//${url.host}`;
}

async function cmdInit(state, options) {
    if (fs.existsSync(state.configFile)) fail(`已存在 ${state.configFile}，拒绝覆盖`);
    if (!options.workspace || !options.url) fail('用法：init --workspace <目录> --url https://主机:端口');
    await fsp.mkdir(path.join(state.stateDir, 'tls'), { recursive: true, mode: 0o700 });
    await fsp.mkdir(options.workspace, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(state.identityFile)) {
        await writeJsonAtomic(state.identityFile, { id: crypto.randomUUID(), name: 'STSync' });
    }
    if (!fs.existsSync(state.certFile)) {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
            '-keyout', state.keyFile, '-out', state.certFile, '-days', '36500',
            '-subj', '/CN=stsync', '-addext', 'subjectAltName=DNS:stsync,DNS:localhost',
        ], { stdio: 'ignore' });
        await fsp.chmod(state.keyFile, 0o600);
    }
    await writeJsonAtomic(state.configFile, {
        listen: options.listen || '0.0.0.0:8443',
        url: validateUrl(options.url),
        workspace: path.resolve(options.workspace),
        tauritavern: { enabled: false },
    }, 0o640);
    console.log(`已初始化：${state.baseDir}`);
    console.log(`证书指纹：${(await state.tls()).spki}`);
}

async function cmdServe(state) {
    const config = await state.config();
    const server = await createServer(state, config);
    const address = await server.listen();
    console.log(`[stsync] STSync 同步引擎已启动：${address.address}:${address.port}（对外 ${config.url}）`);
    console.log(`[stsync] 工作区 ${config.workspace}，证书指纹 ${server.spki}，TauriTavern 兼容：${server.tauritavern ? '已启用' : '未启用'}`);
    const shutdown = () => server.close().then(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

async function tauriPeers(config, state) {
    if (!config.tauritavern?.enabled) return [];
    try {
        const bridge = await createBridge(config.tauritavern, state);
        const peers = await bridge.peers();
        bridge.close();
        return peers.map((p) => ({
            id: p.device_id, name: p.device_name, kind: 'TauriTavern',
            paired_at: p.paired_at_ms ?? null, last_sync_at: p.last_sync_ms ?? null,
        }));
    } catch (error) {
        console.error(`（读取 TauriTavern 设备失败：${error.message}）`);
        return [];
    }
}

async function allDevices(state) {
    const config = await state.config();
    const own = (await state.listDevices()).map((d) => ({ id: d.id, name: d.name, kind: 'SillyTavern', paired_at: d.paired_at, last_sync_at: d.last_sync_at }));
    return [...own, ...(await tauriPeers(config, state))];
}

async function cmdStatus(state, options) {
    const [config, identity, tls, devices] = await Promise.all([state.config(), state.identity(), state.tls(), allDevices(state)]);
    const info = {
        id: identity.id,
        name: identity.name,
        url: config.url,
        listen: config.listen,
        workspace: config.workspace,
        spki: tls.spki,
        devices: devices.length,
        tauritavern: Boolean(config.tauritavern?.enabled),
        pairing_locked: state.pairingLocked(),
    };
    if (options.json) console.log(JSON.stringify(info, null, 2));
    else for (const [k, v] of Object.entries(info)) console.log(`${k}: ${v}`);
}

async function cmdDevices(state, options) {
    const devices = await allDevices(state);
    if (options.json) {
        console.log(JSON.stringify(devices, null, 2));
        return;
    }
    if (!devices.length) {
        console.log('（没有已接入的设备）');
        return;
    }
    const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '从未');
    for (const d of devices) {
        console.log(`[${d.kind}] ${d.name || '(未命名)'}  ${d.id}`);
        console.log(`    接入 ${fmt(d.paired_at)}   上次同步 ${fmt(d.last_sync_at)}`);
    }
}

async function cmdRevoke(state, target) {
    if (!target) fail('用法：revoke <设备ID或名称>');
    const removed = await state.removeDevice(target);
    if (removed) {
        console.log(`已断开 SillyTavern 设备：${removed.name}（${removed.id}）`);
        return;
    }
    const config = await state.config();
    if (config.tauritavern?.enabled) {
        const bridge = await createBridge(config.tauritavern, state);
        try {
            await bridge.revoke(target);
            console.log(`已断开 TauriTavern 设备：${target}`);
            return;
        } catch (error) {
            fail(`未找到设备：${target}（${error.message}）`);
        } finally {
            bridge.close();
        }
    }
    fail(`未找到设备：${target}`);
}

async function cmdConfig(state, [action, key, value]) {
    const config = await state.config();
    if (action === 'get' && CONFIG_KEYS.has(key)) {
        console.log(config[key] ?? '');
        return;
    }
    if (action === 'set' && CONFIG_KEYS.has(key) && value !== undefined) {
        config[key] = key === 'url' ? validateUrl(value) : value;
        await writeJsonAtomic(state.configFile, config, 0o640);
        console.log(`${key} = ${config[key]}`);
        return;
    }
    fail('用法：config get <键> | config set <键> <值>（键：listen / url / workspace）');
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const state = new ServerState(options.base || process.env.STSYNC_BASE || '/srv/stsync');
    const [command, ...rest] = positional;
    switch (command) {
        case 'serve': return cmdServe(state);
        case 'init': return cmdInit(state, options);
        case 'status': return cmdStatus(state, options);
        case 'cert': return console.log((await state.tls()).spki);
        case 'devices': return cmdDevices(state, options);
        case 'revoke': return cmdRevoke(state, rest[0]);
        case 'config': return cmdConfig(state, rest);
        default:
            console.log(USAGE);
            if (command && command !== 'help') process.exit(2);
    }
}

main().catch((error) => fail(error?.message || String(error)));
