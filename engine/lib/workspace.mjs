// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { SyncError, toSyncError } from './errors.mjs';
import { chunkFile, chunkId, CHUNKER_ID } from './chunker.mjs';
import { isIgnored } from './categories.mjs';

const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function batchName(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export const digestOf = (size, ids) => crypto.createHash('sha256').update(`${size}\n${ids.join('\n')}`).digest('base64url');

async function writeJsonAtomic(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.stsync.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await fsp.rename(tmp, file);
}

function exactSize(expected, label) {
    let seen = 0;
    return new Transform({
        transform(chunk, _enc, cb) {
            seen += chunk.length;
            if (seen > expected) return cb(new SyncError('InvalidData', `${label} 超出预期大小`));
            cb(null, chunk);
        },
        flush(cb) {
            if (seen !== expected) return cb(new SyncError('Io', `${label} 数据不完整：预期 ${expected} 字节，实际 ${seen} 字节`));
            cb();
        },
    });
}

export class ChunkStore {
    constructor(dir) {
        this.dir = dir;
    }

    file(id) {
        return path.join(this.dir, id.slice(0, 2), id);
    }

    async size(id) {
        const st = await fsp.stat(this.file(id)).catch(() => null);
        return st ? st.size : null;
    }

    async write(id, data) {
        if (chunkId(data) !== id) throw new SyncError('InvalidData', `数据块校验失败：${id}`);
        const file = this.file(id);
        if (fs.existsSync(file)) {
            const now = new Date();
            await fsp.utimes(file, now, now).catch(() => {});
            return false;
        }
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomUUID()}.stsync.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file);
        return true;
    }

    read(id) {
        return fsp.readFile(this.file(id));
    }

    remove(id) {
        return fsp.rm(this.file(id), { force: true });
    }

    async gc() {
        const cutoff = Date.now() - STORE_TTL_MS;
        for (const sub of await fsp.readdir(this.dir).catch(() => [])) {
            for (const name of await fsp.readdir(path.join(this.dir, sub)).catch(() => [])) {
                const file = path.join(this.dir, sub, name);
                const st = await fsp.stat(file).catch(() => null);
                if (st && st.mtimeMs < cutoff) await fsp.rm(file, { force: true });
            }
        }
    }
}

export class Workspace {
    constructor(root, stateDir, { trash = false } = {}) {
        this.root = path.resolve(root);
        this.trashDir = trash ? path.join(stateDir, 'trash') : null;
        this.indexFile = path.join(stateDir, 'index.json');
        this.store = new ChunkStore(path.join(stateDir, 'chunks'));
        this.entries = new Map();
        this.locations = new Map();
        this.saveTimer = null;
    }

    async load() {
        try {
            const data = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
            if (data?.chunker === CHUNKER_ID) for (const [p, e] of Object.entries(data.entries || {})) this.setEntry(p, e, false);
        } catch {
        }
        const gc = () => {
            this.store.gc().catch(() => {});
            this.gcTrash().catch(() => {});
        };
        const timer = setInterval(gc, 6 * 60 * 60 * 1000);
        timer.unref();
        gc();
    }

    async gcTrash() {
        if (!this.trashDir) return;
        const cutoff = Date.now() - TRASH_TTL_MS;
        for (const name of await fsp.readdir(this.trashDir).catch(() => [])) {
            const dir = path.join(this.trashDir, name);
            const st = await fsp.stat(dir).catch(() => null);
            if (st && st.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
        }
    }

    async trashTarget(p) {
        const batch = path.join(this.trashDir, batchName());
        let target = path.join(batch, ...p.split('/'));
        for (let i = 1; fs.existsSync(target); i += 1) target = path.join(batch, ...`${p}.${i}`.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const now = new Date();
        await fsp.utimes(batch, now, now).catch(() => {});
        return target;
    }

    async keepOld(p, full, move) {
        if (!this.trashDir || !fs.existsSync(full)) return;
        const target = await this.trashTarget(p);
        try {
            if (move) await fsp.rename(full, target);
            else await fsp.link(full, target);
        } catch {
            await fsp.copyFile(full, target);
            if (move) await fsp.rm(full, { force: true });
        }
    }

    full(p) {
        const full = path.resolve(this.root, ...p.split('/'));
        if (!full.startsWith(this.root + path.sep)) throw new SyncError('InvalidData', `路径越界：${p}`);
        return full;
    }

    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            writeJsonAtomic(this.indexFile, { chunker: CHUNKER_ID, entries: Object.fromEntries(this.entries) })
                .catch((error) => console.warn(`[stsync] 保存索引失败：${error.message}`));
        }, 2000);
        this.saveTimer.unref?.();
    }

    forget(p) {
        const old = this.entries.get(p);
        if (!old) return;
        for (const [id] of old.chunks) this.dropLocation(id, p);
    }

    dropLocation(id, p) {
        const list = this.locations.get(id);
        if (!list) return;
        const rest = list.filter((loc) => loc.path !== p);
        if (rest.length) this.locations.set(id, rest);
        else this.locations.delete(id);
    }

    setEntry(p, entry, save = true) {
        this.forget(p);
        this.entries.set(p, entry);
        let offset = 0;
        for (const [id, length] of entry.chunks) {
            const list = this.locations.get(id);
            if (!list) this.locations.set(id, [{ path: p, offset, length }]);
            else if (!list.some((loc) => loc.path === p)) list.push({ path: p, offset, length });
            offset += length;
        }
        if (save) this.scheduleSave();
    }

    dropEntry(p) {
        this.forget(p);
        if (this.entries.delete(p)) this.scheduleSave();
    }

    async describe(p) {
        const st = await fsp.stat(this.full(p)).catch(() => null);
        if (!st || !st.isFile()) {
            this.dropEntry(p);
            return null;
        }
        const mtime = Math.floor(st.mtimeMs);
        const cached = this.entries.get(p);
        if (cached && cached.size === st.size && cached.mtime === mtime) return cached;
        const chunks = (await chunkFile(this.full(p))).map((c) => [c.id, c.length]);
        const entry = { size: st.size, mtime, digest: digestOf(st.size, chunks.map(([id]) => id)), chunks };
        this.setEntry(p, entry);
        return entry;
    }

    async scan(scope, { includeMergeInputs = false } = {}) {
        const out = [];
        const add = async (p) => {
            const entry = await this.describe(p);
            if (entry) out.push({ path: p, size: entry.size, mtime: entry.mtime, digest: entry.digest });
        };
        const walk = async (dirRel) => {
            let items;
            try {
                items = await fsp.readdir(this.full(dirRel), { withFileTypes: true });
            } catch {
                return;
            }
            for (const item of items) {
                const p = `${dirRel}/${item.name}`;
                if (item.isSymbolicLink() || isIgnored(p)) continue;
                if (item.isDirectory()) await walk(p);
                else if (item.isFile()) await add(p);
            }
        };
        for (const d of scope.dirs) await walk(d);
        for (const f of scope.files) if (!isIgnored(f)) await add(f);
        if (includeMergeInputs) for (const f of scope.mergeInputs) await add(f);
        out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return out;
    }

    async source(id) {
        const size = await this.store.size(id);
        if (size !== null) return { kind: 'store', length: size };
        for (const loc of [...(this.locations.get(id) || [])]) {
            const entry = this.entries.get(loc.path);
            const st = await fsp.stat(this.full(loc.path)).catch(() => null);
            if (entry && st && st.size === entry.size && Math.floor(st.mtimeMs) === entry.mtime) {
                return { kind: 'file', full: this.full(loc.path), offset: loc.offset, length: loc.length };
            }
            this.dropLocation(id, loc.path);
        }
        return null;
    }

    async readChunk(id, src) {
        if (src.kind === 'store') return this.store.read(id);
        const handle = await fsp.open(src.full, 'r');
        try {
            const data = Buffer.alloc(src.length);
            const { bytesRead } = await handle.read(data, 0, src.length, src.offset);
            if (bytesRead !== src.length || chunkId(data) !== id) throw new SyncError('Io', `数据块来源已变化：${id}`);
            return data;
        } finally {
            await handle.close();
        }
    }

    async writeFile(p, source, size, mtime, chunks) {
        const full = this.full(p);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        const tmp = `${full}.${crypto.randomUUID().slice(0, 8)}.stsync.tmp`;
        try {
            await pipeline(source, exactSize(size, p), fs.createWriteStream(tmp));
            await this.keepOld(p, full, false);
            await fsp.rename(tmp, full);
            const t = new Date(mtime);
            await fsp.utimes(full, t, t);
        } catch (error) {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            throw toSyncError(error);
        }
        this.setEntry(p, { size, mtime, digest: digestOf(size, chunks.map(([id]) => id)), chunks });
    }

    async deleteFile(p, boundaryRel) {
        const full = this.full(p);
        await this.keepOld(p, full, true);
        await fsp.rm(full, { force: true });
        this.dropEntry(p);
        const boundary = boundaryRel ? this.full(boundaryRel) : path.dirname(full);
        let dir = path.dirname(full);
        while (dir.startsWith(boundary + path.sep)) {
            try {
                await fsp.rmdir(dir);
            } catch {
                break;
            }
            dir = path.dirname(dir);
        }
    }
}
