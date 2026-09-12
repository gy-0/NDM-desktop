const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) }); });
test.after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
    const language = options.language || 'zh_CN';
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
    t.after(() => page.close());
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', language, 'messages.json')));
    await page.route('**/*', async route => {
        const name = new URL(route.request().url()).pathname.slice(1) || 'popup.html';
        if (!['popup.html', 'popup.css', 'popup.js', 'site-adapters.js'].includes(name) && !name.startsWith('fonts/')) return route.fulfill({ status: 404, body: '' });
        await route.fulfill({ path: path.join(root, name) });
    });
    await page.addInitScript(({ messages, language, options }) => {
        window.__requests = []; window.__replies = []; window.__closed = false;
        window.__tab = { id: 17, url: options.url || 'https://example.com/watch', title: options.title || 'A film about the sea' };
        window.__state = { connected: true, mediaCount: 1, catcherEnabled: true, resources: [], mediaItems: options.items || [{ mediaKey: 'top:film', title: '1080p 视频', meta: 'MP4 · 24 MB', host: 'media.example.com', badge: '首选', kind: 'video' }] };
        window.close = () => { window.__closed = true; };
        window.WebSocket = class { close() {} };
        window.chrome = {
            i18n: { getUILanguage: () => language, getMessage: (key, substitutions) => {
                const entry = messages[key]; let text = entry?.message || '';
                for (const [name, placeholder] of Object.entries(entry?.placeholders || {})) {
                    const value = placeholder.content.replace(/\$(\d+)/g, (_, index) => substitutions?.[Number(index) - 1] || '');
                    text = text.replace(new RegExp('\\$' + name + '\\$', 'gi'), value);
                }
                return text;
            } },
            runtime: { lastError: null, getManifest: () => ({ version: 'test' }), sendMessage(request, callback) {
                if (request.type === 'relay:getState') { if (window.__holdRefresh) { window.__refreshReply = callback; return; } return callback(window.__state); }
                if (request.type === 'relay:toggleCatcher') { window.__toggleReply = callback; return; }
                if (request.type === 'relay:downloadMedia') { window.__requests.push(request); window.__replies.push(callback); }
            } },
            tabs: { query: (_, callback) => { if (window.__holdQuery) { window.__queryReply = callback; return; } callback([window.__tab]); } }
        };
    }, { messages, language, options });
    await page.clock.install();
    await page.goto('https://fixture.example/popup.html');
    return page;
}

test('direct media handoff is deliberate, blocks duplicate clicks, and preserves sent state on refresh', async t => {
    const page = await fixture(t);
    const button = page.locator('.media-download');
    assert.equal(await page.locator('.media-meta').innerText(), 'MP4 · 24 MB');
    assert.equal(await page.locator('#media-fallback').isHidden(), true);
    assert.equal(await page.evaluate(() => __requests.length), 0);
    await button.click();
    await page.evaluate(() => document.querySelector('.media-download').click());
    assert.equal(await page.evaluate(() => __requests.length), 1);
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#refresh-page').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => __requests[0]), { type: 'relay:downloadMedia', tabId: 17, mediaKey: 'top:film', expectedPageURL: 'https://example.com/watch' });
    await page.evaluate(() => __replies[0]({ sent: true }));
    assert.equal(await page.locator('.media-feedback').innerText(), '请求已发送，请在 NDM 中查看。');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.evaluate(() => __closed), false);
    await page.locator('#refresh-page').click();
    assert.equal(await page.locator('.media-download').isDisabled(), true);
    assert.equal(await page.locator('.media-row').getAttribute('data-state'), 'sent');
    assert.equal(await page.evaluate(() => __requests.length), 1);
});

test('offline errors stay visible and retryable; a timeout cannot be overwritten by a late acknowledgement', async t => {
    const page = await fixture(t);
    const button = page.locator('.media-download');
    await button.click();
    await page.evaluate(() => __replies[0]({ sent: false, error: 'offline' }));
    assert.equal(await button.isEnabled(), true);
    assert.match(await page.locator('.media-feedback').innerText(), /请先打开 NDM/);
    assert.equal(await page.locator('.media-feedback').getAttribute('role'), 'status');
    await button.click();
    await page.clock.fastForward(6501);
    assert.equal(await button.isEnabled(), true);
    const timeout = await page.locator('.media-feedback').innerText();
    assert.match(timeout, /超时|未响应|未能确认/);
    await page.evaluate(() => __replies[1]({ sent: true }));
    assert.equal(await page.locator('.media-feedback').innerText(), timeout);
    await button.click();
    await page.evaluate(() => __replies[1]({ sent: true }));
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    await page.evaluate(() => __replies[2]({ sent: true }));
    assert.equal(await page.locator('.media-row').getAttribute('data-state'), 'sent');
    assert.equal(await page.evaluate(() => __closed), false);
});

test('a changed source page gets a new request identity after explicit refresh', async t => {
    const page = await fixture(t);
    await page.locator('.media-download').click();
    await page.evaluate(() => { __tab.url = 'https://example.com/watch-next'; __replies[0]({ sent: false, error: 'navigation' }); });
    assert.match(await page.locator('.media-feedback').innerText(), /页面已变化/);
    await page.locator('#refresh-page').click();
    await page.locator('.media-download').click();
    assert.equal(await page.evaluate(() => __requests[1].expectedPageURL), 'https://example.com/watch-next');
});

test('known video pages keep one parse action; old content scripts retain the floating-panel fallback', async t => {
    const known = await fixture(t, { url: 'https://www.youtube.com/watch?v=fixture' });
    assert.equal(await known.locator('#page-resolver-card').isVisible(), true);
    assert.equal(await known.locator('#media-card').isHidden(), true);
    const legacy = await fixture(t, { items: [] });
    assert.equal(await legacy.locator('#media-fallback').isVisible(), true);
    assert.equal(await legacy.locator('#show-panel').isEnabled(), true);
});

test('long multilingual content stays within fixed width and keyboard actions retain visible focus', async t => {
    const items = Array.from({ length: 12 }, (_, i) => ({ mediaKey: 'long:' + i, title: ('非常长的电影名称 A Long Film Title ').repeat(8), meta: 'MP4 · 1080p · 1.2 GB', host: 'media.example.com', kind: 'video' }));
    for (const language of ['zh_CN', 'en']) {
        const page = await fixture(t, { language, title: '一段很长的页面标题 A long page title '.repeat(20), items });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
        const list = await page.locator('.discoveries').evaluate(el => ({ overflow: getComputedStyle(el).overflowY, height: el.clientHeight, scrollHeight: el.scrollHeight }));
        assert.equal(list.overflow, 'auto');
        assert.ok(list.scrollHeight > list.height);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#refresh-page').evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('.media-download').first().evaluate(el => el === document.activeElement), true);
        assert.notEqual(await page.locator('.media-download').first().evaluate(el => getComputedStyle(el).outlineStyle), 'none');
        if (process.env.NDM_QA_SCREENSHOTS) {
            await page.locator('body').screenshot({ path: path.join(process.env.NDM_QA_SCREENSHOTS, 'relay-long-' + language + '.png') });
            await page.emulateMedia({ colorScheme: 'dark' });
            await page.locator('body').screenshot({ path: path.join(process.env.NDM_QA_SCREENSHOTS, 'relay-long-' + language + '-dark.png') });
        }
    }
});

test('refresh locks selection before tab lookup and until the current state has been read', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { __holdRefresh = true; __holdQuery = true; });
    await page.locator('#refresh-page').click();
    await page.evaluate(() => document.querySelector('.media-download').click());
    assert.equal(await page.evaluate(() => __requests.length), 0);
    await page.evaluate(() => __queryReply([__tab]));
    assert.equal(await page.locator('.media-download').isDisabled(), true);
    await page.evaluate(() => document.querySelector('.media-download').click());
    assert.equal(await page.evaluate(() => __requests.length), 0);
    await page.evaluate(() => __refreshReply(__state));
    assert.equal(await page.locator('.media-download').isEnabled(), true);
});

test('an older refresh response cannot overwrite a newly saved catcher preference', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { __holdRefresh = true; });
    await page.locator('#refresh-page').click();
    await page.locator('#catcher').click();
    await page.evaluate(() => __toggleReply({ saved: true, catcherEnabled: false }));
    assert.equal(await page.locator('#catcher').getAttribute('aria-checked'), 'false');
    await page.evaluate(() => __refreshReply({ ...__state, catcherEnabled: true }));
    assert.equal(await page.locator('#catcher').getAttribute('aria-checked'), 'false');
});
