/* The browser owns the session. Read only cookies eligible for the requested
 * URL, from the initiating tab's store/partition, at the moment of handoff. */
(function(root) {
    'use strict';
    const clean = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
    function matches(cookie, rawURL, now = Date.now() / 1000) {
        let url;
        try { url = new URL(rawURL); } catch (_) { return false; }
        if (!/^https?:$/.test(url.protocol) || !cookie || !clean(cookie.domain) ||
            !clean(cookie.path) || !clean(cookie.name) || !clean(cookie.value)) return false;
        const domain = cookie.domain.toLowerCase().replace(/^\./, '');
        const host = url.hostname.toLowerCase(), path = cookie.path || '/';
        if (!domain || (cookie.hostOnly ? host !== domain : host !== domain && !host.endsWith('.' + domain))) return false;
        if (!path.startsWith('/') || !(url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : path + '/'))) return false;
        if (cookie.secure && url.protocol !== 'https:') return false;
        return cookie.session || cookie.expirationDate === undefined || cookie.expirationDate > now;
    }
    function scoped(cookies, url) {
        return (Array.isArray(cookies) ? cookies : []).filter(cookie => matches(cookie, url));
    }
    function header(cookies, url) {
        return scoped(cookies, url).map(cookie => cookie.name + '=' + cookie.value).join('; ');
    }
    function netscape(cookies, url) {
        const lines = scoped(cookies, url).map(cookie => {
            const domain = (cookie.hostOnly ? '' : '.') + cookie.domain.replace(/^\./, '').toLowerCase();
            return [(cookie.httpOnly ? '#HttpOnly_' : '') + domain, cookie.hostOnly ? 'FALSE' : 'TRUE',
                cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE',
                cookie.session || cookie.expirationDate === undefined ? '0' : String(Math.floor(cookie.expirationDate)),
                cookie.name, cookie.value].join('\t');
        });
        return lines.length ? '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n' : '';
    }
    function encode(text) {
        return btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(''));
    }
    function browserName(navigator) {
        const ua = navigator?.userAgent || '';
        const brands = (navigator?.userAgentData?.brands || []).map(item => item.brand).join(' ');
        if (/Firefox\//i.test(ua)) return 'firefox';
        if (/Edg\//i.test(ua) || /Microsoft Edge/i.test(brands)) return 'edge';
        if (/Brave/i.test(brands)) return 'brave';
        // The host accepts Chromium-family sessions; the opaque token still
        // pins the exact originating store, without guessing an Opera profile.
        if (/OPR\//i.test(ua)) return 'chromium';
        return 'chrome';
    }
    // Supports both Chromium callbacks and Promise-only WebExtension methods.
    function invoke(api, name, args, runtime) {
        return new Promise((resolve, reject) => {
            let finished = false;
            const timer = setTimeout(() => done(new Error('session-read-timeout')), 1500);
            function done(error, value) {
                if (finished) return;
                finished = true; clearTimeout(timer);
                error ? reject(error) : resolve(value);
            }
            try {
                const result = api[name](...args, value => done(runtime?.lastError ? new Error('session-read-unavailable') : null, value));
                if (result?.then) result.then(value => done(null, value), error => done(error));
            } catch (error) { done(error); }
        });
    }
    async function capture(chrome, request) {
        const api = chrome.cookies, details = { url: request.url };
        if (typeof request.storeId === 'string') details.storeId = request.storeId;
        else if (Number.isInteger(request.tabId) && request.tabId >= 0 && api.getAllCookieStores) {
            const stores = await invoke(api, 'getAllCookieStores', [], chrome.runtime);
            const store = stores?.find(item => item.tabIds?.includes(request.tabId));
            // Never silently use a different profile or an ordinary store for an incognito tab.
            if (!store) return { cookies: [], context: null };
            details.storeId = store.id;
        }
        let partitionKey = request.partitionKey;
        if (!request.pinnedContext && Number.isInteger(request.tabId) && request.tabId >= 0 && api.getPartitionKey) {
            try {
                const result = await invoke(api, 'getPartitionKey', [{ tabId: request.tabId, frameId: request.frameId || 0 }], chrome.runtime);
                partitionKey = result?.partitionKey;
            } catch (_) { /* Older browsers still provide unpartitioned cookies. */ }
        }
        const queries = [invoke(api, 'getAll', [details], chrome.runtime)];
        if (partitionKey?.topLevelSite) queries.push(invoke(api, 'getAll', [{ ...details, partitionKey }], chrome.runtime));
        const results = await Promise.allSettled(queries);
        if (results.every(result => result.status === 'rejected')) return { cookies: [], context: null };
        const rows = results.flatMap(result => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
        // A partitioned value takes precedence for this frame; never export two
        // conflicting values as an unpartitioned Netscape cookie.
        const unique = new Map();
        for (const row of rows) {
            if (details.storeId !== undefined && row.storeId !== undefined && row.storeId !== details.storeId) continue;
            if (row.partitionKey && (!partitionKey || row.partitionKey.topLevelSite !== partitionKey.topLevelSite ||
                Boolean(row.partitionKey.hasCrossSiteAncestor) !== Boolean(partitionKey.hasCrossSiteAncestor))) continue;
            if (matches(row, request.url)) unique.set([row.domain, row.path, row.name].join('\t'), row);
        }
        return { cookies: [...unique.values()].sort((a, b) => b.path.length - a.path.length),
            context: { url: request.url, tabId: request.tabId, frameId: request.frameId || 0,
                storeId: details.storeId, partitionKey, pinnedContext: true } };
    }
    async function read(chrome, request) { return (await capture(chrome, request)).cookies; }
    function urlKey(raw) {
        try { const url = new URL(raw); if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
            url.hash = ''; return url.href; } catch (_) { return null; }
    }
    // Only opaque identifiers and browser routing live in storage.session;
    // credentials are read fresh and never enter this registry.
    function createRegistry(chrome) {
        const key = 'ndm.relayMediaSessions.v1', memory = new Map();
        let writes = Promise.resolve();
        const ready = chrome.storage?.session
            ? invoke(chrome.storage.session, 'get', [key], chrome.runtime).then(value => {
                for (const item of Array.isArray(value?.[key]) ? value[key].slice(-128) : []) {
                    if (item && typeof item.id === 'string' && urlKey(item.context?.url) && item.expiresAt > Date.now()) memory.set(item.id, item);
                }
            }).catch(() => {}) : Promise.resolve();
        function prune() {
            for (const [id, item] of memory) if (item.expiresAt <= Date.now()) memory.delete(id);
            while (memory.size > 128) memory.delete(memory.keys().next().value);
        }
        return {
            async remember(id, context) {
                await ready;
                if (!context || !urlKey(context.url)) return;
                // Explicit whitelist: never serialize browser Cookie objects.
                memory.set(id, { id, context: { url: context.url, tabId: context.tabId, frameId: context.frameId,
                    storeId: context.storeId, partitionKey: context.partitionKey, pinnedContext: true },
                    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
                prune();
                if (chrome.storage?.session) {
                    writes = writes.catch(() => {}).then(() => invoke(chrome.storage.session, 'set', [{ [key]: [...memory.values()] }], chrome.runtime));
                    await writes.catch(() => {});
                }
            },
            async find(id, url) {
                await ready; prune();
                const item = memory.get(id);
                return item && urlKey(item.context.url) === urlKey(url) ? item.context : null;
            }
        };
    }
    const api = { matches, header, netscape, encode, browserName, read, capture, createRegistry };
    root.NDMRelaySessionCookies = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
