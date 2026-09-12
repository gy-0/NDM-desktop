const test = require('node:test');
const assert = require('node:assert/strict');
const { create, key } = require('../browser-handoff.js');
const url = 'https://fixture.test/archive.zip';
function fixture(t, initial = {}, overrides = {}) {
    const saved = structuredClone(initial), files = new Map(), sends = [], actions = [];
    let safe = true, sequence = 0;
    const storage = { async get() { return structuredClone(saved); }, async set(value) { Object.assign(saved, structuredClone(value)); } };
    const downloads = { async search({ id }) { return files.has(id) ? [files.get(id)] : []; },
        async pause(id) { actions.push(['pause', id]); files.get(id).paused = true; },
        async resume(id) { actions.push(['resume', id]); files.get(id).paused = false; },
        async cancel(id) { actions.push(['cancel', id]); files.get(id).state = 'interrupted'; },
        async erase({ id }) { actions.push(['erase', id]); files.delete(id); } };
    const options = { storage, downloads, canSend: item => !item.requiresSafeFileRedirects || safe,
        send: value => sends.push(JSON.parse(value.slice('NDMRelayDownload:'.length))), focus() {},
        idFactory: () => `deferred-fixture-${++sequence}`, retryDelay: 10000, preparationTimeout: 10000, ...overrides };
    const controller = create(options); t.after(() => controller.dispose());
    function download(id = 12) { const item = { id, url, finalUrl: url, state: 'in_progress', paused: false }; files.set(id, item); return item; }
    return { controller, options, storage, downloads, saved, files, sends, actions, download, setSafe: value => { safe = value; } };
}
test('optional exact attachment binds the new marked owner without stealing an earlier same-URL legacy intent', async t => {
    const f = fixture(t); await f.controller.ready;
    const legacy = f.controller.begin(url), marked = f.controller.begin(url, { requiresSafeFileRedirects: true });
    assert.equal(f.controller.attach(f.download(), marked), true);
    await f.controller.idle();
    assert.equal(f.saved[key].find(item => item.id === marked).downloadId, 12);
    assert.equal(f.saved[key].find(item => item.id === legacy).downloadId, null);
    assert.equal(f.controller.attach(f.download(13), 'missing-owner'), false);
});
test('marked recovery requires safe redirects while unmarked legacy transfers retain their original capability', async t => {
    const marked = { id: 'marked-recovery', url, payload: 'immutable-marked', phase: 'sent', downloadId: 12, ownsPause: true, requiresSafeFileRedirects: true, attempts: 1 };
    const legacy = { ...marked, id: 'legacy-recovery', payload: 'legacy', downloadId: 13, requiresSafeFileRedirects: undefined };
    const f = fixture(t, { [key]: [marked, legacy] }); f.setSafe(false);
    f.download().paused = true; f.download(13).paused = true;
    await f.controller.ready;
    assert.deepEqual(f.sends.map(item => item.requestId), [legacy.id]);
    f.setSafe(true); await f.controller.connected();
    assert.deepEqual(f.sends.find(item => item.requestId === marked.id), { requestId: marked.id, payload: marked.payload });
    assert.equal(f.actions.some(action => action[0] === 'resume'), false);
});
test('marked first send losing redirect capability while persisting restores Chrome without sending', async t => {
    const f = fixture(t); await f.controller.ready;
    const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id); await f.controller.idle();
    const save = f.storage.set; let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    f.storage.set = async value => { if (value[key][0]?.phase === 'sent') { entered(); await new Promise(resolve => { release = resolve; }); } await save(value); };
    const payload = f.controller.payload(id, 'immutable-payload'); await waiting;
    f.setSafe(false); release(); await payload;
    assert.equal(f.sends.length, 0); assert.equal(f.files.get(12).paused, false); assert.equal(f.saved[key].length, 0);
    f.storage.set = save; f.setSafe(true); await f.controller.connected(); assert.equal(f.sends.length, 0);
});
test('marked retry losing redirect capability while persisting retains unknown delivery and exact payload', async t => {
    const f = fixture(t); await f.controller.ready;
    const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id);
    await f.controller.payload(id, 'immutable-payload');
    const save = f.storage.set; let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    f.storage.set = async value => { if (value[key][0]?.phase === 'sent') { entered(); await new Promise(resolve => { release = resolve; }); } await save(value); };
    const retry = f.controller.connected(); await waiting; f.setSafe(false); release(); await retry;
    assert.equal(f.sends.length, 1); assert.equal(f.files.get(12).paused, true);
    assert.equal(f.saved[key][0].payload, 'immutable-payload');
    f.storage.set = save; f.setSafe(true); await f.controller.connected();
    assert.deepEqual(f.sends, [{ requestId: id, payload: 'immutable-payload' }, { requestId: id, payload: 'immutable-payload' }]);
});
test('marked pause failure never creates a native task or removes the completed Chrome artifact', async t => {
    const f = fixture(t); await f.controller.ready;
    f.downloads.pause = async id => { f.files.get(id).state = 'complete'; throw Error('already complete'); };
    const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id);
    assert.equal(await f.controller.payload(id, 'unused-payload'), false);
    assert.equal(f.sends.length, 0); assert.equal(f.files.get(12).state, 'complete');
    assert.equal(f.actions.some(action => ['cancel', 'erase'].includes(action[0])), false);
});
test('marked first clear native rejection releases Chrome, but rejection after a lost ACK retains its original owner', async t => {
    for (const retry of [false, true]) {
        const f = fixture(t); await f.controller.ready;
        const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id);
        await f.controller.payload(id, 'immutable-payload'); if (retry) await f.controller.connected();
        await f.controller.receipt({ requestId: id, status: 'rejected', error: 'storage-failed' });
        assert.equal(f.files.get(12).paused, retry);
        if (retry) {
            assert.equal(f.saved[key][0].phase, 'sent'); assert.equal(f.saved[key][0].payload, 'immutable-payload');
            await f.controller.receipt({ requestId: id, status: 'accepted', taskId: 7 });
            assert.equal(f.files.has(12), false);
        }
    }
});
test('marked payload mismatch never releases Chrome, including a later rejection before the next retry', async t => {
    const f = fixture(t); await f.controller.ready;
    const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id);
    await f.controller.payload(id, 'immutable-payload');
    await f.controller.receipt({ requestId: id, status: 'rejected', error: 'payload-mismatch' });
    await f.controller.receipt({ requestId: id, status: 'rejected', error: 'storage-failed' });
    assert.equal(f.files.get(12).paused, true); assert.equal(f.saved[key][0].uncertainRejection, true);
    assert.equal(f.actions.some(action => action[0] === 'resume'), false);
    await f.controller.receipt({ requestId: id, status: 'deleted' }); assert.equal(f.files.has(12), false);
});
test('a single marked attach persistence failure blocks an already queued payload before any native send', async t => {
    const f = fixture(t); await f.controller.ready;
    const save = f.storage.set; let writes = 0;
    f.storage.set = async value => { if (++writes === 2) throw Error('transient attach save failure'); await save(value); };
    const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id);
    assert.equal(await f.controller.payload(id, 'must-not-send'), false);
    assert.equal(f.sends.length, 0); assert.equal(f.files.get(12).paused, false);
    assert.deepEqual(f.actions, []); assert.deepEqual(f.saved[key], []);
});
test('failed marked attach and terminal saves retain rejection for retry without resuming a user pause', async t => {
    const f = fixture(t, {}, { retryDelay: 10 }); await f.controller.ready;
    const save = f.storage.set; let writes = 0;
    f.storage.set = async value => {
        writes++;
        if (writes === 2) { f.files.get(12).paused = true; throw Error('attach save failure during user pause'); }
        if (writes === 3) throw Error('terminal save failure');
        await save(value);
    };
    const id = f.controller.begin(url, { requiresSafeFileRedirects: true }); f.controller.attach(f.download(), id);
    assert.equal(await f.controller.payload(id, 'must-not-send'), false);
    assert.equal(f.controller.active(id), true); assert.equal(f.files.get(12).paused, true);
    await new Promise(resolve => setTimeout(resolve, 25)); await f.controller.idle();
    assert.equal(f.controller.active(id), false); assert.equal(f.files.get(12).paused, true);
    assert.equal(f.sends.length, 0); assert.deepEqual(f.actions, []); assert.deepEqual(f.saved[key], []);
});
