const test = require("node:test");
const assert = require("node:assert/strict");
const adapters = require("../site-adapters.js");

test("recognizes supported high-frequency video hosts", () => {
    assert.equal(adapters.siteForURL("https://x.com/home"), "x");
    assert.equal(adapters.siteForURL("https://mobile.twitter.com/user/status/1"), "x");
    assert.equal(adapters.siteForURL("https://www.youtube.com/watch?v=abc"), "youtube");
    assert.equal(adapters.siteForURL("https://www.bilibili.com/video/BV1abc"), "bilibili");
    assert.equal(adapters.siteForURL("https://vimeo.com/123"), "vimeo");
    assert.equal(adapters.siteForURL("https://www.instagram.com/reel/abc/"), "instagram");
    assert.equal(adapters.siteForURL("https://www.tiktok.com/@user/video/123"), "tiktok");
    assert.equal(adapters.siteForURL("https://www.douyin.com/video/123"), "douyin");
    assert.equal(adapters.siteForURL("https://example.com/video"), "");
});

test("canonicalizes Bilibili, Vimeo, Instagram, TikTok, and Douyin page links", () => {
    assert.equal(
        adapters.canonicalBilibiliURL("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333"),
        "https://www.bilibili.com/video/BV1GJ411x7h7"
    );
    assert.equal(
        adapters.canonicalVimeoURL("https://player.vimeo.com/video/76979871?autoplay=1"),
        "https://vimeo.com/76979871"
    );
    assert.equal(
        adapters.canonicalInstagramURL("https://www.instagram.com/reel/C9Example/?utm_source=ig_web_copy_link"),
        "https://www.instagram.com/reel/C9Example/"
    );
    assert.equal(
        adapters.canonicalTikTokURL("https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en"),
        "https://www.tiktok.com/@scout2015/video/6718335390845095173"
    );
    assert.equal(
        adapters.canonicalDouyinURL("https://www.douyin.com/video/7351234567890123456?modeFrom=userPost"),
        "https://www.douyin.com/video/7351234567890123456"
    );
});

test("extracts a canonical X status URL instead of an analytics or media URL", () => {
    assert.equal(
        adapters.canonicalPageURL("https://x.com/home", [
            "https://x.com/example/status/123/analytics",
            "https://video.twimg.com/media/file.mp4"
        ]),
        "https://x.com/example/status/123"
    );
});

test("canonicalizes YouTube watch, short, live, and youtu.be links", () => {
    assert.equal(
        adapters.canonicalYouTubeURL("https://www.youtube.com/watch?v=abc123&list=PL1&t=20"),
        "https://www.youtube.com/watch?v=abc123"
    );
    assert.equal(
        adapters.canonicalYouTubeURL("https://www.youtube.com/shorts/short123?feature=share"),
        "https://www.youtube.com/shorts/short123"
    );
    assert.equal(
        adapters.canonicalYouTubeURL("https://www.youtube.com/live/live123?si=token"),
        "https://www.youtube.com/live/live123"
    );
    assert.equal(
        adapters.canonicalYouTubeURL("https://youtu.be/abc123?t=9"),
        "https://www.youtube.com/watch?v=abc123"
    );
});

test("page-level adapters prefer in-page UI without waiting for inject", () => {
    assert.equal(adapters.prefersInlineUI("https://www.bilibili.com/video/BV1abc"), true);
    assert.equal(adapters.prefersInlineUI("https://www.youtube.com/watch?v=abc"), true);
    assert.equal(adapters.prefersInlineUI("https://www.bilibili.com/"), false);
    assert.equal(adapters.prefersInlineUI("https://app.bilibili.com/"), false);
    assert.equal(adapters.prefersInlineUI("https://x.com/user/status/123"), false);
    assert.equal(adapters.prefersInlineUI("https://example.com/watch"), false);
});

test("suppresses a floating candidate only after the nearby native action exists", () => {
    const button = {};
    const article = {
        querySelector(selector) {
            return selector === '[data-better-ndm-site-action="x"]' ? button : null;
        }
    };
    const video = { closest: selector => selector === "article" ? article : null };
    assert.equal(adapters.hasInlineAction(video, "https://x.com/user/status/123"), true);
    assert.equal(adapters.hasInlineAction({ closest: () => null }, "https://x.com/user/status/123"), false);
});

test("uses the page action for single-video sites and keeps a fallback when injection failed", () => {
    const withAction = {
        querySelector(selector) {
            return selector === '[data-better-ndm-site-action="youtube"]' ? {} : null;
        }
    };
    const withoutAction = { querySelector: () => null };
    assert.equal(adapters.hasInlineAction(null, "https://www.youtube.com/watch?v=abc", withAction), true);
    assert.equal(adapters.hasInlineAction(null, "https://www.youtube.com/watch?v=abc", withoutAction), false);
    assert.equal(adapters.hasInlineAction("https://www.youtube.com/watch?v=abc", undefined, withAction), true);
    assert.equal(adapters.hasInlineAction(null, "https://www.bilibili.com/video/BV1abc", {
        querySelector(selector) {
            return selector === '[data-better-ndm-site-action="bilibili"]' ? {} : null;
        }
    }), true);
});

test("treats a lone location href as the page URL when checking page-level injects", () => {
    const withAction = {
        querySelector(selector) {
            return selector === '[data-better-ndm-site-action="bilibili"]' ? {} : null;
        }
    };
    assert.equal(adapters.hasInlineAction("https://www.bilibili.com/video/BV1abc", undefined, withAction), true);
});

// MARK: - Toolbar crowding
//
// The 记笔记 bug: Bilibili's right-hand cluster has a fixed width budget, so
// inserting the NDM chip displaced a native item. It only reproduced in a normal
// profile because 记笔记 requires login — incognito had one fewer item and
// happened to fit. These tests pin the rule that decides how much room we take.

/// Minimal duck-typed row. `width` is the visible budget; each item declares the
/// width it wants, and items are laid out left to right from `left`.
function row(options) {
    const left = options.left ?? 0;
    const width = options.width;
    let cursor = left;
    const children = options.items.map((item) => {
        const wants = item.wants;
        // A squeezed item reports content wider than the box it was given.
        const given = Math.min(wants, Math.max(0, left + width - cursor));
        // Freeze the edge now: `cursor` keeps moving, and closing over it would
        // report every item as sitting at the end of the row.
        const edge = cursor + given;
        const node = {
            dataset: item.ours ? { betterNdmSiteAction: "bilibili-wrapper" } : {},
            scrollWidth: wants,
            clientWidth: given,
            getBoundingClientRect: () => ({ right: edge })
        };
        cursor += given;
        return node;
    });
    return {
        children,
        scrollWidth: Math.max(width, cursor - left),
        clientWidth: width,
        getBoundingClientRect: () => ({ right: left + width })
    };
}

test("an uncrowded row scores zero", () => {
    const container = row({ width: 300, items: [{ wants: 100 }, { wants: 80 }] });
    assert.equal(adapters.crowdingScore(container, (n) => Boolean(n.dataset.betterNdmSiteAction)), 0);
});

test("a native item squeezed below its content width is heavily penalised", () => {
    // 120 + 120 wanted in a 200px row: the second item gets 80 and is squeezed.
    const container = row({ width: 200, items: [{ wants: 120 }, { wants: 120 }] });
    assert.ok(
        adapters.crowdingScore(container, () => false) >= 1000,
        "clipping a native item must dominate the score, not read as a few pixels"
    );
});

test("our own chip being clipped never counts against us", () => {
    const container = row({ width: 200, items: [{ wants: 120 }, { wants: 120, ours: true }] });
    const isOurs = (node) => Boolean(node.dataset.betterNdmSiteAction);
    assert.ok(
        adapters.crowdingScore(container, isOurs) < 1000,
        "we are allowed to be the one that suffers"
    );
});

test("keeps the labelled chip when the row has room for it", () => {
    const scores = { yield: 0, labelled: 0, compact: 0 };
    const mode = adapters.fitChipMode(scores.yield, (m) => scores[m]);
    assert.equal(mode, "labelled");
});

test("drops the label rather than displacing a native item", () => {
    // Labelled overflows and squeezes 记笔记; icon-only fits.
    const scores = { yield: 0, labelled: 1000, compact: 0 };
    const applied = [];
    const mode = adapters.fitChipMode(scores.yield, (m) => {
        applied.push(m);
        return scores[m];
    });
    assert.equal(mode, "compact");
    assert.deepEqual(applied, ["labelled", "compact"], "must try the richer mode first");
});

test("concedes the slot entirely when even the icon does not fit", () => {
    const scores = { yield: 0, labelled: 2000, compact: 1000 };
    const applied = [];
    const mode = adapters.fitChipMode(scores.yield, (m) => {
        applied.push(m);
        return scores[m];
    });
    assert.equal(mode, "yield");
    assert.equal(applied[applied.length - 1], "yield", "must actually re-apply yield, not just report it");
});

test("an already-crowded row is judged against itself, not against zero", () => {
    // Bilibili's own layout is sometimes tight before we arrive. We must not read
    // that pre-existing crowding as our fault and hide forever.
    const baseline = 1000;
    const mode = adapters.fitChipMode(baseline, (m) => (m === "labelled" ? 1000 : 0));
    assert.equal(mode, "labelled", "matching the baseline means we took nothing away");
});
