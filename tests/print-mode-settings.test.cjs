'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../settings.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*init\(\);\s*$/m, '');

function fixture(initial = {}, { success = true, authenticated = true, save, printResult = { success: true } } = {}) {
    const elements = new Map(), saved = [], printed = [], alerts = [], calls = [];
    let connections = 0;
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} } });
        return elements.get(id);
    };
    const context = vm.createContext({
        console: { log() {}, error() {} },
        document: { getElementById: element, querySelectorAll: () => [], documentElement: {} },
        localStorage: { getItem() {}, setItem() {} }, alert: message => alerts.push(message),
        setTimeout() {}, clearTimeout() {},
        window: { printerAPI: {
            saveConfig: async config => { calls.push('save'); saved.push(JSON.parse(JSON.stringify(config))); return save ? await save(config) : { success }; },
            getPrinters: async () => [],
            testPrint: async (...args) => { calls.push('print'); printed.push(args); return printResult; },
            connectToYala: async () => { connections++; },
        } },
    });
    vm.runInContext(source + '\nglobalThis.settings = { renderPrinters, getPrinterPrintMode, getPrinterLayout, isGraphicsPrintMethod, updatePrinterLayoutControls, savePrinterSettings, saveAndTestPrinter, testPrint, toggleFavorite, switchLanguage, configure: (config, authenticated) => { printerConfig = config; isAuthenticated = authenticated; }, config: () => printerConfig };', context);
    context.settings.configure(structuredClone(initial), authenticated);
    return {
        settings: context.settings, element, saved, printed, alerts, calls, connections: () => connections,
        config: () => JSON.parse(JSON.stringify(context.settings.config())),
        controls(name, mode = 'auto', width = 80, layout = {}) {
            element('alias-' + name).value = 'Synthetic alias';
            element('width-' + name).value = String(width);
            element('ip-' + name).value = '192.0.2.10';
            element('mode-' + name).value = mode;
            element('layout-width-' + name).value = layout.printableWidthMm === undefined || layout.printableWidthMm === 0 ? '' : String(layout.printableWidthMm);
            element('layout-offset-' + name).value = String(layout.horizontalOffsetMm ?? 0);
        },
        render(name, locale = 'en') {
            context.settings.switchLanguage(locale);
            context.settings.renderPrinters([{ name, displayName: 'Synthetic printer', status: 0 }]);
            return element('printers-list').innerHTML.split('<div class="print-method-control">')[1].split('<div class="printer-controls">')[0];
        },
    };
}

function selectedMode(markup) {
    return markup.match(/<option value="([^"]+)" selected/)[1];
}

test('existing printer settings default to Automatic without saving or printing', () => {
    for (const modes of [undefined, {}, { Kitchen: 'invalid' }, { Kitchen: null }]) {
        const app = fixture({ printerPrintModes: modes, printerPaperWidths: { Kitchen: 58 } });
        assert.equal(selectedMode(app.render('Kitchen')), 'auto');
        assert.equal(app.settings.getPrinterPrintMode('Kitchen'), 'auto');
        assert.equal(app.saved.length, 0);
        assert.equal(app.printed.length, 0);
    }
});

test('every supported saved print method reopens with the correct selection', () => {
    for (const mode of ['auto', 'electron', 'windows-graphics']) {
        const app = fixture({ printerPrintModes: { Kitchen: mode } });
        assert.equal(selectedMode(app.render('Kitchen')), mode);
    }
});

test('saving preserves exact Windows queue names and unrelated printer settings', async () => {
    const printer = '\\\\TEST-SERVER\\HANASIS S200M';
    const app = fixture({
        port: 9191, printerPrintModes: { Cashier: 'electron' }, printerAliases: { Cashier: 'Front desk' },
        printerPaperWidths: { Cashier: 58 }, printerIPs: { Cashier: '192.0.2.20' },
        favoritePrinters: ['Cashier'], remoteSetting: { enabled: true },
    });
    app.controls(printer, 'windows-graphics');
    await app.settings.savePrinterSettings(printer);
    const saved = app.saved[0];
    assert.deepEqual(saved.printerPrintModes, { Cashier: 'electron', [printer]: 'windows-graphics' });
    assert.equal(saved.printerAliases[printer], 'Synthetic alias');
    assert.equal(saved.printerPaperWidths[printer], 80);
    assert.equal(saved.printerIPs[printer], '192.0.2.10');
    assert.equal(saved.printerAliases.Cashier, 'Front desk');
    assert.equal(saved.printerPaperWidths.Cashier, 58);
    assert.equal(saved.printerIPs.Cashier, '192.0.2.20');
    assert.deepEqual(saved.favoritePrinters, ['Cashier']);
    assert.deepEqual(saved.remoteSetting, { enabled: true });
    assert.equal(saved.port, 9191);
    assert.deepEqual(app.config(), saved);
    assert.equal(app.printed.length, 0);
    app.controls('Cashier', 'auto', 58);
    await app.settings.savePrinterSettings('Cashier');
    assert.deepEqual(app.saved[1].printerPrintModes, { Cashier: 'auto', [printer]: 'windows-graphics' });
});

test('failed saves retain the last saved method and do not report success', async () => {
    const initial = { printerPrintModes: { Kitchen: 'electron' } };
    const app = fixture(initial, { success: false });
    app.controls('Kitchen', 'windows-graphics');
    await app.settings.savePrinterSettings('Kitchen');
    assert.deepEqual(app.config(), initial);
    assert.equal(app.alerts.at(-1), 'Failed to save settings');
    assert.equal(app.printed.length, 0);
});

test('invalid select values cannot persist an unsupported method', async () => {
    const app = fixture();
    app.controls('Kitchen', 'unexpected-command');
    await app.settings.savePrinterSettings('Kitchen');
    assert.equal(app.saved[0].printerPrintModes.Kitchen, 'auto');
});

test('unauthenticated changes keep the existing login boundary', async () => {
    const app = fixture({}, { authenticated: false });
    app.controls('Kitchen', 'windows-graphics');
    await app.settings.savePrinterSettings('Kitchen');
    assert.equal(app.saved.length, 0);
    assert.equal(app.printed.length, 0);
    assert.equal(app.connections(), 1);
});

test('new print-method markup escapes queue names in IDs and accessible references', () => {
    const markup = fixture().render('Queue "A" & <B>\'C');
    assert.match(markup, /id="mode-Queue &quot;A&quot; &amp; &lt;B&gt;&#39;C"/);
    assert.match(markup, /for="mode-Queue &quot;A&quot; &amp; &lt;B&gt;&#39;C"/);
    assert.match(markup, /aria-describedby="mode-hint-Queue &quot;A&quot; &amp; &lt;B&gt;&#39;C"/);
    assert.doesNotMatch(markup, /<B>/);
});

test('English and Arabic labels explain automatic routing and calibration without changing the mode', () => {
    const app = fixture({ printerPrintModes: { Kitchen: 'windows-graphics' } });
    const english = app.render('Kitchen', 'en');
    assert.match(english, /Print method/);
    assert.match(english, /72 mm on 80 mm paper, 48 mm on 58 mm paper/);
    assert.match(english, /Windows graphics only/);
    assert.match(english, /Standard for Epson-named printers/);
    assert.match(english, /Windows graphics for all other printers/);
    assert.match(english, /override the method for this printer only, including Epson/);
    const arabic = app.render('Kitchen', 'ar');
    assert.match(arabic, /طريقة الطباعة/);
    assert.match(arabic, /لرسومات ويندوز فقط/);
    assert.match(arabic, /72 مم لورق 80 مم/);
    assert.match(arabic, /الطباعة القياسية للطابعات التي يتضمن اسمها Epson/);
    assert.match(arabic, /رسومات ويندوز لجميع الطابعات الأخرى/);
    assert.equal(selectedMode(arabic), 'windows-graphics');
    assert.equal(app.saved.length, 0);
});

test('test and favorite actions keep the saved per-printer method map intact', async () => {
    const app = fixture({ printerPrintModes: { Kitchen: 'windows-graphics', Cashier: 'electron' }, printerPaperWidths: { Kitchen: 58 } });
    await app.settings.testPrint('Kitchen');
    assert.deepEqual(app.printed, [['Kitchen', 58]]);
    assert.equal(app.saved.length, 0);
    await app.settings.toggleFavorite('Kitchen');
    assert.deepEqual(app.saved[0].printerPrintModes, { Kitchen: 'windows-graphics', Cashier: 'electron' });
    assert.deepEqual(app.saved[0].favoritePrinters, ['Kitchen']);
});


function testButton() {
    const attributes = new Map();
    return { disabled: false, attributes, setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
}

test('Epson Automatic stays standard while an explicit graphics override enables layout controls', () => {
    const app = fixture();
    const method = { value: 'auto', dataset: { printerName: 'EPSON TM-T20III' } };
    const paper = { value: '80' };
    const width = { value: '72' };
    const offset = { value: '-1.5' };
    const fields = { '[data-print-method]': method, '[data-paper-width]': paper, '[data-layout-width]': width, '[data-layout-offset]': offset };
    const card = { querySelector: selector => fields[selector] };
    method.closest = paper.closest = () => card;
    app.settings.updatePrinterLayoutControls(method);
    assert.equal(width.disabled, true);
    assert.equal(offset.disabled, true);
    method.value = 'windows-graphics';
    app.settings.updatePrinterLayoutControls(method);
    assert.equal(width.disabled, false);
    assert.equal(offset.disabled, false);
    assert.equal(width.placeholder, '72');
    paper.value = '58';
    app.settings.updatePrinterLayoutControls(paper);
    assert.equal(width.max, '58');
    assert.equal(width.placeholder, '48');
    assert.equal(width.value, '', 'an incompatible old calibration returns to automatic after changing paper size');
    method.value = 'electron';
    app.settings.updatePrinterLayoutControls(method);
    assert.equal(width.disabled, true);
    assert.equal(offset.disabled, true);
    assert.equal(app.settings.isGraphicsPrintMethod('Kitchen printer', 'auto'), true);
});

test('Save & test saves an Epson graphics override and layout before using the test IPC', async () => {
    const name = 'EPSON TM-T20III';
    const app = fixture({ printerLayouts: { Kitchen: { printableWidthMm: 48, horizontalOffsetMm: 2 } } });
    app.controls(name, 'windows-graphics', 80, { printableWidthMm: 70, horizontalOffsetMm: -1.5 });
    const button = testButton();
    assert.equal(await app.settings.saveAndTestPrinter(name, button), true);
    assert.deepEqual(app.calls, ['save', 'print']);
    assert.deepEqual(app.saved[0].printerLayouts, {
        Kitchen: { printableWidthMm: 48, horizontalOffsetMm: 2 },
        [name]: { printableWidthMm: 70, horizontalOffsetMm: -1.5 },
    });
    assert.equal(app.saved[0].printerPrintModes[name], 'windows-graphics');
    assert.deepEqual(app.printed, [[name, 80]]);
    assert.equal(button.disabled, false);
    assert.equal(button.attributes.has('aria-busy'), false);
    assert.equal(app.alerts.includes('Settings saved successfully'), false, 'Save & test does not interrupt the flow with a separate save-success alert');
});

test('blank content width and offset persist automatic width and zero offset', async () => {
    const app = fixture();
    app.controls('Kitchen', 'windows-graphics', 58);
    app.element('layout-offset-Kitchen').value = '';
    assert.equal(await app.settings.savePrinterSettings('Kitchen'), true);
    assert.deepEqual(app.saved[0].printerLayouts.Kitchen, { printableWidthMm: 0, horizontalOffsetMm: 0 });
});

test('invalid layout values block saving and test printing', async () => {
    for (const [width, offset, paper] of [[19, 0, 80], [81, 0, 80], [60, 0, 58], ['NaN', 0, 80], [72, 10.1, 80], [72, -10.1, 80], [72, 'Infinity', 80]]) {
        const app = fixture();
        app.controls('Kitchen', 'windows-graphics', paper, { printableWidthMm: width, horizontalOffsetMm: offset });
        assert.equal(await app.settings.saveAndTestPrinter('Kitchen'), false);
        assert.equal(app.saved.length, 0);
        assert.equal(app.printed.length, 0);
        assert.match(app.alerts.at(-1), /content width|Offset/);
    }
});

test('Save & test cannot print after a failed save and restores the button', async () => {
    const app = fixture({ printerPrintModes: { Epson: 'electron' } }, { success: false });
    app.controls('Epson', 'windows-graphics');
    const button = testButton();
    assert.equal(await app.settings.saveAndTestPrinter('Epson', button), false);
    assert.equal(app.printed.length, 0);
    assert.equal(app.config().printerPrintModes.Epson, 'electron');
    assert.equal(button.disabled, false);
    assert.equal(button.attributes.has('aria-busy'), false);
});

test('Save & test blocks a second click until the first save and test finish', async () => {
    let finishSave;
    const app = fixture({}, { save: () => new Promise(resolve => { finishSave = resolve; }) });
    app.controls('Kitchen', 'windows-graphics');
    const button = testButton();
    const first = app.settings.saveAndTestPrinter('Kitchen', button);
    assert.equal(button.disabled, true);
    assert.equal(button.attributes.get('aria-busy'), 'true');
    assert.equal(await app.settings.saveAndTestPrinter('Kitchen'), false);
    assert.equal(app.saved.length, 1);
    assert.equal(app.printed.length, 0);
    finishSave({ success: true });
    assert.equal(await first, true);
    assert.equal(app.printed.length, 1);
    assert.equal(button.disabled, false);
});

test('test submission failures retain the saved layout without automatic reprinting', async () => {
    const app = fixture({}, { printResult: { success: false, message: 'Synthetic offline printer' } });
    app.controls('Kitchen', 'windows-graphics', 58, { printableWidthMm: 46, horizontalOffsetMm: 1 });
    assert.equal(await app.settings.saveAndTestPrinter('Kitchen'), false);
    assert.deepEqual(app.config().printerLayouts.Kitchen, { printableWidthMm: 46, horizontalOffsetMm: 1 });
    assert.equal(app.printed.length, 1);
    assert.match(app.alerts.at(-1), /Synthetic offline/);
});
