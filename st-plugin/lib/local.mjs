// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CHUNKER_ID, chunkFile, chunkId } from './chunker.mjs';
import { isIgnored, validatePath } from './categories.mjs';

const USER_PREFIX = 'data/default-user/';
const GLOBAL_PREFIX = 'public/scripts/extensions/third-party/';

export const digestOf = (size, ids) => crypto.createHash('sha256').update(`${size}\n${ids.join('\n')}`).digest('base64url');

export function resolveLocal(ctx, p) {
    validatePath(p);
    let base;
    let rest;
    if (p.startsWith(USER_PREFIX)) {
        base = path.resolve(ctx.userRoot);
        rest = p.slice(USER_PREFIX.length);
    } else if (p.startsWith(GLOBAL_PREFIX)) {
        base = path.resolve(ctx.globalExtensions);
        rest = p.slice(GLOBAL_PREFIX.length);
    } else {
        throw new Error(`不支持的路径：${p}`);
    }
    if (process.platform === 'win32' && rest.split('/').some((s) => /[<>:"|?*]/.test(s) || /[. ]$/.test(s))) {
        throw new Error(`文件名在 Windows 上无法保存：${p}`);
    }
    const full = path.resolve(base, ...rest.split('/'));
    if (!full.startsWith(base + path.sep)) throw new Error(`路径越界：${p}`);
    return { full, base };
}

export class LocalIndex {
    constructor(ctx) {
        this.file = path.join(ctx.stateRoot, 'index.json');
        this.entries = new Map();
        this.dirty = false;
    }

    async load() {
        try {
            const data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
            if (data?.chunker === CHUNKER_ID) this.entries = new Map(Object.entries(data.entries || {}));
        } catch {
        }
        return this;
    }

    async save() {
        if (!this.dirty) return;
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.stsync.tmp`;
        await fsp.writeFile(tmp, JSON.stringify({ chunker: CHUNKER_ID, entries: Object.fromEntries(this.entries) }));
        await fsp.rename(tmp, this.file);
        this.dirty = false;
    }

    async describe(p, full) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isFile()) {
            if (this.entries.delete(p)) this.dirty = true;
            return null;
        }
        const mtime = Math.floor(st.mtimeMs);
        const cached = this.entries.get(p);
        if (cached && cached.size === st.size && cached.mtime === mtime) return cached;
        const chunks = (await chunkFile(full)).map((c) => [c.id, c.length]);
        const entry = { size: st.size, mtime, digest: digestOf(st.size, chunks.map(([id]) => id)), chunks };
        this.entries.set(p, entry);
        this.dirty = true;
        return entry;
    }

    record(p, entry) {
        this.entries.set(p, entry);
        this.dirty = true;
    }

    forget(p) {
        if (this.entries.delete(p)) this.dirty = true;
    }
}

export async function scanLocal(ctx, scope, index) {
    const out = new Map();
    const add = async (p) => {
        if (isIgnored(p)) return;
        const { full } = resolveLocal(ctx, p);
        const entry = await index.describe(p, full);
        if (entry) out.set(p, { path: p, ...entry, full });
    };
    const walk = async (dirRel) => {
        const { full } = resolveLocal(ctx, `${dirRel}/x`);
        const dirFull = path.dirname(full);
        let items;
        try {
            items = await fsp.readdir(dirFull, { withFileTypes: true });
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
    for (const f of scope.files) await add(f);
    await index.save();
    return out;
}

export async function readLocalChunk(full, offset, length, id) {
    const handle = await fsp.open(full, 'r');
    try {
        const data = Buffer.alloc(length);
        const { bytesRead } = await handle.read(data, 0, length, offset);
        if (bytesRead !== length || chunkId(data) !== id) throw new Error('文件在同步过程中被修改了，请稍后重试');
        return data;
    } finally {
        await handle.close();
    }
}

export async function publishFile(tmpFile, finalFull, mtime) {
    await fsp.mkdir(path.dirname(finalFull), { recursive: true });
    const t = new Date(Number(mtime) || Date.now());
    await fsp.utimes(tmpFile, t, t);
    try {
        await fsp.rename(tmpFile, finalFull);
    } catch (error) {
        if (!['EXDEV', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
        const staging = `${finalFull}.${process.pid}.stsync.tmp`;
        await fsp.copyFile(tmpFile, staging);
        await fsp.utimes(staging, t, t);
        await fsp.rename(staging, finalFull);
        await fsp.rm(tmpFile, { force: true });
    }
}

export async function removeFileAndPrune(full, base) {
    await fsp.rm(full, { force: true });
    let dir = path.dirname(full);
    while (dir.startsWith(base + path.sep) && path.dirname(dir) !== base) {
        try {
            await fsp.rmdir(dir);
        } catch {
            break;
        }
        dir = path.dirname(dir);
    }
}

export async function readLocalSettings(ctx) {
    const full = path.join(ctx.userRoot, 'settings.json');
    try {
        return { settings: JSON.parse(await fsp.readFile(full, 'utf8')), exists: true };
    } catch (error) {
        if (error.code === 'ENOENT') return { settings: {}, exists: false };
        throw new Error(`读取 settings.json 失败：${error.message}`);
    }
}

export const fileExists = (p) => fs.existsSync(p);
