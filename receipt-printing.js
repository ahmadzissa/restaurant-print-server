'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const MAX_HEIGHT = 12000;
const MAX_PNG_BYTES = 20 * 1024 * 1024;

function resolvePrintMode(printerName, modes = {}, platform = process.platform) {
    if (platform !== 'win32') return 'electron';
    const selected = modes?.[printerName];
    if (selected === 'electron' || selected === 'windows-graphics') return selected;
    return /\bepson(?:\b|_)/i.test(printerName) ? 'electron' : 'windows-graphics';
}

function validatePaperWidth(value) {
    const width = Number(value);
    if (width !== 58 && width !== 80) throw new Error('Receipt paper width must be 58 or 80 mm.');
    return width;
}

function resolvePrintLayout(paperWidth, layout = {}) {
    const width = validatePaperWidth(paperWidth);
    if (layout == null) layout = {};
    if (typeof layout !== 'object' || Array.isArray(layout)) throw new Error('Invalid printer layout settings.');
    const configuredWidth = layout.printableWidthMm;
    const printableWidthMm = configuredWidth == null || configuredWidth === 0 ? (width === 80 ? 72 : 48) : configuredWidth;
    const horizontalOffsetMm = layout.horizontalOffsetMm ?? 0;
    if (!Number.isFinite(printableWidthMm) || printableWidthMm < 20 || printableWidthMm > width) {
        throw new Error(`Printable width must be between 20 and ${width} mm.`);
    }
    if (!Number.isFinite(horizontalOffsetMm) || horizontalOffsetMm < -10 || horizontalOffsetMm > 10) {
        throw new Error('Horizontal adjustment must be between -10 and 10 mm.');
    }
    return { printableWidthMm, horizontalOffsetMm };
}

async function renderReceiptImage(printWindow, paperWidth) {
    const width = validatePaperWidth(paperWidth);
    const contents = printWindow.webContents;
    const cssWidth = width * 96 / 25.4;
    const debuggerApi = contents.debugger;
    if (debuggerApi.isAttached()) throw new Error('Receipt renderer is already in use.');
    debuggerApi.attach('1.3');
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Receipt rendering timed out.')), 30000);
    });
    const command = (method, parameters) => Promise.race([debuggerApi.sendCommand(method, parameters), deadline]);
    try {
        await command('Emulation.setEmulatedMedia', { media: 'print' });
        await command('Emulation.setDeviceMetricsOverride', {
            width: Math.ceil(cssWidth), height: 800, deviceScaleFactor: 203 / 96, mobile: false,
        });
        const height = await Promise.race([contents.executeJavaScript(`(async () => {
            document.documentElement.style.setProperty('background', 'white', 'important');
            document.documentElement.style.setProperty('width', '${width}mm', 'important');
            document.body.style.setProperty('width', '${width}mm', 'important');
            document.body.style.setProperty('max-width', '${width}mm', 'important');
            document.body.style.setProperty('box-sizing', 'border-box', 'important');
            document.body.style.setProperty('margin', '0', 'important');
            let timer;
            try {
                await Promise.race([
                    Promise.all([
                        document.fonts ? document.fonts.ready : Promise.resolve(),
                        ...Array.from(document.images, image => image.complete ? Promise.resolve() : new Promise(resolve => {
                            image.addEventListener('load', resolve, { once: true });
                            image.addEventListener('error', resolve, { once: true });
                        })),
                    ]),
                    new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
                ]);
            } finally { clearTimeout(timer); }
            return Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height));
        })()`, true), deadline]);
        if (!Number.isFinite(height) || height < 1 || height > MAX_HEIGHT) {
            throw new Error('Receipt height is outside the supported range.');
        }
        const capture = await command('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: cssWidth, height, scale: 1 },
        });
        const png = Buffer.from(capture.data, 'base64');
        if (png.length < 24 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error('Receipt image could not be rendered.');
        }
        return png;
    } finally {
        clearTimeout(timer);
        if (debuggerApi.isAttached()) debuggerApi.detach();
    }
}

async function printWindowsReceipt(printWindow, options, dependencies = {}) {
    const width = validatePaperWidth(options.paperWidth);
    const layout = resolvePrintLayout(width, options);
    if (typeof options.printerName !== 'string' || !options.printerName.trim() || options.printerName.length > 256 || /[\x00-\x1f]/.test(options.printerName)) {
        throw new Error('An installed Windows printer name is required.');
    }
    const render = dependencies.render || renderReceiptImage;
    const execute = dependencies.execute || runFile;
    const tempRoot = dependencies.tempRoot || os.tmpdir();
    const png = await render(printWindow, width);
    const directory = await fs.mkdtemp(path.join(tempRoot, 'yala-receipt-'));
    try {
        const imagePath = path.join(directory, 'receipt.png');
        const manifestPath = path.join(directory, 'job.json');
        await fs.writeFile(imagePath, png);
        await fs.writeFile(manifestPath, JSON.stringify({
            printerName: options.printerName,
            paperWidth: width,
            jobName: 'YalaMenu receipt',
            imagePath,
            ...layout,
        }), 'utf8');
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const result = await execute(powershell, [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', options.scriptPath, '-ManifestPath', manifestPath,
        ], { windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024 });
        const response = JSON.parse(String(result.stdout).replace(/^\uFEFF/, '').trim());
        if (response.success !== true || response.submitted !== true) throw new Error('Windows did not confirm print submission.');
        return { success: true, mode: 'windows-graphics', physical_output_verified: false };
    } catch (_) {
        throw new Error('Windows graphics printing could not be confirmed. Check the printer before reprinting.');
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

module.exports = { resolvePrintMode, validatePaperWidth, resolvePrintLayout, renderReceiptImage, printWindowsReceipt, MAX_HEIGHT };
