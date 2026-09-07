(function(root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.NDMRelayMediaPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    var STREAM_EXTENSIONS = /^(?:f4f|mpegts|ts|mp2t)$/i;
    var SUSPICIOUS_DATA_EXTENSIONS = /^(?:bin|blob|dat|map|part|tmp)$/i;
    var VIDEO_EXTENSIONS = /^(?:avi|flv|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;
    var AUDIO_EXTENSIONS = /^(?:aac|flac|m4a|mp3|oga|ogg|wav|wma)$/i;
    var VOLATILE_QUERY_KEYS = /^(?:bytestart|byteend|range|rn|rbuf|sq|part|chunk|fragment|token|signature|sig|expires|policy|key-pair-id|googleaccessid|x-amz-.+)$/i;

    function value(item, key, fallback) {
        return item && item[key] !== undefined && item[key] !== null ? item[key] : fallback;
    }

    function urlFor(item) {
        return String(value(item, "2", value(item, "url", "")) || "");
    }

    function contentTypeFor(item) {
        return String(value(item, "8", value(item, "contentType", "")) || "")
            .split(";", 1)[0]
            .trim()
            .toLowerCase();
    }

    function extensionFor(item) {
        var explicit = String(value(item, "fEx", value(item, "extension", "")) || "")
            .replace(/^\./, "")
            .trim()
            .toLowerCase();
        if (explicit) return explicit;

        var type = contentTypeFor(item);
        if (type === "video/mp2t") return "ts";
        if (type === "video/mp4") return "mp4";
        if (type === "video/webm" || type === "audio/webm") return "webm";
        if (type === "audio/mp4") return "m4a";
        if (type.indexOf("audio/") === 0) return type.split("/").pop();

        try {
            var path = new URL(urlFor(item)).pathname;
            var name = path.split("/").pop() || "";
            return name.indexOf(".") >= 0 ? name.split(".").pop().toLowerCase() : "";
        } catch (_) {
            return "";
        }
    }

    function qualityFor(item) {
        var text = [
            value(item, "4", ""),
            value(item, "quality", ""),
            urlFor(item)
        ].join(" ");
        var matches = text.match(/(?:^|[^0-9])(144|240|360|480|540|576|720|1080|1440|2160)p?(?:[^0-9]|$)/ig);
        if (matches && matches.length) {
            var best = 0;
            matches.forEach(function(match) {
                var parsed = parseInt(match.replace(/\D/g, ""), 10);
                if (parsed > best) best = parsed;
            });
            return best;
        }
        var resolution = text.match(/(?:^|[^0-9])(\d{3,4})x(\d{3,4})(?:[^0-9]|$)/i);
        return resolution ? Math.min(parseInt(resolution[1], 10), parseInt(resolution[2], 10)) : 0;
    }

    function durationFor(item) {
        var raw = Number(value(item, "du", value(item, "duration", 0))) || 0;
        if (raw > 0) return raw;
        var text = String(value(item, "fDu", value(item, "4", "")) || "");
        var minutes = text.match(/(\d+(?:\.\d+)?)\s*min/i);
        var seconds = text.match(/(\d+(?:\.\d+)?)\s*sec/i);
        return (minutes ? parseFloat(minutes[1]) * 60 : 0) + (seconds ? parseFloat(seconds[1]) : 0);
    }

    function sizeFor(item) {
        return Number(value(item, "fS", value(item, "7", value(item, "size", 0)))) || 0;
    }

    function isPageResolver(item) {
        return Boolean(value(item, "betterPageResolver", false));
    }

    function isAudioOnly(item) {
        var type = contentTypeFor(item);
        var extension = extensionFor(item);
        var label = String(value(item, "4", "") || "");
        return value(item, "mme", "") === "audio" || type.indexOf("audio/") === 0 ||
            AUDIO_EXTENSIONS.test(extension) || /(?:audio|仅音频|音频)/i.test(label);
    }

    function isCombined(item) {
        return Boolean(value(item, "3", ""));
    }

    function isHLS(item) {
        return value(item, "6", "") === "hls" || /(?:m3u8|mpegurl)/i.test(extensionFor(item) + " " + contentTypeFor(item));
    }

    function isLikelyFragment(item) {
        if (isPageResolver(item) || isHLS(item)) return false;
        var extension = extensionFor(item);
        if (!STREAM_EXTENSIONS.test(extension)) return false;
        var url = urlFor(item);
        var path = "";
        try { path = new URL(url).pathname; } catch (_) { path = url; }
        if (/(?:^|[\/_-])(?:seg(?:ment)?|chunk|frag(?:ment)?|part|init)[\/_-]?\d+/i.test(path)) return true;
        if (/[?&](?:range|rn|rbuf|sq|bytestart|byteend)=/i.test(url)) return true;
        var size = sizeFor(item);
        return size > 0 && size < 2 * 1024 * 1024;
    }

    function canonicalURL(item) {
        var raw = urlFor(item);
        try {
            var parsed = new URL(raw);
            Array.from(parsed.searchParams.keys()).forEach(function(key) {
                if (VOLATILE_QUERY_KEYS.test(key)) parsed.searchParams.delete(key);
            });
            parsed.hash = "";
            return parsed.origin + parsed.pathname + (parsed.search ? parsed.search : "");
        } catch (_) {
            return raw.split("#", 1)[0];
        }
    }

    function semanticKey(item) {
        if (isPageResolver(item)) return "page:" + canonicalURL(item);
        var role = isCombined(item) ? "combined" : isAudioOnly(item) ? "audio" : isHLS(item) ? "hls" : "video";
        var quality = qualityFor(item);
        var duration = Math.round(durationFor(item));
        var extension = extensionFor(item);
        if (!quality && !duration) return [role, extension, canonicalURL(item)].join(":");
        return [role, extension, quality, duration].join(":");
    }

    function candidateScore(item) {
        var score = 0;
        if (isPageResolver(item)) score += 1000000;
        if (isCombined(item)) score += 50000;
        if (isHLS(item)) score += 30000;
        if (VIDEO_EXTENSIONS.test(extensionFor(item))) score += 20000;
        if (extensionFor(item) === "mp4") score += 5000;
        if (isAudioOnly(item)) score -= 30000;
        if (isLikelyFragment(item)) score -= 100000;
        score += qualityFor(item) * 10;
        var size = sizeFor(item);
        if (size > 0) score += Math.min(3000, Math.log(size) * 100);
        return score;
    }

    function compactCandidates(items, limit) {
        var bestByKey = Object.create(null);
        var hasPageResolver = (items || []).some(isPageResolver);
        (items || []).forEach(function(item) {
            if (!item || !urlFor(item) || isLikelyFragment(item)) return;
            // Once a social page can be resolved as one complete video, a raw
            // transport-stream URL is implementation noise, not a useful
            // format choice. Keep an explicitly identified HLS rendition as a
            // fallback, but never ask users to guess which naked TS is real.
            if (hasPageResolver && STREAM_EXTENSIONS.test(extensionFor(item)) && !isHLS(item)) return;
            var key = semanticKey(item);
            var current = bestByKey[key];
            if (!current || candidateScore(item) > candidateScore(current)) bestByKey[key] = item;
        });
        var result = Object.keys(bestByKey).map(function(key) { return bestByKey[key]; });
        result.sort(function(a, b) { return candidateScore(b) - candidateScore(a); });
        return result.slice(0, Math.max(1, Number(limit) || 6));
    }

    function formatSize(bytes, locale) {
        if (!bytes || bytes < 1) return "";
        var units = ["B", "KB", "MB", "GB"];
        var value = bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return (value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
    }

    function describeCandidate(item, options) {
        options = options || {};
        var zh = String(options.locale || "").toLowerCase().indexOf("zh") === 0;
        var recommended = Boolean(options.recommended);
        var quality = qualityFor(item);
        var extension = extensionFor(item).toUpperCase();
        var size = formatSize(sizeFor(item), options.locale);
        var parts = [];

        if (isPageResolver(item)) {
            return zh ? "推荐 · 选择画质并下载" : "Recommended · Choose quality and download";
        }
        if (isAudioOnly(item)) parts.push(zh ? "仅音频" : "Audio only");
        else if (isCombined(item)) parts.push(zh ? "完整视频" : "Complete video");
        else if (isHLS(item)) parts.push(zh ? "流媒体视频" : "Streaming video");
        else parts.push(zh ? "视频文件" : "Video file");
        if (recommended) parts.push(zh ? "推荐" : "Recommended");
        if (quality) parts.push(quality + "p");
        if (extension) parts.push(extension);
        if (size) parts.push(size);
        return parts.join(" · ");
    }

    function candidatePresentation(item, options) {
        options = options || {};
        var zh = String(options.locale || "").toLowerCase().indexOf("zh") === 0;
        var recommended = Boolean(options.recommended);
        var quality = qualityFor(item);
        var extension = extensionFor(item).toUpperCase();
        var size = formatSize(sizeFor(item), options.locale);
        var meta = [];

        if (isPageResolver(item)) {
            return {
                title: zh ? "智能选择最佳版本" : "Smart download",
                meta: zh ? "由 NDM 解析画质并完成下载" : "Let NDM resolve quality and download",
                badge: zh ? "首选" : "Best choice",
                kind: "resolver",
                quality: 0
            };
        }

        if (extension) meta.push(extension);
        if (size) meta.push(size);
        var title = isAudioOnly(item)
            ? (zh ? "仅音频" : "Audio only")
            : isCombined(item)
                ? (zh ? "完整视频" : "Complete video")
                : isHLS(item)
                    ? (zh ? "流媒体视频" : "Streaming video")
                    : (zh ? "视频文件" : "Video file");
        if (quality && !isAudioOnly(item)) {
            title = quality + "p " + (isHLS(item)
                ? (zh ? "流媒体" : "stream")
                : (zh ? "视频" : "video"));
        }
        return {
            title: title,
            meta: meta.join(" · ") || (zh ? "检测到的媒体源" : "Detected media source"),
            badge: recommended ? (zh ? "首选" : "Best choice") : "",
            kind: isAudioOnly(item) ? "audio" : "video",
            quality: quality
        };
    }

    function shouldInterceptNavigation(meta) {
        meta = meta || {};
        var extension = String(meta.extension || "").replace(/^\./, "").toLowerCase();
        if (String(meta.requestType || "") !== "main_frame") return false;
        if (meta.isStreamSegment || SUSPICIOUS_DATA_EXTENSIONS.test(extension)) return false;
        if (meta.isKnownNonDownload && !meta.isAttachment) return false;
        return Boolean(meta.isAttachment || meta.isForceDownload || meta.isMedia || meta.isUnknownBinary);
    }

    function shouldCancelUnexpectedBrowserDownload(meta) {
        meta = meta || {};
        var extension = String(meta.extension || "").replace(/^\./, "").toLowerCase();
        // A top-level navigation may be an explicit click. Never cancel it;
        // users can also intentionally send any such link from the context
        // menu. This guard is only for hidden/subresource-driven junk files.
        if (String(meta.requestType || "") === "main_frame") return false;
        if (!SUSPICIOUS_DATA_EXTENSIONS.test(extension)) return false;
        return Boolean(meta.isAttachment || meta.isForceDownload || meta.isUnknownBinary);
    }

    return {
        candidateScore: candidateScore,
        candidatePresentation: candidatePresentation,
        compactCandidates: compactCandidates,
        contentTypeFor: contentTypeFor,
        describeCandidate: describeCandidate,
        durationFor: durationFor,
        extensionFor: extensionFor,
        isAudioOnly: isAudioOnly,
        isHLS: isHLS,
        isLikelyFragment: isLikelyFragment,
        isPageResolver: isPageResolver,
        qualityFor: qualityFor,
        semanticKey: semanticKey,
        shouldCancelUnexpectedBrowserDownload: shouldCancelUnexpectedBrowserDownload,
        shouldInterceptNavigation: shouldInterceptNavigation,
        sizeFor: sizeFor,
        urlFor: urlFor
    };
});
