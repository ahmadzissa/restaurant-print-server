'use strict';

const { contextBridge } = require('electron');

if (process.isMainFrame && window.location.origin === 'https://admin.yala.menu') {
    const argument = process.argv.find(value => value.startsWith('--yala-print-device-name='));
    let name = 'Windows print station';
    if (argument) {
        try {
            name = decodeURIComponent(argument.slice('--yala-print-device-name='.length)).slice(0, 100) || name;
        } catch (_) {}
    }
    contextBridge.exposeInMainWorld('YalaPrintDevice', {
        platform: 'windows',
        name,
    });
}