// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeServerUrl, parseApiKey } from './api.js';

const BASE = '/api/plugins/stsync';
const POLL_MS = 700;

const PHASES = {
    connecting: '连接服务器',
    preparing: '准备',
    scanning: '扫描本地文件',
    planning: '计算差异',
    uploading: '上传数据',
    downloading: '下载数据',
    assembling: '拼装文件',
    applying: '写入本地',
    committing: '提交',
    done: '完成',
};

export const SETUP_COMMANDS = [
    { label: '手机 Termux', command: 'curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/st-install.sh | sh' },
    { label: '电脑（在 SillyTavern 文件夹里运行）', command: 'node data/default-user/extensions/stsync/st-plugin/install.mjs' },
];

const extensionVersion = fetch(new URL('./manifest.json', import.meta.url))
    .then((r) => r.json())
    .then((m) => String(m.version || ''))
    .catch(() => '');

function headers() {
    const ctx = window.SillyTavern?.getContext?.();
    const base = typeof ctx?.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {};
    return { ...base, 'Content-Type': 'application/json' };
}

async function call(method, path, body) {
    let response;
    try {
        response = await fetch(BASE + path, {
            method,
            headers: headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (error) {
        throw new Error(`无法连接 SillyTavern 服务端：${error.message}`);
    }
    if (response.status === 404) {
        const error = new Error('还差一步：需要安装 STSync 服务端插件');
        error.code = 'PLUGIN_MISSING';
        throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeJob(job) {
    const phase = job?.phase || '';
    const progress = { phase, label: PHASES[phase] || phase, done: 0, total: 0, unit: null, current: job?.current || null };
    if ((phase === 'uploading' || phase === 'downloading') && job.transferTotal > 0) {
        Object.assign(progress, { done: job.transferDone, total: job.transferTotal, unit: 'bytes' });
    } else if ((phase === 'assembling' || phase === 'applying') && job.filesTotal > 0) {
        Object.assign(progress, { done: job.filesDone, total: job.filesTotal, unit: 'files' });
    }
    return progress;
}

export const host = {
    name: 'sillytavern',
    label: 'SillyTavern',

    async checkBackend() {
        let status;
        try {
            status = await call('GET', '/status');
        } catch (error) {
            if (error.code === 'PLUGIN_MISSING') {
                return {
                    state: 'missing',
                    title: '未检测到服务端插件',
                    detail: '插件没有安装，或 config.yaml 中没有开启 enableServerPlugins。',
                    commands: SETUP_COMMANDS,
                };
            }
            return { state: 'error', title: '服务端插件异常', detail: error.message, commands: SETUP_COMMANDS };
        }
        const plugin = String(status.version || '');
        const ext = await extensionVersion;
        if (ext && plugin !== ext) {
            return {
                state: 'outdated',
                title: '服务端插件版本过旧',
                detail: `服务端插件 v${plugin || '未知'}，扩展 v${ext}。刚更新过扩展的话重启 SillyTavern 即可；否则运行下面的命令。`,
                commands: SETUP_COMMANDS,
            };
        }
        return { state: 'ok', title: '服务端插件正常', detail: `SillyTavern 服务端插件 v${plugin}` };
    },

    async listServers() {
        return (await call('GET', '/status')).servers || [];
    },

    async pair(serverUrl, apiKey) {
        const { text } = parseApiKey(apiKey);
        const data = await call('POST', '/pair', { serverUrl: normalizeServerUrl(serverUrl), apiKey: text });
        return { id: data.server.id };
    },

    async removeServer(id) {
        await call('POST', '/unpair', { id });
    },

    async sync(direction, id, mode, onProgress) {
        const started = await call('POST', '/sync', { direction, id, mode });
        const jobId = started.job?.id;
        for (;;) {
            await sleep(POLL_MS);
            const { job } = await call('GET', '/job');
            if (!job || job.id !== jobId) throw new Error('同步作业状态丢失');
            onProgress?.(describeJob(job));
            if (job.status !== 'running') {
                return { status: job.status, message: job.message, summary: job.summary || {}, warnings: job.warnings || [] };
            }
        }
    },

    async afterSync(direction, result) {
        if (direction === 'pull' && result?.status === 'completed') {
            window.toastr?.info?.('下载完成，即将刷新页面以载入新数据', 'STSync');
            setTimeout(() => window.location.reload(), 1500);
        }
    },
};
