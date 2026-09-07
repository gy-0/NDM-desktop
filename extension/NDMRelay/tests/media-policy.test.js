const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../media-policy.js");

test("binary and DAT subresources never trigger automatic download interception", () => {
    assert.equal(policy.shouldInterceptNavigation({
        requestType: "other",
        extension: "dat",
        isForceDownload: true,
        isUnknownBinary: true
    }), false);
    assert.equal(policy.shouldInterceptNavigation({
        requestType: "xmlhttprequest",
        extension: "bin",
        isAttachment: true,
        isUnknownBinary: true
    }), false);
});

test("suspicious data files stay opt-in even when opened as a top-level navigation", () => {
    assert.equal(policy.shouldInterceptNavigation({
        requestType: "main_frame",
        extension: "dat",
        isAttachment: true,
        isUnknownBinary: true
    }), false);
});

test("only suspicious hidden downloads are cancelled from Chrome", () => {
    assert.equal(policy.shouldCancelUnexpectedBrowserDownload({
        requestType: "other",
        extension: "dat",
        isForceDownload: true,
        isUnknownBinary: true
    }), true);
    assert.equal(policy.shouldCancelUnexpectedBrowserDownload({
        requestType: "main_frame",
        extension: "dat",
        isAttachment: true,
        isUnknownBinary: true
    }), false);
    assert.equal(policy.shouldCancelUnexpectedBrowserDownload({
        requestType: "sub_frame",
        extension: "zip",
        isAttachment: true
    }), false);
});

test("intentional top-level media and attachment navigations are still intercepted", () => {
    assert.equal(policy.shouldInterceptNavigation({
        requestType: "main_frame",
        extension: "mp4",
        isMedia: true
    }), true);
    assert.equal(policy.shouldInterceptNavigation({
        requestType: "main_frame",
        extension: "zip",
        isAttachment: true
    }), true);
    assert.equal(policy.shouldInterceptNavigation({
        requestType: "sub_frame",
        extension: "zip",
        isAttachment: true
    }), false);
});

test("Twitter-style variants collapse to one recommended page download plus clear alternatives", () => {
    const page = {
        id: 1,
        2: "https://x.com/example/status/123",
        fEx: "mp4",
        betterPageResolver: true
    };
    const fragment = {
        id: 2,
        2: "https://video.twimg.com/chunk/segment_00291.ts?range=0-999",
        fEx: "ts",
        fS: 400_000,
        6: "media"
    };
    const smaller720p = {
        id: 3,
        2: "https://video.twimg.com/video-720.mp4?token=old",
        fEx: "mp4",
        fS: 8_000_000,
        4: "MP4 File 720p"
    };
    const larger720p = {
        id: 4,
        2: "https://video.twimg.com/video-720.mp4?token=new",
        fEx: "mp4",
        fS: 12_000_000,
        4: "MP4 File 720p"
    };
    const audio = {
        id: 5,
        2: "https://video.twimg.com/audio.m4a",
        fEx: "m4a",
        8: "audio/mp4",
        fS: 2_000_000
    };

    const result = policy.compactCandidates([
        fragment,
        smaller720p,
        page,
        audio,
        larger720p
    ]);

    assert.deepEqual(result.map(item => item.id), [1, 4, 5]);
    assert.equal(policy.describeCandidate(result[0], {
        locale: "zh-CN",
        recommended: true
    }), "推荐 · 选择画质并下载");
    assert.match(policy.describeCandidate(result[1], {
        locale: "zh-CN"
    }), /^视频文件 · 720p · MP4/);
    assert.match(policy.describeCandidate(result[2], {
        locale: "zh-CN"
    }), /^仅音频 · M4A/);

    assert.deepEqual(policy.candidatePresentation(result[0], {
        locale: "zh-CN",
        recommended: true
    }), {
        title: "智能选择最佳版本",
        meta: "由 NDM 解析画质并完成下载",
        badge: "首选",
        kind: "resolver",
        quality: 0
    });
    assert.deepEqual(policy.candidatePresentation(result[1], {
        locale: "zh-CN"
    }), {
        title: "720p 视频",
        meta: "MP4 · 11 MB",
        badge: "",
        kind: "video",
        quality: 720
    });
    assert.deepEqual(policy.candidatePresentation(result[2], {
        locale: "en-US"
    }), {
        title: "Audio only",
        meta: "M4A · 1.9 MB",
        badge: "",
        kind: "audio",
        quality: 0
    });
});

test("raw transport fragments are not offered as standalone videos", () => {
    const result = policy.compactCandidates([{
        id: 1,
        2: "https://cdn.example.com/fragments/part-0042.ts",
        fEx: "ts",
        fS: 512_000,
        6: "media"
    }]);
    assert.deepEqual(result, []);
});

test("a page resolver suppresses even large unnumbered raw TS responses", () => {
    const page = {
        id: 1,
        2: "https://x.com/example/status/123",
        fEx: "mp4",
        betterPageResolver: true
    };
    const rawTransport = {
        id: 2,
        2: "https://video.twimg.com/media/stream.ts",
        fEx: "ts",
        fS: 20_000_000,
        6: "media"
    };

    assert.deepEqual(policy.compactCandidates([rawTransport, page]).map(item => item.id), [1]);
});

test("an explicitly identified HLS rendition remains a usable fallback", () => {
    const page = {
        id: 1,
        2: "https://x.com/example/status/123",
        fEx: "mp4",
        betterPageResolver: true
    };
    const hls = {
        id: 2,
        2: "https://video.twimg.com/media/master.m3u8",
        fEx: "m3u8",
        6: "hls"
    };

    assert.deepEqual(policy.compactCandidates([hls, page]).map(item => item.id), [1, 2]);
});

test("signed CDN variants of the same rendition collapse even when volatile keys use mixed case", () => {
    const older = {
        id: 1,
        2: "https://cdn.example.com/video.mp4?X-Amz-Signature=old&X-Amz-Date=20260721T010000Z",
        fEx: "mp4",
        fS: 8_000_000
    };
    const newer = {
        id: 2,
        2: "https://cdn.example.com/video.mp4?X-Amz-Signature=new&X-Amz-Date=20260721T020000Z",
        fEx: "mp4",
        fS: 12_000_000
    };

    assert.deepEqual(policy.compactCandidates([older, newer]).map(item => item.id), [2]);
});
