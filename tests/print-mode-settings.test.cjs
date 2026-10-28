'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../settings.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*init\(\);\s*$/m, '');

function fixture(initial = {}, { success = true, authenticated = true } = {}) {
    const elements = new Map(), saved = [], printed = [], alerts = [];
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
            saveConfig: async config => { saved.push(JSON.parse(JSON.stringify(config))); return { success }; },
            getPrinters: async () => [],
            testPrint: async (...args) => { printed.push(args); return { success: true }; },
            connectToYala: async () => { connections++; },
        } },
    });
    vm.runInContext(source + '\nglobalThis.settings = { renderPrinters, getPrinterPrintMode, savePrinterSettings, testPrint, toggleFavorite, switchLanguage, configure: (config, authenticated) => { printerConfig = config; isAuthenticated = authenticated; }, config: () => printerConfig };', context);
    context.settings.configure(structuredClone(initial), authenticated);
    return {
        settings: context.settings, element, saved, printed, alerts, connections: () => connections,
        config: () => JSON.parse(JSON.stringify(context.settings.config())),
        controls(name, mode = 'auto', width = 80) {
            element('alias-' + name).value = 'Synthetic alias';
            element('width-' + name).value = String(width);
            element('ip-' + name).value = '192.0.2.10';
            element('mode-' + name).value = mode;
        },
        render(name, locale = 'en') {
            context.settings.switchLanguage(locale);
            context.settings.renderPrinters([{ name, displayName: 'Synthetic printer', status: 0 }]);
            return element('printers-list').innerHTML.match(/<div class="print-method-control">([\s\S]*?)<\/div>/)[1];
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

test('English and Arabic labels explain saving before testing without changing the mode', () => {
    const app = fixture({ printerPrintModes: { Kitchen: 'windows-graphics' } });
    const english = app.render('Kitchen', 'en');
    assert.match(english, /Print method/);
    assert.match(english, /Save before testing/);
    assert.match(english, /Standard for Epson-named printers/);
    assert.match(english, /Windows graphics for all other printers/);
    assert.match(english, /override the method for this printer only/);
    const arabic = app.render('Kitchen', 'ar');
    assert.match(arabic, /طريقة الطباعة/);
    assert.match(arabic, /احفظ قبل التجربة/);
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
