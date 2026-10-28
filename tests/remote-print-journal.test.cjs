'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RemotePrintJournal, submitRemotePrint, RETENTION_MS, MIN_ENTRIES, MAX_ENTRIES } = require('../remote-print');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yala-remote-journal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'journal.json');
    return { file, journal: new RemotePrintJournal(file) };
}

function payload() {
    return { remote_job_id: crypto.randomUUID(), printerName: 'Synthetic printer', content: '<p>Synthetic receipt</p>', paperWidth: 80 };
}

function remoteStatus(status) {
    return error => error.remoteStatus === status;
}

test('persists the start before driver submission and stores no receipt content', async t => {
    const { file, journal } = fixture(t);
    const request = payload();
    const response = await submitRemotePrint(journal, request, async () => {
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].status, 'started');
        return { success: true };
    });
    assert.equal(response.status, 'accepted');
    assert.equal(response.physical_output_verified, false);
    assert.equal(response.deduplicated, false);
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(saved).entries[0].status, 'completed');
    assert.ok(!saved.includes('Synthetic'));
});

test('a completed job survives restart and is acknowledged without submitting again', async t => {
    const { file, journal } = fixture(t);
    const request = payload();
    let submissions = 0;
    const print = async () => { submissions++; return { success: true }; };
    await submitRemotePrint(journal, request, print);
    const response = await submitRemotePrint(new RemotePrintJournal(file), request, print);
    assert.equal(submissions, 1);
    assert.equal(response.deduplicated, true);
});

test('concurrent duplicate cannot race the first driver submission', async t => {
    const { journal } = fixture(t);
    const request = payload();
    let finish;
    let submissions = 0;
    const first = submitRemotePrint(journal, request, () => {
        submissions++;
        return new Promise(resolve => { finish = resolve; });
    });
    await assert.rejects(submitRemotePrint(journal, request, async () => {
        submissions++;
        return { success: true };
    }), remoteStatus('uncertain'));
    finish({ success: true });
    await first;
    assert.equal(submissions, 1);
});

test('a started job survives restart as uncertain and never automatically reprints', async t => {
    const { file, journal } = fixture(t);
    const request = payload();
    journal.begin(request.remote_job_id, request);
    await assert.rejects(submitRemotePrint(new RemotePrintJournal(file), request, () => assert.fail('must not print')), remoteStatus('uncertain'));
});

test('driver failures retain the started marker and refuse a retry', async t => {
    const { file, journal } = fixture(t);
    const request = payload();
    await assert.rejects(submitRemotePrint(journal, request, async () => { throw new Error('Synthetic disconnected printer'); }), remoteStatus('uncertain'));
    await assert.rejects(submitRemotePrint(new RemotePrintJournal(file), request, () => assert.fail('must not print')), remoteStatus('uncertain'));
});

test('a failed completion write remains uncertain after the driver has accepted the job', async t => {
    const { file, journal } = fixture(t);
    const request = payload();
    journal.complete = () => { throw new Error('Synthetic disk failure'); };
    await assert.rejects(submitRemotePrint(journal, request, async () => ({ success: true })), remoteStatus('uncertain'));
    await assert.rejects(submitRemotePrint(new RemotePrintJournal(file), request, () => assert.fail('must not print')), remoteStatus('uncertain'));
});

test('non-success driver responses cannot complete the job', async t => {
    const { journal } = fixture(t);
    await assert.rejects(submitRemotePrint(journal, payload(), async () => ({ success: false })), remoteStatus('uncertain'));
});

test('invalid IDs are rejected before driver submission and UUID case is normalized', async t => {
    const { journal } = fixture(t);
    for (const id of [null, '', '../outside', 42, '00000000-0000-0000-0000-000000000000']) {
        await assert.rejects(submitRemotePrint(journal, { ...payload(), remote_job_id: id }, () => assert.fail('must not print')), remoteStatus('invalid'));
    }
    const request = payload();
    await submitRemotePrint(journal, { ...request, remote_job_id: request.remote_job_id.toUpperCase() }, async () => ({ success: true }));
    const response = await submitRemotePrint(journal, request, () => assert.fail('must not print'));
    assert.equal(response.deduplicated, true);
});

test('reusing a completed job ID for another printer or receipt is refused', async t => {
    const { journal } = fixture(t);
    const request = payload();
    await submitRemotePrint(journal, request, async () => ({ success: true }));
    for (const changed of [{ printerName: 'Other printer' }, { content: '<p>Changed</p>' }, { paperWidth: 58 }]) {
        await assert.rejects(submitRemotePrint(journal, { ...request, ...changed }, () => assert.fail('must not print')), remoteStatus('uncertain'));
    }
});

test('corrupt history fails closed without modifying the file or printing', async t => {
    const { file } = fixture(t);
    fs.writeFileSync(file, '{broken json');
    await assert.rejects(submitRemotePrint(new RemotePrintJournal(file), payload(), () => assert.fail('must not print')), remoteStatus('unavailable'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken json');
});

test('unwritable history cannot reach the printer', async t => {
    const { file } = fixture(t);
    fs.writeFileSync(file, 'not a directory');
    const journal = new RemotePrintJournal(path.join(file, 'history.json'));
    await assert.rejects(submitRemotePrint(journal, payload(), () => assert.fail('must not print')), remoteStatus('unavailable'));
});

function storedEntry(updatedAt, status = 'completed') {
    return { id: crypto.randomUUID(), fingerprint: 'a'.repeat(64), status, updatedAt };
}

test('retention keeps at least seven days and the newest thousand entries', t => {
    const { file } = fixture(t);
    const now = RETENTION_MS * 3;
    const oldEntries = Array.from({ length: MIN_ENTRIES + 5 }, (_, i) => storedEntry(i));
    const recent = storedEntry(now - 1000);
    const uncertain = storedEntry(0, 'started');
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [...oldEntries, recent, uncertain] }));
    const journal = new RemotePrintJournal(file, { now: () => now });
    const request = payload();
    journal.begin(request.remote_job_id, request);
    const retained = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
    assert.ok(retained.some(entry => entry.id === recent.id));
    assert.ok(retained.some(entry => entry.id === uncertain.id));
    assert.equal(retained.length, MIN_ENTRIES + 2);
    assert.ok(!retained.some(entry => entry.id === oldEntries[0].id));
});

test('a full recent history refuses new jobs instead of losing duplicate protection', async t => {
    const { file } = fixture(t);
    const entries = Array.from({ length: MAX_ENTRIES }, () => storedEntry(Date.now()));
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries }));
    await assert.rejects(submitRemotePrint(new RemotePrintJournal(file), payload(), () => assert.fail('must not print')), remoteStatus('unavailable'));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, MAX_ENTRIES);
});
test('case-duplicate IDs in persisted history fail closed', async t => {
    const { file } = fixture(t);
    const entry = storedEntry(Date.now());
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [entry, { ...entry, id: entry.id.toUpperCase() }] }));
    await assert.rejects(submitRemotePrint(new RemotePrintJournal(file), payload(), () => assert.fail('must not print')), remoteStatus('unavailable'));
});