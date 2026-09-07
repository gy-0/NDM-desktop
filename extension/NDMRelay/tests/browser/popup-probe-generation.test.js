const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../../popup.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../../popup.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) }); });
test.after(async () => { await browser?.close(); });
async function fixture(t) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(html);
    await page.evaluate(() => {
        let clock = 0, nextID = 1;
        const timers = new Map();
        window.setTimeout = (fn, delay) => { const id = nextID++; timers.set(id, { at: clock + delay, fn }); return id; };
        window.clearTimeout = id => timers.delete(id);
        window.advance = duration => {
            const end = clock + duration;
            for (;;) {
                const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                clock = next[1].at; timers.delete(next[0]); next[1].fn();
            }
            clock = end;
        };
        window.sockets = []; window.removedTabs = []; window.createdTabs = [];
        window.WebSocket = class {
            constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
            close() { this.readyState = 3; this.onclose?.(); }
            open() { this.readyState = 1; this.onopen?.(); }
            fail() { this.onerror?.(); }
        };
        window.chrome = {
            i18n: { getMessage: () => '', getUILanguage: () => 'en' },
            runtime: { getManifest: () => ({ version: 'test' }), sendMessage: (request, callback) => {
                if (request.type === 'relay:openApp') callback({ connected: false });
                if (request.type === 'relay:getState') callback({ connected: false, resources: [] });
            } },
            tabs: { query: (_, callback) => callback([]), create: (options, callback) => {
                createdTabs.push(options); callback({ id: 71 });
            }, remove: (id, callback) => { removedTabs.push(id); callback?.(); } }
        };
    });
    await page.addScriptTag({ content: source });
    return page;
}
const state = page => page.locator('#status').getAttribute('data-state');
test('new launch success cannot be overwritten by old probe retry/watchdog', async t => {
    const page = await fixture(t);
    await page.evaluate(() => sockets[0].fail()); // Original chain queues a retry.
    await page.locator('#open-app').click();
    await page.evaluate(() => sockets[1].open());
    assert.equal(await state(page), 'connected');
    assert.deepEqual(await page.evaluate(() => removedTabs), [71]);
    await page.evaluate(() => advance(30000));
    assert.equal(await state(page), 'connected');
    assert.equal(await page.evaluate(() => sockets.length), 2);
    assert.deepEqual(await page.evaluate(() => removedTabs), [71]);
});
test('initial chain still rotates to legacy endpoint and settles connected', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { sockets[0].fail(); advance(550); });
    assert.match(await page.evaluate(() => sockets[1].url), /:10007\//);
    await page.evaluate(() => { sockets[1].open(); advance(30000); });
    assert.equal(await state(page), 'connected');
    assert.deepEqual(await page.evaluate(() => removedTabs), []);
});
test('initial watchdog exhaustion still reports offline', async t => {
    const page = await fixture(t);
    await page.evaluate(() => advance(30000));
    assert.equal(await state(page), 'offline');
    assert.equal(await page.evaluate(() => sockets.length), 4);
});
