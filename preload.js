const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printerAPI", {
    getPrinters: () => ipcRenderer.invoke("get-printers"),
    testPrint: (printerName, paperWidth) => ipcRenderer.invoke("test-print", printerName, paperWidth),
    getServerStatus: () => ipcRenderer.invoke("get-server-status"),
    getAutoLaunchStatus: () => ipcRenderer.invoke("get-autolaunch-status"),
    setAutoLaunch: (enabled) => ipcRenderer.invoke("set-autolaunch", enabled),
    saveConfig: (config) => ipcRenderer.invoke("save-config", config),
    getConfig: () => ipcRenderer.invoke("get-config"),
    changePort: (newPort) => ipcRenderer.invoke("change-port", newPort),
    getPrintQueue: () => ipcRenderer.invoke("get-print-queue"),
    showNotification: (title, message) => ipcRenderer.invoke("show-notification", title, message),
    onPrintJobUpdate: (callback) => ipcRenderer.on("print-job-update", callback),
    removeJob: (jobId) => ipcRenderer.invoke("remove-job", jobId),
    clearFailedJobs: () => ipcRenderer.invoke("clear-failed-jobs"),
    onPrinterStatusChange: (callback) => ipcRenderer.on("printer-status-change", callback)
});
