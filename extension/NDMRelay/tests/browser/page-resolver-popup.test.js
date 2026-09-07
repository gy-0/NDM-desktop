const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) }); });
test.after(async () => { await browser?.close(); });
async function fixture(t, url = 'https://www.bilibili.com/video/BV1test?p=3&spm_id_from=fixture', mediaCount = 0) {
    const page = await browser.newPage({ viewport: { width: 292, height: 600 } });
    t.after(() => page.close());
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales/zh_CN/messages.json')));
    await page.route('**/*', async route => {
        const name = new URL(route.request().url()).pathname.slice(1) || 'popup.html';
        if (!['popup.html', 'popup.css', 'popup.js', 'site-adapters.js'].includes(name)) return route.fulfill({ status: 404, body: '' });
        await route.fulfill({ path: path.join(root, name) });
    });
    await page.addInitScript(({ messages, url, mediaCount }) => {
        window.__requests = []; window.__closed = false; window.__url = url;
        window.close = () => { window.__closed = true; };
        window.WebSocket = class { close() {} };
        window.chrome = {
            i18n: { getUILanguage: () => 'zh_CN', getMessage: (key, substitutions) => key === 'popupVersion' ? 'NDM Relay · v' + (substitutions?.[0] || 'test') : messages[key]?.message || '' },
            runtime: { lastError: null, getManifest: () => ({ version: '1.4.5' }), sendMessage(request, callback) {
                if (request.type === 'relay:getState') return callback({ connected: true, mediaCount, catcherEnabled: true, resources: [] });
                if (request.type === 'relay:resolvePage') { if (window.__throwSend) throw Error('context invalidated'); window.__requests.push(request); window.__reply = callback; }
            } },
            tabs: { query: (_, callback) => callback([{ id: 17, url: window.__url }]) }
        };
    }, { messages, url, mediaCount });
    await page.goto('https://fixture.example/popup.html');
    return page;
}
test('zero-media page offers explicit parse; no automatic dispatch, duplicate click or fake native acknowledgement', async t => {
    const page = await fixture(t);
    assert.equal(await page.locator('#page-resolver-card').isVisible(), true);
    assert.equal(await page.evaluate(() => __requests.length), 0);
    await page.locator('#resolve-page').click();
    await page.evaluate(() => document.getElementById('resolve-page').click());
    assert.equal(await page.evaluate(() => __requests.length), 1);
    assert.equal(await page.locator('#resolve-page').getAttribute('aria-busy'), 'true');
    assert.match(await page.evaluate(() => __requests[0].expectedPageURL), /p=3/);
    await page.evaluate(() => __reply({ sent: true }));
    assert.equal(await page.locator('#page-resolver-feedback').innerText(), '请求已发送，请在 NDM 中查看。');
    assert.equal(await page.locator('#resolve-page').isDisabled(), true);
    assert.equal(await page.evaluate(() => __closed), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.NDM_QA_SCREENSHOTS) {
        await page.locator('body').screenshot({ path: process.env.NDM_QA_SCREENSHOTS + '/relay-page-sent.png' });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.locator('body').screenshot({ path: process.env.NDM_QA_SCREENSHOTS + '/relay-page-sent-dark.png' });
    }
});
test('failed send remains open and retryable; stale navigation updates target only after rejection', async t => {
    const page = await fixture(t);
    const button = page.locator('#resolve-page');
    await button.click();
    await page.evaluate(() => __reply({ sent: false, error: 'offline' }));
    assert.match(await page.locator('#page-resolver-feedback').innerText(), /请先打开 NDM/);
    assert.equal(await button.isEnabled(), true);
    await button.click();
    await page.evaluate(() => { __url = 'https://www.bilibili.com/video/BV1test?p=4'; __reply({ sent: false, error: 'navigation' }); });
    assert.match(await page.locator('#page-resolver-feedback').innerText(), /页面已变化/);
    await button.click();
    assert.match(await page.evaluate(() => __requests[2].expectedPageURL), /p=4$/);
    await page.evaluate(() => { chrome.runtime.lastError = { message: 'worker stopped' }; __reply(); chrome.runtime.lastError = null; });
    assert.equal(await button.isEnabled(), true);
    assert.equal(await page.evaluate(() => __closed), false);
    await page.evaluate(() => { __throwSend = true; });
    await button.click();
    assert.equal(await button.isEnabled(), true);
    assert.equal(await button.getAttribute('aria-busy'), 'false');
    assert.match(await page.locator('#page-resolver-feedback').innerText(), /未能发送/);
    if (process.env.NDM_QA_SCREENSHOTS) await page.locator('body').screenshot({ path: process.env.NDM_QA_SCREENSHOTS + '/relay-page-failure.png' });
});
test('ordinary pages and feeds do not offer proactive media parsing', async t => {
    for (const url of ['https://example.com/article', 'https://x.com/home', 'chrome://settings']) {
        const page = await fixture(t, url);
        assert.equal(await page.locator('#page-resolver-card').isVisible(), false);
        assert.equal(await page.evaluate(() => __requests.length), 0);
    }
});

test('known page with candidates has one primary entry, generic media keeps detected controls', async t => {
    const known = await fixture(t, 'https://www.youtube.com/watch?v=fixture', 4);
    assert.equal(await known.locator('#page-resolver-card').isVisible(), true);
    assert.equal(await known.locator('#media-card').isVisible(), false);
    const generic = await fixture(t, 'https://example.com/watch', 2);
    assert.equal(await generic.locator('#page-resolver-card').isVisible(), false);
    assert.equal(await generic.locator('#media-card').isVisible(), true);
});
