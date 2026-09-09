const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
function worker() {
    const events = {};
    const event = name => ({ addListener(listener) { events[name] = listener; } });
    const sent = [];
    const chrome = {
        action: { onClicked: event('action'), setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
        contextMenus: { onClicked: event('menu'), removeAll(cb) { cb(); }, create() {}, update() {} },
        cookies: { getAll(_, cb) { cb([]); } },
        downloads: { onCreated: event('download'), cancel() {}, erase() {} },
        runtime: { lastError: null, onConnect: event('connect'), onMessage: event('message'), getManifest: () => ({ version: '99.99.99' }), reload() { throw Error('Must never auto-reload'); } },
        i18n: { getMessage: () => '' },
        storage: { local: { get(_, cb) { cb({}); }, set() {} } },
        tabs: { query(_, cb) { cb([]); }, remove() {} },
        webNavigation: { onHistoryStateUpdated: event('history') },
        webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred', 'onHeadersReceived'].map(name => [name, event(name)]))
    };
    class Socket { constructor() { this.readyState = 0; } send(text) { sent.push(text); } }
    const context = { chrome, WebSocket: Socket, URL, Headers, unescape,
        NDMRelayMediaPolicy: require('../media-policy.js'), NDMRelayResourcePolicy: require('../resource-policy.js'),
        importScripts() {}, setTimeout: () => 1, clearTimeout() {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'bg.js'), 'utf8'), context);
    const engine = context.NDM_BG;
    engine.M();
    return { engine, sent, events, open() { engine.G.readyState = 1; engine.G.onopen(); } };
}
const download = { 1: 'GET', 2: 'https://fixture.example/file.pdf' };

test('running worker hello precedes queued downloads and does not read the replaced manifest', () => {
    const fixture = worker();
    fixture.engine.pendingRelayQueue.push(download);
    fixture.open();
    assert.ok(fixture.sent[0].startsWith('NDMRelayHello:'));
    const hello = JSON.parse(fixture.sent[0].slice('NDMRelayHello:'.length));
    assert.deepEqual(hello, { version: '1.4.11', protocol: 1, role: 'worker' });
    assert.equal(hello.version, JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version);
    assert.equal(hello.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
    assert.match(fixture.sent[1], /^1:GET\r\n2:https:\/\/fixture.example\/file.pdf\r\n/);
    assert.equal(fixture.engine.pendingRelayQueue.length, 0, 'No status response is required to flush existing downloads');
});

test('host version status is informational and preserves legacy waiting messages and transfers', async () => {
    const fixture = worker(); fixture.open();
    fixture.engine.G.onmessage({ data: 'NDMRelayStatus:{"protocol":1,"expectedVersion":"2.0.0"}' });
    assert.equal(fixture.engine.bridgeStatus.expectedVersion, '2.0.0');
    assert.equal(fixture.engine.D, true);
    await fixture.engine.I(download);
    assert.match(fixture.sent.at(-1), /^1:GET/);
    fixture.engine.G.onmessage({ data: 'waiting' });
    assert.equal(fixture.engine.C, true);
    fixture.engine.G.onmessage({ data: 'nowaiting' });
    assert.equal(fixture.engine.C, false);
    fixture.engine.G.onmessage({ data: 'NDMRelayStatus:{"protocol":1,"expectedVersion":null}' });
    assert.equal(fixture.engine.bridgeStatus.expectedVersion, null);
});

test('invalid status cannot alter controls or disable downloads and reconnect sends a fresh hello', async () => {
    const fixture = worker(); fixture.open();
    for (const data of ['NDMRelayStatus:{', 'NDMRelayStatus:{"protocol":2,"expectedVersion":"x"}', 'NDMRelayStatus:{"protocol":1,"expectedVersion":42}', 'NDMRelayStatus:ShowPanelChrome=0', {}]) fixture.engine.G.onmessage({ data });
    assert.equal(fixture.engine.bridgeStatus, null);
    assert.equal(fixture.engine.F, true);
    assert.equal(fixture.engine.D, true);
    fixture.engine.G.onmessage({ data: 'NDMRelayStatus:{"protocol":1,"expectedVersion":"2.0.0"}' });
    fixture.engine.G.readyState = 3;
    fixture.engine.G.onclose();
    assert.equal(fixture.engine.bridgeStatus, null);
    fixture.engine.M(); fixture.open();
    assert.equal(fixture.sent.filter(text => text.startsWith('NDMRelayHello:')).length, 2);
    await fixture.engine.I(download);
    assert.match(fixture.sent.at(-1), /^1:GET/);
});

test('popup state keeps connection separate from runtime version and host expectations', () => {
    const fixture = worker(); fixture.open();
    let reply;
    fixture.events.message({ type: 'relay:getState', tabId: 17 }, {}, value => { reply = value; });
    assert.equal(reply.connected, true);
    assert.equal(reply.workerVersion, '1.4.11');
    assert.equal(reply.bridgeStatus, null, 'An old host may never send status');
    fixture.engine.G.onmessage({ data: 'NDMRelayStatus:{"protocol":1,"expectedVersion":"2.0.0"}' });
    fixture.events.message({ type: 'relay:getState', tabId: 17 }, {}, value => { reply = value; });
    assert.equal(reply.connected, true, 'A version mismatch must not masquerade as a broken connection');
    assert.equal(reply.bridgeStatus.expectedVersion, '2.0.0');
});
