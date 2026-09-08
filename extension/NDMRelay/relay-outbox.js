(function(root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.NDMRelayOutbox = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    var KEY = "ndmRelayOutboxV1";
    var CAPACITY = 21;
    var ENVELOPE_LIMIT = 118784;
    var SESSION_BUDGET = 8 * 1024 * 1024;
    var encoder = new TextEncoder();
    function bytes(value) { return encoder.encode(value).byteLength; }
    function validID(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id); }
    function envelope(requestId, payload) {
        return "NDMRelayDownload:" + JSON.stringify({ requestId: requestId, payload: payload });
    }
    function clone(items) {
        return items.map(function(item) { return { requestId: item.requestId, payload: item.payload, createdAt: item.createdAt }; });
    }
    function stored(items) { return { version: 1, items: clone(items) }; }
    function withinBudget(items) { return bytes(JSON.stringify({ [KEY]: stored(items) })) <= SESSION_BUDGET; }
    function validItem(item) {
        return item && typeof item === "object" && validID(item.requestId)
            && typeof item.payload === "string" && Number.isFinite(item.createdAt) && item.createdAt >= 0
            && bytes(envelope(item.requestId, item.payload)) <= ENVELOPE_LIMIT;
    }

    /** Session-only ownership: survives a worker rebuild, NOT browser restart.
     * Requires chrome.storage.session's Promise API. No local/disk fallback.
     * One active worker owns mutations; the storage API supplies no cross-worker CAS.
     * Callers may send only after admit succeeds; remove only after a correlated ACK.
     * snapshot is asynchronous and serialized with all other operations.
     */
    function create(options) {
        options = options || {};
        var storage = options.storage, idFactory = options.idFactory, now = options.now || Date.now;
        var items = [];
        var ready = Promise.resolve().then(async function() {
            if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function" || typeof idFactory !== "function") {
                throw new Error("session-storage-unavailable");
            }
            var result = await storage.get(KEY);
            var state = result && result[KEY];
            if (state === undefined) return;
            if (!state || state.version !== 1 || !Array.isArray(state.items) || state.items.length > CAPACITY
                || !state.items.every(validItem) || new Set(state.items.map(function(item) { return item.requestId; })).size !== state.items.length
                || !withinBudget(state.items)) throw new Error("invalid-session-outbox");
            items = clone(state.items);
        });
        // Preserve the initialization error for every caller while avoiding an
        // unhandled rejection if the caller first awaits admit instead of ready.
        var tail = ready.catch(function() {});
        function serialize(operation) {
            var result = tail.then(function() { return ready; }).then(operation);
            tail = result.catch(function() {});
            return result;
        }
        return {
            ready: ready,
            admit: function(payload) {
                return serialize(async function() {
                    if (typeof payload !== "string") return { accepted: false, error: "invalid-payload" };
                    var id;
                    try { id = idFactory(); } catch (_) { return { accepted: false, error: "invalid-request-id" }; }
                    if (!validID(id)) return { accepted: false, error: "invalid-request-id" };
                    var existing = items.find(function(item) { return item.requestId === id; });
                    if (existing) return existing.payload === payload
                        ? { accepted: true, requestId: id }
                        : { accepted: false, error: "id-conflict" };
                    if (bytes(envelope(id, payload)) > ENVELOPE_LIMIT) return { accepted: false, error: "request-too-large" };
                    if (items.length >= CAPACITY) return { accepted: false, error: "queue-full" };
                    var createdAt = now();
                    if (!Number.isFinite(createdAt) || createdAt < 0) return { accepted: false, error: "invalid-time" };
                    var next = clone(items);
                    next.push({ requestId: id, payload: payload, createdAt: createdAt });
                    if (!withinBudget(next)) return { accepted: false, error: "session-budget" };
                    try { await storage.set({ [KEY]: stored(next) }); }
                    catch (_) { return { accepted: false, error: "storage-failed" }; }
                    items = next;
                    return { accepted: true, requestId: id };
                });
            },
            ack: function(requestId) {
                return serialize(async function() {
                    if (!items.some(function(item) { return item.requestId === requestId; })) return { removed: false };
                    var next = items.filter(function(item) { return item.requestId !== requestId; });
                    // A failed deletion retains the request for idempotent replay.
                    await storage.set({ [KEY]: stored(next) });
                    items = next;
                    return { removed: true };
                });
            },
            snapshot: function() { return serialize(function() { return clone(items); }); }
        };
    }
    return { create: create, key: KEY, capacity: CAPACITY, envelopeLimit: ENVELOPE_LIMIT, sessionBudget: SESSION_BUDGET, envelope: envelope };
});
