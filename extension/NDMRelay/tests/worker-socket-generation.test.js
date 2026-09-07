const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
function worker(fetch = async () => ({ ok: false })) {
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
        importScripts() {}, fetch, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'bg.js'), 'utf8'), context);
    const engine = context.NDM_BG;
    engine.M();
    return { engine, sent, events, open() { engine.G.readyState = 1; engine.G.onopen(); } };
}

const request = () => ({1: 'GET', 2: 'https://fixture.example/file.pdf'});
test('obsolete socket events cannot mutate a replacement or flush its queue', () => {
 const f = worker(); const old = f.engine.G; old.readyState = 3; f.engine.M();
 const current = f.engine.G;
 f.engine.pendingRelayQueue.push(request());
 old.onopen();
 assert.equal(f.engine.pendingRelayQueue.length, 1);
 f.open(); const count = f.sent.length;
 current.onmessage({data:'NDMRelayStatus:{"protocol":1,"expectedVersion":"current"}'});
 for (const event of [() => old.onclose(), () => old.onerror(), () => old.onmessage({data:'waiting'}), () => old.onmessage({data:'NDMRelayStatus:{"protocol":1,"expectedVersion":"old"}'}), () => old.onopen()]) event();
 assert.equal(f.engine.D,true); assert.equal(f.engine.C,false);
 assert.equal(f.engine.bridgeStatus.expectedVersion,'current'); assert.equal(f.sent.length,count);
 current.onmessage({data:'waiting'}); assert.equal(f.engine.C,true);
 current.readyState=3; current.onclose(); assert.equal(f.engine.D,false);
});
test('HEAD completion after disconnect keeps the request queued until reconnect', async () => {
 let finish; const f = worker(() => new Promise(resolve => {finish=resolve})); f.open();
 f.engine.C=true; const pending=f.engine.I(request());
 f.engine.G.readyState=3; f.engine.G.onclose();
 finish({ok:true,headers:new Headers({'content-type':'application/pdf','content-length':'12'})}); await pending;
 assert.equal(f.engine.pendingRelayQueue.length,1);
 f.open(); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.sent.filter(text=>text.startsWith('1:GET')).length,1);
 assert.equal(f.engine.pendingRelayQueue.length,0);
});
test('failed HEAD still forwards original intent', async () => {
 const f=worker(async()=>{throw Error('network')}); f.open(); f.engine.C=true;
 await f.engine.I(request()); assert.equal(f.sent.filter(text=>text.startsWith('1:GET')).length,1);
});

test('current direct path requeues closed socket and throwing send exactly once', async () => {
 for (const mode of ['closed','throw']) {
  const f=worker(); f.open(); const old=f.engine.G;
  if(mode==='closed') old.readyState=3;
  else old.send=()=>{throw Error('send failed')};
  await f.engine.I(request());
  assert.equal(f.engine.pendingRelayQueue.length,1);
  assert.notEqual(f.engine.G,old);
  f.open(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sent.filter(text=>text.startsWith('1:GET')).length,1);
  assert.equal(f.engine.pendingRelayQueue.length,0);
 }
});
test('HEAD timeout forwards intent even when fetch ignores abort', async () => {
 const f=worker(()=>new Promise(()=>{})); f.open(); f.engine.C=true;
 const start=Date.now(); await f.engine.I(request());
 assert.ok(Date.now()-start<6500);
 assert.equal(f.sent.filter(text=>text.startsWith('1:GET')).length,1);
});
test('HEAD result arriving after reconnect sends only on the current socket', async () => {
 let finish; const f=worker(()=>new Promise(resolve=>{finish=resolve})); f.open();
 f.engine.C=true; const old=f.engine.G; const pending=f.engine.I(request());
 old.readyState=3; old.onclose(); f.engine.M(); f.open();
 finish({ok:false}); await pending;
 assert.equal(f.sent.filter(text=>text.startsWith('1:GET')).length,1);
 assert.equal(f.engine.pendingRelayQueue.length,0);
});
