const test = require('node:test');
const assert = require('node:assert/strict');
const { create, key } = require('../browser-handoff.js');
function fixture(saved = {}, timeout = 10000) {
    const events = [], files = new Map();
    let online = true;
    const storage = { async get() { return structuredClone(saved); }, async set(value) { Object.assign(saved, structuredClone(value)); events.push('persist'); } };
    const downloads = {
        async search({ id }) { return files.has(id) ? [files.get(id)] : []; },
        async pause(id) { events.push(['pause', id]); files.get(id).paused = true; },
        async resume(id) { events.push(['resume', id]); files.get(id).paused = false; },
        async cancel(id) { events.push(['cancel', id]); if (files.has(id)) files.get(id).state = 'interrupted'; },
        async erase({ id }) { events.push(['erase', id]); files.delete(id); }
    };
    const options = { storage, downloads, canSend: () => online, send: message => events.push(['send', JSON.parse(message.slice('NDMRelayDownload:'.length))]), focus: () => events.push('focus'), idFactory: () => 'fixture-handoff-00001', preparationTimeout: timeout, retryDelay: 10 };
    const controller = create(options);
    function download(paused = false) { const d = { id: 12, url: 'https://fixture.invalid/file.zip', state: 'in_progress', paused }; files.set(d.id, d); return d; }
    return { controller, options, events, saved, files, download, setOnline: value => { online = value; } };
}
const calls = (f, name) => f.events.filter(e => Array.isArray(e) && e[0] === name);
test('pause immediately, persist before native send, erase only after committed receipt', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip'); f.controller.attach(f.download()); await f.controller.idle();
    assert.equal(calls(f, 'pause').length, 1); assert.equal(calls(f, 'send').length, 0); assert.equal(calls(f, 'cancel').length, 0);
    await f.controller.payload(id, '1:GET\r\n2:https://fixture.invalid/file.zip\r\n');
    assert.equal(f.saved[key][0].phase, 'sent'); assert.equal(calls(f, 'cancel').length, 0);
    await f.controller.receipt({ requestId: id, status: 'accepted', taskId: 7 });
    assert.equal(calls(f, 'cancel').length, 1); assert.equal(calls(f, 'erase').length, 1); assert.equal(f.saved[key].length, 0);
});
test('host rejection resumes Chrome without deleting the task', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip'); f.controller.attach(f.download()); await f.controller.payload(id, 'payload');
    await f.controller.receipt({ requestId: id, status: 'rejected' });
    assert.equal(calls(f, 'resume').length, 1); assert.equal(calls(f, 'erase').length, 0);
});
test('preparation timeout restores Chrome and prevents a late cookie callback from sending', async t => {
    const f = fixture({}, 20); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip'); f.controller.attach(f.download());
    await new Promise(r => setTimeout(r, 40)); await f.controller.idle();
    assert.equal(await f.controller.payload(id, 'late payload'), false);
    assert.equal(calls(f, 'resume').length, 1); assert.equal(calls(f, 'send').length, 0);
});
test('worker restart replays an unacknowledged request with the same id, without resuming Chrome', async t => {
    const f = fixture(); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip'); f.controller.attach(f.download()); await f.controller.payload(id, 'payload');
    f.controller.dispose(); const restored = create(f.options); t.after(() => restored.dispose()); await restored.ready;
    assert.deepEqual(calls(f, 'send').map(e => e[1].requestId), [id, id]); assert.equal(calls(f, 'resume').length, 0);
    await restored.receipt({ requestId: id, status: 'accepted', taskId: 7 }); assert.equal(calls(f, 'erase').length, 1);
});
test('worker restart during preparation restores only a download paused by this handoff', async t => {
    for (const paused of [false, true]) {
        const f = fixture(); await f.controller.ready;
        f.controller.begin('https://fixture.invalid/file.zip'); f.controller.attach(f.download(paused)); await f.controller.idle();
        f.controller.dispose(); const restored = create(f.options); t.after(() => restored.dispose()); await restored.ready;
        assert.equal(calls(f, 'resume').length, paused ? 0 : 1); assert.equal(calls(f, 'send').length, 0);
    }
});
test('receipt arriving before onCreated still cleans up the matching browser download', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip'); await f.controller.payload(id, 'payload');
    await f.controller.receipt({ requestId: id, status: 'accepted', taskId: 7 });
    assert.equal(f.controller.attach(f.download()), true); await f.controller.idle(); assert.equal(calls(f, 'erase').length, 1);
});

test('a failed pre-send save never sends or strands an uncertain request', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip'); f.controller.attach(f.download()); await f.controller.idle();
    const save = f.options.storage.set; let writes = 0;
    f.options.storage.set = async value => { if (++writes === 2) throw Error('storage unavailable'); await save(value); };
    await assert.rejects(f.controller.payload(id, 'payload'));
    await f.controller.reject(id);
    assert.equal(calls(f, 'send').length, 0); assert.equal(calls(f, 'resume').length, 1);
});

async function eventually(check, timeout = 250) {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), 'handoff must recover without another browser event or reconnect');
}

test('failed initial persistence never leaves a queued onCreated callback owning an untracked pause', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const save = f.options.storage.set;
    let failed = false;
    f.options.storage.set = async value => {
        if (!failed) { failed = true; throw Error('session temporarily unavailable'); }
        await save(value);
    };
    const id = f.controller.begin('https://fixture.invalid/file.zip');
    f.controller.attach(f.download());
    await f.controller.idle();
    assert.equal(f.controller.active(id), false);
    assert.equal(calls(f, 'pause').length, 0);
    assert.equal(f.files.get(12).paused, false);
    assert.equal(await f.controller.payload(id, 'late payload'), false);
    assert.equal(calls(f, 'send').length, 0);
});

test('a preparation timeout retries a failed browser resume until the original download is running', async t => {
    const f = fixture({}, 10); t.after(() => f.controller.dispose()); await f.controller.ready;
    const resume = f.options.downloads.resume;
    let attempts = 0;
    f.options.downloads.resume = async id => {
        if (++attempts === 1) throw Error('downloads API temporarily unavailable');
        await resume(id);
    };
    const id = f.controller.begin('https://fixture.invalid/file.zip');
    f.controller.attach(f.download());
    await f.controller.idle();
    await eventually(() => !f.controller.active(id));
    assert.equal(attempts, 2);
    assert.equal(f.files.get(12).paused, false);
    assert.equal(f.saved[key].length, 0);
    assert.equal(calls(f, 'send').length, 0);
});

test('restart recovers other downloads even when one browser resume fails temporarily', async t => {
    const first = { id: 'fixture-handoff-00001', url: 'https://fixture.invalid/one.zip', phase: 'preparing', downloadId: 12, ownsPause: true };
    const second = { ...first, id: 'fixture-handoff-00002', url: 'https://fixture.invalid/two.zip', downloadId: 13 };
    const f = fixture({ [key]: [first, second] }); t.after(() => f.controller.dispose());
    f.files.set(12, { id: 12, paused: true, state: 'in_progress' });
    f.files.set(13, { id: 13, paused: true, state: 'in_progress' });
    const resume = f.options.downloads.resume;
    let failed = false;
    f.options.downloads.resume = async id => {
        if (id === 12 && !failed) { failed = true; throw Error('temporary resume failure'); }
        await resume(id);
    };
    await f.controller.ready;
    assert.equal(f.files.get(13).paused, false);
    await eventually(() => !f.controller.active(first.id));
    assert.equal(f.files.get(12).paused, false);
    assert.equal(f.saved[key].length, 0);
});

test('a failed cancellation does not erase an active browser download before retrying', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip');
    f.controller.attach(f.download()); await f.controller.payload(id, 'payload');
    const cancel = f.options.downloads.cancel;
    let attempts = 0;
    f.options.downloads.cancel = async downloadId => {
        if (++attempts === 1) throw Error('temporary cancel failure');
        await cancel(downloadId);
    };
    await f.controller.receipt({ requestId: id, status: 'accepted', taskId: 7 }).catch(() => {});
    assert.equal(calls(f, 'erase').length, 0);
    assert.equal(f.controller.active(id), true);
    await eventually(() => !f.controller.active(id));
    assert.equal(attempts, 2);
    assert.equal(calls(f, 'erase').length, 1);
});

test('a browser download that already completed can still finish handoff cleanup', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip');
    f.controller.attach(f.download()); await f.controller.payload(id, 'payload');
    f.files.get(12).state = 'complete';
    f.options.downloads.cancel = async () => { throw Error('Download is already complete'); };
    await f.controller.receipt({ requestId: id, status: 'accepted', taskId: 7 });
    assert.equal(f.controller.active(id), false);
    assert.equal(calls(f, 'erase').length, 1);
});

test('failed final session cleanup retains ownership and retries without another delivery', async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); await f.controller.ready;
    const id = f.controller.begin('https://fixture.invalid/file.zip');
    f.controller.attach(f.download()); await f.controller.payload(id, 'payload');
    const save = f.options.storage.set;
    let failed = false;
    f.options.storage.set = async value => {
        if (!value[key].length && !failed) { failed = true; throw Error('temporary session failure'); }
        await save(value);
    };
    await assert.rejects(f.controller.receipt({ requestId: id, status: 'accepted', taskId: 7 }));
    assert.equal(f.controller.active(id), true);
    assert.equal(f.saved[key][0].phase, 'accepted');
    await eventually(() => !f.controller.active(id));
    assert.equal(f.saved[key].length, 0);
    assert.equal(calls(f, 'send').length, 1);
    assert.equal(calls(f, 'cancel').length, 1);
});

test('reconnecting delivers pending requests even when another handoff cannot finish cleanup yet', async t => {
    const first = { id: 'fixture-handoff-00001', url: 'https://fixture.invalid/one.zip', phase: 'accepted', downloadId: 12, ownsPause: true };
    const second = { id: 'fixture-handoff-00002', url: 'https://fixture.invalid/two.zip', phase: 'sent', downloadId: null, ownsPause: false, payload: 'payload' };
    const f = fixture({ [key]: [first, second] }); t.after(() => f.controller.dispose());
    f.setOnline(false);
    f.files.set(12, { id: 12, paused: true, state: 'in_progress' });
    f.options.downloads.cancel = async () => { throw Error('temporary cancel failure'); };
    await f.controller.ready;
    assert.equal(calls(f, 'send').length, 0);
    f.setOnline(true);
    await f.controller.connected();
    assert.deepEqual(calls(f, 'send').map(event => event[1].requestId), [second.id]);
    assert.equal(f.controller.active(first.id), true);
});
