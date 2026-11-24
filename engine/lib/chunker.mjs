// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import fs from 'node:fs';

export const CHUNKER_ID = 'fastcdc-gear32-16k-64k-256k-v1';
export const MIN_SIZE = 16 * 1024;
export const AVG_SIZE = 64 * 1024;
export const MAX_SIZE = 256 * 1024;

const MASK_S = 0xFFFFC000 >>> 0;
const MASK_L = 0xFFFC0000 >>> 0;

const GEAR = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
    GEAR[i] = crypto.createHash('sha256').update(`stsync-gear-${i}`).digest().readUInt32BE(0);
}

export const chunkId = (data) => crypto.createHash('sha256').update(data).digest('base64url');

function cutPoint(buf, offset, available, eof) {
    if (available <= MIN_SIZE) return eof ? available : -1;
    const normal = Math.min(AVG_SIZE, available);
    const limit = Math.min(MAX_SIZE, available);
    let fp = 0;
    let i = MIN_SIZE;
    for (; i < normal; i += 1) {
        fp = ((fp << 1) + GEAR[buf[offset + i]]) >>> 0;
        if ((fp & MASK_S) === 0) return i + 1;
    }
    for (; i < limit; i += 1) {
        fp = ((fp << 1) + GEAR[buf[offset + i]]) >>> 0;
        if ((fp & MASK_L) === 0) return i + 1;
    }
    if (limit === MAX_SIZE) return MAX_SIZE;
    return eof ? available : -1;
}

export function chunkBuffer(data) {
    const chunks = [];
    let offset = 0;
    while (offset < data.length) {
        const length = cutPoint(data, offset, data.length - offset, true);
        chunks.push({ id: chunkId(data.subarray(offset, offset + length)), offset, length });
        offset += length;
    }
    return chunks;
}

export async function chunkFile(path) {
    const chunks = [];
    let pending = Buffer.alloc(0);
    let base = 0;
    const emitAvailable = (eof) => {
        let start = 0;
        for (;;) {
            const available = pending.length - start;
            if (available === 0) break;
            const length = cutPoint(pending, start, available, eof);
            if (length < 0) break;
            chunks.push({ id: chunkId(pending.subarray(start, start + length)), offset: base + start, length });
            start += length;
        }
        pending = pending.subarray(start);
        base += start;
    };
    for await (const piece of fs.createReadStream(path, { highWaterMark: 1024 * 1024 })) {
        pending = pending.length ? Buffer.concat([pending, piece]) : piece;
        emitAvailable(false);
    }
    emitAvailable(true);
    return chunks;
}
