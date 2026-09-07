importScripts("media-policy.js", "resource-policy.js");

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
    // Items waiting for the bridge socket. A single slot used to drop every
    // request but the last one when NDM was still launching.
    this.pendingRelayQueue = [];
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
    for (var tabId in tabs) this.updateMediaBadge(Number(tabId))
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
        if (0 == a.frameId) {
            delete this.resourcesByTab[a.tabId];
            this.updateMediaBadge(a.tabId)
        }
        b.postMessage([11, a.url]);
        b["2"] = a.url
    }
};
W.Y = function(a) {
    var b = this.consumeDownloadURL(this.forwardedDownloadURLs, a),
        c = this.consumeDownloadURL(this.blockedDownloadURLs, a);
    !h && this.v && (b || c) && this.cancelBrowserDownload(a.id)
};
W.I = async function(a) {
    if (this.D) {
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
        a["10"] && (b += "Content-Type: " + a["10"] +
            "\r\n");
        a["11"] && (b += "Content-Disposition: " + a["11"] + "\r\n");
        a["9"] && (b += "9:" + a["9"] + "\r\n");
        for (e in a) isRelayRequestHeader(e) && (b += e + ": " + relayHeaderValue(a[e]) + "\r\n");
        "POST" == a["1"] && (a["7"] && (b += "7:" + a["7"] + "\r\n"), a["8"] && (b += "8:" + a["8"] + "\r\n"), b = a.postData ? b + ("__0NeatPostData9__:" + a.postData) : b + "Content-Length: 0\r\n");
        if (!(118784 < b.length))
            if (a["3"]) this.G.send(b), this.i = null;
            else if ("POST" == a["1"] || !this.C || a["7"] && a["8"]) "POST" != a["1"] && this.C && (b += "8:" + a["8"] + "\r\n", b += "7:" + a["7"] + "\r\n"), this.G.send(b),
            this.i = null;
        else try {
            const f = await fetch(a["2"], {
                method: "HEAD",
                credentials: "include"
            });
            f.ok && (a["8"] = a["8"] || f.headers.get("content-type") || "", a["7"] = a["7"] || f.headers.get("Content-Length") || 0, b += "8:" + a["8"] + "\r\n", b += "7:" + a["7"] + "\r\n", this.G.send(b), this.i = null)
        } catch (f) {}
    } else (20 < this.pendingRelayQueue.length && this.pendingRelayQueue.shift(), this.pendingRelayQueue.push(a), this.M())
};
W.M = function() {
    // Never stack sockets: CONNECTING/OPEN already serves the queue.
    if (this.G && (0 == this.G.readyState || 1 == this.G.readyState)) return;
    // Endpoint fallback: the host binds its configured bridge port AND the
    // legacy 10007, so if the primary drifted (custom port, restored profile),
    // the very next dial tries the other address instead of dying forever.
    var a = new WebSocket(this.bridgeEndpoints[this.bridgeEndpointIndex], "ndm.open.v1");
    a.onopen = this.fa;
    a.onclose = this.ca;
    a.onmessage = this.ea;
    a.onerror = this.da;
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
    this.D = !0;
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
    this.i = null;
    // The address we just lost failed — give the alternate a chance on the
    // next dial, whether or not clicks are waiting. With no pending intent we
    // still probe a bounded number of times so a cold worker that started
    // against a not-yet-listening host finds the bridge once it appears.
    if (this.pendingRelayQueue.length || !this.everConnected) {
        this.bridgeEndpointIndex = (this.bridgeEndpointIndex + 1) % this.bridgeEndpoints.length;
        if (this.pendingRelayQueue.length || this.coldProbes < 4) {
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
    "waiting" == a ? this.C = !0 : "nowaiting" == a ? this.C = !1 : !Q(a, "Version") && (N(a, "ShowPanelChrome") || N(a, "ShowPanelEdge")) && (a = "1" == a.split("=")[1], a != this.F && (this.F = a, chrome.storage.local.set({
        ShowMediaPanel: a ? 1 : -1
    }, function() {}), this.ha([13, a])))
};
W.da = function() {
    this.D = !1;
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
    this.I(a)
};
W.relayWithCookies = function(a) {
    if (!a) return;
    if (a.cookies) {
        this.I(a);
        return
    }
    this.i = a;
    var b = this;
    chrome.cookies.getAll({
        url: a["2"]
    }, function(c) {
        b.J(a, c)
    })
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
    !c || "ftp" != c && "http" != c && "https" != c || "ftp" == c && !F(a.linkUrl) || (c = new U, c["2"] = a.linkUrl || a.srcUrl, c.pageUrl = a.pageUrl, c["4"] = b && b.title || "", b && b.url && (c["5"] = b.url), !c["5"] && (c["5"] = a.pageUrl), this.relayWithCookies(c))
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
                tags: p
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
                                extension: b.h,
                                isAttachment: k,
                                isForceDownload: ea.test(t),
                                isMedia: u.test(b.h),
                                isStreamSegment: C.test(b.h),
                                isKnownNonDownload: fa.test(b.h),
                                isUnknownBinary: Boolean(b.h && !u.test(b.h) && !fa.test(b.h))
                            };
                            p = NDMRelayMediaPolicy.shouldInterceptNavigation(downloadMeta);
                            !p && NDMRelayMediaPolicy.shouldCancelUnexpectedBrowserDownload(downloadMeta) && d.rememberDownloadURL(d.blockedDownloadURLs, b["2"]);
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
                                this.rememberDownloadURL(this.forwardedDownloadURLs, b["2"]);
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
                                chrome.tabs.query({
                                    active: !0,
                                    currentWindow: !0
                                }, function(v) {
                                    if (v && v.length && (b["2"] == v[0].pendingUrl || b["2"] == v[0].url) && !A["5"] && v[0].openerTabId) {
                                        var w = d.g[[v[0].openerTabId, 0]];
                                        A["5"] = w && w["2"];
                                        A["4"] = w && w["4"];
                                        u.test(b.h) && (chrome.tabs.remove(v[0].id), A["6"] = "media")
                                    }
                                });
                                "POST" == A["1"] && T(b, A);
                                Y(b, A);
                                d.relayWithCookies(A)
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
        }, "POST" == a.method.toUpperCase() && (c.ka = a.requestBody), this.j[b] = c
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
        a.ja = 0 == c;
        a["2"] = a.sender.url || a.ja && b.url || null;
        a.onMessage.addListener(this.ba.bind(this, a));
        a.onDisconnect.addListener(this.aa.bind(this, a));
        this.H[d] = a;
        this.g[[e, c]] = a;
        a.postMessage([3, a.id]);
        a.postMessage([13, this.F]);
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
            break;
        case 6:
            c = b[1];
            a = (a = a.tabId) && this.g[[a, 0]];
            var e = new U;
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
            this.relayWithCookies(e)
            break;
        case 21:
            a.mediaCount = Math.max(0, Number(b[1]) || 0);
            this.updateMediaBadge(a.tabId);
            break;
        case 22:
            // One representative item ({title, host}) so the toolbar popup can
            // name what the page offers instead of only counting it.
            a.mediaSample = b[1] && "object" == typeof b[1] ? b[1] : null
    }
};
W.aa = function(a) {
    var tabId = a.tabId;
    for (var b in this.g) this.g[b] == a && delete this.g[b];
    delete this.H[a.id];
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
var NDM_BG = new V;

// Popup contract: fresh per-tab state, catcher toggle, and media panel reveal.
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (!message || "object" != typeof message) return;
    if ("relay:getState" == message.type) {
        NDM_BG.whenSettingsReady(function() {
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
                resources: NDM_BG.resourcesByTab[message.tabId] || [],
                // Cached bridge state, so the popup can paint "connected" at once
                // instead of flashing offline while its own probe dials.
                connected: !!NDM_BG.D
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
        resource && target && target.postMessage([23, resource]);
        sendResponse({ sent: !!(resource && target) });
        return
    }
    "relay:showMediaPanel" == message.type && 0 <= message.tabId && (NDM_BG.ma(message.tabId, [17]), sendResponse({}))
});
