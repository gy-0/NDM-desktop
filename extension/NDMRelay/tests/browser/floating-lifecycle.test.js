const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Real DOM/Shadow DOM fixture. No network, browser profile, extension host or downloads.
const source = fs.readFileSync(process.env.NDM_QA_CONTENT_SCRIPT || path.join(__dirname, '../../ct.js'), 'utf8');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NDM_QA_BROWSER ? { executablePath: process.env.NDM_QA_BROWSER } : {}) }); });
test.after(async () => { await browser?.close(); });
async function fixture(t) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><section id="player"><video controls style="width:640px;height:360px"></video></section><button id="outside">Outside</button></main>' }));
    await page.goto('https://fixture.example/watch/one');
    await page.evaluate(() => {
        window.chrome = { runtime: { connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }) } };
    });
    await page.addScriptTag({ content: source.replace('\n    new P\n', '\n    window.__relay = new P\n') });
    await page.evaluate(() => {
        const relay = window.__relay;
        relay.A[1] = { id: 1, 2: 'https://fixture.example/file.mp4', fEx: 'mp4', fS: 1000, 4: 'Fixture video' };
        window.__panel = new N(relay, document.querySelector('video'), 1);
        window.__panel.L(1);
    });
    return page;
}

test('floating affordance follows hidden ancestors and detached players without waking them', async t => {
    const page = await fixture(t);
    const host = page.locator('#neatDiv1');
    assert.equal(await host.isVisible(), true);
    await page.evaluate(() => document.querySelector('#player').style.visibility = 'hidden');
    await host.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__panel.wake());
    assert.equal(await host.isVisible(), false);
    await page.evaluate(() => document.querySelector('#player').style.visibility = '');
    await host.waitFor({ state: 'visible' });
    await page.locator('.ndm-launcher').click();
    assert.equal(await page.locator('.ndm-surface').isVisible(), true);
    await page.evaluate(() => document.querySelector('video').remove());
    await host.waitFor({ state: 'hidden' });
});

test('float can reopen after an inline action temporarily suppressed it', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        window.__inline = true;
        window.__panel.siteHasInlineUI = () => window.__inline;
        window.__panel.render();
    });
    await page.locator('#neatDiv1').waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.__inline = false; window.__panel.render(); });
    await page.locator('.ndm-launcher').click();
    assert.equal(await page.locator('.ndm-surface').isVisible(), true);
    assert.equal(await page.locator('.ndm-media-item').count(), 1);
});

test('keyboard opens choices and Escape returns focus without reopening on player movement', async t => {
    const page = await fixture(t);
    const badge = page.locator('.ndm-launcher');
    await badge.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#neatDiv1').shadowRoot.activeElement?.classList.contains('ndm-media-item'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#neatDiv1').shadowRoot.activeElement?.classList.contains('ndm-launcher'));
    await page.locator('video').dispatchEvent('mousemove');
    await page.evaluate(() => window.__panel.render());
    assert.equal(await page.locator('.ndm-surface').isVisible(), false);
});

test('SPA reset cleans every panel even if its first host was removed by the page', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        window.__second = new N(window.__relay, document.querySelector('video'), 2);
        window.__second.L(1);
        window.__panel.h.remove();
        window.__relay.za();
    });
    assert.equal(await page.locator('[id^="neatDiv"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ panels: Object.keys(window.__relay.i), media: Object.keys(window.__relay.A), listeners: window.__panel.listeners.length })), { panels: [], media: [], listeners: 0 });
    await page.evaluate(() => document.querySelector('#player').hidden = true);
    assert.equal(await page.locator('[id^="neatDiv"]').count(), 0);
});

test('new media discoveries preserve the focused download identity and Escape remains usable', async t => {
    const page = await fixture(t);
    await page.locator('.ndm-launcher').focus();
    await page.keyboard.press('Enter');
    await page.locator('.ndm-media-item').waitFor();
    await page.locator('.ndm-media-item').focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
        const relay = window.__relay;
        relay.A[2] = { id: 2, 2: 'https://fixture.example/second.mp4', fEx: 'mp4', fS: 2000, 4: 'Second video' };
        window.__panel.L(2);
    });
    assert.equal(await page.locator('.ndm-media-item').first().evaluate(el => el === el.getRootNode().activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ndm-surface').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#neatDiv1').shadowRoot.activeElement?.classList.contains('ndm-launcher'));
});

test('background media refresh never steals focus from the page', async t => {
    const page = await fixture(t);
    await page.locator('.ndm-launcher').click();
    await page.locator('#outside').focus();
    await page.evaluate(() => window.__panel.render());
    assert.equal(await page.locator('#outside').evaluate(el => el === document.activeElement), true);
});

test('reordering choices retains resource identity and removal gives a usable fallback', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        window.__relay.A[2] = { id: 2, 2: 'https://fixture.example/second.mp4', fEx: 'mp4', fS: 2000, 4: 'Second video' };
        window.__panel.L(2);
        window.__panel.showAlternatives = true;
        window.__panel.render();
    });
    await page.locator('.ndm-launcher').click();
    await page.locator('[data-resource-id="2"]').focus();
    await page.evaluate(() => { window.__panel.items.reverse(); window.__panel.render(); });
    assert.equal(await page.locator('[data-resource-id="2"]').evaluate(el => el === el.getRootNode().activeElement), true);
    await page.evaluate(() => { window.__panel.items = [1]; window.__panel.render(); });
    assert.equal(await page.locator('[data-resource-id="1"]').evaluate(el => el === el.getRootNode().activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ndm-surface').isVisible(), false);
});

test('refresh retains the alternatives toggle without moving focus into a download', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        window.__relay.A[2] = { id: 2, 2: 'https://fixture.example/second.mp4', fEx: 'mp4', fS: 2000, 4: 'Second video' };
        window.__panel.L(2);
    });
    await page.locator('.ndm-launcher').click();
    await page.locator('.ndm-alternatives').focus();
    await page.evaluate(() => window.__panel.render());
    assert.equal(await page.locator('.ndm-alternatives').evaluate(el => el === el.getRootNode().activeElement), true);
});
