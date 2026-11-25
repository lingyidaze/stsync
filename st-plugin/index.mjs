// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { createTransport, pairDevice, serverInfo, SyncSession } from './lib/client.mjs';
import { UserState } from './lib/state.mjs';
import { runPush, runPull } from './lib/jobs.mjs';

const VERSION = '1.1.1';
const B64URL = /^[A-Za-z0-9_-]+$/;
const MODES = new Set(['Incremental', 'Mirror']);

export const info = {
    id: 'stsync',
    name: 'STSync',
    description: 'SillyTavern / Luker 云端同步：把数据上传/下载到 STSync 服务器（可与 TauriTavern 共用）',
};

const jobs = new Map();

function readHostInfo() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        return { name: String(pkg.name || ''), version: String(pkg.version || '') };
    } catch {
        return { name: '', version: '' };
    }
}

const hostInfo = readHostInfo();

function userContext(request) {
    const handle = request.user?.profile?.handle || 'default-user';
    const dataRoot = path.resolve(globalThis.DATA_ROOT || './data');
    const userRoot = path.resolve(request.user?.directories?.root || path.join(dataRoot, handle));
    const stateRoot = path.join(dataRoot, '_stsync', handle);
    return {
        handle,
        dataRoot,
        userRoot,
        stateRoot,
        globalExtensions: path.resolve(process.cwd(), 'public', 'scripts', 'extensions', 'third-party'),
        state: new UserState(stateRoot),
    };
}

function normalizeServerUrl(raw) {
    let url;
    try {
        url = new URL(String(raw || '').trim());
    } catch {
        throw new Error('服务器地址格式不正确，例如 https://1.2.3.4:8443');
    }
    if (url.protocol !== 'https:') throw new Error('服务器地址必须使用 https://');
    if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
        throw new Error('服务器地址只能包含协议、主机和端口');
    }
    return `${url.protocol}//${url.host}`;
}

function parseApiKey(raw) {
    const parts = String(raw || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'sts1') {
        throw new Error('API Key 格式不正确（应以 sts1. 开头，在服务器上运行 stsync key 查看）');
    }
    const [, token, spki] = parts;
    if (!B64URL.test(token) || token.length > 128 || !B64URL.test(spki)) {
        throw new Error('API Key 包含非法字符');
    }
    return { token, spki };
}

const publicServer = (s) => ({ id: s.id, name: s.name, url: s.url, lastSync: s.lastSync ?? null });

const publicJob = (job) => job && ({
    id: job.id,
    direction: job.direction,
    mode: job.mode,
    status: job.status,
    phase: job.phase,
    filesDone: job.filesDone,
    filesTotal: job.filesTotal,
    bytesDone: job.bytesDone,
    bytesTotal: job.bytesTotal,
    bytesSent: job.bytesSent,
    transferDone: job.transferDone,
    transferTotal: job.transferTotal,
    current: job.current,
    message: job.message,
    summary: job.summary,
    warnings: job.warnings,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
});

const handler = (fn) => async (request, response) => {
    try {
        response.json(await fn(request, response));
    } catch (error) {
        console.error('[STSync]', error);
        response.status(400).json({ error: error?.message || String(error) });
    }
};

export async function init(router) {
    router.use(express.json({ limit: '64kb' }));

    router.get('/status', handler(async (request) => {
        const ctx = userContext(request);
        return {
            ok: true,
            version: VERSION,
            host: hostInfo,
            servers: (await ctx.state.servers()).map(publicServer),
            job: publicJob(jobs.get(ctx.handle)),
        };
    }));

    router.post('/pair', handler(async (request) => {
        const ctx = userContext(request);
        const baseUrl = normalizeServerUrl(request.body?.serverUrl);
        const { token, spki } = parseApiKey(request.body?.apiKey);
        const identity = await ctx.state.identity();
        const transport = createTransport(baseUrl, spki);
        try {
            await serverInfo(transport);
            const result = await pairDevice(transport, token, identity);
            const record = {
                id: String(result.server_id || ''),
                name: String(result.server_name || 'STSync'),
                url: baseUrl,
                spki,
                pairedAt: Date.now(),
                lastSync: null,
            };
            if (!record.id) throw new Error('服务器没有返回设备 ID');
            for (const old of await ctx.state.servers()) {
                if (old.url === baseUrl && old.id !== record.id) {
                    await ctx.state.removeServer(old.id);
                }
            }
            await ctx.state.upsertServer(record);
            return { ok: true, server: publicServer(record) };
        } finally {
            transport.close();
        }
    }));

    router.post('/unpair', handler(async (request) => {
        const ctx = userContext(request);
        await ctx.state.removeServer(String(request.body?.id || ''));
        return { ok: true };
    }));

    router.get('/job', handler(async (request) => ({ job: publicJob(jobs.get(userContext(request).handle)) })));

    router.post('/sync', handler(async (request) => {
        const ctx = userContext(request);
        const direction = request.body?.direction;
        const mode = request.body?.mode;
        if (direction !== 'push' && direction !== 'pull') throw new Error('direction 必须是 push 或 pull');
        if (!MODES.has(mode)) throw new Error('mode 必须是 Incremental 或 Mirror');
        const force = request.body?.force === true;

        const running = jobs.get(ctx.handle);
        if (running?.status === 'running') throw new Error('已有同步正在进行，请等待完成');

        const server = await ctx.state.server(String(request.body?.id || ''));
        if (!server) throw new Error('未找到该服务器，请重新连接');

        const job = {
            id: `${Date.now().toString(36)}`,
            direction,
            mode,
            status: 'running',
            phase: 'connecting',
            filesDone: 0,
            filesTotal: 0,
            bytesDone: 0,
            bytesTotal: 0,
            bytesSent: 0,
            transferDone: 0,
            transferTotal: 0,
            current: null,
            message: '',
            summary: null,
            warnings: [],
            startedAt: Date.now(),
            finishedAt: null,
        };
        jobs.set(ctx.handle, job);

        (async () => {
            let session = null;
            try {
                const identity = await ctx.state.identity();
                session = new SyncSession(createTransport(server.url, server.spki), identity);
                const info = await serverInfo(session.transport);
                await session.open();
                const options = { info, serverId: server.id, force };
                const syncMode = mode === 'Mirror' ? 'mirror' : 'incremental';
                job.summary = direction === 'push'
                    ? await runPush(session, ctx, syncMode, job, options)
                    : await runPull(session, ctx, syncMode, job, options);
                job.status = 'completed';
                job.phase = 'done';
                await ctx.state.touchServer(server.id, { lastSync: Date.now() });
            } catch (error) {
                console.error('[STSync] 同步失败', error);
                job.status = 'failed';
                job.message = error?.message || String(error);
            } finally {
                job.finishedAt = Date.now();
                job.current = null;
                session?.close();
            }
        })();

        return { ok: true, job: publicJob(job) };
    }));

    console.log('[STSync] 服务端插件已加载');
}

export async function exit() {
    jobs.clear();
}

export default { info, init, exit };
