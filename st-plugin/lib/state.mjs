// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw new Error(`读取 ${file} 失败：${error.message}`);
    }
}

async function writeJsonPrivate(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
}

export class UserState {
    constructor(stateRoot) {
        this.root = stateRoot;
        this.identityFile = path.join(stateRoot, 'identity.json');
        this.serversFile = path.join(stateRoot, 'servers.json');
    }

    async identity() {
        const existing = await readJson(this.identityFile, null);
        if (existing?.id && existing?.privateKey) return existing;

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const identity = {
            id: crypto.randomUUID(),
            name: `SillyTavern (${os.hostname()})`.slice(0, 64),
            publicKey: publicKey.export({ format: 'jwk' }).x,
            privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
            createdAt: Date.now(),
        };
        await writeJsonPrivate(this.identityFile, identity);
        return identity;
    }

    async servers() {
        const list = await readJson(this.serversFile, []);
        return Array.isArray(list) ? list : [];
    }

    async server(serverId) {
        return (await this.servers()).find((s) => s.id === serverId) || null;
    }

    async upsertServer(record) {
        const list = (await this.servers()).filter((s) => s.id !== record.id);
        list.push(record);
        await writeJsonPrivate(this.serversFile, list);
    }

    async removeServer(serverId) {
        const list = (await this.servers()).filter((s) => s.id !== serverId);
        await writeJsonPrivate(this.serversFile, list);
    }

    async touchServer(serverId, patch) {
        const list = await this.servers();
        const item = list.find((s) => s.id === serverId);
        if (!item) return;
        Object.assign(item, patch);
        await writeJsonPrivate(this.serversFile, list);
    }
}
