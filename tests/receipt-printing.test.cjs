'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolvePrintMode, resolvePrintLayout, validatePaperWidth, renderReceiptImage, printWindowsReceipt, MAX_HEIGHT } = require('../receipt-printing');

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]);

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yala-receipt-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

function options(overrides = {}) {
    return { printerName: 'Xprinter XP-80', paperWidth: 80, scriptPath: 'C:\\Synthetic App\\windows-receipt-print.ps1', ...overrides };
}

function renderer({ height = 300, capture = png, failure, attached = false } = {}) {
    const calls = [];
    let isAttached = attached;
    let detachCount = 0;
    return {
        calls,
        detached: () => detachCount,
        window: { webContents: {
            executeJavaScript: async () => height,
            debugger: {
                isAttached: () => isAttached,
                attach() { isAttached = true; },
                detach() { isAttached = false; detachCount++; },
                async sendCommand(method, payload) {
                    calls.push({ method, payload });
                    if (failure) throw failure;
                    return method === 'Page.captureScreenshot' ? { data: capture.toString('base64') } : {};
                },
            },
        } },
    };
}

test('Windows automatically uses graphics for every queue including Epson', () => {
    for (const name of [
        'Xprinter XP-80', 'xprinter xp80 (Copy 1)', 'Kitchen S200M', 'Xprinter XP-58', 'Xprinter XP-800',
        'Star TSP100', 'BIXOLON SRP-350', 'Brother QL-800', 'Zebra ZD220',
        'Generic / Text Only', 'Kitchen printer', 'Renamed receipt queue (Copy 1)',
    ]) {
        assert.equal(resolvePrintMode(name, {}, 'win32'), 'windows-graphics', name);
    }
    for (const name of ['EPSON TM-T20III', 'epson tm-t88v', 'Epson Receipt (Copy 1)', 'Kitchen EPSON TM-m30']) {
        assert.equal(resolvePrintMode(name, {}, 'win32'), 'windows-graphics', name);
        assert.equal(resolvePrintMode(name, { [name]: 'auto' }, 'win32'), 'windows-graphics', name);
    }
});

test('non-Windows queues keep Electron printing regardless of brand or graphics override', () => {
    for (const platform of ['darwin', 'linux']) {
        for (const name of ['Xprinter XP-80', 'EPSON TM-T20III', 'Kitchen printer', 'Star TSP100']) {
            assert.equal(resolvePrintMode(name, {}, platform), 'electron', `${platform}: ${name}`);
            assert.equal(resolvePrintMode(name, { [name]: 'windows-graphics' }, platform), 'electron', `${platform} override: ${name}`);
        }
    }
});

test('explicit print methods remain independent for each exact queue', () => {
    const modes = { 'Xprinter XP-80': 'electron', 'Kitchen printer': 'electron', 'EPSON TM-T20III': 'windows-graphics' };
    assert.equal(resolvePrintMode('Xprinter XP-80', modes, 'win32'), 'electron');
    assert.equal(resolvePrintMode('Kitchen printer', modes, 'win32'), 'electron');
    assert.equal(resolvePrintMode('Kitchen printer (Copy 1)', modes, 'win32'), 'windows-graphics');
    assert.equal(resolvePrintMode('EPSON TM-T20III', { 'EPSON TM-T20III': 'electron' }, 'win32'), 'electron');
    assert.equal(resolvePrintMode('EPSON TM-T20III', modes, 'win32'), 'windows-graphics');
    assert.equal(resolvePrintMode('EPSON TM-T20III (Copy 1)', modes, 'win32'), 'windows-graphics');
    assert.equal(resolvePrintMode('Xprinter XP-80', { 'Xprinter XP-80': 'invalid' }, 'win32'), 'windows-graphics');
    assert.equal(resolvePrintMode('EPSON TM-T20III', { 'EPSON TM-T20III': 'invalid' }, 'win32'), 'windows-graphics');
});

test('receipt widths are restricted to supported 58 and 80 mm forms', () => {
    for (const width of [58, 80, '58', '80']) assert.equal(validatePaperWidth(width), Number(width));
    for (const width of [0, null, undefined, 79, 81, -80, Infinity, NaN, '80;exit', {}, []]) {
        assert.throws(() => validatePaperWidth(width), /58 or 80/);
    }
});

test('receipt layouts default to thermal printable widths with no horizontal offset', () => {
    for (const [paperWidth, printableWidthMm] of [[58, 48], [80, 72]]) {
        assert.deepEqual(resolvePrintLayout(paperWidth), { printableWidthMm, horizontalOffsetMm: 0 });
        assert.deepEqual(resolvePrintLayout(paperWidth, null), { printableWidthMm, horizontalOffsetMm: 0 });
        for (const requested of [0, null, undefined]) {
            assert.deepEqual(resolvePrintLayout(paperWidth, { printableWidthMm: requested }), { printableWidthMm, horizontalOffsetMm: 0 });
        }
    }
});

test('receipt layout calibration accepts bounded widths and offsets', () => {
    for (const paperWidth of [58, 80]) {
        for (const printableWidthMm of [20, 47.5, paperWidth]) {
            for (const horizontalOffsetMm of [-10, -2.5, 0, 2.5, 10]) {
                assert.deepEqual(resolvePrintLayout(paperWidth, { printableWidthMm, horizontalOffsetMm }), { printableWidthMm, horizontalOffsetMm });
            }
        }
        for (const printableWidthMm of [-1, 19.9, paperWidth + 0.1, Infinity, NaN, '48', 'invalid']) {
            assert.throws(() => resolvePrintLayout(paperWidth, { printableWidthMm }));
        }
        for (const horizontalOffsetMm of [-10.1, 10.1, Infinity, NaN, '1', 'invalid']) {
            assert.throws(() => resolvePrintLayout(paperWidth, { horizontalOffsetMm }));
        }
        for (const layout of [false, [], 'invalid', 5]) {
            assert.throws(() => resolvePrintLayout(paperWidth, layout));
        }
    }
});

test('rendering captures the complete bounded receipt at thermal resolution and releases the debugger', async () => {
    const app = renderer({ height: 2400 });
    assert.deepEqual(await renderReceiptImage(app.window, 80), png);
    assert.deepEqual(app.calls.find(call => call.method === 'Emulation.setEmulatedMedia').payload, { media: 'print' });
    assert.equal(app.calls.find(call => call.method === 'Emulation.setDeviceMetricsOverride').payload.deviceScaleFactor, 203 / 96);
    assert.equal(app.calls.find(call => call.method === 'Page.captureScreenshot').payload.clip.height, 2400);
    assert.equal(app.calls.find(call => call.method === 'Page.captureScreenshot').payload.captureBeyondViewport, true);
    assert.equal(app.detached(), 1);
});

test('oversized or invalid receipts cannot reach image capture', async () => {
    for (const height of [0, -1, Infinity, NaN, MAX_HEIGHT + 1, '400']) {
        const app = renderer({ height });
        await assert.rejects(renderReceiptImage(app.window, 80), /height/);
        assert.equal(app.calls.some(call => call.method === 'Page.captureScreenshot'), false);
        assert.equal(app.detached(), 1);
    }
});

test('a stalled renderer times out and releases its debugger without submitting a print', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const app = renderer();
    app.window.webContents.debugger.sendCommand = () => new Promise(() => {});
    const rejection = assert.rejects(renderReceiptImage(app.window, 80), /rendering timed out/);
    t.mock.timers.tick(30000);
    await rejection;
    assert.equal(app.detached(), 1);
});

test('successful rendering cancels its watchdog', async t => {
    const clear = t.mock.method(global, 'clearTimeout');
    const app = renderer();
    await renderReceiptImage(app.window, 80);
    assert.equal(clear.mock.callCount(), 1);
    assert.ok(clear.mock.calls[0].arguments[0]);
});

test('render failures and invalid image data release only the owned debugger session', async () => {
    const broken = renderer({ failure: new Error('Synthetic render failure') });
    await assert.rejects(renderReceiptImage(broken.window, 80), /Synthetic/);
    assert.equal(broken.detached(), 1);
    const invalid = renderer({ capture: Buffer.from('not a PNG') });
    await assert.rejects(renderReceiptImage(invalid.window, 58), /could not be rendered/);
    assert.equal(invalid.detached(), 1);
    const ownedElsewhere = renderer({ attached: true });
    await assert.rejects(renderReceiptImage(ownedElsewhere.window, 80), /already in use/);
    assert.equal(ownedElsewhere.detached(), 0);
});

test('Windows submission preserves exact printer names as JSON data and cleans private receipt files', async t => {
    const directory = await fixture(t);
    const printerName = 'Kitchen "Arabic" \'$(never-run)\' % طابعة';
    let executions = 0;
    const result = await printWindowsReceipt({}, options({ printerName }), {
        tempRoot: directory,
        render: async (_, width) => { assert.equal(width, 80); return png; },
        execute: async (file, args, settings) => {
            executions++;
            assert.match(file, /powershell\.exe$/i);
            assert.equal(args[args.indexOf('-File') + 1], options().scriptPath);
            assert.equal(args.includes(printerName), false);
            assert.equal(settings.windowsHide, true);
            assert.ok(settings.timeout > 0 && settings.timeout <= 60000);
            const manifestPath = args[args.indexOf('-ManifestPath') + 1];
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            assert.equal(manifest.printerName, printerName);
            assert.equal(manifest.paperWidth, 80);
            assert.equal(manifest.printableWidthMm, 72);
            assert.equal(manifest.horizontalOffsetMm, 0);
            assert.equal(manifest.jobName, 'YalaMenu receipt');
            assert.ok(path.resolve(manifestPath).startsWith(path.resolve(directory) + path.sep));
            assert.deepEqual(await fs.readFile(manifest.imagePath), png);
            return { stdout: '\uFEFF{"success":true,"submitted":true}' };
        },
    });
    assert.equal(executions, 1);
    assert.deepEqual(result, { success: true, mode: 'windows-graphics', physical_output_verified: false });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('calibrated width and offset reach the helper manifest without changing the rendered paper width', async t => {
    const directory = await fixture(t);
    await printWindowsReceipt({}, options({ paperWidth: 58, printableWidthMm: 44.5, horizontalOffsetMm: -2.5 }), {
        tempRoot: directory,
        render: async (_, width) => { assert.equal(width, 58); return png; },
        execute: async (_, args) => {
            const manifest = JSON.parse(await fs.readFile(args[args.indexOf('-ManifestPath') + 1], 'utf8'));
            assert.equal(manifest.paperWidth, 58);
            assert.equal(manifest.printableWidthMm, 44.5);
            assert.equal(manifest.horizontalOffsetMm, -2.5);
            return { stdout: '{"success":true,"submitted":true}' };
        },
    });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('invalid layout calibration cannot render or submit a receipt', async t => {
    const directory = await fixture(t);
    for (const layout of [{ printableWidthMm: 81 }, { printableWidthMm: 19 }, { horizontalOffsetMm: 11 }, { horizontalOffsetMm: NaN }]) {
        await assert.rejects(printWindowsReceipt({}, options(layout), {
            tempRoot: directory,
            render: () => assert.fail('invalid layout must not render'),
            execute: () => assert.fail('invalid layout must not submit'),
        }));
    }
    assert.deepEqual(await fs.readdir(directory), []);
});

test('failed, timed-out and malformed submissions never retry or claim physical success', async t => {
    for (const outcome of [new Error('Timeout: private receipt details'), 'not JSON', '{"success":false}', '{"success":true,"submitted":false}', '{}']) {
        const directory = await fixture(t);
        let executions = 0;
        let renders = 0;
        await assert.rejects(printWindowsReceipt({}, options(), {
            tempRoot: directory,
            render: async () => { renders++; return png; },
            execute: async () => {
                executions++;
                if (outcome instanceof Error) throw outcome;
                return { stdout: outcome };
            },
        }), error => /Check the printer before reprinting/.test(error.message) && !/private/.test(error.message));
        assert.equal(executions, 1);
        assert.equal(renders, 1);
        assert.deepEqual(await fs.readdir(directory), []);
    }
});

test('invalid queues and render errors never start the Windows print helper', async t => {
    const directory = await fixture(t);
    let executions = 0;
    for (const printerName of ['', '   ', 'line\nbreak', 'null\0byte', 'a'.repeat(257), null]) {
        await assert.rejects(printWindowsReceipt({}, options({ printerName }), {
            tempRoot: directory,
            render: () => assert.fail('invalid queue must not render'),
            execute: () => { executions++; },
        }), /printer name/);
    }
    await assert.rejects(printWindowsReceipt({}, options(), {
        tempRoot: directory,
        render: () => { throw new Error('Synthetic render failure'); },
        execute: () => { executions++; },
    }), /Synthetic render failure/);
    assert.equal(executions, 0);
    assert.deepEqual(await fs.readdir(directory), []);
});
