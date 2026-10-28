'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function renderFixtures() {
    const { app, BrowserWindow, nativeImage, session } = require('electron');
    const { renderReceiptImage, MAX_HEIGHT } = require('../receipt-printing');
    const outputDirectory = process.argv[2];
    const profileDirectory = process.argv[3];
    const dashboardPrinterScript = process.argv[4];
    app.setPath('userData', profileDirectory);
    await app.whenReady();
    console.log(`Synthetic renderer: Electron ${process.versions.electron}`);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: /^https?:/i.test(details.url) });
    });
    await fs.mkdir(outputDirectory, { recursive: true });
    const window = new BrowserWindow({
        show: false,
        width: 400,
        height: 800,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
    });
    try {
        for (const width of [58, 80]) {
            for (const language of ['en', 'ar']) {
                const rows = language === 'ar' ? 70 : 5;
                const title = language === 'ar' ? 'مطعم تجريبي' : 'Synthetic Restaurant';
                const item = language === 'ar' ? 'وجبة دجاج مع الأرز' : 'Chicken and rice';
                const total = language === 'ar' ? 'الإجمالي' : 'Total';
                const html = `<!doctype html><html lang="${language}" dir="${language === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="UTF-8"><style>
                    * { box-sizing: border-box; } body { width: ${width}mm; margin: 0; padding: 3mm; color: #000; background: #fff; font-family: Arial, sans-serif; font-size: 12px; }
                    h1 { font-size: 19px; text-align: center; } table { width: 100%; border-collapse: collapse; } td { padding: 3px 0; vertical-align: top; } td:last-child { text-align: end; white-space: nowrap; }
                    .total { border-top: 1px solid black; padding: 8px 0; font-weight: bold; } #footer { height: 10px; background: rgb(255, 0, 255); }
                    #receipt { display: none; } #toolbar { height: 60px; background: blue; }
                    @media print { #receipt { display: block; } #toolbar { display: none; } }
                    </style></head><body><div id="toolbar">Screen-only controls</div><div id="receipt"><h1>${title}</h1><p>TEST ONLY — 12345</p><table>${Array.from({ length: rows }, (_, index) => `<tr><td>${index + 1}. ${item}</td><td>12.00</td></tr>`).join('')}</table><p class="total">${total}: ${(rows * 12).toFixed(2)}</p><div id="footer"></div></div></body></html>`;
                await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
                const png = await renderReceiptImage(window, width);
                const pixelWidth = png.readUInt32BE(16);
                const pixelHeight = png.readUInt32BE(20);
                assert.ok(Math.abs(pixelWidth - width * 203 / 25.4) <= 2, `${width} mm width must use 203 dpi: ${pixelWidth}`);
                window.webContents.debugger.attach('1.3');
                await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
                const cssHeight = await window.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
                window.webContents.debugger.detach();
                assert.ok(Math.abs(pixelHeight - cssHeight * 203 / 96) <= 3, `full ${language}/${width} receipt height: ${pixelHeight} for ${cssHeight}px`);
                if (rows === 70) {
                    assert.ok(cssHeight > 800, 'long Arabic receipt must exceed the viewport');
                }
                const decoded = nativeImage.createFromBuffer(png);
                assert.equal(decoded.isEmpty(), false);
                const pixels = decoded.toBitmap();
                let footerPixels = 0;
                let darkPixels = 0;
                for (let y = 0; y < pixelHeight; y++) {
                    for (let x = 0; x < pixelWidth; x++) {
                        const offset = (y * pixelWidth + x) * 4;
                        const blue = pixels[offset];
                        const green = pixels[offset + 1];
                        const red = pixels[offset + 2];
                        if (red < 80 && green < 80 && blue < 80) darkPixels++;
                        if (y > pixelHeight - 70 && red > 240 && green < 20 && blue > 240) footerPixels++;
                    }
                }
                assert.ok(darkPixels > 500, 'receipt must contain rendered text');
                assert.ok(footerPixels > 500, 'footer must remain visible below the viewport');
                assert.equal(window.webContents.debugger.isAttached(), false);
                const filename = `receipt-${width}mm-${language}.png`;
                await fs.writeFile(path.join(outputDirectory, filename), png);
                console.log(`${filename}: ${pixelWidth}x${pixelHeight}, text and footer visible`);
            }
        }
        if (dashboardPrinterScript) {
            const vm = require('node:vm');
            const scope = { module: { exports: {} } };
            vm.runInNewContext(await fs.readFile(dashboardPrinterScript, 'utf8'), scope, { timeout: 1000 });
            for (const width of [58, 80]) {
                const html = scope.module.exports.generateTestReceipt({
                    printer_name: 'Xprinter XP-80', display_name: 'مطبخ تجريبي — Test kitchen', target: 'kitchen',
                }, width);
                await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
                const png = await renderReceiptImage(window, width);
                const pixelWidth = png.readUInt32BE(16);
                const pixelHeight = png.readUInt32BE(20);
                assert.ok(Math.abs(pixelWidth - width * 203 / 25.4) <= 2);
                const footerBottom = await window.webContents.executeJavaScript('document.querySelector(".footer").getBoundingClientRect().bottom');
                assert.ok(pixelHeight > footerBottom * 203 / 96, 'actual dashboard test footer must fit in the rendered receipt');
                assert.ok(png.length > 1000, 'actual dashboard test must produce a nonempty image');
                const filename = `dashboard-test-${width}mm.png`;
                await fs.writeFile(path.join(outputDirectory, filename), png);
                console.log(`${filename}: ${pixelWidth}x${pixelHeight}, actual dashboard test HTML`);
            }
        }
        await window.loadURL(`data:text/html,${encodeURIComponent(`<html><body><div style="height:${MAX_HEIGHT + 1}px">Synthetic oversize receipt</div></body></html>`)}`);
        await assert.rejects(renderReceiptImage(window, 80), /height is outside/);
        assert.equal(window.webContents.debugger.isAttached(), false);
        console.log('Oversize receipt rejected; no print API called.');
    } finally {
        window.destroy();
    }
    app.exit(0);
}

async function launchRenderer() {
    const { spawn } = require('node:child_process');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yala-receipt-render-test-'));
    const outputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(directory, 'images');
    const dashboardPrinterScript = process.argv[3] ? path.resolve(process.argv[3]) : null;
    const profileDirectory = path.join(directory, 'profile');
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    try {
        await new Promise((resolve, reject) => {
            const child = spawn(require('electron'), [__filename, outputDirectory, profileDirectory, ...(dashboardPrinterScript ? [dashboardPrinterScript] : [])], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: environment,
            });
            let completed = false;
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error('Synthetic Electron receipt rendering exceeded 90 seconds.'));
            }, 90000);
            child.stdout.pipe(process.stdout);
            child.stderr.pipe(process.stderr);
            child.on('error', error => {
                completed = true;
                clearTimeout(timer);
                reject(error);
            });
            child.on('exit', code => {
                if (completed) return;
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`Synthetic Electron receipt rendering failed with code ${code}.`));
            });
        });
        console.log(`Synthetic images: ${outputDirectory}`);
    } finally {
        // Keep successful synthetic images for manual visual inspection, but remove the isolated browser profile.
        await fs.rm(profileDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    }
}

if (process.versions.electron) {
    renderFixtures().catch(error => {
        console.error(error);
        require('electron').app.exit(1);
    });
} else {
    launchRenderer().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
