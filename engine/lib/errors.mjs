// SPDX-License-Identifier: AGPL-3.0-only
const STATUS = {
    NotFound: 404,
    InvalidData: 400,
    Unauthorized: 401,
    Io: 500,
    Internal: 500,
};

export class SyncError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.status = STATUS[kind] ?? 500;
    }
}

export function toSyncError(error) {
    if (error instanceof SyncError) return error;
    return new SyncError('Io', error?.message || String(error));
}
