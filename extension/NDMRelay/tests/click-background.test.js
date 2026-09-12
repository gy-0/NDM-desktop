const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const clicks = require('../click-handoff.js');
const pageURL = 'https://fixture.test/page.html', fileURL = 'https://fixture.test/archive.zip';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
    const events = {}, sent = [], saved = structuredClone(options.saved || {}), messages = [];
    const event = name => ({ addListener(listener) { events[name] = listener; } });
    const forbidden = () => assert.fail('early click must never touch Chrome download APIs');
    const chrome = {
        action: { onClicked: event('action'), setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
        contextMenus: { onClicked: event('menu'), removeAll(cb) { cb(); }, create() {}, update() {} },
        cookies: { getAll(_, cb) { cb([{ domain: 'fixture.test', path: '/', name: 'session', value: 'private-fixture', session: true }]); } },
        downloads: { onCreated: event('download'), cancel: forbidden, erase: forbidden, pause: forbidden, resume: forbidden },
        runtime: { lastError: null, onConnect: event('connect'), onMessage: event('message') },
        i18n: { getMessage: () => '' },
        storage: { local: { get(_, cb) { cb({}); }, set(_, cb) { cb?.(); } }, session: { async get(key) { if (key === 'ndmClickHTTPAuthOriginsV1') await options.authRead?.(); return structuredClone(saved); }, async set(value) { Object.assign(saved, structuredClone(value)); } } },
        tabs: { query(_, cb) { cb([]); }, remove: forbidden, get(_, cb) { cb({ url: pageURL }); } },
        webNavigation: { onHistoryStateUpdated: event('history'), onCommitted: event('committed'), getFrame(_, cb) { cb({ url: pageURL, documentId: 'document-fixture' }); } },
        webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred', 'onHeadersReceived'].map(name => [name, event(name)]))
    };
    const globals = { chrome, URL, Headers, TextEncoder, unescape, crypto: require('node:crypto').webcrypto, AbortController,
        WebSocket: class { constructor() { this.readyState = 0; } }, importScripts() {}, setTimeout(callback, delay) { if (options.immediateMedia && delay === 2000) { callback(); return 0; } return setTimeout(callback, delay); }, clearTimeout,
        NDMClickHandoff: clicks, NDMRelayMediaPolicy: require('../media-policy.js'), NDMRelayResourcePolicy: require('../resource-policy.js'),
        NDMRelaySessionCookies: require('../session-cookies.js'), NDMRelaySiteAdapters: require('../site-adapters.js') };
    vm.runInNewContext(fs.readFileSync(require.resolve('../bg.js'), 'utf8'), globals);
    const engine = globals.NDM_BG; await engine.clickHandoffs.ready; await tick(); t.after(() => { engine.clickHandoffs.dispose(); clearTimeout(engine.bridgeRetryTimer); });
    engine.D = true; engine.G = { readyState: 1, send(value) { sent.push(value); } }; engine.bridgeStatus = { durableHandoff: 1, safeFileRedirects: 1 };
    const port = { id: 1, tabId: 4, frameId: 0, documentId: 'document-fixture', ja: true, 2: pageURL, 4: 'Fixture', postMessage(message) { messages.push(message); } };
    engine.H[1] = port; engine.g['4,0'] = port;
    function policy(value) {
        events.onHeadersReceived({ requestId: 'document-request', tabId: 4, frameId: 0, type: 'main_frame', url: pageURL,
            responseHeaders: value === undefined ? [] : [{ name: 'Referrer-Policy', value }] });
        events.committed({ tabId: 4, frameId: 0, url: pageURL, documentId: port.documentId });
    }
    policy();
    const request = (overrides = {}) => ({ requestId: 'click-fixture-request-001', url: fileURL, filename: 'archive.zip', pageURL, ...overrides });
    async function click(overrides) { engine.ba(port, [28, request(overrides)]); await tick(); await engine.clickHandoffs.idle(); await tick(); }
    return { engine, chrome, events, port, sent, messages, request, click, policy, saved };
}
test('worker uses native committed receipt for an ordinary file click with cookies and referrer', async t => {
    const f = await fixture(t); assert.equal(f.engine.clickAvailable(f.port), true); await f.click();
    assert.equal(f.sent.length, 1); assert.ok(f.sent[0].startsWith('NDMRelayDownload:'));
    const envelope = JSON.parse(f.sent[0].slice('NDMRelayDownload:'.length));
    assert.match(envelope.payload, /Cookie: session=private-fixture/); assert.match(envelope.payload, /Referer: https:\/\/fixture.test\/page.html/);
    assert.match(envelope.payload, /3:archive.zip/); assert.match(envelope.payload, /6:normal/);
    assert.equal(f.messages.filter(message => message[1].requestId).at(-1)[1].status, 'pending');
    f.engine.ea({ data: 'NDMRelayReceipt:' + JSON.stringify({ requestId: envelope.requestId, status: 'accepted', taskId: 12 }) });
    await f.engine.clickHandoffs.idle(); assert.equal(f.messages.at(-1)[1].status, 'accepted');
});
test('worker independently rejects forged frame, document, origin, credentials and malformed fields', async t => {
    for (const override of [{ url: 'https://other.test/file.zip' }, { url: 'https://user:secret@fixture.test/file.zip' },
        { url: fileURL + '#hash' }, { url: fileURL + '?signature=x' }, { filename: 'x\r\nCookie: forged' }, { pageURL: pageURL + '/old' },
        { requestId: 'short' }, { url: 'javascript:alert(1)' }]) {
        const f = await fixture(t); await f.click(override);
        assert.equal(f.sent.length, 0); assert.equal(f.messages.at(-1)[1].status, 'fallback');
    }
    const f = await fixture(t); f.chrome.webNavigation.getFrame = (_, cb) => cb({ url: pageURL, documentId: 'replacement-document' });
    await f.click(); assert.equal(f.sent.length, 0); assert.equal(f.messages.at(-1)[1].reason, 'navigation');
});
test('explicit download accepts a signed same-origin URL and an extensionless filename hint', async t => {
    const f = await fixture(t); await f.click({ url: 'https://fixture.test/download?signature=fixture', filename: 'README', explicitDownload: true });
    assert.equal(f.sent.length, 1); assert.match(f.sent[0], /README/);
});
test('availability requires observed safe document policy and follows catcher/socket capability changes', async t => {
    const f = await fixture(t);
    for (const policy of ['no-referrer', 'origin', 'strict-origin', 'origin-when-cross-origin']) {
        f.policy(policy); assert.equal(f.engine.clickAvailable(f.port), false);
    }
    for (const policy of ['same-origin', 'strict-origin-when-cross-origin', 'unsafe-url', 'no-referrer, same-origin']) {
        f.policy(policy); assert.equal(f.engine.clickAvailable(f.port), true);
    }
    f.engine.clickPagePolicies = {}; f.engine.publishClickAvailability(); assert.equal(f.messages.at(-1)[1].available, false);
    f.policy(); f.engine.toggleCatcher(false); assert.equal(f.messages.at(-1)[1].available, false);
    f.engine.toggleCatcher(true); assert.equal(f.messages.at(-1)[1].available, true);
    f.engine.ca(); assert.equal(f.messages.at(-1)[1].available, false);
});
test('a page change during cookie capture prevents sending and returns a safe fallback', async t => {
    const f = await fixture(t); let release; f.chrome.cookies.getAll = (_, cb) => { release = cb; };
    f.engine.ba(f.port, [28, f.request()]); await tick();
    f.port['2'] = pageURL + '/next'; release([]); await tick(); await f.engine.clickHandoffs.idle();
    assert.equal(f.sent.length, 0); assert.equal(f.messages.at(-1)[1].status, 'fallback');
});
test('duplicate sent click after catcher off or policy loss never claims browser fallback', async t => {
    const f = await fixture(t); await f.click(); f.engine.v = false; f.engine.clickPagePolicies = {};
    await f.click(); assert.equal(f.sent.length, 1); assert.equal(f.messages.at(-1)[1].status, 'pending');
    f.engine.ba(f.port, [29, f.request()]); await tick(); await f.engine.clickHandoffs.idle();
    assert.equal(f.messages.at(-1)[1].ready, false);
});
test('fallback replay bypasses the legacy catcher across redirects, only in its original document', async t => {
    const f = await fixture(t); f.engine.v = false; await f.click(); f.engine.v = true;
    f.engine.ba(f.port, [29, f.request()]); await tick(); await f.engine.clickHandoffs.idle();
    assert.equal(f.messages.at(-1)[1].ready, true);
    let legacy = 0; f.engine.browserHandoffs = { begin() { legacy++; }, hasPending() { return false; } };
    const initial = { requestId: 'chrome-fallback-1', tabId: 4, frameId: 0, url: fileURL, type: 'main_frame', method: 'GET' };
    f.events.onBeforeRequest(initial);
    f.events.onHeadersReceived({ ...initial, statusLine: 'HTTP/1.1 302 Found', responseHeaders: [{ name: 'Location', value: 'https://cdn.test/final.zip' }] });
    f.events.onBeforeRequest({ ...initial, url: 'https://cdn.test/final.zip' });
    f.events.onHeadersReceived({ ...initial, url: 'https://cdn.test/final.zip', statusLine: 'HTTP/1.1 200 OK', responseHeaders: [{ name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: '1000000' }] });
    assert.equal(legacy, 0); assert.equal(f.sent.length, 0); assert.equal(f.engine.j[initial.requestId].clickFallback, true);
    f.events.onBeforeRequest({ ...initial, requestId: 'another-request', tabId: 5 });
    assert.equal(f.engine.j['another-request'].clickFallback, undefined);
});
test('new click referrer strips SPA fragments and sanitizes page-title control characters', async t => {
    const f = await fixture(t), url = pageURL + '#/route?secret=fixture';
    f.port['2'] = url; f.port['4'] = 'Fixture\r\nCookie: injected';
    f.chrome.tabs.get = (_, cb) => cb({ url }); f.chrome.webNavigation.getFrame = (_, cb) => cb({ url, documentId: f.port.documentId });
    await f.click({ pageURL: url });
    const envelope = JSON.parse(f.sent[0].slice('NDMRelayDownload:'.length));
    assert.match(envelope.payload, /Referer: https:\/\/fixture.test\/page.html\r\n/);
    assert.doesNotMatch(envelope.payload, /Referer: [^\r\n]*#/);
    assert.doesNotMatch(envelope.payload, /\r\nCookie: injected/);
});
test('duplicate Referrer-Policy fields honor the last recognized value', async t => {
    const f = await fixture(t);
    f.events.onHeadersReceived({ requestId: 'policy-request', tabId: 4, frameId: 0, type: 'main_frame', url: pageURL,
        responseHeaders: [{ name: 'Referrer-Policy', value: 'same-origin' }, { name: 'referrer-policy', value: 'no-referrer' }] });
    f.events.committed({ tabId: 4, frameId: 0, url: pageURL, documentId: f.port.documentId });
    assert.equal(f.engine.clickAvailable(f.port), false);
});
test('old or malformed redirect capability keeps early clicks in Chrome without changing legacy capability', async t => {
    for (const capability of [undefined, 0, true, '1']) {
        const f = await fixture(t);
        f.engine.ea({ data: 'NDMRelayStatus:' + JSON.stringify({ protocol: 1, expectedVersion: null,
            durableHandoff: 1, safeFileRedirects: capability }) });
        await f.engine.clickHandoffs.idle();
        assert.equal(f.engine.bridgeStatus.durableHandoff, 1);
        assert.equal(f.engine.clickBridgeReady(), false); assert.equal(f.messages.at(-1)[1].available, false);
        await f.click(); assert.equal(f.sent.length, 0); assert.equal(f.messages.at(-1)[1].status, 'fallback');
    }
});
test('pending click waits for safe redirect capability before replay, even with its page closed', async t => {
    const f = await fixture(t); await f.click();
    const original = f.sent[0]; delete f.engine.H[f.port.id]; delete f.engine.g['4,0'];
    f.engine.ea({ data: 'NDMRelayStatus:' + JSON.stringify({ protocol: 1, expectedVersion: null, durableHandoff: 1 }) });
    await f.engine.clickHandoffs.idle(); assert.equal(f.sent.length, 1); assert.equal(f.engine.clickHandoffs.hasPending(), true);
    f.engine.ea({ data: 'NDMRelayStatus:' + JSON.stringify({ protocol: 1, expectedVersion: null, durableHandoff: 1, safeFileRedirects: 1 }) });
    await f.engine.clickHandoffs.idle();
    assert.equal(f.engine.clickBridgeReady(), true); assert.equal(f.sent.length, 2); assert.equal(f.sent[1], original);
});
function authChallenge(f, overrides = {}) {
    f.events.onHeadersReceived({ requestId: 'auth-challenge', tabId: 4, frameId: 0, type: 'xmlhttprequest',
        method: 'HEAD', url: pageURL + '?private=fixture', statusCode: 401, statusLine: 'HTTP/1.1 401 Unauthorized',
        responseHeaders: [{ name: 'WWW-Authenticate', get value() { assert.fail('authentication challenge values must never be read'); } }], ...overrides });
}
test('observed HTTP auth disables early clicks and persists only origins without reading challenge values', async t => {
    const f = await fixture(t); authChallenge(f);
    assert.equal(f.engine.clickAvailable(f.port), false);
    assert.equal(f.engine.clickBridgeReady(), true);
    await f.engine.clickHTTPAuthWrites;
    assert.deepEqual(f.saved.ndmClickHTTPAuthOriginsV1, ['https://fixture.test']);
    f.policy(); assert.equal(f.engine.clickAvailable(f.port), false);
    await f.click(); assert.equal(f.sent.length, 0); assert.equal(f.messages.at(-1)[1].status, 'fallback');
});
test('HTTP auth origin knowledge restores before availability and survives successful cached responses', async t => {
    let release;
    const f = await fixture(t, { saved: { ndmClickHTTPAuthOriginsV1: ['https://fixture.test'] }, authRead: () => new Promise(resolve => { release = resolve; }) });
    assert.equal(f.engine.clickHTTPAuthReady, false); assert.equal(f.engine.clickAvailable(f.port), false);
    release(); await f.engine.clickHTTPAuthReadyPromise;
    f.policy(); assert.equal(f.engine.clickHTTPAuthReady, true); assert.equal(f.engine.clickAvailable(f.port), false);
    f.events.onHeadersReceived({ requestId: 'warm-page', tabId: 4, frameId: 0, type: 'main_frame', url: pageURL, statusCode: 200, responseHeaders: [] });
    assert.equal(f.engine.clickHTTPAuthOrigins.has('https://fixture.test'), true);
    f.port['2'] = 'https://unrelated.test/page';
    f.engine.captureClickPolicy({ tabId: 4, type: 'main_frame', url: f.port['2'], responseHeaders: [] });
    f.engine.commitClickPolicy({ tabId: 4, frameId: 0, documentId: f.port.documentId, url: f.port['2'] });
    assert.equal(f.engine.clickAvailable(f.port), true);
});
test('HTTP auth observation ignores proxy responses, missing challenges, invalid tabs and non-HTTP origins', async t => {
    const f = await fixture(t);
    for (const override of [{ statusCode: 407, statusLine: 'HTTP/1.1 407 Proxy Authentication Required' },
        { responseHeaders: [] }, { tabId: -1 }, { url: 'data:text/plain,fixture' }]) authChallenge(f, override);
    await f.engine.clickHTTPAuthWrites;
    assert.equal(f.engine.clickHTTPAuthOrigins.size, 0); assert.equal(f.engine.clickAvailable(f.port), true);
});
test('known browser HTTP auth preserves ordinary redirected downloads while resource and media discovery continue', async t => {
    const f = await fixture(t, { immediateMedia: true }); authChallenge(f);
    let legacy = 0; const resources = [], media = [];
    f.engine.browserHandoffs = { begin() { legacy++; return Promise.resolve({}); }, hasPending() { return false; } };
    f.engine.sendResource = item => resources.push(item); f.engine.A = item => media.push(item);
    const initial = { requestId: 'auth-download', tabId: 4, frameId: 0, url: fileURL, type: 'main_frame', method: 'GET' };
    f.events.onBeforeRequest(initial);
    f.events.onHeadersReceived({ ...initial, statusLine: 'HTTP/1.1 302 Found', responseHeaders: [] });
    f.events.onBeforeRequest({ ...initial, url: 'https://cdn.test/final.zip' });
    f.events.onHeadersReceived({ ...initial, url: 'https://cdn.test/final.zip', statusLine: 'HTTP/1.1 200 OK', responseHeaders: [{ name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: '1000000' }] });
    assert.equal(legacy, 0); assert.equal(f.sent.length, 0); assert.equal(resources.length, 1);
    assert.deepEqual(Object.keys(f.engine.blockedDownloadURLs), []);
    const clip = { ...initial, requestId: 'auth-media', type: 'media', url: 'https://fixture.test/clip.mp4' };
    f.events.onBeforeRequest(clip);
    f.events.onHeadersReceived({ ...clip, statusLine: 'HTTP/1.1 200 OK', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1000000' }] });
    assert.equal(media.length, 1); assert.equal(media[0]['2'], clip.url); assert.equal(legacy, 0);
});
test('a later auth challenge never gives a sent click a second browser owner', async t => {
    const f = await fixture(t); await f.click(); const original = f.sent[0]; authChallenge(f);
    await f.click(); assert.equal(f.messages.at(-1)[1].status, 'pending');
    f.engine.ea({ data: 'NDMRelayStatus:' + JSON.stringify({ protocol: 1, expectedVersion: null, durableHandoff: 1, safeFileRedirects: 1 }) });
    await f.engine.clickHandoffs.idle();
    assert.equal(f.sent.length, 2); assert.equal(f.sent[1], original);
    const envelope = JSON.parse(original.slice('NDMRelayDownload:'.length));
    f.engine.ea({ data: 'NDMRelayReceipt:' + JSON.stringify({ requestId: envelope.requestId, status: 'accepted', taskId: 12 }) });
    await f.engine.clickHandoffs.idle(); assert.equal(f.messages.at(-1)[1].status, 'accepted');
});
test('an auth challenge during preparation falls back before sending and can arm scoped browser replay', async t => {
    const f = await fixture(t); let release;
    f.chrome.cookies.getAll = (_, callback) => { release = callback; };
    f.engine.ba(f.port, [28, f.request()]); await tick(); authChallenge(f); release([]);
    await tick(); await f.engine.clickHandoffs.idle();
    assert.equal(f.sent.length, 0); assert.equal(f.messages.at(-1)[1].status, 'fallback');
    f.engine.ba(f.port, [29, f.request()]); await tick(); await f.engine.clickHandoffs.idle();
    assert.equal(f.messages.at(-1)[1].ready, true);
});
