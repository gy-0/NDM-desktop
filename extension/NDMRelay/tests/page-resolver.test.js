const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const adapters = require('../site-adapters.js');
const bg = fs.readFileSync(require.resolve('../bg.js'), 'utf8');
const ct = fs.readFileSync(require.resolve('../ct.js'), 'utf8');
function method(source, name, owner, context) {
    const start = source.indexOf(owner + '.' + name + ' = function');
    assert.ok(start >= 0, name + ' must exist');
    const ending = owner === 'O' ? '\n    };' : '\n};';
    const boundary = source.indexOf(ending, start) + ending.length;
    vm.runInNewContext(source.slice(start, boundary), context);
}
function worker(url = 'https://www.bilibili.com/video/BV1test?p=3') {
    const messages = [], replies = [];
    const port = { tabId: 7, postMessage: msg => messages.push(msg) };
    let timeout;
    const context = { W: {}, URL, NDMRelaySiteAdapters: adapters,
        chrome: { runtime: {}, tabs: { get: (_id, cb) => cb({ url }) } },
        setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {} };
    method(bg, 'resolvePage', 'W', context);
    method(bg, 'pageResolverReceipt', 'W', context);
    const host = Object.assign({ D: true, g: { '7,0': port } }, context.W);
    return { host, port, messages, replies, context, expire: () => timeout(), request: () => host.resolvePage({ tabId: 7, expectedPageURL: url }, r => replies.push(r)) };
}
test('only concrete HTTP(S) pages qualify; content identity survives', () => {
    assert.equal(adapters.currentPageURL('https://www.bilibili.com/video/BV1test?p=3&spm_id_from=x'), 'https://www.bilibili.com/video/BV1test?p=3');
    assert.equal(adapters.currentPageURL('https://player.vimeo.com/video/123456?h=abcdef1234'), 'https://vimeo.com/123456/abcdef1234');
    for (const url of ['https://x.com/home', 'https://youtube.com/', 'https://example.com/video/123', 'file://youtube.com/watch?v=x']) assert.equal(adapters.currentPageURL(url), '');
});
test('worker waits for matching content receipt, rejects duplicate and wrong port', () => {
    const w = worker(); w.request();
    assert.equal(w.replies.length, 0);
    w.request(); assert.equal(w.replies[0].error, 'busy');
    const payload = w.messages[0][1];
    w.host.pageResolverReceipt({}, { requestId: payload.requestId, sent: true });
    assert.equal(w.replies.length, 1);
    w.host.pageResolverReceipt(w.port, { requestId: payload.requestId, sent: true });
    assert.equal(w.replies[1].sent, true);
});
test('offline, stale navigation, missing port and posting errors do not report success', () => {
    for (const error of ['offline', 'navigation', 'unavailable', 'send-failed']) {
        const w = worker();
        if (error === 'offline') w.host.D = false;
        if (error === 'navigation') w.context.chrome.tabs.get = (_id, cb) => cb({ url: 'https://youtube.com/' });
        if (error === 'unavailable') w.host.g = {};
        if (error === 'send-failed') w.port.postMessage = () => { throw Error('disconnected'); };
        w.request(); assert.equal(w.replies[0].error, error); assert.equal(w.replies[0].sent, false);
    }
});
test('bounded timeout releases pending request for explicit retry', () => {
    const w = worker(); w.request(); w.expire();
    assert.equal(w.replies[0].error, 'timeout');
    w.request(); assert.equal(w.messages.length, 2);
});
test('content rechecks live navigation before reusing downloadSitePage', () => {
    const sent = [], downloaded = [];
    const context = { O: {}, window: { location: { href: 'https://www.bilibili.com/video/BV1test?p=3' } }, NDMRelaySiteAdapters: adapters };
    method(ct, 'resolveCurrentPage', 'O', context);
    const host = { port: { postMessage: msg => sent.push(msg) }, downloadSitePage: value => downloaded.push(value) };
    const request = { requestId: 1, expectedPageURL: context.window.location.href };
    context.O.resolveCurrentPage.call(host, request);
    assert.equal(downloaded[0].url, request.expectedPageURL);
    context.window.location.href = 'https://www.bilibili.com/';
    context.O.resolveCurrentPage.call(host, request);
    assert.equal(downloaded.length, 1);
    assert.equal(sent[1][1].error, 'navigation');
});
test('top-frame request uses the existing media-page wire payload and retains Vimeo context', () => {
    const url = 'https://player.vimeo.com/video/123456?h=abcdef1234&autoplay=1';
    const w = worker(url), downloads = [];
    const context = { O: {}, window: { location: { href: url } }, NDMRelaySiteAdapters: adapters,
        F: value => value, M: () => '', NDMRelayText: (_zh, en) => en };
    for (const name of ['resolveCurrentPage', 'downloadSitePage', 'oa']) method(ct, name, 'O', context);
    const content = Object.assign({ A: {}, getTitle: () => 'Fixture', port: { postMessage(message) {
        if (message[0] === 6) downloads.push(message[1]);
        if (message[0] === 24) w.host.pageResolverReceipt(w.port, message[1]);
    } } }, context.O);
    w.port.postMessage = message => { assert.equal(message[0], 24); content.resolveCurrentPage(message[1]); };
    w.request();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0]['2'], 'https://vimeo.com/123456/abcdef1234');
    assert.equal(downloads[0]['6'], 'media-page');
    assert.equal(w.replies[0].sent, true);
});
