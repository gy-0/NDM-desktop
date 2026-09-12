const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const { candidate, confirmedFile, install } = require('../click-catcher.js');
function fixture(attrs = {}, options = {}) {
    const attributes = { href: 'https://files.example/build.zip', ...attrs };
    const anchor = { localName: 'a', href: attributes.href,
        hasAttribute: key => Object.hasOwn(attributes, key), getAttribute: key => attributes[key] ?? null };
    const win = { location: new URL('https://files.example/releases'), crypto, navigator: { language: 'en' }, addEventListener() {}, removeEventListener() {} }; win.top = win;
    if (options.Observer) win.MutationObserver = options.Observer;
    const doc = { querySelector: () => null, querySelectorAll: () => (options.meta ? [options.meta] : []).map(content => ({ content, getAttribute: key => key === 'content' ? content : 'referrer' })) };
    const sent = [], replayed = [], notices = [], timers = new Map(); let sequence = 0;
    const response = { ok: true, redirected: false, headers: new Headers({ 'content-type': 'application/zip' }) };
    const probes = [];
    const catcher = install({ window: win, document: doc, fetch: async (...args) => { probes.push(args); return options.fetch ? options.fetch(...args) : response; },
        send: message => { if (options.send) options.send(message); sent.push(message); }, replay: intent => replayed.push(intent), notice: status => notices.push(status),
        setTimeout: (fn, delay) => { timers.set(++sequence, { fn, delay }); return sequence; }, clearTimeout: id => timers.delete(id) });
    const event = changes => ({ isTrusted: true, defaultPrevented: false, button: 0, composedPath: () => [anchor], preventDefault() { this.defaultPrevented = true; }, ...changes });
    catcher.receive([28, { available: true }]);
    return { catcher, win, doc, anchor, event, sent, replayed, notices, probes, timers };
}
test('only trusted ordinary same-origin top-frame download intent is eligible', () => {
    const f = fixture(); assert.ok(candidate(f.event(), f.win, f.doc));
    for (const change of [{ isTrusted: false }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) assert.equal(candidate(f.event(change), f.win, f.doc), null);
    for (const attrs of [{ href: 'https://other.example/file.zip' }, { href: 'blob:https://files.example/id' }, { href: 'https://files.example/file.zip?token=1' }, { href: 'https://files.example/file.zip#section' }, { target: '_blank' }, { rel: 'noreferrer' }, { referrerpolicy: 'origin' }, { onclick: 'go()' }, { ping: '/track' }, { download: '../file.zip' }]) {
        const f = fixture(attrs); assert.equal(candidate(f.event(), f.win, f.doc), null, JSON.stringify(attrs));
    }
    const restrictive = fixture({}, { meta: 'no-referrer' }); assert.equal(candidate(restrictive.event(), restrictive.win, restrictive.doc), null);
    const explicit = fixture({ href: 'https://files.example/download?token=once', download: 'README' }); assert.equal(candidate(explicit.event(), explicit.win, explicit.doc).explicitDownload, true);
});
test('archive probe rejects HTML, JSON, redirects and errors even with attachment headers', () => {
    const headers = mime => new Headers({ 'content-type': mime, 'content-disposition': 'attachment; filename=x.zip' });
    for (const mime of ['text/html', 'text/plain', 'application/json', 'application/xhtml+xml']) assert.equal(confirmedFile({ ok: true, headers: headers(mime) }), false);
    assert.equal(confirmedFile({ ok: true, redirected: true, headers: headers('application/zip') }), false);
    assert.equal(confirmedFile({ ok: false, headers: headers('application/zip') }), false);
});
test('HEAD is bounded and same-origin without redirects; explicit download performs no probe', async () => {
    const f = fixture(); const event = f.event(); await f.catcher.clicked(event);
    assert.equal(event.defaultPrevented, true); assert.equal(f.probes.length, 1);
    const opts = f.probes[0][1]; assert.equal(opts.method, 'HEAD'); assert.equal(opts.mode, 'same-origin'); assert.equal(opts.credentials, 'same-origin'); assert.equal(opts.redirect, 'error');
    assert.equal(f.sent[0][0], 28); assert.equal(f.replayed.length, 0);
    const explicit = fixture({ download: 'file.zip' }); await explicit.catcher.clicked(explicit.event()); assert.equal(explicit.probes.length, 0); assert.equal(explicit.sent.length, 1);
});
test('offline natural click and failed HEAD preserve browser default without a native request', async () => {
    const offline = fixture({ download: '' }); offline.catcher.disconnected(); const event = offline.event(); await offline.catcher.clicked(event);
    assert.equal(event.defaultPrevented, false); assert.equal(offline.sent.length, 0);
    const f = fixture({}, { fetch: async () => { throw Error('405/redirect/network error'); } }); await f.catcher.clicked(f.event());
    assert.equal(f.sent.length, 0); assert.equal(f.replayed.length, 1);
});
test('fallback waits for scoped bypass acknowledgement; late acceptance never starts Chrome', async () => {
    const f = fixture({ download: '' }); await f.catcher.clicked(f.event()); const id = f.sent[0][1].requestId;
    f.catcher.receive([28, { requestId: id, status: 'fallback' }]); assert.equal(f.sent[1][0], 29); assert.equal(f.replayed.length, 0);
    f.catcher.receive([29, { requestId: id, ready: true }]); assert.equal(f.replayed.length, 1);
    f.catcher.receive([28, { requestId: id, status: 'accepted' }]); assert.equal(f.replayed.length, 1);
});
test('double click and reconnect retain one durable intent, including stale offline availability', async () => {
    const f = fixture({ download: '' }); await f.catcher.clicked(f.event()); const first = f.sent[0];
    f.catcher.disconnected(); const again = f.event(); await f.catcher.clicked(again); assert.equal(again.defaultPrevented, true); assert.equal(f.sent.length, 1);
    f.catcher.receive([28, { available: true }]); assert.deepEqual(f.sent[1], first);
    f.catcher.receive([28, { requestId: first[1].requestId, status: 'pending' }]); assert.equal(f.replayed.length, 0);
    f.catcher.receive([28, { requestId: first[1].requestId, status: 'accepted' }]); assert.equal(f.notices.at(-1), 'accepted');
    await f.catcher.clicked(f.event()); assert.equal(f.sent.length, 2);
});
test('navigation during preparation or before fallback never replays into the new page', async () => {
    let resolve; const f = fixture({}, { fetch: () => new Promise(done => { resolve = done; }) });
    const click = f.catcher.clicked(f.event()); f.win.location = new URL('https://files.example/new-page'); resolve({ ok: false }); await click;
    assert.equal(f.sent.length, 0); assert.equal(f.replayed.length, 0); assert.equal(f.notices.at(-1), 'navigation');
    const sent = fixture({ download: '' }); await sent.catcher.clicked(sent.event()); sent.win.location = new URL('https://files.example/new-page');
    sent.catcher.receive([28, { requestId: sent.sent[0][1].requestId, status: 'fallback' }]); assert.equal(sent.replayed.length, 0); assert.equal(sent.sent.length, 1);
});
test('browser fallback retries its bypass after worker reconnect even when NDM remains offline', async () => {
    const f = fixture({ download: '' }); await f.catcher.clicked(f.event()); const id = f.sent[0][1].requestId;
    f.catcher.receive([28, { requestId: id, status: 'fallback' }]); f.catcher.disconnected();
    f.catcher.receive([29, { requestId: id, ready: false, reason: 'storage-failed' }]);
    assert.equal(f.replayed.length, 0); assert.equal(f.notices.at(-1), 'pending');
    f.catcher.receive([28, { available: false }]); assert.equal(f.sent.at(-1)[0], 29);
    f.catcher.receive([29, { requestId: id, ready: true }]); assert.equal(f.replayed.length, 1);
});
test('source-page userinfo stays in the browser and restrictive policy changes cannot create a second owner', async () => {
    const credentials = fixture({ download: '' }); credentials.win.location = new URL('https://user:pass@files.example/releases');
    const untouched = credentials.event(); await credentials.catcher.clicked(untouched); assert.equal(untouched.defaultPrevented, false); assert.equal(credentials.sent.length, 0);
    const f = fixture({ download: '' }); await f.catcher.clicked(f.event());
    f.doc.querySelectorAll = () => [{ content: 'no-referrer', getAttribute: key => key === 'content' ? 'no-referrer' : 'referrer' }];
    const repeated = f.event(); await f.catcher.clicked(repeated); assert.equal(repeated.defaultPrevented, true); assert.equal(f.sent.length, 1); assert.equal(f.replayed.length, 0);
});
test('multiple referrer policies are conservatively honored and removed restrictive metadata remains sticky', async () => {
    const f = fixture({ download: '' });
    const meta = content => ({ content, getAttribute: key => key === 'content' ? content : 'referrer' });
    f.doc.querySelectorAll = () => [meta('same-origin'), meta('no-referrer')];
    const first = f.event(); await f.catcher.clicked(first); assert.equal(first.defaultPrevented, false);
    f.doc.querySelectorAll = () => []; const second = f.event(); await f.catcher.clicked(second); assert.equal(second.defaultPrevented, false); assert.equal(f.sent.length, 0);
});
test('removed and renamed restrictive metadata is remembered through MutationObserver old values', async () => {
    let observer;
    class Observer {
        constructor(callback) { observer = this; this.callback = callback; this.records = []; }
        observe() {}
        disconnect() {}
        takeRecords() { const records = this.records; this.records = []; return records; }
    }
    const f = fixture({ download: '' }, { Observer });
    const removed = { nodeType: 1, localName: 'meta', querySelectorAll: () => [], getAttribute: key => key === 'name' ? 'renamed' : 'same-origin' };
    observer.records = [{ type: 'attributes', target: removed, attributeName: 'name', oldValue: 'referrer' },
        { type: 'attributes', target: removed, attributeName: 'content', oldValue: 'no-referrer' },
        { type: 'childList', removedNodes: [removed], addedNodes: [] }];
    const event = f.event(); await f.catcher.clicked(event); assert.equal(event.defaultPrevented, false); assert.equal(f.sent.length, 0);
    const again = f.event(); await f.catcher.clicked(again); assert.equal(again.defaultPrevented, false);
});
