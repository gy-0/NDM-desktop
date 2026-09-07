var y = {
        242: "240p",
        243: "360p",
        244: "480p",
        246: "480p",
        247: "720p",
        248: "1080p",
        271: "1440p",
        272: "2160p",
        278: "144p",
        302: "720p-60f",
        303: "1080p-60f",
        308: "1440p-60f",
        313: "2160p",
        315: "2160p-60f",
        335: "1080p-60f",
        336: "1440p-60f",
        337: "2160p-60f"
    },
    z = [171, 172, 249, 250, 251];

function C(d) {
    return document.getElementById(d)
}
window.el = C;

function D() {
    var d = document.location.host.toLowerCase(),
        g = d.length - 12;
    return 0 <= g && d.indexOf("facebook.com", g) == g
}
async function E(d) {
    try {
        const g = await fetch(d["2"], {
            mode: "no-cors"
        });
        if (g.ok) {
            let a = await g.text();
            (d.ba || function() {})(a)
        }
    } catch (g) {}
}

function F(d) {
    var g = 0,
        a;
    var b = 0;
    for (a = d.length; b < a; b++) {
        var c = d.charCodeAt(b);
        g = (g << 5) - g + c;
        g |= 0
    }
    return g
}

function G(d) {
    return !d || 0 > d ? " " : 1E3 > d ? d + " Bytes" : 1E6 > d ? (d / 1024).toFixed(1) + " KB" : 1E9 > d ? (d / 1048576).toFixed(2) + " MB" : (d / 1073741824).toFixed(3) + " GB"
}

function H(d) {
    return d.replace(/\\u([\d\w]{4})/gi, function(g, a) {
        return String.fromCharCode(parseInt(a, 16))
    })
}

function I(d) {
    if (!d) return {
        left: 0,
        top: 0
    };
    try {
        var g = d.getBoundingClientRect();
        return g ? {
            left: Math.round(g.left + window.pageXOffset),
            top: Math.round(g.top + window.pageYOffset),
            right: Math.round(g.right + window.pageXOffset),
            bottom: Math.round(g.bottom + window.pageYOffset),
            width: Math.round(g.width),
            height: Math.round(g.height)
        } : {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0
        }
    } catch (a) {
        return {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0
        }
    }
}

function M(d) {
    return d ? !d.fEx || "VTT" != d.fEx.toUpperCase() && "SRT" != d.fEx.toUpperCase() ? d["4"] || (d.fEx.toUpperCase() || "MP4") + " File  " + (G(d.fS) || d.fDu) : d.fEx.toUpperCase() + " Subtitles File " + (d.fS ? G(d.fS) : " ") : "Media File"
}

var NDMRelayPolicy = globalThis.NDMRelayMediaPolicy;

function NDMRelayText(zh, en) {
    return String(navigator.language || "").toLowerCase().indexOf("zh") === 0 ? zh : en
}

function NDMRelayIcon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 18 18");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (name === "close") {
        svg.innerHTML = '<path d="M5 5l8 8M13 5l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    } else if (name === "chevron") {
        svg.innerHTML = '<path d="m5.5 7 3.5 3.5L12.5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
    } else if (name === "download") {
        svg.innerHTML = '<path d="M9 3.5v7m0 0 2.5-2.5M9 10.5 6.5 8M4 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
    } else if (name === "audio") {
        svg.innerHTML = '<path d="M7.5 12.2V5.1l5-1v6.1M7.5 12.2c0 1-1 1.8-2.2 1.8S3 13.4 3 12.5s1-1.7 2.3-1.7c.9 0 1.7.3 2.2.8m5-1.4c0 1-1 1.8-2.2 1.8S8 11.4 8 10.5s1-1.7 2.3-1.7c.9 0 1.7.3 2.2.8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>'
    } else if (name === "brand") {
        svg.innerHTML = '<path d="M4.5 13.5v-9l9 9v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    } else if (name === "resolver") {
        svg.innerHTML = '<path d="M9 2.8 10.1 6l3.1 1.1-3.1 1.1L9 11.4 7.9 8.2 4.8 7.1 7.9 6 9 2.8Z" fill="currentColor"/><path d="m13.5 11 .55 1.55 1.45.55-1.45.55-.55 1.55-.55-1.55-1.45-.55 1.45-.55.55-1.55Z" fill="currentColor"/>'
    } else {
        svg.innerHTML = '<rect x="3" y="4" width="12" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m8 7 4 2-4 2Z" fill="currentColor"/>'
    }
    return svg
}

function NDMRelayFloatCSS() {
    return [
        ":host{all:initial;--ndm-ink:#191b21;--ndm-muted:#676b76;--ndm-faint:#8b8f98;--ndm-surface:#fff;--ndm-subtle:#f4f5f7;--ndm-hover:#eef0f4;--ndm-line:rgba(25,27,33,.08);--ndm-accent:#7168d5;--ndm-accent-ink:#584fb8;--ndm-accent-soft:rgba(113,104,213,.10);--ndm-accent-hover:rgba(113,104,213,.15);--ndm-on-accent:#fff;--ndm-shadow:0 24px 64px rgba(20,23,31,.16),0 6px 18px rgba(20,23,31,.08),0 0 0 1px rgba(20,23,31,.06);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color-scheme:light dark}",
        "@media(prefers-color-scheme:dark){:host{--ndm-ink:#f6f7fb;--ndm-muted:#a8abb5;--ndm-faint:#858995;--ndm-surface:#1e2026;--ndm-subtle:#282b33;--ndm-hover:#30343e;--ndm-line:rgba(255,255,255,.09);--ndm-accent:#b2acff;--ndm-accent-ink:#d0cbff;--ndm-accent-soft:rgba(170,163,255,.14);--ndm-accent-hover:rgba(170,163,255,.19);--ndm-on-accent:#171922;--ndm-shadow:0 28px 72px rgba(0,0,0,.46),0 6px 20px rgba(0,0,0,.26),0 0 0 1px rgba(255,255,255,.1)}}",
        "*{box-sizing:border-box}",
        "[hidden]{display:none!important}",
        "button,h2{all:unset;box-sizing:border-box}",
        ".ndm-shell{display:flex;align-items:flex-start;color:var(--ndm-ink);font-family:inherit}",
        ".ndm-launcher{position:relative;display:grid;place-items:center;width:32px;height:32px;padding:0;border-radius:10px;background:color-mix(in srgb,var(--ndm-surface) 70%,transparent);box-shadow:0 6px 18px rgba(20,23,31,.12),0 0 0 1px color-mix(in srgb,var(--ndm-line) 80%,transparent);cursor:pointer;touch-action:manipulation;user-select:none;transition:background-color .14s ease,scale .12s cubic-bezier(.2,0,0,1),box-shadow .14s ease}",
        ".ndm-launcher::after{content:'';position:absolute;inset:-2px 0}",
        ".ndm-launcher:hover{background:color-mix(in srgb,var(--ndm-surface) 88%,transparent);box-shadow:0 8px 22px rgba(20,23,31,.15),0 0 0 1px var(--ndm-line)}",
        ".ndm-launcher:active{scale:.96}",
        ".ndm-launcher:focus-visible,.ndm-close:focus-visible,.ndm-media-item:focus-visible,.ndm-alternatives:focus-visible{outline:2px solid var(--ndm-accent);outline-offset:3px}",
        ".ndm-brand-mark{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:8px;background:var(--ndm-accent);color:var(--ndm-on-accent);box-shadow:0 4px 12px rgba(113,104,213,.22)}",
        ".ndm-launcher .ndm-brand-mark{width:22px;height:22px;border-radius:7px;background:var(--ndm-accent-soft);color:var(--ndm-accent);box-shadow:none}",
        ".ndm-launcher-label,.ndm-launcher-count{display:none}",
        ".ndm-brand-mark svg{width:16px;height:16px}",
        ".ndm-launcher-label{font-size:12px;line-height:1;font-weight:670;letter-spacing:-.015em}",
        ".ndm-launcher-count{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 5px;border-radius:7px;background:var(--ndm-accent-soft);color:var(--ndm-accent-ink);font-size:10px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums}",
        ".ndm-launcher-label,.ndm-launcher-count{display:none}",
        ".ndm-surface{width:min(320px,calc(100vw - 24px));padding:7px;border-radius:16px;background:var(--ndm-surface);box-shadow:var(--ndm-shadow);transform-origin:top right}",
        ".ndm-header{display:grid;grid-template-columns:32px minmax(0,1fr) 32px;align-items:center;gap:10px;padding:6px 4px 12px 8px}",
        ".ndm-header .ndm-brand-mark{width:32px;height:32px;border-radius:10px}",
        ".ndm-header .ndm-brand-mark svg{width:19px;height:19px}",
        ".ndm-heading{min-width:0}",
        ".ndm-title{display:block;font-size:14.5px;line-height:1.25;font-weight:700;letter-spacing:-.025em;color:var(--ndm-ink);text-wrap:balance}",
        ".ndm-summary{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;font-size:11px;line-height:1.35;color:var(--ndm-muted);font-variant-numeric:tabular-nums}",
        ".ndm-close{position:relative;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:10px;color:var(--ndm-muted);cursor:pointer;touch-action:manipulation;transition:background-color .14s ease,color .14s ease,scale .12s cubic-bezier(.2,0,0,1)}",
        ".ndm-close::after{content:'';position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%)}",
        ".ndm-close:hover{background:var(--ndm-hover);color:var(--ndm-ink)}",
        ".ndm-close:active{scale:.96}",
        ".ndm-close svg{width:18px;height:18px}",
        ".ndm-list{display:flex;flex-direction:column;max-height:min(360px,calc(100vh - 112px));overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ndm-line) transparent}",
        ".ndm-media-item{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:11px;width:100%;min-height:62px;padding:9px;border-radius:12px;color:var(--ndm-ink);cursor:pointer;touch-action:manipulation;text-align:start;transition:background-color .14s ease,scale .12s cubic-bezier(.2,0,0,1),box-shadow .14s ease}",
        ".ndm-media-item:hover{background:var(--ndm-hover)}",
        ".ndm-media-item:active{scale:.96}",
        ".ndm-media-item.is-recommended{background:var(--ndm-accent-soft);box-shadow:inset 0 0 0 1px rgba(113,104,213,.11)}",
        ".ndm-media-item.is-recommended:hover{background:var(--ndm-accent-hover)}",
        ".ndm-item-icon{display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:11px;background:var(--ndm-surface);color:var(--ndm-muted);box-shadow:0 0 0 1px var(--ndm-line),0 1px 2px rgba(20,23,31,.04)}",
        ".ndm-media-item.is-recommended .ndm-item-icon{background:var(--ndm-accent);color:var(--ndm-on-accent);box-shadow:0 5px 14px rgba(113,104,213,.22)}",
        ".ndm-item-icon svg{width:18px;height:18px}",
        ".ndm-quality{display:flex;align-items:baseline;color:var(--ndm-ink);font-size:10.5px;line-height:1;font-weight:720;letter-spacing:-.025em;font-variant-numeric:tabular-nums}",
        ".ndm-quality small{margin-inline-start:1px;color:var(--ndm-faint);font-size:7px;line-height:1;font-weight:650}",
        ".ndm-item-copy{min-width:0}",
        ".ndm-item-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.3;font-weight:670;letter-spacing:-.012em}",
        ".ndm-item-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;color:var(--ndm-muted);font-size:11px;line-height:1.35;font-weight:450;font-variant-numeric:tabular-nums}",
        ".ndm-item-end{display:flex;align-items:center;gap:6px;color:var(--ndm-muted)}",
        ".ndm-item-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:7px;background:var(--ndm-surface);color:var(--ndm-accent-ink);box-shadow:0 0 0 1px rgba(113,104,213,.13);font-size:9.5px;line-height:1;font-weight:700;white-space:nowrap}",
        ".ndm-item-action{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9px}",
        ".ndm-item-action svg{width:18px;height:18px}",
        ".ndm-media-item:hover .ndm-item-action{color:var(--ndm-ink)}",
        ".ndm-alternatives{display:flex;align-items:center;justify-content:space-between;width:100%;height:40px;margin-top:3px;padding:0 10px;border-radius:11px;color:var(--ndm-muted);cursor:pointer;touch-action:manipulation;font-size:11.5px;line-height:1.3;font-weight:580;transition:background-color .14s ease,color .14s ease,scale .12s cubic-bezier(.2,0,0,1)}",
        ".ndm-alternatives:hover{background:var(--ndm-hover);color:var(--ndm-ink)}",
        ".ndm-alternatives:active{scale:.96}",
        ".ndm-alternatives svg{width:18px;height:18px;transition:transform .16s cubic-bezier(.2,0,0,1)}",
        ".ndm-alternatives[aria-expanded=true] svg{transform:rotate(180deg)}",
        "@media(max-width:380px){.ndm-surface{width:calc(100vw - 24px)}.ndm-item-badge{display:none}.ndm-header{grid-template-columns:30px minmax(0,1fr) 32px;gap:9px;padding-inline-start:7px}.ndm-header .ndm-brand-mark{width:30px;height:30px}.ndm-media-item{grid-template-columns:36px minmax(0,1fr) auto;gap:9px;padding-inline:8px}.ndm-item-icon{width:36px;height:36px}}",
        "@media(prefers-contrast:more){:host{--ndm-muted:var(--ndm-ink);--ndm-accent-soft:rgba(113,104,213,.17)}.ndm-media-item.is-recommended{box-shadow:inset 0 0 0 2px var(--ndm-accent)}}",
        "@media(prefers-reduced-motion:reduce){.ndm-launcher,.ndm-close,.ndm-media-item,.ndm-alternatives,.ndm-alternatives svg{transition:none}}"
    ].join("")
}

function N(d, g, a) {
    this.D = d;
    d.i[a] = this;
    this.ua = a;
    this.h = null;
    this.badge = null;
    this.badgeLabel = null;
    this.count = null;
    this.summary = null;
    this.closeButton = null;
    this.pointerOpening = !1;
    this.p = null;
    this.panel = null;
    this.m = g;
    this.j = null;
    this.hover = !1;
    this.focusWithin = !1;
    this.anchor = null;
    this.position = {
        left: 0,
        top: 0
    };
    this.toolbarPinned = !1;
    this.items = [];
    this.visibleItems = [];
    this.showAlternatives = !1;
    this.listeners = [];
    this.visibilityObserver = null
}
var O = N.prototype;
O.G = function(d) {
    var g = Array.prototype.slice.call(arguments);
    g[2] = g[2].bind(this);
    this.listeners.push(g.slice(0));
    d.addEventListener.apply(d, g.slice(1))
};
O.mediaIsVisible = function() {
    if (!this.m) return true;
    if (!this.m.isConnected) return false;
    var rect = this.m.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (var node = this.m; node && node.nodeType === 1; node = node.parentElement) {
        var style = window.getComputedStyle(node);
        if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true
};
O.syncVisibility = function() {
    if (!this.h) return false;
    var visible = this.visibleItems.length > 0 && this.D.H && !this.siteHasInlineUI() && this.mediaIsVisible();
    if (visible && this.h.style.display === "none") this.h.style.pointerEvents = "";
    this.h.style.display = visible ? "" : "none";
    visible ? this.h.removeAttribute("aria-hidden") : this.h.setAttribute("aria-hidden", "true");
    return visible
};
O.dispose = function() {
    this.j && clearTimeout(this.j);
    this.visibilityObserver && this.visibilityObserver.disconnect();
    this.listeners.forEach(function(args) { args[0].removeEventListener.apply(args[0], args.slice(1)) });
    this.listeners = [];
    this.h && this.h.remove()
};
O.v = function() {
    if (!this.h || !this.syncVisibility()) return;
    var fixed = this.h.style.position === "fixed";
    var viewportLeft = fixed ? 0 : window.pageXOffset;
    var viewportTop = fixed ? 0 : window.pageYOffset;
    var activeSurface = this.p && !this.p.hidden ? this.p : this.badge;
    var rect = activeSurface && activeSurface.getBoundingClientRect ? activeSurface.getBoundingClientRect() : null;
    var width = rect && rect.width || 84;
    var height = rect && rect.height || 36;
    var anchor = !this.toolbarPinned && this.anchor;
    var desiredLeft = anchor ? anchor.right - width - 12 : viewportLeft + window.innerWidth - width - 16;
    var desiredTop = anchor ? anchor.top + 12 : viewportTop + 16;
    var maxLeft = Math.max(viewportLeft + 12, viewportLeft + window.innerWidth - width - 12);
    var maxTop = Math.max(viewportTop + 12, viewportTop + window.innerHeight - height - 12);
    this.h.style.left = Math.round(Math.min(maxLeft, Math.max(viewportLeft + 12, desiredLeft))) + "px";
    this.h.style.top = Math.round(Math.min(maxTop, Math.max(viewportTop + 12, desiredTop))) + "px"
};
O.Y = function(d) {
    this.K(!0);
    this.D.oa(this.visibleItems[d])
};
O.setExpanded = function(expanded) {
    if (!this.p || !this.badge) return;
    var active = this.h && this.h.shadowRoot ? this.h.shadowRoot.activeElement : document.activeElement;
    var focusCameFromLauncher = active === this.badge;
    var focusWasInside = active && this.p.contains(active);
    this.p.hidden = !expanded;
    this.badge.hidden = expanded;
    this.v();
    var g = this;
    if (expanded && focusCameFromLauncher && !this.pointerOpening) requestAnimationFrame(function() {
        var first = g.panel && g.panel.querySelector("button");
        (first || g.closeButton) && (first || g.closeButton).focus()
    });
    if (!expanded && focusWasInside) requestAnimationFrame(function() {
        g.badge && g.badge.focus()
    })
};
O.K = function(d) {
    if (!this.p) return;
    this.setExpanded(d ? !1 : this.p.hidden)
};
O.siteHasInlineUI = function() {
    if (!globalThis.NDMRelaySiteAdapters) return false;
    var href = window.location.href;
    // Page-level adapters: suppress the float as soon as we are on a known
    // video URL. Waiting for the inject to land was too late — media sniffs
    // already mounted overlays during Bilibili/YouTube boot.
    if (NDMRelaySiteAdapters.prefersInlineUI(href)) return true;
    return Boolean(NDMRelaySiteAdapters.siteForURL(href) &&
        NDMRelaySiteAdapters.hasInlineAction(this.m, href));
};
O.show = function(d) {
    if (!this.h) return;
    // Adapted sites (Bilibili/YouTube/…) use the in-page button. Never resurrect
    // the floating strip once that native action is present.
    if (!this.syncVisibility()) {
        this.h.style.display = "none";
        this.h.setAttribute("aria-hidden", "true");
        this.h.style.pointerEvents = "none";
        return;
    }
    this.h.style.display = this.D.H ? "" : "none";
    this.h.removeAttribute("aria-hidden");
    this.h.style.opacity = 1;
    this.h.style.pointerEvents = "";
    this.j && (clearTimeout(this.j), this.j = null);
    if (d) {
        this.setExpanded(!0);
        return
    }
    this.hover || this.focusWithin || this.fade(3200)
};
O.fade = function(delay) {
    var g = this;
    this.j && clearTimeout(this.j);
    this.j = setTimeout(function() {
        g.j = null;
        g.h && g.p && g.p.hidden && !g.hover && !g.focusWithin && (g.h.style.opacity = 0, g.h.style.pointerEvents = "none")
    }, delay || 3200)
};
O.wake = function() {
    this.hover || !this.h || this.show(!1)
};
O.I = function(d) {
    var g = this,
        e = this.D.N(this.visibleItems[d]),
        b = NDMRelayPolicy ? NDMRelayPolicy.describeCandidate(e, {
            locale: navigator.language,
            recommended: 0 == d
        }) : M(e),
        presentation = NDMRelayPolicy && NDMRelayPolicy.candidatePresentation ? NDMRelayPolicy.candidatePresentation(e, {
            locale: navigator.language,
            recommended: 0 == d
        }) : {
            title: b,
            meta: "",
            badge: 0 == d ? NDMRelayText("首选", "Best choice") : "",
            kind: "video",
            quality: 0
        },
        a = document.createElement("BUTTON");
    a.type = "button";
    a.className = "ndm-media-item" + (0 == d ? " is-recommended" : "");
    a.title = b.trim();
    a.setAttribute("aria-label", (presentation.kind === "resolver" ? NDMRelayText("打开：", "Open: ") : NDMRelayText("下载：", "Download: ")) + b.trim());
    var icon = document.createElement("SPAN");
    icon.className = "ndm-item-icon";
    if (presentation.quality) {
        var quality = document.createElement("SPAN");
        quality.className = "ndm-quality";
        quality.textContent = presentation.quality;
        var qualityUnit = document.createElement("SMALL");
        qualityUnit.textContent = "p";
        quality.appendChild(qualityUnit);
        icon.appendChild(quality)
    } else {
        icon.appendChild(NDMRelayIcon(presentation.kind === "audio" ? "audio" : presentation.kind === "resolver" ? "resolver" : "media"))
    }
    var copy = document.createElement("SPAN");
    copy.className = "ndm-item-copy";
    var title = document.createElement("SPAN");
    title.className = "ndm-item-title";
    title.textContent = presentation.title;
    var meta = document.createElement("SPAN");
    meta.className = "ndm-item-meta";
    meta.textContent = presentation.meta;
    copy.appendChild(title);
    copy.appendChild(meta);
    var end = document.createElement("SPAN");
    end.className = "ndm-item-end";
    if (presentation.badge) {
        var badge = document.createElement("SPAN");
        badge.className = "ndm-item-badge";
        badge.textContent = presentation.badge;
        end.appendChild(badge)
    }
    var action = document.createElement("SPAN");
    action.className = "ndm-item-action";
    action.appendChild(NDMRelayIcon("download"));
    end.appendChild(action);
    a.appendChild(icon);
    a.appendChild(copy);
    a.appendChild(end);
    a.onclick = function(e) {
        e.stopPropagation();
        e.preventDefault();
        g.Y(d)
    };
    this.panel.appendChild(a)
};
O.render = function() {
    if (!this.panel || !this.h) return;
    var d = this,
        raw = this.items.map(function(g) {
            return d.D.N(g)
        }).filter(Boolean),
        visible = NDMRelayPolicy ? NDMRelayPolicy.compactCandidates(raw, 6) : raw,
        allItemIds = visible.map(function(g) {
            return g.id
        });
    this.visibleItems = this.showAlternatives ? allItemIds : allItemIds.slice(0, 1);
    this.panel.replaceChildren();
    for (var g = 0; g < this.visibleItems.length; g++) this.I(g);
    var a = allItemIds.length;
    if (1 < a) {
        var e = this,
            more = document.createElement("BUTTON");
        more.type = "button";
        more.className = "ndm-alternatives";
        var moreLabel = document.createElement("SPAN");
        moreLabel.textContent = this.showAlternatives ? NDMRelayText("收起其他版本", "Hide other versions") : NDMRelayText("显示其他 " + (a - 1) + " 个版本", "Show " + (a - 1) + " more versions");
        more.appendChild(moreLabel);
        more.appendChild(NDMRelayIcon("chevron"));
        more.setAttribute("aria-expanded", this.showAlternatives ? "true" : "false");
        more.onclick = function(f) {
            f.stopPropagation();
            var keyboardActivation = 0 === f.detail;
            e.showAlternatives = !e.showAlternatives;
            e.render();
            e.show(!0);
            keyboardActivation && requestAnimationFrame(function() {
                var replacement = e.panel && e.panel.querySelector(".ndm-alternatives");
                replacement && replacement.focus()
            })
        };
        this.panel.appendChild(more)
    }
    this.count.innerText = a;
    this.count.style.display = 1 < a ? "" : "none";
    this.summary.textContent = NDMRelayText(a + " 个版本 · 首选项已置顶", a + (1 == a ? " version" : " versions") + " · Best option first");
    this.badge.setAttribute("aria-label", NDMRelayText("打开 NDM 下载选项，共 " + a + " 个版本", "Open NDM downloads, " + a + (1 == a ? " version" : " versions")));
    // Pass the media element so X/Instagram can scope to the nearby article;
    // page-level adapters (YouTube/Bilibili/…) query document for the inject.
    var siteHasInlineUI = this.siteHasInlineUI();
    var shouldFloat = a && this.D.H && !siteHasInlineUI && this.mediaIsVisible();
    this.h.style.display = shouldFloat ? "" : "none";
    shouldFloat ? this.h.removeAttribute("aria-hidden") : this.h.setAttribute("aria-hidden", "true");
    this.h.style.pointerEvents = shouldFloat ? "" : "none";
    this.D.updateMediaCount();
    this.v()
};
O.L = function(d) {
    var g = this,
        a = this.D.N(d),
        b = null,
        c = this.m ? "absolute" : "fixed";
    this.m && (b = I(this.m));
    b && (this.anchor = b, this.position = {
        left: Math.max(0, b.left + 8),
        top: Math.max(0, b.top + 8)
    });
    this.m || (this.anchor = null, this.position = {
        left: Math.max(0, window.pageXOffset + window.innerWidth - 100),
        top: Math.max(0, window.pageYOffset + 16)
    });
    if (this.h) this.v();
    else {
        this.h = document.createElement("DIV");
        this.h.style.cssText = "padding:0;margin:0;position:" + c + ";z-index:2147483646;left:" + this.position.left + "px;top:" + this.position.top + "px;direction:ltr;opacity:1;transition:opacity .24s ease-out";
        this.h.id = "neatDiv" + this.ua;
        this.h.style.display = this.D.H ? "" : "none";
        var shadow = this.h.attachShadow ? this.h.attachShadow({ mode: "open" }) : this.h;
        var style = document.createElement("STYLE");
        style.textContent = NDMRelayFloatCSS();
        shadow.appendChild(style);
        var shell = document.createElement("DIV");
        shell.className = "ndm-shell";
        shadow.appendChild(shell);
        this.badge = document.createElement("BUTTON");
        this.badge.type = "button";
        this.badge.className = "ndm-launcher";
        this.badge.setAttribute("aria-label", NDMRelayText("显示视频下载选项", "Show video download options"));
        var e = document.createElement("SPAN");
        e.className = "ndm-brand-mark";
        e.setAttribute("aria-hidden", "true");
        e.appendChild(NDMRelayIcon("brand"));
        this.badge.appendChild(e);
        this.badgeLabel = document.createElement("SPAN");
        this.badgeLabel.innerText = "NDM";
        this.badgeLabel.className = "ndm-launcher-label";
        this.badge.appendChild(this.badgeLabel);
        this.count = document.createElement("SPAN");
        this.count.className = "ndm-launcher-count";
        this.count.style.display = "none";
        this.badge.appendChild(this.count);
        this.badge.addEventListener("pointerdown", function() {
            g.pointerOpening = !0
        });
        this.badge.addEventListener("pointercancel", function() {
            g.pointerOpening = !1
        });
        this.badge.addEventListener("pointerleave", function() {
            g.pointerOpening = !1
        });
        this.badge.onclick = function(f) {
            f.stopPropagation();
            g.show(!0);
            g.pointerOpening = !1
        };
        shell.appendChild(this.badge);
        this.p = document.createElement("SECTION");
        this.p.className = "ndm-surface";
        this.p.hidden = !0;
        this.p.setAttribute("role", "dialog");
        var titleId = "ndm-relay-title-" + this.ua;
        var summaryId = "ndm-relay-summary-" + this.ua;
        this.p.setAttribute("aria-labelledby", titleId);
        this.p.setAttribute("aria-describedby", summaryId);
        var header = document.createElement("DIV");
        header.className = "ndm-header";
        var headerMark = document.createElement("SPAN");
        headerMark.className = "ndm-brand-mark";
        headerMark.setAttribute("aria-hidden", "true");
        headerMark.appendChild(NDMRelayIcon("brand"));
        header.appendChild(headerMark);
        var heading = document.createElement("DIV");
        heading.className = "ndm-heading";
        var panelTitle = document.createElement("H2");
        panelTitle.id = titleId;
        panelTitle.className = "ndm-title";
        panelTitle.textContent = NDMRelayText("选择下载版本", "Choose a download");
        this.summary = document.createElement("DIV");
        this.summary.id = summaryId;
        this.summary.className = "ndm-summary";
        heading.appendChild(panelTitle);
        heading.appendChild(this.summary);
        header.appendChild(heading);
        var cls = document.createElement("BUTTON");
        cls.type = "button";
        cls.className = "ndm-close";
        this.closeButton = cls;
        cls.setAttribute("aria-label", NDMRelayText("收起下载面板", "Minimize downloads"));
        cls.appendChild(NDMRelayIcon("close"));
        header.appendChild(cls);
        this.p.appendChild(header);
        this.panel = document.createElement("DIV");
        this.panel.className = "ndm-list";
        this.p.appendChild(this.panel);
        cls.onclick = function(ev) {
            ev.stopPropagation();
            g.K(!0);
            g.h.style.opacity = 1;
            g.h.style.pointerEvents = ""
        };
        this.p.addEventListener("keydown", function(ev) {
            if (ev.key !== "Escape") return;
            ev.preventDefault();
            ev.stopPropagation();
            g.K(!0)
        });
        shell.appendChild(this.p);
        this.h.addEventListener("mouseenter", function() {
            g.hover = !0;
            g.j && (clearTimeout(g.j), g.j = null);
            g.h.style.opacity = 1
        });
        this.h.addEventListener("mouseleave", function() {
            g.hover = !1;
            g.p && g.p.hidden && g.fade(2400)
        });
        this.h.addEventListener("focusin", function() {
            g.focusWithin = !0;
            g.j && (clearTimeout(g.j), g.j = null);
            g.h.style.opacity = 1;
            g.h.style.pointerEvents = ""
        });
        this.h.addEventListener("focusout", function(ev) {
            var next = ev.relatedTarget;
            if (next && g.h.contains(next)) return;
            g.focusWithin = !1;
            g.p && g.p.hidden && g.fade(3200)
        });
        this.m && this.G(this.m, "mousemove", this.wake);
        if (this.m && window.MutationObserver) {
            // Watch only this player's ancestry, never the entire document subtree.
            // Hiding a tab/panel must also hide its separately mounted download UI.
            this.visibilityObserver = new MutationObserver(function() { g.v() });
            for (var ancestor = this.m; ancestor; ancestor = ancestor.parentElement) {
                this.visibilityObserver.observe(ancestor, {
                    attributes: true, attributeFilter: ["class", "style", "hidden"], childList: true
                })
            }
        }
        document.body.appendChild(this.h);
        this.fade(3200)
    }
    if (-1 < this.items.indexOf(d)) return;
    this.items.push(d);
    this.D.ensurePageResolver(this);
    this.render()
};
if (!window.o) {
    var P = function() {
        this.ea = null;
        this.A = {};
        this.i = {};
        this.g = [];
        this.P = !1;
        this.$ = this.Z = -1;
        this.Counter = 1;
        this.l = null;
        this.H = !0;
        this.ja = [];
        this.portRetries = 0;
        this.ga = Math.ceil(2E6 * Math.random());
        this.connectPort();
        if (D()) {
            var a = this;
            this.sa = new window.MutationObserver(function(b) {
                b.forEach(function(c) {
                    a.pa(c.target)
                })
            });
            this.sa.observe(document, {
                childList: !0,
                subtree: !0
            })
        }
        this.o(window,
            "keydown", this.W, !0);
        this.o(window, "keyup", this.W, !0);
        this.o(window, "mouseup", this.T, !0);
        this.o(window, "resize", this.ta);
        this.o(document, "DOMContentLoaded", this.da);
        this.o(document, "click", this.ra);
        this.siteAdapters = null;
        if (window.top === window && globalThis.NDMRelaySiteAdapters) {
            try {
                this.siteAdapters = NDMRelaySiteAdapters.install({
                    onDownload: this.downloadSitePage.bind(this),
                    onActionReady: this.refreshSitePanels.bind(this)
                })
            } catch (a) {
                this.siteAdapters = null
            }
        }
    };
    window.o = !0;
    O = P.prototype;
    O.qa = function(a, b) {
        b.hd && this.B({
            id: F(b.hd),
            1: "GET",
            2: b.hd,
            fEx: "mp4",
            4: " MP4 File HQ"
        }, window.location.href, a, !1);
        b.sd && this.B({
            id: F(b.sd),
            1: "GET",
            2: b.sd,
            fEx: "mp4",
            4: " MP4 File LQ"
        }, window.location.href, a, !1)
    };
    O.la = function(a) {
        for (;
            (a = a.parentElement) && 1 > a.querySelectorAll("video").length;);
        if (a) return a.querySelectorAll("video")[0]
    };
    O.ia = function(a, b) {
        var c = this;
        E({
            2: "https://www.facebook.com/video/embed?video_id=" + b,
            ba: function(f) {
                var e = /"sd_src_no_ratelimit":"(.*?)"/.exec(f),
                    h = /"hd_src_no_ratelimit":"(.*?)"/.exec(f);
                e && e.length || (e = /"sd_src":"(.*?)"/.exec(f));
                h && h.length || (h = /"hd_src":"(.*?)"/.exec(f));
                f = {
                    sd: e && e.length ? e[1].replace(/\\/g, "") : "",
                    hd: h && h.length ? h[1].replace(/\\/g, "") : ""
                };
                e = c.la(a);
                void 0 !== e && c.qa(e, f)
            }
        })
    };
    O.pa = function(a) {
        var b = this;
        a = a.querySelectorAll('a[href*="/videos/"]');
        a.length && Array.from(a, function(c) {
            if (!c.getAttribute("NEAT_DM")) {
                c.setAttribute("NEAT_DM", 1);
                var f = c.href.match(/.*\/videos\/(\d+)\/.*/i);
                f && b.ia(c, f[1])
            }
        })
    };
    O.N = function(a) {
        return this.A[a]
    };
    O.refreshSitePanels = function() {
        for (var a in this.i) {
            if (this.i[a] && this.i[a].render) this.i[a].render()
        }
    };
    O.updateMediaCount = function() {
        // Do not badge adapted tabs where the in-page action already owns download.
        var count = 0,
            ids = [];
        for (var key in this.i) {
            var panel = this.i[key];
            if (!panel || !panel.items || !panel.items.length) continue;
            if (panel.siteHasInlineUI && panel.siteHasInlineUI()) continue;
            count += panel.items.length;
            ids = ids.concat(panel.items)
        }
        this.port.postMessage([21, Math.min(99, count)]);
        // A representative item lets the toolbar popup say what the page holds
        // rather than only how many things it found. Prefer the document title:
        // the best-scoring candidate is usually the page resolver, whose label
        // is generic UI copy ("推荐 · 选择画质并下载"), not the video's name — so
        // only fall back to item labels on the rare untitled document.
        var label = count ? this.getTitle() || this.bestItemLabel(ids) : "";
        this.port.postMessage([22, label ? {
            title: label.slice(0, 120),
            host: window.location.host || ""
        } : null])
    };
    O.bestItemLabel = function(ids) {
        var best = "",
            bestScore = -Infinity,
            d = this;
        (ids || []).forEach(function(id) {
            var item = d.N(id);
            if (!item || !item["4"]) return;
            var score = NDMRelayPolicy ? NDMRelayPolicy.candidateScore(item) : 0;
            if (score > bestScore) bestScore = score, best = String(item["4"])
        });
        return best
    };
    O.resolveCurrentPage = function(request) {
        var result = { requestId: request && request.requestId, sent: false };
        var current = window.location.href;
        if (!request || request.expectedPageURL !== current) result.error = "navigation";
        else {
            var url = NDMRelaySiteAdapters.currentPageURL(current);
            if (!url) result.error = "unsupported";
            else try {
                this.downloadSitePage({ url: url });
                result.sent = true;
            } catch (_) { result.error = "send-failed"; }
        }
        try { this.port.postMessage([24, result]); } catch (_) { /* Worker timeout reports disconnect. */ }
    };
    O.downloadSitePage = function(a) {
        if (!a || !a.url) return;
        var b = {
            id: F("NDMRelaySite:" + a.url),
            1: "GET",
            2: a.url,
            6: "media-page",
            fEx: "mp4",
            4: a.label || NDMRelayText("使用 NDM 下载", "Download with NDM"),
            betterPageResolver: !0
        };
        this.A[b.id] = b;
        this.oa(b.id)
    };
    O.downloadResource = function(a) {
        if (!a || !a["2"]) return;
        // Shelf rows are ordinary files. Keep the item URL in field 2 and mark
        // ltype normal so the Mac host does not rewrite it to the tab's video
        // page (the previous bug turned web.txt / .dmg clicks into yt-dlp probes).
        var item = {};
        for (var key in a) {
            if (Object.prototype.hasOwnProperty.call(a, key)) item[key] = a[key]
        }
        var b = item.id || F(item.resourceKey || item["2"]);
        item.id = b;
        item["6"] = "normal";
        item.betterPageResolver = !1;
        this.A[b] = item;
        this.oa(b)
    };
    O.socialVideoPageURL = function(a) {
        var b = String(window.location.hostname || "").toLowerCase();
        if (!(b == "x.com" || b.endsWith(".x.com") || b == "twitter.com" || b.endsWith(".twitter.com"))) return "";

        function c(f) {
            var e = String(f || "").match(/^(https?:\/\/(?:[^/.]+\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/\d+)/i);
            return e ? e[1] : ""
        }
        var d = c(window.location.href);
        if (d) return d;
        var e = a && a.closest ? a.closest("article") : null;
        e ||= document;
        var g = e.querySelectorAll('a[href*="/status/"]');
        for (var h = 0; h < g.length; h++) {
            d = c(g[h].href);
            if (d) return d
        }
        return ""
    };
    O.ensurePageResolver = function(a) {
        var b = globalThis.NDMRelaySiteAdapters ? NDMRelaySiteAdapters.pageURLForElement(a.m, window.location) : this.socialVideoPageURL(a.m);
        if (!b) return;
        var c = F("NDMRelayPage:" + b);
        this.A[c] || (this.A[c] = {
            id: c,
            1: "GET",
            2: b,
            6: "media-page",
            fEx: "mp4",
            4: NDMRelayText("推荐 · 选择画质并下载", "Recommended · Choose quality and download"),
            betterPageResolver: !0
        });
        -1 == a.items.indexOf(c) && a.items.unshift(c)
    };
    O.showAllPanels = function() {
        var a = null,
            b = Number.POSITIVE_INFINITY;
        for (var c in this.i) {
            var d = this.i[c];
            if (!d || !d.h || !d.visibleItems.length) continue;
            // Prefer the embedded site button; skip floating recovery when it exists.
            if (d.siteHasInlineUI && d.siteHasInlineUI()) continue;
            var e = d.m && d.m.getBoundingClientRect ? d.m.getBoundingClientRect() : null;
            var g = e && e.bottom >= 0 && e.top <= window.innerHeight ? Math.abs(e.top) : 1E12;
            g < b && (a = d, b = g)
        }
        if (a) {
            a.toolbarPinned = b >= 1E12;
            a.h.style.position = a.toolbarPinned ? "fixed" : a.m ? "absolute" : "fixed";
            a.v();
            a.show(!0)
        }
    };
    O.Ba = function() {
        this.port.postMessage([2, this.ea, window.location.href, this.getTitle()])
    };
    O.da = function(a) {
        for (var b = this, c = document.getElementsByTagName("SCRIPT"), f, e, h, l, m = !1, q = /"progressive":\s*\[/, r = 0; r < c.length; r++) {
            var n = c[r];
            f = n.innerText;
            if (a && !m && -1 < f.indexOf("itag") && 0 > f.indexOf("signatureCipher")) {
                for (var p = ['"formats"', "adaptiveFormats"], t = 0; t < p.length; t++) e = f, h = e.indexOf(p[t]), 0 > h || (e = e.substr(h), h = e.indexOf("["), l = e.indexOf("]"), 0 > h || 0 > l || l <= h || (e = e.substr(h + 1, l - h - 1), m = this.M(e, 1 == t)));
                if (this.Ca) break
            }
            if (0 <= document.location.host.toLowerCase().indexOf("vimeo") && !n.src && q.test(n.innerText) && (e = n.innerText, h = e.indexOf('"progressive"'), !(0 > h || (l = e.indexOf("]", h), 0 > l)))) {
                e = e.substr(h, l - h + 1);
                f = null;
                try {
                    f = JSON.parse("{" + e + "}")
                } catch (v) {}
                if (f) {
                    var u = f.progressive;
                    u && setTimeout(function() {
                        for (var v = 0; v <
                            u.length; v++) b.B({
                            id: F(u[v].url),
                            1: "GET",
                            2: u[v].url,
                            fEx: "mp4",
                            4: "MP4 File " + u[v].quality
                        }, window.location.href, null, !1)
                    }, 2E3);
                    break
                }
            }
        }
    };
    O.M = function(a, b) {
        var c = this,
            f = {
                18: {
                    e: "MP4",
                    s: "360p"
                },
                22: {
                    e: "MP4",
                    s: "720p"
                },
                37: {
                    e: "MP4",
                    s: "1080p"
                },
                38: {
                    e: "MP4",
                    s: "1080p"
                },
                82: {
                    e: "MP4",
                    s: "360p"
                },
                84: {
                    e: "MP4",
                    s: "720p"
                },
                132: {
                    e: "MP4",
                    s: "240p"
                },
                151: {
                    e: "MP4",
                    s: "144p"
                }
            };
        a = H(a);
        a = a.replace(/\\/g, "");
        var e = [],
            h = "";
        a = a.split("}");
        if (1 > a.length) return !1;
        for (var l = 0; l < a.length; l++) {
            var m = a[l].trim(),
                q = {},
                r;
            if (m && !(0 > m.indexOf("itag"))) {
                var n =
                    m.indexOf('"url"');
                if (!(0 > n)) {
                    n = m.indexOf('"', n + 5);
                    var p = m.indexOf('"', n + 1);
                    if (!(0 > n || 0 > p || p <= n || (m = q.url = decodeURIComponent(m.substr(n + 1, p - n - 1)), n = m.indexOf("?"), 0 > n))) {
                        n = m.substring(n + 1).split("&");
                        for (p = 0; p < n.length; p++) 0 == n[p].indexOf("itag=") && (r = q.itag = parseInt(n[p].split("=").pop())), 0 == n[p].indexOf("dur=") && (q.dur = parseFloat(n[p].split("=").pop())), 0 == n[p].indexOf("ei=") && (q.mK = n[p].split("=").pop());
                        m && r && (0 < m.indexOf("signature=") || 0 < m.indexOf("sig=")) && (!b || q.dur) && (b || f[r]) && (!b || y[r] ||
                            -1 < z.indexOf(r)) && (b ? e.push({
                            2: m,
                            mme: 0 > z.indexOf(r) ? "video" : "audio",
                            ig: r,
                            du: q.dur,
                            mK: q.mK,
                            purl: window.location.href
                        }) : (m = parseInt(q.dur), h = q.timeStr = 60 > m ? m + " sec" : parseInt(m / 60) + " min " + (parseInt(m % 60) ? parseInt(m % 60) + " sec" : ""), e.push(q)))
                    }
                }
            }
        }
        if (!e.length) return !1;
        b ? setTimeout(function() {
            for (var t = e.length - 1; 0 <= t; t--) c.X(e[t], "DTC")
        }, 1800) : (this.Aa(), setTimeout(function() {
            for (var t = 0; t < e.length; t++) {
                var u = e[t];
                c.B({
                    id: F(u.url),
                    ig: u.itag,
                    1: "GET",
                    2: u.url,
                    fEx: f[u.itag].e,
                    4: f[u.itag].e + " File " + f[u.itag].s +
                        ", " + (u.timeStr || h)
                }, window.location.href, null, !1)
            }
        }, 1500));
        return !0
    };
    O.Aa = function() {
        this.g = [];
        for (var a in this.i)
            for (var b = this.i[a], c = 0; c < b.items.length; c++) {
                var f = this.A[b.items[c]];
                if (f && f.ig) {
                    this.U(a, !0);
                    break
                }
            }
    };
    O.U = function(a, b) {
        var c = this.i[a];
        if (c) {
            if (b)
                for (b = 0; b < c.items.length; b++) delete this.A[c.items[b]];
            try {
                c.dispose()
            } catch (f) {}
            delete this.i[a];
            this.updateMediaCount()
        }
    };
    O.oa = function(a) {
        (a = this.A[a]) && this.port.postMessage([6, a, window.location.href, this.getTitle(),
            M(a)
        ])
    };
    O.ka = function(a, b) {
        var c = null,
            f = ["VIDEO", "AUDIO", "OBJECT", "EMBED"];
        try {
            var e = document.activeElement,
                h = 0,
                l, m, q = e && 0 <= f.indexOf(e.tagName) ? e : null;
            q ||= (e = document.elementFromPoint(this.Z, this.$)) && 0 <= f.indexOf(e.tagName) ? e : null;
            for (var r = 0; r < f.length; r++) {
                for (var n = document.getElementsByTagName(f[r]), p = 0; p < n.length; p++)
                    if (e = n[p], 3 != r || "application/x-shockwave-flash" == e.type.toLowerCase()) {
                        var t = e.src || e.data;
                        if (t && (t == a || t == b)) {
                            var u = e;
                            break
                        }
                        if (q || v) var v = e;
                        else {
                            var A = e.clientWidth,
                                B = e.clientHeight;
                            if (A && B) {
                                var J = window.getComputedStyle(e);
                                if (!J || "hidden" != J.visibility) {
                                    var K = A * B;
                                    B < 1.4 * A && A < 3 * B && K > h && (h = K, l = e);
                                    m ||= e
                                }
                            }
                        }
                    } if (u) break
            }(c = u || q || v || l || m) || (c = document.querySelectorAll("video,audio")[0]);
            if (!c) return null;
            if ("EMBED" == c.tagName && !c.clientWidth && !c.clientHeight) {
                var L = c.parentElement;
                "OBJECT" == L.tagName && (c = L)
            }
            return c
        } catch (Q) {
            return null
        }
    };
    O.ma = function(a) {
        try {
            var b = parseInt(a.getAttribute("JM_NEAT"));
            b || (b = this.ga << 10 | this.Counter++, a.setAttribute("JM_NEAT", b));
            return b
        } catch (c) {}
    };
    O.getTitle = function() {
        var a = "";
        try {
            a = document.title || document.getElementsByTagName("title")[0].innerText, a = a.trim()
        } catch (b) {}
        return a ? a = a.replace(/[ \t\r\n\u25B6]+/g, " ").trim() : ""
    };
    O.W = function(a) {
        8 != a.keyCode && 46 != a.keyCode || this.port.postMessage([4, "keydown" == a.type])
    };
    O.T = function(a) {
        0 == a.button && (this.Z = a.clientX, this.$ = a.clientY)
    };
    O.ta = function() {
        if (!this.P) {
            this.P = !0;
            var a = this;
            window.setTimeout(function() {
                for (var b in a.i) {
                    var c = a.i[b],
                        f = null;
                    c.m && (f = I(c.m));
                    if (f) {
                        try {
                            document.body.removeChild(c.h)
                        } catch (e) {}
                        c.anchor = f;
                        c.position.left =
                            Math.max(0, f.left + 8);
                        c.position.top = Math.max(0, f.top + 8);
                        document.body.appendChild(c.h)
                    }
                    c.v()
                }
                a.P = !1
            }, 500)
        }
    };

    function d(a, b) {
        return 18 > Math.abs(a.left - b.left) && 18 > Math.abs(a.top - b.top)
    }

    function g(a) {
        a = I(a.m);
        return !a || 0 > a.left || 0 > a.top
    }
    O.B = function(a, b, c, f) {
        var e = this,
            h = -1,
            l = null,
            m;
        // Adapted video pages download via the in-page button. Never create the
        // legacy float here: logged-in Bilibili tabs emit many media sniffs and
        // mounting overlays during Vue hydration blacked out the player.
        if (globalThis.NDMRelaySiteAdapters && NDMRelaySiteAdapters.prefersInlineUI(window.location.href)) {
            a.id || (a.id = F(a["2"]));
            e.A[a.id] = a;
            e.updateMediaCount();
            return;
        }
        f = f && RegExp(".*facebook.com$|.*vimeo.com$|.*youtube.com$", "i").test(window.location.host) && !(a.fEx && "VTT" == a.fEx.toUpperCase()) && !(!a.fS || 4194304 < a.fS);
        a.id || (a.id = F(a["2"]));
        c ||= this.ka(a["2"], b);
        if (!c)
            for (m in this.i) {
                l =
                    this.i[m];
                h = m;
                break
            }
        if (!c && !l) {
            if (f) return;
            l = new N(e, null, 0)
        } else if (!l)
            if (h = this.ma(c), l = this.i[h], !l) {
                if (f) return;
                l = new N(e, c, h);
                b = I(c);
                c = {
                    left: Math.max(0, b.left + 8),
                    top: Math.max(0, b.top + 8)
                };
                for (m in this.i)
                    if (m && m != h && (b = this.i[m], d(c, b.position))) {
                        for (c = 0; c < b.items.length; c++) l.L(b.items[c]);
                        this.U(m, !1);
                        break
                    } if (0 != h && this.i[0]) {
                    b = this.i[0];
                    for (c = 0; c < b.items.length; c++) l.L(b.items[c]);
                    this.U(0, !1)
                }
            } else {
                if (f) {
                    l.v();
                    return
                }
            }
        else if (f) {
            l.v();
            return
        }
        e.A[a.id] = a;
        l.L(a.id);
        l.m && g(l) && !this.l && (e.l =
            setInterval(function() {
                e.ha(l)
            }, 1200))
    };
    O.ha = function(a) {
        if (a && a.m) {
            var b = I(a.m);
            b && (a.anchor = b, a.position = {
                left: Math.max(0, b.left + 8),
                top: Math.max(0, b.top + 8)
            }, a.v());
            !b || 0 > b.left || 0 > b.top || (clearInterval(this.l), this.l = null)
        } else clearInterval(this.l), this.l = null
    };
    O.V = function(a, b) {
        var c = this,
            f = a.du,
            e = "";
        e = 60 > f ? parseInt(f) + " sec" : parseInt(f / 60) + " min " + (parseInt(f % 60) ? parseInt(f % 60) + " sec" : "");
        var h = {
            id: F(a["2"] + b["2"]),
            2: a["2"],
            3: b["2"],
            ig: a.ig,
            4: "MKV File " + y[a.ig] + ", " + e
        };
        setTimeout(function() {
            c.B(h, a.purl,
                null, !1)
        }, 2200)
    };
    O.X = function(a, b) {
        if ("https://www.youtube.com/" != window.location.href.toLowerCase() && ("video" != a.mme || y[a.ig])) {
            a.mode = b;
            for (b = 0; b < this.g.length; b++)
                if (a.ig == this.g[b].ig && (a.mK == this.g[b].mK || 2 > Math.abs(a.du - this.g[b].du))) return;
            a.used = !1;
            if ("video" == a.mme) {
                var c = null;
                for (b = 0; b < this.g.length; b++)
                    if ("audio" == this.g[b].mme && !this.g[b].used && (a.mK == this.g[b].mK || 2 > Math.abs(a.du - this.g[b].du))) {
                        this.g[b].used = !0;
                        c = this.g[b];
                        break
                    } if (!c)
                    for (b = 0; b < this.g.length; b++)
                        if ("audio" == this.g[b].mme &&
                            (a.mK == this.g[b].mK || 2 > Math.abs(a.du - this.g[b].du))) {
                            this.g[b].used = !0;
                            c = this.g[b];
                            break
                        } c && (a.used = !0, this.V(a, c))
            } else {
                c = null;
                for (b = 0; b < this.g.length; b++)
                    if ("video" == this.g[b].mme && 0 == this.g[b].used && (a.mK == this.g[b].mK || 2 > Math.abs(a.du - this.g[b].du))) {
                        this.g[b].used = !0;
                        c = this.g[b];
                        break
                    } c && (a.used = !0, this.V(c, a))
            }
            this.g.push(a)
        }
    };
    O.na = function(a) {
        var b = this;
        E({
            2: a,
            ba: function(c) {
                for (var f = ['"formats"', "adaptiveFormats"], e = 0; e < f.length; e++) {
                    var h = c,
                        l = h.indexOf(f[e]);
                    if (!(0 > l || -1 < h.indexOf("signatureCipher"))) {
                        h =
                            h.substr(l);
                        l = h.indexOf("[");
                        var m = h.indexOf("]");
                        if (0 > l || 0 > m || m <= l) break;
                        h = h.substr(l + 1, m - l - 1);
                        b.M(h, 1 == e)
                    }
                }
            }
        })
    };
    O.showBridgeNotice = function() {
        if (window.top !== window) return;
        var zh = String(navigator.language || "").toLowerCase().indexOf("zh") === 0;
        var text = {
            title: zh ? "无法连接到 NDM" : "Can't reach NDM",
            body: zh ? "NDM 可能没有在运行。你的点击已暂存，连接恢复后会自动发送。" : "NDM may not be running. Your click is queued and will be sent once reconnected.",
            open: zh ? "打开 NDM" : "Open NDM",
            dismiss: zh ? "知道了" : "Dismiss",
            opened: zh ? "已通知 NDM" : "NDM notified",
            offline: zh ? "仍未连接，请启动 NDM 后重试" : "Still offline — start NDM and try again"
        };
        var host = document.getElementById("ndm-relay-bridge-toast");
        if (host && host.remove) host.remove();
        host = document.createElement("div");
        host.id = "ndm-relay-bridge-toast";
        // Isolated shadow root: page CSS can never restyle this notice, and the
        // notice can never leak styles into the page.
        var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
        var style = document.createElement("style");
        style.textContent = [
            ":host{all:initial}",
            "*{box-sizing:border-box}",
            ".wrap{position:fixed;left:50%;bottom:22px;transform:translate(-50%,14px);opacity:0;z-index:2147483647;transition:transform .28s cubic-bezier(.22,1,.36,1),opacity .28s cubic-bezier(.22,1,.36,1);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
            ".wrap.in{transform:translate(-50%,0);opacity:1}",
            "@media(prefers-reduced-motion:reduce){.wrap{transition:none}}",
            ".card{display:flex;align-items:flex-start;gap:11px;width:min(400px,calc(100vw - 32px));padding:13px 14px;border:1px solid rgba(60,60,67,.24);border-radius:12px;background:#f7f7f8;color:#1d1d1f;box-shadow:0 10px 30px rgba(0,0,0,.2)}",
            ".dot{flex:none;width:8px;height:8px;border-radius:50%;background:#d16b4b;margin-top:5px}",
            ".body{min-width:0;flex:1}",
            ".title{font-size:13px;font-weight:700;line-height:1.3}",
            ".msg{margin-top:3px;font-size:12px;line-height:1.45;color:#6e6e73}",
            ".row{display:flex;align-items:center;gap:8px;margin-top:9px}",
            ".open{appearance:none;border:0;border-radius:7px;background:#303238;color:#f7f7f8;height:28px;padding:0 12px;cursor:pointer;font:650 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
            ".open:hover,.open:focus-visible{outline:2px solid rgba(102,106,115,.45);outline-offset:2px}",
            ".close{appearance:none;border:0;border-radius:7px;background:transparent;color:#6e6e73;height:28px;padding:0 10px;cursor:pointer;font:550 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
            ".close:hover,.close:focus-visible{background:rgba(120,120,128,.12);outline:none}",
            "@media(prefers-color-scheme:dark){.card{background:#1e2025;color:#f5f5f7;border-color:rgba(255,255,255,.135)}.msg{color:#a8abb2}.open{background:#f0f0f2;color:#17181c}.close{color:#a8abb2}.close:hover{background:rgba(235,235,245,.12)}}"
        ].join("");
        shadow.appendChild(style);
        var wrap = document.createElement("div");
        wrap.className = "wrap";
        var card = document.createElement("div");
        card.className = "card";
        var dot = document.createElement("span");
        dot.className = "dot";
        var bodyEl = document.createElement("div");
        bodyEl.className = "body";
        var title = document.createElement("div");
        title.className = "title";
        title.textContent = text.title;
        var msg = document.createElement("div");
        msg.className = "msg";
        msg.textContent = text.body;
        var row = document.createElement("div");
        row.className = "row";
        var openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "open";
        openBtn.textContent = text.open;
        var closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "close";
        closeBtn.textContent = text.dismiss;
        row.appendChild(openBtn);
        row.appendChild(closeBtn);
        bodyEl.appendChild(title);
        bodyEl.appendChild(msg);
        bodyEl.appendChild(row);
        card.appendChild(dot);
        card.appendChild(bodyEl);
        wrap.appendChild(card);
        shadow.appendChild(wrap);

        function hide() {
            wrap.classList.remove("in");
            setTimeout(function() {
                if (host && host.remove) host.remove()
            }, 300)
        }
        var timer = setTimeout(hide, 9000);
        closeBtn.addEventListener("click", function() {
            clearTimeout(timer);
            hide()
        });
        openBtn.addEventListener("click", function() {
            try {
                chrome.runtime.sendMessage({ type: "relay:openApp" }, function(reply) {
                    if (!reply || !reply.connected) {
                        msg.textContent = text.offline;
                        return
                    }
                    openBtn.textContent = text.opened;
                    openBtn.disabled = true;
                    clearTimeout(timer);
                    timer = setTimeout(hide, 1800)
                })
            } catch (e) {}
        });
        (document.body || document.documentElement).appendChild(host);
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                wrap.classList.add("in")
            })
        })
    };
    O.aa = function(a) {
        var b = this;
        switch (a[0]) {
            case 1:
                b.B(a[1], a[2], null, !0);
                break;
            case 3:
                var c = a[1];
                c && (b.ea = c);
                b.Ba();
                break;
            case 5:
                b.fa();
                break;
            case 7:
                b.M(a[1], a[2]);
                break;
            case 9:
                setTimeout(function() {
                    b.X(a[1], "BGH")
                }, 1400);
                break;
            case 11:
                b.za();
                b.siteAdapters && b.siteAdapters.refresh();
                c = new URL(window.location.href);
                var f = c.pathname;
                if (!(0 <= c.hostname.toLowerCase().indexOf("youtube."))) {
                    setTimeout(function() {
                        b.da()
                    }, 2500);
                    break
                }
                0 ==
                    f.toLowerCase().indexOf("/watch") && b.na(a[1]);
                break;
            case 13:
                c = a[1];
                c != b.H && (b.H = c, b.fa());
                break;
            case 17:
                b.H = !0;
                b.showAllPanels();
                break;
            case 24:
                b.resolveCurrentPage(a[1]);
                break;
            case 23:
                b.downloadResource(a[1]);
                break;
            case 15:
                b.showBridgeNotice()
        }
    };
    O.o = function(a) {
        var b = Array.prototype.slice.call(arguments);
        b[2] = b[2].bind(this);
        this.ja.push(b);
        a.addEventListener.apply(a, b.slice(1))
    };
    O.ra = function() {
        for (var a in this.i) {
            var panel = this.i[a];
            panel.K(!0);
            panel.fade(3200)
        }
    };
    O.za = function() {
        for (var a in this.i) this.i[a].dispose();
        this.i = {};
        this.updateMediaCount();
        this.A = {};
        this.g = [];
        this.l && clearInterval(this.l);
        this.l = null
    };
    O.fa = function() {
        try {
            for (var b in this.i) {
                var panel = this.i[b];
                if (panel && panel.render) panel.render();
                else if (panel && panel.h) panel.h.style.display = this.H ? "" : "none"
            }
        } catch (c) {}
    };
    O.ca = function() {
        // After the extension reloads or updates, chrome.runtime.connect throws
        // "Extension context invalidated" in old pages. Retry a few times, then
        // stop quietly instead of throwing in page context forever.
        if (this.portRetries === undefined) this.portRetries = 0;
        var b = this;
        try {
            this.port = chrome.runtime.connect({
                name: "neat"
            });
            this.portRetries = 0
        } catch (a) {
            if (3 <= ++this.portRetries) return;
            setTimeout(function() {
                b.ca()
            }, 3000);
            return
        }
        this.wirePort()
    };
    O.connectPort = function() {
        this.portRetries = 0;
        this.ca()
    };
    O.wirePort = function() {
        this.port.onMessage.addListener(this.aa.bind(this));
        this.port.onDisconnect.addListener(this.ca.bind(this))
    };
    new P
};
