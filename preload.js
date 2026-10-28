const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printerAPI", {
    // Existing printer methods
    getPrinters: () => ipcRenderer.invoke("get-printers"),
    testPrint: (printerName, paperWidth) => ipcRenderer.invoke("test-print", printerName, paperWidth),

    // Server methods
    getServerStatus: () => ipcRenderer.invoke("get-server-status"),
    changePort: (newPort) => ipcRenderer.invoke("change-port", newPort),

    // Auto-launch methods
    getAutoLaunchStatus: () => ipcRenderer.invoke("get-autolaunch-status"),
    setAutoLaunch: (enabled) => ipcRenderer.invoke("set-autolaunch", enabled),

    // Config methods
    saveConfig: (config) => ipcRenderer.invoke("save-config", config),
    getConfig: () => ipcRenderer.invoke("get-config"),

    // Print queue methods
    getPrintQueue: () => ipcRenderer.invoke("get-print-queue"),
    removeJob: (jobId) => ipcRenderer.invoke("remove-job", jobId),
    clearFailedJobs: () => ipcRenderer.invoke("clear-failed-jobs"),

    // Notification methods
    showNotification: (title, message) => ipcRenderer.invoke("show-notification", title, message),

    // Version
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Event listeners
    onPrintJobUpdate: (callback) => ipcRenderer.on("print-job-update", callback),
    onPrinterStatusChange: (callback) => ipcRenderer.on("printer-status-change", callback),

    // ========== YALA MENU CONNECTION METHODS (NEW) ==========
    connectToYala: () => ipcRenderer.invoke("connect-to-yala"),
    disconnectFromYala: () => ipcRenderer.invoke("disconnect-from-yala"),
    getConnectionStatus: () => ipcRenderer.invoke("get-connection-status"),
    showLoginWindow: () => ipcRenderer.invoke("show-login-window"),
    onConnectionStatusChanged: (callback) => ipcRenderer.on("connection-status-changed", callback),
    navigateToSection: (section) => ipcRenderer.invoke("navigate-to-section", section)
});
