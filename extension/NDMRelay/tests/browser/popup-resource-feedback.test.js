const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

async function fixture(t, language = 'zh_CN') {
    const page = await browser.newPage({ viewport: { width: 292, height: 600 } });
    t.after(() => page.close());
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', language, 'messages.json')));
    await page.route('**/*', async route => {
        const name = new URL(route.request().url()).pathname.slice(1) || 'popup.html';
        if (!['popup.html', 'popup.css', 'popup.js'].includes(name)) return route.fulfill({ status: 404, body: '' });
        await route.fulfill({ path: path.join(root, name) });
    });
    await page.addInitScript(({ messages, language }) => {
        window.__requests = [];
        window.__closed = false;
        window.close = () => { window.__closed = true; };
        window.WebSocket = class { close() {} };
        window.chrome = {
            i18n: { getUILanguage: () => language, getMessage: key => messages[key]?.message || '' },
            runtime: { lastError: null, getManifest: () => ({ version: 'test' }), sendMessage(request, callback) {
                if (request.type === 'relay:getState') return callback({ connected: false, mediaCount: 0, catcherEnabled: true, resources: [{ resourceKey: 'fixture-key', fileName: 'Research report.pdf', fEx: 'pdf', fS: 1024 }] });
                if (request.type === 'relay:downloadResource') { window.__requests.push(request); window.__reply = callback; }
            } },
            tabs: { query: (_, callback) => callback([{ id: 17 }]) }
        };
    }, { messages, language });
    await page.goto('https://fixture.example/popup.html');
    return page;
}

test('resource handoff failure is announced and can be retried without closing popup', async t => {
    const page = await fixture(t);
    const button = page.locator('.resource-download');
    await button.click();
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    await page.evaluate(() => window.__reply({ sent: false }));
    assert.equal(await button.isEnabled(), true);
    assert.match(await page.locator('.resource-feedback').innerText(), /刷新来源页面/);
    assert.equal(await page.locator('.resource-feedback').getAttribute('role'), 'status');
    await button.click();
    assert.equal(await page.evaluate(() => window.__requests.length), 2);
    await page.evaluate(() => { chrome.runtime.lastError = { message: 'No receiver' }; window.__reply(); chrome.runtime.lastError = null; });
    assert.match(await page.locator('.resource-feedback').innerText(), /未能发送请求/);
    assert.equal(await button.isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__closed), false);
});

test('page dispatch acknowledgement does not claim an app task or completed download', async t => {
    const page = await fixture(t, 'en');
    const button = page.locator('.resource-download');
    await button.click();
    await page.evaluate(() => window.__reply({ sent: true }));
    assert.equal(await button.innerText(), 'Sent');
    assert.equal(await button.getAttribute('aria-label'), 'Sent Research report.pdf');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.locator('.resource-feedback').innerText(), 'Request sent. Check NDM for the result.');
    assert.equal(await page.evaluate(() => window.__closed), false);
    assert.equal(await page.evaluate(() => window.__requests[0].resourceKey), 'fixture-key');
});
