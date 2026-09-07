(function(root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.NDMRelaySiteAdapters = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    function hostFor(value) {
        try { return new URL(String(value || "")).hostname.toLowerCase(); }
        catch (_) { return ""; }
    }

    function siteForURL(value) {
        var host = hostFor(value);
        if (host === "x.com" || host.endsWith(".x.com") ||
            host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
        if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
        if (host === "bilibili.com" || host.endsWith(".bilibili.com")) return "bilibili";
        if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return "vimeo";
        if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
        if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
        if (host === "douyin.com" || host.endsWith(".douyin.com")) return "douyin";
        return "";
    }

    function canonicalXURL(value) {
        var match = String(value || "").match(/^(https?:\/\/(?:[^/.]+\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/\d+)/i);
        return match ? match[1].replace(/^http:/i, "https:") : "";
    }

    function canonicalYouTubeURL(value) {
        try {
            var url = new URL(String(value || ""));
            var host = url.hostname.toLowerCase();
            if (host === "youtu.be") {
                var shortID = url.pathname.split("/").filter(Boolean)[0];
                return shortID ? "https://www.youtube.com/watch?v=" + encodeURIComponent(shortID) : "";
            }
            if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return "";
            if (url.pathname === "/watch") {
                var videoID = url.searchParams.get("v");
                return videoID ? "https://www.youtube.com/watch?v=" + encodeURIComponent(videoID) : "";
            }
            var pathMatch = url.pathname.match(/^\/(shorts|live)\/([^/?#]+)/i);
            return pathMatch ? "https://www.youtube.com/" + pathMatch[1].toLowerCase() + "/" + encodeURIComponent(pathMatch[2]) : "";
        } catch (_) {
            return "";
        }
    }

    function canonicalBilibiliURL(value) {
        try {
            var url = new URL(String(value || ""));
            if (!(url.hostname === "bilibili.com" || url.hostname.endsWith(".bilibili.com"))) return "";
            var match = url.pathname.match(/^\/video\/((?:BV[0-9A-Za-z]+)|(?:av\d+))/i);
            return match ? "https://www.bilibili.com/video/" + match[1] : "";
        } catch (_) { return ""; }
    }

    function canonicalVimeoURL(value) {
        try {
            var url = new URL(String(value || ""));
            if (!(url.hostname === "vimeo.com" || url.hostname.endsWith(".vimeo.com"))) return "";
            var match = url.pathname.match(/\/(?:video\/)?(\d+)(?:\/|$)/);
            return match ? "https://vimeo.com/" + match[1] : "";
        } catch (_) { return ""; }
    }

    function canonicalInstagramURL(value) {
        try {
            var url = new URL(String(value || ""));
            if (!(url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com"))) return "";
            var match = url.pathname.match(/^\/(reel|p|tv)\/([^/?#]+)/i);
            return match ? "https://www.instagram.com/" + match[1].toLowerCase() + "/" + match[2] + "/" : "";
        } catch (_) { return ""; }
    }

    function canonicalTikTokURL(value) {
        try {
            var url = new URL(String(value || ""));
            if (!(url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"))) return "";
            var match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)/i);
            return match ? "https://www.tiktok.com/@" + match[1] + "/video/" + match[2] : "";
        } catch (_) { return ""; }
    }

    function canonicalDouyinURL(value) {
        try {
            var url = new URL(String(value || ""));
            if (!(url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"))) return "";
            var match = url.pathname.match(/^\/video\/(\d+)/i);
            return match ? "https://www.douyin.com/video/" + match[1] : "";
        } catch (_) { return ""; }
    }

    function canonicalForSite(site, value) {
        if (site === "x") return canonicalXURL(value);
        if (site === "youtube") return canonicalYouTubeURL(value);
        if (site === "bilibili") return canonicalBilibiliURL(value);
        if (site === "vimeo") return canonicalVimeoURL(value);
        if (site === "instagram") return canonicalInstagramURL(value);
        if (site === "tiktok") return canonicalTikTokURL(value);
        if (site === "douyin") return canonicalDouyinURL(value);
        return "";
    }

    function canonicalPageURL(value, candidateLinks) {
        var site = siteForURL(value);
        if (!site) return "";
        var direct = canonicalForSite(site, value);
        if (direct) return direct;
        var links = candidateLinks || [];
        for (var i = 0; i < links.length; i++) {
            direct = canonicalForSite(site, links[i]);
            if (direct) return direct;
        }
        return "";
    }

    function pageURLForElement(element, locationValue) {
        var rawLocation = String(locationValue && locationValue.href || locationValue || "");
        var site = siteForURL(rawLocation);
        if (site !== "x" && site !== "instagram") return canonicalPageURL(rawLocation);
        var article = element && element.closest ? element.closest('article[data-testid="tweet"], article') : null;
        var scope = article || element || (typeof document !== "undefined" ? document : null);
        var links = [];
        if (scope && scope.querySelectorAll) {
            links = Array.from(scope.querySelectorAll('a[href*="/status/"],a[href*="/reel/"],a[href*="/p/"],a[href*="/tv/"]')).map(function(link) {
                return link.href || link.getAttribute("href") || "";
            });
        }
        return canonicalPageURL(rawLocation, links);
    }

    /// Page-level adapters (Bilibili/YouTube/…) own the download entry.
    /// Callers should not mount the legacy floating media strip on these URLs
    /// at all — even before the in-page button lands — because media sniffs
    /// during SPA boot (common when logged in) used to append overlays and
    /// fight hydration (black player + comment skeleton on Bilibili).
    function prefersInlineUI(value) {
        var site = siteForURL(value);
        if (site === "youtube") return Boolean(canonicalYouTubeURL(value));
        if (site === "bilibili") return Boolean(canonicalBilibiliURL(value));
        if (site === "vimeo") return Boolean(canonicalVimeoURL(value));
        if (site === "tiktok") return Boolean(canonicalTikTokURL(value));
        if (site === "douyin") return Boolean(canonicalDouyinURL(value));
        return false;
    }

    /// True only after the site-native action actually exists. Callers use
    /// this to suppress the legacy floating media strip without risking a
    /// dead end when a site changes its DOM and injection fails.
    /// Accepts hasInlineAction(mediaEl, location) or hasInlineAction(locationHref).
    function hasInlineAction(element, locationValue, documentValue) {
        if (typeof element === "string" && (locationValue === undefined || locationValue === null)) {
            locationValue = element;
            element = null;
        } else if (element && typeof element === "object" && !element.closest &&
            (element.href || element.hostname) && (locationValue === undefined || locationValue === null)) {
            // Accidental Location / URL object as the sole argument.
            locationValue = element;
            element = null;
        }
        var rawLocation = String(locationValue && locationValue.href || locationValue || "");
        var site = siteForURL(rawLocation);
        if (!site) return false;
        var selector = '[data-better-ndm-site-action="' + site + '"]';
        if (site === "x" || site === "instagram") {
            var article = element && element.closest ? element.closest("article") : null;
            return Boolean(article && article.querySelector && article.querySelector(selector));
        }
        var doc = documentValue || (typeof document !== "undefined" ? document : null);
        return Boolean(doc && doc.querySelector && doc.querySelector(selector));
    }

    function text(zh, en) {
        return typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().indexOf("zh") === 0 ? zh : en;
    }

    function addStyles() {
        if (!document.head || document.getElementById("better-ndm-site-adapter-style")) return;
        var style = document.createElement("style");
        style.id = "better-ndm-site-adapter-style";
        style.textContent = [
            // X action-bar icon button: icon-only inside a circular hover, like
            // the native Share/Bookmark. Color is synced from a sibling native
            // button at inject time (theme-exact); the vars are the fallback.
            ".better-ndm-x-action{display:flex;align-items:center;min-width:0}",
            ".better-ndm-x-button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:34.75px;height:34.75px;border-radius:9999px;color:var(--better-ndm-x-color,rgb(83,100,113));cursor:pointer;transition:color .2s ease,background-color .2s ease}",
            ".better-ndm-x-button:hover,.better-ndm-x-button:focus-visible{color:rgb(29,155,240);background:rgba(29,155,240,.1);outline:none}",
            ".better-ndm-x-button svg{width:18.75px;height:18.75px;fill:currentColor;flex:none}",
            ".better-ndm-x-label{display:none}",
            // YouTube: match the native mono action chip (Share/Download).
            ".better-ndm-youtube-action{display:inline-flex;align-items:center;margin-left:8px;vertical-align:middle}",
            // Values verified against YouTube's live 分享/Share chip: 40px tall,
            // 20px radius, 0 16px padding, rgba(0,0,0,.05) bg, 14px Roboto.
            ".better-ndm-youtube-button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;padding:0 16px;border-radius:20px;background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.05));color:var(--yt-spec-text-primary,#0f0f0f);cursor:pointer;font:500 14px/40px Roboto,Arial,sans-serif;white-space:nowrap;transition:background-color .15s ease}",
            ".better-ndm-youtube-button:hover,.better-ndm-youtube-button:focus-visible{background:var(--yt-spec-button-chip-background-hover,rgba(0,0,0,.1));outline:none}",
            ".better-ndm-youtube-button svg{width:24px;height:24px;fill:currentColor;flex:none;margin-left:-4px}",
            // Peer of 举报/笔记: reuse native .video-toolbar-right-item (font/icon/hover).
            // Spacing matches .toolbar-right-note before .video-tool-more — no extra
            // margin-left / flex:none / min-width (those squeezed 记笔记 off-screen).
            ".better-ndm-bilibili-action{margin-right:12px}",
            "@media (min-width:1681px){.better-ndm-bilibili-action{margin-right:20px}}",
            ".better-ndm-bilibili-button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;color:inherit;cursor:pointer;font:inherit;line-height:inherit;white-space:nowrap}",
            ".better-ndm-bilibili-button:focus-visible{outline:none}",
            ".better-ndm-bilibili-button .video-toolbar-item-icon{fill:currentColor}",
            // Two concession steps for a full toolbar. We only ever shrink or hide
            // ourselves — never restyle 记笔记 / 稿件举报 to make room.
            ".better-ndm-bilibili-compact .better-ndm-bilibili-label{display:none}",
            ".better-ndm-bilibili-compact{margin-right:8px}",
            ".better-ndm-bilibili-yield{display:none}",
            ".better-ndm-site-inline-action{display:inline-flex;align-items:center;margin-left:8px}",
            ".better-ndm-site-inline-button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 12px;border:1px solid rgba(120,120,128,.25);border-radius:8px;background:rgba(120,120,128,.08);color:inherit;cursor:pointer;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap}",
            ".better-ndm-site-inline-button:hover,.better-ndm-site-inline-button:focus-visible{background:rgba(120,120,128,.14);border-color:rgba(120,120,128,.38);outline:none}",
            ".better-ndm-site-inline-button svg{width:18px;height:18px;fill:currentColor;flex:none}",
            // TikTok action rail item: mirrors TikTok's circular Like/Comment/
            // Share buttons (circle + count-style label below). Circle size,
            // colors and count typography are sampled from the live rail at
            // inject time; these fallbacks match TikTok's light theme.
            ".better-ndm-tiktok-action{display:flex;flex-direction:column;align-items:center;gap:4px;flex:none}",
            ".better-ndm-tiktok-button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:var(--ndm-tt-circle-size,48px);height:var(--ndm-tt-circle-size,48px);border-radius:9999px;background:var(--ndm-tt-circle-bg,rgba(22,24,35,.06));color:var(--ndm-tt-circle-ink,#161823);cursor:pointer;touch-action:manipulation;transition:scale .12s ease,opacity .14s ease}",
            ".better-ndm-tiktok-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
            ".better-ndm-tiktok-button:active{scale:.93}",
            ".better-ndm-tiktok-button svg{width:24px;height:24px;fill:currentColor;flex:none}",
            ".better-ndm-tiktok-button[aria-busy='true']{opacity:.6;pointer-events:none}",
            ".better-ndm-tiktok-count{color:var(--ndm-tt-label,rgba(22,24,35,.5));font-size:var(--ndm-tt-label-size,12px);line-height:1;font-weight:var(--ndm-tt-label-weight,600)}",
            ".better-ndm-site-busy{opacity:.68;pointer-events:none}"
        ].join("");
        document.head.appendChild(style);
    }

    function makeIcon() {
        var namespace = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(namespace, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        var path = document.createElementNS(namespace, "path");
        path.setAttribute("d", "M11 3a1 1 0 0 1 2 0v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.42l2.3 2.3V3ZM5 17a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z");
        svg.appendChild(path);
        return svg;
    }

    /// How crowded a toolbar row is, as a single comparable number.
    ///
    /// Load-bearing definition, hence pure and duck-typed so it can be tested
    /// without a browser. Bilibili's right-hand cluster has a fixed width budget:
    /// adding an item without giving anything back pushes a native one out. Logged
    /// out there is no 记笔记 to displace and the row happens to fit, which is
    /// exactly why the bug only ever showed in a normal profile.
    ///
    /// Counts overflow pixels, plus a heavy penalty per native item that is either
    /// squeezed below its own content width or pushed past the row's right edge.
    /// `isOurs` marks the chip so our own clipping never counts against us.
    function crowdingScore(container, isOurs) {
        if (!container) return 0;
        var score = Math.max(0, num(container.scrollWidth) - num(container.clientWidth));
        var edge = rightEdge(container);
        var children = container.children || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (!child || (isOurs && isOurs(child))) continue;
            if (num(child.scrollWidth) - num(child.clientWidth) > 1) score += 1000;
            if (edge !== null && rightEdge(child) > edge + 1) score += 1000;
        }
        return score;
    }

    function num(value) {
        return typeof value === "number" && isFinite(value) ? value : 0;
    }

    function rightEdge(node) {
        if (!node || typeof node.getBoundingClientRect !== "function") return null;
        var rect = node.getBoundingClientRect();
        return rect && typeof rect.right === "number" ? rect.right : null;
    }

    /// Richest chip rendering that does not make the row more crowded than we
    /// found it. Pure; `observe(mode)` applies a mode and returns its score.
    function fitChipMode(baseline, observe) {
        var ladder = ["labelled", "compact"];
        for (var i = 0; i < ladder.length; i++) {
            if (observe(ladder[i]) <= baseline) return ladder[i];
        }
        // Out of room. Concede the slot rather than keep a native item squeezed —
        // the toolbar popup and the generic NDM float are still reachable.
        observe("yield");
        return "yield";
    }

    function isOurChipNode(node) {
        return Boolean(node && node.dataset && node.dataset.betterNdmSiteAction);
    }

    function SiteAdapterManager(options) {
        this.options = options || {};
        this.observer = null;
        this.timer = null;
        this.start();
    }

    SiteAdapterManager.prototype.start = function() {
        if (typeof document === "undefined" || typeof window === "undefined") return;
        if (!siteForURL(window.location.href)) return;
        var manager = this;
        var site = siteForURL(window.location.href);
        var ready = function() {
            if (site === "bilibili") {
                // Bilibili's Vue player/header still hydrate after DOMContentLoaded.
                // A body-wide MutationObserver or early toolbar surgery races that
                // work and leaves a black player + comment skeleton — especially
                // in a normal profile where the user is logged in and media sniffs
                // are busy. Wait for window load, then only watch the toolbar.
                var startBilibili = function() {
                    manager.watchBilibiliToolbar();
                };
                if (document.readyState === "complete") setTimeout(startBilibili, 600);
                else window.addEventListener("load", function() {
                    setTimeout(startBilibili, 600);
                }, { once: true });
                return;
            }
            addStyles();
            manager.scan();
            if (!manager.observer && window.MutationObserver && document.body) {
                manager.observer = new MutationObserver(function() { manager.schedule(); });
                // Never observe documentElement: Bilibili (and similar SPAs) hydrate
                // header chrome from html children and a broad observer there causes
                // top-bar flash/disappear.
                manager.observer.observe(document.body, { childList: true, subtree: true });
                manager._observeDelay = 80;
            }
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
        else ready();
    };

    /// Poll for the Bilibili video toolbar, inject once, and observe only that
    /// subtree — never the player or documentElement.
    SiteAdapterManager.prototype.watchBilibiliToolbar = function() {
        var manager = this;
        if (this._biliWatching) return;
        this._biliWatching = true;
        this._observeDelay = 400;
        var tries = 0;
        var attach = function() {
            if (!canonicalBilibiliURL(window.location.href)) {
                manager.scanBilibili();
                manager._biliWatching = false;
                return;
            }
            // Prefer the whole arc toolbar so right-side 举报/笔记/more reshuffles
            // still trigger a re-home of the NDM chip (never only left-main).
            var target = document.querySelector("#arc_toolbar_report, .video-toolbar-right, .video-toolbar-left, .video-toolbar-left-main");
            if (!target) {
                if (tries++ < 40) manager._biliPoll = setTimeout(attach, 500);
                else manager._biliWatching = false;
                return;
            }
            addStyles();
            manager.scan();
            if (!manager.observer && window.MutationObserver) {
                manager.observer = new MutationObserver(function() { manager.schedule(); });
                manager.observer.observe(target, { childList: true, subtree: true });
            }
            // Width is half of the fit decision, and a resize mutates nothing the
            // observer would see.
            if (!manager._biliResize) {
                manager._biliResize = function() { manager.schedule(); };
                window.addEventListener("resize", manager._biliResize);
            }
        };
        attach();
    };

    SiteAdapterManager.prototype.schedule = function() {
        var manager = this;
        if (this.timer) return;
        var delay = this._observeDelay || 80;
        this.timer = setTimeout(function() {
            manager.timer = null;
            manager.scan();
        }, delay);
    };

    SiteAdapterManager.prototype.notifyActionReady = function() {
        if (this.options.onActionReady) this.options.onActionReady();
    };

    SiteAdapterManager.prototype.scan = function() {
        var site = siteForURL(window.location.href);
        if (site === "x") this.scanX();
        else if (site === "youtube") this.scanYouTube();
        else if (site === "bilibili") this.scanBilibili();
        else if (site === "vimeo") this.scanVimeo();
        else if (site === "instagram") this.scanInstagram();
        else if (site === "tiktok") this.scanTikTok();
        else if (site === "douyin") this.scanDouyin();
    };

    SiteAdapterManager.prototype.makeButton = function(site, urlProvider) {
        var manager = this;
        var button = document.createElement("button");
        button.type = "button";
        button.dataset.betterNdmSiteAction = site;
        button.className = site === "x" ? "better-ndm-x-button" : site === "youtube" ? "better-ndm-youtube-button" : site === "bilibili" ? "better-ndm-bilibili-button" : "better-ndm-site-inline-button";
        var label = site === "x" ? "NDM" : site === "bilibili" ? text("NDM下载", "NDM Download") : text("使用 NDM 下载", "Download with NDM");
        var idleLabel = site === "tiktok" ? text("下载", "Download") : label;
        var labelNode = document.createElement("span");
        labelNode.className = "better-ndm-" + site + "-label";
        labelNode.textContent = label;
        button.appendChild(makeIcon());
        button.appendChild(labelNode);
        if (site === "bilibili") {
            // Mirror 稿件举报 / 记笔记: native icon + text classes drive size/gap.
            var icon = button.querySelector("svg");
            if (icon) {
                icon.setAttribute("class", "video-toolbar-item-icon");
                icon.setAttribute("fill", "currentColor");
                icon.setAttribute("width", "20");
                icon.setAttribute("height", "20");
            }
            labelNode.className = "better-ndm-bilibili-label video-toolbar-item-text";
        }
        button.title = text("使用 NDM 下载此视频", "Download this video with NDM");
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", function(event) {
            event.preventDefault();
            event.stopPropagation();
            var url = urlProvider();
            if (!url || button.disabled) return;
            button.disabled = true;
            button.classList.add("better-ndm-site-busy");
            button.setAttribute("aria-busy", "true");
            if (labelNode) labelNode.textContent = text("正在打开 NDM…", "Opening NDM…");
            try {
                if (manager.options.onDownload) manager.options.onDownload({
                    site: site,
                    url: url,
                    label: text("使用 NDM 下载", "Download with NDM")
                });
            } finally {
                setTimeout(function() {
                    button.disabled = false;
                    button.classList.remove("better-ndm-site-busy");
                    button.removeAttribute("aria-busy");
                    if (labelNode) labelNode.textContent = idleLabel;
                }, 1400);
            }
        });
        if (site === "tiktok") {
            // TikTok's rail item is a circular icon button with a count-style
            // label below — the opposite of the generic labelled pill.
            button.className = "better-ndm-tiktok-button";
            labelNode.className = "better-ndm-tiktok-count";
            labelNode.textContent = idleLabel;
            var railItem = document.createElement("span");
            railItem.className = "better-ndm-tiktok-action";
            railItem.appendChild(button);
            railItem.appendChild(labelNode);
            return railItem;
        }
        return button;
    };

    SiteAdapterManager.prototype.scanX = function() {
        var manager = this;
        Array.from(document.querySelectorAll('article[data-testid="tweet"]')).forEach(function(article) {
            if (article.querySelector('[data-better-ndm-site-action="x"]')) return;
            if (!article.querySelector('video,[data-testid="videoPlayer"]')) return;
            var actionGroups = Array.from(article.querySelectorAll('[role="group"]'));
            var group = actionGroups.find(function(candidate) {
                return candidate.querySelector('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"]');
            });
            if (!group) return;
            var pageURL = pageURLForElement(article, window.location);
            if (!pageURL) return;
            var wrapper = document.createElement("div");
            wrapper.className = "better-ndm-x-action";
            wrapper.dataset.betterNdmSiteAction = "x-wrapper";
            var button = manager.makeButton("x", function() {
                return pageURLForElement(article, window.location) || pageURL;
            });
            // Theme-exact resting color: copy it from a native action-bar icon
            // (X's dim / lights-out / light themes each use a different gray,
            // and it isn't the OS color scheme). Falls back to the CSS var.
            var nativeIcon = group.querySelector('[data-testid="reply"] svg, [data-testid="retweet"] svg, [data-testid="like"] svg');
            if (nativeIcon) {
                var nativeColor = window.getComputedStyle(nativeIcon).color;
                if (nativeColor) button.style.setProperty("--better-ndm-x-color", nativeColor);
            }
            wrapper.appendChild(button);
            group.appendChild(wrapper);
            manager.notifyActionReady();
        });
    };

    SiteAdapterManager.prototype.scanYouTube = function() {
        if (!canonicalYouTubeURL(window.location.href)) return;
        var actions = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
        if (!actions || actions.querySelector('[data-better-ndm-site-action="youtube"]')) return;
        var wrapper = document.createElement("div");
        wrapper.className = "better-ndm-youtube-action";
        wrapper.dataset.betterNdmSiteAction = "youtube-wrapper";
        wrapper.appendChild(this.makeButton("youtube", function() {
            return canonicalYouTubeURL(window.location.href);
        }));
        actions.appendChild(wrapper);
        this.notifyActionReady();
    };

    /// Mount NDM to the right of 稿件举报 / 记笔记 and immediately left of
    /// `.video-tool-more`. Stay a sibling of more (never a descendant) so Bilibili's
    /// narrow-width fold into the more menu cannot swallow the chip.
    SiteAdapterManager.prototype.scanBilibili = function() {
        var pageURL = canonicalBilibiliURL(window.location.href);
        // Only touch the video toolbar on real /video/BV pages. Never inject on
        // app.bilibili.com or other marketing shells — those hosts only need
        // ordinary file catching (e.g. .dmg), not DOM surgery.
        if (!pageURL) {
            // A SPA can retain the old toolbar after leaving the video route.
            // Remove only our entry; native controls belong to the page.
            document.querySelectorAll('[data-better-ndm-site-action="bilibili-wrapper"]').forEach(function(wrapper) {
                wrapper.remove();
            });
            return;
        }
        if (!document.querySelector("video")) return;

        var more = document.querySelector(
            "#arc_toolbar_report .video-tool-more.video-toolbar-right-item, " +
            "#arc_toolbar_report .video-tool-more, " +
            ".video-toolbar-right .video-tool-more, " +
            ".video-tool-more.video-toolbar-right-item"
        );
        var right = (more && more.parentElement) ||
            document.querySelector("#arc_toolbar_report .video-toolbar-right, .video-toolbar-right");
        if (!right) return;

        var existingWrap = document.querySelector('[data-better-ndm-site-action="bilibili-wrapper"]');
        if (existingWrap) {
            // Re-home if SPA re-render tucked us under more or away from the anchor.
            var misplaced = existingWrap.closest(".video-tool-more") ||
                (more && existingWrap.parentElement !== more.parentElement) ||
                (more && existingWrap.nextElementSibling !== more);
            if (misplaced && more && more.parentElement) {
                more.parentElement.insertBefore(existingWrap, more);
            } else if (misplaced && !more && existingWrap.parentElement !== right) {
                right.appendChild(existingWrap);
            }
            // Re-decide every pass: login state, SPA re-render and window width all
            // change how much room the row has.
            this.fitBilibiliChip(existingWrap, existingWrap.parentElement || right);
            return;
        }
        if (document.querySelector('[data-better-ndm-site-action="bilibili"]')) return;

        var wrapper = document.createElement("div");
        // Native .video-toolbar-right-item supplies display/font/color/hover; stay a
        // sibling of more (never a descendant) so the fold cannot swallow the chip.
        wrapper.className = "better-ndm-bilibili-action video-toolbar-right-item";
        wrapper.dataset.betterNdmSiteAction = "bilibili-wrapper";
        wrapper.appendChild(this.makeButton("bilibili", function() { return canonicalBilibiliURL(window.location.href); }));
        if (more && more.parentElement) more.parentElement.insertBefore(wrapper, more);
        else right.appendChild(wrapper);
        this.fitBilibiliChip(wrapper, wrapper.parentElement || right);
        this.notifyActionReady();
    };

    /// Give the chip the most room the row can spare, and no more.
    ///
    /// The baseline is measured with the chip laid out as `yield` (display:none),
    /// which reproduces the row exactly as it was before we existed. Any mode that
    /// scores worse than that baseline is displacing something of Bilibili's, so we
    /// step down instead of keeping it.
    SiteAdapterManager.prototype.fitBilibiliChip = function(wrapper, container) {
        if (!wrapper || !container || typeof container.getBoundingClientRect !== "function") return;
        var apply = function(mode) {
            wrapper.classList.remove("better-ndm-bilibili-compact", "better-ndm-bilibili-yield");
            if (mode === "compact") wrapper.classList.add("better-ndm-bilibili-compact");
            else if (mode === "yield") wrapper.classList.add("better-ndm-bilibili-yield");
            return crowdingScore(container, isOurChipNode);
        };
        wrapper.dataset.betterNdmFit = fitChipMode(apply("yield"), apply);
    };

    SiteAdapterManager.prototype.scanVimeo = function() {
        var pageURL = canonicalVimeoURL(window.location.href);
        if (!pageURL || !document.querySelector("video")) return;
        var actions = document.querySelector('[data-testid="video-actions"], [class*="video_actions"], [class*="action-bar"]');
        if (!actions) {
            var heading = document.querySelector("main h1, h1");
            actions = heading && heading.parentElement;
        }
        this.addInlineAction(actions, "vimeo", function() { return canonicalVimeoURL(window.location.href) || pageURL; });
    };

    SiteAdapterManager.prototype.scanInstagram = function() {
        var manager = this;
        Array.from(document.querySelectorAll("article")).forEach(function(article) {
            if (!article.querySelector("video") || article.querySelector('[data-better-ndm-site-action="instagram"]')) return;
            var pageURL = pageURLForElement(article, window.location);
            if (!pageURL) return;
            var actions = Array.from(article.querySelectorAll("section")).find(function(section) {
                return section.querySelectorAll("button").length >= 2;
            });
            manager.addInlineAction(actions, "instagram", function() { return pageURLForElement(article, window.location) || pageURL; });
        });
    };

    /// TikTok's rail is a narrow flex column whose children are the
    /// Like/Comment/Collect/Share groups. Walk up from the share control
    /// until the parent holds several action groups; appending there keeps
    /// NDM a real sibling item instead of a pill glued under the section.
    SiteAdapterManager.prototype.tikTokRail = function(share) {
        var node = share;
        for (var depth = 0; node && depth < 6; depth += 1) {
            var parent = node.parentElement;
            if (!parent) return null;
            if (parent.children.length >= 3) {
                var layout = window.getComputedStyle(parent);
                if (layout.display.indexOf("flex") >= 0 && layout.flexDirection === "column") return parent;
            }
            node = parent;
        }
        return null;
    };

    /// Theme-exact by sampling TikTok's own circle + count. TikTok ships
    /// themes that do not follow prefers-color-scheme, so computed values
    /// beat any static guess; the CSS vars remain the fallback.
    SiteAdapterManager.prototype.sampleTikTokTheme = function(share, item) {
        try {
            var circle = share.closest("button, [role='button']") || share;
            for (var depth = 0; circle && depth < 3; depth += 1) {
                var style = window.getComputedStyle(circle);
                var radius = style.borderRadius.indexOf("%") >= 0 || (parseFloat(style.borderRadius) || 0) >= 20;
                if (radius) {
                    if (style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)") {
                        item.style.setProperty("--ndm-tt-circle-bg", style.backgroundColor);
                    }
                    if (style.color) item.style.setProperty("--ndm-tt-circle-ink", style.color);
                    if (parseFloat(style.width) > 0 && parseFloat(style.height) > 0) {
                        item.style.setProperty("--ndm-tt-circle-size", style.width);
                    }
                    break;
                }
                circle = circle.firstElementChild;
            }
            var count = document.querySelector('[data-e2e="share-count"], [data-e2e$="-count"]');
            if (count) {
                var countStyle = window.getComputedStyle(count);
                if (countStyle.color) item.style.setProperty("--ndm-tt-label", countStyle.color);
                if (parseFloat(countStyle.fontSize) > 0) item.style.setProperty("--ndm-tt-label-size", countStyle.fontSize);
                if (countStyle.fontWeight) item.style.setProperty("--ndm-tt-label-weight", countStyle.fontWeight);
            }
        } catch (_) {
            // Static CSS fallbacks already cover this.
        }
    };

    SiteAdapterManager.prototype.scanTikTok = function() {
        var pageURL = canonicalTikTokURL(window.location.href);
        if (!pageURL || !document.querySelector("video")) return;
        var share = document.querySelector('[data-e2e="share-icon"], [data-e2e="video-share"], [data-e2e="browse-share-group"]');
        if (!share) return;
        var rail = this.tikTokRail(share) || share.closest("section") || share.parentElement;
        if (rail.querySelector('[data-better-ndm-site-action="tiktok"]')) return;
        var item = this.makeButton("tiktok", function() { return canonicalTikTokURL(window.location.href) || pageURL; });
        this.sampleTikTokTheme(share, item);
        rail.appendChild(item);
        this.notifyActionReady();
    };

    SiteAdapterManager.prototype.scanDouyin = function() {
        var pageURL = canonicalDouyinURL(window.location.href);
        if (!pageURL || !document.querySelector("video")) return;
        var actions = document.querySelector('[data-e2e="video-action-bar"], [class*="video-action"], [class*="action-bar"]');
        this.addInlineAction(actions, "douyin", function() { return canonicalDouyinURL(window.location.href) || pageURL; });
    };

    SiteAdapterManager.prototype.addInlineAction = function(actions, site, urlProvider) {
        if (!actions || actions.querySelector('[data-better-ndm-site-action="' + site + '"]')) return;
        var wrapper = document.createElement("span");
        wrapper.className = "better-ndm-site-inline-action";
        wrapper.dataset.betterNdmSiteAction = site + "-wrapper";
        wrapper.appendChild(this.makeButton(site, urlProvider));
        actions.appendChild(wrapper);
        this.notifyActionReady();
    };

    SiteAdapterManager.prototype.refresh = function() {
        var site = siteForURL(window.location.href);
        if (site === "bilibili") {
            if (!canonicalBilibiliURL(window.location.href)) this.scanBilibili();
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            if (this._biliPoll) clearTimeout(this._biliPoll);
            this._biliPoll = null;
            this._biliWatching = false;
            var manager = this;
            // SPA navigations re-hydrate the toolbar; re-attach after a beat.
            setTimeout(function() { manager.watchBilibiliToolbar(); }, 400);
            return;
        }
        this.schedule();
    };

    SiteAdapterManager.prototype.destroy = function() {
        if (this.observer) this.observer.disconnect();
        if (this.timer) clearTimeout(this.timer);
        if (this._biliPoll) clearTimeout(this._biliPoll);
        if (this._biliResize && typeof window !== "undefined") {
            window.removeEventListener("resize", this._biliResize);
            this._biliResize = null;
        }
        this.observer = null;
        this.timer = null;
        this._biliPoll = null;
        this._biliWatching = false;
    };

    function install(options) {
        return new SiteAdapterManager(options);
    }

    return {
        canonicalPageURL: canonicalPageURL,
        canonicalBilibiliURL: canonicalBilibiliURL,
        canonicalDouyinURL: canonicalDouyinURL,
        canonicalInstagramURL: canonicalInstagramURL,
        canonicalTikTokURL: canonicalTikTokURL,
        canonicalVimeoURL: canonicalVimeoURL,
        canonicalXURL: canonicalXURL,
        canonicalYouTubeURL: canonicalYouTubeURL,
        crowdingScore: crowdingScore,
        fitChipMode: fitChipMode,
        hasInlineAction: hasInlineAction,
        install: install,
        pageURLForElement: pageURLForElement,
        prefersInlineUI: prefersInlineUI,
        siteForURL: siteForURL
    };
});
