// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { SyncError } from './errors.mjs';

export const sha256b64url = (data) => crypto.createHash('sha256').update(data).digest('base64url');

export function spkiOfCertPem(certPem) {
    const cert = new crypto.X509Certificate(certPem);
    return sha256b64url(cert.publicKey.export({ type: 'spki', format: 'der' }));
}

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
        throw new SyncError('Io', `读取 ${file} 失败：${error.message}`);
    }
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.stsync.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode });
    await fsp.rename(tmp, file);
}

export class ServerState {
    constructor(baseDir) {
        this.baseDir = path.resolve(baseDir);
        this.configFile = path.join(this.baseDir, 'config.json');
        this.stateDir = path.join(this.baseDir, 'state');
        this.identityFile = path.join(this.stateDir, 'server.json');
        this.devicesFile = path.join(this.stateDir, 'devices.json');
        this.certFile = path.join(this.stateDir, 'tls', 'server.crt');
        this.keyFile = path.join(this.stateDir, 'tls', 'server.key');
        this.apiKeyFile = path.join(this.baseDir, 'apikey');
        this.lockFile = path.join(this.baseDir, 'pairing.locked');
        this.queue = Promise.resolve();
    }

    config() {
        return readJson(this.configFile);
    }

    identity() {
        return readJson(this.identityFile);
    }

    async tls() {
        const [cert, key] = await Promise.all([fsp.readFile(this.certFile, 'utf8'), fsp.readFile(this.keyFile, 'utf8')]);
        return { cert, key, spki: spkiOfCertPem(cert) };
    }

    pairingLocked() {
        return fs.existsSync(this.lockFile);
    }

    async checkApiToken(token) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
            throw new SyncError('Unauthorized', 'API Key 无效');
        }
        if (this.pairingLocked()) throw new SyncError('Unauthorized', '服务器已关闭新设备接入');
        let expected = '';
        try {
            expected = (await fsp.readFile(this.apiKeyFile, 'utf8')).trim();
        } catch {
        }
        const ok = expected && crypto.timingSafeEqual(Buffer.from(sha256b64url(token)), Buffer.from(sha256b64url(expected)));
        if (!ok) throw new SyncError('Unauthorized', 'API Key 无效');
    }

    withDevices(fn) {
        const run = this.queue.then(async () => {
            const devices = await readJson(this.devicesFile, []);
            if (!Array.isArray(devices)) throw new SyncError('InvalidData', 'devices.json 格式错误');
            const result = await fn(devices);
            if (result?.save) await writeJsonAtomic(this.devicesFile, devices);
            return result?.value;
        });
        this.queue = run.catch(() => {});
        return run;
    }

    listDevices() {
        return this.withDevices((devices) => ({ value: structuredClone(devices) }));
    }

    getDevice(id) {
        return this.withDevices((devices) => ({ value: devices.find((d) => d.id === id) ?? null }));
    }

    saveDevice(device) {
        return this.withDevices((devices) => {
            const index = devices.findIndex((d) => d.id === device.id);
            if (index >= 0) devices[index] = device;
            else devices.push(device);
            return { save: true };
        });
    }

    touchDevice(id) {
        return this.withDevices((devices) => {
            const device = devices.find((d) => d.id === id);
            if (!device) return {};
            device.last_sync_at = Date.now();
            return { save: true };
        });
    }

    removeDevice(idOrName) {
        return this.withDevices((devices) => {
            let index = devices.findIndex((d) => d.id === idOrName);
            if (index < 0) {
                const matches = devices.filter((d) => d.name === idOrName);
                if (matches.length > 1) throw new SyncError('InvalidData', `多台设备名为 ${idOrName}，请改用设备 ID`);
                index = devices.indexOf(matches[0]);
            }
            if (index < 0) return { value: null };
            const [removed] = devices.splice(index, 1);
            return { save: true, value: removed };
        });
    }
}
