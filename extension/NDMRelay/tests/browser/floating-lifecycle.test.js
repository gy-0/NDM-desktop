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
    await page.addScriptTag({ path: path.join(__dirname, '../../media-policy.js') });
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

test('floating request waits for acceptance, rejects visibly and permits explicit retry', async t=>{
    const page=await fixture(t);
    await page.evaluate(()=>{window.__requests=[]; __relay.port.postMessage=m=>__requests.push(m);});
    await page.locator('.ndm-launcher').click();
    await page.evaluate(()=>{__panel.Y(0);__panel.Y(0);});
    assert.equal(await page.evaluate(()=>__requests.filter(m=>m[0]===6).length),1);
    assert.equal(await page.locator('.ndm-surface').isVisible(),true);
    await page.evaluate(()=>{const request=__requests.find(m=>m[0]===6);__relay.relayReceipts.get(request[5])({sent:false,error:'queue-full'});});
    await page.waitForFunction(()=>!__panel.relayPending);
    assert.equal(await page.locator('.ndm-surface').isVisible(),true);
    assert.match(await page.locator('#ndm-relay-bridge-toast .msg').innerText(),/queue|请求/i);
    if(process.env.NDM_QA_ADMISSION_SCREENSHOT) {
        await page.locator('#ndm-relay-bridge-toast .wrap').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
        await page.screenshot({path:process.env.NDM_QA_ADMISSION_SCREENSHOT});
        await page.emulateMedia({colorScheme:'dark'});
        await page.screenshot({path:process.env.NDM_QA_ADMISSION_SCREENSHOT.replace('.png','-dark.png')});
    }
    await page.evaluate(()=>__panel.Y(0));
    assert.equal(await page.evaluate(()=>__requests.filter(m=>m[0]===6).length),2);
    await page.evaluate(()=>{const request=__requests.filter(m=>m[0]===6).at(-1);__relay.relayReceipts.get(request[5])({sent:true});});
});

test('4K streaming choices have one readable quality label and no playlist size', async t => {
    const page = await fixture(t);
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../media-policy.js'), 'utf8') });
    await page.evaluate(() => {
        NDMRelayPolicy = window.NDMRelayMediaPolicy;
        window.__relay.A[2] = { id: 2, 2: 'https://fixture.example/2160p.m3u8', 6: 'hls', fEx: 'ts', fS: 227 };
        window.__panel.L(2);
    });
    await page.locator('.ndm-launcher').click();
    const first = page.locator('.ndm-media-item').first();
    assert.match(await first.innerText(), /2160p/);
    assert.doesNotMatch(await first.innerText(), /227|\bTS\b/);
    assert.equal(await first.locator('.ndm-quality').count(), 0);
    assert.equal(await first.locator('.ndm-item-icon svg').count(), 1);
    const geometry = await first.locator('.ndm-item-title').evaluate(el => ({ width: el.clientWidth, textWidth: el.scrollWidth }));
    assert.ok(geometry.width >= geometry.textWidth, JSON.stringify(geometry));
    await page.locator('.ndm-surface').screenshot({ path: '/tmp/ndm-relay-live-picker.png' });
});


test('glass launcher is one transparent surface and panel dismisses without stealing the page click', async t => {
    const page = await fixture(t);
    const material = await page.locator('.ndm-launcher').evaluate(button => {
        const style = getComputedStyle(button);
        const mark = getComputedStyle(button.querySelector('.ndm-brand-mark'));
        return { background: style.backgroundColor, blur: style.backdropFilter, mark: mark.backgroundColor, size: [button.offsetWidth, button.offsetHeight] };
    });
    assert.match(material.background, /rgba\(.+, 0\.3\)/);
    assert.match(material.blur, /blur\(16px\)/);
    assert.equal(material.mark, 'rgba(0, 0, 0, 0)');
    assert.deepEqual(material.size, [32, 32]);
    await page.locator('.ndm-launcher').focus();
    await page.keyboard.press('Enter');
    await page.locator('.ndm-media-item').first().waitFor();
    await page.locator('#outside').click();
    assert.equal(await page.locator('.ndm-surface').isVisible(), false);
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#outside').evaluate(el => el === document.activeElement), true);
});

test('moving over overlaid player controls wakes the affordance without opening it', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { window.__panel.fade(1); });
    await page.waitForFunction(() => document.querySelector('#neatDiv1').style.opacity === '0');
    await page.locator('#player').dispatchEvent('pointermove');
    assert.equal(await page.locator('#neatDiv1').evaluate(el => el.style.opacity), '1');
    assert.equal(await page.locator('.ndm-surface').isVisible(), false);
});

test('glass picker stays readable over a changing video surface and honors reduced motion', async t => {
    const page = await fixture(t);
    await page.evaluate(async () => {
        document.body.style.margin = '0';
        document.querySelector('#player').style.cssText = 'width:640px;height:360px';
        const video = document.querySelector('video');
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, 640, 360);
        gradient.addColorStop(0, '#ddb679'); gradient.addColorStop(.43, '#677f9b');
        gradient.addColorStop(.68, '#222d50'); gradient.addColorStop(1, '#796f90');
        context.fillStyle = gradient; context.fillRect(0, 0, 640, 360);
        video.muted = true;
        video.srcObject = canvas.captureStream(12);
        await video.play();
    });
    await page.locator('video').dispatchEvent('mousemove');
    await page.screenshot({ path: '/tmp/ndm-relay-glass-launcher.png' });
    await page.locator('.ndm-launcher').click();
    assert.notEqual(await page.locator('.ndm-surface').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
    await page.locator('.ndm-surface').waitFor({ state: 'visible' });
    await page.screenshot({ path: '/tmp/ndm-relay-glass-picker.png', animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.ndm-surface').evaluate(el => getComputedStyle(el).animationName), 'none');
});
