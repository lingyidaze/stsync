// SPDX-License-Identifier: AGPL-3.0-only
export const MODES = Object.freeze({ INCREMENTAL: 'Incremental', MIRROR: 'Mirror' });

const B64URL = /^[A-Za-z0-9_-]+$/;

export function normalizeServerUrl(raw) {
    const text = String(raw || '').trim();
    let url;
    try {
        url = new URL(text);
    } catch {
        throw new Error('服务器地址格式不正确，例如 https://1.2.3.4:8443');
    }
    if (url.protocol !== 'https:') {
        throw new Error('服务器地址必须使用 https://');
    }
    if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
        throw new Error('服务器地址只能包含协议、主机和端口');
    }
    return `${url.protocol}//${url.host}`;
}

export function parseApiKey(apiKey) {
    const text = String(apiKey || '').trim();
    if (!text) {
        throw new Error('请填写 API Key');
    }
    const parts = text.split('.');
    if (parts.length !== 3 || parts[0] !== 'sts1') {
        throw new Error('API Key 格式不正确（应以 sts1. 开头，在服务器上运行 stsync key 查看）');
    }
    const [, token, spki] = parts;
    if (!B64URL.test(token) || token.length > 128 || !B64URL.test(spki)) {
        throw new Error('API Key 包含非法字符');
    }
    return { token, spki, text };
}

export function isTauriTavern() {
    return Boolean(window.__TAURITAVERN__);
}

export async function loadHost() {
    if (isTauriTavern()) {
        await window.__TAURITAVERN__.ready;
        return (await import('./host-tauri.js')).host;
    }
    return (await import('./host-st.js')).host;
}
