const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const policy = require('../media-policy.js');
const bg = fs.readFileSync(require.resolve('../bg.js'), 'utf8');
const ct = fs.readFileSync(require.resolve('../ct.js'), 'utf8');
const pageURL = 'https://www.douyin.com/video/123456789';
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
    const events = {}, timers = new Map(), sent = [], tabs = new Map(), queries = [], cookieReads = [];
    let sequence = 0;
    const event = name => ({ addListener(listener) { events[name] = listener; } });
    const chrome = {
        action: { onClicked: event('action'), setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
        contextMenus: { onClicked: event('menu'), removeAll(cb) { cb(); }, create() {}, update() {} },
        cookies: {
            getAllCookieStores(cb) { cb([{ id: '0', tabIds: [...tabs.values()].filter(t => !t.incognito).map(t => t.id) }, { id: '1', tabIds: [...tabs.values()].filter(t => t.incognito).map(t => t.id) }]); },
            getPartitionKey({ tabId, frameId }, cb) { cb({ partitionKey: { topLevelSite: 'https://www.douyin.com', hasCrossSiteAncestor: frameId !== 0 } }); },
            getAll(details, cb) { cookieReads.push(plain(details)); cb([{ domain: 'fixture.example', path: '/', name: 'session',
                value: details.storeId + (details.partitionKey ? '-partition' : '-ordinary'), storeId: details.storeId,
                ...(details.partitionKey ? { partitionKey: details.partitionKey } : {}), secure: true, session: true }]); }
        },
        downloads: { onCreated: event('download'), cancel() {}, erase() {} },
        runtime: { lastError: null, onConnect: event('connect'), onMessage: event('message') },
        i18n: { getMessage: () => '' }, storage: { local: { get(_, cb) { cb({}); }, set() {} } },
        tabs: { query(query, cb) { queries.push(plain(query)); cb([...tabs.values()].filter(tab => tab.active)); }, remove() {}, get(id, cb) { cb(tabs.get(id)); } },
        webNavigation: { onHistoryStateUpdated: event('history'), onCommitted: event('committed'), getFrame({ tabId, frameId }, cb) {
            const port = engine.g[[tabId, frameId]]; cb(port && { url: port['2'], documentId: port.actualDocumentID || port.documentId });
        } },
        webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred', 'onHeadersReceived'].map(name => [name, event(name)]))
    };
    class Socket { constructor() { this.readyState = 0; } send(value) { sent.push(value); } }
    const context = { chrome, WebSocket: Socket, URL, Headers, unescape, crypto, AbortController, navigator: { userAgent: 'Chrome/123' },
        NDMRelayMediaPolicy: policy, NDMRelayResourcePolicy: require('../resource-policy.js'),
        NDMRelaySiteAdapters: require('../site-adapters.js'), NDMRelaySessionCookies: require('../session-cookies.js'),
        importScripts() {}, fetch: async () => { assert.fail('remote preparation must not issue legacy HEAD'); },
        setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); } };
    vm.runInNewContext(bg, context);
    const engine = context.NDM_BG;
    engine.D = true; engine.G = { readyState: 1, send(value) { sent.push(value); } };
    function addTab(id, options = {}) {
        const url = options.url || pageURL;
        tabs.set(id, { id, url, title: 'Video ' + id, active: options.active !== false, incognito: !!options.incognito });
        return addFrame(id, 0, url, options);
    }
    function addFrame(tabId, frameId, url, options = {}) {
        const port = { id: ++sequence, tabId, frameId, ja: frameId === 0, documentId: 'document-' + tabId + '-' + frameId,
            2: url, 4: 'Video ' + tabId, messages: [] };
        const contentMessages = [], c = { O: {}, window: { location: { href: url, host: new URL(url).host }, innerHeight: 900, innerWidth: 1440 }, navigator: { language: 'en' },
            crypto, Uint8Array, NDMRelayPolicy: policy, M: item => policy.describeCandidate(item),
            setTimeout: context.setTimeout, clearTimeout: context.clearTimeout };
        for (const name of ['N', 'mediaShelfCandidates', 'publishMediaShelf', 'downloadMediaSelection', 'oa']) {
            const start = ct.search(new RegExp('O\\.' + name + ' = (?:async )?function'));
            vm.runInNewContext(ct.slice(start, ct.indexOf('\n    };', start) + '\n    };'.length), c);
        }
        const items = options.items || [{ id: 1, 2: 'https://fixture.example/movie-' + tabId + '.mp4?token=secret-' + tabId,
            6: 'media', fEx: 'mp4', quality: '1080p', Authorization: 'Bearer auth-' + tabId }];
        const owner = Object.assign({ A: Object.fromEntries(items.map(item => [item.id, item])),
            i: { player: { items: items.map(item => item.id), m: { isConnected: true, getBoundingClientRect: () => ({ top: 0, left: 0, right: 640, bottom: 480 }) }, siteHasInlineUI: () => options.adapted !== false, mediaIsVisible: () => true } },
            getTitle: () => 'Video ' + tabId, port: { postMessage(message) { contentMessages.push(message); engine.ba(port, message); } } }, c.O);
        port.postMessage = message => {
            port.messages.push(message);
            if (message[0] === 26) owner.publishMediaShelf(message[1]);
            if (message[0] === 27) owner.downloadMediaSelection(message[1]);
            if (message[0] === 25) owner.relayReceipts.get(message[1].requestId)?.(message[1]);
        };
        engine.H[port.id] = port; engine.g[[tabId, frameId]] = port;
        owner.publishMediaShelf();
        return { port, owner, context: c, contentMessages };
    }
    async function rpc(op, extra = {}, socket = engine.G) {
        const requestId = crypto.randomUUID();
        await engine.handlePageMedia({ requestId, op, pageURL, ...extra }, socket); await tick();
        return responses().find(response => response.requestId === requestId);
    }
    function responses() { return sent.filter(value => value.startsWith('NDMRelayPageMediaResponse:')).map(value => JSON.parse(value.slice('NDMRelayPageMediaResponse:'.length))); }
    return { engine, chrome, events, sent, tabs, timers, queries, cookieReads, addTab, addFrame, rpc, responses };
}

test('discover inspects only active exact Douyin pages, exposes no transfer data, and leaves popup shelf empty', async () => {
    const f = fixture(), first = f.addTab(1), second = f.addTab(2, { incognito: true });
    f.addTab(3, { url: 'https://www.douyin.com/' }); f.addTab(4, { active: false }); f.addTab(5, { url: pageURL + '9' });
    const reply = await f.rpc('discover');
    assert.deepEqual(reply.sources.map(source => source.tabId), [1, 2]);
    assert.deepEqual(f.queries, [{ active: true }]); assert.equal(f.cookieReads.length, 0);
    assert.doesNotMatch(JSON.stringify(reply), /token=|Bearer|Authorization|movie-|https:\/\/fixture|cookies/);
    assert.equal(reply.sources[1].incognito, true); assert.equal(reply.sources[0].browser, 'chrome');
    assert.equal(reply.sources[0].documentID, first.port.documentId);
    assert.deepEqual(Object.keys(reply.sources[0].items[0]).sort(), ['badge', 'kind', 'mediaKey', 'meta', 'quality', 'title']);
    assert.equal(typeof reply.sources[0].items[0].quality, 'string');
    assert.equal(f.engine.mediaShelfForTab(1).length, 0); assert.equal(second.port.mediaCount, 0);
    assert.ok(first.contentMessages.filter(message => message[0] === 26).every(message => !JSON.stringify(message).includes('secret-')));
});
test('prepare returns exact BridgeProtocol once, retaining incognito partition routing without legacy send', async () => {
    const f = fixture(); f.addTab(1); f.addTab(2, { incognito: true });
    const source = (await f.rpc('discover')).sources[1]; f.engine.C = true;
    const result = await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey });
    assert.match(result.payload, /^1:GET\r\n2:https:\/\/fixture.example\/movie-2.mp4\?token=secret-2/);
    assert.match(result.payload, /6:media\r\n/); assert.match(result.payload, /Authorization: Bearer auth-2/);
    assert.match(result.payload, /Cookie: session=1-partition/); assert.doesNotMatch(result.payload, /auth-1|session=0/);
    assert.deepEqual(f.cookieReads.map(value => value.storeId), ['1', '1']);
    assert.equal(f.cookieReads[1].partitionKey.topLevelSite, 'https://www.douyin.com');
    assert.equal(f.sent.filter(value => value.startsWith('1:')).length, 0);
    assert.equal(f.engine.pendingRelayQueue.length, 0); assert.equal(f.engine.relayReservations.size, 0);
});
test('source from another tab or worker cannot select a version or prepare anything', async () => {
    const f = fixture(); f.addTab(1); f.addTab(2);
    const [a, b] = (await f.rpc('discover')).sources;
    assert.equal((await f.rpc('prepare', { sourceID: a.sourceID, mediaKey: b.items[0].mediaKey })).error, 'navigation');
    const other = fixture(); other.addTab(1);
    assert.equal((await other.rpc('prepare', { sourceID: a.sourceID, mediaKey: a.items[0].mediaKey })).error, 'unavailable');
    assert.equal(f.cookieReads.length + other.cookieReads.length, 0);
});
test('navigation, same URL document replacement, removed player and replaced version reject old handles', async () => {
    for (const change of ['navigation', 'document', 'port', 'player', 'version']) {
        const f = fixture(), c = f.addTab(1), source = (await f.rpc('discover')).sources[0];
        if (change === 'navigation') f.events.history({ tabId: 1, frameId: 0, url: pageURL + '9' });
        if (change === 'document') c.port.actualDocumentID = 'same-url-new-document';
        if (change === 'port') f.addFrame(1, 0, pageURL);
        if (change === 'player') c.owner.i.player.m.isConnected = false;
        if (change === 'version') c.owner.A[1]['2'] += '-replacement';
        const result = await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey });
        assert.ok(['navigation', 'unavailable'].includes(result.error), change); assert.equal(result.payload, undefined);
        assert.equal(f.cookieReads.length, 0);
    }
});
test('cookie completion after version change, same URL navigation, timeout or socket replacement cannot deliver payload', async () => {
    for (const change of ['version', 'navigation', 'timeout', 'socket']) {
        const f = fixture(), c = f.addTab(1), source = (await f.rpc('discover')).sources[0];
        const releases = []; f.chrome.cookies.getAll = (details, cb) => releases.push(cb);
        const pending = f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey }); await tick();
        assert.equal(releases.length, 2);
        if (change === 'version') c.owner.A[1].Authorization = 'Bearer replaced-same-url';
        if (change === 'navigation') c.port.actualDocumentID = 'new-document';
        if (change === 'timeout') f.timers.get(f.engine.mediaDownloadPending[1].timer)();
        if (change === 'socket') { f.engine.ca(); f.engine.G = { readyState: 1, send(value) { f.sent.push(value); } }; f.engine.D = true; }
        releases.forEach(cb => cb([])); await pending; await tick();
        assert.ok(f.responses().every(response => !response.payload), change);
        assert.equal(f.sent.filter(value => value.startsWith('1:')).length, 0);
        assert.equal(f.engine.pendingRelayQueue.length, 0); assert.equal(f.engine.relayReservations.size, 0);
    }
});
test('selected iframe uses its exact document and partition; replacing top document rejects it', async () => {
    const f = fixture(); f.addTab(1, { items: [] }); const frame = f.addFrame(1, 2, 'https://fixture.example/embed');
    const source = (await f.rpc('discover')).sources[0];
    const result = await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey });
    assert.match(result.payload, /Referer: https:\/\/fixture.example\/embed/);
    assert.equal(f.cookieReads[1].partitionKey.hasCrossSiteAncestor, true);
    f.engine.g[[1, 0]].actualDocumentID = 'top-replaced';
    assert.equal((await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey })).error, 'navigation');
    assert.equal(frame.port.documentId, 'document-1-2');
});
test('expired handles and old request IDs are refused, max sixteen sources stay bounded', async () => {
    const f = fixture(); for (let id = 1; id <= 18; id++) f.addTab(id);
    const reply = await f.rpc('discover'); assert.equal(reply.sources.length, 16); assert.equal(f.engine.pageMediaSources.size, 16);
    const source = reply.sources[0]; f.engine.pageMediaSources.get(source.sourceID).expiresAt = Date.now() - 1;
    assert.equal((await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey })).error, 'unavailable');
    await f.engine.handlePageMedia({ requestId: reply.requestId, op: 'discover', pageURL }, f.engine.G);
    assert.equal(f.responses().at(-1).error, 'busy');
    assert.deepEqual((await f.rpc('discover', { pageURL: pageURL + '99' })).sources, []);
    assert.equal((await f.rpc('discover', { pageURL: 'https://www.douyin.com/?modal_id=not-a-video' })).error, 'unsupported');
});
test('hung frame refresh discards old remote shelf and popup still follows original ordinary download', async () => {
    const f = fixture(), c = f.addTab(1, { adapted: false });
    const originalKey = c.port.mediaItems[0].mediaKey;
    await f.rpc('discover'); const originalPost = c.port.postMessage;
    c.port.postMessage = message => { if (message[0] !== 26) originalPost(message); };
    const pending = f.rpc('discover'); await tick();
    f.timers.get(f.engine.mediaShelfRefreshes['remote:1'].timer)();
    assert.deepEqual((await pending).sources, []);
    c.port.postMessage = originalPost;
    let receipt;
    f.engine.downloadMedia({ tabId: 1, expectedPageURL: pageURL, mediaKey: originalKey }, value => { receipt = value; }); await tick();
    assert.equal(receipt.sent, true); assert.equal(f.sent.filter(value => value.startsWith('1:')).length, 1);
});
test('wire requests are correlated and malformed/unsupported requests never query another page', async () => {
    const f = fixture(); f.addTab(1);
    const requestId = crypto.randomUUID();
    f.engine.ea({ data: 'NDMRelayPageMediaRequest:' + JSON.stringify({ requestId, op: 'discover', pageURL }) }); await tick();
    assert.equal(f.responses()[0].requestId, requestId); assert.equal(f.responses()[0].sources.length, 1);
    f.engine.ea({ data: 'NDMRelayPageMediaRequest:{bad' });
    f.engine.ea({ data: 'NDMRelayPageMediaRequest:' + JSON.stringify({ requestId: 'not-an-id', op: 'discover', pageURL }) });
    f.engine.ea({ data: 'NDMRelayPageMediaRequest:' + JSON.stringify({ requestId: crypto.randomUUID(), op: 'createTask', pageURL }) });
    assert.equal(f.responses().length, 1); assert.equal(f.queries.length, 1);
    assert.equal((await f.rpc('discover', { pageURL: pageURL + '?modal_id=another-video' })).error, 'unsupported');
});
test('one tab preparation is busy until its matching receipt; unrelated content receipts cannot release it', async () => {
    const f = fixture(), c = f.addTab(1), source = (await f.rpc('discover')).sources[0];
    const originalPost = c.port.postMessage;
    c.port.postMessage = message => { if (message[0] !== 27) originalPost(message); };
    await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey });
    const pending = f.engine.mediaDownloadPending[1]; assert.ok(pending);
    assert.equal((await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey })).error, 'busy');
    f.engine.mediaDownloadReceipt({ tabId: 1 }, { requestId: pending.requestId, sent: true });
    f.engine.mediaDownloadReceipt(c.port, { requestId: pending.requestId + 1, sent: true });
    assert.equal(f.engine.mediaDownloadPending[1], pending);
    f.timers.get(pending.timer)(); assert.equal(f.responses().at(-1).error, 'timeout');
    assert.equal(f.engine.mediaDownloadPending[1], undefined); assert.equal(f.sent.filter(value => value.startsWith('1:')).length, 0);
});
test('offscreen or ambiguous visible feed players never become a guessed current video', async () => {
    const f = fixture(), c = f.addTab(1);
    c.owner.i.player.m.getBoundingClientRect = () => ({ top: 950, left: 0, right: 640, bottom: 1430 });
    assert.deepEqual((await f.rpc('discover')).sources, []);
    c.owner.i.player.m.getBoundingClientRect = () => ({ top: 0, left: 0, right: 640, bottom: 480 });
    c.owner.i.second = { ...c.owner.i.player };
    assert.deepEqual((await f.rpc('discover')).sources, []);
});
test('a throwing content port cannot retain the last successful remote shelf', async () => {
    const f = fixture(), c = f.addTab(1); await f.rpc('discover');
    c.port.postMessage = () => { throw Error('port closed'); };
    assert.deepEqual((await f.rpc('discover')).sources, []);
    assert.equal(c.port.remoteMediaItems.length, 0);
});
test('the original jingxuan modal share matches the canonical video and retains its exact tab URL', async () => {
    const f = fixture(), actual = 'https://www.douyin.com/jingxuan?modal_id=7684024843209051426';
    f.addTab(1, { url: actual }); f.addTab(2, { url: 'https://www.douyin.com/jingxuan?modal_id=999' });
    const reply = await f.rpc('discover', { pageURL: 'https://www.douyin.com/video/7684024843209051426' });
    assert.equal(reply.sources.length, 1); assert.equal(reply.sources[0].pageURL, actual);
    const source = reply.sources[0];
    const prepared = await f.rpc('prepare', { pageURL: actual, sourceID: source.sourceID, mediaKey: source.items[0].mediaKey });
    assert.match(prepared.payload, /5:https:\/\/www.douyin.com\/jingxuan\?modal_id=7684024843209051426\r\n/);
    for (const url of [actual + '&modal_id=999', 'https://www.douyin.com/jingxuan?modal_id=abc', pageURL + '?modal_id=999']) {
        assert.equal((await f.rpc('discover', { pageURL: url })).error, 'unsupported');
    }
});
test('legacy producer field 3 audio URLs cannot be listed or silently dropped by remote preparation', async () => {
    const f = fixture(); f.addTab(1, { items: [{ id: 1, 2: 'https://fixture.example/video.m3u8', 3: 'https://fixture.example/audio.m3u8', fEx: 'mkv', quality: '1080p' }] });
    assert.deepEqual((await f.rpc('discover')).sources, []);
    const good = fixture(), c = good.addTab(1), source = (await good.rpc('discover')).sources[0], original = c.owner.oa;
    c.owner.oa = function(id, selection) {
        const item = this.A[id]; this.A[id] = { ...item, 3: 'https://fixture.example/audio.m3u8' };
        const pending = original.call(this, id, selection); this.A[id] = item; return pending;
    };
    const result = await good.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey });
    assert.equal(result.error, 'unsupported'); assert.equal(result.payload, undefined);
    assert.equal(good.sent.filter(value => value.startsWith('1:')).length, 0);
});
test('captured MIME size and real user agent survive remote and default no-HEAD legacy sends', async () => {
    for (const remote of [true, false]) {
        const f = fixture(), c = f.addTab(1, { adapted: remote, items: [{ id: 1, 2: 'https://fixture.example/movie.mp4',
            7: 789012, 8: 'video/mp4', 9: 'Mozilla/5.0 fixture-UA', fEx: 'mp4', quality: '1080p' }] });
        assert.equal(f.engine.C, false);
        let payload;
        if (remote) {
            const source = (await f.rpc('discover')).sources[0];
            payload = (await f.rpc('prepare', { sourceID: source.sourceID, mediaKey: source.items[0].mediaKey })).payload;
        } else {
            await c.owner.oa(1); payload = f.sent.find(value => value.startsWith('1:'));
        }
        assert.match(payload, /7:789012\r\n/); assert.match(payload, /8:video\/mp4\r\n/);
        assert.match(payload, /9:Mozilla\/5.0 fixture-UA\r\n/); assert.doesNotMatch(payload, /9:.*1080/);
    }
});
test('real adapted B captures without panels are readable only when matched to an actual media source', async () => {
    const f = fixture(), c = f.addTab(1), original = c.owner.A[1];
    c.owner.i = {}; c.owner.A = {}; c.owner.updateMediaCount = () => {};
    const media = { isConnected: true, currentSrc: original['2'], src: '', querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 640, bottom: 480, width: 640, height: 480 }) };
    c.context.document = { querySelectorAll: () => [media] };
    c.context.NDMRelaySiteAdapters = require('../site-adapters.js');
    for (const name of ['B', 'adaptedMediaPlayers']) {
        const start = ct.search(new RegExp('O\\.' + name + ' = (?:async )?function'));
        vm.runInNewContext(ct.slice(start, ct.indexOf('\n    };', start) + '\n    };'.length), c.context);
        c.owner[name] = c.context.O[name];
    }
    c.owner.B(original, pageURL, null, false);
    assert.equal(Object.keys(c.owner.i).length, 0, 'no legacy float or DOM mount is created');
    const found = (await f.rpc('discover')).sources;
    assert.equal(found.length, 1); assert.equal(found[0].items.length, 1);
    media.currentSrc = 'blob:https://www.douyin.com/unknown';
    assert.deepEqual((await f.rpc('discover')).sources, [], 'unbound cache entries must not be assigned to a guessed player');
});
