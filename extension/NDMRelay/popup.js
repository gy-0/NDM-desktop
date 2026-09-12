// NDM Relay popup: connection status, per-tab media count, catcher toggle.
// The bridge probe runs here (not in the service worker) so the answer is
// always fresh even when the worker was suspended.
(function () {
    "use strict";

    var BRIDGE_URL = "ws://127.0.0.1:51873/ndm/download";
    // The host also serves the bridge on the legacy port, so a drifted or
    // custom primary port never leaves the popup permanently blind.
    var BRIDGE_URL_FALLBACK = "ws://127.0.0.1:10007/ndm/download";
    var BRIDGE_PROTOCOL = "ndm.open.v1";
    var APP_URL = "ndm://open/relay";
    // The live probe outranks the worker's cached flag, which can describe a
    // socket that died while the worker was suspended.
    var probeSettled = false;
    var probeGeneration = 0;
    var cancelProbe = null;

    function beginProbe() {
        probeGeneration++;
        if (cancelProbe) cancelProbe();
        cancelProbe = null;
        probeSettled = false;
        return probeGeneration;
    }

    function message(key, substitutions, fallback) {
        var text = "";
        try {
            text = chrome.i18n.getMessage(key, substitutions) || "";
        } catch (error) { /* an untranslated key is not worth failing over */ }
        return text || fallback || "";
    }

    function localize() {
        try {
            var uiLanguage = chrome.i18n.getUILanguage();
            if (uiLanguage) document.documentElement.lang = uiLanguage;
        } catch (error) { /* keep the HTML fallback language */ }
        var nodes = document.querySelectorAll("[data-i18n]");
        for (var i = 0; i < nodes.length; i++) {
            var key = nodes[i].getAttribute("data-i18n");
            var text = chrome.i18n.getMessage(key);
            if (text) nodes[i].textContent = text;
        }
        var labelled = document.querySelectorAll("[data-i18n-aria-label]");
        for (var j = 0; j < labelled.length; j++) {
            var labelKey = labelled[j].getAttribute("data-i18n-aria-label");
            var label = chrome.i18n.getMessage(labelKey);
            if (label) labelled[j].setAttribute("aria-label", label);
        }
    }

    function setStatus(state) {
        var status = document.getElementById("status");
        var text = document.getElementById("status-text");
        var openApp = document.getElementById("open-app");
        // "checking" is the honest answer until either the cached background
        // flag or our own probe lands; never paint a false offline.
        status.dataset.state = state;
        text.textContent = state === "connected"
            ? message("popupConnected", null, "已连接 NDM")
            : state === "starting"
                ? message("popupOpening", null, "正在打开…")
            : state === "offline"
                ? message("popupOffline", null, "未连接")
                : message("popupChecking", null, "正在检查…");
        document.getElementById("offline-hint").hidden = state !== "offline";
        openApp.textContent = state === "connected"
            ? message("popupShowApp", null, "显示 NDM")
            : message("popupOpenApp", null, "打开 NDM");
        openApp.disabled = state === "starting";
    }

    function probeBridge(retries, endpointIndex, generation) {
        if (generation === undefined) generation = beginProbe();
        if (generation !== probeGeneration) return;
        retries = Number(retries || 0);
        var endpoints = [BRIDGE_URL, BRIDGE_URL_FALLBACK];
        var endpoint = endpoints[Number(endpointIndex || 0) % endpoints.length];
        var settled = false;
        var socket;
        var watchdog;
        var retryTimer;
        function dispose() {
            clearTimeout(watchdog);
            clearTimeout(retryTimer);
            if (socket) {
                socket.onopen = socket.onclose = socket.onerror = null;
                try { if (socket.readyState === 0 || socket.readyState === 1) socket.close(); }
                catch (error) { /* disposable probe */ }
            }
        }
        cancelProbe = dispose;
        function settle(state) {
            if (settled || generation !== probeGeneration) return;
            settled = true;
            dispose();
            if (state === "offline" && retries > 0) {
                // Each retry also rotates the address, so one quiet pass covers
                // both the contract port and the legacy fallback.
                retryTimer = setTimeout(function () { probeBridge(retries - 1, Number(endpointIndex || 0) + 1, generation); }, 550);
                return;
            }
            probeSettled = true;
            setStatus(state);
            // NDM answered: the handoff tab has done its job.
            if (state === "connected") closeHandoffTab();
        }
        try {
            socket = new WebSocket(endpoint, BRIDGE_PROTOCOL);
        } catch (error) {
            settle("offline");
            return;
        }
        socket.onopen = function () { settle("connected"); };
        // A clean server close is just as decisive as an error — settling on
        // onclose keeps the offline verdict fast instead of burning the
        // full 1500ms watchdog per attempt.
        socket.onclose = function () { settle("offline"); };
        socket.onerror = function () { settle("offline"); };
        watchdog = setTimeout(function () { settle("offline"); }, 1500);
    }

    // Tab created only to hand the ndm:// URL to the OS. Once the bridge is
    // live (or the popup closes and the worker takes over) it must not linger
    // as a dead error page in the tab strip.
    var handoffTabId = -1;

    function closeHandoffTab() {
        if (handoffTabId < 0) return;
        var id = handoffTabId;
        handoffTabId = -1;
        try {
            chrome.tabs.remove(id, function () { void chrome.runtime.lastError; });
        } catch (error) { /* the popup is closing anyway */ }
    }

    function launchApp() {
        var generation = beginProbe();
        setStatus("starting");
        try {
            chrome.tabs.create({ url: APP_URL }, function (tab) {
                if (generation !== probeGeneration) {
                    if (tab && tab.id >= 0) chrome.tabs.remove(tab.id, function () { void chrome.runtime.lastError; });
                    return;
                }
                if (chrome.runtime.lastError) {
                    setStatus("offline");
                    return;
                }
                handoffTabId = tab && tab.id >= 0 ? tab.id : -1;
                chrome.runtime.sendMessage({ type: "relay:handoff", tabId: handoffTabId });
                probeSettled = false;
                probeBridge(10, 0, generation);
            });
        } catch (error) {
            setStatus("offline");
        }
    }

    function activeTab(callback) {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            callback(tabs && tabs.length ? tabs[0] : null);
        });
    }

    function describeMedia(count, sample) {
        var title = sample && sample.title ? String(sample.title).trim() : "";
        var host = sample && sample.host ? String(sample.host).replace(/^www\./, "") : "";
        if (title) {
            // The count is already on the badge; here the page's own name is
            // the more useful thing to say.
            return host
                ? message("popupMediaSampleHost", [title, host], title + " · " + host)
                : message("popupMediaSample", [title], title);
        }
        return message("popupMediaCount", [String(count)], count + " 项可下载");
    }

    function describeResource(item) {
        var type = item.resourceTypeLabel || String(item.fEx || "").toUpperCase();
        var size = Number(item.fS || item[7] || 0);
        var sizeText = "";
        if (size > 0) {
            var units = ["B", "KB", "MB", "GB"];
            var unit = 0;
            while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
            sizeText = (size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)) + " " + units[unit];
        }
        return [type, sizeText, item.resourceHost || ""].filter(Boolean).join(" · ");
    }

    function renderResources(tab, resources) {
        var card = document.getElementById("resource-card");
        var list = document.getElementById("resource-list");
        resources = Array.isArray(resources) ? resources : [];
        card.hidden = resources.length === 0;
        document.getElementById("resource-total").textContent = resources.length
            ? message("popupResourceCount", [String(resources.length)], resources.length + " 项")
            : "";
        while (list.firstChild) list.removeChild(list.firstChild);
        resources.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "resource-row";
            var info = document.createElement("div");
            info.className = "resource-info";
            var name = document.createElement("div");
            name.className = "resource-name";
            name.textContent = item.fileName || message("popupUnnamedResource", null, "未命名文件");
            name.title = name.textContent;
            var meta = document.createElement("div");
            meta.className = "resource-meta";
            meta.textContent = describeResource(item);
            info.appendChild(name);
            info.appendChild(meta);
            var download = document.createElement("button");
            download.type = "button";
            download.className = "resource-download";
            download.textContent = message("popupDownload", null, "下载");
            download.setAttribute("aria-label", download.textContent + " " + name.textContent);
            var feedback = document.createElement("div");
            feedback.className = "resource-feedback";
            feedback.setAttribute("role", "status");
            feedback.setAttribute("aria-live", "polite");
            feedback.hidden = true;
            info.appendChild(feedback);
            download.addEventListener("click", function () {
                if (download.disabled || refreshBusy) return;
                resourcePending++;
                document.getElementById("refresh-page").disabled = true;
                download.disabled = true;
                download.setAttribute("aria-busy", "true");
                download.textContent = message("popupSending", null, "正在发送…");
                feedback.hidden = true;
                var finished = false;
                function finish(reply, failed) {
                    if (finished) return;
                    finished = true;
                    resourcePending--;
                    document.getElementById("refresh-page").disabled = refreshBusy || resourcePending > 0 || Array.from(mediaRequests.values()).some(function(value) { return value.status === "sending"; });
                    download.removeAttribute("aria-busy");
                    feedback.hidden = false;
                    if (!failed && reply && reply.sent) {
                        // `sent` acknowledges delivery to the page's content script,
                        // not an NDM task, parsed format or successful download.
                        download.textContent = message("popupRequestSent", null, "已发送");
                        download.setAttribute("aria-label", download.textContent + " " + name.textContent);
                        feedback.dataset.state = "sent";
                        feedback.textContent = message("popupResourceSent", null, "请求已发送，请在 NDM 中查看。");
                    } else {
                        download.disabled = false;
                        download.textContent = message("popupDownload", null, "下载");
                        feedback.dataset.state = "error";
                        feedback.textContent = reply && reply.error === "queue-full"
                            ? message("popupQueueFull", null, "等待发送的请求已满，请连接 NDM 后重试。")
                            : failed
                            ? message("popupResourceSendFailed", null, "未能发送请求，请重试。")
                            : message("popupResourceUnavailable", null, "未能交接此文件，请刷新来源页面后重试。");
                    }
                }
                try {
                    chrome.runtime.sendMessage({
                        type: "relay:downloadResource",
                        tabId: tab && tab.id,
                        resourceKey: item.resourceKey
                    }, function (reply) {
                        finish(reply, Boolean(chrome.runtime.lastError));
                    });
                } catch (error) {
                    finish(null, true);
                }
            });
            row.appendChild(info);
            row.appendChild(download);
            list.appendChild(row);
        });
    }

    var mediaRequests = new Map();
    var resourcePending = 0;
    var catcherGeneration = 0;
    var stateGeneration = 0;
    var refreshBusy = false;

    function mediaFailure(error) {
        var keys = { offline: "popupPageOffline", navigation: "popupPageNavigation", unavailable: "popupMediaUnavailable",
            busy: "popupMediaBusy", timeout: "popupMediaTimeout", "queue-full": "popupQueueFull" };
        return message(keys[error] || "popupResourceSendFailed", null, "未能发送请求，请重试。");
    }

    function renderMedia(tab, items) {
        var list = document.getElementById("media-list");
        items = Array.isArray(items) ? items : [];
        document.getElementById("media-total").textContent = items.length
            ? message("popupResourceCount", [String(items.length)], items.length + " 项") : "";
        while (list.firstChild) list.removeChild(list.firstChild);
        items.forEach(function(item) {
            var identity = [tab && tab.id, tab && tab.url, item.mediaKey].join("\n");
            var state = mediaRequests.get(identity) || { status: "ready" };
            var row = document.createElement("div");
            row.className = "media-row";
            var choice = document.createElement("div");
            choice.className = "media-choice";
            var info = document.createElement("div");
            info.className = "media-info";
            var title = document.createElement("div");
            title.className = "media-title";
            title.textContent = item.title || message("popupMediaFile", null, "视频文件");
            var meta = document.createElement("div");
            meta.className = "media-meta";
            meta.textContent = item.meta || "";
            info.appendChild(title);
            info.appendChild(meta);
            var pageHost = "";
            try { pageHost = new URL(tab.url).host; } catch (_) {}
            if (item.host && item.host !== pageHost) {
                var source = document.createElement("span");
                source.className = "media-source";
                source.textContent = item.host;
                info.appendChild(source);
            }
            if (item.badge && items.length > 1) {
                var badge = document.createElement("span");
                badge.className = "media-badge";
                badge.textContent = item.badge;
                info.appendChild(badge);
            }
            var button = document.createElement("button");
            button.type = "button";
            button.className = "media-download";
            button.dataset.mediaKey = item.mediaKey;
            var feedback = document.createElement("div");
            feedback.className = "media-feedback";
            feedback.setAttribute("role", "status");
            feedback.setAttribute("aria-live", "polite");
            feedback.setAttribute("aria-atomic", "true");
            var action = item.kind === "resolver" ? message("popupChooseQuality", null, "选择画质") : message("popupDownload", null, "下载");
            function paint() {
                row.dataset.state = state.status;
                button.disabled = state.status === "sending" || state.status === "sent";
                button.setAttribute("aria-busy", state.status === "sending" ? "true" : "false");
                button.textContent = state.status === "sending" ? message("popupSending", null, "正在发送…")
                    : state.status === "sent" ? message("popupRequestSent", null, "已发送")
                    : state.status === "error" ? message("popupRetry", null, "重试") : action;
                button.setAttribute("aria-label", button.textContent + " · " + title.textContent + (item.meta ? " · " + item.meta : ""));
                feedback.hidden = state.status !== "error" && state.status !== "sent";
                feedback.dataset.state = state.status;
                feedback.textContent = state.status === "sent" ? message("popupResourceSent", null, "请求已发送，请在 NDM 中查看。") : state.status === "error" ? mediaFailure(state.error) : "";
            }
            button.addEventListener("click", function() {
                if (button.disabled || refreshBusy) return;
                state = { status: "sending" };
                mediaRequests.set(identity, state);
                document.getElementById("refresh-page").disabled = true;
                paint();
                var finished = false;
                function finish(reply, failed) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(watchdog);
                    state.status = !failed && reply && reply.sent ? "sent" : "error";
                    state.error = failed ? "send-failed" : reply && reply.error;
                    paint();
                    if (state.error === "offline") {
                        setStatus("checking");
                        probeBridge(1);
                    }
                    document.getElementById("refresh-page").disabled = refreshBusy || resourcePending > 0 || Array.from(mediaRequests.values()).some(function(value) { return value.status === "sending"; });
                }
                var watchdog = setTimeout(function() { finish({ sent: false, error: "timeout" }); }, 6500);
                try {
                    chrome.runtime.sendMessage({ type: "relay:downloadMedia", tabId: tab.id, mediaKey: item.mediaKey, expectedPageURL: tab.url }, function(reply) {
                        finish(reply, Boolean(chrome.runtime.lastError));
                    });
                } catch (_) { finish(null, true); }
            });
            paint();
            choice.appendChild(info);
            choice.appendChild(button);
            row.appendChild(choice);
            row.appendChild(feedback);
            list.appendChild(row);
        });
    }

    var resolverTab = null;
    function refreshState(tab) {
        var generation = probeGeneration;
        var settingsGeneration = catcherGeneration;
        var stateRequest = ++stateGeneration;
        var pageChanged = resolverTab && (!tab || resolverTab.id !== tab.id || resolverTab.url !== tab.url);
        if (pageChanged) {
            mediaRequests.clear();
            document.getElementById("media-card").hidden = true;
            document.getElementById("resource-card").hidden = true;
            var resolveButton = document.getElementById("resolve-page");
            if (resolveButton.disabled) document.getElementById("page-resolver-feedback").textContent = message("popupPageHint", null, "在 NDM 中解析并选择画质");
            resolveButton.disabled = false;
            resolveButton.setAttribute("aria-busy", "false");
        }
        resolverTab = tab;
        var refresh = document.getElementById("refresh-page");
        refreshBusy = true;
        refresh.disabled = true;
        refresh.setAttribute("aria-busy", "true");
        // Keep the snapshot stable while its replacement is in flight. A
        // download callback must never paint a row that refresh just removed.
        var waitingButtons = Array.from(document.querySelectorAll(".media-download:not(:disabled), .resource-download:not(:disabled)"));
        waitingButtons.forEach(function(button) { button.disabled = true; });
        var webPage = !!(tab && /^https?:\/\//i.test(tab.url || ""));
        var host = "";
        try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch (_) {}
        document.getElementById("page-title").textContent = tab && tab.title || host || message("popupCurrentPage", null, "当前页面");
        document.getElementById("page-host").textContent = webPage ? host : message("popupBrowserPage", null, "浏览器页面");
        var knownPage = !!(tab && typeof NDMRelaySiteAdapters !== "undefined" && NDMRelaySiteAdapters.currentPageURL(tab.url));
        document.getElementById("page-resolver-card").hidden = !knownPage;
        var stateSettled = false;
        function settled(reply, failed) {
                if (stateSettled || stateRequest !== stateGeneration) return;
                stateSettled = true;
                clearTimeout(stateTimeout);
                refreshBusy = false;
                waitingButtons.forEach(function(button) { button.disabled = false; });
                refresh.disabled = resourcePending > 0 || Array.from(mediaRequests.values()).some(function(value) { return value.status === "sending"; });
                refresh.setAttribute("aria-busy", "false");
                if (failed || !reply) {
                    document.getElementById("discovery-empty").hidden = false;
                    document.getElementById("empty-title").textContent = message("popupRefreshFailed", null, "未能读取本页内容");
                    document.getElementById("empty-hint").textContent = message("popupRefreshRetry", null, "请刷新列表后重试。");
                    return;
                }
                var catcher = document.getElementById("catcher");
                if (settingsGeneration === catcherGeneration && !catcher.disabled) catcher.setAttribute("aria-checked", reply.catcherEnabled ? "true" : "false");
                // Seed from the worker's cached socket state so a known-live
                // bridge reads "connected" immediately; probeBridge still has
                // the final word a moment later.
                if (reply.connected && !probeSettled && generation === probeGeneration) setStatus("connected");
                var count = Number(reply.mediaCount || 0);
                var items = Array.isArray(reply.mediaItems) ? reply.mediaItems : [];
                document.getElementById("media-card").hidden = knownPage || (!count && !items.length);
                document.getElementById("media-fallback").hidden = !!items.length;
                if (count > 0 && !knownPage && !items.length) {
                    document.getElementById("media-count-line").textContent =
                        describeMedia(count, reply.mediaSample);
                }
                renderMedia(tab, knownPage ? [] : items);
                renderResources(tab, reply.resources);
                document.getElementById("discovery-empty").hidden = knownPage || count > 0 || items.length > 0 || !!(reply.resources && reply.resources.length);
                document.getElementById("empty-title").textContent = message(webPage ? "popupEmptyTitle" : "popupRestrictedTitle", null, "还没有发现可下载内容");
                document.getElementById("empty-hint").textContent = message(webPage ? "popupEmptyHint" : "popupRestrictedHint", null, "先播放视频或打开文件，再刷新列表。");
        }
        var stateTimeout = setTimeout(function() { settled(null, true); }, 4000);
        try {
            chrome.runtime.sendMessage({ type: "relay:getState", tabId: tab ? tab.id : -1 }, function(reply) { settled(reply, Boolean(chrome.runtime.lastError)); });
        } catch (_) { settled(null, true); }
    }

    document.getElementById("refresh-page").addEventListener("click", function() {
        if (this.disabled) return;
        // Lock before tabs.query yields, not only after it returns.
        refreshBusy = true;
        this.disabled = true;
        this.setAttribute("aria-busy", "true");
        try { activeTab(refreshState); }
        catch (_) { refreshState(resolverTab); }
    });

    document.getElementById("catcher").addEventListener("click", function () {
        var catcher = this;
        if (catcher.disabled) return;
        catcherGeneration++;
        var subtitle = document.getElementById("catcher-sub");
        var previous = catcher.getAttribute("aria-checked") === "true";
        var next = this.getAttribute("aria-checked") !== "true";
        catcher.setAttribute("aria-checked", next ? "true" : "false");
        catcher.setAttribute("aria-busy", "true");
        catcher.disabled = true;
        subtitle.removeAttribute("data-state");
        subtitle.textContent = message(
            "popupCatcherSub",
            null,
            "普通下载自动交给 NDM 加速"
        );
        function finish(reply, failed) {
            catcherGeneration++;
            failed = failed || !reply || !reply.saved;
            catcher.disabled = false;
            catcher.setAttribute("aria-busy", "false");
            catcher.setAttribute(
                "aria-checked",
                failed ? (previous ? "true" : "false") : (reply.catcherEnabled ? "true" : "false")
            );
            if (failed) {
                subtitle.dataset.state = "error";
                subtitle.textContent = message(
                    "popupSettingFailed",
                    null,
                    "未能保存设置，请重试"
                );
            }
        }
        try {
            chrome.runtime.sendMessage(
                { type: "relay:toggleCatcher", enabled: next },
                function (reply) { finish(reply, Boolean(chrome.runtime.lastError)); }
            );
        } catch (_) {
            // An invalidated extension context can throw before any callback.
            // Restore the durable state and expose the same retryable feedback.
            finish(null, true);
        }
    });

    document.getElementById("resolve-page").addEventListener("click", function () {
        var button = this, feedback = document.getElementById("page-resolver-feedback");
        if (button.disabled || !resolverTab) return;
        var requestedTab = resolverTab;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        feedback.textContent = message("popupPageSending", null, "正在发送请求…");
        function finish(reply) {
            if (!resolverTab || resolverTab.id !== requestedTab.id || resolverTab.url !== requestedTab.url) return;
            var failed = chrome.runtime.lastError || !reply || !reply.sent;
            button.disabled = !failed;
            button.setAttribute("aria-busy", "false");
            var key = reply && reply.error === "queue-full" ? "popupQueueFull" : !failed ? "popupPageSent" : reply && reply.error === "offline" ? "popupPageOffline" : reply && reply.error === "navigation" ? "popupPageNavigation" : "popupPageFailed";
            feedback.textContent = message(key, null, failed ? "未能发送请求，请刷新来源页面后重试。" : "请求已发送，请在 NDM 中查看。");
            // Refresh the target after an explicit stale-navigation rejection. Never
            // silently download a different page from the one shown on click.
            if (failed && reply && reply.error === "navigation") activeTab(refreshState);
        }
        try {
            chrome.runtime.sendMessage({ type: "relay:resolvePage", tabId: requestedTab.id, expectedPageURL: requestedTab.url }, finish);
        } catch (_) { finish({ sent: false, error: "send-failed" }); }
    });

    document.getElementById("show-panel").addEventListener("click", function () {
        activeTab(function (tab) {
            if (tab && tab.id >= 0) {
                chrome.runtime.sendMessage({ type: "relay:showMediaPanel", tabId: tab.id });
            }
            window.close();
        });
    });

    document.getElementById("open-app").addEventListener("click", function () {
        // The worker re-dials the bridge and asks NDM to come forward. Its
        // reply is only the cached flag, and a reconnect it just started is
        // still pending, so re-probe rather than trust a falsy answer — that
        // race is exactly how a running NDM would get reported offline.
        var generation = beginProbe();
        setStatus("checking");
        chrome.runtime.sendMessage({ type: "relay:openApp" }, function (reply) {
            if (generation !== probeGeneration) return;
            if (chrome.runtime.lastError) {
                launchApp();
                return;
            }
            if (reply && reply.connected) {
                probeSettled = true;
                setStatus("connected");
                return;
            }
            launchApp();
        });
    });

    function renderVersion() {
        // popupVersion takes a substitution, so localize() cannot fill it in;
        // read the real number from the manifest instead of hardcoding it twice
        // in the locale files where it would silently drift on every bump.
        var version = "";
        try {
            version = (chrome.runtime.getManifest() || {}).version || "";
        } catch (error) { /* fall back to the bare wordmark */ }
        document.getElementById("foot-note").textContent = version
            ? message("popupVersion", [version], "NDM Relay · v" + version)
            : "NDM Relay";
    }

    localize();
    renderVersion();
    setStatus("checking");
    // A few retries let the probe rotate onto the legacy fallback when the
    // contract port is not the one this host bound.
    probeBridge(3);
    activeTab(refreshState);
})();
