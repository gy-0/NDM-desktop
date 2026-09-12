/* Early, deliberately narrow GET-link handoff. No downloads API is used here. */
(function(root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.NDMRelayClickCatcher = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
    'use strict';
    var archive = /\.(?:zip|7z|rar|tar|gz|bz2|xz|dmg|pkg|iso)$/i;
    var safePolicy = /^(?:|strict-origin-when-cross-origin|no-referrer-when-downgrade|same-origin|unsafe-url)$/i;
    function anchorFor(event, win, doc) {
        if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || win.top !== win) return null;
        var path = event.composedPath ? event.composedPath() : [event.target];
        var anchor = path.find(function(el) { return el && el.localName === 'a' && el.hasAttribute('href'); });
        if (!anchor) return null;
        var target = anchor.getAttribute('target') || (doc.querySelector('base[target]') || {}).target || '_self';
        return target.toLowerCase() === '_self' ? anchor : null;
    }
    function candidate(event, win, doc) {
        var anchor = anchorFor(event, win, doc);
        if (!anchor || anchor.hasAttribute('onclick') || anchor.hasAttribute('ping') || anchor.hasAttribute('attributionsrc') || /\bnoreferrer\b/i.test(anchor.getAttribute('rel') || '')) return null;
        var page;
        try { page = new URL(win.location.href); } catch (_) { return null; }
        if (page.username || page.password) return null;
        var metas = Array.from(doc.querySelectorAll('meta[name="referrer" i]'));
        if (!safePolicy.test(anchor.getAttribute('referrerpolicy') || '') || metas.some(function(meta) { return !safePolicy.test(meta.content.trim()); })) return null;
        var url;
        try { url = new URL(anchor.href, win.location.href); } catch (_) { return null; }
        if (!/^https?:$/.test(url.protocol) || url.origin !== win.location.origin || url.username || url.password || url.hash || /[\r\n\0]/.test(anchor.getAttribute('href')) || /%(?:0[ad]|00)/i.test(url.href)) return null;
        var explicit = anchor.hasAttribute('download');
        if (!explicit && (url.search || !archive.test(url.pathname))) return null;
        var filename = explicit ? anchor.getAttribute('download') || '' : '';
        // Let the browser handle names whose platform normalization is ambiguous.
        if (filename.length > 255 || /[\x00-\x1f\x7f\\/]/.test(filename)) return null;
        return { url: url.href, filename: filename, explicitDownload: explicit, pageURL: win.location.href,
            attributes: ['download', 'target', 'rel', 'referrerpolicy'].reduce(function(result, key) {
                if (anchor.hasAttribute(key)) result[key] = anchor.getAttribute(key); return result;
            }, {}) };
    }
    function confirmedFile(response) {
        if (!response.ok || response.redirected) return false;
        var mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (/^(?:text\/|application\/(?:json|xhtml\+xml|xml))/.test(mime)) return false;
        return /^(?:application\/(?:octet-stream|zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|vnd\.rar|x-tar|gzip|x-gzip|x-bzip2|x-xz|x-apple-diskimage|x-iso9660-image|vnd\.apple\.installer\+xml))$/.test(mime)
            || /^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '');
    }
    function install(options) {
        var win = options.window || window, doc = options.document || document;
        var fetcher = options.fetch || win.fetch.bind(win), send = options.send;
        var timer = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
        var available = false, intents = new Map(), byURL = new Map(), bypass = new Map(), disposed = false;
        var noticeHost, noticeText, noticeTimer, policyBlocked = false, policyObserver;
        function inspectPolicies(records) {
            // The effective document policy has no standard read API. Remember
            // restrictive meta policies even after a site removes/replaces them.
            var targets = new Set();
            function scan(node) {
                if (!node || node.nodeType !== 1) return;
                if (node.localName === 'meta' && String(node.getAttribute('name')).toLowerCase() === 'referrer') targets.add(node);
                if (node.querySelectorAll) node.querySelectorAll('meta[name="referrer" i]').forEach(function(meta) { targets.add(meta); });
            }
            (records || []).forEach(function(record) {
                if (record.type === 'attributes') {
                    if (record.target.localName === 'meta' && (String(record.target.getAttribute('name')).toLowerCase() === 'referrer' || record.attributeName === 'name' && String(record.oldValue).toLowerCase() === 'referrer')) targets.add(record.target);
                } else {
                    Array.from(record.addedNodes || []).forEach(scan); Array.from(record.removedNodes || []).forEach(scan);
                }
            });
            doc.querySelectorAll('meta[name="referrer" i]').forEach(function(meta) { targets.add(meta); });
            targets.forEach(function(meta) { if (!safePolicy.test((meta.getAttribute('content') || '').trim())) policyBlocked = true; });
            (records || []).forEach(function(record) {
                if (targets.has(record.target) && record.attributeName === 'content' && record.oldValue !== null && !safePolicy.test(record.oldValue.trim())) policyBlocked = true;
            });
        }
        if (win.MutationObserver) {
            policyObserver = new win.MutationObserver(inspectPolicies);
            policyObserver.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['name', 'content'], attributeOldValue: true });
        }
        function notice(state) {
            if (options.notice) { options.notice(state); return; }
            if (!doc.body) return;
            if (!noticeHost || !noticeHost.isConnected) {
                noticeHost = doc.createElement('div'); noticeHost.id = 'ndm-relay-click-notice';
                var shadow = noticeHost.attachShadow({ mode: 'closed' });
                var style = doc.createElement('style');
                style.textContent = ':host{all:initial} .notice{position:fixed;z-index:2147483647;bottom:22px;left:50%;transform:translateX(-50%);box-sizing:border-box;max-width:calc(100vw - 32px);padding:12px 16px;border:1px solid rgba(60,60,67,.24);border-radius:12px;background:#f7f7f8;color:#1d1d1f;box-shadow:0 10px 30px rgba(0,0,0,.16);font:500 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){.notice{background:#1e2025;color:#f5f5f7;border-color:rgba(255,255,255,.135)}}';
                noticeText = doc.createElement('div'); noticeText.className = 'notice'; noticeText.setAttribute('role', 'status');
                shadow.append(style, noticeText); doc.body.appendChild(noticeHost);
            }
            var zh = /^zh/i.test(win.navigator.language || '');
            noticeText.textContent = ({ checking: zh ? '正在确认下载…' : 'Checking download…',
                pending: zh ? '正在确认 NDM 是否已接收，连接恢复后会自动继续。' : 'Confirming receipt from NDM. This will continue when reconnected.',
                accepted: zh ? '已交给 NDM' : 'Sent to NDM', deleted: zh ? '此下载已在 NDM 中删除' : 'This download was deleted in NDM',
                fallback: zh ? '继续使用浏览器下载' : 'Continuing in the browser',
                navigation: zh ? '页面已变化，下载尚未交给 NDM，请重新点击下载。' : 'The page changed before handoff. Click the download again.' })[state];
            clear(noticeTimer);
            if (state !== 'pending' && state !== 'checking') noticeTimer = timer(function() { if (noticeHost) noticeHost.remove(); }, 2600);
        }
        function current(intent) { return !disposed && intent.pageURL === win.location.href; }
        function release(intent) { intents.delete(intent.requestId); if (byURL.get(intent.url) === intent) byURL.delete(intent.url); clear(intent.watchdog); }
        function replay(intent) {
            release(intent);
            if (!current(intent)) return;
            if (options.replay) { options.replay(intent); return; }
            // Re-run only the default link action: page handlers already saw the
            // trusted click. A detached clone with copied onclick would run twice.
            var anchor = doc.createElement('a'); anchor.href = intent.url;
            Object.keys(intent.attributes).forEach(function(key) { anchor.setAttribute(key, intent.attributes[key]); });
            anchor.hidden = true; anchor.addEventListener('click', function(event) { event.stopPropagation(); });
            doc.body.appendChild(anchor); anchor.click(); anchor.remove();
        }
        function requestBypass(intent) {
            if (!current(intent)) { bypass.delete(intent.requestId); release(intent); if (!disposed) notice('navigation'); return; }
            clear(intent.watchdog);
            try { send([29, { requestId: intent.requestId, url: intent.url, pageURL: intent.pageURL }]); }
            catch (_) { /* Worker reconnect will retry; native outcome is already settled. */ }
            if (bypass.has(intent.requestId)) intent.watchdog = timer(function() { requestBypass(intent); }, 2000);
        }
        function fallback(intent, needsBypass) {
            if (!current(intent)) { release(intent); if (!disposed) notice('navigation'); return; }
            if (!needsBypass) { notice('fallback'); replay(intent); return; }
            notice('checking');
            // No native send can remain outstanding when worker returns fallback.
            // Ack the document-scoped bypass before replaying the default action.
            bypass.set(intent.requestId, intent);
            requestBypass(intent);
        }
        function transmit(intent) {
            if (!current(intent)) return;
            intent.phase = 'requested';
            try { send([28, { requestId: intent.requestId, url: intent.url, filename: intent.filename,
                explicitDownload: intent.explicitDownload, pageURL: intent.pageURL }]); }
            catch (_) {
                if (!intent.dispatched) { fallback(intent, false); return; }
                notice('pending'); return;
            }
            intent.dispatched = true;
            clear(intent.watchdog);
            intent.watchdog = timer(function() { if (intents.has(intent.requestId)) notice('pending'); }, 4000);
        }
        async function clicked(event) {
            // Once ownership is unresolved, later page-policy changes must not
            // turn a second click into a competing browser download.
            var anchor = anchorFor(event, win, doc), previous;
            if (anchor) try { previous = byURL.get(new URL(anchor.href, win.location.href).href); } catch (_) {}
            if (previous) { event.preventDefault(); notice(previous.phase === 'accepted' ? 'accepted' : 'pending'); return; }
            inspectPolicies(policyObserver ? policyObserver.takeRecords() : []);
            if (policyBlocked) return;
            var item = candidate(event, win, doc);
            if (!item) return;
            if (!available) return;
            event.preventDefault();
            var intent = Object.assign(item, { requestId: win.crypto.randomUUID(), phase: 'preparing', dispatched: false });
            intents.set(intent.requestId, intent); byURL.set(intent.url, intent);
            var progress = timer(function() { if (intents.has(intent.requestId)) notice('checking'); }, 250);
            if (!intent.explicitDownload) {
                var controller = new AbortController(), timeout = timer(function() { controller.abort(); }, 1500), confirmed = false;
                try { confirmed = confirmedFile(await fetcher(intent.url, { method: 'HEAD', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal })); }
                catch (_) {} finally { clear(timeout); }
                if (!confirmed) { clear(progress); fallback(intent, false); return; }
            }
            clear(progress);
            if (!current(intent)) { release(intent); if (!disposed) notice('navigation'); return; }
            if (!available) { fallback(intent, true); return; }
            transmit(intent);
        }
        function receive(message) {
            var reply = message[1] || {};
            if (message[0] === 29) {
                var fallbackIntent = bypass.get(reply.requestId);
                if (fallbackIntent && reply.ready) { bypass.delete(reply.requestId); notice('fallback'); replay(fallbackIntent); }
                else if (fallbackIntent && reply.reason === 'navigation') { bypass.delete(reply.requestId); release(fallbackIntent); notice('navigation'); }
                else if (fallbackIntent) notice('pending');
                return;
            }
            if (message[0] !== 28) return;
            if (typeof reply.available === 'boolean') {
                var reconnected = !available && reply.available; available = reply.available;
                if (reconnected) {
                    intents.forEach(function(intent) { if (intent.dispatched && intent.phase === 'requested') transmit(intent); });
                }
                // A reconnected worker can install a bypass while NDM is offline.
                // Availability of the native bridge must not hold a browser fallback.
                bypass.forEach(requestBypass);
                return;
            }
            var intent = intents.get(reply.requestId);
            if (!intent) return;
            clear(intent.watchdog);
            if (reply.status === 'fallback') { fallback(intent, true); return; }
            if (reply.status === 'accepted' || reply.status === 'deleted') {
                intent.phase = 'accepted'; notice(reply.status);
                timer(function() { release(intent); }, 2000);
            } else if (reply.status === 'pending') notice('pending');
        }
        win.addEventListener('click', clicked, false);
        return { receive: receive, disconnected: function() { available = false; },
            dispose: function() { disposed = true; available = false; if (policyObserver) policyObserver.disconnect(); win.removeEventListener('click', clicked, false); intents.forEach(release); if (noticeHost) noticeHost.remove(); },
            // Exposed only as a module test seam; the installed object stays in the isolated world.
            clicked: clicked };
    }
    return { candidate: candidate, confirmedFile: confirmedFile, install: install };
});
