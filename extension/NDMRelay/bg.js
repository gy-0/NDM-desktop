importScripts("media-policy.js", "resource-policy.js", "site-adapters.js", "browser-handoff.js", "click-handoff.js", "session-cookies.js");

// The executing worker identifies itself. Reading a replaced manifest here
// would let an old MV3 worker incorrectly claim it had loaded the new code.
const NDM_RELAY_RUNNING_VERSION = "1.4.15";

var h = !1,
    aa = RegExp("^bytes [0-9]+-[0-9]+/([0-9]+)$"),
    n = "object xmlhttprequest media other main_frame sub_frame image".split(" "),
    ba = ["object", "xmlhttprequest", "media", "other"],
    ca = RegExp("://.+/([^/]+?(?:.([^./]+?))?)(?=[?#]|$)"),
    da = [301, 302, 303, 307, 308],
    ea = RegExp("^(?:application/x-apple-diskimage|application/download|application/force-download|application/x-msdownload|binary/octet-stream)$", "i"),
    u = RegExp("^(?:FLV|SWF|MP3|MP4|M4V|F4F|F4V|M4A|MPG|MPEG|MPEG4|MPE|AVI|WMV|WMA|WAV|WAVE|ASF|RM|RAM|OGG|OGV|OGM|OGA|MOV|MID|MIDI|3GP|3GPP|QT|WEBM|TS|MKV|AAC|MP2T|MPEGTS|RMVB|VTT|SRT)$",
        "i"),
    fa = RegExp("^(?:HTM|HTML|MHT|MHTML|SHTML|SHTM|XHT|XHTM|XHTML|XML|TXT|CSS|JS|JSON|GIF|ICO|JPEG|JPG|PNG|WEBP|BMP|SVG|TIF|TIFF|PDF|PHP|ASP|ASPX|EOT|TTF|WOF|WOFF|WOFF2|MSG|CHN|PEM|BR|OTF|ACZ|AZC|CGI|TPL|OSD|M3U8|DO)$", "i"),
    ha = RegExp("^(?:FLV|AVI|MPG|MPE|WMV|QT|MOV|RM|RAM|WMA|MID|MIDI|AAC|MKV|RMVB)$", "i"),
    C = RegExp("^(?:F4F|MPEGTS|TS|MP2T)$", "i"),
    D = {
        "application/x-apple-diskimage": "DMG",
        "application/cert-chain+cbor": "MSG",
        "application/epub+zip": "EPUB",
        "application/java-archive": "JAR",
        "video/x-matroska": "MKV",
        "text/html": "HTML|HTM",
        "text/css": "CSS",
        "text/javascript": "JS|JSON",
        "text/mspg-legacyinfo": "MSI|MSP",
        "text/plain": "TXT|SRT",
        "text/srt": "SRT",
        "text/vtt": "VTT|SRT",
        "text/xml": "XML|F4M|TTML",
        "text/x-javascript": "JS|JSON",
        "text/x-json": "JSON",
        "application/f4m+xml": "F4M",
        "application/gzip": "GZ",
        "application/javascript": "JS",
        "application/json": "JSON",
        "application/msword": "DOC|DOCX|DOT|DOTX",
        "application/pdf": "PDF",
        "application/ttaf+xml": "DFXP",
        "application/vnd.apple.mpegurl": "M3U8",
        "application/zip": "ZIP",
        "application/x-7z-compressed": "7Z",
        "application/x-aim": "PLJ",
        "application/x-compress": "Z",
        "application/x-compress-7z": "7Z",
        "application/x-compressed": "ARJ",
        "application/x-gtar": "TAR",
        "application/x-msi": "MSI",
        "application/x-msp": "MSP",
        "application/x-gzip": "GZ",
        "application/x-gzip-compressed": "GZ",
        "application/x-javascript": "JS",
        "application/x-mpegurl": "M3U8",
        "application/x-msdos-program": "EXE|DLL",
        "application/vnd.apple.installer+xml": "MPKG",
        "application/x-ole-storage": "MSI|MSP",
        "application/x-rar": "RAR",
        "application/x-rar-compressed": "RAR",
        "application/x-sdlc": "EXE|SDLC",
        "application/x-shockwave-flash": "SWF",
        "application/x-silverlight-app": "XAP",
        "application/x-subrip": "SRT",
        "application/x-tar": "TAR",
        "application/x-zip": "ZIP",
        "application/x-zip-compressed": "ZIP",
        "video/3gpp": "3GP|3GPP",
        "video/3gpp2": "3GP|3GPP",
        "video/avi": "AVI",
        "video/f4f": "F4F",
        "video/f4m": "F4M",
        "video/flv": "FLV",
        "video/mp2t": "TS|M3U8",
        "video/mp4": "MP4|M4V",
        "video/mpeg": "MPG|MPEG|MPE",
        "video/mpegurl": "M3U8|M3U",
        "video/mpg4": "MP4|M4V",
        "video/msvideo": "AVI",
        "video/quicktime": "MOV|QT",
        "video/webm": "WEBM",
        "video/x-flash-video": "FLV",
        "video/x-flv": "FLV",
        "video/x-mp4": "MP4|M4V",
        "video/x-mpegurl": "M3U8|M3U",
        "video/x-mpg4": "MP4|M4V",
        "video/x-ms-asf": "ASF",
        "video/x-ms-wmv": "WMV",
        "video/x-msvideo": "AVI",
        "audio/3gpp": "3GP|3GPP",
        "audio/3gpp2": "3GP|3GPP",
        "audio/mp3": "MP3",
        "audio/mp4": "M4A|MP4",
        "audio/mp4a-latm": "M4A|MP4",
        "audio/mpeg": "MP3",
        "audio/mpeg4-generic": "M4A|MP4",
        "audio/mpegurl": "M3U8|M3U",
        "image/svg+xml": "SVG|SVGZ",
        "audio/webm": "WEBM",
        "audio/wav": "WAV",
        "audio/x-mpeg": "MP3",
        "audio/x-mpegurl": "M3U8|M3U",
        "audio/x-ms-wma": "WMA",
        "audio/x-wav": "WAV",
        "ilm/tm": "MP3",
        "image/gif": "GIF|GFA",
        "image/icon": "ICO|CUR",
        "image/jpg": "JPG|JPEG",
        "image/jpeg": "JPG|JPEG",
        "image/png": "PNG|APNG",
        "image/tiff": "TIF|TIFF",
        "image/vnd.microsoft.icon": "ICO|CUR",
        "image/webp": "WEBP",
        "image/x-icon": "ICO|CUR",
        "flv-application/octet-stream": "FLV",
        "image/x-xbitmap": "XBM",
        "audio/x-mp3": "MP3",
        "audio/x-hx-aac-adts": "AAC",
        "audio/aac": "AAC",
        "audio/x-aac": "AAC",
        "application/vnd.rn-realmedia-vbr": "RMVB"
    };

function E(a) {
    return a && unescape(a.split(";", 1).shift().trim()) || ""
}

function F(a) {
    return (a = ca.exec(a)) ? a[1] || "" : ""
}

function K(a) {
    return -1 < a.indexOf(".") ? a.split(".").pop() : ""
}

function ia(a) {
    var b;
    a = a.toUpperCase();
    for (b in D)
        if (-1 < D[b].split("|").indexOf(a)) return b;
    return ""
}

function L(a, b) {
    if (!a) return null;
    for (var c = 0; c < a.length; c++)
        if (a[c].name.toLowerCase() == b.toLowerCase()) return a[c].value || a[c].binaryValue || null;
    return null
}

function relayHeaderValue(a) {
    return String(a || "").replace(/[\r\n\0]+/g, " ").trim()
}

function isRelayRequestHeader(a) {
    a = String(a || "").toLowerCase();
    return "authorization" == a || "accept" == a || "accept-language" == a || N(a, "x-")
}

function M() {
    for (var a = {}, b = 0; b < arguments.length; b++)
        for (var c in arguments[b]) arguments[b].hasOwnProperty(c) && (a[c] = arguments[b][c]);
    return a
}

function N(a, b) {
    return a && b && 0 == a.indexOf(b)
}

function P(a, b) {
    if (!a || !b) return !1;
    var c = a.length - b.length;
    return 0 <= c && a.indexOf(b, c) == c
}

function Q(a, b) {
    return a && b && 0 <= a.indexOf(b)
}

function R(a) {
    return Q(a, "://") ? a.split("://", 1).shift().toLowerCase() || "" : "http"
}
async function S(a, b) {
    var c = null,
        d = {},
        e, f = b && b["1"] || "GET";
    if (b && (e = b.m))
        for (var g = 0; g < e.length; g++) N(e[g].name.toLowerCase(), "x-") && (d[e[g].name] = e[g].value);
    if ("POST" == f && b) {
        try {
            T(b, b), b["10"] && (d["Content-Type"] = b["10"])
        } catch (m) {}
        b && b.postData && (c = b.postData)
    }
    try {
        const m = await fetch(a["2"], {
            method: f,
            credentials: "include",
            headers: new Headers(d),
            body: c
        });
        if (m.ok) {
            let y = await m.text();
            (a.L || function() {})(y)
        }
    } catch (m) {}
}

function U() {
    this["1"] = "GET";
    this["2"] = "";
    this["3"] = "";
    this["4"] = "";
    this["5"] = "";
    this["6"] = "normal";
    this["7"] = 0;
    this["8"] = "";
    this["9"] = "";
    this["10"] = "";
    this.cookies = this["11"] = "";
    this.postData = null
}

function V() {
    var a = this.constructor.prototype,
        b;
    for (b in a) this[b] = a[b].bind(this);
    this.H = {};
    this.g = {};
    this.j = {};
    this.resourcesByTab = Object.create(null);
    this.ga = 1;
    this.forwardedDownloadURLs = Object.create(null);
    this.blockedDownloadURLs = Object.create(null);
    this.deferredFileCandidates = new Map();
    // Items waiting for the bridge socket. A single slot used to drop every
    // request but the last one when NDM was still launching.
    this.pendingRelayQueue = [];
    this.clickPagePolicies = {};
    this.clickNavigationPolicies = {};
    this.clickHTTPAuthOrigins = new Set();
    this.clickHTTPAuthReady = !chrome.storage.session;
    var authOwner = this;
    this.clickHTTPAuthLoaded = this.clickHTTPAuthReady;
    this.clickHTTPAuthReadyPromise = chrome.storage.session ? chrome.storage.session.get("ndmClickHTTPAuthOriginsV1").then(function(saved) {
        var origins = saved.ndmClickHTTPAuthOriginsV1;
        if (origins !== undefined && (!Array.isArray(origins) || origins.some(function(origin) { return !origin || authOwner.clickHTTPOrigin(origin) !== origin; }))) return;
        (origins || []).forEach(function(origin) { authOwner.clickHTTPAuthOrigins.add(origin); });
        authOwner.clickHTTPAuthLoaded = authOwner.clickHTTPAuthReady = true;
        authOwner.publishClickAvailability();
    }, function() {}) : Promise.resolve();
    this.clickHTTPAuthWrites = this.clickHTTPAuthReadyPromise;
    if (typeof NDMClickHandoff !== "undefined" && chrome.storage.session) {
        var clickOwner = this;
        this.clickHandoffs = NDMClickHandoff.create({ storage: chrome.storage.session,
            canSend: function() { return clickOwner.clickBridgeReady(); },
            canStart: function(context) { var port = clickOwner.g[[context.tabId, context.frameId]];
                return port && port.documentId === context.documentId && port["2"] === context.pageURL && clickOwner.clickAvailable(port); },
            send: function(message) { clickOwner.G.send(message); },
            notify: function(context, result) { var port = clickOwner.g[[context.tabId, context.frameId]];
                if (port && port.documentId === context.documentId) try { port.postMessage([28, result]); } catch (_) {} }
        });
        this.clickHandoffs.ready.then(function() { clickOwner.clickHandoffsReady = true; clickOwner.publishClickAvailability(); }, function() {});
    }
    if (typeof NDMBrowserHandoff !== "undefined" && chrome.storage.session) {
        var owner = this;
        this.browserHandoffs = NDMBrowserHandoff.create({
            storage: chrome.storage.session, downloads: chrome.downloads,
            idFactory: function() { return crypto.randomUUID(); },
            canSend: function(item) {
                if (!owner.D || !owner.G || owner.G.readyState !== 1) { owner.M(); owner.scheduleBridgeRetry(); return false; }
                return owner.bridgeStatus && owner.bridgeStatus.durableHandoff === 1 &&
                    (!item || !item.requiresSafeFileRedirects || owner.bridgeStatus.safeFileRedirects === 1);
            },
            send: function(message) { owner.G.send(message); },
            focus: function() { if (owner.D && owner.G && owner.G.readyState === 1) try { owner.G.send("NDMControl: focus"); } catch (_) {} }
        });
    }
    // Bridge retry clock: exponential 1s→15s while clicks wait, reset on open.
    this.bridgeRetryMs = 0;
    this.bridgeRetryTimer = null;
    this.lastBridgeNoticeAt = 0;
    // Tab created for the ndm:// protocol handoff; closed once the bridge is
    // live so no dead error page lingers in the tab strip.
    this.handoffTabId = -1;
    // Primary contract port first, legacy 10007 as the standing fallback.
    this.bridgeEndpoints = ["ws://127.0.0.1:51873/ndm/download", "ws://127.0.0.1:10007/ndm/download"];
    this.bridgeEndpointIndex = 0;
    this.everConnected = !1;
    this.coldProbes = 0;
    this.bridgeStatus = null;
    var self = this;
    chrome.storage.local.get(["bridgeEndpoint"], function(d) {
        var i = self.bridgeEndpoints.indexOf(d.bridgeEndpoint);
        if (i >= 0 && i != self.bridgeEndpointIndex) {
            self.bridgeEndpointIndex = i;
            if (!self.D && (self.i || self.pendingRelayQueue.length)) self.M()
        }
    });
    this.C = !1;
    chrome.contextMenus.removeAll(function() {
        chrome.contextMenus.create({
            title: chrome.i18n.getMessage("ctxDownload") || "Download with NDM",
            id: "NDM_CtxMenu",
            contexts: ["link", "image"]
        });
        chrome.contextMenus.create({
            title: chrome.i18n.getMessage("ctxShowPanel") || "Show video download controls",
            id: "NDM_ShowMediaPanel",
            contexts: ["action"]
        });
        chrome.contextMenus.create({
            title: chrome.i18n.getMessage("ctxToggleCatcher") || "Catch browser downloads",
            id: "NDM_ToggleCatcher",
            contexts: ["action"],
            type: "checkbox",
            checked: !0
        })
    });
    this.l(chrome.contextMenus.onClicked, this.X);
    this.l(chrome.downloads.onCreated, this.Y);
    this.l(chrome.runtime.onConnect, this.$);
    this.l(chrome.webRequest.onBeforeRequest, this.T, {
        urls: ["http://*/*", "https://*/*", "ftp://*/*"],
        types: n
    }, ["requestBody"]);
    try {
        this.l(chrome.webRequest.onBeforeSendHeaders, this.U, {
            urls: ["https://*/*", "http://*/*"],
            types: n
        }, ["requestHeaders", "extraHeaders"])
    } catch (d) {
        // Firefox lacks Chromium's extraHeaders flag. Ordinary headers still
        // flow there, with cookies.getAll as the authenticated-session fallback.
        this.l(chrome.webRequest.onBeforeSendHeaders, this.U, {
            urls: ["https://*/*", "http://*/*"],
            types: n
        }, ["requestHeaders"])
    }
    this.l(chrome.webRequest.onHeadersReceived, this.W, {
        urls: ["<all_urls>"],
        types: n
    }, ["responseHeaders"]);
    this.l(chrome.webRequest.onCompleted, this.O, {
        urls: ["<all_urls>"]
    });
    this.l(chrome.webRequest.onErrorOccurred, this.O, {
        urls: ["<all_urls>"]
    });
    this.l(chrome.webNavigation.onHistoryStateUpdated, this.Z);
    if (chrome.webNavigation.onCommitted) this.l(chrome.webNavigation.onCommitted, function(details) {
        this.invalidateMediaShelf(details.tabId, details.frameId, true);
        this.commitClickPolicy(details)
    }.bind(this));
    chrome.action.onClicked.addListener(this.N);
    // Download interception is opt-in only after persisted settings are
    // available. MV3 can wake this worker for the same download event that
    // starts the async storage read; assuming "on" during that gap can steal
    // one browser download from a user who explicitly disabled the catcher.
    this.v = !1;
    this.settingsReady = !1;
    this.settingsReadyCallbacks = [];
    chrome.action.setBadgeBackgroundColor({
        color: "#5f636b"
    });
    var c = this;
    this.F = !0;
    chrome.storage.local.get(["ShowMediaPanel", "DownloadCatcherEnabled"], function(d) {
        d = d || {};
        -1 == d.ShowMediaPanel && (c.F = !1);
        c.v = !chrome.runtime.lastError && d.DownloadCatcherEnabled !== !1;
        c.settingsReady = !0;
        c.updateActionState();
        var callbacks = c.settingsReadyCallbacks;
        c.settingsReadyCallbacks = [];
        for (var i = 0; i < callbacks.length; i++) callbacks[i]()
    });
    this.i = this.G = null;
    this.D = !1;
    this.M()
}
var W = V.prototype;
W.whenSettingsReady = function(callback) {
    this.settingsReady ? callback() : this.settingsReadyCallbacks.push(callback)
};
W.updateActionState = function() {
    var a = this.v ? "" : "Off";
    chrome.action.setTitle({
        title: this.v
            ? (chrome.i18n.getMessage("actionTitleOn") || "NDM Relay")
            : (chrome.i18n.getMessage("actionTitleOff") || "NDM Relay\r\nDownload catcher is off")
    });
    chrome.action.setBadgeText({
        text: a
    });
    chrome.contextMenus.update("NDM_ToggleCatcher", {
        checked: this.v
    }, function() {
        void chrome.runtime.lastError
    });
    var tabs = {};
    for (var key in this.H) {
        var port = this.H[key];
        if (port && 0 <= port.tabId) tabs[port.tabId] = !0
    }
    for (var tabId in tabs) this.updateMediaBadge(Number(tabId));
    this.publishClickAvailability()
};
W.updateMediaBadge = function(tabId) {
    var count = 0;
    for (var key in this.H) {
        var port = this.H[key];
        if (port && port.tabId == tabId) count += Number(port.mediaCount || 0)
    }
    count += (this.resourcesByTab[tabId] || []).length;
    chrome.action.setBadgeText({
        tabId: tabId,
        text: this.v ? (count ? String(Math.min(99, count)) : "") : "Off"
    })
};
W.toggleCatcher = function(a, callback) {
    var next = "boolean" == typeof a ? a : !this.v,
        self = this;
    chrome.storage.local.set({
        DownloadCatcherEnabled: next
    }, function() {
        var saved = !chrome.runtime.lastError;
        saved && (self.v = next);
        self.updateActionState();
        callback && callback({
            catcherEnabled: self.v,
            saved: saved
        })
    })
};
W.rememberDownloadURL = function(a, b) {
    a && b && (a[b] = Date.now() + 3E4)
};
W.consumeDownloadURL = function(a, b) {
    var c = Date.now(),
        d;
    for (d in a) a[d] < c && delete a[d];
    var e = [b && b.url, b && b.finalUrl];
    for (var f = 0; f < e.length; f++)
        if (e[f] && a[e[f]]) return delete a[e[f]], !0;
    return !1
};
W.cancelBrowserDownload = function(a) {
    chrome.downloads.cancel(a, function() {
        chrome.downloads.erase({
            id: a
        }, function() {
            void chrome.runtime.lastError
        })
    })
};
W.N = function(a) {
    a && 0 <= a.id && this.ma(a.id, [17])
};
W.Z = function(a) {
    var b = this.g[[a.tabId, a.frameId]];
    if (b && b["2"] != a.url) {
        this.invalidateMediaShelf(a.tabId, a.frameId, false);
        if (0 == a.frameId) {
            delete this.resourcesByTab[a.tabId];
            this.updateMediaBadge(a.tabId)
        }
        b.postMessage([11, a.url]);
        b["2"] = a.url
    }
};
W.Y = function(a) {
    if (this.browserHandoffs && this.browserHandoffs.attach(a)) return;
    var pending = this.pendingBrowserHandoffs && Array.from(this.pendingBrowserHandoffs).find(function(item) {
        return !item.download && (item.url === a.url || item.url === a.finalUrl);
    });
    if (pending) { pending.download = a; return; }
    if (this.claimDeferredFileDownload(a)) return;
    var b = this.consumeDownloadURL(this.forwardedDownloadURLs, a),
        c = this.consumeDownloadURL(this.blockedDownloadURLs, a);
    !h && this.v && (b || c) && this.cancelBrowserDownload(a.id)
};
W.deferredFileReferrer = function(value) {
    try {
        var url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) return "";
        url.hash = ""; url.username = ""; url.password = "";
        return url.href
    } catch (_) { return ""; }
};
W.pruneDeferredFileCandidates = function() {
    var now = Date.now(), owner = this;
    clearTimeout(this.deferredFileTimer);
    this.deferredFileCandidates.forEach(function(candidate, id) { if (candidate.expiresAt <= now) owner.deferredFileCandidates.delete(id); });
    if (this.deferredFileCandidates.size) this.deferredFileTimer = setTimeout(this.pruneDeferredFileCandidates,
        Math.max(1, Math.min(...Array.from(this.deferredFileCandidates.values(), function(candidate) { return candidate.expiresAt; })) - now));
};
W.rememberDeferredFileCandidate = function(request, details) {
    this.pruneDeferredFileCandidates();
    if (this.deferredFileCandidates.size >= 64 || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    var referrer = this.deferredFileReferrer(L(request.m, "Referer")), owner = this;
    var hasReferrerHeader = (request.m || []).some(function(header) { return String(header.name).toLowerCase() === "referer"; });
    if (!referrer && (hasReferrerHeader || details.type !== "other" || !details.documentId)) return;
    var ids = details.type === "other" ? [details.frameId] : [...new Set([details.frameId, details.parentFrameId, 0])];
    var ports = ids.map(function(frameId) { return owner.g[[details.tabId, frameId]]; }).filter(function(port) {
        if (!port || !port.documentId || !owner.deferredFileReferrer(port["2"]) || referrer && owner.deferredFileReferrer(port["2"]) !== referrer) return false;
        var expected = port.frameId === details.frameId ? details.documentId : port.frameId === details.parentFrameId ? details.parentDocumentId : null;
        if (expected && expected !== port.documentId) return false;
        if (!referrer && expected !== port.documentId) return false;
        return port.frameId === details.frameId || port.frameId === details.parentFrameId ||
            port.documentId === details.documentId || port.documentId === details.parentDocumentId
    });
    if (ports.length !== 1) return;
    var port = ports[0], top = this.g[[details.tabId, 0]];
    if (!top || !top.documentId) return;
    // Chrome can omit Referer from `other` request metadata. A matching sender
    // document plus DownloadItem's actual full referrer is required below.
    referrer ||= this.deferredFileReferrer(port["2"]);
    var item = M(new U, { 2: request["2"], 1: "GET", 3: relayHeaderValue(request.K || request.o || "").replace(/[\\/]/g, "_").slice(0, 255), 4: relayHeaderValue(top["4"]),
        5: top["2"], 7: request["7"], 8: request["8"], pageUrl: port["2"], tabId: details.tabId, frameId: port.frameId });
    Y(request, item);
    item.requestReferer = referrer;
    var now = Date.now();
    this.deferredFileCandidates.set(details.requestId, { requestId: details.requestId, item: item, referrer: referrer,
        urls: request.deferredRequestURLs || [request["2"]], url: request["2"], capturedAt: now, expiresAt: now + 30000,
        port: port, top: top, documentId: port.documentId, pageURL: port["2"], topDocumentId: top.documentId, topPageURL: top["2"] });
    this.pruneDeferredFileCandidates()
};
W.deferredFileContextCurrent = function(candidate) {
    var port = candidate.port, top = candidate.top;
    return !!(this.settingsReady && this.v && !h && this.browserHandoffs && this.clickBridgeReady() &&
        this.g[[port.tabId, port.frameId]] === port && port.documentId === candidate.documentId && port["2"] === candidate.pageURL &&
        this.g[[top.tabId, 0]] === top && top.documentId === candidate.topDocumentId && top["2"] === candidate.topPageURL &&
        !this.keepHTTPAuthDownloadInBrowser(candidate.item, candidate.url))
};
W.claimDeferredFileDownload = function(download) {
    if (!this.deferredFileCandidates.size) return false;
    this.pruneDeferredFileCandidates();
    var urls = [...new Set([download.url, download.finalUrl].filter(Boolean))];
    var matches = Array.from(this.deferredFileCandidates.values()).filter(function(candidate) {
        return urls.includes(candidate.url) && urls.every(function(url) { return candidate.urls.includes(url); })
    });
    if (!matches.length) return false;
    // DownloadItem has no tab/frame identity. Claim all URL matches before any
    // asynchronous work; ambiguous candidates remain owned by Chrome.
    matches.forEach(function(candidate) { this.deferredFileCandidates.delete(candidate.requestId); }, this);
    if (matches.length !== 1) return true;
    var candidate = matches[0], owner = this, started = Date.parse(download.startTime);
    if (!Number.isInteger(download.id) || download.state !== "in_progress" || download.paused || download.byExtensionId ||
        this.deferredFileReferrer(download.referrer) !== candidate.referrer ||
        !Number.isFinite(started) || Math.abs(started - candidate.capturedAt) > 5000 || !this.deferredFileContextCurrent(candidate)) return true;
    chrome.tabs.get(candidate.top.tabId, function(tab) {
        if (chrome.runtime.lastError || !tab || tab.url !== candidate.topPageURL || Boolean(tab.incognito) !== Boolean(download.incognito) || !owner.deferredFileContextCurrent(candidate)) return;
        chrome.webNavigation.getFrame({ tabId: candidate.port.tabId, frameId: candidate.port.frameId }, function(frame) {
            if (chrome.runtime.lastError || !frame || frame.documentId !== candidate.documentId || frame.url !== candidate.pageURL || !owner.deferredFileContextCurrent(candidate)) return;
            owner.browserHandoffs.ready.then(function() { return chrome.downloads.search({ id: download.id }); }).then(function(found) {
                var current = found[0];
                if (!current || current.state !== "in_progress" || current.paused || current.url !== download.url || current.finalUrl !== download.finalUrl ||
                    Boolean(current.incognito) !== Boolean(download.incognito) || current.referrer !== download.referrer ||
                    !owner.deferredFileContextCurrent(candidate)) return;
                var item = candidate.item;
                if (!owner.admitRelay(item).sent) return;
                item.browserHandoffID = owner.browserHandoffs.begin(candidate.url, { requiresSafeFileRedirects: true });
                if (!item.browserHandoffID) { owner.relayReservations.delete(item); return; }
                if (!owner.browserHandoffs.attach(current, item.browserHandoffID)) {
                    owner.relayReservations.delete(item); owner.browserHandoffs.reject(item.browserHandoffID).catch(function() {}); return;
                }
                item.deferredFileGuard = function() { return owner.deferredFileContextCurrent(candidate); };
                owner.relayWithCookies(item, function(receipt) {
                    if (!receipt.sent) owner.browserHandoffs.reject(item.browserHandoffID).catch(function() {});
                });
            }).catch(function() {});
        });
    });
    return true
};
// Reservations include cookie/HEAD preparation and disconnected delivery. Never
// evict an accepted intent to make room for a newer one. Memory only: requests
// may contain browser credentials or POST bodies.
W.admitRelay = function(a) {
    this.relayReservations ||= new Set();
    if (this.relayReservations.has(a)) return { accepted: true, sent: true };
    if (this.relayReservations.size >= 21) return { accepted: false, sent: false, error: "queue-full" };
    this.relayReservations.add(a);
    return { accepted: true, sent: true };
};
W.I = async function(a) {
    if (a.deferredFileGuard && !a.deferredFileGuard()) {
        this.relayReservations && this.relayReservations.delete(a);
        return { accepted: false, sent: false, error: "deferred-context-changed" };
    }
    if (a.clickHandoffID && !this.clickHandoffs.active(a.clickHandoffID)) {
        this.relayReservations && this.relayReservations.delete(a);
        return { accepted: false, sent: false, error: "handoff-expired" };
    }
    if (a.browserHandoffID && !this.browserHandoffs.active(a.browserHandoffID)) {
        this.relayReservations.delete(a);
        return { accepted: false, sent: false, error: "handoff-expired" };
    }
    // Popup media choices are immediate sends. Their short-lived guard is
    // deliberately separate from the existing durable/browser queue paths.
    var selectionError = a.relayMediaGuard && a.relayMediaGuard();
    if (selectionError) {
        this.relayReservations && this.relayReservations.delete(a);
        return { accepted: false, sent: false, error: selectionError };
    }
    var admission = this.admitRelay(a);
    if (!admission.sent) return admission;
    var self = this, selectionFailure;
    function failSelection(error) {
        self.relayReservations.delete(a);
        if (self.i === a) self.i = null;
        selectionFailure = { accepted: false, sent: false, error: error };
    }
    function queue() {
        if (a.relayMediaGuard) { failSelection(a.relayMediaGuard() || "offline"); return; }
        if (self.pendingRelayQueue.indexOf(a) < 0) {
            self.pendingRelayQueue.push(a)
        }
        self.M();
        self.scheduleBridgeRetry()
    }
    function send(message) {
        var error = a.relayMediaGuard && a.relayMediaGuard();
        if (error) { failSelection(error); return; }
        // HEAD may have yielded across a disconnect/reconnect. Only the current
        // live socket can accept this intent; send() success is not a host ACK.
        if (!self.D || !self.G || self.G.readyState !== 1) { queue(); return }
        try { self.G.send(message); self.relayReservations.delete(a); if (self.i === a) self.i = null }
        catch (error) {
            var failed = self.G;
            self.G = null;
            self.D = !1;
            self.bridgeStatus = null;
            try { failed.close() } catch (closeError) {}
            queue()
        }
    }
    {
        var b = "1:" + a["1"] + "\r\n";
        b += "2:" + a["2"] + "\r\n";
        a["3"] && (b += "3:" + a["3"] + "\r\n");
        b += "6:" + (a["6"] || "normal") + "\r\n";
        a["4"] && (b += "4:" + a["4"] + "\r\n");
        var c = relayHeaderValue(a.requestOrigin),
            d = relayHeaderValue(a.requestReferer);
        if (!c && a.pageUrl) try {
            c = (new URL(a.pageUrl.trim())).origin
        } catch (f) {}
        if (!d && a.pageUrl) {
            d = a.pageUrl;
            var e = d.lastIndexOf("#");
            d = 0 > e || e < d.indexOf("?") ? d : d.substr(0, e)
        }
        c && (b += "Origin: " + c + "\r\n");
        d && (b += "Referer: " + relayHeaderValue(d) + "\r\n");
        a["5"] && (b += "5:" + a["5"] + "\r\n");
        a.cookies && (b += "Cookie: " + a.cookies + "\r\n");
        // A scoped jar retains domain/path/HttpOnly rules for media extractors;
        // forwarding a flat Cookie header to every media CDN would lose them.
        a.sessionCookies && (b += "13:" + a.sessionBrowser + "\r\n14:" + a.sessionCookies + "\r\n15:" + a.sessionID + "\r\n");
        a["10"] && (b += "Content-Type: " + a["10"] +
            "\r\n");
        a["11"] && (b += "Content-Disposition: " + a["11"] + "\r\n");
        a["9"] && (b += "9:" + a["9"] + "\r\n");
        for (e in a) isRelayRequestHeader(e) && (b += e + ": " + relayHeaderValue(a[e]) + "\r\n");
        "POST" == a["1"] && (a["7"] && (b += "7:" + a["7"] + "\r\n"), a["8"] && (b += "8:" + a["8"] + "\r\n"), b = a.postData ? b + ("__0NeatPostData9__:" + a.postData) : b + "Content-Length: 0\r\n");
        if (118784 < b.length) { this.relayReservations.delete(a); return { accepted: false, sent: false, error: "request-too-large" }; }
        if (a.clickHandoffID) {
            this.relayReservations.delete(a);
            const accepted = await this.clickHandoffs.payload(a.clickHandoffID, b);
            return { accepted: accepted, sent: false };
        }
        if (a.browserHandoffID) {
            this.relayReservations.delete(a);
            const accepted = await this.browserHandoffs.payload(a.browserHandoffID, b);
            return { accepted: accepted, sent: accepted };
        }
        if (!this.D || !this.G || this.G.readyState !== 1) { queue(); return selectionFailure || admission; }
        if (a["3"] || "POST" == a["1"] || !this.C || a["7"] && a["8"]) {
            if (!a["3"] && "POST" != a["1"] && this.C) b += "8:" + a["8"] + "\r\n7:" + a["7"] + "\r\n";
            send(b);
            return selectionFailure || admission
        }
        // Legacy hosts request optional HEAD metadata. Failure must not erase
        // the download intent, and an unresponsive fetch must not hold it forever.
        var controller = new AbortController(), timer;
        try {
            const f = await Promise.race([
                fetch(a["2"], { method: "HEAD", credentials: "include", signal: controller.signal }),
                new Promise(function(resolve) {
                    timer = setTimeout(function() { controller.abort(); resolve(null) }, 5000)
                })
            ]);
            if (f && f.ok) {
                a["8"] = a["8"] || relayHeaderValue(f.headers.get("content-type")) || "";
                a["7"] = a["7"] || relayHeaderValue(f.headers.get("Content-Length")) || 0;
                b += "8:" + a["8"] + "\r\n7:" + a["7"] + "\r\n"
            }
        } catch (error) { /* Host can perform its own metadata probe. */ }
        finally { clearTimeout(timer) }
        send(b)
    }
    return selectionFailure || admission;
};
W.M = function() {
    // Never stack sockets: CONNECTING/OPEN already serves the queue.
    if (this.G && (0 == this.G.readyState || 1 == this.G.readyState)) return;
    // Endpoint fallback: the host binds its configured bridge port AND the
    // legacy 10007, so if the primary drifted (custom port, restored profile),
    // the very next dial tries the other address instead of dying forever.
    var a = new WebSocket(this.bridgeEndpoints[this.bridgeEndpointIndex], "ndm.open.v1");
    var self = this;
    a.onopen = function(event) { if (self.G === a) self.fa(event) };
    a.onclose = function(event) { if (self.G === a) self.ca(event) };
    a.onmessage = function(event) { if (self.G === a) self.ea(event) };
    a.onerror = function(event) { if (self.G === a) self.da(event) };
    this.G = a
};
W.requestAppFocus = function() {
    // Re-dial first: a socket that died while the worker slept is the common
    // reason "open NDM" feels dead, and M() is a no-op when one is alive.
    this.M();
    // A live host forwards this control line to the Electron shell. When the
    // bridge is offline, the popup launches the registered ndm:// URL instead.
    if (this.D && this.G && 1 == this.G.readyState) try {
        this.G.send("NDMControl: focus\r\n")
    } catch (a) {}
    return this.D
};
W.fa = function() {
    this.bridgeStatus = null;
    // Hello must precede queued download/control messages on every connection.
    // An older host may ignore it; no reply or version match gates downloads.
    try {
        this.G.send("NDMRelayHello:" + JSON.stringify({
            version: NDM_RELAY_RUNNING_VERSION, protocol: 1, role: "worker"
        }));
    } catch (error) { /* ordinary transport handling remains responsible */ }
    this.D = !0;
    this.publishClickAvailability();
    this.everConnected = !0;
    this.coldProbes = 0;
    // Fresh connection: drop the retry clock and let the next drop start at 1s.
    if (this.bridgeRetryTimer) {
        clearTimeout(this.bridgeRetryTimer);
        this.bridgeRetryTimer = null
    }
    this.bridgeRetryMs = 0;
    // Remember the address that actually answered, so the next cold worker
    // starts on the working endpoint instead of rediscovering it.
    var chosen = this.bridgeEndpoints[this.bridgeEndpointIndex];
    chrome.storage.local.set({ bridgeEndpoint: chosen }, function() {});
    // The popup may have closed right after asking for an ndm:// launch; its
    // handoff tab has served its purpose the moment this socket went live.
    if (this.handoffTabId >= 0) {
        var c = this.handoffTabId;
        this.handoffTabId = -1;
        chrome.tabs.remove(c, function() {
            void chrome.runtime.lastError
        })
    }
    var a = this.pendingRelayQueue;
    this.pendingRelayQueue = [];
    for (var b = 0; b < a.length; b++) this.I(a[b])
};
W.ca = function() {
    this.D = !1;
    this.bridgeStatus = null;
    this.i = null;
    this.publishClickAvailability();
    // The address we just lost failed — give the alternate a chance on the
    // next dial, whether or not clicks are waiting. With no pending intent we
    // still probe a bounded number of times so a cold worker that started
    // against a not-yet-listening host finds the bridge once it appears.
    if (this.pendingRelayQueue.length || this.browserHandoffs?.hasPending() || this.clickHandoffs?.hasPending() || !this.everConnected) {
        this.bridgeEndpointIndex = (this.bridgeEndpointIndex + 1) % this.bridgeEndpoints.length;
        if (this.pendingRelayQueue.length || this.browserHandoffs?.hasPending() || this.clickHandoffs?.hasPending() || this.coldProbes < 4) {
            if (!this.pendingRelayQueue.length) this.coldProbes++;
            this.scheduleBridgeRetry()
        }
    }
};
W.scheduleBridgeRetry = function() {
    if (this.bridgeRetryTimer) return;
    var a = this;
    this.bridgeRetryMs = this.bridgeRetryMs ? Math.min(2 * this.bridgeRetryMs, 15000) : 1000;
    this.bridgeRetryTimer = setTimeout(function() {
        a.bridgeRetryTimer = null;
        a.M()
    }, this.bridgeRetryMs)
};
W.ea = function(a) {
    a = a.data;
    if (typeof a !== "string") return;
    if (a.startsWith("NDMRelaySessionRequest:")) {
        try {
            var request = JSON.parse(a.slice("NDMRelaySessionRequest:".length));
            if (typeof request.requestId === "string" && request.requestId.length <= 128 &&
                typeof request.sessionID === "string" && typeof request.url === "string") {
                this.refreshMediaSession(request).catch(function() {});
            }
        } catch (_) {}
        return;
    }
    if (a.startsWith("NDMRelayReceipt:")) {
        try { var receipt = JSON.parse(a.slice("NDMRelayReceipt:".length));
            if (this.browserHandoffs) this.browserHandoffs.receipt(receipt).catch(function() {});
            if (this.clickHandoffs) this.clickHandoffs.receipt(receipt).catch(function() {});
        } catch (_) {}
        return;
    }
    if (a.startsWith("NDMRelayStatus:")) {
        try {
            var status = JSON.parse(a.slice("NDMRelayStatus:".length));
            if (status && status.protocol === 1 &&
                (status.expectedVersion === null || typeof status.expectedVersion === "string")) {
                this.bridgeStatus = { protocol: 1, expectedVersion: status.expectedVersion, durableHandoff: status.durableHandoff,
                    safeFileRedirects: status.safeFileRedirects };
                if (this.browserHandoffs) this.browserHandoffs.connected().catch(function() {});
                if (this.clickHandoffs) this.clickHandoffs.connected().catch(function() {});
                this.publishClickAvailability();
            }
        } catch (error) { /* malformed/unknown status cannot disable downloads */ }
        return;
    }
    "waiting" == a ? this.C = !0 : "nowaiting" == a ? this.C = !1 : !Q(a, "Version") && (N(a, "ShowPanelChrome") || N(a, "ShowPanelEdge")) && (a = "1" == a.split("=")[1], a != this.F && (this.F = a, chrome.storage.local.set({
        ShowMediaPanel: a ? 1 : -1
    }, function() {}), this.ha([13, a])))
};
W.da = function() {
    this.D = !1;
    this.bridgeStatus = null;
    this.publishClickAvailability();
    // Tell the page once per episode (not once per failed request) that the
    // bridge is down, so the page can show a calm inline notice.
    if ((this.i || this.pendingRelayQueue.length) && Date.now() - this.lastBridgeNoticeAt > 8000) {
        this.lastBridgeNoticeAt = Date.now();
        var a = this;
        chrome.tabs.query({
            currentWindow: !0,
            active: !0
        }, function(b) {
            b && b.length && (b = a.g[[b[0].id, 0]]) && b.postMessage([15])
        })
    }
    this.i = null;
    this.pendingRelayQueue.length && this.scheduleBridgeRetry()
};
W.J = function(a, b) {
    if (!a) return;
    var c = "";
    if (b && 0 < b.length)
        for (var d = 0; d < b.length; d++) c += b[d].name + "=" + b[d].value + (d < b.length - 1 ? "; " : "");
    a.cookies || (a.cookies = relayHeaderValue(c));
    this.i === a && (this.i = null);
    return this.I(a)
};
W.mediaSessionRegistry = function() {
    return this.relayMediaSessions ||= NDMRelaySessionCookies.createRegistry(chrome);
};
W.refreshMediaSession = async function(request) {
    var context = await this.mediaSessionRegistry().find(request.sessionID, request.url);
    // Every worker hears the request. Only the profile that admitted this
    // explicit handoff owns its opaque token and may answer it.
    if (!context) return;
    var captured = await NDMRelaySessionCookies.capture(chrome, context);
    if (!captured.context) return;
    var jar = NDMRelaySessionCookies.netscape(captured.cookies, request.url) || "# Netscape HTTP Cookie File\n";
    var encoded = NDMRelaySessionCookies.encode(jar);
    if (encoded.length > 65536 || !this.D || !this.G || this.G.readyState !== 1) return;
    this.G.send("NDMRelaySessionResponse:" + JSON.stringify({ requestId: request.requestId,
        sessionID: request.sessionID, cookies: encoded }));
};
W.relayWithCookies = function(a, callback) {
    var self = this, admission = a ? this.admitRelay(a) : { accepted: false, sent: false, error: "unavailable" };
    function finish(result) { if (callback) callback(result); }
    if (!admission.sent) { finish(admission); return admission; }
    function failed() {
        self.relayReservations.delete(a);
        finish({ accepted: false, sent: false, error: "send-failed" });
    }
    try {
        var mediaPage = a["6"] === "media-page" || !!NDMRelaySiteAdapters.currentPageURL(a["2"]);
        if (a.cookies && !mediaPage) this.I(a).then(finish, failed);
        else {
            this.i = a;
            NDMRelaySessionCookies.capture(chrome, { url: a["2"], tabId: a.tabId, frameId: a.frameId }).then(async function(captured) {
                var cookies = captured.cookies;
                if (mediaPage) {
                    // Empty is meaningful: an anonymous handoff must never
                    // reuse another profile's previous logged-in session.
                    var jar = NDMRelaySessionCookies.netscape(cookies, a["2"]) || "# Netscape HTTP Cookie File\n";
                    var encoded = NDMRelaySessionCookies.encode(jar);
                    if (encoded.length <= 65536) {
                        a.sessionID = crypto.randomUUID();
                        await self.mediaSessionRegistry().remember(a.sessionID, captured.context);
                        a.sessionCookies = encoded;
                        a.sessionBrowser = NDMRelaySessionCookies.browserName(typeof navigator !== "undefined" ? navigator : null);
                    }
                }
                a.cookies ||= NDMRelaySessionCookies.header(cookies, a["2"]);
                return self.I(a);
            }, function() {
                // A public video/file must not be blocked by a browser cookie
                // API failure. Captured request headers still take precedence.
                return self.I(a);
            }).then(finish, failed);
        }
    } catch (_) { failed(); }
    return admission;
};
W.X = function(a, b) {
    if ("NDM_ShowMediaPanel" == a.menuItemId) {
        b && 0 <= b.id && this.ma(b.id, [17]);
        return
    }
    if ("NDM_ToggleCatcher" == a.menuItemId) {
        this.toggleCatcher(a.checked);
        return
    }
    var c = R(a.linkUrl);
    !c || "ftp" != c && "http" != c && "https" != c || "ftp" == c && !F(a.linkUrl) || (c = new U, c["2"] = a.linkUrl || a.srcUrl, c.tabId = b && b.id, c.frameId = a.frameId || 0, c.pageUrl = a.pageUrl, c["4"] = b && b.title || "", b && b.url && (c["5"] = b.url), !c["5"] && (c["5"] = a.pageUrl), this.relayWithCookies(c))
};

function X(a) {
    this.g = a
}
var ja = X.prototype;
ja.j = function(a) {
    var b = "";
    if (!a) return b;
    if ((a = a.split(",")) && a.length)
        for (var c = 0; c < a.length; c++) {
            var d = a[c].split("=");
            d && 2 == d.length && ("BANDWIDTH" == d[0].toString().trim() && (b += parseInt(parseInt(d[1]) / 1024) + " Kbps "), "RESOLUTION" == d[0].toString().trim() && (b += d[1] + " "))
        }
    return b.trim()
};
ja.i = function(a, b) {
    var c = [],
        d = 0,
        e = "",
        f = this;
    b = b.split(/[\r\n]+/);
    if (0 != b.length && "#EXTM3U" == b[0].trim()) {
        for (var g = !1, m = !1, y = !1, p = "", t = RegExp("^#(EXT[^\\s:]+)(?::(.*))"), G = 1; G < b.length; G++) {
            var k = b[G].trim();
            k && ("#" == k[0] ? 0 == k.indexOf("#EXT") && (k = t.exec(k)) && (g || (g = "EXTINF" == k[1]) && (p = k[2]), m || (m = "EXT-X-STREAM-INF" == k[1]) && (p = k[2]), y ||= "EXT-X-BYTERANGE" == k[1]) : (g && (d += parseFloat(p), g = !1), m && (c.push({
                2: (new URL(k, a["2"])).href,
                tags: p,
                audio: NDMRelayMediaPolicy.hlsAudioForVariant(b, p, a["2"])
            }), m = !1), y && !e && (e = (new URL(k, a["2"])).href)))
        }
        if (e) {
            b = "";
            d && (60 <
                d && (b += parseInt(d / 60) + " min "), b += parseInt(d % 60) && parseInt(d % 60) + " sec");
            var l = {
                6: "media",
                fEx: "ts",
                4: "TS File " + b,
                fDu: b
            };
            l = M(l, {
                1: a["1"],
                2: e,
                tabId: a.tabId,
                frameId: a.frameId,
                fS: a["7"],
                fileName: a.fileName
            });
            Y(a, l);
            "POST" == l["1"] && T(a, l);
            setTimeout(function() {
                f.g.A(l)
            }, 2500)
        } else c.length ? setTimeout(function() {
            for (var B = 0; B < c.length; B++) f.g.A(M({
                tabId: a.tabId,
                frameId: a.frameId
            }, {
                1: "GET",
                2: c[B]["2"],
                3: c[B].audio,
                6: "hls",
                fEx: "ts",
                4: "TS File " + f.j(c[B].tags)
            }))
        }, 2500) : 0 < d && (b = "", 60 < d && (b += parseInt(d / 60) + " min "), b +=
            parseInt(d % 60) && parseInt(d % 60) + " sec", l = {
                6: "hls",
                fEx: "ts",
                4: "TS File " + b,
                fDu: b
            }, l = M(l, {
                1: a["1"],
                2: a["2"],
                tabId: a.tabId,
                frameId: a.frameId,
                fS: a["7"],
                fileName: a.fileName
            }), Y(a, l), "POST" == l["1"] && T(a, l), setTimeout(function() {
                f.g.A(l)
            }, 2500))
    }
};
W.A = function(a) {
    var b = this.g[[a.tabId, a.frameId]];
    if (!b && (b = this.g[[a.tabId, 0]], !b)) return;
    var c = a["2"],
        d = 0,
        e;
    var f = 0;
    for (e = c.length; f < e; f++) {
        var g = c.charCodeAt(f);
        d = (d << 5) - d + g;
        d |= 0
    }
    a.id = d;
    b.postMessage([1, a, b["2"]])
};
W.sendResource = function(a) {
    var tabId = Number(a && a.tabId);
    if (!(0 <= tabId)) return;
    this.resourcesByTab[tabId] = NDMRelayResourcePolicy.compactResources(
        (this.resourcesByTab[tabId] || []).concat([a]),
        12
    );
    this.updateMediaBadge(tabId)
};
W.O = function(a) {
    if (this.clickHandoffs) this.clickHandoffs.completed(a.requestId);
    delete this.j[a.requestId]
};

function ka(a, b) {
    if (!a) return null;
    var c = a.raw;
    if (c) {
        a = "";
        for (b = 0; b < c.length; b++) {
            var d = c[b].bytes;
            if (!d) return null;
            d = new Uint8Array(d);
            for (var e = d.length, f = 0; f < e; f++) a += String.fromCharCode(d[f])
        }
        return a
    }
    c = a.formData;
    if (!c) return null;
    e = E(b);
    a = [];
    e &&= e.toLowerCase();
    if ("application/x-www-form-urlencoded" == e) {
        for (d in c)
            for (e = c[d], d = d.split(" ").map(encodeURIComponent).join("+"), b = 0; b < e.length; b++) a.length && a.push("&"), a.push(d, "=", e[b].split(" ").map(encodeURIComponent).join("+"));
        return a.join("")
    }
    if ("multipart/form-data" ==
        e) {
        (f = Z(b, "boundary")) || (f = "----WebKitFormBoundary" + Math.random().toString(36).substr(2));
        for (d in c)
            for (e = c[d], b = 0; b < e.length; b++) a.push("--", f, '\r\nContent-Disposition: form-data; name="', d, '"\r\n\r\n', e[b], "\r\n");
        a.push("--", f, "--\r\n");
        return a.join("")
    }
    return null
}
W.V = function(a) {
    if (!("video/webm" != a["8"].toLowerCase() && "audio/webm" != a["8"].toLowerCase() || 1 > a["2"].indexOf("signature=") && 1 > a["2"].indexOf("sig="))) {
        var b = this.g[[a.tabId, a.frameId]];
        b ||= this.g[[a.tabId, 0]];
        if (b) {
            var c = a["2"].indexOf("?");
            if (-1 != c) {
                var d = a["2"].substring(0, c);
                c = a["2"].substring(c + 1);
                a = {
                    2: "",
                    mme: a["8"].split("/").shift(),
                    ig: 0,
                    du: 0,
                    mK: "",
                    purl: b["2"]
                };
                d += "?";
                c = c.split("&");
                for (var e = 0; e < c.length; e++) N(c[e], "dur=") && (a.du = parseFloat(c[e].split("=").pop())), N(c[e], "itag=") && (a.ig = c[e].split("=").pop()),
                    N(c[e], "ei=") && (a.mK = c[e].split("=").pop()), N(c[e], "range=") || N(c[e], "rbuf=") || N(c[e], "rn=") || (d = d + c[e] + "&");
                a.du && a.ig && (d = d.substring(0, d.length - 1), a["2"] = d, b.postMessage([9, a]))
            }
        }
    }
};
W.W = function(a) {
    this.captureClickHTTPAuth(a);
    if (!a.ndmClickPolicyCaptured) { this.captureClickPolicy(a); a.ndmClickPolicyCaptured = true; }
    if (this.clickHandoffs && !this.clickHandoffsReady) {
        var waiting = this.j[a.requestId], owner = this;
        this.clickHandoffs.ready.then(function() { if (waiting) { owner.j[a.requestId] ||= waiting; owner.W(a); } }, function() {});
        return;
    }
    var sourceRequest = this.j[a.requestId];
    var keepHTTPAuthInBrowser = sourceRequest && a.method === "GET" && this.keepHTTPAuthDownloadInBrowser(sourceRequest, a.url);
    if (sourceRequest && this.bindClickFallback({ ...a, url: sourceRequest["2"] })) sourceRequest.clickFallback = true;
    if (sourceRequest && sourceRequest.clickFallback) {
        this.deferredFileCandidates.forEach(function(candidate, id) {
            if (candidate.port.tabId === a.tabId && (candidate.urls.includes(a.url) || candidate.urls.includes(sourceRequest["2"]))) this.deferredFileCandidates.delete(id);
        }, this);
        return;
    }
    var deferredResponse = a;
    var b, c = a.requestId,
        d = this;
    if (b = this.j[c]) {
        var e = a.url,
            f = a.type,
            g = 0 <= ba.indexOf(f),
            m = a.method.toUpperCase(),
            y = R(e);
        if (!y || "http" != y && "https" != y || "GET" != m && "POST" != m) delete this.j[c];
        else {
            b.B = a.responseHeaders;
            var p = L(b.B, "Content-Type"),
                t = E(p).toLowerCase();
            if ("image" == f && t && N(t.toLowerCase(), "image/")) delete this.j[c];
            else {
                var G = L(b.B, "Content-Disposition"),
                    k = "attachment" == E(G).toLowerCase();
                a = parseInt(a.statusLine.split(" ", 2).pop()) || 0;
                b.ia = 0 <= da.indexOf(a);
                if (!b.ia)
                    if (200 != a &&
                        206 != a) delete this.j[c];
                    else {
                        a = L(b.B, "Content-Length");
                        var l = L(b.B, "Content-Range"),
                            B = null;
                        l && (l = aa.exec(l)) && (a = l[1]);
                        a && (B = parseInt(a));
                        if (0 === B) delete this.j[c];
                        else {
                            b["2"] = e, b["8"] = p, b["7"] = B, b.type = f, b.protocol = y, b["1"] = m, b.S = P(f, "_frame"), f = new URL(e), e = f.hostname, f = f.pathname, (m = f.split("/").pop().trim()) && (m = m.split("?").shift().trim()), b.o = m || "", b.u = K(b.o), b.K = Z(G, "filename") || Z(p, "name"), b.R = b.K && K(b.K) || "", p = t ? D[t] : !1, b.P = (p ? p.split("|").shift() : "").toLowerCase(), b.h = b.P || b.R || b.u ||
                            "", b.fileName = b.K || b.o || "", b.fileName && (p = b.fileName.lastIndexOf("."), -1 < p && (b.fileName = b.fileName.substr(0, p).trim())), b.fileName && b.h && (b.fileName += "." + b.h), !t && b.h && (t = ia(b.h));
                            var downloadMeta = {
                                requestType: b.type,
                                method: b["1"], contentType: t,
                                extension: b.h,
                                isAttachment: k,
                                isForceDownload: ea.test(t),
                                isMedia: u.test(b.h),
                                isStreamSegment: C.test(b.h),
                                isKnownNonDownload: fa.test(b.h),
                                isUnknownBinary: Boolean(b.h && !u.test(b.h) && !fa.test(b.h))
                            };
                            p = NDMRelayMediaPolicy.shouldInterceptNavigation(downloadMeta);
                            var deferFile = !keepHTTPAuthInBrowser && NDMRelayMediaPolicy.shouldDeferFileDownload && NDMRelayMediaPolicy.shouldDeferFileDownload(downloadMeta);
                            if (deferFile) this.rememberDeferredFileCandidate(b, deferredResponse);
                            // Browser-managed HTTP authentication is unavailable to the
                            // early payload. Keep ordinary downloads in Chrome while
                            // still running the existing resource/media discovery below.
                            p && keepHTTPAuthInBrowser && (p = false);
                            !p && !deferFile && !keepHTTPAuthInBrowser && NDMRelayMediaPolicy.shouldCancelUnexpectedBrowserDownload(downloadMeta) && d.rememberDownloadURL(d.blockedDownloadURLs, b["2"]);
                            var resourceCandidate = NDMRelayResourcePolicy.candidateFromResponse({
                                1: b["1"],
                                2: b["2"],
                                7: b["7"],
                                8: b["8"],
                                requestType: b.type,
                                extension: b.h,
                                fileName: b.K || b.o,
                                isAttachment: k
                            });
                            if (resourceCandidate) {
                                resourceCandidate.tabId = b.tabId;
                                resourceCandidate.frameId = b.frameId;
                                d.sendResource(resourceCandidate)
                            }
                            if (Q(b.o.toLowerCase(), "manif") || Q(b.o.toLowerCase(), "favicon.ico") || Q(b.o.toLowerCase(), "pem.msg") || P(b.o.toLowerCase(), ".wasm") || Q(b.o.toLowerCase(), ".json") || Q(b.P.toLowerCase(), "json") || Q(b.R.toLowerCase(), "json") || !p)
                            if (Q(e, "youtube.com") && Q(f, "api/timedtext")) {
                                if (g = b["2"].indexOf("?"), -1 != g) {
                                    c = b["2"].substring(0, g) + "?";
                                    g = b["2"].substring(g + 1).split("&");
                                    for (t = 0; t < g.length; t++) c = N(g[t], "fmt=") ? c + "fmt=vtt&" : c + g[t] + "&";
                                    "&" == c[c.length - 1] && (c = c.substring(0, c.length - 1));
                                    b["2"] = c;
                                    var H = {
                                        2: b["2"],
                                        6: "media",
                                        1: b["1"],
                                        tabId: b.tabId,
                                        frameId: b.frameId,
                                        fEx: "VTT",
                                        7: b["7"],
                                        8: b["8"],
                                        fS: b["7"],
                                        fileName: b.fileName
                                    };
                                    setTimeout(function() {
                                        d.A(H)
                                    }, 1500)
                                }
                            } else {
                                k =
                                    "vtt" == b.h.toLowerCase() || "vtt" == b.u.toLowerCase() || "srt" == b.h.toLowerCase() || "srt" == b.u.toLowerCase();
                                var O = null;
                                "m3u8" == b.h.toLowerCase() || "m3u8" == b.u.toLowerCase() ? O = new X(this) : k || "POST" == b["1"] || Q(e.toLowerCase(), "vimeo") || Q(e.toLowerCase(), "youtube") || Q(e.toLowerCase(), "google") || Q(e.toLowerCase(), "bilibili") || Q(e.toLowerCase(), "hdslb") || "txt" != b.h.toLowerCase() && "js" != b.h.toLowerCase() || "xmlhttprequest" != b.type || b["7"] && 307200 < b["7"] || (O = new X(this));
                                if (O) S({
                                    2: b["2"],
                                    L: function(v) {
                                        O.i(M({}, b), v)
                                    }
                                }, M({}, b));
                                else if (g && P(e, "googlevideo.com") && N(f, "/videoplayback")) this.V(b);
                                else if (g && RegExp("^(?:[w-]+.)*?(?:youtube.com|googlevideo.com|youtube.googleapis.com|docs.google.com)$", "i").test(e)) {
                                    if (P(f, "player") && "POST" == b["1"] && 0 != b.frameId) {
                                        T(b, b);
                                        var q = b.postData;
                                        var r = q.indexOf('"videoId"');
                                        if (0 > r) return;
                                        q = q.substr(r + 9);
                                        r = q.indexOf('"');
                                        if (0 > r) return;
                                        var I = q.indexOf('"', r + 1);
                                        if (I < r) return;
                                        S({
                                            2: "https://www.youtube.com/watch?v=" + q.substr(r + 1, I - r - 1),
                                            L: function(v) {
                                                for (var w = ['"formats"', "adaptiveFormats"], z = 0; z < w.length; z++)
                                                    if (q = v, r = q.indexOf(w[z]), !(0 > r || -1 < q.indexOf("signatureCipher"))) {
                                                        q =
                                                            q.substr(r);
                                                        r = q.indexOf("[");
                                                        I = q.indexOf("]");
                                                        if (0 > r || 0 > I || I <= r) break;
                                                        q = q.substr(r + 1, I - r - 1);
                                                        (x = d.g[[b.tabId, b.frameId]]) || (x = d.g[[b.tabId, 0]]);
                                                        x && x.postMessage([7, q, 1 == z])
                                                    }
                                            }
                                        }, null)
                                    }
                                } else g && "player.vimeo.com" == e && N(f, "/video/") && "application/json" == t ? S({
                                    2: b["2"],
                                    L: function(v) {
                                        var w = null;
                                        try {
                                            w = JSON.parse(v)
                                        } catch (J) {}
                                        if (w) {
                                            var z = w.request.files.progressive;
                                            z && setTimeout(function() {
                                                    for (var J = 0; J < z.length; J++) d.A({
                                                        1: "GET",
                                                        2: z[J].url,
                                                        6: "media",
                                                        tabId: b.tabId,
                                                        frameId: b.frameId,
                                                        fEx: "mp4",
                                                        4: "MP4 File " + z[J].quality
                                                    })
                                                },
                                                2500)
                                        }
                                    }
                                }, b) : !g && !k || !u.test(b.h) && !u.test(b.u) || C.test(b.h) || !(!b["7"] || 204800 < b["7"] || k) || "ASF" == b.h && 1024E3 >= b["7"] || "DCLK-AdSvr" == L(b.B, "Server") || (H = {
                                    2: b["2"],
                                    6: "media",
                                    1: b["1"],
                                    tabId: b.tabId,
                                    frameId: b.frameId,
                                    fEx: u.test(b.h) ? b.h : b.u,
                                    7: b["7"],
                                    8: b["8"],
                                    fS: b["7"],
                                    fileName: b.fileName
                                }, "POST" == H["1"] && T(b, H), Y(b, H), setTimeout(function() {
                                    d.A(H)
                                }, 2E3));
                                delete this.j[c]
                            }
                        else {
                            if (h || !this.v) {
                                // Explicit bypass/off means Chrome owns the
                                // navigation; do not register it for cleanup.
                            }
                            else {
                                var x = d.g[[b.tabId, b.frameId]];
                                g = d.g[[b.tabId, 0]];
                                var A = M(new U, {
                                    2: b["2"],
                                    1: b["1"],
                                    4: g && g["4"] || x && x["4"],
                                    5: g && g["2"] || x && x["2"],
                                    7: b["7"],
                                    8: b["8"],
                                    pageUrl: x && x["2"] || b["2"]
                                });
                                A.tabId = b.tabId;
                                A.frameId = b.frameId;
                                if (!d.admitRelay(A).sent) { delete this.j[c]; return; }
                                var handoff = { url: b["2"] };
                                if (this.browserHandoffs) {
                                    A.browserHandoffID = this.browserHandoffs.begin(b["2"]);
                                    if (!A.browserHandoffID) { this.relayReservations.delete(A); delete this.j[c]; return; }
                                }
                                this.pendingBrowserHandoffs ||= new Set();
                                if (!A.browserHandoffID) this.pendingBrowserHandoffs.add(handoff);
                                "POST" == A["1"] && T(b, A);
                                Y(b, A);
                                chrome.tabs.query({ active: !0, currentWindow: !0 }, function(v) {
                                    var closeTab = null;
                                    if (v && v.length && (b["2"] == v[0].pendingUrl || b["2"] == v[0].url) && !A["5"] && v[0].openerTabId) {
                                        var opener = d.g[[v[0].openerTabId, 0]];
                                        A["5"] = opener && opener["2"];
                                        A["4"] = opener && opener["4"];
                                        if (u.test(b.h)) { closeTab = v[0].id; A["6"] = "media"; }
                                    }
                                    d.relayWithCookies(A, function(receipt) {
                                        d.pendingBrowserHandoffs.delete(handoff);
                                        if (A.browserHandoffID) {
                                            if (!receipt.sent) d.browserHandoffs.reject(A.browserHandoffID).catch(function() {});
                                            return;
                                        }
                                        if (!receipt.sent) return;
                                        if (handoff.download) { if (!h && d.v) d.cancelBrowserDownload(handoff.download.id); }
                                        else d.rememberDownloadURL(d.forwardedDownloadURLs, b["2"]);
                                        if (closeTab !== null && !h && d.v) chrome.tabs.remove(closeTab);
                                    });
                                });
                            }
                            delete this.j[c]
                        }
                    }
                    }
            }
        }
    }
};

function T(a, b) {
    var c = L(a.m, "Content-Type"),
        d = L(a.m, "Content-Disposition");
    a = ka(a.ka, c);
    if (!a || 1 > a.length) a = null;
    b.postData = a;
    c && (b["10"] = c.trim());
    d && (b["11"] = d.trim())
}

function Y(a, b) {
    if (a.m)
        for (var c = 0; c < a.m.length; c++) {
            var d = a.m[c].name,
                e = d.toLowerCase(),
                f = relayHeaderValue(a.m[c].value);
            if (!f) continue;
            "cookie" == e ? b.cookies = f : "referer" == e ? b.requestReferer = f : "origin" == e ? b.requestOrigin = f : "user-agent" == e ? b["9"] = f : "content-type" == e ? b["10"] = f : isRelayRequestHeader(e) && (b[d] = f)
        }
}
W.U = function(a) {
    if (!(0 > a.tabId || 0 > a.frameId)) {
        var b = this.j[a.requestId];
        b && (b.m = a.requestHeaders)
    }
};
W.T = function(a) {
    if (!(0 > a.tabId || 0 > a.frameId))
        if ("ftp" == R(a.url)) {
            if (F(a.url) && !h) {
                var b = new U,
                    c = this.g[[a.tabId, 0]];
                c && c["2"] && (b["5"] = c["2"], b.pageUrl = c["2"]);
                c && c["4"] && (b["4"] = c["4"]);
                b["2"] = a.url;
                this.I(b)
            }
        } else b = a.requestId, c = this.j[b] || {
            id: b,
            2: a.url,
            tabId: a.tabId,
            frameId: a.frameId
        }, "POST" == a.method.toUpperCase() && (c.ka = a.requestBody), this.bindClickFallback(a) && (c.clickFallback = true),
            (a.type === "sub_frame" || a.type === "other") && ((c.deferredRequestURLs ||= []),
                c.deferredRequestURLs.length < 32 && !c.deferredRequestURLs.includes(a.url) && c.deferredRequestURLs.push(a.url)), this.j[b] = c
};

function Z(a, b) {
    if (!a) return null;
    b = b.toLowerCase();
    a = a.split(";");
    a.shift();
    for (var c = 0; c < a.length; c++) {
        var d = a[c],
            e = d.indexOf("=");
        if (0 < e) {
            var f = d.substr(0, e).trim().toLowerCase(),
                g = "*" == f[f.length - 1];
            g && (f = f.substr(0, f.length - 1).trimRight());
            if (f == b) return a = d.substr(e + 1).trim(), c = a.length - 1, '"' == a[0] && '"' == a[c] && (a = a.substring(1, c)), g && (a = a.split("'", 3).pop()), unescape(a)
        } else if (0 > e && d.trim().toLowerCase() == b) return ""
    }
    return null
}
W.l = function(a) {
    a.addListener.apply(a, Array.prototype.slice.call(arguments).slice(1))
};
W.clickBridgeReady = function() {
    // Before Chrome makes the first request, NDM must own redirect credential
    // boundaries as well as durable admission. Older hosts keep the browser path.
    return !!(this.D && this.G && this.G.readyState === 1 && this.bridgeStatus &&
        this.bridgeStatus.durableHandoff === 1 && this.bridgeStatus.safeFileRedirects === 1)
};
W.clickContext = function(port) {
    return { tabId: port.tabId, frameId: port.frameId, documentId: port.documentId, pageURL: port["2"] }
};
W.clickAvailable = function(port) {
    var policy = port && this.clickPagePolicies[port.tabId];
    return !!(this.settingsReady && this.v && !h && this.clickHandoffsReady && this.clickHTTPAuthReady && this.clickBridgeReady() && port && port.frameId === 0 &&
        !this.clickHTTPAuthOrigins.has(this.clickHTTPOrigin(port["2"])) &&
        this.g[[port.tabId, 0]] === port && port.documentId && policy && policy.documentId === port.documentId && policy.allowed)
};
W.clickHTTPOrigin = function(value) {
    try { var url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : ""; } catch (_) { return ""; }
};
W.captureClickHTTPAuth = function(details) {
    if (!Number.isInteger(details.tabId) || details.tabId < 0 || details.statusCode !== 401 && !/^HTTP\/\S+ 401(?: |$)/.test(details.statusLine || "")) return;
    // Only header presence is needed. Never inspect or retain the challenge,
    // realm, user credentials, or browser Authorization header values.
    if (!(details.responseHeaders || []).some(function(header) { return String(header.name).toLowerCase() === "www-authenticate"; })) return;
    var origin = this.clickHTTPOrigin(details.url), owner = this;
    if (!origin || this.clickHTTPAuthOrigins.has(origin)) return;
    this.clickHTTPAuthOrigins.add(origin);
    this.publishClickAvailability();
    this.clickHTTPAuthWrites = this.clickHTTPAuthWrites.then(function() {
        if (!owner.clickHTTPAuthLoaded || !chrome.storage.session) return;
        return chrome.storage.session.set({ ndmClickHTTPAuthOriginsV1: Array.from(owner.clickHTTPAuthOrigins) }).then(function() {
            owner.clickHTTPAuthReady = true; owner.publishClickAvailability();
        }, function() { owner.clickHTTPAuthReady = false; owner.publishClickAvailability(); });
    });
};
W.keepHTTPAuthDownloadInBrowser = function(request, url) {
    var page = this.g[[request.tabId, 0]];
    return !this.clickHTTPAuthReady || [url, request["2"], page && page["2"]].some(function(value) {
        return this.clickHTTPAuthOrigins.has(this.clickHTTPOrigin(value));
    }, this)
};
W.publishClickAvailability = function() {
    Object.values(this.H).forEach(function(port) {
        if (port && port.frameId === 0) try { port.postMessage([28, { available: this.clickAvailable(port) }]); } catch (_) {}
    }, this)
};
W.captureClickPolicy = function(details) {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    var raw = (details.responseHeaders || []).filter(function(header) { return String(header.name).toLowerCase() === "referrer-policy"; })
        .map(function(header) { return String(header.value || ""); }).join(",");
    var tokens = raw.toLowerCase().split(",").map(function(value) { return value.trim(); });
    var recognized = tokens.filter(function(value) { return ["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"].includes(value); });
    var effective = recognized.at(-1) || "";
    this.clickNavigationPolicies[details.tabId] = { url: details.url, allowed: ["", "no-referrer-when-downgrade", "same-origin", "strict-origin-when-cross-origin", "unsafe-url"].includes(effective) }
};
W.commitClickPolicy = function(details) {
    if (details.frameId !== 0) return;
    var policy = this.clickNavigationPolicies[details.tabId];
    this.clickPagePolicies[details.tabId] = { documentId: details.documentId || "", allowed: !!(policy && policy.url === details.url && policy.allowed) };
    delete this.clickNavigationPolicies[details.tabId];
    this.publishClickAvailability()
};
W.validateFileClick = function(port, request, fallback) {
    if (!request || typeof NDMClickHandoff === "undefined" || !NDMClickHandoff.validID(request.requestId) ||
        port.frameId !== 0 || !port.documentId || this.g[[port.tabId, 0]] !== port || request.pageURL !== port["2"]) return false;
    if (typeof request.url !== "string" || /[\x00-\x20\x7f]/.test(request.url) || /%(?:0[ad]|00)/i.test(request.url) ||
        typeof request.filename !== "undefined" && (typeof request.filename !== "string" || /[\x00-\x1f\x7f\/\\]/.test(request.filename) || request.filename.length > 255)) return false;
    try {
        var url = new URL(request.url), page = new URL(port["2"]);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || page.username || page.password || url.hash || url.origin !== page.origin) return false;
        if (fallback) return true;
        return request.explicitDownload === true || !url.search && /\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz|dmg|pkg|exe|msi|iso)$/i.test(url.pathname)
    } catch (_) { return false; }
};
W.checkClickDocument = function(port, done) {
    chrome.tabs.get(port.tabId, function(tab) {
        if (chrome.runtime.lastError || !tab || tab.url !== port["2"]) { done(false); return; }
        chrome.webNavigation.getFrame({ tabId: port.tabId, frameId: 0 }, function(frame) {
            done(!chrome.runtime.lastError && !!frame && frame.url === port["2"] && frame.documentId === port.documentId)
        });
    })
};
W.handleFileClick = function(port, request) {
    var self = this;
    function fallback(reason) { try { port.postMessage([28, { requestId: request && request.requestId,
        status: self.clickHandoffs && self.clickHandoffs.mayHaveSent(request && request.requestId) ? "pending" : "fallback", reason: reason }]); } catch (_) {} }
    if (this.clickHandoffs && !this.clickHandoffsReady) {
        this.clickHandoffs.ready.then(function() { self.handleFileClick(port, request); }, function() {
            try { port.postMessage([28, { requestId: request && request.requestId, status: "pending", reason: "storage-failed" }]); } catch (_) {}
        }); return;
    }
    if (!this.validateFileClick(port, request, false)) { fallback("invalid-request"); return; }
    if (!this.clickHandoffs) { fallback("unavailable"); return; }
    this.checkClickDocument(port, function(valid) {
        if (!valid || !self.validateFileClick(port, request, false)) { fallback("navigation"); return; }
        self.clickHandoffs.begin({ requestId: request.requestId, url: request.url, context: self.clickContext(port) }).then(function(result) {
            if (result.error) { fallback(result.error); return; }
            if (!result.prepare) return;
            var item = new U;
            item["1"] = "GET"; item["2"] = request.url; item["3"] = request.filename || ""; item["6"] = "normal";
            item["4"] = relayHeaderValue(port["4"]); item["5"] = port["2"]; item.pageUrl = port["2"];
            var referrer = new URL(port["2"]); referrer.hash = ""; item.requestReferer = referrer.href;
            item.tabId = port.tabId; item.frameId = 0; item.clickHandoffID = request.requestId;
            self.relayWithCookies(item, function(receipt) {
                if (!receipt.accepted) self.clickHandoffs.reject(request.requestId, receipt.error || "preparation-failed").catch(function() {});
            });
        }).catch(function() { fallback("storage-failed"); });
    })
};
W.armClickFallback = function(port, request) {
    var self = this;
    function reply(ready, reason) { try { port.postMessage([29, { requestId: request && request.requestId, ready: ready, reason: reason }]); } catch (_) {} }
    if (!this.clickHandoffs || !this.validateFileClick(port, request, true)) { reply(false, "invalid-request"); return; }
    this.checkClickDocument(port, function(valid) {
        if (!valid || !self.validateFileClick(port, request, true)) { reply(false, "navigation"); return; }
        self.clickHandoffs.armFallback({ requestId: request.requestId, url: request.url, context: self.clickContext(port) }).then(function(ready) {
            reply(ready, ready ? undefined : "handoff-owned");
        }, function() { reply(false, "storage-failed"); });
    })
};
W.bindClickFallback = function(details) {
    var port = this.g[[details.tabId, details.frameId]];
    return !!(this.clickHandoffsReady && port && this.clickHandoffs.bindFallback(details, port.documentId))
};
W.$ = function(a) {
    var b = a.sender.tab;
    if (b && 0 <= b.id) {
        var c = a.sender.frameId,
            d = a.id || this.ga++,
            e = b.id;
        a.id = d;
        a["4"] = b.title;
        a.tabId = e;
        a.frameId = c;
        a.documentId = a.sender.documentId || "";
        a.ja = 0 == c;
        a["2"] = a.sender.url || a.ja && b.url || null;
        a.onMessage.addListener(this.ba.bind(this, a));
        a.onDisconnect.addListener(this.aa.bind(this, a));
        this.H[d] = a;
        this.g[[e, c]] = a;
        a.postMessage([3, a.id]);
        a.postMessage([13, this.F]);
        a.postMessage([28, { available: this.clickAvailable(a) }]);
        if (this.clickHandoffs) this.clickHandoffs.ready.then(function() { this.clickHandoffs.replay(this.clickContext(a)); }.bind(this)).catch(function() {});
        a.sender = null;
    }
};
W.ba = function(a, b) {
    switch (b[0]) {
        case 2:
            var c = b[2],
                d = b[3];
            (a = this.H[b[1]]) && c && (a["2"] = c);
            a && d && (a["4"] = d);
            break;
        case 4:
            h = b[1];
            this.publishClickAvailability();
            break;
        case 6:
            var originPort = a;
            var selection = b[6], mediaPending = selection && this.mediaDownloadPending && this.mediaDownloadPending[a.tabId];
            if (selection && (!mediaPending || mediaPending.port !== a || mediaPending.requestId !== selection.mediaRequestId ||
                mediaPending.contentKey !== selection.mediaKey)) {
                try { originPort.postMessage([25, { requestId: b[5], sent: false, error: "unavailable" }]); } catch (_) {}
                break;
            }
            c = b[1];
            a = (a = a.tabId) && this.g[[a, 0]];
            var e = new U;
            if (selection) e.relayMediaGuard = mediaPending.guard;
            e.tabId = originPort.tabId;
            e.frameId = originPort.frameId;
            e["1"] = c["1"] || "GET";
            e["2"] = c["2"];
            c["3"] && (e["3"] = c["3"]);
            e.pageUrl = b[2];
            e["4"] = b[3] || a && a["4"] || "";
            e["5"] = a && a["2"] || e.pageUrl;
            e["9"] = b[4];
            c["7"] && (e["7"] = c["7"]);
            c["8"] && (e["8"] = c["8"]);
            e["6"] = c["6"] || "media";
            !c.fEx || "vtt" != c.fEx.toLowerCase() && "srt" != c.fEx.toLowerCase() || (e["6"] = "normal");
            c.postData && (e.postData =
                c.postData);
            c["10"] && (e["10"] = c["10"]);
            c["11"] && (e["11"] = c["11"]);
            c.cookies && (e.cookies = c.cookies);
            c.requestReferer && (e.requestReferer = c.requestReferer);
            c.requestOrigin && (e.requestOrigin = c.requestOrigin);
            for (d in c) isRelayRequestHeader(d) && (e[d] = c[d]);
            var requestId = b[5], worker = this;
            this.relayWithCookies(e, function(receipt) {
                // This worker already owns the final send result. Complete the
                // popup request here so a frame closing before its UI receipt
                // cannot turn an already-written download into a false failure.
                if (selection) worker.mediaDownloadReceipt(originPort, { ...receipt, requestId: selection.mediaRequestId });
                if (requestId) { try { originPort.postMessage([25, { requestId: requestId, ...receipt }]); } catch (_) {} }
            });
            break;
        case 24:
            this.pageResolverReceipt(a, b[1]);
            break;
        case 21:
            a.mediaCount = Math.max(0, Number(b[1]) || 0);
            this.updateMediaBadge(a.tabId);
            break;
        case 22:
            // One representative item ({title, host}) so the toolbar popup can
            // name what the page offers instead of only counting it.
            a.mediaSample = b[1] && "object" == typeof b[1] ? b[1] : null;
            break;
        case 26:
            this.receiveMediaShelf(a, b[1]);
            break;
        case 27:
            this.mediaDownloadReceipt(a, b[1]);
            break;
        case 28:
            this.handleFileClick(a, b[1]);
            break;
        case 29:
            this.armClickFallback(a, b[1])
    }
};
W.aa = function(a) {
    var tabId = a.tabId;
    for (var b in this.g) this.g[b] == a && delete this.g[b];
    delete this.H[a.id];
    var pending = this.mediaDownloadPending && this.mediaDownloadPending[tabId];
    if (pending && (pending.port === a || a.ja)) pending.finish({ sent: false, error: "unavailable" });
    a.ja && delete this.resourcesByTab[tabId];
    this.updateMediaBadge(tabId)
};
W.ma = function(a, b) {
    var c = this.g;
    a = a.toString() + ",";
    for (var d in c) N(d, a) && c[d].postMessage(b)
};
W.ha = function(a) {
    var b = this.g,
        c;
    for (c in b) b[c].postMessage(a)
};
// Receipts confirm only that the top frame forwarded the request to this worker.
// Native parsing/task creation has no correlated acknowledgement in this protocol.
W.pageResolverReceipt = function(port, receipt) {
    var pending = receipt && this.pageResolverPending && this.pageResolverPending[port.tabId];
    if (pending && pending.port === port && pending.requestId === receipt.requestId) {
        pending.finish({ sent: receipt.sent === true, error: receipt.sent === true ? undefined : receipt.error || "send-failed" });
    }
};
W.resolvePage = function(message, respond) {
    var self = this, tabId = message.tabId;
    if (!Number.isInteger(tabId) || tabId < 0 || !NDMRelaySiteAdapters.currentPageURL(message.expectedPageURL)) {
        respond({ sent: false, error: "unsupported" }); return;
    }
    this.pageResolverPending ||= {};
    if (this.pageResolverPending[tabId]) { respond({ sent: false, error: "busy" }); return; }
    var pending = { requestId: (this.pageResolverSequence = (this.pageResolverSequence || 0) + 1) };
    this.pageResolverPending[tabId] = pending;
    pending.finish = function(result) {
        if (self.pageResolverPending[tabId] !== pending) return;
        delete self.pageResolverPending[tabId];
        clearTimeout(pending.timer);
        respond(result);
    };
    pending.timer = setTimeout(function() { pending.finish({ sent: false, error: "timeout" }); }, 5000);
    chrome.tabs.get(tabId, function(tab) {
        if (self.pageResolverPending[tabId] !== pending) return;
        if (chrome.runtime.lastError || !tab || tab.url !== message.expectedPageURL) {
            pending.finish({ sent: false, error: "navigation" }); return;
        }
        if (!self.D) { pending.finish({ sent: false, error: "offline" }); return; }
        pending.port = self.g[[tabId, 0]];
        if (!pending.port) { pending.finish({ sent: false, error: "unavailable" }); return; }
        try {
            pending.port.postMessage([24, { requestId: pending.requestId, expectedPageURL: tab.url }]);
        } catch (_) { pending.finish({ sent: false, error: "send-failed" }); }
    });
};
W.receiveMediaShelf = function(port, snapshot) {
    if (!snapshot || snapshot.pageURL !== port["2"] || port.mediaDocumentStale || this.g[[port.tabId, port.frameId]] !== port) return;
    var safeText = function(value, limit) { return typeof value === "string" ? value.replace(/[\r\n\0]/g, " ").slice(0, limit) : ""; };
    port.mediaPageURL = snapshot.pageURL;
    port.mediaItems = (Array.isArray(snapshot.items) ? snapshot.items : []).slice(0, 6).filter(function(item) {
        return item && typeof item.mediaKey === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(item.mediaKey) &&
            ["video", "audio", "resolver"].includes(item.kind)
    }).map(function(item) {
        return { mediaKey: String(port.id) + ":" + item.mediaKey, contentKey: item.mediaKey,
            title: safeText(item.title, 100), meta: safeText(item.meta, 160), badge: safeText(item.badge, 30),
            kind: item.kind, quality: Math.max(0, Math.min(4320, Number(item.quality) || 0)) }
    });
    port.mediaCount = port.mediaItems.length;
    if (!port.mediaCount) port.mediaSample = null;
    this.updateMediaBadge(port.tabId);
    var refresh = this.mediaShelfRefreshes && this.mediaShelfRefreshes[port.tabId];
    if (refresh && refresh.id === snapshot.refreshId) {
        refresh.remaining.delete(port);
        if (!refresh.remaining.size) refresh.finish();
    }
};
W.refreshMediaShelf = function(tabId, done) {
    this.mediaShelfRefreshes ||= {};
    var pending = this.mediaShelfRefreshes[tabId];
    if (pending) { pending.callbacks.push(done); return; }
    var self = this, ports = Object.values(this.H).filter(function(port) {
        // Include current frames without a cached snapshot. In particular a
        // parent SPA navigation can preserve the iframe and its media player.
        return port && port.tabId === tabId && self.g[[tabId, port.frameId]] === port && !port.mediaDocumentStale && Array.isArray(port.mediaItems)
    });
    if (!ports.length) { done(); return; }
    pending = { id: (this.mediaShelfRefreshSequence = (this.mediaShelfRefreshSequence || 0) + 1), remaining: new Set(ports), callbacks: [done] };
    this.mediaShelfRefreshes[tabId] = pending;
    pending.finish = function() {
        if (self.mediaShelfRefreshes[tabId] !== pending) return;
        delete self.mediaShelfRefreshes[tabId]; clearTimeout(pending.timer);
        pending.callbacks.forEach(function(callback) { callback(); });
    };
    // A busy frame must not hold the popup indefinitely. Content scripts that
    // never published protocol 26 retain their count/show-panel fallback.
    pending.timer = setTimeout(pending.finish, 250);
    ports.forEach(function(port) {
        try { port.postMessage([26, pending.id]); }
        catch (_) { pending.remaining.delete(port); }
    });
    if (!pending.remaining.size) pending.finish()
};
W.mediaShelfForTab = function(tabId) {
    var self = this, items = [];
    Object.values(this.H).filter(function(port) {
        return port && port.tabId === tabId && self.g[[tabId, port.frameId]] === port && !port.mediaDocumentStale && port.mediaPageURL === port["2"]
    }).sort(function(a, b) { return a.frameId - b.frameId; }).forEach(function(port) {
        var host = "";
        try { host = new URL(port["2"]).host; } catch (_) {}
        (port.mediaItems || []).forEach(function(item) {
            items.push({ mediaKey: item.mediaKey, title: item.title, meta: item.meta, badge: item.badge,
                kind: item.kind, quality: item.quality, frameId: port.frameId, host: host })
        });
    });
    return items.slice(0, 6)
};
W.invalidateMediaShelf = function(tabId, frameId, newDocument) {
    Object.values(this.H).forEach(function(port) {
        if (!port || port.tabId !== tabId || frameId !== 0 && port.frameId !== frameId) return;
        port.mediaItems = []; port.mediaCount = 0; port.mediaSample = null; port.mediaPageURL = "";
        if (newDocument) port.mediaDocumentStale = true;
    });
    var pending = this.mediaDownloadPending && this.mediaDownloadPending[tabId];
    if (pending && (frameId === 0 || pending.port && pending.port.frameId === frameId)) pending.finish({ sent: false, error: "navigation" });
    this.updateMediaBadge(tabId)
};
W.mediaDownloadReceipt = function(port, receipt) {
    var pending = receipt && this.mediaDownloadPending && this.mediaDownloadPending[port.tabId];
    if (!pending || pending.port !== port || pending.requestId !== receipt.requestId) return;
    // The immediate-send guard ran before socket.send. Later discovery or a
    // disconnect cannot turn a successful write into a retryable failure.
    pending.finish({ sent: receipt.sent === true,
        error: receipt.sent === true ? undefined : receipt.error || "send-failed" })
};
W.downloadMedia = function(message, respond) {
    var self = this, tabId = message.tabId;
    if (!Number.isInteger(tabId) || tabId < 0 || typeof message.mediaKey !== "string" ||
        typeof message.expectedPageURL !== "string" || !/^https?:\/\//i.test(message.expectedPageURL)) {
        respond({ sent: false, error: "unavailable" }); return;
    }
    this.mediaDownloadPending ||= {};
    if (this.mediaDownloadPending[tabId]) { respond({ sent: false, error: "busy" }); return; }
    var pending = { requestId: (this.mediaDownloadSequence = (this.mediaDownloadSequence || 0) + 1),
        deadline: Date.now() + 5500 };
    this.mediaDownloadPending[tabId] = pending;
    pending.finish = function(result) {
        if (self.mediaDownloadPending[tabId] !== pending) return;
        delete self.mediaDownloadPending[tabId]; clearTimeout(pending.timer); respond(result)
    };
    pending.guard = function() {
        if (self.mediaDownloadPending[tabId] !== pending || Date.now() >= pending.deadline) return "timeout";
        var port = pending.port;
        if (!port || self.g[[tabId, port.frameId]] !== port) return "unavailable";
        if (port.mediaDocumentStale || port["2"] !== pending.frameURL || port.mediaPageURL !== pending.frameURL) return "navigation";
        if (!(port.mediaItems || []).some(function(item) { return item.mediaKey === message.mediaKey; })) return "unavailable";
        if (!self.D || !self.G || self.G.readyState !== 1) return "offline";
        return ""
    };
    pending.timer = setTimeout(function() { pending.finish({ sent: false, error: "timeout" }); }, 6000);
    chrome.tabs.get(tabId, function(tab) {
        if (self.mediaDownloadPending[tabId] !== pending) return;
        if (chrome.runtime.lastError || !tab || tab.url !== message.expectedPageURL) {
            pending.finish({ sent: false, error: "navigation" }); return;
        }
        pending.port = Object.values(self.H).find(function(port) {
            return port && port.tabId === tabId && self.g[[tabId, port.frameId]] === port &&
                (port.mediaItems || []).some(function(item) { return item.mediaKey === message.mediaKey; })
        });
        var port = pending.port;
        if (!port) { pending.finish({ sent: false, error: "unavailable" }); return; }
        pending.frameURL = port.mediaPageURL;
        pending.contentKey = port.mediaItems.find(function(item) { return item.mediaKey === message.mediaKey; }).contentKey;
        function dispatch(frame) {
            if (self.mediaDownloadPending[tabId] !== pending) return;
            if (chrome.runtime.lastError || !frame || frame.url !== pending.frameURL ||
                port.documentId && frame.documentId !== port.documentId) {
                pending.finish({ sent: false, error: "navigation" }); return;
            }
            var error = pending.guard();
            if (error) { pending.finish({ sent: false, error: error }); return; }
            try { port.postMessage([27, { requestId: pending.requestId, mediaKey: pending.contentKey, expectedFrameURL: pending.frameURL }]); }
            catch (_) { pending.finish({ sent: false, error: "unavailable" }); }
        }
        chrome.webNavigation.getFrame({ tabId: tabId, frameId: port.frameId }, dispatch)
    })
};
var NDM_BG = new V;

// Popup contract: fresh per-tab state, catcher toggle, and media panel reveal.
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (!message || "object" != typeof message) return;
    if ("relay:downloadMedia" == message.type) {
        NDM_BG.downloadMedia(message, sendResponse);
        return true;
    }
    if ("relay:resolvePage" == message.type) {
        NDM_BG.resolvePage(message, sendResponse);
        return true;
    }
    if ("relay:getState" == message.type) {
        NDM_BG.whenSettingsReady(function() {
            NDM_BG.refreshMediaShelf(message.tabId, function() {
                var mediaCount = 0,
                    mediaSample = null;
                Object.values(NDM_BG.H).forEach(function(port) {
                    if (!port || port.tabId != message.tabId) return;
                    mediaCount += Number(port.mediaCount || 0);
                    // Top frame wins; a subframe sample only fills an empty slot.
                    if (port.mediaSample && (!mediaSample || port.ja)) mediaSample = port.mediaSample
                });
                sendResponse({
                    catcherEnabled: NDM_BG.v,
                    mediaCount: mediaCount,
                    mediaSample: mediaSample,
                    mediaItems: NDM_BG.mediaShelfForTab(message.tabId),
                    resources: NDM_BG.resourcesByTab[message.tabId] || [],
                    // Cached bridge state, so the popup can paint "connected" at once
                    // instead of flashing offline while its own probe dials.
                    connected: !!NDM_BG.D,
                    workerVersion: NDM_RELAY_RUNNING_VERSION,
                    bridgeStatus: NDM_BG.bridgeStatus
                })
            })
        });
        return !0
    }
    if ("relay:openApp" == message.type) {
        sendResponse({
            connected: NDM_BG.requestAppFocus()
        });
        return
    }
    if ("relay:toggleCatcher" == message.type) {
        NDM_BG.whenSettingsReady(function() {
            NDM_BG.toggleCatcher(
                "boolean" == typeof message.enabled ? message.enabled : void 0,
                sendResponse
            )
        });
        return !0
    }
    if ("relay:handoff" == message.type) {
        NDM_BG.handoffTabId = "number" == typeof message.tabId && 0 <= message.tabId ? message.tabId : -1;
        sendResponse({});
        return
    }
    if ("relay:downloadResource" == message.type && 0 <= message.tabId) {
        var resources = NDM_BG.resourcesByTab[message.tabId] || [],
            requestedKey = message.resourceKey,
            resource = resources.find(function(item) { return item.resourceKey == requestedKey; }),
            target = NDM_BG.g[[message.tabId, 0]] || resource && NDM_BG.g[[message.tabId, resource.frameId]];
        if (!resource || !target) { sendResponse({ sent: false, error: "unavailable" }); return; }
        NDM_BG.pageResolverPending ||= {};
        if (NDM_BG.pageResolverPending[message.tabId]) { sendResponse({ sent: false, error: "busy" }); return; }
        var pending = { requestId: (NDM_BG.pageResolverSequence = (NDM_BG.pageResolverSequence || 0) + 1), port: target };
        NDM_BG.pageResolverPending[message.tabId] = pending;
        pending.finish = function(result) {
            if (NDM_BG.pageResolverPending[message.tabId] !== pending) return;
            delete NDM_BG.pageResolverPending[message.tabId]; clearTimeout(pending.timer); sendResponse(result);
        };
        pending.timer = setTimeout(function() { pending.finish({ sent: false, error: "timeout" }); }, 5000);
        try { target.postMessage([23, resource, { requestId: pending.requestId, expectedPageURL: target["2"] }]); }
        catch (_) { pending.finish({ sent: false, error: "unavailable" }); }
        return true
    }
    "relay:showMediaPanel" == message.type && 0 <= message.tabId && (NDM_BG.ma(message.tabId, [17]), sendResponse({}))
});
