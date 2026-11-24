// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { SyncError } from './errors.mjs';
import { MAX_SIZE, CHUNKER_ID } from './chunker.mjs';
import { CATEGORIES, resolveScope, validatePath } from './categories.mjs';
import { digestOf } from './workspace.mjs';
import { sha256b64url } from './state.mjs';
import {
    sendJson, readBody, parseJson, pickResponseEncoding, requestEncoding, decodedRequest, encoder,
    ByteReader, SUPPORTED_ENCODINGS,
} from './http-util.mjs';

export const PROTOCOL_VERSION = 1;
const ID_LEN = 43;
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_LIMIT = 64 * 1024 * 1024;
const SMALL_LIMIT = 64 * 1024;
const MAX_IDS = 20_000;
const TIME_WINDOW_MS = 2 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PLAN_IDLE_MS = 30 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const invalid = (message) => new SyncError('InvalidData', message);

function checkPath(p) {
    try {
        return validatePath(p);
    } catch (error) {
        throw invalid(error.message);
    }
}

function idList(value) {
    if (!Array.isArray(value) || value.length > MAX_IDS) throw invalid('chunks 必须是数组，且单次不超过 20000 个');
    for (const id of value) if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalid(`无效的块 ID：${id}`);
    return value;
}

function frameHeader(id, length) {
    const head = Buffer.alloc(4 + ID_LEN);
    head.writeUInt32BE(length, 0);
    head.write(id, 4, 'ascii');
    return head;
}

export function createSync({ state, workspace, identity }) {
    const sessions = new Map();
    const nonces = new Map();
    const plans = new Map();

    const sweep = () => {
        const now = Date.now();
        for (const [k, v] of sessions) if (v.expiresAt <= now) sessions.delete(k);
        for (const [k, v] of nonces) if (v <= now) nonces.delete(k);
        for (const [k, v] of plans) if (v.touchedAt + PLAN_IDLE_MS <= now) plans.delete(k);
    };
    const timer = setInterval(sweep, 60_000);
    timer.unref();

    async function authenticate(req) {
        const value = req.headers.authorization;
        if (typeof value !== 'string' || !value.startsWith('Bearer ')) throw new SyncError('Unauthorized', '缺少会话令牌');
        const session = sessions.get(value.slice(7));
        if (!session || session.expiresAt <= Date.now()) throw new SyncError('Unauthorized', '会话已过期');
        const device = await state.getDevice(session.deviceId);
        if (!device) throw new SyncError('Unauthorized', '设备已被服务器断开');
        return device;
    }

    async function planFor(req, planId, direction) {
        const device = await authenticate(req);
        const plan = plans.get(planId);
        if (!plan) throw new SyncError('NotFound', '同步计划不存在或已过期');
        if (plan.deviceId !== device.id) throw new SyncError('Unauthorized', '同步计划不属于本设备');
        if (direction && plan.direction !== direction) throw invalid(`这不是${direction === 'push' ? '上传' : '下载'}计划`);
        plan.touchedAt = Date.now();
        return { plan, device };
    }

    function normalizeManifest(manifest, scope) {
        if (!Array.isArray(manifest)) throw invalid('manifest 必须是数组');
        const seen = new Map();
        for (const e of manifest) {
            const p = checkPath(e?.path);
            if (!scope.contains(p)) throw invalid(`路径不在所选类别内：${p}`);
            if (seen.has(p)) throw invalid(`清单中有重复路径：${p}`);
            const size = Number(e.size);
            const mtime = Number(e.mtime);
            if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mtime) || mtime < 0 || typeof e.digest !== 'string') {
                throw invalid(`清单条目无效：${p}`);
            }
            seen.set(p, { path: p, size, mtime, digest: e.digest });
        }
        return seen;
    }

    const boundaryOf = (scope, p) => scope.dirs.filter((d) => p.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0] ?? null;
    const deletable = (scope, p) => boundaryOf(scope, p) !== null;

    const routes = {
        async info(req, res) {
            sendJson(res, 200, {
                service: 'stsync',
                protocol: PROTOCOL_VERSION,
                server_id: identity.id,
                server_name: identity.name,
                chunker: CHUNKER_ID,
                max_chunk_bytes: MAX_SIZE,
                encodings: SUPPORTED_ENCODINGS,
                categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
            });
        },

        async pair(req, res) {
            const body = parseJson(await readBody(req, SMALL_LIMIT));
            await state.checkApiToken(body.token);
            const id = String(body.id || '');
            if (!UUID.test(id)) throw invalid('id 必须是 UUID');
            const key = Buffer.from(String(body.key || ''), 'base64url');
            if (key.length !== 32) throw invalid('key 必须是 32 字节的 ed25519 公钥');
            const existing = await state.getDevice(id);
            await state.saveDevice({
                id,
                name: String(body.name || '未命名设备').slice(0, 64),
                key: key.toString('base64url'),
                paired_at: existing?.paired_at ?? Date.now(),
                last_sync_at: existing?.last_sync_at ?? null,
            });
            console.log(`[stsync] 设备已接入：${body.name || id}`);
            sendJson(res, 200, { server_id: identity.id, server_name: identity.name });
        },

        async session(req, res) {
            const h = (name) => {
                const v = req.headers[name];
                if (typeof v !== 'string' || !v) throw invalid(`缺少请求头 ${name}`);
                return v;
            };
            const deviceId = h('x-stsync-device');
            const time = Number(h('x-stsync-time'));
            const nonce = h('x-stsync-nonce');
            const signature = Buffer.from(h('x-stsync-signature'), 'base64url');
            if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw invalid('X-STSync-Nonce 无效');
            const body = await readBody(req, SMALL_LIMIT);
            if (parseJson(body).id !== deviceId) throw new SyncError('Unauthorized', '设备 ID 不一致');
            if (!Number.isSafeInteger(time) || Math.abs(time - Date.now()) > TIME_WINDOW_MS) {
                throw new SyncError('Unauthorized', '本机时间与服务器相差超过 2 分钟，请校准系统时间');
            }
            const device = await state.getDevice(deviceId);
            if (!device) throw new SyncError('Unauthorized', '设备未接入或已被断开，请重新填写 API Key');
            const message = Buffer.from(`STSYNC-SESSION-1\n${deviceId}\n${time}\n${nonce}\n${sha256b64url(body)}`, 'utf8');
            let valid = false;
            try {
                const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(device.key, 'base64url')]), format: 'der', type: 'spki' });
                valid = signature.length === 64 && crypto.verify(null, message, key, signature);
            } catch {
                valid = false;
            }
            if (!valid) throw new SyncError('Unauthorized', '设备签名无效');
            const nonceKey = `${deviceId}|${nonce}`;
            if (nonces.has(nonceKey)) throw new SyncError('Unauthorized', '请求被重放');
            nonces.set(nonceKey, Date.now() + NONCE_TTL_MS);
            const token = crypto.randomBytes(32).toString('base64url');
            const expiresAt = Date.now() + SESSION_TTL_MS;
            sessions.set(token, { deviceId, expiresAt });
            sendJson(res, 200, { token, expires: expiresAt });
        },

        async plan(req, res) {
            const device = await authenticate(req);
            const body = parseJson(await readBody(req, JSON_LIMIT));
            const direction = body.direction;
            const mode = body.mode;
            if (direction !== 'push' && direction !== 'pull') throw invalid('direction 必须是 push 或 pull');
            if (mode !== 'incremental' && mode !== 'mirror') throw invalid('mode 必须是 incremental 或 mirror');
            let scope;
            try {
                scope = resolveScope(body.categories);
            } catch (error) {
                throw invalid(error.message);
            }
            const client = normalizeManifest(body.manifest, scope);
            const server = await workspace.scan(scope, { includeMergeInputs: direction === 'pull' });
            const serverMap = new Map(server.map((e) => [e.path, e]));
            const plan = { id: crypto.randomUUID(), deviceId: device.id, direction, mode, scope, touchedAt: Date.now() };

            if (direction === 'push') {
                plan.upload = new Map([...client.values()].filter((e) => serverMap.get(e.path)?.digest !== e.digest).map((e) => [e.path, e]));
                plan.delete = mode === 'mirror' ? server.filter((e) => !client.has(e.path) && deletable(scope, e.path)).map((e) => e.path) : [];
                plan.assembled = new Set();
                plan.usedStore = new Set();
                plans.set(plan.id, plan);
                const upload = [...plan.upload.values()];
                sendJson(res, 200, {
                    id: plan.id,
                    upload,
                    delete: plan.delete,
                    bytes: upload.reduce((n, e) => n + e.size, 0),
                });
                return;
            }

            const download = [];
            plan.allowed = new Set();
            for (const e of server) {
                const merge = scope.isMergeInput(e.path);
                if (!merge && client.get(e.path)?.digest === e.digest) continue;
                const entry = workspace.entries.get(e.path);
                if (!entry) continue;
                for (const [id] of entry.chunks) plan.allowed.add(id);
                download.push({ ...e, chunks: entry.chunks, ...(merge ? { merge: true } : {}) });
            }
            plan.delete = mode === 'mirror' ? [...client.keys()].filter((p) => !serverMap.has(p) && deletable(scope, p)) : [];
            plans.set(plan.id, plan);
            sendJson(res, 200, {
                id: plan.id,
                download,
                delete: plan.delete,
                bytes: download.reduce((n, e) => n + e.size, 0),
            });
        },

        async missing(req, res, planId) {
            await planFor(req, planId, 'push');
            const ids = idList(parseJson(await readBody(req, JSON_LIMIT)).chunks);
            const missing = [];
            for (const id of new Set(ids)) if (!(await workspace.source(id))) missing.push(id);
            sendJson(res, 200, { missing });
        },

        async chunks(req, res, planId) {
            await planFor(req, planId, 'push');
            const reader = new ByteReader(decodedRequest(req, requestEncoding(req, ['identity', 'zstd', 'br'])));
            let stored = 0;
            for (;;) {
                const length = (await reader.readExact(4, '块数据流')).readUInt32BE(0);
                if (length === 0) break;
                if (length > MAX_SIZE) throw invalid(`数据块过大：${length}`);
                const id = (await reader.readExact(ID_LEN, '块数据流')).toString('ascii');
                if (!ID_PATTERN.test(id)) throw invalid(`无效的块 ID：${id}`);
                if (await workspace.store.write(id, await reader.readExact(length, '块数据流'))) stored += 1;
            }
            await reader.expectEof('块数据流');
            sendJson(res, 200, { stored });
        },

        async assemble(req, res, planId) {
            const { plan } = await planFor(req, planId, 'push');
            const body = parseJson(await readBody(req, JSON_LIMIT));
            if (!Array.isArray(body.files)) throw invalid('files 必须是数组');
            let assembled = 0;
            for (const f of body.files) {
                const p = checkPath(f?.path);
                const meta = plan.upload.get(p);
                if (!meta) throw new SyncError('NotFound', `文件不在上传计划内：${p}`);
                const ids = idList(f.chunks);
                if (digestOf(meta.size, ids) !== meta.digest) throw invalid(`块清单与内容指纹不符：${p}`);
                const sources = [];
                let total = 0;
                for (const id of ids) {
                    const src = await workspace.source(id);
                    if (!src) throw new SyncError('NotFound', `数据块不可用：${id}`);
                    sources.push([id, src]);
                    total += src.length;
                }
                if (total !== meta.size) throw invalid(`拼装大小不符：${p}`);
                const data = Readable.from((async function* () {
                    for (const [id, src] of sources) yield await workspace.readChunk(id, src);
                })());
                await workspace.writeFile(p, data, meta.size, meta.mtime, sources.map(([id, src]) => [id, src.length]));
                for (const [id, src] of sources) if (src.kind === 'store') plan.usedStore.add(id);
                plan.assembled.add(p);
                assembled += 1;
            }
            sendJson(res, 200, { assembled });
        },

        async fetch(req, res, planId) {
            const { plan } = await planFor(req, planId, 'pull');
            const ids = idList(parseJson(await readBody(req, JSON_LIMIT)).chunks);
            const sources = [];
            for (const id of ids) {
                if (!plan.allowed.has(id)) throw new SyncError('Unauthorized', `数据块不在下载计划内：${id}`);
                const src = await workspace.source(id);
                if (!src) throw new SyncError('NotFound', `数据块不可用（云端文件已变化，请重新同步）：${id}`);
                sources.push([id, src]);
            }
            const encoding = pickResponseEncoding(req);
            const stream = Readable.from((async function* () {
                for (const [id, src] of sources) {
                    const data = await workspace.readChunk(id, src);
                    yield frameHeader(id, data.length);
                    yield data;
                }
                yield Buffer.alloc(4);
            })());
            res.writeHead(200, { 'Content-Type': 'application/x-stsync-chunks', ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {}) });
            const enc = encoder(encoding);
            stream.on('error', (error) => res.destroy(error));
            (enc ? stream.pipe(enc) : stream).pipe(res);
        },

        async commit(req, res, planId) {
            const { plan, device } = await planFor(req, planId);
            if (plan.direction === 'push') {
                const pending = [...plan.upload.keys()].filter((p) => !plan.assembled.has(p));
                if (pending.length) throw invalid(`还有 ${pending.length} 个文件未上传完成`);
                for (const p of plan.delete) await workspace.deleteFile(p, boundaryOf(plan.scope, p));
                for (const id of plan.usedStore) await workspace.store.remove(id);
            }
            plans.delete(plan.id);
            await state.touchDevice(device.id);
            sendJson(res, 200, { ok: true, deleted: plan.direction === 'push' ? plan.delete.length : 0 });
        },

        async abort(req, res, planId) {
            const { plan } = await planFor(req, planId);
            plans.delete(plan.id);
            sendJson(res, 200, { ok: true });
        },
    };

    function route(method, pathname) {
        const fixed = {
            '/api/v1/info': ['GET', 'info'],
            '/api/v1/pair': ['POST', 'pair'],
            '/api/v1/session': ['POST', 'session'],
            '/api/v1/sync/plan': ['POST', 'plan'],
        }[pathname];
        if (fixed) return method === fixed[0] ? (req, res) => routes[fixed[1]](req, res) : 405;
        const parts = pathname.split('/');
        if (parts[1] !== 'api' || parts[2] !== 'v1' || parts[3] !== 'plans' || !parts[4]) return 404;
        const planId = decodeURIComponent(parts[4]);
        if (parts.length === 5) return method === 'DELETE' ? (req, res) => routes.abort(req, res, planId) : 405;
        const action = {
            missing: 'POST', chunks: 'PUT', assemble: 'POST', fetch: 'POST', commit: 'POST',
        };
        if (parts.length !== 6 || !action[parts[5]]) return 404;
        return method === action[parts[5]] ? (req, res) => routes[parts[5]](req, res, planId) : 405;
    }

    return { route };
}
