const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldDeferFileDownload: defer, shouldInterceptNavigation: intercept } = require('../media-policy.js');
const file = { requestType: 'sub_frame', method: 'GET', extension: 'zip', contentType: 'application/zip', isAttachment: true, isUnknownBinary: true };
test('ordinary GET archive/installers in iframe or other become candidates, never header-only interceptions', () => {
    for (const requestType of ['sub_frame', 'other']) for (const extension of ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'dmg', 'pkg', 'exe', 'msi', 'iso', 'epub', 'jar']) {
        const meta = { ...file, requestType, extension, contentType: 'application/octet-stream' };
        assert.equal(defer(meta), true, requestType + ':' + extension);
        assert.equal(intercept(meta), false, 'A header alone must not become an automatic download');
    }
    assert.equal(intercept({ ...file, requestType: 'main_frame' }), true);
    assert.equal(defer({ ...file, requestType: 'main_frame' }), false);
});
test('normal resources, methods, media and opaque data do not become deferred downloads', () => {
    for (const requestType of ['xmlhttprequest', 'media', 'image', 'object', 'script', 'stylesheet']) assert.equal(defer({ ...file, requestType }), false);
    for (const method of ['POST', 'HEAD', 'PUT', '']) assert.equal(defer({ ...file, method }), false);
    for (const extension of ['bin', 'dat', 'blob', 'part', 'tmp', 'ts', 'm4s', 'mp4', 'mp3', 'm3u8', 'json', 'html', 'pdf', 'unknown']) assert.equal(defer({ ...file, extension }), false);
    for (const flag of ['isMedia', 'isStreamSegment', 'isKnownNonDownload']) assert.equal(defer({ ...file, [flag]: true }), false);
});
test('a ZIP-looking name does not override a webpage or media response type', () => {
    for (const contentType of ['text/html; charset=utf-8', 'text/plain', 'application/json', 'application/vnd.api+json', 'application/xhtml+xml', 'application/javascript', 'application/dash+xml', 'application/pdf', 'image/png', 'video/mp4', 'audio/mpeg']) assert.equal(defer({ ...file, contentType }), false, contentType);
    assert.equal(defer({ ...file, contentType: '' }), true, 'The real DownloadItem, not a guessed MIME, is the final gate');
});
