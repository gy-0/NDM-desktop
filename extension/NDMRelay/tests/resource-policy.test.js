const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../resource-policy.js");

test("discovers an embedded PDF as an explicit resource, not an automatic download", () => {
    const candidate = policy.candidateFromResponse({
        1: "GET",
        2: "https://cdn.example.com/viewer/source?id=42",
        7: 4_194_304,
        8: "application/pdf; charset=binary",
        requestType: "xmlhttprequest",
        fileName: "research-paper.pdf"
    });

    assert.equal(candidate.fileName, "research-paper.pdf");
    assert.equal(candidate.fEx, "pdf");
    assert.equal(candidate.resourceKind, "document");
    assert.equal(candidate[6], "normal");
    assert.equal(policy.describeResource(candidate), "PDF · 4.0 MB · cdn.example.com");
});

test("recognizes office, ebook, archive, and Mac installer resources", () => {
    const fixtures = [
        ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
        ["application/epub+zip", "epub"],
        ["application/x-7z-compressed", "7z"],
        ["application/x-apple-diskimage", "dmg"]
    ];
    fixtures.forEach(([contentType, extension]) => {
        const candidate = policy.candidateFromResponse({
            2: "https://example.com/resource/asset",
            8: contentType,
            requestType: "object"
        });
        assert.equal(candidate.fEx, extension);
        assert.match(candidate.fileName, new RegExp("\\." + extension + "$", "i"));
    });
});

test("rejects scripts, images, video fragments, and unknown DAT/BIN files", () => {
    [
        { 2: "https://example.com/app.js", 8: "text/javascript", requestType: "xmlhttprequest" },
        { 2: "https://example.com/cover.png", 8: "image/png", requestType: "image" },
        { 2: "https://example.com/part-2.ts", 8: "video/mp2t", requestType: "media" },
        { 2: "https://example.com/cache.dat", 8: "application/octet-stream", requestType: "other" },
        { 2: "https://example.com/model.bin", 8: "application/octet-stream", requestType: "xmlhttprequest" }
    ].forEach(meta => assert.equal(policy.candidateFromResponse(meta), null));
});

test("deduplicates range and signed variants while preserving the best metadata", () => {
    const small = policy.candidateFromResponse({
        2: "https://files.example.com/book.pdf?range=0-999&token=old",
        7: 1000,
        8: "application/pdf",
        requestType: "xmlhttprequest"
    });
    const complete = policy.candidateFromResponse({
        2: "https://files.example.com/book.pdf?range=0-999999&token=new",
        7: 1_000_000,
        8: "application/pdf",
        requestType: "xmlhttprequest",
        fileName: "The Book.pdf",
        isAttachment: true
    });
    const result = policy.compactResources([small, complete]);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, "The Book.pdf");
    assert.equal(result[0][7], 1_000_000);
});

test("collapses independently signed S3 URLs for the same resource path", () => {
    const first = policy.candidateFromResponse({
        2: "https://bucket.example.com/report.pdf?X-Amz-Credential=one&X-Amz-Date=20260721T010000Z&X-Amz-Signature=aaa",
        8: "application/pdf",
        requestType: "xmlhttprequest"
    });
    const second = policy.candidateFromResponse({
        2: "https://bucket.example.com/report.pdf?X-Amz-Credential=two&X-Amz-Date=20260721T020000Z&X-Amz-Signature=bbb",
        8: "application/pdf",
        requestType: "xmlhttprequest"
    });
    assert.equal(policy.compactResources([first, second]).length, 1);
});

test("collapses mirrored viewer URLs when filename type and meaningful size agree", () => {
    const viewer = policy.candidateFromResponse({
        2: "https://viewer.example.com/fetch?id=42&token=old",
        7: 4_194_304,
        8: "application/pdf",
        requestType: "xmlhttprequest",
        fileName: "Research Paper.pdf"
    });
    const cdn = policy.candidateFromResponse({
        2: "https://cdn.example.net/files/research-paper.pdf?signature=new",
        7: 4_194_304,
        8: "application/pdf",
        requestType: "object",
        fileName: "Research Paper.pdf",
        isAttachment: true
    });

    const result = policy.compactResources([viewer, cdn]);
    assert.equal(result.length, 1);
    assert.equal(result[0].isAttachment, true);
    assert.match(result[0][2], /^https:\/\/cdn\.example\.net/);
});

test("same filenames without a reliable size stay separate", () => {
    const first = policy.candidateFromResponse({
        2: "https://one.example.com/report.pdf",
        8: "application/pdf",
        requestType: "object"
    });
    const second = policy.candidateFromResponse({
        2: "https://two.example.com/report.pdf",
        8: "application/pdf",
        requestType: "object"
    });

    assert.equal(policy.compactResources([first, second]).length, 2);
});

test("rejects bilibili telemetry web.txt and other tiny noise", () => {
    assert.equal(policy.candidateFromResponse({
        2: "https://data.bilibili.com/log/web?event=1",
        7: 2,
        8: "text/plain",
        requestType: "xmlhttprequest",
        fileName: "web.txt"
    }), null);
    assert.equal(policy.candidateFromResponse({
        2: "https://cdn.example.com/notes/web.txt",
        7: 2,
        8: "text/plain",
        requestType: "xmlhttprequest"
    }), null);
    assert.equal(policy.candidateFromResponse({
        2: "https://cdn.example.com/beacon.txt",
        7: 4096,
        8: "text/plain",
        requestType: "xmlhttprequest"
    }), null);
    assert.equal(policy.isNoiseHost("data.bilibili.com"), true);
    assert.equal(policy.isNoiseFilename("web.txt"), true);
});

test("keeps real installers and documents above the size floor", () => {
    const dmg = policy.candidateFromResponse({
        2: "https://dl.hdslb.com/mobile/fixed/pc_electron_mac/bili_mac.dmg?v=1.17.9",
        7: 120_000_000,
        8: "application/x-apple-diskimage",
        requestType: "main_frame",
        fileName: "bili_mac.dmg"
    });
    assert.equal(dmg.fEx, "dmg");
    assert.match(dmg[2], /bili_mac\.dmg/);
    assert.equal(dmg[6], "normal");

    const pdf = policy.candidateFromResponse({
        2: "https://files.example.com/report.pdf",
        7: 50_000,
        8: "application/pdf",
        requestType: "object"
    });
    assert.equal(pdf.fEx, "pdf");

    assert.equal(policy.candidateFromResponse({
        2: "https://files.example.com/tiny.pdf",
        7: 200,
        8: "application/pdf",
        requestType: "xmlhttprequest"
    }), null);
});

test("plain txt without attachment stays off the shelf", () => {
    assert.equal(policy.candidateFromResponse({
        2: "https://files.example.com/readme.txt",
        7: 12_000,
        8: "text/plain",
        requestType: "xmlhttprequest"
    }), null);
    const attached = policy.candidateFromResponse({
        2: "https://files.example.com/readme.txt",
        7: 12_000,
        8: "text/plain",
        requestType: "main_frame",
        isAttachment: true,
        fileName: "readme.txt"
    });
    assert.equal(attached.fEx, "txt");
});

test("background text attachments stay hidden even when a site names them like files", () => {
    ["json.txt", "f.txt"].forEach(fileName => {
        assert.equal(policy.candidateFromResponse({
            2: "https://www.youtube.com/api/stats/" + fileName,
            7: 12_000,
            8: "text/plain",
            requestType: "xmlhttprequest",
            isAttachment: true,
            fileName
        }), null);
    });
});
