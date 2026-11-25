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

const KNOWN_HOSTS = { sillytavern: 'SillyTavern', luker: 'Luker' };

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
        const hostName = String(status.host?.name || '');
        const hostVersion = status.host?.version ? ` ${status.host.version}` : '';
        const known = KNOWN_HOSTS[hostName.toLowerCase()];
        if (!known) {
            return {
                state: 'unknown',
                title: `未识别的酒馆：${hostName || '未知'}${hostVersion}`,
                detail: 'STSync 只在 SillyTavern、Luker 和 TauriTavern 上验证过。这个酒馆的数据结构可能不同，'
                    + '同步前请先备份数据，并先用「增量」模式小范围试用，确认无误后再正常使用；尽量不要使用「镜像」模式。',
            };
        }
        return { state: 'ok', title: '服务端插件正常', detail: `${known}${hostVersion} · 服务端插件 v${plugin}` };
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

    async sync(direction, id, mode, onProgress, { force = false } = {}) {
        const started = await call('POST', '/sync', { direction, id, mode, force });
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
        const s = result?.summary || {};
        const changed = s.files > 0 || s.deleted > 0;
        const skipped = Array.isArray(s.skipped) && s.skipped.length > 0;
        if (direction === 'pull' && result?.status === 'completed' && changed && !skipped) {
            window.toastr?.info?.('下载完成，即将刷新页面以载入新数据', 'STSync');
            setTimeout(() => window.location.reload(), 1500);
        }
    },
};
