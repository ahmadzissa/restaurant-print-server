'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { dashboardPageState, isAllowedNavigation } = require('../remote-print');

test('dashboard and Google auth navigation use exact HTTPS origins', () => {
    for (const url of ['https://admin.yala.menu/dashboard', 'https://accounts.google.com/o/oauth2/auth']) {
        assert.equal(isAllowedNavigation(url), true, url);
    }
    for (const url of [
        'https://admin.yala.menu.evil.test/dashboard',
        'https://evil.test/?admin.yala.menu',
        'https://admin.yala.menu@evil.test/',
        'https://user:password@admin.yala.menu/',
        'http://admin.yala.menu/dashboard',
        'https://admin.yala.menu:8443/',
        'file:///secret',
        'javascript:alert(1)',
        'not a url'
    ]) {
        assert.equal(isAllowedNavigation(url), false, url);
    }
});

test('logout, expired sessions and authentication do not count as a connected dashboard', () => {
    assert.equal(dashboardPageState('https://admin.yala.menu/dashboard'), 'dashboard');
    assert.equal(dashboardPageState('https://admin.yala.menu/settings#printersSettings'), 'dashboard');
    assert.equal(dashboardPageState('https://admin.yala.menu/login?next=/dashboard'), 'signed-out');
    assert.equal(dashboardPageState('https://admin.yala.menu/logout'), 'signed-out');
    assert.equal(dashboardPageState('https://admin.yala.menu/register'), 'signed-out');
    assert.equal(dashboardPageState('https://admin.yala.menu/auth/google/callback'), 'authenticating');
    assert.equal(dashboardPageState('https://accounts.google.com/'), 'external');
});

const preload = fs.readFileSync(path.join(__dirname, '../device-preload.js'), 'utf8');

function runPreload(origin, isMainFrame) {
    const exposed = [];
    vm.runInNewContext(preload, {
        require: name => {
            assert.equal(name, 'electron');
            return { contextBridge: { exposeInMainWorld: (key, value) => exposed.push({ key, value }) } };
        },
        process: { isMainFrame, argv: ['electron', '--yala-print-device-name=Demo%20Kitchen%20PC'] },
        window: { location: { origin } }
    });
    return exposed;
}

test('isolated preload exposes only device metadata to the trusted top-level dashboard', () => {
    const exposed = runPreload('https://admin.yala.menu', true);
    assert.equal(exposed.length, 1);
    assert.equal(exposed[0].key, 'YalaPrintDevice');
    assert.deepEqual(JSON.parse(JSON.stringify(exposed[0].value)), { platform: 'windows', name: 'Demo Kitchen PC' });
});

test('preload exposes no native bridge in subframes or external pages', () => {
    assert.deepEqual(runPreload('https://admin.yala.menu', false), []);
    assert.deepEqual(runPreload('https://accounts.google.com', true), []);
    assert.deepEqual(runPreload('https://admin.yala.menu.evil.test', true), []);
    assert.deepEqual(runPreload('null', true), []);
});