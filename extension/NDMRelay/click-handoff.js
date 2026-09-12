/* Pre-navigation file intents: no Chrome download exists for this path. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.NDMClickHandoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const key = 'ndmClickHandoffsV1';
    const validID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
    const sameContext = (a, b) => a && b && a.tabId === b.tabId && a.frameId === b.frameId && a.documentId === b.documentId && a.pageURL === b.pageURL;
    function create({ storage, canSend, canStart = () => true, send, notify = () => {}, retryDelay = 2000, preparationTimeout = 3500 }) {
        const items = new Map(), timers = new Map(), bound = new Map();
        let tail = Promise.resolve(), disposed = false;
        const save = () => storage.set({ [key]: [...items.values()] });
        function queue(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; }
        function clear(id) { clearTimeout(timers.get(id)); timers.delete(id); }
        function later(item, fn, delay = retryDelay) {
            clear(item.id);
            if (!disposed) timers.set(item.id, setTimeout(() => queue(fn).catch(() => {}), delay));
        }
        function emit(item, status = item.phase, reason = item.reason) {
            if (['accepted', 'deleted', 'fallback'].includes(status) && item.attempts > 0 && item.resultPersisted === false) {
                status = 'pending'; reason = 'storage-failed';
            }
            try { notify(item.context, { requestId: item.id, status: ['preparing', 'ready', 'sent'].includes(status) ? 'pending' : status, ...(reason ? { reason } : {}) }); } catch (_) {}
        }
        function prune() {
            const terminal = [...items.values()].filter(item => ['accepted', 'deleted', 'fallback'].includes(item.phase) && item.resultPersisted !== false && !(item.bypassUntil > Date.now()));
            for (const item of terminal.slice(0, Math.max(0, terminal.length - 128))) items.delete(item.id);
        }
        async function finish(item, status, reason) {
            item.phase = status; item.reason = reason; item.resultPersisted = false; delete item.payload; clear(item.id);
            try { await save(); item.resultPersisted = true; }
            catch (_) {
                // Replaying a saved sent request after a browser fallback would
                // create two owners. Persist the terminal decision first.
                if (!item.attempts && status === 'fallback') emit(item);
                else emit(item, 'pending', 'storage-failed');
                later(item, () => finish(item, status, reason)); return;
            }
            emit(item);
        }
        async function transmit(item) {
            if (disposed || !['ready', 'sent'].includes(item.phase)) return;
            if (!item.attempts && (!canSend() || !canStart(item.context))) { await finish(item, 'fallback', 'unavailable'); return; }
            if (!canSend()) { emit(item, 'pending', 'offline'); later(item, () => transmit(item)); return; }
            const previous = { phase: item.phase, attempts: item.attempts };
            item.phase = 'sent'; item.attempts++;
            try { await save(); }
            catch (_) {
                Object.assign(item, previous);
                if (!item.attempts) await finish(item, 'fallback', 'storage-failed');
                else { emit(item, 'pending', 'storage-failed'); later(item, () => transmit(item)); }
                return;
            }
            // Once a send is attempted, its outcome can only be resolved by a
            // host receipt. Retries retain the exact ID and immutable payload.
            try { send('NDMRelayDownload:' + JSON.stringify({ requestId: item.id, payload: item.payload })); } catch (_) {}
            emit(item, 'pending'); later(item, () => transmit(item));
        }
        const ready = queue(async () => {
            const saved = (await storage.get(key))[key] || [];
            if (!Array.isArray(saved) || saved.length > 256 || saved.some(item => !item || !validID(item.id) ||
                !['preparing', 'ready', 'sent', 'accepted', 'deleted', 'fallback'].includes(item.phase) || !item.context ||
                !Number.isInteger(item.attempts) || item.attempts < 0 || item.phase === 'sent' && typeof item.payload !== 'string')) throw Error('invalid-click-session');
            for (const item of saved) {
                if (['accepted', 'deleted', 'fallback'].includes(item.phase)) item.resultPersisted = true;
                items.set(item.id, item);
            }
            for (const item of saved) {
                if (['preparing', 'ready'].includes(item.phase)) await finish(item, 'fallback', 'preparation-interrupted');
                else if (item.phase === 'sent') await transmit(item);
            }
        });
        ready.catch(() => {});
        return {
            ready,
            mayHaveSent(id) { const item = items.get(id); return !!(item && item.attempts > 0 && (item.phase !== 'fallback' || item.resultPersisted === false)); },
            hasPending() { return [...items.values()].some(item => ['preparing', 'ready', 'sent'].includes(item.phase)); },
            active(id) { return items.get(id)?.phase === 'preparing'; },
            begin(request) {
                return queue(async () => {
                    await ready;
                    prune();
                    const existing = items.get(request.requestId);
                    if (existing) {
                        if (existing.url !== request.url || !sameContext(existing.context, request.context)) return { prepare: false, error: 'id-conflict' };
                        emit(existing); return { prepare: false };
                    }
                    if (!validID(request.requestId) || items.size >= 256 || [...items.values()].filter(item => ['preparing', 'ready', 'sent'].includes(item.phase)).length >= 21) return { prepare: false, error: 'queue-full' };
                    const item = { id: request.requestId, url: request.url, context: request.context, phase: 'preparing', attempts: 0 };
                    items.set(item.id, item);
                    if (!canSend() || !canStart(item.context)) { await finish(item, 'fallback', 'unavailable'); return { prepare: false }; }
                    try { await save(); }
                    catch (_) { await finish(item, 'fallback', 'storage-failed'); return { prepare: false }; }
                    later(item, () => item.phase === 'preparing' ? finish(item, 'fallback', 'preparation-timeout') : Promise.resolve(), preparationTimeout);
                    return { prepare: true };
                });
            },
            payload(id, payload) {
                return queue(async () => {
                    const item = items.get(id);
                    if (!item || item.phase !== 'preparing') return false;
                    if (typeof payload !== 'string' || new TextEncoder().encode('NDMRelayDownload:' + JSON.stringify({ requestId: id, payload })).length > 118784) {
                        await finish(item, 'fallback', 'request-too-large'); return false;
                    }
                    item.payload = payload; item.phase = 'ready'; await transmit(item); return item.phase !== 'fallback';
                });
            },
            reject(id, reason = 'preparation-failed') {
                return queue(async () => { const item = items.get(id); if (item && !item.attempts && ['preparing', 'ready'].includes(item.phase)) await finish(item, 'fallback', reason); });
            },
            receipt(receipt) {
                return queue(async () => {
                    const item = receipt && items.get(receipt.requestId);
                    if (!item || item.phase !== 'sent') return false;
                    if (['accepted', 'deleted'].includes(receipt.status)) await finish(item, receipt.status);
                    else if (receipt.status === 'rejected' && receipt.error === 'payload-mismatch') {
                        // Native has already bound this ID to another payload.
                        // Even a locally first attempt cannot grant Chrome a
                        // second owner. Keep the uncertainty across later errors.
                        item.uncertainRejection = true;
                        try { await save(); } catch (_) {}
                        emit(item, 'pending', 'payload-mismatch'); later(item, () => transmit(item));
                    }
                    else if (receipt.status === 'rejected' && item.attempts === 1 && !item.uncertainRejection) await finish(item, 'fallback', 'native-rejected');
                    else if (receipt.status === 'rejected') { emit(item, 'pending', 'unconfirmed-rejection'); later(item, () => transmit(item)); }
                    return true;
                });
            },
            connected() { return queue(async () => { for (const item of items.values()) if (item.phase === 'sent') await transmit(item); }); },
            replay(context) { for (const item of items.values()) if (sameContext(item.context, context)) emit(item); },
            armFallback(request) {
                return queue(async () => {
                    await ready;
                    prune();
                    let item = items.get(request.requestId);
                    if (item && (item.phase !== 'fallback' || item.url !== request.url || !sameContext(item.context, request.context))) return false;
                    if (!item) {
                        if (!validID(request.requestId) || items.size >= 256) return false;
                        item = { id: request.requestId, url: request.url, context: request.context, phase: 'fallback', attempts: 0 };
                        items.set(item.id, item);
                    }
                    item.bypassUntil = Date.now() + 30000; delete item.boundRequestId; await save(); item.resultPersisted = true; return true;
                });
            },
            bindFallback(details, documentId) {
                const scopeMatches = item => item.context.tabId === details.tabId && item.context.frameId === details.frameId && item.context.documentId === documentId;
                if (bound.has(details.requestId)) return scopeMatches(bound.get(details.requestId));
                const restored = [...items.values()].find(item => item.boundRequestId === details.requestId && item.bypassUntil > Date.now() && scopeMatches(item));
                if (restored) { bound.set(details.requestId, restored); return true; }
                const item = [...items.values()].find(item => item.phase === 'fallback' && !item.boundRequestId && item.bypassUntil > Date.now() &&
                    item.url === details.url && item.context.tabId === details.tabId && item.context.frameId === details.frameId && item.context.documentId === documentId);
                if (!item) return false;
                item.boundRequestId = details.requestId; bound.set(details.requestId, item); queue(save).catch(() => {}); return true;
            },
            completed(requestId) { bound.delete(requestId); },
            idle() { return tail; },
            dispose() { disposed = true; for (const id of timers.keys()) clear(id); }
        };
    }
    return { create, key, validID };
});
