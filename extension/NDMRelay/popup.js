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

    function probeBridge(retries, endpointIndex) {
        retries = Number(retries || 0);
        var endpoints = [BRIDGE_URL, BRIDGE_URL_FALLBACK];
        var endpoint = endpoints[Number(endpointIndex || 0) % endpoints.length];
        var settled = false;
        var socket;
        function settle(state) {
            if (settled) return;
            settled = true;
            try {
                if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close();
            } catch (error) { /* the probe socket is disposable */ }
            if (state === "offline" && retries > 0) {
                // Each retry also rotates the address, so one quiet pass covers
                // both the contract port and the legacy fallback.
                setTimeout(function () { probeBridge(retries - 1, Number(endpointIndex || 0) + 1); }, 550);
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
        setTimeout(function () { settle("offline"); }, 1500);
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
        setStatus("starting");
        try {
            chrome.tabs.create({ url: APP_URL }, function (tab) {
                if (chrome.runtime.lastError) {
                    setStatus("offline");
                    return;
                }
                handoffTabId = tab && tab.id >= 0 ? tab.id : -1;
                chrome.runtime.sendMessage({ type: "relay:handoff", tabId: handoffTabId });
                probeSettled = false;
                probeBridge(10);
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
            download.addEventListener("click", function () {
                chrome.runtime.sendMessage({
                    type: "relay:downloadResource",
                    tabId: tab && tab.id,
                    resourceKey: item.resourceKey
                }, function (reply) {
                    if (!chrome.runtime.lastError && reply && reply.sent) window.close();
                });
            });
            row.appendChild(info);
            row.appendChild(download);
            list.appendChild(row);
        });
    }

    function refreshState(tab) {
        chrome.runtime.sendMessage(
            { type: "relay:getState", tabId: tab ? tab.id : -1 },
            function (reply) {
                if (chrome.runtime.lastError || !reply) return;
                var catcher = document.getElementById("catcher");
                catcher.setAttribute("aria-checked", reply.catcherEnabled ? "true" : "false");
                // Seed from the worker's cached socket state so a known-live
                // bridge reads "connected" immediately; probeBridge still has
                // the final word a moment later.
                if (reply.connected && !probeSettled) setStatus("connected");
                var count = Number(reply.mediaCount || 0);
                if (count > 0) {
                    document.getElementById("media-card").hidden = false;
                    document.getElementById("media-count-line").textContent =
                        describeMedia(count, reply.mediaSample);
                }
                renderResources(tab, reply.resources);
            }
        );
    }

    document.getElementById("catcher").addEventListener("click", function () {
        var catcher = this;
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
        chrome.runtime.sendMessage(
            { type: "relay:toggleCatcher", enabled: next },
            function (reply) {
                var failed = chrome.runtime.lastError || !reply || !reply.saved;
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
        );
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
        setStatus("checking");
        chrome.runtime.sendMessage({ type: "relay:openApp" }, function (reply) {
            if (chrome.runtime.lastError) {
                launchApp();
                return;
            }
            if (reply && reply.connected) {
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
