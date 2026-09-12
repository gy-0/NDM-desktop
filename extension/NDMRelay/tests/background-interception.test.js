const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../media-policy.js");
const resourcePolicy = require("../resource-policy.js");

function loadBackground(options = {}) {
    const listeners = {};
    const registrations = {};
    const cookieRequests = [];
    const pendingCookieRequests = [];
    const cancelledDownloads = [];
    const erasedDownloads = [];
    const sentMessages = [];
    const event = name => ({
        addListener(listener, ...args) {
            listeners[name] = listener;
            registrations[name] = args;
        }
    });

    const chrome = {
        action: {
            onClicked: event("actionClicked"),
            setBadgeBackgroundColor() {},
            setBadgeText() {},
            setTitle() {}
        },
        contextMenus: {
            onClicked: event("contextMenuClicked"),
            removeAll(callback) { callback(); },
            create() {},
            update(_id, _properties, callback) { if (callback) callback(); }
        },
        cookies: {
            getAll(details, callback) {
                cookieRequests.push(details.url);
                if (options.deferCookies) {
                    pendingCookieRequests.push({ details, callback });
                } else {
                    callback(options.cookies || []);
                }
            }
        },
        downloads: {
            onCreated: event("downloadCreated"),
            cancel(id, callback) {
                cancelledDownloads.push(id);
                if (callback) callback();
            },
            erase(query, callback) {
                erasedDownloads.push(query.id);
                if (callback) callback();
            }
        },
        runtime: {
            lastError: null,
            onConnect: event("runtimeConnect"),
            onMessage: event("runtimeMessage")
        },
        i18n: {
            getMessage() { return ""; }
        },
        storage: {
            local: {
                get(_keys, callback) { callback({}); },
                set() {}
            }
        },
        tabs: {
            query(_query, callback) { callback([]); },
            remove() {}
        },
        webNavigation: {
            onHistoryStateUpdated: event("historyStateUpdated")
        },
        webRequest: {
            onBeforeRequest: event("beforeRequest"),
            onBeforeSendHeaders: event("beforeSendHeaders"),
            onCompleted: event("requestCompleted"),
            onErrorOccurred: event("requestError"),
            onHeadersReceived: event("headersReceived")
        }
    };

    class MockWebSocket {
        constructor() {
            this.readyState = 0;
        }
        send(message) { sentMessages.push(message); }
    }

    const context = {
        NDMRelayMediaPolicy: policy,
        NDMRelayResourcePolicy: resourcePolicy,
        NDMRelaySiteAdapters: require('../site-adapters.js'),
        NDMRelaySessionCookies: require('../session-cookies.js'),
        crypto: require('node:crypto').webcrypto,
        Headers,
        URL,
        WebSocket: MockWebSocket,
        chrome,
        fetch: async () => ({ ok: false }),
        importScripts() {},
        setTimeout, clearTimeout,
        unescape
    };
    context.globalThis = context;
    vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, "..", "bg.js"), "utf8"),
        context,
        { filename: "bg.js" }
    );
    context.NDM_BG.D = true;
    context.NDM_BG.G = { readyState: 1, send(message) { sentMessages.push(message); } };
    return {
        worker: context.NDM_BG,
        listeners,
        registrations,
        cookieRequests,
        pendingCookieRequests,
        cancelledDownloads,
        erasedDownloads,
        sentMessages
    };
}

function responseHeaders(contentType, disposition) {
    const headers = [
        { name: "Content-Type", value: contentType },
        { name: "Content-Length", value: "4096" }
    ];
    if (disposition) headers.push({ name: "Content-Disposition", value: disposition });
    return headers;
}

function simulateResponse(runtime, options) {
    runtime.listeners.beforeRequest({
        requestId: options.id,
        url: options.url,
        tabId: 10,
        frameId: options.type === "main_frame" ? 0 : 2,
        type: options.type,
        method: "GET"
    });
    runtime.listeners.beforeSendHeaders({
        requestId: options.id,
        url: options.url,
        tabId: 10,
        frameId: options.type === "main_frame" ? 0 : 2,
        type: options.type,
        method: "GET",
        requestHeaders: options.requestHeaders || []
    });
    runtime.listeners.headersReceived({
        requestId: options.id,
        url: options.url,
        tabId: 10,
        frameId: options.type === "main_frame" ? 0 : 2,
        type: options.type,
        method: "GET",
        statusLine: "HTTP/1.1 200 OK",
        responseHeaders: responseHeaders(options.contentType, options.disposition)
    });
}

function readState(runtime, tabId = 10) {
    let state;
    runtime.listeners.runtimeMessage({ type: "relay:getState", tabId }, {}, reply => { state = reply; });
    return state;
}

test("background ignores DAT and BIN page subresources", () => {
    const runtime = loadBackground();
    simulateResponse(runtime, {
        id: "dat-resource",
        url: "https://example.com/telemetry/cache.dat",
        type: "other",
        contentType: "application/octet-stream"
    });
    simulateResponse(runtime, {
        id: "bin-resource",
        url: "https://example.com/assets/model.bin",
        type: "xmlhttprequest",
        contentType: "application/octet-stream",
        disposition: "attachment; filename=model.bin"
    });
    assert.deepEqual(runtime.cookieRequests, []);
});

test("background keeps a useful embedded PDF in the toolbar popup without auto-downloading it", () => {
    const runtime = loadBackground();
    const messages = [];
    runtime.listeners.runtimeConnect({
        sender: {
            tab: { id: 10, title: "Research", url: "https://example.com/viewer" },
            frameId: 0,
            url: "https://example.com/viewer"
        },
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage(message) { messages.push(message); }
    });
    simulateResponse(runtime, {
        id: "pdf-resource",
        url: "https://cdn.example.com/files/paper.pdf?range=0-4095",
        type: "xmlhttprequest",
        contentType: "application/pdf"
    });

    const state = readState(runtime);
    assert.equal(state.resources.length, 1);
    assert.equal(state.resources[0].fEx, "pdf");
    assert.equal(state.resources[0][6], "normal");
    assert.equal(messages.some(message => message[0] === 19), false);
    assert.deepEqual(runtime.cookieRequests, []);
});

test("an iframe PDF is reported once in the tab toolbar popup", () => {
    const runtime = loadBackground();
    const topMessages = [];
    const frameMessages = [];
    const connect = (frameId, messages) => runtime.listeners.runtimeConnect({
        sender: {
            tab: { id: 10, title: "Reader", url: "https://example.com/reader" },
            frameId,
            url: frameId ? "https://viewer.example.com/embed" : "https://example.com/reader"
        },
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage(message) { messages.push(message); }
    });
    connect(0, topMessages);
    connect(2, frameMessages);
    simulateResponse(runtime, {
        id: "iframe-pdf-resource",
        url: "https://viewer.example.com/original.pdf",
        type: "xmlhttprequest",
        contentType: "application/pdf"
    });

    assert.equal(readState(runtime).resources.length, 1);
    assert.equal(topMessages.some(message => message[0] === 19), false);
    assert.equal(frameMessages.some(message => message[0] === 19), false);
    let reply;
    runtime.listeners.runtimeMessage({
        type: "relay:downloadResource",
        tabId: 10,
        resourceKey: readState(runtime).resources[0].resourceKey
    }, {}, value => { reply = value; });
    assert.equal(reply, undefined, "resource dispatch alone is not acceptance");
    assert.equal(topMessages.filter(message => message[0] === 23).length, 1);
    assert.equal(frameMessages.filter(message => message[0] === 23).length, 0);
    const request = topMessages.find(message => message[0] === 23)[2];
    runtime.worker.pageResolverReceipt(runtime.worker.g['10,0'], { requestId: request.requestId, sent: false, error: 'queue-full' });
    assert.equal(reply.sent, false);
    assert.equal(reply.error, 'queue-full');
});

test("YouTube text attachments never become downloadable page files", () => {
    const runtime = loadBackground();
    simulateResponse(runtime, {
        id: "youtube-json-text",
        url: "https://www.youtube.com/api/stats/json.txt",
        type: "xmlhttprequest",
        contentType: "text/plain",
        disposition: "attachment; filename=json.txt"
    });
    simulateResponse(runtime, {
        id: "youtube-f-text",
        url: "https://www.youtube.com/api/stats/f.txt",
        type: "xmlhttprequest",
        contentType: "text/plain",
        disposition: "attachment; filename=f.txt"
    });

    assert.equal(readState(runtime).resources.length, 0);
});

test("background does not expose JavaScript or unknown DAT traffic as resources", () => {
    const runtime = loadBackground();
    const messages = [];
    runtime.listeners.runtimeConnect({
        sender: {
            tab: { id: 10, title: "App", url: "https://example.com" },
            frameId: 0,
            url: "https://example.com"
        },
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage(message) { messages.push(message); }
    });
    simulateResponse(runtime, {
        id: "javascript-resource",
        url: "https://example.com/app.js",
        type: "xmlhttprequest",
        contentType: "text/javascript"
    });
    simulateResponse(runtime, {
        id: "dat-resource-panel",
        url: "https://example.com/cache.dat",
        type: "other",
        contentType: "application/octet-stream"
    });
    assert.equal(messages.some(message => message[0] === 19), false);
});

test("background cancels a suspicious hidden DAT download created by Chrome", () => {
    const runtime = loadBackground();
    const url = "https://example.com/telemetry/cache.dat";
    simulateResponse(runtime, {
        id: "dat-resource",
        url,
        type: "other",
        contentType: "application/octet-stream"
    });
    runtime.listeners.downloadCreated({ id: 41, url });

    assert.deepEqual(runtime.cancelledDownloads, [41]);
    assert.deepEqual(runtime.erasedDownloads, [41]);
    assert.deepEqual(runtime.cookieRequests, []);
});

test("background never cancels an explicitly opened top-level DAT download", () => {
    const runtime = loadBackground();
    const url = "https://example.com/manual.dat";
    simulateResponse(runtime, {
        id: "top-level-dat",
        url,
        type: "main_frame",
        contentType: "application/octet-stream",
        disposition: "attachment; filename=manual.dat"
    });
    runtime.listeners.downloadCreated({ id: 42, url });

    assert.deepEqual(runtime.cancelledDownloads, []);
    assert.deepEqual(runtime.erasedDownloads, []);
});

test("background ignores attachment downloads started by hidden frames", () => {
    const runtime = loadBackground();
    simulateResponse(runtime, {
        id: "hidden-frame",
        url: "https://example.com/automatic.zip",
        type: "sub_frame",
        contentType: "application/zip",
        disposition: "attachment; filename=automatic.zip"
    });
    assert.deepEqual(runtime.cookieRequests, []);
});

test("background still hands an intentional top-level attachment to NDM", () => {
    const runtime = loadBackground();
    simulateResponse(runtime, {
        id: "user-download",
        url: "https://example.com/manual.zip",
        type: "main_frame",
        contentType: "application/zip",
        disposition: "attachment; filename=manual.zip"
    });
    assert.deepEqual(runtime.cookieRequests, ["https://example.com/manual.zip"]);
});

test("background relays the browser's authenticated request context without unsafe transport headers", () => {
    const runtime = loadBackground({ cookies: [{ name: "fallback", value: "stale" }] });
    const url = "https://secure.example.com/export/report.zip";
    simulateResponse(runtime, {
        id: "authenticated-download",
        url,
        type: "main_frame",
        contentType: "application/zip",
        disposition: "attachment; filename=report.zip",
        requestHeaders: [
            { name: "Cookie", value: "session=live; entitlement=pro" },
            { name: "Authorization", value: "Bearer test-token" },
            { name: "Referer", value: "https://secure.example.com/reports/42" },
            { name: "Origin", value: "https://secure.example.com" },
            { name: "User-Agent", value: "Relay Test Browser" },
            { name: "Accept", value: "application/zip" },
            { name: "Accept-Language", value: "zh-CN,zh;q=0.9" },
            { name: "X-Download-Nonce", value: "nonce-42" },
            { name: "Host", value: "secure.example.com" },
            { name: "Range", value: "bytes=0-1023" },
            { name: "Accept-Encoding", value: "br, gzip" },
            { name: "Sec-Fetch-Site", value: "same-origin" }
        ]
    });

    assert.deepEqual(Array.from(runtime.registrations.beforeSendHeaders[1]), ["requestHeaders", "extraHeaders"]);
    assert.equal(runtime.sentMessages.length, 1);
    const message = runtime.sentMessages[0];
    assert.match(message, /Cookie: session=live; entitlement=pro\r\n/);
    assert.match(message, /Authorization: Bearer test-token\r\n/);
    assert.match(message, /Referer: https:\/\/secure\.example\.com\/reports\/42\r\n/);
    assert.match(message, /Origin: https:\/\/secure\.example\.com\r\n/);
    assert.match(message, /9:Relay Test Browser\r\n/);
    assert.match(message, /Accept: application\/zip\r\n/);
    assert.match(message, /Accept-Language: zh-CN,zh;q=0\.9\r\n/);
    assert.match(message, /X-Download-Nonce: nonce-42\r\n/);
    assert.doesNotMatch(message, /Cookie: fallback=stale/);
    assert.doesNotMatch(message, /\r\n(?:Host|Range|Accept-Encoding|Sec-Fetch-Site):/i);
});

test("clicking a detected media candidate preserves its captured authentication context", () => {
    const runtime = loadBackground({ cookies: [{ name: "fallback", value: "stale" }] });
    let receiveFromContent;
    runtime.listeners.runtimeConnect({
        sender: {
            tab: { id: 10, title: "Authenticated media", url: "https://secure.example.com/watch/42" },
            frameId: 0,
            url: "https://secure.example.com/watch/42"
        },
        onMessage: { addListener(listener) { receiveFromContent = listener; } },
        onDisconnect: { addListener() {} },
        postMessage() {}
    });

    receiveFromContent([6, {
        1: "GET",
        2: "https://cdn.example.com/video.mp4",
        6: "media",
        cookies: "session=live",
        requestReferer: "https://secure.example.com/watch/42",
        requestOrigin: "https://secure.example.com",
        Authorization: "Bearer test-token",
        Accept: "video/mp4",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "X-Download-Nonce": "nonce-42"
    }, "https://secure.example.com/watch/42", "Authenticated media", "Relay Test Browser"]);

    assert.equal(runtime.sentMessages.length, 1);
    const message = runtime.sentMessages[0];
    assert.match(message, /Cookie: session=live\r\n/);
    assert.match(message, /Authorization: Bearer test-token\r\n/);
    assert.match(message, /Referer: https:\/\/secure\.example\.com\/watch\/42\r\n/);
    assert.match(message, /Origin: https:\/\/secure\.example\.com\r\n/);
    assert.match(message, /Accept: video\/mp4\r\n/);
    assert.match(message, /Accept-Language: zh-CN,zh;q=0\.9\r\n/);
    assert.match(message, /X-Download-Nonce: nonce-42\r\n/);
    assert.doesNotMatch(message, /Cookie: fallback=stale/);
});

test("concurrent cookie lookups keep each authenticated handoff attached to its own URL", async () => {
    const runtime = loadBackground({ deferCookies: true });
    const first = "https://secure.example.com/first.zip";
    const second = "https://secure.example.com/second.zip";
    simulateResponse(runtime, {
        id: "auth-first",
        url: first,
        type: "main_frame",
        contentType: "application/zip",
        disposition: "attachment; filename=first.zip"
    });
    simulateResponse(runtime, {
        id: "auth-second",
        url: second,
        type: "main_frame",
        contentType: "application/zip",
        disposition: "attachment; filename=second.zip"
    });

    assert.equal(runtime.pendingCookieRequests.length, 2);
    runtime.pendingCookieRequests[1].callback([{ domain: 'secure.example.com', hostOnly: true, path: '/', name: "session", value: "second" }]);
    runtime.pendingCookieRequests[0].callback([{ domain: 'secure.example.com', hostOnly: true, path: '/', name: "session", value: "first" }]);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(runtime.sentMessages.length, 2);
    const byURL = new Map(runtime.sentMessages.map(message => [message.match(/2:(.+)\r\n/)[1], message]));
    assert.match(byURL.get(first), /Cookie: session=first\r\n/);
    assert.match(byURL.get(second), /Cookie: session=second\r\n/);
});

test("concurrent top-level handoffs survive unrelated Chrome downloads", async () => {
    const runtime = loadBackground();
    const first = "https://example.com/first.zip";
    const second = "https://example.com/second.dmg";
    simulateResponse(runtime, {
        id: "first-download",
        url: first,
        type: "main_frame",
        contentType: "application/zip",
        disposition: "attachment; filename=first.zip"
    });
    simulateResponse(runtime, {
        id: "second-download",
        url: second,
        type: "main_frame",
        contentType: "application/octet-stream",
        disposition: "attachment; filename=second.dmg"
    });

    runtime.listeners.downloadCreated({ id: 50, url: "https://example.com/unrelated.pdf" });
    runtime.listeners.downloadCreated({ id: 51, url: first });
    runtime.listeners.downloadCreated({ id: 52, finalUrl: second, url: second + "?redirected=1" });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.cancelledDownloads, [51, 52]);
    assert.deepEqual(runtime.erasedDownloads, [51, 52]);
    assert.deepEqual(runtime.cookieRequests, [first, second]);
});

test("a user can still explicitly send a DAT link from the context menu", () => {
    const runtime = loadBackground();
    runtime.listeners.contextMenuClicked({
        menuItemId: "NDM_CtxMenu",
        linkUrl: "https://example.com/manual.dat",
        pageUrl: "https://example.com/downloads"
    }, {
        id: 10,
        title: "Downloads",
        url: "https://example.com/downloads"
    });
    assert.deepEqual(runtime.cookieRequests, ["https://example.com/manual.dat"]);
});

test("toolbar action restores the current tab's nearest media panel", () => {
    const runtime = loadBackground();
    const messages = [];
    const port = {
        sender: {
            tab: { id: 10, title: "Video", url: "https://x.com/example/status/123" },
            frameId: 0,
            url: "https://x.com/example/status/123"
        },
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage(message) { messages.push(message); }
    };

    runtime.listeners.runtimeConnect(port);
    runtime.listeners.actionClicked({ id: 10 });

    assert.deepEqual(Array.from(messages[messages.length - 1]), [17]);
});

test('full preparation queue leaves newest automatic download in Chrome', async()=>{
    const runtime=loadBackground({deferCookies:true});
    for(let i=0;i<22;i++) {
        const url=`https://example.com/queued-${i}.zip`;
        simulateResponse(runtime,{id:`queue-${i}`,url,type:'main_frame',contentType:'application/zip',disposition:`attachment; filename=queued-${i}.zip`});
        runtime.listeners.downloadCreated({id:100+i,url});
    }
    assert.equal(runtime.pendingCookieRequests.length,21);
    assert.deepEqual(runtime.cancelledDownloads,[]);
    runtime.pendingCookieRequests.forEach(request=>request.callback([]));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(runtime.cancelledDownloads,Array.from({length:21},(_,i)=>100+i));
    assert.equal(runtime.sentMessages.filter(x=>x.startsWith('1:')).length,21);
});
test('oversized captured request never cancels the browser download', async()=>{
    const runtime=loadBackground({cookies:[{domain:'example.com',hostOnly:true,path:'/',name:'large',value:'x'.repeat(120000)}]});
    const url='https://example.com/oversized.zip';
    simulateResponse(runtime,{id:'oversized',url,type:'main_frame',contentType:'application/zip',disposition:'attachment; filename=oversized.zip'});
    runtime.listeners.downloadCreated({id:199,url});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(runtime.cancelledDownloads,[]);
    assert.equal(runtime.sentMessages.filter(x=>x.startsWith('1:')).length,0);
});

test('each video handoff has its own session token, including an explicit anonymous handoff', async () => {
    const options = { cookies: [{ domain: '.youtube.com', path: '/', hostOnly: false,
        secure: true, httpOnly: true, session: true, name: 'SID', value: 'fixture-account' }] };
    const runtime = loadBackground(options);
    const target = 'https://www.youtube.com/watch?v=fixture';
    let receive;
    runtime.listeners.runtimeConnect({ sender: { tab: { id: 10, title: 'Video', url: target }, frameId: 0, url: target },
        onMessage: { addListener(listener) { receive = listener; } }, onDisconnect: { addListener() {} }, postMessage() {} });
    const send = () => receive([6, { 1: 'GET', 2: target, 6: 'media-page' }, target, 'Video', 'Chrome']);
    send(); await new Promise(resolve => setImmediate(resolve));
    options.cookies = [];
    send(); await new Promise(resolve => setImmediate(resolve));
    const messages = runtime.sentMessages.filter(value => value.startsWith('1:GET'));
    assert.equal(messages.length, 2);
    const tokens = messages.map(value => value.match(/\r\n15:([^\r]+)/)[1]);
    assert.notEqual(tokens[0], tokens[1]);
    const jars = messages.map(value => Buffer.from(value.match(/\r\n14:([^\r]+)/)[1], 'base64').toString());
    assert.match(jars[0], /#HttpOnly_\.youtube.com\tTRUE\t\/\tTRUE\t0\tSID\tfixture-account/);
    assert.equal(jars[1], '# Netscape HTTP Cookie File\n');
    const before = runtime.sentMessages.length;
    await runtime.worker.refreshMediaSession({requestId:'refresh-known', sessionID:tokens[0],url:target});
    const refresh = JSON.parse(runtime.sentMessages.at(-1).slice('NDMRelaySessionResponse:'.length));
    assert.equal(refresh.sessionID, tokens[0]);
    assert.equal(Buffer.from(refresh.cookies, 'base64').toString(), '# Netscape HTTP Cookie File\n');
    await runtime.worker.refreshMediaSession({requestId:'foreign',sessionID:tokens[0],url:'https://evil.example/'});
    await runtime.worker.refreshMediaSession({requestId:'unknown',sessionID:'unknown-token',url:target});
    assert.equal(runtime.sentMessages.length, before + 1);
});
