// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { errorFromResponse } from './client.mjs';
import { DEFAULT_CATEGORY_IDS, resolveScope } from './categories.mjs';
import { MAX_SIZE, chunkId } from './chunker.mjs';
import {
    LocalIndex, scanLocal, resolveLocal, readLocalChunk, publishFile, removeFileAndPrune, readLocalSettings, digestOf,
} from './local.mjs';
import { applyDownloadedSections, splitSettings } from './settings-sections.mjs';

const ID_LEN = 43;
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BATCH_BYTES = 16 * 1024 * 1024;
const BATCH_IDS = 5000;
const ASSEMBLE_FILES = 100;
const SETTINGS_PATH = 'data/default-user/settings.json';
const SECTION_NAMES = {
    'data/default-user/settings/appearance.json': 'appearance',
    'data/default-user/settings/presets.json': 'presets',
    'data/default-user/settings/layout.json': 'layout',
    'data/default-user/settings/persona-state.json': 'persona_state',
};
const HAS_ZSTD = typeof zlib.createZstdCompress === 'function';
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SyncBase {
    constructor(ctx, serverId) {
        this.file = serverId ? path.join(ctx.stateRoot, 'base', `${serverId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) : null;
        this.map = new Map();
    }

    async load() {
        if (!this.file) return this;
        try {
            this.map = new Map(Object.entries(JSON.parse(await fsp.readFile(this.file, 'utf8'))));
        } catch {
        }
        return this;
    }

    get(p) {
        return this.file ? (this.map.get(p) ?? null) : undefined;
    }

    async save() {
        if (!this.file) return;
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.stsync.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map)));
        await fsp.rename(tmp, this.file);
    }
}

class LocalTrash {
    constructor(ctx) {
        this.root = path.join(ctx.stateRoot, 'trash');
        const pad = (n) => String(n).padStart(2, '0');
        const d = new Date();
        this.batch = path.join(this.root, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
        this.count = 0;
    }

    async gc() {
        const cutoff = Date.now() - TRASH_TTL_MS;
        for (const name of await fsp.readdir(this.root).catch(() => [])) {
            const dir = path.join(this.root, name);
            const st = await fsp.stat(dir).catch(() => null);
            if (st && st.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
        }
    }

    async keep(p, full) {
        if (!fs.existsSync(full)) return;
        const target = path.join(this.batch, ...p.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(full, target);
        this.count += 1;
    }
}

function categoriesFor(info, categories) {
    if (categories) return categories;
    const offered = Array.isArray(info?.categories) ? new Set(info.categories.map((c) => c?.id)) : null;
    return offered ? DEFAULT_CATEGORY_IDS.filter((id) => offered.has(id)) : DEFAULT_CATEGORY_IDS;
}

function skippedOf(plan) {
    return Array.isArray(plan.skipped)
        ? plan.skipped.filter((s) => typeof s?.path === 'string').map((s) => ({ path: s.path, reason: String(s.reason || 'conflict') }))
        : [];
}

const planUrl = (id, action) => `/api/v1/plans/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

export function pickEncoding(info) {
    const encodings = Array.isArray(info?.encodings) ? info.encodings : [];
    if (HAS_ZSTD && encodings.includes('zstd')) return 'zstd';
    if (encodings.includes('br')) return 'br';
    return 'identity';
}

function encoderFor(encoding) {
    if (encoding === 'zstd') return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
    if (encoding === 'br') return zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    return null;
}

function decoderFor(encoding) {
    if (!encoding || encoding === 'identity') return null;
    if (encoding === 'zstd' && HAS_ZSTD) return zlib.createZstdDecompress();
    if (encoding === 'br') return zlib.createBrotliDecompress();
    throw new Error(`服务器返回了不支持的压缩格式：${encoding}`);
}

function frameHeader(id, length) {
    const head = Buffer.alloc(4 + ID_LEN);
    head.writeUInt32BE(length, 0);
    head.write(id, 4, 'ascii');
    return head;
}

async function* readFrames(stream) {
    let buffer = Buffer.alloc(0);
    const iterator = stream[Symbol.asyncIterator]();
    let done = false;
    const need = async (n) => {
        while (buffer.length < n && !done) {
            const next = await iterator.next();
            if (next.done) done = true;
            else buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
        }
        if (buffer.length < n) throw new Error('数据块传输意外中断');
    };
    for (;;) {
        await need(4);
        const length = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (length === 0) return;
        if (length > MAX_SIZE) throw new Error(`数据块过大：${length}`);
        await need(ID_LEN + length);
        const id = buffer.subarray(0, ID_LEN).toString('ascii');
        const data = Buffer.from(buffer.subarray(ID_LEN, ID_LEN + length));
        buffer = buffer.subarray(ID_LEN + length);
        yield { id, data };
    }
}

function batches(items, maxCount, sizeOf = () => 0, maxBytes = Infinity) {
    const out = [];
    let current = [];
    let bytes = 0;
    for (const item of items) {
        const size = sizeOf(item);
        if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) {
            out.push(current);
            current = [];
            bytes = 0;
        }
        current.push(item);
        bytes += size;
    }
    if (current.length) out.push(current);
    return out;
}

function localSources(local) {
    const sources = new Map();
    for (const item of local.values()) {
        let offset = 0;
        for (const [id, length] of item.chunks) {
            if (!sources.has(id)) sources.set(id, { full: item.full, offset, length });
            offset += length;
        }
    }
    return sources;
}

async function prepare(ctx, categories, serverId) {
    const scope = resolveScope(categories);
    const index = await new LocalIndex(ctx).load();
    const base = await new SyncBase(ctx, serverId).load();
    const local = await scanLocal(ctx, scope, index);
    const manifest = [...local.values()].map(({ path: p, size, mtime, digest }) => {
        const entry = { path: p, size, mtime, digest };
        const b = base.get(p);
        if (b !== undefined) entry.base = b;
        return entry;
    });
    return { scope, index, base, local, manifest };
}

async function askMissing(session, planId, ids) {
    const missing = new Set();
    for (const batch of batches(ids, BATCH_IDS)) {
        const result = await session.json('POST', planUrl(planId, 'missing'), { chunks: batch }, '查询缺失数据块失败');
        for (const id of result.missing || []) missing.add(id);
    }
    return missing;
}

async function uploadChunks(session, planId, chunks, encoding, job) {
    job.transferTotal += chunks.reduce((sum, c) => sum + c.length, 0);
    for (const batch of batches(chunks, BATCH_IDS, (c) => c.length, BATCH_BYTES)) {
        const frames = Readable.from((async function* () {
            for (const c of batch) {
                const data = await readLocalChunk(c.full, c.offset, c.length, c.id);
                yield frameHeader(c.id, data.length);
                yield data;
                job.transferDone += data.length;
            }
            yield Buffer.alloc(4);
        })());
        const enc = encoderFor(encoding);
        const body = enc ? frames.pipe(enc) : frames;
        frames.on('error', (error) => body.destroy(error));
        let sent = 0;
        body.on('data', (piece) => { sent += piece.length; });
        const response = await session.raw('PUT', planUrl(planId, 'chunks'), {
            headers: { 'Content-Type': 'application/x-stsync-chunks', ...(enc ? { 'Content-Encoding': encoding } : {}) },
            body,
        });
        if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, '上传数据块失败');
        job.bytesSent += sent;
    }
}

export async function runPush(session, ctx, mode, job, { info, categories, serverId, force = false } = {}) {
    job.phase = 'scanning';
    categories = categoriesFor(info, categories);
    const { base, local, manifest } = await prepare(ctx, categories, serverId);

    job.phase = 'planning';
    const plan = await session.json('POST', '/api/v1/sync/plan', {
        direction: 'push', mode, force, categories, manifest,
    }, '创建上传计划失败');
    const upload = plan.upload || [];
    job.filesTotal = upload.length;
    job.bytesTotal = Number(plan.bytes) || 0;
    job.bytesSent = 0;

    let committed = false;
    try {
        const sources = localSources(local);
        const unique = new Map();
        for (const entry of upload) {
            const item = local.get(entry.path);
            if (!item || item.digest !== entry.digest) throw new Error(`${entry.path} 在同步过程中被修改了，请稍后重试`);
            for (const [id] of item.chunks) if (!unique.has(id)) unique.set(id, { id, ...sources.get(id) });
        }

        job.phase = 'uploading';
        const encoding = pickEncoding(info);
        const missing = await askMissing(session, plan.id, [...unique.keys()]);
        await uploadChunks(session, plan.id, [...missing].map((id) => unique.get(id)), encoding, job);

        job.phase = 'assembling';
        const files = upload.map((entry) => ({ entry, chunks: local.get(entry.path).chunks.map(([id]) => id) }));
        for (const batch of batches(files, ASSEMBLE_FILES, (f) => f.chunks.length, BATCH_IDS)) {
            const payload = JSON.stringify({ files: batch.map((f) => ({ path: f.entry.path, chunks: f.chunks })) });
            const post = () => session.raw('POST', planUrl(plan.id, 'assemble'), { headers: { 'Content-Type': 'application/json' }, body: payload });
            let response = await post();
            if (response.status === 404) {
                const again = await askMissing(session, plan.id, [...new Set(batch.flatMap((f) => f.chunks))]);
                await uploadChunks(session, plan.id, [...again].map((id) => unique.get(id)), encoding, job);
                response = await post();
            }
            if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, '服务器拼装文件失败');
            for (const f of batch) {
                job.current = f.entry.path;
                job.filesDone += 1;
                job.bytesDone += f.entry.size;
            }
        }

        job.phase = 'committing';
        const result = await session.json('POST', planUrl(plan.id, 'commit'), undefined, '提交上传失败');
        committed = true;
        if (Array.isArray(plan.synced)) {
            for (const p of plan.synced) {
                const item = local.get(p);
                if (item) base.map.set(p, item.digest);
            }
            for (const p of plan.delete || []) base.map.delete(p);
            await base.save();
        }
        return { files: upload.length, bytes: job.bytesTotal, sent: job.bytesSent, deleted: result.deleted ?? 0, skipped: skippedOf(plan) };
    } finally {
        if (!committed) await session.raw('DELETE', planUrl(plan.id)).catch(() => {});
    }
}

class ChunkStaging {
    constructor(dir) {
        this.dir = dir;
    }

    file(id) {
        return path.join(this.dir, id.slice(0, 2), id);
    }

    has(id) {
        return fs.existsSync(this.file(id));
    }

    async write(id, data) {
        if (chunkId(data) !== id) throw new Error(`下载的数据块校验失败：${id}`);
        const file = this.file(id);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.stsync.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file);
    }

    read(id) {
        return fsp.readFile(this.file(id));
    }

    clear() {
        return fsp.rm(this.dir, { recursive: true, force: true });
    }
}

function needsSectionMerge(core, sections) {
    const fromCore = splitSettings(core);
    return Object.entries(sections).some(([name, value]) => value && Object.keys(fromCore[name] || {}).length === 0);
}

export async function runPull(session, ctx, mode, job, { info, categories, serverId, force = false } = {}) {
    job.phase = 'scanning';
    categories = categoriesFor(info, categories);
    const { index, base, local, manifest } = await prepare(ctx, categories, serverId);
    const trash = new LocalTrash(ctx);
    await trash.gc();

    job.phase = 'planning';
    const plan = await session.json('POST', '/api/v1/sync/plan', {
        direction: 'pull', mode, force, categories, manifest,
    }, '创建下载计划失败');
    const download = plan.download || [];
    const deletes = plan.delete || [];
    job.filesTotal = download.length;
    job.bytesTotal = Number(plan.bytes) || 0;
    job.bytesSent = 0;

    const staging = path.join(ctx.stateRoot, 'staging', crypto.randomUUID());
    const store = new ChunkStaging(path.join(ctx.stateRoot, 'chunks'));
    try {
        for (const entry of download) {
            resolveLocal(ctx, entry.path);
            if (digestOf(entry.size, entry.chunks.map(([id]) => id)) !== entry.digest) throw new Error(`云端块清单与内容指纹不符：${entry.path}`);
        }

        job.phase = 'downloading';
        const sources = localSources(local);
        const wanted = new Map();
        for (const entry of download) {
            for (const [id, length] of entry.chunks) {
                if (!ID_PATTERN.test(id)) throw new Error(`服务器返回了无效的块 ID：${id}`);
                if (!sources.has(id) && !store.has(id) && !wanted.has(id)) wanted.set(id, length);
            }
        }
        job.transferTotal = [...wanted.values()].reduce((sum, n) => sum + n, 0);
        for (const batch of batches([...wanted.entries()], BATCH_IDS, ([, length]) => length, BATCH_BYTES)) {
            const response = await session.raw('POST', planUrl(plan.id, 'fetch'), {
                headers: { 'Content-Type': 'application/json', 'Accept-Encoding': HAS_ZSTD ? 'zstd, br' : 'br' },
                body: JSON.stringify({ chunks: batch.map(([id]) => id) }),
                stream: true,
            });
            if (!response.stream) throw errorFromResponse(response, '下载数据块失败');
            let received = 0;
            response.stream.on('data', (piece) => { received += piece.length; });
            const decoder = decoderFor(response.headers['content-encoding']);
            const decoded = decoder ? response.stream.pipe(decoder) : response.stream;
            response.stream.on('error', (error) => decoded.destroy(error));
            const expected = new Set(batch.map(([id]) => id));
            for await (const { id, data } of readFrames(decoded)) {
                if (!expected.delete(id)) throw new Error(`服务器返回了计划外的数据块：${id}`);
                await store.write(id, data);
                job.transferDone += data.length;
            }
            if (expected.size) throw new Error(`有 ${expected.size} 个数据块没有收到`);
            job.bytesSent += received;
        }

        job.phase = 'assembling';
        const assembled = [];
        for (const [i, entry] of download.entries()) {
            job.current = entry.path;
            const tmp = path.join(staging, `${i}.part`);
            await fsp.mkdir(staging, { recursive: true });
            const out = await fsp.open(tmp, 'w');
            try {
                for (const [id, length] of entry.chunks) {
                    const src = sources.get(id);
                    const data = src ? await readLocalChunk(src.full, src.offset, src.length, id) : await store.read(id);
                    if (data.length !== length || chunkId(data) !== id) throw new Error(`数据块校验失败：${entry.path}`);
                    await out.write(data);
                }
            } finally {
                await out.close();
            }
            assembled.push({ entry, tmp });
            job.filesDone += 1;
            job.bytesDone += entry.size;
        }

        job.phase = 'applying';
        job.current = null;
        const sections = {};
        let settingsDownload = null;
        for (const { entry, tmp } of assembled) {
            if (entry.merge) {
                try {
                    sections[SECTION_NAMES[entry.path]] = JSON.parse(await fsp.readFile(tmp, 'utf8'));
                } catch {
                    job.warnings.push(`云端 ${entry.path} 不是有效的 JSON，已忽略`);
                }
                continue;
            }
            if (entry.path === SETTINGS_PATH) {
                settingsDownload = { entry, tmp };
                continue;
            }
            const { full } = resolveLocal(ctx, entry.path);
            await trash.keep(entry.path, full);
            await publishFile(tmp, full, entry.mtime);
            index.record(entry.path, { size: entry.size, mtime: entry.mtime, digest: entry.digest, chunks: entry.chunks });
        }
        if (settingsDownload) {
            const { entry, tmp } = settingsDownload;
            const full = path.join(ctx.userRoot, 'settings.json');
            let core = null;
            try {
                core = JSON.parse(await fsp.readFile(tmp, 'utf8'));
            } catch {
                job.warnings.push('云端 settings.json 不是有效的 JSON，已跳过');
            }
            if (core) await trash.keep(SETTINGS_PATH, full);
            if (core && needsSectionMerge(core, sections)) {
                const merged = applyDownloadedSections((await readLocalSettings(ctx)).settings, { core, ...sections });
                const mergedTmp = `${tmp}.merged`;
                await fsp.writeFile(mergedTmp, JSON.stringify(merged, null, 4), 'utf8');
                await publishFile(mergedTmp, full, entry.mtime);
                index.forget(SETTINGS_PATH);
            } else if (core) {
                await publishFile(tmp, full, entry.mtime);
                index.record(SETTINGS_PATH, { size: entry.size, mtime: entry.mtime, digest: entry.digest, chunks: entry.chunks });
            }
        }

        let deleted = 0;
        for (const p of deletes) {
            const { full, base: root } = resolveLocal(ctx, p);
            await trash.keep(p, full);
            await removeFileAndPrune(full, root);
            index.forget(p);
            deleted += 1;
        }
        await index.save();

        await session.json('POST', planUrl(plan.id, 'commit'), undefined, '完成下载失败');
        await store.clear();
        if (Array.isArray(plan.synced)) {
            const remote = new Map(download.map((e) => [e.path, e.digest]));
            for (const p of plan.synced) {
                const digest = remote.get(p) ?? local.get(p)?.digest;
                if (digest) base.map.set(p, digest);
            }
            for (const p of deletes) base.map.delete(p);
            await base.save();
        }
        return {
            files: download.filter((e) => !e.merge).length,
            bytes: job.bytesTotal,
            sent: job.bytesSent,
            deleted,
            skipped: skippedOf(plan),
            backedUp: trash.count,
        };
    } finally {
        await fsp.rm(staging, { recursive: true, force: true });
    }
}
