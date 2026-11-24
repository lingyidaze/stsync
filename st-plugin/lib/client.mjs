// SPDX-License-Identifier: AGPL-3.0-only
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';

const REQUEST_TIMEOUT_MS = 120_000;
const SESSION_RENEW_MARGIN_MS = 60_000;

export const sha256b64url = (data) => crypto.createHash('sha256').update(data).digest('base64url');

export function spkiOfCertificate(rawDer) {
    const cert = new crypto.X509Certificate(rawDer);
    return sha256b64url(cert.publicKey.export({ type: 'spki', format: 'der' }));
}

export class SyncHttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

class PinnedAgent extends https.Agent {
    constructor(spki) {
        super({ keepAlive: true, maxSockets: 4 });
        this.spki = spki;
    }

    createConnection(options, callback) {
        const servername = net.isIP(options.host) ? undefined : (options.servername || options.host);
        const socket = tls.connect({
            host: options.host,
            port: options.port,
            servername,
            ALPNProtocols: ['http/1.1'],
            rejectUnauthorized: false,
        });
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
                if (!cert?.raw) return done(new Error('服务器没有提供 TLS 证书'));
                if (spkiOfCertificate(cert.raw) !== this.spki) {
                    return done(new Error('服务器证书指纹与 API Key 不匹配，已拒绝连接（可能遭到中间人攻击，或服务器证书已更换）'));
                }
                done(null);
            } catch (error) {
                done(error);
            }
        });
        socket.once('error', (error) => done(error));
        return undefined;
    }
}

export function createTransport(baseUrl, spki) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:') throw new Error('服务器地址必须使用 https://');
    const agent = new PinnedAgent(spki);

    function request(method, pathAndQuery, { headers = {}, body, contentLength, stream = false } = {}) {
        return new Promise((resolve, reject) => {
            const finalHeaders = { ...headers };
            let payload = typeof body === 'string' ? Buffer.from(body) : body;
            if (Buffer.isBuffer(payload)) finalHeaders['Content-Length'] = String(payload.length);
            else if (payload && contentLength !== undefined) finalHeaders['Content-Length'] = String(contentLength);
            else if (!payload && method !== 'GET') finalHeaders['Content-Length'] = '0';

            const req = https.request({
                protocol: 'https:',
                hostname: base.hostname.replace(/^\[|\]$/g, ''),
                port: base.port || 443,
                method,
                path: pathAndQuery,
                headers: finalHeaders,
                agent,
                timeout: REQUEST_TIMEOUT_MS,
            }, (res) => {
                const status = res.statusCode || 0;
                if (stream && status >= 200 && status < 300) {
                    resolve({ status, headers: res.headers, stream: res });
                    return;
                }
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('请求服务器超时')));
            req.on('error', reject);
            if (payload && typeof payload.pipe === 'function') {
                payload.on('error', (error) => req.destroy(error));
                payload.pipe(req);
            } else {
                req.end(payload);
            }
        });
    }

    return { request, close: () => agent.destroy(), baseUrl: `${base.protocol}//${base.host}` };
}

export function errorFromResponse(response, fallback) {
    let detail = '';
    try {
        const parsed = JSON.parse(response.body.toString('utf8'));
        detail = parsed?.error || parsed?.message || '';
    } catch {
        detail = (response.body || Buffer.alloc(0)).toString('utf8').slice(0, 200);
    }
    return new SyncHttpError(response.status, `${fallback}（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
}

function parseJson(response, what) {
    try {
        return JSON.parse(response.body.toString('utf8'));
    } catch {
        throw new Error(`${what}：服务器返回了无法解析的数据`);
    }
}

async function postJson(transport, path, payload, what, headers = {}) {
    const response = await transport.request('POST', path, {
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
    });
    return response;
}

export async function serverInfo(transport) {
    const response = await transport.request('GET', '/api/v1/info');
    if (response.status !== 200) throw errorFromResponse(response, '连接的不是 STSync 服务器');
    const info = parseJson(response, '读取服务器信息失败');
    if (info.service !== 'stsync') throw new Error('连接的不是 STSync 服务器');
    return info;
}

export async function pairDevice(transport, token, identity) {
    const response = await postJson(transport, '/api/v1/pair', {
        token,
        id: identity.id,
        name: identity.name,
        key: identity.publicKey,
    }, '接入失败');
    if (response.status === 401) throw errorFromResponse(response, '接入被拒绝');
    if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, '接入失败');
    return parseJson(response, '接入失败');
}

export class SyncSession {
    constructor(transport, identity) {
        this.transport = transport;
        this.identity = identity;
        this.privateKey = crypto.createPrivateKey(identity.privateKey);
        this.token = null;
        this.expiresAt = 0;
    }

    async open() {
        const body = Buffer.from(JSON.stringify({ id: this.identity.id }));
        const time = Date.now();
        const nonce = crypto.randomBytes(16).toString('base64url');
        const message = `STSYNC-SESSION-1\n${this.identity.id}\n${time}\n${nonce}\n${sha256b64url(body)}`;
        const signature = crypto.sign(null, Buffer.from(message, 'utf8'), this.privateKey).toString('base64url');
        const response = await this.transport.request('POST', '/api/v1/session', {
            headers: {
                'Content-Type': 'application/json',
                'X-STSync-Device': this.identity.id,
                'X-STSync-Time': String(time),
                'X-STSync-Nonce': nonce,
                'X-STSync-Signature': signature,
            },
            body,
        });
        if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, '服务器拒绝了本设备');
        const data = parseJson(response, '打开会话失败');
        this.token = data.token;
        this.expiresAt = Number(data.expires) || Date.now() + 10 * 60_000;
        return data;
    }

    async ensure() {
        if (!this.token || Date.now() > this.expiresAt - SESSION_RENEW_MARGIN_MS) await this.open();
    }

    async raw(method, path, options = {}, { retry = true } = {}) {
        await this.ensure();
        const headers = { ...(options.headers || {}), Authorization: `Bearer ${this.token}` };
        const response = await this.transport.request(method, path, { ...options, headers });
        const replayable = !options.stream && !(options.body && typeof options.body.pipe === 'function');
        if (response.status === 401 && retry && replayable) {
            this.token = null;
            return this.raw(method, path, options, { retry: false });
        }
        return response;
    }

    async json(method, path, payload, what) {
        const response = await this.raw(method, path, {
            headers: { 'Content-Type': 'application/json' },
            body: payload === undefined ? undefined : JSON.stringify(payload),
        });
        if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, what);
        return response.body.length ? parseJson(response, what) : {};
    }

    close() {
        this.transport.close();
    }
}
