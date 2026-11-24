// SPDX-License-Identifier: AGPL-3.0-only
import https from 'node:https';

import { SyncError } from './errors.mjs';
import { sendError } from './http-util.mjs';
import { Workspace } from './workspace.mjs';
import { createSync } from './sync.mjs';
import { createBridge } from './bridge.mjs';

export function splitListen(listen) {
    const text = String(listen || '0.0.0.0:8443');
    const index = text.lastIndexOf(':');
    if (index < 0) throw new SyncError('InvalidData', `监听地址无效：${text}`);
    return [text.slice(0, index).replace(/^\[|\]$/g, '') || '0.0.0.0', Number(text.slice(index + 1))];
}

export async function createServer(state, config) {
    const identity = await state.identity();
    const tlsMaterial = await state.tls();
    const workspace = new Workspace(config.workspace, state.stateDir);
    await workspace.load();
    const sync = createSync({ state, workspace, identity });

    let bridge = null;
    if (config.tauritavern?.enabled) {
        try {
            bridge = await createBridge(config.tauritavern, state);
        } catch (error) {
            console.warn(`[stsync] TauriTavern 兼容未启用：${error.message}`);
        }
    }

    const log = process.env.STSYNC_LOG_REQUESTS;
    const server = https.createServer({
        key: tlsMaterial.key,
        cert: tlsMaterial.cert,
        minVersion: 'TLSv1.3',
        ALPNProtocols: ['http/1.1'],
        requestTimeout: 0,
        headersTimeout: 60_000,
        keepAliveTimeout: 30_000,
    }, async (req, res) => {
        const started = Date.now();
        let url;
        try {
            url = new URL(req.url, 'https://stsync.invalid');
            if (url.pathname.startsWith('/v2/')) {
                if (!bridge) {
                    req.resume();
                    res.writeHead(404).end();
                    return;
                }
                await bridge.handle(req, res, url);
                return;
            }
            const handler = sync.route(req.method, url.pathname);
            if (typeof handler !== 'function') {
                req.resume();
                res.writeHead(handler).end();
                return;
            }
            await handler(req, res);
        } catch (error) {
            req.resume();
            sendError(res, error);
        } finally {
            if (log) res.once('finish', () => console.log(`[stsync] ${req.method} ${url?.pathname ?? '?'} ${res.statusCode} ${Date.now() - started}ms`));
        }
    });

    const [host, port] = splitListen(config.listen);
    return {
        identity,
        spki: tlsMaterial.spki,
        tauritavern: Boolean(bridge),
        bridge,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => resolve(server.address()));
        }),
        close: () => new Promise((resolve) => {
            bridge?.close();
            server.close(() => resolve());
        }),
    };
}
