const test = require('node:test');
const assert = require('node:assert/strict');
const { create, key } = require('../click-handoff.js');
const context = { tabId: 4, frameId: 0, documentId: 'document-fixture', pageURL: 'https://fixture.test/page' };
const request = (id = 'click-fixture-request-001') => ({ requestId: id, url: 'https://fixture.test/archive.zip', context: { ...context } });
const payload = '1:GET\r\n2:https://fixture.test/archive.zip\r\nCookie: fixture=private\r\n';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, settings = {}) {
    const saved = settings.saved || {}, sent = [], notifications = [], events = []; let online = true, current = true;
    const storage = { async get() { return structuredClone(saved); }, async set(value) { events.push('persist'); Object.assign(saved, structuredClone(value)); } };
    const options = { storage, canSend: () => online, canStart: () => current, send(message) { events.push('send'); sent.push(JSON.parse(message.slice('NDMRelayDownload:'.length))); },
        notify(ctx, result) { notifications.push({ ctx, ...result }); }, retryDelay: 10000, preparationTimeout: 10000, ...settings };
    const controller = create(options); t.after(() => controller.dispose());
    return { controller, options, saved, sent, notifications, events, online(value) { online = value; }, current(value) { current = value; } };
}
test('click intent persists before send and only native receipt produces accepted', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request());
    await f.controller.payload(request().requestId, payload);
    assert.equal(f.saved[key][0].phase, 'sent'); assert.equal(f.sent.length, 1);
    assert.equal(f.events.at(-2), 'persist'); assert.equal(f.events.at(-1), 'send');
    assert.equal(f.notifications.at(-1).status, 'pending');
    await f.controller.receipt({ requestId: request().requestId, status: 'accepted', taskId: 12 });
    assert.equal(f.notifications.at(-1).status, 'accepted'); assert.equal(f.saved[key][0].payload, undefined);
});
test('duplicate begin never prepares or sends the same intent twice and rejects changed identity', async t => {
    const f = fixture(t); await f.controller.ready;
    assert.equal((await f.controller.begin(request())).prepare, true);
    assert.equal((await f.controller.begin(request())).prepare, false);
    assert.equal((await f.controller.begin({ ...request(), url: 'https://fixture.test/other.zip' })).error, 'id-conflict');
    await f.controller.payload(request().requestId, payload); await f.controller.begin(request());
    assert.equal(f.sent.length, 1); assert.equal(await f.controller.payload(request().requestId, 'changed'), false);
});
test('offline or obsolete document before first send falls back without a native request', async t => {
    for (const change of ['offline', 'document']) {
        const f = fixture(t); await f.controller.ready; await f.controller.begin(request());
        if (change === 'offline') f.online(false); else f.current(false);
        await f.controller.payload(request().requestId, payload);
        assert.equal(f.sent.length, 0); assert.equal(f.notifications.at(-1).status, 'fallback');
    }
});
test('preparation timeout rejects late payloads without a hidden download', async t => {
    const f = fixture(t, { preparationTimeout: 10 }); await f.controller.ready; await f.controller.begin(request());
    await new Promise(resolve => setTimeout(resolve, 25)); await f.controller.idle();
    assert.equal(f.notifications.at(-1).status, 'fallback'); assert.equal(await f.controller.payload(request().requestId, payload), false);
    assert.equal(f.sent.length, 0);
});
test('first explicit rejection can fall back; rejection after retransmission remains pending', async t => {
    for (const retry of [false, true]) {
        const f = fixture(t); await f.controller.ready; await f.controller.begin(request()); await f.controller.payload(request().requestId, payload);
        if (retry) await f.controller.connected();
        await f.controller.receipt({ requestId: request().requestId, status: 'rejected', error: 'storage-failed' });
        assert.equal(f.notifications.at(-1).status, retry ? 'pending' : 'fallback');
        assert.equal(await f.controller.armFallback(request()), !retry);
    }
});
test('lost ACK survives worker restart and replays immutable payload even when the page no longer exists', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request()); await f.controller.payload(request().requestId, payload);
    f.controller.dispose(); f.current(false);
    const next = create(f.options); t.after(() => next.dispose()); await next.ready;
    assert.deepEqual(f.sent, [{ requestId: request().requestId, payload }, { requestId: request().requestId, payload }]);
    await next.receipt({ requestId: request().requestId, status: 'deleted', taskId: 12 });
    assert.equal(f.notifications.at(-1).status, 'deleted'); assert.equal(await next.armFallback(request()), false);
});
test('sent intent cannot be rejected locally or replayed in Chrome after loss of connection', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request()); await f.controller.payload(request().requestId, payload);
    f.online(false); f.current(false); await f.controller.reject(request().requestId); await f.controller.connected();
    assert.equal(f.notifications.at(-1).status, 'pending'); assert.equal(await f.controller.armFallback(request()), false);
    assert.equal(f.sent.length, 1);
});
test('failed persistence before the first send falls back and cannot revive a late payload', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request());
    f.options.storage.set = async () => { throw Error('storage failed'); };
    await f.controller.payload(request().requestId, payload);
    assert.equal(f.sent.length, 0); assert.equal(f.notifications.at(-1).status, 'fallback');
    assert.equal(await f.controller.payload(request().requestId, payload), false);
});
test('rejection cannot authorize fallback until its terminal decision is persisted', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request()); await f.controller.payload(request().requestId, payload);
    const save = f.options.storage.set; f.options.storage.set = async () => { throw Error('storage failed'); };
    await f.controller.receipt({ requestId: request().requestId, status: 'rejected' });
    assert.equal(f.notifications.at(-1).status, 'pending'); assert.equal(f.saved[key][0].phase, 'sent');
    await f.controller.begin(request());
    assert.equal(f.notifications.at(-1).status, 'pending'); assert.equal(f.controller.mayHaveSent(request().requestId), true);
    await assert.rejects(f.controller.armFallback(request()));
    f.options.storage.set = save; assert.equal(await f.controller.armFallback(request()), true);
});
test('bypass binds one exact tab/document URL request and follows redirects without affecting another tab', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.armFallback(request());
    const details = { requestId: 'chrome-1', url: request().url, tabId: 4, frameId: 0 };
    assert.equal(f.controller.bindFallback({ ...details, tabId: 5 }, context.documentId), false);
    assert.equal(f.controller.bindFallback(details, 'wrong-document'), false);
    assert.equal(f.controller.bindFallback(details, context.documentId), true);
    assert.equal(f.controller.bindFallback({ ...details, url: 'https://cdn.test/final.zip' }, context.documentId), true);
    assert.equal(f.controller.bindFallback({ ...details, requestId: 'chrome-2' }, context.documentId), false);
    await f.controller.idle(); f.controller.dispose();
    const next = create(f.options); t.after(() => next.dispose()); await next.ready;
    assert.equal(next.bindFallback({ ...details, url: 'https://cdn.test/final.zip' }, context.documentId), true);
});
test('UTF8 oversized payloads never reach native and unknown receipts cannot change another intent', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request());
    await f.controller.receipt({ requestId: 'unknown-fixture-id', status: 'accepted' });
    assert.equal(f.notifications.length, 0);
    await f.controller.payload(request().requestId, '界'.repeat(45000));
    assert.equal(f.sent.length, 0); assert.equal(f.notifications.at(-1).reason, 'request-too-large');
});
test('failed restored session reads fail closed without replacing saved intents', async t => {
    const f = fixture(t, { storage: { async get() { throw Error('read failed'); }, async set() { assert.fail('must not overwrite'); } } });
    await assert.rejects(f.controller.ready); await assert.rejects(f.controller.begin(request()));
    assert.equal(f.sent.length, 0);
});
test('payload mismatch is never a fallback, including first attempt and subsequent rejection before retry', async t => {
    const f = fixture(t); await f.controller.ready; await f.controller.begin(request()); await f.controller.payload(request().requestId, payload);
    await f.controller.receipt({ requestId: request().requestId, status: 'rejected', error: 'payload-mismatch' });
    assert.equal(f.notifications.at(-1).status, 'pending'); assert.equal(f.notifications.at(-1).reason, 'payload-mismatch');
    assert.equal(await f.controller.armFallback(request()), false); assert.equal(f.saved[key][0].payload, payload);
    await f.controller.receipt({ requestId: request().requestId, status: 'rejected', error: 'storage-failed' });
    assert.equal(f.notifications.at(-1).status, 'pending'); assert.equal(f.saved[key][0].attempts, 1);
    await f.controller.begin(request()); assert.equal(f.notifications.at(-1).status, 'pending');
    f.controller.dispose(); const restored = create(f.options); t.after(() => restored.dispose()); await restored.ready;
    assert.equal(f.sent.at(-1).payload, payload); assert.equal(f.saved[key][0].uncertainRejection, true);
    assert.equal(await restored.armFallback(request()), false);
    await restored.receipt({ requestId: request().requestId, status: 'accepted', taskId: 12 });
    assert.equal(f.notifications.at(-1).status, 'accepted');
});
