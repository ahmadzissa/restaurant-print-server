const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const os = require("os");
const net = require("net");
const fs = require("fs");
const AutoLaunch = require("auto-launch");
const { RemotePrintJournal, submitRemotePrint, DASHBOARD_ORIGIN, dashboardPageState, isAllowedNavigation } = require("./remote-print");
const { resolvePrintMode, validatePaperWidth, printWindowsReceipt } = require('./receipt-printing');
let serverRunning = false;

// Set Windows taskbar icon - MUST match package.json appId
if (process.platform === 'win32') {
    app.setAppUserModelId('com.yallamenu.printserver');
}

// Handle Squirrel events for Windows installer
if (require('electron-squirrel-startup')) app.quit();

function semverGt(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        if (parts1[i] > parts2[i]) return true;
        if (parts1[i] < parts2[i]) return false;
    }
    return false;
}



/**
 * Send debug logs to BROWSER CONSOLE (F12 DevTools)
 */
async function debugToConsoleOnly(win) {
    try {
        if (!win || win.isDestroyed()) return;

        console.log('🔍 Gathering printer debug data...');
        const printers = await win.webContents.getPrintersAsync();
        const debugData = [];

        for (const printer of printers) {
            const windowsInfo = await getWindowsPrinterDetails(printer.name);

            // Analyze each character
            const chars = Array.from(printer.name).map((c, idx) => {
                const code = c.charCodeAt(0);
                return {
                    pos: idx,
                    char: c,
                    code: code,
                    hex: '0x' + code.toString(16),
                    isSpecial: c === '\\' || c === ' ' || code < 32 || code > 126
                };
            });

            debugData.push({
                electronName: printer.name,
                cleanName: printer.name.trim(),
                length: printer.name.length,
                trimmedLength: printer.name.trim().length,
                displayName: printer.displayName,
                status: printer.status,
                isDefault: printer.isDefault,
                hasLeadingSpace: printer.name !== printer.name.trimStart(),
                hasTrailingSpace: printer.name !== printer.name.trimEnd(),
                containsBackslash: printer.name.includes('\\'),
                chars: chars,
                specialChars: chars.filter(c => c.isSpecial),
                windowsInfo: windowsInfo
            });
        }

        // Build JavaScript to execute in browser
        const jsCode = `
(function() {
    console.clear();
    console.log('%c═══════════════════════════════════════════════════════════', 'color: #0f0; font-weight: bold');
    console.log('%c🔍 PRINTER DEBUG REPORT - BROWSER CONSOLE', 'color: #0f0; font-size: 18px; font-weight: bold');
    console.log('%c═══════════════════════════════════════════════════════════', 'color: #0f0; font-weight: bold');
    console.log('%cTimestamp: ${new Date().toLocaleString()}', 'color: #888');
    console.log('%cTotal Printers: ${printers.length}', 'color: #000');
    console.log(' ');

    const debugData = ${JSON.stringify(debugData, null, 2)};

    debugData.forEach((printer, index) => {
        console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #ff9800');
        console.log('%c🖨️  PRINTER #' + (index + 1) + ': ' + printer.electronName, 'color: #ff9800; font-size: 16px; font-weight: bold');
        console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #ff9800');
        console.log(' ');

        // NAME COMPARISON
        console.log('%c📝 NAME ANALYSIS:', 'color: #0ff; font-weight: bold; font-size: 14px');
        console.log('%c   Electron sees:', 'color: #0ff', '"' + printer.electronName + '"');
        console.log('%c   After trim:   ', 'color: #0ff', '"' + printer.cleanName + '"');
        console.log('%c   Display Name: ', 'color: #0ff', printer.displayName || 'N/A');
        console.log(' ');

        // LENGTH INFO
        console.log('%c📏 LENGTH:', 'color: #0ff; font-weight: bold');
        console.log('   Original: ' + printer.length + ' chars');
        console.log('   Trimmed:  ' + printer.trimmedLength + ' chars');
        if (printer.hasLeadingSpace) console.log('%c   ⚠️  HAS LEADING SPACE', 'color: #f00; font-weight: bold');
        if (printer.hasTrailingSpace) console.log('%c   ⚠️  HAS TRAILING SPACE', 'color: #f00; font-weight: bold');
        console.log(' ');

        // SPECIAL CHARACTERS
        if (printer.specialChars.length > 0) {
            console.log('%c⚠️  SPECIAL CHARACTERS FOUND:', 'color: #f90; font-weight: bold; font-size: 14px');
            console.table(printer.specialChars);
            console.log(' ');
        }

        // FULL CHARACTER BREAKDOWN
        console.log('%c🔤 CHARACTER BREAKDOWN:', 'color: #0ff; font-weight: bold');
        console.table(printer.chars);
        console.log(' ');

        // WINDOWS INFO
        console.log('%c🪟 WINDOWS SYSTEM DATA (WMIC):', 'color: #0ff; font-weight: bold; font-size: 14px');
        if (printer.windowsInfo.success) {
            console.log('%c   ✓ Windows Name:', 'color: #0f0', '"' + printer.windowsInfo.name + '"');
            console.log('   Port:          ' + printer.windowsInfo.port);
            console.log('   Status:        ' + printer.windowsInfo.status);
            console.log(' ');

            // MISMATCH CHECK
            if (printer.electronName !== printer.windowsInfo.name) {
                console.log('%c⚠️⚠️⚠️ NAME MISMATCH DETECTED ⚠️⚠️⚠️', 'color: #f00; font-weight: bold; font-size: 16px; background: #ff9800');
                console.log('%c   Your App Sees:  "' + printer.electronName + '"', 'color: #f00; font-weight: bold');
                console.log('%c   Windows Has:    "' + printer.windowsInfo.name + '"', 'color: #0f0; font-weight: bold');
                console.log('%c   This is why printing fails!', 'color: #f90; font-weight: bold');
                console.log(' ');
                console.log('%c✅ SOLUTION: Use this name for deviceName:', 'color: #0f0; font-weight: bold; font-size: 14px');
                console.log('%c   "' + printer.cleanName + '"', 'color: #0f0; font-weight: bold; font-size: 14px; background: #000');
            } else {
                console.log('%c✓ Names match - OK', 'color: #0f0; font-weight: bold');
            }
        } else {
            console.log('%c   ✗ Failed to get Windows data', 'color: #f00; font-weight: bold');
            console.log('   Error: ' + printer.windowsInfo.error);
        }
        console.log(' ');
    });

    console.log('%c═══════════════════════════════════════════════════════════', 'color: #0f0; font-weight: bold');
    console.log('%c✓ DEBUG COMPLETE - Data saved to window.PRINTER_DEBUG', 'color: #0f0; font-weight: bold');
    console.log('%c═══════════════════════════════════════════════════════════', 'color: #0f0; font-weight: bold');
    
    // Store for later access
    window.PRINTER_DEBUG = debugData;
    console.log(' ');
    console.log('%c💡 Type window.PRINTER_DEBUG in console to see full data', 'color: #ff9800; font-style: italic');
})();
`;

        // Execute in browser window
        await win.webContents.executeJavaScript(jsCode);
        console.log('✓ Debug sent to browser console');

    } catch (error) {
        console.error('❌ Debug failed:', error);
        if (win && !win.isDestroyed()) {
            win.webContents.executeJavaScript(`
                console.error('❌ Debug Error: ${error.message.replace(/'/g, "\\'")}');
            `);
        }
    }
}

function getWindowsPrinterDetails(printerName) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            return resolve({ success: false, error: 'Not Windows' });
        }

        const cleanName = printerName.replace(/\\/g, '\\\\').replace(/'/g, "''");
        const cmd = `wmic printer where "name like '%${cleanName}%'" get name,portname,printerstate /format:list`;

        exec(cmd, { timeout: 3000 }, (error, stdout) => {
            if (error) return resolve({ success: false, error: error.message });

            const info = {};
            stdout.split('\n').forEach(line => {
                const parts = line.split('=');
                if (parts.length === 2) {
                    info[parts[0].trim().toLowerCase()] = parts[1].trim();
                }
            });

            if (!info.name) return resolve({ success: false, error: "Not Found in WMIC" });

            resolve({
                success: true,
                name: info.name,
                port: info.portname,
                status: info.printerstate
            });
        });
    });
}
// ========== SINGLE INSTANCE LOCK ==========
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    dialog.showErrorBox(
        'YallaMenu Print Manager Already Running',
        'The application is already running in the system tray.\n\n' +
        'Click the printer icon in your system tray to open settings.'
    );
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log('⚠️ Second instance attempted, showing existing window');
        if (settingsWindow) {
            if (settingsWindow.isMinimized()) settingsWindow.restore();
            if (!settingsWindow.isVisible()) settingsWindow.show();
            settingsWindow.focus();
        } else {
            createSettingsWindow();
        }
    });
}

let wasAutoStarted = process.argv.includes('--hidden') || process.argv.includes('--auto-start');
let PORT = 9100;
let tray = null;
let settingsWindow = null;
let serverApp = null;
let httpServer = null;
const printQueue = [];
const printerStatusCache = new Map();
const recentOrderPrints = new Map()
const DEDUP_WINDOW = 10000;
let loginWindow = null;
let isConnected = false;

// ========== CONFIG FILE ==========
const CONFIG_PATH = path.join(app.getPath('userData'), 'printer-config.json');
const remotePrintJournal = new RemotePrintJournal(path.join(app.getPath('userData'), 'remote-print-journal.json'));

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(data);
            console.log('✓ Config loaded from:', CONFIG_PATH);
            return parsed;
        }
    } catch (err) {
        console.error('Failed to load config:', err);
    }

    // Return default config if file doesn't exist or fails
    return {
        port: 9100,
        printerAliases: {},
        printerPaperWidths: {},
        printerPrintModes: {},
        favoritePrinters: [],
        printerIPs: {}
    };
}

function saveConfig(configToSave) {
    try {
        console.log('Saving config to:', CONFIG_PATH);
        console.log('Config data:', JSON.stringify(configToSave, null, 2));
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configToSave, null, 2), 'utf8');
        console.log('✓ Config saved successfully');
        return true;
    } catch (err) {
        console.error('Failed to save config:', err);
        return false;
    }
}

let config = loadConfig();
PORT = config.port || 9100;

// ========== AUTO-LAUNCH CONFIGURATION ==========
const autoLauncher = new AutoLaunch({
    name: 'Yalla-Menu Print Server',
    path: app.getPath('exe'),
    isHidden: true
});

// ========== PRINTER IP CONFIGURATION ==========
const PRINTER_IP_DEFAULT = "192.168.68.100";
const PRINTER_RAW_PORT = 9100;

function resolvePrinterIp(printerName) {
    return config.printerIPs[printerName] || PRINTER_IP_DEFAULT;
}

// ========== UTILITY ==========
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
    }
    return "localhost";
}

// ========== NOTIFICATIONS ==========
function showDesktopNotification(title, body, isError = false) {
    if (Notification.isSupported()) {
        new Notification({
            title: title,
            body: body,
            icon: path.join(__dirname, 'assets', 'icon.ico'),
            urgency: isError ? 'critical' : 'normal'
        }).show();
    }
}

// ========== LOGIN WINDOW MANAGEMENT ==========
function updateDashboardConnection(connected) {
    const changed = isConnected !== connected;
    isConnected = connected;
    if (config.yalaConnected !== connected) {
        config.yalaConnected = connected;
        saveConfig(config);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('connection-status-changed', { connected });
    }
    return changed;
}

function createLoginWindow({ hidden = false } = {}) {
    if (loginWindow && !loginWindow.isDestroyed()) {
        if (!hidden) {
            loginWindow.show();
            loginWindow.focus();
        }
        return;
    }

    const window = new BrowserWindow({
        width: 1200,
        height: 800,
        show: !hidden,
        fullscreenable: true,
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
            partition: 'persist:yala-session',
            preload: path.join(__dirname, 'device-preload.js'),
            additionalArguments: ['--yala-print-device-name=' + encodeURIComponent(os.hostname())],
        },
        title: 'Yala Menu Print Station'
    });
    loginWindow = window;
    let reconnectTimer = null;
    const cancelReconnect = () => {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
    };
    const scheduleReconnect = () => {
        if (reconnectTimer !== null || window.isDestroyed() || app.isQuitting || !config.yalaConnected) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!window.isDestroyed() && !app.isQuitting && config.yalaConnected) {
                window.loadURL(DASHBOARD_ORIGIN + '/dashboard').catch(scheduleReconnect);
            }
        }, 15000);
    };
    window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) scheduleReconnect();
    });
    window.webContents.on('render-process-gone', scheduleReconnect);

    const guardNavigation = (event, url) => {
        if (!isAllowedNavigation(url)) event.preventDefault();
    };
    window.webContents.on('will-navigate', guardNavigation);
    window.webContents.on('will-redirect', guardNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', event => event.preventDefault());

    const handleNavigation = (_event, url) => {
        const state = dashboardPageState(url);
        if (state === 'signed-out') {
            cancelReconnect();
            updateDashboardConnection(false);
            window.show();
            return;
        }
        if (state !== 'dashboard') {
            if (isConnected) updateDashboardConnection(false);
            return;
        }
        cancelReconnect();
        const newlyConnected = updateDashboardConnection(true);
        if (newlyConnected) {
            if (!hidden) {
                showDesktopNotification('Connected to Yala Menu', 'Remote printing is available while this print station is running.');
                setTimeout(() => {
                    if (!window.isDestroyed() && isConnected) window.hide();
                }, 1500);
            }
        }
    };
    window.webContents.on('did-navigate', handleNavigation);
    window.webContents.on('did-navigate-in-page', handleNavigation);

    window.on('close', event => {
        if (!app.isQuitting && (isConnected || config.yalaConnected)) {
            event.preventDefault();
            window.hide();
        }
    });
    window.on('closed', () => {
        cancelReconnect();
        if (loginWindow === window) loginWindow = null;
        if (app.isQuitting) {
            isConnected = false;
        } else {
            updateDashboardConnection(false);
        }
    });

    window.loadURL(DASHBOARD_ORIGIN + (hidden ? '/dashboard' : '/login')).catch(() => {
        scheduleReconnect();
        if (!window.isDestroyed() && !hidden) {
            showDesktopNotification('Yala Menu connection failed', 'Check the internet connection and reopen the dashboard.', true);
        }
    });
}

function disconnectLogin() {
    updateDashboardConnection(false);
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.destroy();
        loginWindow = null;
    }
    showDesktopNotification('Disconnected from Yala Menu', 'Remote printing is stopped on this computer.');
}
// ========== CUT FUNCTION ==========
function sendCutCommandRawTcp(printerIp, port = PRINTER_RAW_PORT) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const cutCommand = Buffer.from([0x1B, 0x64, 0x06, 0x1D, 0x56, 0x00]);

        socket.connect(port, printerIp, () => {
            console.log(`🔪 Cutting: ${printerIp}:${port}`);
            socket.end(cutCommand);
        });

        socket.on("error", (err) => {
            console.log(`✗ Cut error: ${err.message}`);
            resolve();
        });

        socket.on("close", () => {
            console.log(`✓ Cut sent\n`);
            resolve();
        });
    });
}

// ========== PRINT JOB ==========
const { exec, execFile } = require('child_process');

// Add this function to main.js
async function monitorPrintJobStatus(printerName, jobId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let checkCount = 0;

        const checkStatus = () => {
            checkCount++;
            const elapsed = Date.now() - startTime;

            // Check timeout first
            if (elapsed > timeoutMs) {
                if (settingsWindow && !settingsWindow.isDestroyed()) {
                    settingsWindow.webContents.executeJavaScript(`
                        console.log('%c⏱️ Monitoring timeout after ${elapsed}ms', 'color: #f90');
                    `).catch(() => {});
                }
                return resolve({ success: true, reason: 'timeout', message: 'Print sent, monitoring timed out', elapsed, checks: checkCount });
            }

            // WMIC command
            const escapedName = printerName.replace(/\\/g, '\\\\').replace(/'/g, "''");
            execFile('wmic', ['printjob', 'where', `name like '%${escapedName}%'`, 'get', 'name,jobid,status,jobstatus'], { timeout: 3000, windowsHide: true }, (error, stdout, stderr) => {
                if (error) {
                    // Log to browser
                    if (settingsWindow && !settingsWindow.isDestroyed()) {
                        settingsWindow.webContents.executeJavaScript(`
                            console.log('%c   WMIC Check #${checkCount} (${elapsed}ms): Failed', 'color: #f90');
                        `).catch(() => {});
                    }

                    if (elapsed > 5000) {
                        return resolve({ success: true, reason: 'assumed', checks: checkCount, elapsed });
                    }
                    setTimeout(checkStatus, 1000);
                    return;
                }

                const output = stdout.toLowerCase();

                // Check for errors
                if (output.includes('error') || output.includes('offline') ||
                    output.includes('paper') || output.includes('jam')) {
                    if (settingsWindow && !settingsWindow.isDestroyed()) {
                        settingsWindow.webContents.executeJavaScript(`
                            console.log('%c   ❌ Printer error detected in queue', 'color: #f00; font-weight: bold');
                        `).catch(() => {});
                    }
                    return reject(new Error('Printer error detected in job queue'));
                }

                // Still printing?
                const stillPrinting = output.includes('printing') ||
                    output.includes('spooling') ||
                    output.includes('queued');

                if (stillPrinting) {
                    if (settingsWindow && !settingsWindow.isDestroyed()) {
                        settingsWindow.webContents.executeJavaScript(`
                            console.log('%c   🖨️ Check #${checkCount} (${elapsed}ms): Still printing...', 'color: #0ff');
                        `).catch(() => {});
                    }
                    setTimeout(checkStatus, 1000);
                    return;
                }

                // No jobs found = completed
                if (elapsed > 3000) {
                    return resolve({ success: true, reason: 'completed', checks: checkCount, elapsed });
                }

                setTimeout(checkStatus, 1000);
            });
        };

        // Start checking after 2 seconds
        setTimeout(checkStatus, 2000);
    });
}


// Modify your printJob function
function sanitizePrinterName(printerName) {
    // Electron's deviceName should match the exact printer name from Windows
    // Trim any extra whitespace
    return printerName.trim();
}

async function printJob(printerName, htmlContent, url, paperWidth = 80) {
    paperWidth = validatePaperWidth(paperWidth);
    if (typeof printerName !== 'string' || !printerName.trim() || printerName.length > 256 || /[\x00-\x1f]/.test(printerName)) {
        throw new Error('An installed printer name is required.');
    }
    const jobId = Date.now();
    const printMode = resolvePrintMode(printerName, config.printerPrintModes);

    // ✅ LOG TO BROWSER: Print Job Started
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.executeJavaScript(`
            console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0ff; font-weight: bold');
            console.log('%c🖨️  NEW PRINT JOB #${jobId}', 'color: #0ff; font-size: 16px; font-weight: bold');
            console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0ff; font-weight: bold');
            console.log('%c📋 ORIGINAL REQUEST:', 'color: #0ff; font-weight: bold');
            console.log('   Printer Name: "${printerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
            console.log('   Paper Width:  ${paperWidth}mm');
            console.log('   Has URL:      ${!!url}');
            console.log('   Content Size: ${htmlContent ? htmlContent.length : 0} bytes');
            console.log(' ');
        `).catch(() => {});
    }

    // Device names must match the Windows queue exactly, including spaces and percent signs.
    const sanitizedPrinterName = printerName;

    // ✅ LOG TO BROWSER: Name After Sanitization
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.executeJavaScript(`
            console.log('%c🔧 NAME SANITIZATION:', 'color: #ff9800; font-weight: bold');
            console.log('   Original:  "${printerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
            console.log('   Sanitized: "${sanitizedPrinterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
            ${printerName !== sanitizedPrinterName ? `
            console.log('%c   ⚠️ NAME WAS MODIFIED', 'color: #f90; font-weight: bold');
            ` : `
            console.log('%c   ✓ Name unchanged', 'color: #0f0');
            `}
            console.log(' ');
            console.log('%c📤 SUBMITTING RECEIPT (${printMode})...', 'color: #0ff; font-weight: bold');
            console.log('   deviceName: "${sanitizedPrinterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
            console.log(' ');
        `).catch(() => {});
    }

    const queueItem = {
        id: jobId,
        printerName: sanitizedPrinterName,
        originalName: printerName,
        status: 'pending',
        timestamp: new Date().toISOString(),
        paperWidth: paperWidth
    };

    printQueue.push(queueItem);
    broadcastPrintQueueUpdate();

    return new Promise((resolve, reject) => {
        const printWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                offscreen: printMode === 'windows-graphics',
                backgroundThrottling: printMode !== 'windows-graphics'
            }
        });

        const loadPromise = url
            ? printWindow.loadURL(url)
            : printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

        loadPromise.then(() => {
            setTimeout(() => {
                const submitPrint = printMode === 'windows-graphics'
                    ? (options, callback) => {
                        const scriptPath = app.isPackaged
                            ? path.join(process.resourcesPath, 'windows-receipt-print.ps1')
                            : path.join(__dirname, 'windows-receipt-print.ps1');
                        printWindowsReceipt(printWindow, { printerName, paperWidth, scriptPath })
                            .then(() => callback(true), error => callback(false, error.message));
                    }
                    : printWindow.webContents.print.bind(printWindow.webContents);
                submitPrint({
                    silent: true,
                    deviceName: sanitizedPrinterName,
                    printBackground: true,
                    margins: {
                        marginType: 'none'
                    }
                }, async (success, failureReason) => {
                    printWindow.destroy();

                    if (!success) {
                        // ✅ LOG TO BROWSER: Print Failed
                        if (settingsWindow && !settingsWindow.isDestroyed()) {
                            settingsWindow.webContents.executeJavaScript(`
                                console.log('%c❌━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #f00; font-weight: bold');
                                console.log('%c❌ PRINT FAILED - Job #${jobId}', 'color: #f00; font-size: 16px; font-weight: bold');
                                console.log('%c❌━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #f00; font-weight: bold');
                                console.log('%c🔴 FAILURE DETAILS:', 'color: #f00; font-weight: bold; font-size: 14px');
                                console.log('   Printer Used:     "${sanitizedPrinterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
                                console.log('   Original Request: "${printerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
                                console.log('   Paper Width:      ${paperWidth}mm');
                                console.log('   Failure Reason:   "${(failureReason || 'Unknown').replace(/"/g, '\\"')}"');
                                console.log(' ');
                                console.log('%c🔍 POSSIBLE CAUSES:', 'color: #f90; font-weight: bold');
                                ${failureReason && failureReason.toLowerCase().includes('invalid') && failureReason.toLowerCase().includes('name') ? `
                                console.log('%c   ⚠️ INVALID DEVICE NAME', 'color: #f00; font-weight: bold');
                                console.log('   The printer name does not match any installed printer');
                                console.log('   Check: window.PRINTER_DEBUG for correct names');
                                ` : ''}
                                ${failureReason && (failureReason.toLowerCase().includes('access') || failureReason.toLowerCase().includes('permission')) ? `
                                console.log('%c   ⚠️ PERMISSION DENIED', 'color: #f00; font-weight: bold');
                                console.log('   User lacks permission to print to this printer');
                                console.log('   Check Windows printer permissions');
                                ` : ''}
                                ${failureReason && failureReason.toLowerCase().includes('offline') ? `
                                console.log('%c   ⚠️ PRINTER OFFLINE', 'color: #f00; font-weight: bold');
                                console.log('   Printer is not responding or disconnected');
                                ` : ''}
                                console.log(' ');
                                console.log('%c💡 TROUBLESHOOTING STEPS:', 'color:#ff9800; font-weight: bold');
                                console.log('   1. Check printer name: window.PRINTER_DEBUG');
                                console.log('   2. Verify printer is online in Windows');
                                console.log('   3. Test print from Windows (right-click printer → Print Test Page)');
                                console.log('   4. Check printer permissions in Windows');
                                console.log(' ');
                            `).catch(() => {});
                        }

                        queueItem.status = 'failed';
                        queueItem.error = failureReason || 'Print failed';
                        broadcastPrintQueueUpdate();
                        showDesktopNotification(`Print Failed`, `${sanitizedPrinterName}: ${queueItem.error}`, true);
                        return reject(new Error(queueItem.error));
                    }

                    if (printMode === 'windows-graphics') {
                        queueItem.status = 'submitted';
                        broadcastPrintQueueUpdate();
                        return resolve({ success: true, message: `Receipt submitted on ${paperWidth}mm paper`, jobId, printMode, physical_output_verified: false });
                    }

                    // ✅ LOG TO BROWSER: Print API Success
                    if (settingsWindow && !settingsWindow.isDestroyed()) {
                        settingsWindow.webContents.executeJavaScript(`
                            console.log('%c✓ ELECTRON PRINT API SUCCEEDED', 'color: #0f0; font-weight: bold; font-size: 14px');
                            console.log('   Job sent to Windows print spooler');
                            console.log(' ');
                            console.log('%c⏳ MONITORING PRINT JOB STATUS...', 'color: #0ff; font-weight: bold');
                        `).catch(() => {});
                    }

                    // Monitor the actual print job status
                    try {
                        const monitorResult = await monitorPrintJobStatus(sanitizedPrinterName, jobId, 30000);

                        // ✅ LOG TO BROWSER: Print Completed Successfully
                        if (settingsWindow && !settingsWindow.isDestroyed()) {
                            settingsWindow.webContents.executeJavaScript(`
                                console.log('%c✅━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0f0; font-weight: bold');
                                console.log('%c✅ PRINT COMPLETED - Job #${jobId}', 'color: #0f0; font-size: 16px; font-weight: bold');
                                console.log('%c✅━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0f0; font-weight: bold');
                                console.log('   Printer:  "${sanitizedPrinterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
                                console.log('   Duration: ${monitorResult.elapsed || 0}ms');
                                console.log('   Checks:   ${monitorResult.checks || 0}');
                                console.log(' ');
                            `).catch(() => {});
                        }

                        queueItem.status = 'completed';
                        queueItem.monitorResult = monitorResult;
                        broadcastPrintQueueUpdate();

                        // Send cut command after successful print
                        if (printMode !== 'windows-graphics') {
                            const printerIp = resolvePrinterIp(printerName);
                            setTimeout(async () => {
                                await sendCutCommandRawTcp(printerIp, PRINTER_RAW_PORT);
                            }, 1200);
                        }

                        resolve({ success: true, message: `Receipt submitted on ${paperWidth}mm paper`, jobId, printMode, physical_output_verified: false });

                    } catch (error) {
                        // ✅ LOG TO BROWSER: Monitoring Error
                        if (settingsWindow && !settingsWindow.isDestroyed()) {
                            settingsWindow.webContents.executeJavaScript(`
                                console.log('%c⚠️━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #f90; font-weight: bold');
                                console.log('%c⚠️ PRINT MONITORING ERROR - Job #${jobId}', 'color: #f90; font-size: 16px; font-weight: bold');
                                console.log('%c⚠️━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #f90; font-weight: bold');
                                console.log('%c📋 ERROR DETAILS:', 'color: #f90; font-weight: bold');
                                console.log('   Error: "${error.message.replace(/"/g, '\\"')}"');
                                console.log('   Printer: "${sanitizedPrinterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"');
                                console.log(' ');
                                console.log('%c💡 NOTE:', 'color: #ff9800; font-weight: bold');
                                console.log('   Print may have succeeded but monitoring failed');
                                console.log('   This is often a WMIC access issue, not a print failure');
                                console.log(' ');
                            `).catch(() => {});
                        }

                        queueItem.status = 'failed';
                        queueItem.error = error.message;
                        broadcastPrintQueueUpdate();
                        showDesktopNotification(`Print Job Failed`, `${sanitizedPrinterName}: ${error.message}`, true);
                        reject(error);
                    }
                });
            }, 500);
        }).catch(error => {
            // ✅ LOG TO BROWSER: Content Load Error
            if (settingsWindow && !settingsWindow.isDestroyed()) {
                settingsWindow.webContents.executeJavaScript(`
                    console.log('%c❌ CONTENT LOAD ERROR - Job #${jobId}', 'color: #f00; font-weight: bold; font-size: 14px');
                    console.log('   Error: "${error.message.replace(/"/g, '\\"')}"');
                    console.log('   Failed to load HTML content or URL');
                    console.log(' ');
                `).catch(() => {});
            }

            printWindow.destroy();
            queueItem.status = 'failed';
            queueItem.error = error.message;
            broadcastPrintQueueUpdate();
            reject(error);
        });
    });
}


// Modify your printJob function
function sanitizePrinterNameAdvanced(printerName) {
    if (!printerName) return '';

    let sanitized = printerName;

    console.log(`🔧 Sanitizing: "${printerName}"`);

    // Remove URL encoding artifacts (% signs)
    if (sanitized.includes('%')) {
        console.log('   ⚠️ Removing % characters');
        sanitized = sanitized.replace(/%/g, '');
    }

    // Fix excessive backslash escaping
    // Windows network paths should be: \\servername\printername
    // But sometimes we get: \\\\\\\\servername\\\\printername
    let iterations = 0;
    while (sanitized.includes('\\\\\\\\') && iterations < 10) {
        sanitized = sanitized.replace(/\\\\\\\\/g, '\\\\');
        iterations++;
    }

    if (iterations > 0) {
        console.log(`   ⚠️ Fixed backslash escaping (${iterations} iterations)`);
    }

    // Trim whitespace
    const beforeTrim = sanitized;
    sanitized = sanitized.trim();
    if (beforeTrim !== sanitized) {
        console.log('   ⚠️ Removed leading/trailing spaces');
    }

    // Remove control characters
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

    console.log(`   ✅ Result: "${sanitized}"`);

    return sanitized;
}

function broadcastPrintQueueUpdate() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('print-job-update', getRecentPrintJobs());
    }
}

function getRecentPrintJobs() {
    return printQueue.slice(-20).reverse();
}

// ========== PRINTER STATUS MONITORING ==========
async function checkPrinterStatus(win) {
    try {
        const printers = await win.webContents.getPrintersAsync();
        printers.forEach(printer => {
            const previousStatus = printerStatusCache.get(printer.name);
            if (previousStatus !== printer.status) {
                printerStatusCache.set(printer.name, printer.status);
                if (settingsWindow && !settingsWindow.isDestroyed()) {
                    settingsWindow.webContents.send('printer-status-change', {
                        name: printer.name,
                        status: printer.status
                    });
                }
            }
        });
    } catch (err) {
        console.error('Failed to check printer status:', err);
    }
}

// Monitor printer status every 10 seconds
setInterval(() => {
    const win = settingsWindow || BrowserWindow.getAllWindows()[0];
    if (win) checkPrinterStatus(win);
}, 10000);

// ========== EXPRESS SERVER ==========
function createServer() {
    serverApp = express();
    serverApp.use(cors({ origin: "*", methods: ["GET", "POST"] }));
    serverApp.use(bodyParser.json({ limit: "50mb" }));
    serverApp.use(bodyParser.text({ limit: "50mb", type: "text/html" }));

    serverApp.get("/status", (req, res) => {
        res.json({
            running: true,
            remote_jobs: true,
            version: app.getVersion(),
            windows_graphics: process.platform === 'win32',
            port: PORT,
            ip: getLocalIP(),
            printer_ip_default: PRINTER_IP_DEFAULT,
            printer_raw_port: PRINTER_RAW_PORT
        });
    });

    serverApp.get("/printers", async (req, res) => {
        try {
            const win = settingsWindow || BrowserWindow.getAllWindows()[0];
            if (!win) return res.status(500).json({ success: false, error: "No window available" });
            const printers = await win.webContents.getPrintersAsync();
            res.json({
                success: true,
                printers: printers.map(p => ({
                    name: p.name,
                    displayName: p.displayName || p.name,
                    isDefault: !!p.isDefault,
                    status: p.status || 0
                }))
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    serverApp.post("/cut", async (req, res) => {
        try {
            const { printerIp } = req.body || {};
            const ip = printerIp || PRINTER_IP_DEFAULT;
            await sendCutCommandRawTcp(ip, PRINTER_RAW_PORT);
            res.json({ success: true, message: `Cut sent to ${ip}:${PRINTER_RAW_PORT}` });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    serverApp.post('/print', async (req, res) => {
        try {
            const { printerName, content, url, paperWidth: requestedWidth, order_id, remote_job_id } = req.body || {};

            if (!printerName) {
                return res.status(400).json({ success: false, error: 'printerName is required' });
            }

            if (!content && !url) {
                return res.status(400).json({ success: false, error: 'Either content or url is required' });
            }

            if (remote_job_id !== undefined) {
                const paperWidth = requestedWidth || config.printerPaperWidths?.[printerName] || 80;
                try {
                    const result = await submitRemotePrint(remotePrintJournal, {
                        remote_job_id, printerName, content, url, paperWidth
                    }, () => printJob(printerName, content, url, paperWidth));
                    return res.json(result);
                } catch (error) {
                    return res.status(error.httpStatus || 503).json({
                        success: false,
                        remote_job_id,
                        remote_status: error.remoteStatus || 'unavailable',
                        status: error.remoteStatus || 'unavailable',
                        error: error.message
                    });
                }
            }
            // ✅ DEDUPLICATION USING order_id
            if (order_id) {
                const dedupeKey = `${printerName}-${order_id}`;
                const now = Date.now();

                if (recentOrderPrints.has(dedupeKey)) {
                    const lastPrintTime = recentOrderPrints.get(dedupeKey);
                    const timeSinceLastPrint = now - lastPrintTime;

                    if (timeSinceLastPrint < DEDUP_WINDOW) {
                        console.log(`⚠️ Duplicate print ignored: Order #${order_id} on ${printerName} (${timeSinceLastPrint}ms ago)`);

                        return res.json({
                            success: true,
                            message: `Order #${order_id} already printed recently`,
                            deduplicated: true,
                            timeSinceLastPrint: timeSinceLastPrint
                        });
                    }
                }

                // Mark this order as printed NOW (before actual printing)
                recentOrderPrints.set(dedupeKey, now);

                // Cleanup old entries (older than dedup window)
                for (const [key, timestamp] of recentOrderPrints.entries()) {
                    if (now - timestamp > DEDUP_WINDOW) {
                        recentOrderPrints.delete(key);
                    }
                }
            }

            // Use requested width if provided, otherwise use configured width, default to 80mm
            const paperWidth = requestedWidth || config.printerPaperWidths?.[printerName] || 80;

            console.log(`✅ Printing to ${printerName} (Paper: ${paperWidth}mm)${order_id ? ` - Order #${order_id}` : ''}`);

            const result = await printJob(printerName, content, url, paperWidth);
            res.json(result);

        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    httpServer = serverApp.listen(PORT, "0.0.0.0", () => {
        serverRunning = true;
        console.log(`\n✓ Server running:`);
        console.log(`  - Local: http://localhost:${PORT}`);
        console.log(`  - Network: http://${getLocalIP()}:${PORT}`);
        console.log(`✓ Default printer IP: ${PRINTER_IP_DEFAULT}:${PRINTER_RAW_PORT}\n`);
    });

    httpServer.on('error', (error) => {
        serverRunning = false;
        if (error.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use`);
            dialog.showErrorBox(
                'Port Already in Use',
                `Cannot start server on port ${PORT}.\n\n` +
                'The port is already being used by another application.\n' +
                'Please change the port number from settings.'
            );
        } else {
            console.error('❌ Server error:', error);
            dialog.showErrorBox('Server Error', `Failed to start server: ${error.message}`);
        }
    });
}

// ========== UI ==========
function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        show: false,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        },
        title: "YallaMenu Print Manager"
    });

    settingsWindow.once('ready-to-show', () => {
        settingsWindow.show();


        // Run debug after 2 seconds
        setTimeout(() => {
            debugToConsoleOnly(settingsWindow);
        }, 2000);
    });

    settingsWindow.loadFile("settings.html")
        .catch(err => {
            console.error('Failed to load settings.html:', err);
        });

    settingsWindow.on("close", (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            settingsWindow.hide();
        }
    });
}
function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    tray = new Tray(iconPath);
    tray.setToolTip('YallaMenu Print Manager');

    const contextMenu = Menu.buildFromTemplate([
        { label: `Server: ${getLocalIP()}:${PORT}`, enabled: false },
        { label: `RAW Cut: ${PRINTER_IP_DEFAULT}:${PRINTER_RAW_PORT}`, enabled: false },
        { type: 'separator' },
        { label: 'Open Settings', click: createSettingsWindow },
        {
            label: 'Auto-start',
            type: 'checkbox',
            checked: false,
            id: 'auto-start-menu-item',
            click: async (menuItem) => {
                try {
                    if (menuItem.checked) {
                        await autoLauncher.enable();
                        console.log('✓ Auto-launch enabled');
                    } else {
                        await autoLauncher.disable();
                        console.log('✓ Auto-launch disabled');
                    }
                } catch (err) {
                    console.log('Auto-launch error:', err);
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', createSettingsWindow);

    // Update auto-start checkbox after menu is created
    autoLauncher.isEnabled().then(isEnabled => {
        const menuItem = contextMenu.items.find(item => item.id === 'auto-start-menu-item');
        if (menuItem) {
            menuItem.checked = isEnabled;
            tray.setContextMenu(contextMenu);
        }
    }).catch(err => {
        console.log('Auto-launch check error:', err);
    });
}

function registerIPCHandlers() {

    ipcMain.handle("navigate-to-section", async (event, section) => {
        if (loginWindow && !loginWindow.isDestroyed() && isConnected) {
            const routes = {
                'printers': 'https://admin.yala.menu/printer',
                'orders': 'https://admin.yala.menu/TablesPayments',
                'menu': 'https://admin.yala.menu/Sections',
                'settings': 'https://admin.yala.menu/settings',
                'qr': 'https://admin.yala.menu/qr',
                'design': 'https://admin.yala.menu/themeSetting',
                'dashboard': 'https://admin.yala.menu/dashboard'
            };

            if (routes[section]) {
                loginWindow.loadURL(routes[section]);
                loginWindow.show();
                loginWindow.focus();
                return { success: true };
            }
            return { success: false, error: 'Invalid section' };
        }
        return { success: false, error: 'Not connected' };
    });

    ipcMain.handle("get-printers", async () => {
        try {
            const win = settingsWindow || BrowserWindow.getAllWindows()[0];
            if (!win) return [];
            const printers = await win.webContents.getPrintersAsync();
            return printers.map(p => ({
                name: p.name,
                displayName: p.displayName || p.name,
                isDefault: !!p.isDefault,
                status: p.status || 0
            }));
        } catch {
            return [];
        }
    });

    ipcMain.handle('test-print', async (event, printerName, paperWidth = 80) => {
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @page { 
      size: auto;
      margin: 0mm;
    }
    * {
      box-sizing: border-box;
    }
    body {
      width: ${paperWidth - 2}mm;
      font-family: 'Courier New', monospace;
      font-size: 11pt;
      padding: 3mm 1mm 3mm 5mm;
      margin: 0;
      background: white;
    }
    h1 { 
      text-align: center;
      border-top: 2px solid #000;
      border-bottom: 2px solid #000; 
      padding: 3mm 0;
      margin: 0 0 3mm 0;
      font-size: 13pt;
    }
    p { 
      margin: 2mm 0;
      text-align: left;
    }
    .line { 
      border-top: 1px dashed #000; 
      margin: 3mm 0; 
    }
    .center { 
      text-align: center;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <h1>TEST PRINT</h1>
  <p class="center">YallaMenu Print Manager</p>
  <div class="line"></div>
  <p><strong>Printer:</strong> ${printerName}</p>
  <p><strong>Paper Width:</strong> ${paperWidth}mm</p>
  <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
  <div class="line"></div>
  <p class="center">✓ PRINT OK ✓</p>
</body>
</html>`;

        try {
            const savedWidth = config.printerPaperWidths?.[printerName] || paperWidth;
            const r = await printJob(printerName, html, null, savedWidth);
            return { success: true, message: r.message };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('get-server-status', () => {
        const isRunning = httpServer && httpServer.listening;
        return {
            running: isRunning,
            port: PORT,
            url: `http://${getLocalIP()}:${PORT}`
        };
    });

    ipcMain.handle("get-autolaunch-status", async () => {
        try {
            return await autoLauncher.isEnabled();
        } catch {
            return false;
        }
    });

    ipcMain.handle('get-app-version', () => {
        return app.getVersion();
    });

    ipcMain.handle("set-autolaunch", async (event, enabled) => {
        try {
            if (enabled) {
                await autoLauncher.enable();
            } else {
                await autoLauncher.disable();
            }
            return { success: true };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle("save-config", async (event, newConfig) => {
        config = { ...config, ...newConfig };
        const saved = saveConfig(config);
        return { success: saved };
    });

    ipcMain.handle("get-config", () => config);

    ipcMain.handle("change-port", async (event, newPort) => {
        try {
            const testServer = require('net').createServer();

            return new Promise((resolve) => {
                testServer.once('error', (err) => {
                    if (err.code === 'EADDRINUSE') {
                        resolve({
                            success: false,
                            message: `Port ${newPort} is already in use. Try: ${newPort + 1}, ${newPort + 10}, or 9999`
                        });
                    } else {
                        resolve({ success: false, message: err.message });
                    }
                });

                testServer.once('listening', () => {
                    testServer.close();

                    if (httpServer) {
                        httpServer.close();
                    }

                    PORT = newPort;
                    config.port = newPort;
                    saveConfig(config);

                    createServer();

                    resolve({ success: true, message: `Server restarted on port ${newPort}` });
                });

                testServer.listen(newPort);
            });
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle("get-print-queue", () => getRecentPrintJobs());

    ipcMain.handle("show-notification", (event, title, message) => {
        showDesktopNotification(title, message);
        return { success: true };
    });

    ipcMain.handle("remove-job", async (event, jobId) => {
        const index = printQueue.findIndex(job => job.id === jobId);
        if (index > -1) {
            printQueue.splice(index, 1);
            broadcastPrintQueueUpdate();
            return { success: true };
        }
        return { success: false };
    });

    ipcMain.handle("clear-failed-jobs", async () => {
        const beforeCount = printQueue.length;
        const filtered = printQueue.filter(job => job.status !== 'failed');
        printQueue.length = 0;
        printQueue.push(...filtered);
        broadcastPrintQueueUpdate();
        return { success: true, removed: beforeCount - filtered.length };
    });

    // ========== YALA MENU CONNECTION HANDLERS ==========
    ipcMain.handle("connect-to-yala", async () => {
        try {
            createLoginWindow();
            return { success: true, message: 'Opening login window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("disconnect-from-yala", async () => {
        try {
            disconnectLogin();
            return { success: true, message: 'Disconnected' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("get-connection-status", async () => {
        return {
            connected: isConnected,
            hasWindow: loginWindow && !loginWindow.isDestroyed()
        };
    });

    ipcMain.handle("show-login-window", async () => {
        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.show();
            loginWindow.focus();
            return { success: true };
        }
        return { success: false, error: 'Login window not available' };
    });

    ipcMain.handle("navigate-to-printers", async () => {
        if (loginWindow && !loginWindow.isDestroyed()) {
            if (isConnected) {
                loginWindow.loadURL('https://admin.yala.menu/printer');
                loginWindow.show();
                loginWindow.focus();
                return { success: true };
            } else {
                return { success: false, error: 'Not connected to Yala Menu' };
            }
        }
        return { success: false, error: 'Login window not available' };
    });
}

// ========== AUTO-UPDATER ==========
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    dialog.showMessageBox({
        type: 'info',
        title: 'تحديث متاح / Update Available',
        message: `نسخة جديدة متاحة: ${info.version}\nNew version available: ${info.version}`,
        buttons: ['تحديث الآن / Update Now', 'لاحقاً / Later']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.downloadUpdate();
        }
    });
});

autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    dialog.showMessageBox({
        type: 'info',
        title: 'جاهز للتثبيت / Ready to Install',
        message: 'تم تحميل التحديث. سيتم التثبيت عند إعادة تشغيل التطبيق.\nUpdate downloaded. Will install on restart.',
        buttons: ['إعادة التشغيل الآن / Restart Now', 'لاحقاً / Later']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });
});

autoUpdater.on('error', (err) => {
    console.error('Update error:', err);
});

// ========== APP LIFECYCLE ==========
app.whenReady().then(async () => {
    createTray();
    createServer();
    registerIPCHandlers();
    if (config.yalaConnected) {
        createLoginWindow({ hidden: true });
    }

    // Enable auto-launch on first run
    try {
        const isEnabled = await autoLauncher.isEnabled();
        if (!isEnabled) {
            await autoLauncher.enable();
            console.log('✓ Auto-launch enabled on first run');
        }
    } catch (err) {
        console.log('Auto-launch setup error:', err);
    }

    console.log('🍽️ YallaMenu Print Manager started');

    // Show settings window on first run
    checkFirstRun();
    setTimeout(() => {
        console.log('🔍 Checking for updates on startup...');
        autoUpdater.checkForUpdates();
    }, 2000);
});

// ========== FIRST RUN DETECTION ==========
function checkFirstRun() {
    const firstRunFlag = path.join(app.getPath('userData'), 'first-run-complete');

    if (!fs.existsSync(firstRunFlag)) {
        // First time running - show settings window
        console.log('First run detected - opening settings window');
        createSettingsWindow();

        // Create flag file so we know it's not the first run anymore
        fs.writeFileSync(firstRunFlag, new Date().toISOString(), 'utf8');

        // Show welcome notification
        showDesktopNotification(
            '🍽️ YallaMenu Print Manager',
            'Welcome! The server is running in your system tray.\n' +
            'Right-click the printer icon to access settings.',
            false
        );
    } else {
        // Not first run
        if (wasAutoStarted) {
            // Auto-started with Windows - stay in tray
            console.log('Server auto-started in system tray');
            showDesktopNotification(
                '✓ Print Server Running',
                `Server: ${getLocalIP()}:${PORT}`,
                false
            );
        } else {
            // Manually opened - show settings window
            console.log('Server manually opened - showing settings');
            createSettingsWindow();
        }
    }
}

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
    app.isQuitting = true;
    // Close login window on quit
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.destroy();
    }
});
