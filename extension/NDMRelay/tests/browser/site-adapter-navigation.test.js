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
