const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(process.env.NDM_SITE_ADAPTER_TEST_SOURCE || path.join(__dirname, '../../site-adapters.js'), 'utf8');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) }); });
test.after(async () => { await browser?.close(); });
async function fixture(t) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<style>.video-toolbar-right{display:flex;width:800px;height:44px;gap:12px;align-items:center}.video-toolbar-right-item{display:inline-flex}</style><video style="width:640px;height:360px"></video><div id="arc_toolbar_report"><div class="video-toolbar-right"><button id="native-note">Notes</button><div class="video-tool-more video-toolbar-right-item">More</div></div></div>' }));
    await page.goto('https://www.bilibili.com/video/BV1first');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
        window.__downloads = [];
        window.__manager = NDMRelaySiteAdapters.install({ onDownload: item => window.__downloads.push(item) });
        window.__manager.scanBilibili();
    });
    return page;
}

test('Bilibili stale button cannot hand off the previous video after SPA leaves its page', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        // Simulate the interval after history changes but before the old toolbar
        // is unmounted or Relay receives the navigation notification.
        history.pushState({}, '', '/');
        document.querySelector('[data-better-ndm-site-action="bilibili"]').click();
    });
    assert.equal(await page.evaluate(() => window.__downloads.length), 0, 'A stale toolbar must not send its captured old video URL');
    await page.evaluate(() => window.__manager.refresh());
    await page.waitForFunction(() => !document.querySelector('[data-better-ndm-site-action="bilibili-wrapper"]'));
    assert.equal(await page.locator('#native-note').count(), 1, 'Cleanup must preserve native toolbar controls');
});

test('Bilibili reused SPA toolbar hands off the current video once without duplicate entries', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        history.pushState({}, '', '/video/BV2second?spm_id_from=tracking');
        window.__manager.scanBilibili();
        window.__manager.scanBilibili();
        document.querySelector('[data-better-ndm-site-action="bilibili"]').click();
    });
    assert.equal(await page.locator('[data-better-ndm-site-action="bilibili"]').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__downloads.map(item => item.url)), ['https://www.bilibili.com/video/BV2second']);
});

test('Bilibili reused toolbar hands off the selected part after an in-page part switch', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        history.pushState({}, '', '/video/BV1first?p=3&spm_id_from=tracking');
        document.querySelector('[data-better-ndm-site-action="bilibili"]').click();
    });
    assert.deepEqual(await page.evaluate(() => window.__downloads.map(item => item.url)), ['https://www.bilibili.com/video/BV1first?p=3']);
});

test('Vimeo inline action retains synthetic unlisted player access context without console output', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const messages = [];
    page.on('console', event => messages.push(event.text()));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<video></video><div data-testid="video-actions"></div>' }));
    await page.goto('https://player.vimeo.com/video/123456?h=abcdef1234&autoplay=1');
    await page.addScriptTag({ content: source });
    const urls = await page.evaluate(() => {
        const downloads = [];
        const manager = NDMRelaySiteAdapters.install({ onDownload: item => downloads.push(item.url) });
        manager.scanVimeo();
        document.querySelector('[data-better-ndm-site-action="vimeo"]').click();
        return downloads;
    });
    assert.deepEqual(urls, ['https://vimeo.com/123456/abcdef1234']);
    assert.equal(messages.some(message => message.includes('abcdef1234')), false);
});


for (const example of [
    { site: 'vimeo', url: 'https://vimeo.com/123456', body: '<div data-testid="video-actions"></div>', method: 'scanVimeo' },
    { site: 'tiktok', url: 'https://www.tiktok.com/@creator/video/123456', body: '<section style="display:flex;flex-direction:column"><button>Like</button><button>Comment</button><button data-e2e="share-icon">Share</button></section>', method: 'scanTikTok' },
    { site: 'douyin', url: 'https://www.douyin.com/video/123456', body: '<div data-e2e="video-action-bar"></div>', method: 'scanDouyin' }
]) {
    test(example.site + ' stale native action cannot download the previous video after leaving its route', async t => {
        const page = await browser.newPage();
        t.after(() => page.close());
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<video></video>' + example.body }));
        await page.goto(example.url);
        await page.addScriptTag({ content: source });
        const downloads = await page.evaluate(example => {
            window.__downloads = [];
            const manager = NDMRelaySiteAdapters.install({ onDownload: item => window.__downloads.push(item.url) });
            manager[example.method]();
            history.pushState({}, '', '/');
            document.querySelector('[data-better-ndm-site-action="' + example.site + '"]').click();
            manager[example.method]();
            return { downloads: window.__downloads, remaining: document.querySelectorAll('[data-better-ndm-site-action="' + example.site + '"]').length };
        }, example);
        assert.deepEqual(downloads, { downloads: [], remaining: 0 });
    });
}

test('Instagram feed action is a native-sized plain icon and resolves its own article', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<article><video></video><a href="/reel/second/">Time</a><section><div role="button"><svg style="color:rgb(20,30,40)"></svg></div><div role="button">Share</div></section></article>' }));
    await page.goto('https://www.instagram.com/reel/first/');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
        window.__downloads = [];
        const manager = NDMRelaySiteAdapters.install({ onDownload: item => window.__downloads.push(item.url) });
        manager.scanInstagram();
    });
    const action = page.locator('[data-better-ndm-site-action="instagram"]');
    const appearance = await action.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight, background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
    assert.deepEqual(appearance, { width: 40, height: 40, background: 'rgba(0, 0, 0, 0)', color: 'rgb(20, 30, 40)' });
    await action.click();
    assert.deepEqual(await page.evaluate(() => window.__downloads), ['https://www.instagram.com/reel/second/']);
});

test('YouTube Shorts gets one native rail entry belonging to the active short', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<ytd-reel-video-renderer><div id="actions"></div></ytd-reel-video-renderer><ytd-reel-video-renderer is-active><video></video><div id="actions"></div></ytd-reel-video-renderer>' }));
    await page.goto('https://www.youtube.com/shorts/first');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
        window.__downloads = [];
        const manager = NDMRelaySiteAdapters.install({ onDownload: item => window.__downloads.push(item.url) });
        manager.scanYouTube();
        manager.scanYouTube();
        history.pushState({}, '', '/shorts/second');
    });
    assert.equal(await page.locator('[data-better-ndm-site-action="youtube"]').count(), 1);
    const action = page.locator('ytd-reel-video-renderer[is-active] [data-better-ndm-site-action="youtube"]');
    assert.deepEqual(await action.evaluate(el => [el.offsetWidth, el.offsetHeight]), [48, 48]);
    await action.click();
    assert.deepEqual(await page.evaluate(() => window.__downloads), ['https://www.youtube.com/shorts/second']);
});


test('X reply feed resolves the article video instead of the open status page or nested quote', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<article data-testid="tweet"><video></video><article><a href="/quoted/status/999">Quoted</a></article><a href="/reply/status/222">Time</a><div role="group"><button data-testid="reply"><svg></svg></button></div></article>' }));
    await page.goto('https://x.com/original/status/111');
    await page.addScriptTag({ content: source });
    const downloads = await page.evaluate(() => {
        const downloads = [];
        const manager = NDMRelaySiteAdapters.install({ onDownload: item => downloads.push(item.url) });
        manager.scanX();
        document.querySelector('[data-better-ndm-site-action="x"]').click();
        return downloads;
    });
    assert.deepEqual(downloads, ['https://x.com/reply/status/222']);
});
