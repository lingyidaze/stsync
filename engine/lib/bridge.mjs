// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import https from 'node:https';
import tls from 'node:tls';

import { SyncError, toSyncError } from './errors.mjs';
import { sendJson, sendError } from './http-util.mjs';
import { spkiOfCertPem } from './state.mjs';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

class PinnedAgent extends https.Agent {
    constructor(spki) {
        super({ keepAlive: true, maxSockets: 16 });
        this.spki = spki;
    }

    createConnection(options, callback) {
        const socket = tls.connect({ host: options.host, port: options.port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
        let settled = false;
        const done = (error) => {
            if (settled) return;
            settled = true;
            if (error) {
                socket.destroy();
                callback(error);
            } else {
                callback(null, socket);
            }
        };
        socket.once('secureConnect', () => {
            try {
                const cert = socket.getPeerCertificate(false);
                const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64')}\n-----END CERTIFICATE-----\n`;
                done(spkiOfCertPem(pem) === this.spki ? null : new Error('本机 tt-sync 证书指纹不符'));
            } catch (error) {
                done(error);
            }
        });
        socket.once('error', done);
        return undefined;
    }
}

function run(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 15_000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(String(stderr || error.message).trim()));
            else resolve(String(stdout));
        });
    });
}

export async function createBridge(cfg, state) {
    const upstream = new URL(cfg.upstream);
    const certPem = await fsp.readFile(`${cfg.stateDir}/tls/cert.pem`, 'utf8');
    const agent = new PinnedAgent(spkiOfCertPem(certPem));
    const cli = ['--quiet', '--no-color', '--state-dir', cfg.stateDir, '--config-file', cfg.configFile];

    async function mintPairToken() {
        const uri = (await run(cfg.binary, [...cli, 'pair', 'open', '--rw', '--mirror', '--expires', '2m'])).trim();
        const token = new URL(uri.replace(/^tauritavern:/, 'https:')).searchParams.get('token');
        if (!token) throw new SyncError('Internal', 'tt-sync 没有返回配对令牌');
        return token;
    }

    function forward(req, res, pathAndQuery) {
        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name)) headers[name] = value;
        headers.host = upstream.host;
        const outbound = https.request({
            hostname: upstream.hostname,
            port: upstream.port,
            method: req.method,
            path: pathAndQuery,
            headers,
            agent,
        }, (upstreamRes) => {
            const out = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_HEADERS.has(name)) out[name] = value;
            res.writeHead(upstreamRes.statusCode || 502, out);
            upstreamRes.pipe(res);
            upstreamRes.on('error', (error) => res.destroy(error));
        });
        outbound.on('error', (error) => {
            if (!res.headersSent) sendJson(res, 502, { ok: false, error: `TauriTavern 同步服务不可用：${error.message}` });
            else res.destroy(error);
        });
        outbound.setTimeout(5 * 60_000, () => outbound.destroy(new Error('上游响应超时')));
        req.on('error', (error) => outbound.destroy(error));
        req.pipe(outbound);
    }

    return {
        async handle(req, res, url) {
            try {
                if (url.pathname === '/v2/pair/complete' && req.method === 'POST') {
                    try {
                        await state.checkApiToken(url.searchParams.get('token') || '');
                    } catch (error) {
                        req.resume();
                        sendJson(res, 401, { ok: false, error: error.message });
                        return;
                    }
                    const token = await mintPairToken();
                    console.log('[stsync] TauriTavern 设备正在接入');
                    forward(req, res, `/v2/pair/complete?token=${encodeURIComponent(token)}`);
                    return;
                }
                forward(req, res, req.url);
            } catch (error) {
                req.resume();
                sendError(res, toSyncError(error));
            }
        },

        async peers() {
            return JSON.parse(await run(cfg.binary, [...cli, 'peers', 'list', '--json']));
        },

        async revoke(idOrName) {
            return run(cfg.binary, [...cli, 'peers', 'revoke', idOrName]);
        },

        close: () => agent.destroy(),
    };
}
