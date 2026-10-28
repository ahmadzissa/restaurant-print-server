'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ENTRIES = 1000;
const MAX_ENTRIES = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function remoteError(message, status, httpStatus) {
    const error = new Error(message);
    error.remoteStatus = status;
    error.httpStatus = httpStatus;
    return error;
}

function fingerprint(payload) {
    return crypto.createHash('sha256').update(JSON.stringify([
        payload.printerName,
        payload.content || '',
        payload.url || '',
        payload.paperWidth || 80
    ])).digest('hex');
}

class RemotePrintJournal {
    constructor(filePath, options = {}) {
        this.filePath = filePath;
        this.now = options.now || Date.now;
        this.entries = null;
    }

    load() {
        if (this.entries) return;
        try {
            const document = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES) {
                throw new Error('Invalid journal');
            }
            const entries = new Map();
            for (const entry of document.entries) {
                if (!entry || typeof entry.id !== 'string' || !UUID.test(entry.id) || entries.has(entry.id.toLowerCase())
                    || !['started', 'completed'].includes(entry.status)
                    || typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)
                    || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) {
                    throw new Error('Invalid journal entry');
                }
                const id = entry.id.toLowerCase();
                entries.set(id, { ...entry, id });
            }
            this.entries = entries;
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.entries = new Map();
                return;
            }
            throw remoteError('Remote print history cannot be read. Printing is paused to prevent duplicates.', 'unavailable', 503);
        }
    }

    save(entries) {
        const temporaryPath = this.filePath + '.' + crypto.randomUUID() + '.tmp';
        let descriptor;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, JSON.stringify({ version: 1, entries: [...entries.values()] }));
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporaryPath, this.filePath);
            this.entries = entries;
        } catch (error) {
            if (descriptor !== undefined) {
                try { fs.closeSync(descriptor); } catch (_) {}
            }
            try { fs.unlinkSync(temporaryPath); } catch (_) {}
            throw remoteError('Remote print history cannot be saved. Check the print manager storage.', 'unavailable', 503);
        }
    }

    begin(id, payload) {
        if (typeof id !== 'string' || !UUID.test(id)) {
            throw remoteError('remote_job_id must be a valid UUID.', 'invalid', 422);
        }
        id = id.toLowerCase();
        this.load();
        const previous = this.entries.get(id);
        const signature = fingerprint(payload);
        if (previous) {
            if (previous.fingerprint !== signature || previous.status !== 'completed') {
                throw remoteError('This print job may already have reached the printer. Check the receipt before requesting a manual reprint.', 'uncertain', 409);
            }
            return false;
        }

        const now = this.now();
        const entries = new Map(this.entries);
        const newest = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        for (const entry of newest.slice(MIN_ENTRIES)) {
            if (entry.status === 'completed' && now - entry.updatedAt > RETENTION_MS) {
                entries.delete(entry.id);
            }
        }
        if (entries.size >= MAX_ENTRIES) {
            throw remoteError('Remote print history is full. Printing is paused until the retained jobs can be reviewed.', 'unavailable', 503);
        }

        entries.set(id, { id, fingerprint: signature, status: 'started', updatedAt: now });
        this.save(entries);
        return true;
    }

    complete(id) {
        id = id.toLowerCase();
        const entry = this.entries?.get(id);
        if (!entry || entry.status !== 'started') {
            throw remoteError('Remote print history does not contain the pending job.', 'uncertain', 409);
        }
        const entries = new Map(this.entries);
        entries.set(id, { ...entry, status: 'completed', updatedAt: this.now() });
        this.save(entries);
    }
}

async function submitRemotePrint(journal, payload, print) {
    const id = payload.remote_job_id;
    const firstAttempt = journal.begin(id, payload);
    if (firstAttempt) {
        try {
            const result = await print();
            if (!result || result.success !== true) {
                throw new Error('Printer did not confirm submission');
            }
            journal.complete(id);
        } catch (error) {
            throw remoteError('Print submission could not be confirmed. Check the printer before requesting a manual reprint.', 'uncertain', 409);
        }
    }
    return {
        success: true,
        remote_job_id: id,
        remote_status: 'completed',
        status: 'accepted',
        physical_output_verified: false,
        deduplicated: !firstAttempt,
        message: 'Receipt accepted by the printer driver. Physical output is not independently verified.'
    };
}

const DASHBOARD_ORIGIN = 'https://admin.yala.menu';
const AUTH_ORIGIN = 'https://accounts.google.com';

function dashboardPageState(value) {
    try {
        const url = new URL(value);
        if (url.origin !== DASHBOARD_ORIGIN || url.username || url.password) return 'external';
        if (/^\/(?:login|logout|register|forgot-password|reset-password)(?:\/|$)/.test(url.pathname)) return 'signed-out';
        if (/^\/auth\//.test(url.pathname)) return 'authenticating';
        return 'dashboard';
    } catch (_) {
        return 'external';
    }
}

function isAllowedNavigation(value) {
    try {
        const url = new URL(value);
        return !url.username && !url.password && [DASHBOARD_ORIGIN, AUTH_ORIGIN].includes(url.origin);
    } catch (_) {
        return false;
    }
}

module.exports = { RemotePrintJournal, submitRemotePrint, RETENTION_MS, MIN_ENTRIES, MAX_ENTRIES, DASHBOARD_ORIGIN, dashboardPageState, isAllowedNavigation };