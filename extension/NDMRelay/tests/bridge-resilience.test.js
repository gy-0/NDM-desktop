const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) {
    return fs.readFileSync(path.join(__dirname, "..", name), "utf8");
}

test("bridge close never discards queued clicks", () => {
    const background = source("bg.js");
    const onClose = background.match(/W\.ca = function\(\) \{[\s\S]*?\n\};/);
    assert.ok(onClose, "W.ca handler exists");
    assert.doesNotMatch(onClose[0], /pendingRelayQueue\s*=\s*\[\]/);
    assert.match(onClose[0], /scheduleBridgeRetry/);
});

test("bridge error keeps the queue and retries with a bounded backoff", () => {
    const background = source("bg.js");
    const onError = background.match(/W\.da = function\(\) \{[\s\S]*?\n\};/);
    assert.ok(onError, "W.da handler exists");
    assert.doesNotMatch(onError[0], /pendingRelayQueue\s*=\s*\[\]/);
    assert.match(background, /Math\.min\(2 \* this\.bridgeRetryMs, 15000\)/);
    assert.match(background, /this\.lastBridgeNoticeAt > 8000/);
});

test("pending queue is capped so it can never grow unbounded", () => {
    const background = source("bg.js");
    assert.match(background, /20 < this\.pendingRelayQueue\.length && this\.pendingRelayQueue\.shift\(\)/);
});

test("open resets the retry clock", () => {
    const onOpen = source("bg.js").match(/W\.fa = function\(\) \{[\s\S]*?\n\};/);
    assert.ok(onOpen, "W.fa handler exists");
    assert.match(onOpen[0], /clearTimeout\(this\.bridgeRetryTimer\)/);
    assert.match(onOpen[0], /this\.bridgeRetryMs = 0/);
});

test("pages show an inline bridge notice instead of a blocking alert", () => {
    const content = source("ct.js");
    assert.doesNotMatch(content, /\balert\(/);
    assert.match(content, /showBridgeNotice/);
    // The notice must promise queue-and-flush semantics, matching bg.js.
    assert.match(content, /已暂存|queued/);
    assert.match(content, /无法连接到 NDM|Can't reach NDM/);
    // Isolated shadow root, restrained solid surface (no glass).
    assert.match(content, /attachShadow/);
    assert.doesNotMatch(content.match(/O\.showBridgeNotice[\s\S]*?\n    \};/)[0], /backdrop-filter|linear-gradient/i);
});

test("content port reconnect survives extension context invalidation", () => {
    const content = source("ct.js");
    const reconnect = content.match(/O\.ca = function\(\) \{[\s\S]*?\n    \};/);
    assert.ok(reconnect, "port reconnect exists");
    assert.match(reconnect[0], /try \{/);
    assert.match(reconnect[0], /Extension context invalidated/);
    assert.match(reconnect[0], /3 <= \+\+this\.portRetries/);
});

test("the ndm:// handoff tab never lingers after the bridge comes alive", () => {
    const background = source("bg.js");
    const popup = source("popup.js");
    assert.match(background, /relay:handoff/);
    assert.match(background, /handoffTabId >= 0[\s\S]*?chrome\.tabs\.remove/);
    // Popup closes its own handoff tab as soon as the probe connects...
    assert.match(popup, /state === "connected"\) closeHandoffTab\(\)/);
    // ...and hands the tab id to the worker for the popup-closed case.
    assert.match(popup, /type: "relay:handoff", tabId/);
});

test("popup contract still pins the bridge endpoint and protocol", () => {
    const popup = source("popup.js");
    assert.match(popup, /ws:\/\/127\.0\.0\.1:51873\/ndm\/download/);
    assert.match(popup, /"ndm\.open\.v1"/);
});

test("extension falls back to the legacy bridge port when the primary drifts", () => {
    const background = source("bg.js");
    const popup = source("popup.js");
    // Both sides know both addresses; the worker rotates on a failed dial with
    // pending intent and persists whichever endpoint answered.
    assert.match(background, /"ws:\/\/127\.0\.0\.1:51873\/ndm\/download", "ws:\/\/127\.0\.0\.1:10007\/ndm\/download"/);
    assert.match(background, /bridgeEndpointIndex = \(this\.bridgeEndpointIndex \+ 1\) % this\.bridgeEndpoints\.length/);
    assert.match(background, /chrome\.storage\.local\.set\(\{ bridgeEndpoint: chosen \}/);
    assert.match(popup, /BRIDGE_URL_FALLBACK = "ws:\/\/127\.0\.0\.1:10007\/ndm\/download"/);
    assert.match(popup, /probeBridge\(retries - 1, Number\(endpointIndex \|\| 0\) \+ 1\)/);
});
