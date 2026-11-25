// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeServerUrl, parseApiKey } from './api.js';

const API_KEY_EXPIRES_AT_MS = 4102444800000;
const EXCLUDED_DATASETS = new Set(['backups']);
const HOST_SYNC_LISTENERS = '/scripts/tauri/setting/setting-panel/sync-listeners.js';

async function invoke(command, args = {}) {
    const safeInvoke = window.__TAURITAVERN__?.invoke?.safeInvoke;
    if (typeof safeInvoke === 'function') {
        return safeInvoke(command, args);
    }
    const internals = window.__TAURI_INTERNALS__;
    if (typeof internals?.invoke === 'function') {
        return internals.invoke(command, args);
    }
    throw new Error('TauriTavern 宿主接口不可用');
}

function buildPairUri(serverUrl, apiKey) {
    const { token, spki } = parseApiKey(apiKey);
    const url = normalizeServerUrl(serverUrl);
    const q = [
        'v=2',
        `url=${encodeURIComponent(url)}`,
        `token=${encodeURIComponent(token)}`,
        `exp=${API_KEY_EXPIRES_AT_MS}`,
        `spki=${encodeURIComponent(spki)}`,
    ].join('&');
    return `tauritavern://tt-sync/pair?${q}`;
}

async function getCatalog() {
    const catalog = await invoke('sync_get_dataset_catalog');
    return {
        policyVersion: Number(catalog?.policy_version),
        supportedDatasetIds: (catalog?.supported_dataset_ids || []).map(String),
    };
}

async function getOverwritePolicy() {
    try {
        const policy = (await invoke('lan_sync_get_status'))?.overwrite_policy;
        if (policy === 'exact' || policy === 'prefer-newer') return policy;
    } catch (error) {
        console.warn('[STSync] 读取覆盖策略失败，使用 exact', error);
    }
    return 'exact';
}

async function listen(event, callback) {
    const api = window.__TAURI__?.event;
    if (typeof api?.listen === 'function') return api.listen(event, callback);
    const internals = window.__TAURI_INTERNALS__;
    if (typeof internals?.transformCallback !== 'function') return null;
    const handler = internals.transformCallback(callback);
    const eventId = await internals.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler });
    return () => internals.invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
}

const PHASE_LABELS = {
    preparing: '准备', scanning: '扫描本地文件', planning: '计算差异', diffing: '计算差异',
    uploading: '上传数据', downloading: '下载数据', transferring: '传输数据', applying: '写入本地',
    committing: '提交', finalizing: '收尾', completed: '完成', done: '完成',
};

const num = (...values) => values.map(Number).find((v) => Number.isFinite(v) && v >= 0) ?? 0;

function toProgress(payload) {
    const p = payload?.progress || payload?.job?.progress || payload || {};
    const raw = String(p.phase ?? payload?.phase ?? '');
    const phase = raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const progress = { phase, label: PHASE_LABELS[phase] || raw, done: 0, total: 0, unit: null, current: p.current_path || null };
    const bytesTotal = num(p.bytes_total, p.total_bytes);
    const filesTotal = num(p.files_total, p.total_files);
    if (bytesTotal > 0) Object.assign(progress, { done: num(p.bytes_done), total: bytesTotal, unit: 'bytes' });
    else if (filesTotal > 0) Object.assign(progress, { done: num(p.files_done), total: filesTotal, unit: 'files' });
    return progress;
}

function fromHostSummary(s) {
    if (!s) return {};
    return { files: s.files_total, bytes: s.bytes_total, deleted: s.files_deleted };
}

export const host = {
    name: 'tauritavern',
    label: 'TauriTavern',

    async checkBackend() {
        try {
            const catalog = await getCatalog();
            return {
                state: 'ok',
                title: '内置同步组件可用',
                detail: `TauriTavern 内置 TT-Sync，可同步 ${catalog.supportedDatasetIds.length} 类数据`,
            };
        } catch (error) {
            return {
                state: 'error',
                title: '内置同步组件不可用',
                detail: `${error?.message || error}。请确认 TauriTavern 是支持 TT-Sync 的版本。`,
            };
        }
    },

    async listServers() {
        const list = await invoke('tt_sync_list_servers');
        if (!Array.isArray(list)) throw new Error('tt_sync_list_servers 返回了非数组');
        return list.map(server => ({
            id: String(server.server_device_id || ''),
            name: String(server.server_device_name || server.server_device_id || ''),
            url: String(server.base_url || ''),
            lastSync: server.last_sync_ms ?? null,
        }));
    },

    async pair(serverUrl, apiKey) {
        const before = await this.listServers();
        const baseUrl = normalizeServerUrl(serverUrl);
        const paired = await invoke('tt_sync_pair', { pairUri: buildPairUri(baseUrl, apiKey) });
        const id = String(paired?.server_device_id || '');
        for (const old of before) {
            if (old.id !== id && old.url === baseUrl) {
                await invoke('tt_sync_remove_server', { serverDeviceId: old.id }).catch(() => {});
            }
        }
        return { id };
    },

    async removeServer(id) {
        await invoke('tt_sync_remove_server', { serverDeviceId: id });
    },

    async sync(direction, id, mode, onProgress) {
        const catalog = await getCatalog();
        const options = {
            selection: {
            policy_version: catalog.policyVersion,
            dataset_ids: catalog.supportedDatasetIds.filter((id) => !EXCLUDED_DATASETS.has(id)),
        },
            overwrite_policy: await getOverwritePolicy(),
            require_bundle_zstd: true,
        };
        const unlisten = await listen('sync:job', (event) => onProgress?.(toProgress(event?.payload))).catch(() => null);
        let report;
        try {
            report = await invoke(direction === 'push' ? 'tt_sync_push' : 'tt_sync_pull', {
                serverDeviceId: id,
                mode,
                options,
            });
        } finally {
            await unlisten?.();
        }
        const result = report?.result || {};
        return {
            status: result.status === 'failed' ? 'failed' : 'completed',
            message: result.message || '',
            summary: fromHostSummary(result.summary),
            report,
        };
    },

    async afterSync(direction, result) {
        if (!result?.report) return;
        try {
            const module = await import(HOST_SYNC_LISTENERS);
            await module.showSyncReportResult(result.report);
        } catch (error) {
            console.warn('[STSync] 宿主结果展示不可用', error);
            if (direction === 'pull' && result.status === 'completed') window.location.reload();
        }
    },
};
