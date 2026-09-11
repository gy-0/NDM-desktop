/* Browser downloads remain recoverable until the host commits the task. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.NDMBrowserHandoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const key = 'ndmBrowserHandoffsV1';
    function create({ storage, downloads, canSend, send, focus, idFactory, preparationTimeout = 4000 }) {
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
            clear(item.id); items.delete(item.id); await save();
        }
        async function release(item) {
            if (item.downloadId != null && item.ownsPause) {
                const [current] = await downloads.search({ id: item.downloadId });
                if (current?.state === 'in_progress' && current.paused) await downloads.resume(item.downloadId);
            }
            await remove(item);
        }
        async function finish(item) {
            if (item.downloadId == null) {
                later(item.id, () => queue(() => remove(item)), 30000);
                return;
            }
            if (item.phase === 'accepted') {
                // cancel may fail if a very small download already completed.
                try { await downloads.cancel(item.downloadId); } catch (_) {}
                await downloads.erase({ id: item.downloadId });
                await remove(item);
            } else await release(item);
        }
        async function transmit(item) {
            if (!items.has(item.id)) return;
            if (['accepted', 'rejected'].includes(item.phase)) {
                later(item.id, () => queue(() => transmit(item)), 2000);
                await save(); await finish(item); return;
            }
            if (!canSend() || !['ready', 'sent'].includes(item.phase)) return;
            // Persist BEFORE send: a worker restart replays the same id, never a new task.
            const previous = item.phase;
            item.phase = 'sent';
            try { await save(); } catch (error) { item.phase = previous; throw error; }
            clear(item.id);
            try { send('NDMRelayDownload:' + JSON.stringify({ requestId: item.id, payload: item.payload })); } catch (_) {}
            // Unknown delivery is not rejection. Re-send idempotently until a receipt arrives.
            later(item.id, () => queue(() => transmit(item)), 2000);
        }
        const ready = queue(async () => {
            const saved = (await storage.get(key))[key] || [];
            for (const item of saved) items.set(item.id, item);
            for (const item of saved) {
                if (['preparing', 'ready', 'rejected'].includes(item.phase)) await release(item);
                else if (item.phase === 'accepted') await finish(item);
                else await transmit(item);
            }
        });
        ready.catch(() => {});
        return {
            ready,
            begin(url) {
                if (items.size >= 21) return null;
                const item = { id: idFactory(), url, phase: 'preparing', downloadId: null, ownsPause: false };
                items.set(item.id, item);
                queue(save).catch(() => { items.delete(item.id); });
                focus();
                later(item.id, () => queue(async () => {
                    if (['preparing', 'ready'].includes(item.phase)) { item.phase = 'rejected'; await save(); await release(item); }
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
                    if (item && ['preparing', 'ready'].includes(item.phase)) { item.phase = 'rejected'; await save(); await release(item); }
                });
            },
            receipt(receipt) {
                return queue(async () => {
                    const item = items.get(receipt.requestId);
                    if (!item || item.phase !== 'sent' || !['accepted', 'deleted', 'rejected'].includes(receipt.status)) return;
                    item.phase = receipt.status === 'rejected' ? 'rejected' : 'accepted';
                    delete item.payload;
                    later(item.id, () => queue(() => transmit(item)), 2000);
                    await save(); await finish(item);
                });
            },
            connected() { return queue(async () => { for (const item of [...items.values()]) {
                if (['accepted', 'rejected'].includes(item.phase)) await finish(item);
                else await transmit(item);
            } }); },
            idle() { return tail; },
            dispose() { for (const id of timers.keys()) clear(id); }
        };
    }
    return { create, key };
});
