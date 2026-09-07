const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) }); });
test.after(async () => { await browser?.close(); });
async function fixture(t) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
        const event = () => ({ addListener() {} });
        window.chrome = {
            action: { onClicked: event(), setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
            contextMenus: { onClicked: event(), removeAll(cb) { cb(); }, create() {}, update() {} },
            cookies: { getAll(_, cb) { cb([]); } }, downloads: { onCreated: event(), cancel() {}, erase() {} },
            runtime: { lastError: null, onConnect: event(), onMessage: event() },
            i18n: { getMessage() { return ''; } }, storage: { local: { get(_, cb) { cb({}); }, set() {} } },
            tabs: { query(_, cb) { cb([]); }, remove() {} }, webNavigation: { onHistoryStateUpdated: event() },
            webRequest: { onBeforeRequest: event(), onBeforeSendHeaders: event(), onCompleted: event(), onErrorOccurred: event(), onHeadersReceived: event() }
        };
        window.__sockets = []; window.__delivered = []; window.__dropped = []; window.__heads = [];
        window.WebSocket = class {
            constructor() { this.readyState = 0; __sockets.push(this); }
            send(message) {
                if (this.readyState === 0) throw new DOMException('Connecting', 'InvalidStateError');
                // Actual WebSocket semantics: CLOSING/CLOSED silently discard.
                (this.readyState === 1 ? __delivered : __dropped).push(message);
            }
            open() { this.readyState = 1; this.onopen?.({ target: this }); }
            close() { this.readyState = 3; this.onclose?.({ target: this }); }
        };
        window.fetch = () => new Promise((resolve, reject) => __heads.push({ resolve, reject }));
        window.importScripts = () => {};
    });
    for (const file of ['media-policy.js', 'resource-policy.js', 'site-adapters.js', 'bg.js']) await page.addScriptTag({ path: file === 'bg.js' && process.env.NDM_QA_BACKGROUND ? process.env.NDM_QA_BACKGROUND : path.join(root, file) });
    await page.evaluate(() => { NDM_BG.C = true; __sockets.at(-1).open(); });
    return page;
}
async function start(page) {
    await page.evaluate(() => { NDM_BG.relayWithCookies({ '1': 'GET', '2': 'https://fixture.invalid/file.zip', '6': 'normal' }); });
    await page.waitForFunction(() => __heads.length === 1);
}
async function settle(page) { await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30))); }
async function downloads(page) { return page.evaluate(() => __delivered.filter(message => message.startsWith('1:'))); }
test('worker retains intent when connection closes during HEAD and sends exactly once after reconnect', async t => {
    const page = await fixture(t); await start(page);
    await page.evaluate(() => { __sockets.at(-1).close(); __heads[0].resolve({ ok: true, headers: new Headers() }); });
    await settle(page);
    await page.evaluate(() => { NDM_BG.M(); __sockets.at(-1).open(); });
    // A repair may re-probe optional headers or reuse those already obtained.
    await settle(page);
    await page.evaluate(() => { for (const head of __heads.slice(1)) head.resolve({ ok: true, headers: new Headers() }); });
    await settle(page);
    assert.equal((await downloads(page)).length, 1, 'An accepted click must survive disconnect without duplication');
    assert.equal(await page.evaluate(() => __dropped.filter(message => message.startsWith('1:')).length), 0, 'Never send a download to a CLOSED socket');
});
for (const mode of ['rejected', 'non-2xx']) test(`optional HEAD ${mode} does not discard the download request`, async t => {
    const page = await fixture(t); await start(page);
    await page.evaluate(mode => {
        if (mode === 'rejected') __heads[0].reject(new TypeError('fixture HEAD blocked'));
        else __heads[0].resolve({ ok: false, status: 405, headers: new Headers() });
    }, mode);
    await settle(page);
    const sent = await downloads(page);
    assert.equal(sent.length, 1, 'HEAD metadata failure must still hand off the original request');
    assert.ok(sent[0].includes('2:https://fixture.invalid/file.zip\r\n'));
});
