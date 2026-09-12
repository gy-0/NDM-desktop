const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pageURL = 'https://fixture.test/page.html?private=fixture';
const fileURL = 'https://fixture.test/archive.zip';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
    const events = {}, calls = [], sent = [], saved = {}, files = new Map(), tabs = new Map();
    const event = name => ({ addListener(listener) { events[name] = listener; } });
    const chrome = {
        action: { onClicked: event('action'), setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
        contextMenus: { onClicked: event('menu'), removeAll(cb) { cb(); }, create() {}, update() {} },
        cookies: { getAll(_, cb) { calls.push('cookies'); cb([{ domain: 'fixture.test', path: '/', name: 'session', value: 'synthetic-cookie', session: true }]); } },
        downloads: { onCreated: event('created'), async search({ id }) { return files.has(id) ? [{ ...files.get(id) }] : []; },
            async pause(id) { calls.push(['pause', id]); files.get(id).paused = true; },
            async resume(id) { calls.push(['resume', id]); files.get(id).paused = false; },
            async cancel(id) { calls.push(['cancel', id]); files.get(id).state = 'interrupted'; },
            async erase({ id }) { calls.push(['erase', id]); files.delete(id); } },
        runtime: { lastError: null, onConnect: event('connect'), onMessage: event('message') }, i18n: { getMessage: () => '' },
        storage: { local: { get(_, cb) { cb({}); }, set(_, cb) { cb?.(); } },
            session: { async get() { return structuredClone(saved); }, async set(value) { calls.push('persist'); Object.assign(saved, structuredClone(value)); } } },
        tabs: { query(_, cb) { cb([]); }, remove() { assert.fail('deferred download must never close a tab'); }, get(id, cb) { cb(tabs.get(id)); } },
        webNavigation: { onHistoryStateUpdated: event('history'), onCommitted: event('committed'),
            getFrame({ tabId, frameId }, cb) { const port = engine.g[[tabId, frameId]]; cb(port ? { url: port['2'], documentId: port.documentId } : null); } },
        webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred', 'onHeadersReceived'].map(name => [name, event(name)]))
    };
    const globals = { chrome, URL, Headers, TextEncoder, unescape, crypto: require('node:crypto').webcrypto, AbortController,
        WebSocket: class { constructor() { this.readyState = 0; } }, importScripts() {}, setTimeout, clearTimeout,
        NDMBrowserHandoff: require('../browser-handoff.js'), NDMClickHandoff: require('../click-handoff.js'),
        NDMRelayMediaPolicy: require('../media-policy.js'), NDMRelayResourcePolicy: require('../resource-policy.js'),
        NDMRelaySessionCookies: require('../session-cookies.js'), NDMRelaySiteAdapters: require('../site-adapters.js') };
    vm.runInNewContext(fs.readFileSync(require.resolve('../bg.js'), 'utf8'), globals);
    const engine = globals.NDM_BG;
    await Promise.all([engine.browserHandoffs.ready, engine.clickHandoffs.ready, engine.clickHTTPAuthReadyPromise]); await tick();
    t.after(() => { engine.browserHandoffs.dispose(); engine.clickHandoffs.dispose(); clearTimeout(engine.bridgeRetryTimer); clearTimeout(engine.deferredFileTimer); });
    engine.D = true; engine.G = { readyState: 1, send(value) { if (value.startsWith('NDMRelayDownload:')) sent.push(JSON.parse(value.slice('NDMRelayDownload:'.length))); } };
    engine.bridgeStatus = { durableHandoff: 1, safeFileRedirects: 1 };
    function port(tabId = 4, frameId = 0, url = pageURL) {
        const value = { id: `${tabId}:${frameId}`, tabId, frameId, documentId: `doc-${tabId}-${frameId}`, 2: url, 4: 'Fixture', postMessage() {} };
        engine.g[[tabId, frameId]] = value; engine.H[value.id] = value;
        if (frameId === 0) tabs.set(tabId, { id: tabId, url, incognito: false });
        return value;
    }
    const top = port();
    function response(overrides = {}, headers = [], responseHeaders) {
        const details = { requestId: 'request-fixture-1', url: fileURL, tabId: 4, frameId: 1, parentFrameId: 0,
            parentDocumentId: top.documentId, method: 'GET', type: 'sub_frame', ...overrides };
        events.onBeforeRequest(details);
        events.onBeforeSendHeaders({ ...details, requestHeaders: overrides.requestHeaders || [{ name: 'Referer', value: pageURL }, ...headers] });
        events.onHeadersReceived({ ...details, statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: [
            { name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: '1000000' },
            { name: 'Content-Disposition', value: 'attachment; filename="archive.zip"' }, ...(responseHeaders || [])] });
        return details;
    }
    async function flush() { await tick(); await engine.browserHandoffs.idle(); await tick(); await engine.browserHandoffs.idle(); }
    async function created(overrides = {}) {
        const download = { id: 12, url: fileURL, finalUrl: fileURL, referrer: pageURL, startTime: new Date().toISOString(), state: 'in_progress', paused: false, ...overrides };
        files.set(download.id, { ...download }); events.created(download); await flush(); return download;
    }
    return { engine, chrome, events, calls, sent, saved, files, tabs, top, port, response, created, flush };
}
const callsOf = (f, name) => f.calls.filter(value => Array.isArray(value) && value[0] === name);

test('eligible hidden-frame headers only record a bounded candidate and never start native or cookie preparation', async t => {
    const f = await fixture(t); const details = f.response();
    f.events.onCompleted(details); await f.flush();
    assert.equal(f.engine.deferredFileCandidates.size, 1); assert.equal(f.sent.length, 0);
    assert.equal(f.calls.includes('cookies'), false); assert.equal(callsOf(f, 'pause').length, 0);
});
test('a unique real DownloadItem uses its source context, cookie preparation and the durable native receipt', async t => {
    const f = await fixture(t); f.response(); await f.created();
    assert.equal(f.engine.deferredFileCandidates.size, 0); assert.equal(f.calls.includes('cookies'), true);
    assert.equal(f.sent.length, 1); assert.match(f.sent[0].payload, /Cookie: session=synthetic-cookie/);
    assert.match(f.sent[0].payload, /Referer: https:\/\/fixture.test\/page.html\?private=fixture\r\n/);
    assert.equal(callsOf(f, 'pause').length, 1); assert.equal(callsOf(f, 'cancel').length, 0);
    assert.equal(f.saved.ndmBrowserHandoffsV1[0].requiresSafeFileRedirects, true);
    f.engine.ea({ data: 'NDMRelayReceipt:' + JSON.stringify({ requestId: f.sent[0].requestId, status: 'accepted', taskId: 7 }) });
    await f.flush(); assert.equal(callsOf(f, 'cancel').length, 1); assert.equal(callsOf(f, 'erase').length, 1);
});
test('captured source headers stay authoritative over a later cookie lookup', async t => {
    const f = await fixture(t); f.response({}, [{ name: 'Cookie', value: 'actual=request-cookie' }, { name: 'X-Fixture', value: 'request-context' }]);
    await f.created(); assert.equal(f.calls.includes('cookies'), false);
    assert.match(f.sent[0].payload, /Cookie: actual=request-cookie/); assert.match(f.sent[0].payload, /X-Fixture: request-context/);
});
test('same-URL candidates in distinct tabs are ambiguous and all are consumed without touching Chrome', async t => {
    const f = await fixture(t); f.response(); const second = f.port(5);
    f.response({ requestId: 'second-request', tabId: 5, parentDocumentId: second.documentId });
    await f.created(); assert.equal(f.engine.deferredFileCandidates.size, 0);
    assert.equal(f.sent.length, 0); assert.equal(callsOf(f, 'pause').length, 0);
});
test('offline, unsafe hosts, disabled catcher and HTTP-auth sources leave the actual download unpaused', async t => {
    for (const change of [f => { f.engine.D = false; }, f => { f.engine.bridgeStatus.safeFileRedirects = 0; },
        f => { f.engine.v = false; }, f => { f.engine.clickHTTPAuthOrigins.add('https://fixture.test'); }]) {
        const f = await fixture(t); f.response(); change(f); await f.created();
        assert.equal(f.sent.length, 0); assert.equal(callsOf(f, 'pause').length, 0); assert.equal(f.calls.includes('cookies'), false);
    }
});
test('expired, old, completed, paused, wrong-referrer and incognito-mismatched downloads keep Chrome ownership', async t => {
    for (const overrides of [{ startTime: new Date(Date.now() - 6000).toISOString() }, { startTime: 'invalid' },
        { state: 'complete' }, { paused: true }, { referrer: 'https://fixture.test/' }, { incognito: true }]) {
        const f = await fixture(t); f.response(); await f.created(overrides);
        assert.equal(f.sent.length, 0); assert.equal(callsOf(f, 'pause').length, 0);
    }
    const f = await fixture(t); f.response(); f.engine.deferredFileCandidates.get('request-fixture-1').expiresAt = Date.now() - 1;
    await f.created(); assert.equal(f.engine.deferredFileCandidates.size, 0); assert.equal(f.sent.length, 0);
});
test('navigation or source-frame disconnection between headers and onCreated prevents preparation', async t => {
    for (const change of [f => { f.top.documentId = 'replacement-document'; }, f => { delete f.engine.g['4,0']; },
        f => { f.tabs.get(4).url = 'https://fixture.test/new-page'; }]) {
        const f = await fixture(t); f.response(); change(f); await f.created();
        assert.equal(f.sent.length, 0); assert.equal(callsOf(f, 'pause').length, 0);
    }
});
test('click fallback requests cannot leave deferred metadata for recapture', async t => {
    const f = await fixture(t); const details = f.response();
    f.events.onBeforeRequest({ ...details, requestId: 'fallback-replay' });
    f.engine.j['fallback-replay'].clickFallback = true;
    f.events.onHeadersReceived({ ...details, requestId: 'fallback-replay', statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: [] });
    await f.created(); assert.equal(f.engine.deferredFileCandidates.size, 0); assert.equal(f.sent.length, 0);
});
test('failed controller restore or initial persistence never pauses a newly matched Chrome download', async t => {
    for (const fault of ['restore', 'persist']) {
        const f = await fixture(t); f.response();
        if (fault === 'restore') { const failed = Promise.reject(Error('unread session')); failed.catch(() => {}); f.engine.browserHandoffs.ready = failed; }
        else f.chrome.storage.session.set = async value => { if (value.ndmBrowserHandoffsV1) throw Error('session unavailable'); };
        await f.created(); assert.equal(f.sent.length, 0); assert.equal(callsOf(f, 'pause').length, 0);
    }
});
test('other download attributes can prove their source document when Chrome omits the request Referer', async t => {
    for (const badDocument of [false, true]) {
        const f = await fixture(t), child = f.port(4, 1, 'https://fixture.test/frame.html');
        f.response({ type: 'other', documentId: badDocument ? 'other-document' : child.documentId, requestHeaders: [] });
        await f.created({ referrer: child['2'] });
        assert.equal(f.sent.length, badDocument ? 0 : 1);
        if (!badDocument) assert.match(f.sent[0].payload, /Referer: https:\/\/fixture.test\/frame.html\r\n/);
    }
});
test('a present request Referer must agree with the source document and cannot be replaced by DownloadItem metadata', async t => {
    const f = await fixture(t), child = f.port(4, 1, 'https://fixture.test/frame.html');
    f.response({ type: 'other', documentId: child.documentId, requestHeaders: [{ name: 'Referer', value: 'https://fixture.test/' }] });
    await f.created({ referrer: child['2'] }); assert.equal(f.sent.length, 0); assert.equal(callsOf(f, 'pause').length, 0);
});
test('percent-encoded filename line breaks cannot inject native protocol fields', async t => {
    const f = await fixture(t);
    const details = { requestId: 'filename-injection', url: fileURL, tabId: 4, frameId: 1, parentFrameId: 0,
        parentDocumentId: f.top.documentId, method: 'GET', type: 'sub_frame' };
    f.events.onBeforeRequest(details); f.events.onBeforeSendHeaders({ ...details, requestHeaders: [{ name: 'Referer', value: pageURL }] });
    f.events.onHeadersReceived({ ...details, statusLine: 'HTTP/1.1 200 OK', responseHeaders: [
        { name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: '1000000' },
        { name: 'Content-Disposition', value: "attachment; filename*=UTF-8''safe.zip%0D%0A2%3Ahttps%3A%2F%2Finvalid.test%2Fpayload.zip" }] });
    await f.created(); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.split('\r\n').filter(line => line.startsWith('2:')).length, 1);
    assert.match(f.sent[0].payload, /^1:GET\r\n2:https:\/\/fixture.test\/archive.zip\r\n/);
});
