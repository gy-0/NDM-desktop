const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) {
    return fs.readFileSync(path.join(__dirname, "..", name), "utf8");
}

test("manifest wires the popup, localized identity, and full icon set", () => {
    const manifest = JSON.parse(source("manifest.json"));
    assert.equal(manifest.action.default_popup, "popup.html");
    assert.equal(manifest.default_locale, "zh_CN");
    assert.equal(manifest.name, "__MSG_extName__");
    assert.equal(manifest.description, "__MSG_extDescription__");
    assert.deepEqual(Object.keys(manifest.action.default_icon).sort(), ["128", "16", "48"]);
});

test("popup is self-contained and CSP-safe (no inline script)", () => {
    const html = source("popup.html");
    assert.match(html, /<link rel="stylesheet" href="popup\.css"/);
    assert.match(html, /<script src="popup\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>[^<]/);
    assert.doesNotMatch(html, /onclick=/i);
});

test("popup speaks the background contract and probes the bridge itself", () => {
    const popup = source("popup.js");
    assert.match(popup, /relay:getState/);
    assert.match(popup, /relay:toggleCatcher/);
    assert.match(popup, /relay:showMediaPanel/);
    assert.match(popup, /relay:downloadResource/);
    assert.match(popup, /ws:\/\/127\.0\.0\.1:51873\/ndm\/download/);
    assert.match(popup, /ndm\.open\.v1/);
    assert.match(popup, /ndm:\/\/open\/relay/);
    assert.match(popup, /chrome\.tabs\.create/);
});

test("popup exposes localized names and announces dynamic status", () => {
    const html = source("popup.html");
    const popup = source("popup.js");
    assert.match(html, /<title data-i18n="extName">NDM Relay<\/title>/);
    assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
    assert.match(html, /id="catcher"[^>]*data-i18n-aria-label="popupCatcherTitle"[^>]*aria-describedby="catcher-sub"/);
    assert.match(html, /class="brand" translate="no"/);
    assert.match(popup, /chrome\.i18n\.getUILanguage\(\)/);
    assert.match(popup, /document\.documentElement\.lang = uiLanguage/);
    assert.match(popup, /\[data-i18n-aria-label\]/);
});

test("popup pins its toolbar width and keeps practical pointer targets", () => {
    const css = source("popup.css");
    assert.match(css, /body\s*\{[^}]*width:\s*292px/s);
    assert.doesNotMatch(css, /body\s*\{[^}]*width:[^;}]*(?:vw|dvw|svw)/s);
    assert.match(css, /\.btn\s*\{[^}]*min-height:\s*40px/s);
    assert.match(css, /\.switch::after\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s);
    assert.match(css, /#media-card\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*stretch/s);
    assert.match(css, /#media-card \.btn-accent\s*\{[^}]*width:\s*100%[^}]*white-space:\s*normal/s);
    assert.match(css, /@media\s*\(max-width:\s*220px\)[\s\S]*\.foot-row\s*\{[^}]*flex-direction:\s*column/);
    assert.match(css, /\.btn-quiet\s*\{[^}]*width:\s*100%[^}]*white-space:\s*normal/s);
});

test("background answers every popup message type", () => {
    const background = source("bg.js");
    assert.match(background, /relay:getState/);
    assert.match(background, /relay:toggleCatcher/);
    assert.match(background, /relay:showMediaPanel/);
    assert.match(background, /relay:downloadResource/);
    assert.match(background, /chrome\.runtime\.onMessage\.addListener/);
});

test("background queues relay items while NDM is still launching", () => {
    const background = source("bg.js");
    assert.match(background, /this\.pendingRelayQueue = \[\]/);
    // Enqueue instead of the old single-slot overwrite.
    assert.match(background, /this\.pendingRelayQueue\.push\(a\), this\.M\(\)/);
    // Flush on open, clear on close/error, and never stack sockets.
    assert.match(background, /var a = this\.pendingRelayQueue;\s*\n\s*this\.pendingRelayQueue = \[\];/);
    assert.match(background, /0 == this\.G\.readyState \|\| 1 == this\.G\.readyState/);
});

test("both locales parse and expose the same keys, covering popup i18n hooks", () => {
    const zh = JSON.parse(source("_locales/zh_CN/messages.json"));
    const en = JSON.parse(source("_locales/en/messages.json"));
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    const html = source("popup.html");
    for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
        assert.ok(zh[match[1]], `zh_CN missing key ${match[1]}`);
    }
    for (const key of ["ctxDownload", "ctxShowPanel", "ctxToggleCatcher", "popupConnected", "popupOffline", "popupMediaCount"]) {
        assert.ok(zh[key] && en[key], `missing ${key}`);
    }
});

test("localized media actions describe outcomes instead of implementation controls", () => {
    const zh = JSON.parse(source("_locales/zh_CN/messages.json"));
    const en = JSON.parse(source("_locales/en/messages.json"));
    assert.equal(zh.popupShowControls.message, "显示下载选项");
    assert.equal(en.popupShowControls.message, "Show download options");
    assert.equal(zh.ctxShowPanel.message, "显示视频下载选项");
    assert.equal(en.ctxShowPanel.message, "Show video download options");
    assert.doesNotMatch(zh.popupContextHint.message, /任意|→|[“”]/);
    assert.doesNotMatch(en.popupContextHint.message, /any|→|[\"“”]/i);
});
