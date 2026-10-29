'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function appFixture(t, initial = {}, failures = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yala-printer-main-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'printer-config.json'), JSON.stringify({
        port: 9100, printerIPs: {}, printerPaperWidths: {}, ...initial,
    }));
    fs.writeFileSync(path.join(directory, 'first-run-complete'), 'synthetic');
    const windows = [];
    const timers = new Map();
    const routes = new Map();
    const handlers = new Map();
    const submissions = [];
    const commands = [];
    let timerId = 0;
    let ready;
    const app = new EventEmitter();
    Object.assign(app, {
        getPath: () => directory,
        getVersion: () => '1.3.2',
        requestSingleInstanceLock: () => true,
        setAppUserModelId() {},
        quit() { app.isQuitting = true; app.emit('before-quit'); },
        whenReady: () => ({ then: callback => { ready = callback; } }),
    });
    class FakeWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.visible = options.show;
            this.destroyed = false;
            this.loaded = [];
            this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
            this.webContents.send = () => {};
            this.webContents.getURL = () => this.loaded.at(-1) || '';
            this.webContents.print = (options, callback) => {
                submissions.push({ mode: 'electron', options });
                callback(!failures.electron, failures.electron);
            };
            windows.push(this);
        }
        loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
        loadFile() { return Promise.resolve(); }
        isDestroyed() { return this.destroyed; }
        show() { this.visible = true; }
        hide() { this.visible = false; }
        focus() {}
        destroy() { this.destroyed = true; this.emit('closed'); }
        static getAllWindows() { return windows.filter(window => !window.destroyed); }
    }
    class FakeTray extends EventEmitter {
        setToolTip() {}
        setContextMenu() {}
    }
    const server = {
        use() {},
        get(route, handler) { routes.set('GET ' + route, handler); },
        post(route, handler) { routes.set('POST ' + route, handler); },
        listen() { return new EventEmitter(); },
    };
    const updater = new EventEmitter();
    const modules = {
        electron: {
            app, BrowserWindow: FakeWindow, Tray: FakeTray,
            Menu: { buildFromTemplate: () => ({ getMenuItemById: () => ({}) }) },
            ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
            Notification: { isSupported: () => false },
            dialog: { showErrorBox: () => assert.fail('unexpected error dialog') },
        },
        'electron-updater': { autoUpdater: updater },
        './receipt-printing': {
            ...require('../receipt-printing'),
            async printWindowsReceipt(window, options) {
                submissions.push({ mode: 'windows-graphics', options });
                if (failures.graphics) throw new Error(failures.graphics);
                return { success: true, physical_output_verified: false };
            },
        },
        express: () => server,
        cors: () => () => {},
        'body-parser': { json: () => () => {}, text: () => () => {} },
        'electron-squirrel-startup': false,
        'auto-launch': class {
            isEnabled() { return Promise.resolve(true); }
            enable() { return Promise.resolve(); }
        },
        'child_process': {
            exec: () => assert.fail('no printer or shell commands allowed'),
            execFile(file, args, options, callback) {
                commands.push({ file, args, options });
                callback(null, 'Synthetic offline printer');
            },
        },
        net: { Socket: class { constructor() { assert.fail('no printer network allowed'); } } },
    };
    const context = vm.createContext({
        require: name => Object.hasOwn(modules, name) ? modules[name] :
            name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name),
        __dirname: path.join(__dirname, '..'),
        process: { platform: 'win32', argv: ['electron', '--hidden'] },
        console: { log() {}, error() {} },
        setInterval() {},
        setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        Buffer,
    });
    vm.runInContext(mainSource, context, { filename: 'main.js' });
    return {
        context, windows, timers, routes, handlers, app, submissions, commands,
        start: () => ready(),
        config: () => JSON.parse(fs.readFileSync(path.join(directory, 'printer-config.json'), 'utf8')),
        connected: () => vm.runInContext('isConnected', context),
        printStation: () => windows.find(window => window.options.webPreferences.partition === 'persist:yala-session'),
    };
}

function navigate(window, url) {
    window.webContents.emit('did-navigate', {}, url);
}

test('startup restores the connected station hidden without throttling or elevated renderer access', async t => {
    const fixture = appFixture(t, { yalaConnected: true });
    await fixture.start();
    const station = fixture.printStation();
    assert.ok(station);
    assert.equal(station.visible, false);
    assert.equal(station.loaded[0], 'https://admin.yala.menu/dashboard');
    assert.equal(station.options.webPreferences.backgroundThrottling, false);
    assert.equal(station.options.webPreferences.nodeIntegration, false);
    assert.equal(station.options.webPreferences.sandbox, true);
    assert.equal(station.options.webPreferences.contextIsolation, true);
    assert.equal(path.basename(station.options.webPreferences.preload), 'device-preload.js');
    assert.equal(station.openHandler().action, 'deny');
});

test('first startup does not create a dashboard receiver before connecting', async t => {
    const fixture = appFixture(t);
    await fixture.start();
    assert.equal(fixture.printStation(), undefined);
    await fixture.handlers.get('connect-to-yala')();
    assert.equal(fixture.printStation().loaded[0], 'https://admin.yala.menu/login');
});

test('closing the connected dashboard hides it, while logout stops persistence', t => {
    const fixture = appFixture(t);
    fixture.context.createLoginWindow();
    const station = fixture.printStation();
    navigate(station, 'https://admin.yala.menu/dashboard');
    assert.equal(fixture.config().yalaConnected, true);
    let prevented = false;
    station.emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(station.visible, false);
    assert.equal(station.isDestroyed(), false);
    navigate(station, 'https://admin.yala.menu/login');
    assert.equal(fixture.connected(), false);
    assert.equal(fixture.config().yalaConnected, false);
    assert.equal(station.visible, true);
});

test('disconnect destroys the receiver and prevents restoring it next startup', t => {
    const fixture = appFixture(t, { yalaConnected: true });
    fixture.context.createLoginWindow({ hidden: true });
    const station = fixture.printStation();
    navigate(station, 'https://admin.yala.menu/dashboard');
    fixture.context.disconnectLogin();
    assert.equal(station.isDestroyed(), true);
    assert.equal(fixture.connected(), false);
    assert.equal(fixture.config().yalaConnected, false);
});

test('normal app exit preserves the station preference for restart', t => {
    const fixture = appFixture(t, { yalaConnected: true });
    fixture.context.createLoginWindow({ hidden: true });
    navigate(fixture.printStation(), 'https://admin.yala.menu/dashboard');
    fixture.app.quit();
    assert.equal(fixture.printStation().isDestroyed(), true);
    assert.equal(fixture.config().yalaConnected, true);
});

test('navigation guards deny lookalike origins and permit the Google auth redirect', t => {
    const fixture = appFixture(t);
    fixture.context.createLoginWindow();
    const station = fixture.printStation();
    for (const eventName of ['will-navigate', 'will-redirect']) {
        let denied = false;
        station.webContents.emit(eventName, { preventDefault() { denied = true; } }, 'https://admin.yala.menu.evil.test/');
        assert.equal(denied, true);
        let allowed = true;
        station.webContents.emit(eventName, { preventDefault() { allowed = false; } }, 'https://accounts.google.com/o/oauth2/auth');
        assert.equal(allowed, true);
    }
});

test('offline restoration schedules one reconnect and disconnect cancels it', t => {
    const fixture = appFixture(t, { yalaConnected: true });
    fixture.context.createLoginWindow({ hidden: true });
    const station = fixture.printStation();
    station.webContents.emit('did-fail-load', {}, -106, 'offline', 'https://admin.yala.menu/dashboard', true);
    station.webContents.emit('did-fail-load', {}, -106, 'offline', 'https://admin.yala.menu/dashboard', true);
    const retries = [...fixture.timers.values()].filter(timer => timer.delay === 15000);
    assert.equal(retries.length, 1);
    retries[0].callback();
    assert.equal(station.loaded.length, 2);
    station.webContents.emit('did-fail-load', {}, -106, 'offline', 'https://admin.yala.menu/dashboard', true);
    fixture.context.disconnectLogin();
    const retainedRetry = [...fixture.timers.values()].find(timer => timer.delay === 15000);
    if (retainedRetry) retainedRetry.callback();
    assert.equal(station.loaded.length, 2);
});

async function requestPrint(fixture, body) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await fixture.routes.get('POST /print')({ body }, response);
    return response;
}

test('HTTP remote print path deduplicates successful jobs and preserves local printing', async t => {
    const fixture = appFixture(t);
    fixture.context.createServer();
    let prints = 0;
    fixture.context.stubPrint = async () => { prints++; return { success: true }; };
    vm.runInContext('printJob = stubPrint', fixture.context);
    const request = { remote_job_id: crypto.randomUUID(), order_id: 12, printerName: 'Synthetic printer', content: '<p>Test</p>', paperWidth: 58 };
    const first = await requestPrint(fixture, request);
    const second = await requestPrint(fixture, request);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.physical_output_verified, false);
    assert.equal(second.body.deduplicated, true);
    assert.equal(prints, 1);
    const local = await requestPrint(fixture, { printerName: request.printerName, content: '<p>Local</p>', order_id: 13 });
    assert.equal(local.body.success, true);
    assert.equal(prints, 2);
});

test('HTTP remote print failure becomes uncertain and cannot automatically reprint', async t => {
    const fixture = appFixture(t);
    fixture.context.createServer();
    let prints = 0;
    fixture.context.stubPrint = async () => { prints++; throw new Error('Synthetic printer failure'); };
    vm.runInContext('printJob = stubPrint', fixture.context);
    const request = { remote_job_id: crypto.randomUUID(), printerName: 'Synthetic printer', content: '<p>Test</p>' };
    const first = await requestPrint(fixture, request);
    const second = await requestPrint(fixture, request);
    assert.equal(first.statusCode, 409);
    assert.equal(first.body.status, 'uncertain');
    assert.equal(second.statusCode, 409);
    assert.equal(prints, 1);
});
test('status advertises durable remote job support only in the updated agent', t => {
    const fixture = appFixture(t);
    fixture.context.createServer();
    let status;
    fixture.routes.get('GET /status')({}, { json(value) { status = value; } });
    assert.equal(status.running, true);
    assert.equal(status.remote_jobs, true);
    assert.equal(status.version, '1.3.2');
    assert.equal(status.windows_graphics, true);
});

async function submitReceipt(fixture, printerName, width = 80) {
    fixture.monitorCalls = 0;
    fixture.context.monitorPrintJobStatus = async () => { fixture.monitorCalls++; return { elapsed: 1, checks: 1 }; };
    const pending = fixture.context.printJob(printerName, '<p>Synthetic receipt</p>', null, width);
    await Promise.resolve();
    const timerEntry = [...fixture.timers.entries()].find(([, item]) => item.delay === 500);
    if (timerEntry) {
        fixture.timers.delete(timerEntry[0]);
        timerEntry[1].callback();
    }
    return pending;
}

test('XP-80 receipts use Windows graphics once without Electron or TCP cutting', async t => {
    const fixture = appFixture(t);
    const result = await submitReceipt(fixture, 'Xprinter XP-80');
    assert.equal(result.success, true);
    assert.equal(result.printMode, 'windows-graphics');
    assert.equal(result.physical_output_verified, false);
    assert.equal(fixture.submissions.length, 1);
    assert.equal(fixture.submissions[0].mode, 'windows-graphics');
    assert.equal(fixture.submissions[0].options.printerName, 'Xprinter XP-80');
    assert.equal(path.basename(fixture.submissions[0].options.scriptPath), 'windows-receipt-print.ps1');
    assert.equal([...fixture.timers.values()].some(item => item.delay === 1200), false);
    assert.equal(fixture.windows[0].isDestroyed(), true);
    assert.equal(fixture.monitorCalls, 0);
    assert.equal(fixture.context.getRecentPrintJobs()[0].status, 'submitted');
    assert.equal(fixture.windows[0].options.webPreferences.offscreen, true);
    assert.equal(fixture.windows[0].options.webPreferences.backgroundThrottling, false);
});

test('standard queues and explicit overrides preserve the exact Windows queue name', async t => {
    for (const [name, modes, expected] of [
        ['EPSON TM-T20III', {}, 'windows-graphics'],
        ['EPSON TM-T20III', { 'EPSON TM-T20III': 'auto' }, 'windows-graphics'],
        ['EPSON TM-T20III', { 'EPSON TM-T20III': 'electron' }, 'electron'],
        ['Kitchen Star TSP100', {}, 'windows-graphics'],
        ['BIXOLON SRP-350', {}, 'windows-graphics'],
        ['Kitchen receipt printer', {}, 'windows-graphics'],
        ['Xprinter XP-80', { 'Xprinter XP-80': 'electron' }, 'electron'],
        ['EPSON TM-T20III', { 'EPSON TM-T20III': 'windows-graphics' }, 'windows-graphics'],
        ['Kitchen 100% \\ counter', { 'Kitchen 100% \\ counter': 'windows-graphics' }, 'windows-graphics'],
    ]) {
        const fixture = appFixture(t, { printerPrintModes: modes });
        const result = await submitReceipt(fixture, name, 58);
        assert.equal(result.printMode, expected);
        assert.equal(fixture.submissions.length, 1);
        const call = fixture.submissions[0];
        assert.equal(call.options.printerName || call.options.deviceName, name);
        assert.equal(fixture.windows[0].options.webPreferences.offscreen, expected === 'windows-graphics');
    }
});

test('a graphics failure rejects without a second submission or fallback', async t => {
    const fixture = appFixture(t, {}, { graphics: 'Synthetic uncertain submission' });
    await assert.rejects(submitReceipt(fixture, 'Xprinter XP-80'), /uncertain submission/);
    assert.equal(fixture.submissions.length, 1);
    assert.equal(fixture.submissions[0].mode, 'windows-graphics');
    assert.equal(fixture.windows[0].isDestroyed(), true);
});

test('invalid names and unsupported widths fail before creating a print window', async t => {
    const fixture = appFixture(t);
    await assert.rejects(submitReceipt(fixture, ''), /printer name/);
    await assert.rejects(submitReceipt(fixture, 'Xprinter XP-80', 0), /58 or 80/);
    assert.equal(fixture.windows.length, 0);
    assert.equal(fixture.submissions.length, 0);
});

test('legacy queue monitoring passes names as an argument without a command shell', async t => {
    const fixture = appFixture(t);
    const name = 'EPSON 100% " & synthetic';
    const pending = fixture.context.monitorPrintJobStatus(name, 1);
    [...fixture.timers.values()].find(item => item.delay === 2000).callback();
    await assert.rejects(pending, /Printer error/);
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].file, 'wmic');
    assert.equal(fixture.commands[0].args[2], `name like '%${name}%'`);
    assert.equal(fixture.commands[0].options.windowsHide, true);
});

test('graphics layout stays per printer and applies to an Epson override', async t => {
    const fixture = appFixture(t, {
        printerPrintModes: { 'EPSON TM-T20III': 'windows-graphics' },
        printerLayouts: {
            'EPSON TM-T20III': { printableWidthMm: 68, horizontalOffsetMm: -2 },
            'Xprinter XP-80': { printableWidthMm: 70, horizontalOffsetMm: 1 },
        },
    });
    await submitReceipt(fixture, 'EPSON TM-T20III');
    await submitReceipt(fixture, 'Xprinter XP-80');
    assert.deepEqual(fixture.submissions.map(call => [call.options.printableWidthMm, call.options.horizontalOffsetMm]), [[68, -2], [70, 1]]);
});

test('invalid graphics layouts fail before submission and do not affect standard Epson printing', async t => {
    const fixture = appFixture(t, { printerPrintModes: { 'EPSON TM-T20III': 'electron' }, printerLayouts: {
        'Xprinter XP-80': { printableWidthMm: 90 }, 'EPSON TM-T20III': { printableWidthMm: 90 },
    } });
    await assert.rejects(submitReceipt(fixture, 'Xprinter XP-80'), /Printable width/);
    assert.equal(fixture.submissions.length, 0);
    assert.equal(fixture.windows.length, 0);
    await submitReceipt(fixture, 'EPSON TM-T20III');
    assert.equal(fixture.submissions[0].mode, 'electron');
});

test('test receipt reports the saved Epson method, width and layout with both edge markers', async t => {
    const name = 'EPSON <counter>';
    const fixture = appFixture(t, {
        printerPrintModes: { [name]: 'windows-graphics' }, printerPaperWidths: { [name]: 58 },
        printerLayouts: { [name]: { printableWidthMm: 46, horizontalOffsetMm: -1 } },
    });
    fixture.context.registerIPCHandlers();
    let request;
    fixture.context.stubPrint = async (...args) => { request = args; return { success: true, message: 'Submitted' }; };
    vm.runInContext('printJob = stubPrint', fixture.context);
    const result = await fixture.handlers.get('test-print')({}, name, 80);
    assert.equal(result.success, true);
    assert.equal(request[0], name);
    assert.equal(request[3], 58);
    assert.match(request[1], /Windows graphics/);
    assert.match(request[1], /Printable width:<\/strong> 46mm/);
    assert.match(request[1], /Horizontal adjustment:<\/strong> -1mm/);
    assert.match(request[1], /EPSON &lt;counter&gt;/);
    assert.match(request[1], /<span>LEFT<\/span><span>RIGHT<\/span>/);
    assert.match(request[1], /اختبار عربي/);
    assert.match(request[1], /width: 56mm/);
});

test('a failed configuration save does not change the active printer method or layout', async t => {
    const fixture = appFixture(t, { printerPrintModes: { Epson: 'electron' } });
    fixture.context.registerIPCHandlers();
    fixture.context.saveConfig = () => false;
    const result = await fixture.handlers.get('save-config')({}, {
        printerPrintModes: { Epson: 'windows-graphics' }, printerLayouts: { Epson: { printableWidthMm: 68 } },
    });
    assert.equal(result.success, false);
    const config = fixture.handlers.get('get-config')();
    assert.equal(config.printerPrintModes.Epson, 'electron');
    assert.equal(config.printerLayouts, undefined);
});
