const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const policy = require('../media-policy.js');
const bg = fs.readFileSync(require.resolve('../bg.js'), 'utf8');
const ct = fs.readFileSync(require.resolve('../ct.js'), 'utf8');
const pageURL = 'https://fixture.example/watch';
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function methods(source, names, owner, context) {
    for (const name of names) {
        const start = source.search(new RegExp(owner + '\\.' + name + ' = (?:async )?function'));
        assert.ok(start >= 0, name + ' exists');
        const ending = owner === 'O' ? '\n    };' : '\n};';
        vm.runInNewContext(source.slice(start, source.indexOf(ending, start) + ending.length), context);
    }
}
function content(items, url = pageURL) {
    const sent = [], timers = new Map(); let sequence = 0;
    const context = { O: {}, window: { location: { href: url, host: new URL(url).host } },
        navigator: { language: 'en' }, crypto, Uint8Array, NDMRelayPolicy: policy,
        M: item => policy.describeCandidate(item),
        setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); } };
    methods(ct, ['N', 'mediaShelfCandidates', 'publishMediaShelf', 'downloadMediaSelection', 'oa'], 'O', context);
    const owner = Object.assign({ A: Object.fromEntries(items.map(item => [item.id, item])),
        i: { player: { items: items.map(item => item.id), m: { isConnected: true } } },
        getTitle: () => 'Fixture media', port: { postMessage(message) { sent.push(message); } } }, context.O);
    return { owner, context, sent, timers };
}
function worker(options = {}) {
    const events = {}, timers = new Map(), sent = [], ports = []; let sequence = 0;
    const event = name => ({ addListener(listener) { events[name] = listener; } });
    const chrome = {
        action: { onClicked: event('action'), setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
        contextMenus: { onClicked: event('menu'), removeAll(cb) { cb(); }, create() {}, update() {} },
        cookies: { getAll(details, cb) { cb([{ domain: 'fixture.example', path: '/', name: 'session', value: 'fixture-cookie', secure: true, session: true }]); } },
        downloads: { onCreated: event('download'), cancel() {}, erase() {} },
        runtime: { lastError: null, onConnect: event('connect'), onMessage: event('message') },
        i18n: { getMessage: () => '' }, storage: { local: { get(_, cb) { cb({}); }, set() {} } },
        tabs: { query(_, cb) { cb([]); }, remove() {}, get(_id, cb) { cb({ url: pageURL }); } },
        webNavigation: { onHistoryStateUpdated: event('history'), onCommitted: event('committed'),
            getFrame({ tabId, frameId }, cb) { const port = ports.find(port => port.tabId === tabId && port.frameId === frameId);
                cb(port && { url: port['2'], documentId: port.documentId }); } },
        webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred', 'onHeadersReceived'].map(name => [name, event(name)]))
    };
    class Socket { constructor() { this.readyState = 0; } send(value) { sent.push(value); } }
    const context = { chrome, WebSocket: Socket, URL, Headers, unescape, crypto, AbortController,
        NDMRelayMediaPolicy: policy, NDMRelayResourcePolicy: require('../resource-policy.js'),
        NDMRelaySiteAdapters: require('../site-adapters.js'), NDMRelaySessionCookies: require('../session-cookies.js'),
        importScripts() {}, fetch: options.fetch || (async () => ({ ok: false })),
        setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); } };
    vm.runInNewContext(bg, context);
    const engine = context.NDM_BG;
    engine.D = true; engine.G = { readyState: 1, send(value) { sent.push(value); } };
    function port(frameId = 0, url = pageURL, tabId = 7) {
        const value = { id: ports.length + 1, tabId, frameId, documentId: 'document-' + frameId,
            ja: frameId === 0, 2: url, messages: [], postMessage(message) { this.messages.push(message); } };
        ports.push(value); engine.H[value.id] = value; engine.g[[tabId, frameId]] = value; return value;
    }
    return { engine, events, context, chrome, sent, timers, port,
        request(key, overrides = {}) { const replies = []; events.message({ type: 'relay:downloadMedia', tabId: 7,
            mediaKey: key, expectedPageURL: pageURL, ...overrides }, {}, result => replies.push(result)); return replies; } };
}
function fixture(options = {}) {
    const w = worker(options), p = w.port(options.frameId || 0, options.frameURL || pageURL);
    const c = content(options.items || [{ id: 1, 2: 'https://fixture.example/movie.mp4?token=fixture-secret', fEx: 'mp4', 7: 10000000, 8: 'video/mp4', Authorization: 'Bearer fixture-auth' }], p['2']);
    c.owner.port.postMessage = message => { c.sent.push(message); w.engine.ba(p, message); };
    p.postMessage = message => {
        p.messages.push(message);
        if (message[0] === 26) c.owner.publishMediaShelf(message[1]);
        if (message[0] === 27) c.owner.downloadMediaSelection(message[1]);
        if (message[0] === 25) c.owner.relayReceipts.get(message[1].requestId)?.(message[1]);
    };
    c.owner.publishMediaShelf();
    return { ...w, p, c, key: p.mediaItems[0]?.mediaKey };
}

test('content publishes compact, credential-free choices with stable opaque handles', () => {
    const c = content([
        { id: 1, 2: 'https://fixture.example/movie.mp4?token=fixture-secret', fEx: 'mp4', quality: '1080p', cookies: 'session=private', Authorization: 'Bearer private' },
        { id: 2, 2: 'https://fixture.example/audio.m4a', fEx: 'm4a' },
        { id: 3, 2: 'https://fixture.example/chunk-123.m4s', fEx: 'm4s' }
    ]);
    c.owner.publishMediaShelf();
    const first = plain(c.sent[0][1]); assert.equal(first.items.length, 2);
    assert.equal(first.items[0].title, '1080p video'); assert.equal(first.items[1].kind, 'audio');
    assert.doesNotMatch(JSON.stringify(first.items), /fixture-secret|private|movie\.mp4|https:|cookies|Authorization/);
    c.owner.i.player.items.reverse(); c.owner.publishMediaShelf();
    assert.deepEqual(plain(c.sent[1][1].items), first.items);
    c.owner.A[1]['2'] = 'https://fixture.example/movie.mp4?token=replaced'; c.owner.publishMediaShelf();
    assert.notEqual(c.sent[2][1].items[0].mediaKey, first.items[0].mediaKey);
});
test('removed players and adapted-site panels never become selectable shelf rows', () => {
    const c = content([{ id: 1, 2: 'https://fixture.example/movie.mp4' }]);
    c.owner.i.player.m.isConnected = false; c.owner.publishMediaShelf(); assert.equal(c.sent[0][1].items.length, 0);
    c.owner.i.player.m.isConnected = true; c.owner.i.player.siteHasInlineUI = () => true;
    c.owner.publishMediaShelf(); assert.equal(c.sent[1][1].items.length, 0);
});
test('worker state exposes safe frame metadata, excludes other tabs and caps choices', () => {
    const w = worker(), top = w.port(), iframe = w.port(2, 'https://embed.example/player?session=private'), unrelated = w.port(0, pageURL, 8);
    for (const p of [top, iframe, unrelated]) w.engine.receiveMediaShelf(p, { pageURL: p['2'], items: Array.from({ length: 6 }, (_, i) => ({
        mediaKey: 'opaque-fixture-key-' + i, title: 'Video', meta: 'MP4', kind: 'video', quality: 720,
        cookies: 'private', url: 'https://fixture.example/private.mp4', Authorization: 'Bearer private' })) });
    const first = plain(w.engine.mediaShelfForTab(7)); assert.equal(first.length, 6);
    assert.ok(first.every(item => item.frameId === 0)); assert.doesNotMatch(JSON.stringify(first), /private|Authorization|cookies|contentKey|https:/);
    w.engine.receiveMediaShelf(top, { pageURL, items: [] });
    assert.equal(w.engine.mediaShelfForTab(7)[0].host, 'embed.example');
    let response; w.events.message({ type: 'relay:getState', tabId: 7 }, {}, value => { response = value; });
    w.timers.get(w.engine.mediaShelfRefreshes[7].timer)();
    assert.equal(response.mediaItems[0].frameId, 2);
});
test('unknown, stale-document and replaced-port snapshots are ignored', () => {
    const w = worker(), p = w.port();
    const snapshot = { pageURL, items: [{ mediaKey: 'opaque-fixture-key', title: 'Video', kind: 'video' }] };
    w.engine.receiveMediaShelf(p, { ...snapshot, pageURL: pageURL + '/old' }); assert.equal(p.mediaItems, undefined);
    p.mediaDocumentStale = true; w.engine.receiveMediaShelf(p, snapshot); assert.equal(p.mediaItems, undefined);
    p.mediaDocumentStale = false; w.port(); w.engine.receiveMediaShelf(p, snapshot); assert.equal(p.mediaItems, undefined);
});
test('selected media passes through oa, current-frame cookies and existing wire headers once', async () => {
    const f = fixture({ frameId: 2, frameURL: 'https://embed.example/player' });
    const replies = f.request(f.key); assert.equal(replies.length, 0);
    await tick();
    assert.equal(replies[0].sent, true); assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /2:https:\/\/fixture.example\/movie.mp4\?token=fixture-secret/);
    assert.match(f.sent[0], /Cookie: session=fixture-cookie/);
    assert.match(f.sent[0], /Authorization: Bearer fixture-auth/);
    assert.match(f.sent[0], /Referer: https:\/\/embed.example\/player/);
    assert.equal(f.engine.pendingRelayQueue.length, 0); assert.equal(f.engine.relayReservations.size, 0);
});
test('worker rejects offline, unknown key, changed tab and changed document before dispatch', () => {
    for (const reason of ['offline', 'unavailable', 'navigation', 'document']) {
        const f = fixture();
        if (reason === 'offline') f.engine.D = false;
        if (reason === 'navigation') f.chrome.tabs.get = (_, cb) => cb({ url: pageURL + '/next' });
        if (reason === 'document') f.chrome.webNavigation.getFrame = (_, cb) => cb({ url: pageURL, documentId: 'new-document' });
        const replies = f.request(reason === 'unavailable' ? 'unknown-key' : f.key);
        assert.equal(replies[0].error, reason === 'document' ? 'navigation' : reason);
        assert.equal(f.sent.length, 0); assert.equal(f.p.messages.filter(message => message[0] === 27).length, 0);
    }
});
test('duplicate requests are busy until a matching receipt or timeout releases the request', () => {
    const f = fixture(); f.p.postMessage = message => f.p.messages.push(message);
    const first = f.request(f.key), request = f.p.messages[0][1];
    assert.equal(f.request(f.key)[0].error, 'busy');
    f.engine.mediaDownloadReceipt({}, { requestId: request.requestId, sent: true }); assert.equal(first.length, 0);
    f.engine.mediaDownloadReceipt(f.p, { requestId: request.requestId + 1, sent: true }); assert.equal(first.length, 0);
    f.engine.mediaDownloadReceipt(f.p, { requestId: request.requestId, sent: false, error: 'queue-full' });
    assert.equal(first[0].error, 'queue-full');
    const second = f.request(f.key); const pending = f.engine.mediaDownloadPending[7];
    f.timers.get(pending.timer)(); assert.equal(second[0].error, 'timeout');
    assert.equal(f.engine.mediaDownloadPending[7], undefined);
});
test('page navigation and disconnect invalidate selections immediately, including same-URL reloads', () => {
    for (const change of ['history', 'committed', 'disconnect']) {
        const f = fixture(); f.p.postMessage = () => {};
        const replies = f.request(f.key);
        if (change === 'history') f.events.history({ tabId: 7, frameId: 0, url: pageURL + '/next' });
        if (change === 'committed') f.events.committed({ tabId: 7, frameId: 0, url: pageURL });
        if (change === 'disconnect') f.engine.aa(f.p);
        assert.equal(replies[0].error, change === 'disconnect' ? 'unavailable' : 'navigation');
        assert.equal(f.engine.mediaShelfForTab(7).length, 0);
        f.c.owner.publishMediaShelf();
        assert.equal(f.engine.mediaShelfForTab(7).length, 0);
    }
});
test('content rechecks the actual document and player immediately before invoking oa', async () => {
    for (const change of ['navigation', 'removed', 'source']) {
        const f = fixture();
        if (change === 'navigation') f.c.context.window.location.href += '/next';
        if (change === 'removed') f.c.owner.i.player.m.isConnected = false;
        if (change === 'source') f.c.owner.A[1]['2'] += '-changed';
        const replies = f.request(f.key); await tick();
        assert.equal(replies[0].error, change === 'navigation' ? 'navigation' : 'unavailable'); assert.equal(f.sent.length, 0);
    }
});
test('disconnection during cookie preparation returns failure and never queues a hidden send', async () => {
    const f = fixture(); let release;
    f.chrome.cookies.getAll = (_, cb) => { release = cb; };
    const replies = f.request(f.key); f.engine.D = false; f.engine.G.readyState = 3;
    release([]); await tick();
    assert.equal(replies[0].sent, false); assert.equal(replies[0].error, 'offline');
    assert.equal(f.sent.length, 0); assert.equal(f.engine.pendingRelayQueue.length, 0); assert.equal(f.engine.relayReservations.size, 0);
});
test('navigation or timeout during preparation prevents late cookie completion from sending', async () => {
    for (const change of ['navigation', 'timeout']) {
        const f = fixture(); let release;
        f.chrome.cookies.getAll = (_, cb) => { release = cb; };
        const replies = f.request(f.key), pending = f.engine.mediaDownloadPending[7];
        if (change === 'navigation') f.events.committed({ tabId: 7, frameId: 0, url: pageURL });
        else f.timers.get(pending.timer)();
        release([]); await tick();
        assert.equal(replies.length, 1); assert.equal(replies[0].error, change);
        assert.equal(f.sent.length, 0); assert.equal(f.engine.pendingRelayQueue.length, 0); assert.equal(f.engine.relayReservations.size, 0);
    }
});
test('disconnect during legacy HEAD and throwing socket sends remain explicit failures', async () => {
    let release;
    const f = fixture({ fetch: () => new Promise(resolve => { release = resolve; }), items: [{ id: 1, 2: 'https://fixture.example/movie.mp4' }] });
    f.engine.C = true; const replies = f.request(f.key); await tick();
    f.engine.G.readyState = 3; release({ ok: false }); await tick();
    assert.equal(replies[0].error, 'offline'); assert.equal(f.engine.pendingRelayQueue.length, 0); assert.equal(f.sent.length, 0);
    const throwing = fixture(); throwing.engine.G.send = () => { throw Error('socket closed'); };
    const failed = throwing.request(throwing.key); await tick();
    assert.equal(failed[0].error, 'offline'); assert.equal(throwing.engine.pendingRelayQueue.length, 0);
});
test('a new worker port republishes handles and cannot acknowledge old pending content requests', async () => {
    const f = fixture(); let release;
    f.c.owner.oa = () => new Promise(resolve => { release = resolve; });
    const replies = f.request(f.key), oldPort = f.c.owner.port;
    f.engine.aa(f.p); f.c.owner.port = { postMessage() { assert.fail('must not send an old receipt on the replacement port'); } };
    release({ sent: true }); await tick();
    assert.equal(replies[0].error, 'unavailable');
    assert.equal(f.c.sent.at(-1)[0], 27); assert.notEqual(oldPort, f.c.owner.port);
});
test('independent players with equal quality and duration stay separate while duplicate URLs collapse', () => {
    const c = content([
        { id: 1, 2: 'https://fixture.example/first.mp4', quality: '1080p', duration: 60 },
        { id: 2, 2: 'https://fixture.example/second.mp4', quality: '1080p', duration: 60 },
        { id: 3, 2: 'https://fixture.example/first.mp4', quality: '1080p', duration: 60 }
    ]);
    c.owner.i = Object.fromEntries([1, 2, 3].map(id => [id, { items: [id], m: { isConnected: true } }]));
    c.owner.publishMediaShelf(); assert.equal(c.sent[0][1].items.length, 2);
    assert.deepEqual(Array.from(c.owner.mediaShelf.values(), item => item.id), [1, 2]);
});
test('a navigation rejection followed by retry preserves worker correlation when content sequence differs', async () => {
    const f = fixture(); f.chrome.tabs.get = (_, cb) => cb({ url: pageURL + '/changed' });
    assert.equal(f.request(f.key)[0].error, 'navigation');
    f.chrome.tabs.get = (_, cb) => cb({ url: pageURL });
    const replies = f.request(f.key); await tick();
    assert.equal(replies.length, 1); assert.equal(replies[0].sent, true); assert.equal(f.sent.length, 1);
    assert.equal(f.engine.mediaDownloadSequence, 2); assert.equal(f.c.owner.relaySequence, 1);
});
test('a successful socket write remains successful if connection or discovery changes before its receipt', async () => {
    const f = fixture();
    f.engine.G.send = value => { f.sent.push(value); f.engine.D = false; f.p.mediaItems = []; };
    const replies = f.request(f.key); await tick();
    assert.equal(replies[0].sent, true); assert.equal(f.sent.length, 1);
});
test('getState waits for refreshed candidates and removes a detached player on its first read', () => {
    const f = fixture(); f.c.owner.i.player.m.isConnected = false;
    let result; f.events.message({ type: 'relay:getState', tabId: 7 }, {}, value => { result = value; });
    assert.equal(result.mediaItems.length, 0); assert.equal(f.engine.mediaShelfRefreshes[7], undefined);
});
test('a surviving iframe republishes media after parent SPA navigation invalidates its cache', () => {
    const f = fixture({ frameId: 2, frameURL: 'https://embed.example/player' }); f.port(0);
    f.events.history({ tabId: 7, frameId: 0, url: pageURL + '/next' });
    assert.equal(f.engine.mediaShelfForTab(7).length, 0);
    let result; f.events.message({ type: 'relay:getState', tabId: 7 }, {}, value => { result = value; });
    f.timers.get(f.engine.mediaShelfRefreshes[7].timer)(); // Legacy top-frame fixture does not speak protocol 26.
    assert.equal(result.mediaItems.length, 1); assert.equal(result.mediaItems[0].frameId, 2);
});
test('port handshake republishes an existing media shelf after worker replacement', () => {
    const c = content([{ id: 1, 2: 'https://fixture.example/movie.mp4' }]);
    methods(ct, ['Ba', 'updateMediaCount', 'bestItemLabel'], 'O', c.context); Object.assign(c.owner, c.context.O);
    c.owner.ea = 3; c.owner.Ba();
    assert.deepEqual(c.sent.map(message => message[0]), [2, 21, 22, 26]);
    assert.equal(c.sent[3][1].items.length, 1);
});
test('worker send receipt completes the popup even if the originating frame closes before its UI receipt', async () => {
    const f = fixture(), deliver = f.p.postMessage;
    f.p.postMessage = message => {
        if (message[0] === 25) { f.engine.aa(f.p); throw Error('document closed'); }
        deliver(message);
    };
    const replies = f.request(f.key); await tick();
    assert.equal(replies.length, 1); assert.equal(replies[0].sent, true); assert.equal(f.sent.length, 1);
});
