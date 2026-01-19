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

// Handle Squirrel events for Windows installer
if (require('electron-squirrel-startup')) app.quit();

// ========== SINGLE INSTANCE LOCK ==========
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    dialog.showErrorBox(
        'Restaurant Print Server Already Running',
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

let PORT = 9100;
let tray = null;
let settingsWindow = null;
let serverApp = null;
let httpServer = null;
const printQueue = [];
const printerStatusCache = new Map();

// ========== CONFIG FILE ==========
const CONFIG_PATH = path.join(app.getPath('userData'), 'printer-config.json');

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
    name: 'Restaurant Print Server',
    path: app.getPath('exe'),
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
async function printJob(printerName, htmlContent, url, paperWidth = 80) {
    const jobId = Date.now();
    const queueItem = {
        id: jobId,
        printerName,
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
                contextIsolation: true
            }
        });

        // Adjust content based on paper width
        if (htmlContent && !htmlContent.includes("cut-spacing")) {
            const widthMm = `${paperWidth}mm`;
            htmlContent = htmlContent.replace(
                '<body',
                `<body style="width: ${widthMm}; max-width: ${widthMm}; margin: 0 auto;"`
            );
            htmlContent = htmlContent.replace("</body>", '<div class="cut-spacing" style="height: 30mm"></div></body>');
        }

        const loadPromise = url ?
            printWindow.loadURL(url) :
            printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(htmlContent));

        loadPromise.then(() => {
            setTimeout(() => {
                printWindow.webContents.print(
                    {
                        silent: true,
                        deviceName: printerName,
                        printBackground: true,
                        margins: { marginType: "none" }
                    },
                    async (success, failureReason) => {
                        printWindow.destroy();

                        queueItem.status = success ? 'completed' : 'failed';
                        queueItem.error = failureReason;
                        broadcastPrintQueueUpdate();

                        if (!success) {
                            const errorMsg = failureReason || "Print failed";
                            showDesktopNotification(
                                '❌ Print Job Failed',
                                `Printer: ${printerName}\nPaper: ${paperWidth}mm\nError: ${errorMsg}`,
                                true
                            );
                            return reject(new Error(errorMsg));
                        }

                        console.log(`✓ Print successful: ${printerName} (${paperWidth}mm)`);
                        const printerIp = resolvePrinterIp(printerName);

                        setTimeout(async () => {
                            await sendCutCommandRawTcp(printerIp, PRINTER_RAW_PORT);
                        }, 1200);

                        resolve({
                            success: true,
                            message: `Printed on ${paperWidth}mm paper (Windows) + Cut (RAW TCP)`
                        });
                    }
                );
            }, 500);
        }).catch((error) => {
            printWindow.destroy();
            queueItem.status = 'failed';
            queueItem.error = error.message;
            broadcastPrintQueueUpdate();

            showDesktopNotification(
                '❌ Print Job Failed',
                `Printer: ${printerName}\nPaper: ${paperWidth}mm\nError: ${error.message}`,
                true
            );
            reject(error);
        });
    });
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
            version: "3.0-Enhanced",
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

    serverApp.post("/print", async (req, res) => {
        try {
            const { printerName, content, url, paperWidth: requestedWidth } = req.body;
            if (!printerName) {
                return res.status(400).json({ success: false, error: "printerName is required" });
            }
            if (!content && !url) {
                return res.status(400).json({ success: false, error: "Either 'content' or 'url' is required" });
            }

            // Use requested width if provided, otherwise use configured width, default to 80mm
            const paperWidth = requestedWidth || config.printerPaperWidths[printerName] || 80;

            console.log(`📄 Printing to: ${printerName} (Paper: ${paperWidth}mm)${requestedWidth ? ' [Override]' : ' [Configured]'}`);

            const result = await printJob(printerName, content, url, paperWidth);
            res.json(result);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    httpServer = serverApp.listen(PORT, "0.0.0.0", () => {
        console.log(`\n✓ Server running:`);
        console.log(`  - Local: http://localhost:${PORT}`);
        console.log(`  - Network: http://${getLocalIP()}:${PORT}`);
        console.log(`✓ Default printer IP: ${PRINTER_IP_DEFAULT}:${PRINTER_RAW_PORT}\n`);
    });

    httpServer.on('error', (error) => {
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
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        },
        title: "Restaurant Print Server"
    });

    settingsWindow.once('ready-to-show', () => {
        settingsWindow.show();
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
    tray.setToolTip('Restaurant Print Server');

    tray.setContextMenu(
        Menu.buildFromTemplate([
            {
                label: `Server: ${getLocalIP()}:${PORT}`,
                enabled: false
            },
            {
                label: `RAW Cut: ${PRINTER_IP_DEFAULT}:${PRINTER_RAW_PORT}`,
                enabled: false
            },
            {
                type: "separator"
            },
            {
                label: "Open Settings",
                click: () => createSettingsWindow()
            },
            {
                label: "Auto-start",
                type: "checkbox",
                checked: false,
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
            {
                type: "separator"
            },
            {
                label: "Quit",
                click: () => {
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ])
    );

    tray.on("click", () => createSettingsWindow());

    autoLauncher.isEnabled().then((isEnabled) => {
        const menu = tray.getContextMenu();
        const autoStartItem = menu.items.find(item => item.label === "Auto-start");
        if (autoStartItem) autoStartItem.checked = isEnabled;
    }).catch(err => console.log('Auto-launch check error:', err));
}

function registerIPCHandlers() {
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

    ipcMain.handle("test-print", async (event, printerName, paperWidth = 80) => {
        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: ${paperWidth}mm auto; margin: 0; }
body {
    width: ${paperWidth}mm;
    font-family: monospace;
    margin: 0;
    padding: 10mm;
    font-size: 12pt;
}
h1 {
    text-align: center;
    border-top: 2px solid #000;
    border-bottom: 2px solid #000;
    padding: 5mm 0;
}
.line {
    border-top: 1px dashed #000;
    margin: 5mm 0;
}
.center { text-align: center; }
</style>
</head>
<body>
<h1>TEST PRINT</h1>
<div class="center"><strong>RESTAURANT PRINT SERVER</strong></div>
<div class="line"></div>
<p><strong>Printer:</strong> ${printerName}</p>
<p><strong>Paper Width:</strong> ${paperWidth}mm</p>
<p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
<div class="line"></div>
<div class="center">✓ Print OK ✓</div>
</body>
</html>`;

        try {
            const savedWidth = config.printerPaperWidths[printerName] || paperWidth;
            const r = await printJob(printerName, html, null, savedWidth);
            return { success: true, message: r.message };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle("get-server-status", () => ({
        running: true,
        port: PORT,
        url: `http://${getLocalIP()}:${PORT}`
    }));

    ipcMain.handle("get-autolaunch-status", async () => {
        try {
            return await autoLauncher.isEnabled();
        } catch {
            return false;
        }
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

    ipcMain.handle("check-updates", async () => {
        try {
            const result = await autoUpdater.checkForUpdates();
            return { success: true, version: result.updateInfo.version };
        } catch (error) {
            return { success: false, message: 'No updates available' };
        }
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

    // Check for updates after 3 seconds
    setTimeout(() => {
        autoUpdater.checkForUpdates();
    }, 3000);

    console.log('🍽️ Restaurant Print Server started');

    // Show settings window on first run
    checkFirstRun();
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
            '🍽️ Restaurant Print Server',
            'Welcome! The server is running in your system tray.\n' +
            'Right-click the printer icon to access settings.',
            false
        );
    } else {
        // Not first run - stay in tray
        console.log('Server started in system tray');

        // Optional: Show a subtle notification
        showDesktopNotification(
            '✓ Print Server Running',
            `Server: ${getLocalIP()}:${PORT}`,
            false
        );
    }
}

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => { app.isQuitting = true; });
