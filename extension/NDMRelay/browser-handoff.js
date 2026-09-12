/* Browser downloads remain recoverable until the host commits the task. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.NDMBrowserHandoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const key = 'ndmBrowserHandoffsV1';
    function create({ storage, downloads, canSend, send, focus, idFactory, preparationTimeout = 4000, retryDelay = 2000 }) {
        const items = new Map();
        let tail = Promise.resolve();
        const timers = new Map();
        const save = () => storage.set({ [key]: [...items.values()] });
        function queue(fn) {
            const result = tail.then(fn);
            tail = result.catch(() => {});
            return result;
        }
        function clear(id) { clearTimeout(timers.get(id)); timers.delete(id); }
        function later(id, fn, ms) { clear(id); timers.set(id, setTimeout(() => { fn().catch(() => {}); }, ms)); }
        async function remove(item) {
            // Keep ownership and a retry until the removal is durable. A failed
            // session write must not silently orphan a still-persisted handoff.
            later(item.id, () => queue(() => remove(item)), retryDelay);
            await storage.set({ [key]: [...items.values()].filter(current => current !== item) });
            items.delete(item.id); clear(item.id);
        }
        async function release(item) {
            if (item.downloadId != null && item.ownsPause) {
                const [current] = await downloads.search({ id: item.downloadId });
                if (current?.state === 'in_progress' && current.paused) await downloads.resume(item.downloadId);
            }
            await remove(item);
        }
        async function finish(item) {
            if (!items.has(item.id)) return;
            // Schedule before any API call: failures during receipt processing,
            // preparation timeout or worker recovery all need the same retry.
            later(item.id, () => queue(() => finish(item)), retryDelay);
            await save();
            if (item.downloadId == null) {
                later(item.id, () => queue(() => remove(item)), 30000);
                return;
            }
            if (item.phase === 'accepted') {
                // cancel may fail if a very small download already completed.
                try { await downloads.cancel(item.downloadId); }
                catch (error) {
                    const [current] = await downloads.search({ id: item.downloadId });
                    // An actual cancellation failure is retryable. Erasing an
                    // active entry here would hide a duplicate browser transfer.
                    if (current?.state === 'in_progress') throw error;
                }
                await downloads.erase({ id: item.downloadId });
                await remove(item);
            } else await release(item);
        }
        async function transmit(item) {
            if (!items.has(item.id)) return;
            if (['accepted', 'rejected'].includes(item.phase)) {
                await finish(item); return;
            }
            if (!canSend() || !['ready', 'sent'].includes(item.phase)) return;
            // Persist BEFORE send: a worker restart replays the same id, never a new task.
            const previous = item.phase;
            item.phase = 'sent';
            // Unknown delivery is not rejection. Re-send idempotently until a receipt arrives.
            later(item.id, () => queue(() => transmit(item)), retryDelay);
            try { await save(); } catch (error) { item.phase = previous; throw error; }
            try { send('NDMRelayDownload:' + JSON.stringify({ requestId: item.id, payload: item.payload })); } catch (_) {}
        }
        const ready = queue(async () => {
            const saved = (await storage.get(key))[key] || [];
            for (const item of saved) items.set(item.id, item);
            for (const item of saved) {
                if (['preparing', 'ready'].includes(item.phase)) item.phase = 'rejected';
                // Every item retains its own retry. One transient API failure
                // must not prevent the rest of the browser downloads recovering.
                try { await transmit(item); } catch (_) {}
            }
        });
        ready.catch(() => {});
        return {
            ready,
            begin(url) {
                if (items.size >= 21) return null;
                const item = { id: idFactory(), url, phase: 'preparing', downloadId: null, ownsPause: false };
                items.set(item.id, item);
                queue(save).catch(() => { items.delete(item.id); clear(item.id); });
                focus();
                later(item.id, () => queue(async () => {
                    if (['preparing', 'ready'].includes(item.phase)) { item.phase = 'rejected'; await finish(item); }
                }), preparationTimeout);
                return item.id;
            },
            active(id) { return items.has(id); },
            hasPending() { return [...items.values()].some(item => ['preparing', 'ready', 'sent'].includes(item.phase)); },
            attach(download) {
                const item = [...items.values()].find(i => i.downloadId == null && (i.url === download.url || i.url === download.finalUrl));
                if (!item) return false;
                item.downloadId = download.id;
                item.ownsPause = download.paused !== true;
                queue(async () => {
                    // begin's queued persistence may have failed since onCreated
                    // matched this item. Never pause a download without an owner.
                    if (!items.has(item.id)) return;
                    await save();
                    if (['accepted', 'rejected'].includes(item.phase)) { await finish(item); return; }
                    if (item.ownsPause) {
                        try { await downloads.pause(download.id); } catch (_) { item.ownsPause = false; await save(); }
                    }
                }).catch(() => {});
                return true;
            },
            payload(id, payload) {
                return queue(async () => {
                    const item = items.get(id);
                    if (!item || item.phase !== 'preparing') return false;
                    item.payload = payload; item.phase = 'ready'; await save(); await transmit(item); return true;
                });
            },
            reject(id) {
                return queue(async () => {
                    const item = items.get(id);
                    if (item && ['preparing', 'ready'].includes(item.phase)) { item.phase = 'rejected'; await finish(item); }
                });
            },
            receipt(receipt) {
                return queue(async () => {
                    const item = items.get(receipt.requestId);
                    if (!item || item.phase !== 'sent' || !['accepted', 'deleted', 'rejected'].includes(receipt.status)) return;
                    item.phase = receipt.status === 'rejected' ? 'rejected' : 'accepted';
                    delete item.payload;
                    await finish(item);
                });
            },
            connected() { return queue(async () => {
                for (const item of [...items.values()]) {
                    try { await transmit(item); } catch (_) {}
                }
            }); },
            idle() { return tail; },
            dispose() { for (const id of timers.keys()) clear(id); }
        };
    }
    return { create, key };
});
