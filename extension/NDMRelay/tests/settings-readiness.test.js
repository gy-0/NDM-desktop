const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../media-policy.js");
const resourcePolicy = require("../resource-policy.js");

function loadBackgroundBeforeSettings() {
    const listeners = {};
    const cancelledDownloads = [];
    const storageWrites = [];
    let resolveSettings;
    let failStorageWrites = false;
    const event = name => ({
        addListener(listener) {
            listeners[name] = listener;
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
        cookies: { getAll(_details, callback) { callback([]); } },
        downloads: {
            onCreated: event("downloadCreated"),
            cancel(id, callback) {
                cancelledDownloads.push(id);
                if (callback) callback();
            },
            erase(_query, callback) { if (callback) callback(); }
        },
        runtime: {
            lastError: null,
            onConnect: event("runtimeConnect"),
            onMessage: event("runtimeMessage")
        },
        i18n: { getMessage() { return ""; } },
        storage: {
            local: {
                get(_keys, callback) { resolveSettings = callback; },
                set(value, callback) {
                    storageWrites.push(value);
                    if (!callback) return;
                    chrome.runtime.lastError = failStorageWrites
                        ? { message: "storage unavailable" }
                        : null;
                    callback();
                    chrome.runtime.lastError = null;
                }
            }
        },
        tabs: {
            query(_query, callback) { callback([]); },
            remove() {}
        },
        webNavigation: { onHistoryStateUpdated: event("historyStateUpdated") },
        webRequest: {
            onBeforeRequest: event("beforeRequest"),
            onBeforeSendHeaders: event("beforeSendHeaders"),
            onCompleted: event("requestCompleted"),
            onErrorOccurred: event("requestError"),
            onHeadersReceived: event("headersReceived")
        }
    };
    class MockWebSocket { send() {} }
    const context = {
        NDMRelayMediaPolicy: policy,
        NDMRelayResourcePolicy: resourcePolicy,
        Headers,
        URL,
        WebSocket: MockWebSocket,
        chrome,
        fetch: async () => ({ ok: false }),
        importScripts() {},
        setTimeout,
        unescape
    };
    context.globalThis = context;
    vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, "..", "bg.js"), "utf8"),
        context,
        { filename: "bg.js" }
    );
    return {
        context,
        listeners,
        cancelledDownloads,
        storageWrites,
        resolveSettings,
        failNextStorageWrite() { failStorageWrites = true; }
    };
}

test("cold worker never intercepts before the persisted catcher setting loads", () => {
    const runtime = loadBackgroundBeforeSettings();
    const url = "https://example.com/archive.zip";
    runtime.context.NDM_BG.forwardedDownloadURLs[url] = Date.now() + 30000;

    runtime.listeners.downloadCreated({ id: 41, url });

    assert.deepEqual(runtime.cancelledDownloads, []);
    runtime.resolveSettings({ DownloadCatcherEnabled: false });
    assert.equal(runtime.context.NDM_BG.v, false);
});

test("popup state waits for persisted settings instead of returning a guessed default", () => {
    const runtime = loadBackgroundBeforeSettings();
    const replies = [];

    const keepsChannelOpen = runtime.listeners.runtimeMessage(
        { type: "relay:getState", tabId: 9 },
        {},
        reply => replies.push(reply)
    );

    assert.equal(keepsChannelOpen, true);
    assert.deepEqual(replies, []);
    runtime.resolveSettings({ DownloadCatcherEnabled: false });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].catcherEnabled, false);
});

test("a catcher toggle arriving during startup is applied after settings load", () => {
    const runtime = loadBackgroundBeforeSettings();
    const replies = [];

    const keepsChannelOpen = runtime.listeners.runtimeMessage(
        { type: "relay:toggleCatcher", enabled: false },
        {},
        reply => replies.push(reply)
    );

    assert.equal(keepsChannelOpen, true);
    assert.deepEqual(replies, []);
    runtime.resolveSettings({});
    assert.equal(runtime.context.NDM_BG.v, false);
    assert.equal(runtime.storageWrites.length, 1);
    assert.equal(runtime.storageWrites[0].DownloadCatcherEnabled, false);
    assert.equal(replies[0].catcherEnabled, false);
    assert.equal(replies[0].saved, true);
});

test("a failed catcher write preserves the last durable setting", () => {
    const runtime = loadBackgroundBeforeSettings();
    const replies = [];
    runtime.resolveSettings({ DownloadCatcherEnabled: true });
    runtime.failNextStorageWrite();

    runtime.listeners.runtimeMessage(
        { type: "relay:toggleCatcher", enabled: false },
        {},
        reply => replies.push(reply)
    );

    assert.equal(runtime.context.NDM_BG.v, true);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].saved, false);
    assert.equal(replies[0].catcherEnabled, true);
});
