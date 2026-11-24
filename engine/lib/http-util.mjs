// SPDX-License-Identifier: AGPL-3.0-only
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { SyncError, toSyncError } from './errors.mjs';

export function sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
}

export function sendError(res, error) {
    const e = toSyncError(error);
    if (res.headersSent) {
        res.destroy(e);
        return;
    }
    sendJson(res, e.status, { ok: false, error: e.message });
}

export async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new SyncError('InvalidData', 'request body too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function parseJson(buffer) {
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
        throw new SyncError('InvalidData', error.message);
    }
}

const HAS_ZSTD = typeof zlib.createZstdCompress === 'function';
export const SUPPORTED_ENCODINGS = HAS_ZSTD ? ['zstd', 'br', 'identity'] : ['br', 'identity'];

export function acceptsEncoding(req, name) {
    const value = req.headers['accept-encoding'];
    return typeof value === 'string'
        && value.split(',').some((part) => part.split(';')[0].trim().toLowerCase() === name);
}

export function pickResponseEncoding(req) {
    for (const name of SUPPORTED_ENCODINGS) {
        if (name === 'identity' || acceptsEncoding(req, name)) return name;
    }
    return 'identity';
}

export function requestEncoding(req, allowed = ['identity', 'zstd']) {
    const value = req.headers['content-encoding'];
    if (value === undefined) return 'identity';
    const v = String(value).trim().toLowerCase();
    if (allowed.includes(v) && (v !== 'zstd' || HAS_ZSTD)) return v;
    throw new SyncError('InvalidData', `unsupported Content-Encoding: ${value}`);
}

export function decoder(encoding) {
    if (encoding === 'zstd') return zlib.createZstdDecompress();
    if (encoding === 'br') return zlib.createBrotliDecompress();
    return null;
}

export function encoder(encoding) {
    if (encoding === 'zstd') return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
    if (encoding === 'br') return zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    return null;
}

export function decodedRequest(req, encoding) {
    const d = decoder(encoding);
    if (!d) return req;
    req.on('error', (error) => d.destroy(error));
    return req.pipe(d);
}

export class ByteReader {
    constructor(stream) {
        this.iterator = stream[Symbol.asyncIterator]();
        this.buffer = Buffer.alloc(0);
        this.done = false;
    }

    async fill(n) {
        while (this.buffer.length < n && !this.done) {
            const { value, done } = await this.iterator.next();
            if (done) this.done = true;
            else this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
        }
    }

    async readExact(n, context = 'stream') {
        await this.fill(n);
        if (this.buffer.length < n) throw new SyncError('Io', `unexpected EOF in ${context}`);
        const out = this.buffer.subarray(0, n);
        this.buffer = this.buffer.subarray(n);
        return out;
    }

    take(n) {
        const self = this;
        return Readable.from((async function* () {
            let remaining = n;
            while (remaining > 0) {
                await self.fill(1);
                if (!self.buffer.length) throw new SyncError('Io', '数据流意外结束');
                const piece = self.buffer.subarray(0, Math.min(remaining, self.buffer.length));
                self.buffer = self.buffer.subarray(piece.length);
                remaining -= piece.length;
                yield piece;
            }
        })());
    }

    async expectEof(context) {
        await this.fill(1);
        if (this.buffer.length) throw new SyncError('InvalidData', `${context} contained more bytes than planned`);
    }
}
