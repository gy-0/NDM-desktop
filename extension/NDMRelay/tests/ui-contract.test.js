const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) {
    return fs.readFileSync(path.join(__dirname, "..", name), "utf8");
}

test("page resources live in the toolbar popup instead of an injected overlay", () => {
    const manifest = JSON.parse(source("manifest.json"));
    const scripts = manifest.content_scripts.flatMap(entry => entry.js || []);
    const popup = source("popup.html");
    assert.equal(scripts.includes("resource-shelf.js"), false);
    assert.equal(scripts.includes("resource-policy.js"), false);
    assert.match(popup, /id="resource-card"/);
    assert.match(popup, /id="resource-list"/);
});

test("generic media control gets out of the way and remains toolbar-recoverable", () => {
    const content = source("ct.js");
    assert.match(content, /backdrop-filter:blur\(16px\)/);
    assert.match(content, /prefers-reduced-transparency:reduce/);
    assert.match(content, /badgeLabel\.innerText = "NDM"/);
    assert.match(content, /style\.opacity = 0/);
    assert.match(content, /showAllPanels/);
    assert.match(content, /postMessage\(\[21,/);
    assert.doesNotMatch(content, /style\.opacity = 0\.82/);
    // Adapted sites hide the float once the in-page action exists; pass the
    // media node so X/Instagram can scope, and never resurrect via toolbar pin.
    assert.match(content, /hasInlineAction\(this\.m,\s*href\)|hasInlineAction\(this\.m,\s*window\.location\.href\)/);
    assert.match(content, /prefersInlineUI\(window\.location\.href\)|prefersInlineUI\(href\)/);
    assert.match(content, /siteHasInlineUI/);
    assert.match(content, /shouldFloat = a && this\.D\.H && !siteHasInlineUI/);
    const background = source("bg.js");
    assert.match(background, /updateMediaBadge/);
    assert.match(background, /case 21:/);
});

test("floating launcher is a compact icon-only affordance", () => {
    const content = source("ct.js");
    assert.match(content, /\.ndm-launcher\{[^}]*width:32px;height:32px/);
    assert.match(content, /\.ndm-launcher-label,\.ndm-launcher-count\{display:none\}/);
    assert.match(content, /this\.badge\.className = "ndm-launcher"/);
    assert.match(content, /this\.badge\.setAttribute\("aria-label"/);
});

test("floating media choices stay isolated from page CSS and expose structured rows", () => {
    const content = source("ct.js");
    assert.match(content, /attachShadow\(\{ mode: "open" \}\)/);
    assert.match(content, /setAttribute\("role", "dialog"\)/);
    assert.match(content, /candidatePresentation/);
    assert.match(content, /className = "ndm-item-title"/);
    assert.match(content, /className = "ndm-item-meta"/);
    assert.match(content, /NDMRelayIcon\("close"\)/);
    assert.match(content, /ev\.key !== "Escape"/);
    assert.doesNotMatch(content, /getURL\("img\/close16(?:_2x)?\.png"\)/);
});

test("floating media panel favors the trailing edge and does not time out while open", () => {
    const content = source("ct.js");
    assert.match(content, /anchor\.right - width - 12/);
    assert.match(content, /window\.innerWidth - width - 16/);
    assert.match(content, /g\.p && g\.p\.hidden && !g\.hover && !g\.focusWithin/);
    assert.match(content, /addEventListener\("focusin"/);
    assert.doesNotMatch(content, /fade\(d \? 6E3/);
});

test("floating media disclosure and dialog keep keyboard context", () => {
    const content = source("ct.js");
    assert.match(content, /setAttribute\("aria-labelledby", titleId\)/);
    assert.match(content, /document\.createElement\("H2"\)/);
    assert.match(content, /keyboardActivation && requestAnimationFrame/);
    assert.match(content, /replacement && replacement\.focus\(\)/);
});

test("bilibili adapter never observes documentElement and defers toolbar watch", () => {
    const adapters = source("site-adapters.js");
    assert.match(adapters, /watchBilibiliToolbar/);
    assert.match(adapters, /prefersInlineUI/);
    assert.doesNotMatch(adapters, /observe\(document\.documentElement/);
    assert.doesNotMatch(adapters, /document\.body \|\| document\.documentElement/);
    assert.match(adapters, /Never observe documentElement/);
});

test("bilibili NDM chip mounts left of video-tool-more outside the fold", () => {
    const adapters = source("site-adapters.js");
    assert.match(adapters, /video-tool-more/);
    assert.match(adapters, /video-toolbar-right-item/);
    assert.match(adapters, /insertBefore\(wrapper,\s*more\)/);
    assert.match(adapters, /closest\("\.video-tool-more"\)/);
    assert.doesNotMatch(adapters, /video-toolbar-left-main[\s\S]{0,200}appendChild\(wrapper\)/);
});

test("bilibili NDM chip reuses native right-item spacing instead of custom squeeze", () => {
    const adapters = source("site-adapters.js");
    assert.match(adapters, /video-toolbar-item-icon/);
    assert.match(adapters, /video-toolbar-item-text/);
    assert.match(adapters, /better-ndm-bilibili-action\{margin-right:12px\}/);
    assert.doesNotMatch(adapters, /better-ndm-bilibili-action\{[^}]*margin-left/);
    assert.doesNotMatch(adapters, /better-ndm-bilibili-action\{[^}]*flex:none/);
    assert.doesNotMatch(adapters, /better-ndm-bilibili-action\{[^}]*min-width/);
});

test("content script keeps resource downloads as normal file handoffs", () => {
    const content = source("ct.js");
    assert.match(content, /downloadResource = function/);
    assert.match(content, /item\["6"\] = "normal"/);
    assert.match(content, /betterPageResolver = !1/);
});

test("site-native actions retain explicit accessible labels", () => {
    const adapters = source("site-adapters.js");
    assert.match(adapters, /button\.setAttribute\("aria-label", button\.title\)/);
    assert.match(adapters, /正在打开 NDM/);
});

test("bilibili chip yields room instead of displacing 记笔记", () => {
    const adapters = source("site-adapters.js");
    // The fit ladder must exist and be driven by a measured baseline.
    assert.match(adapters, /fitBilibiliChip/);
    assert.match(adapters, /crowdingScore/);
    assert.match(adapters, /fitChipMode/);
    assert.match(adapters, /better-ndm-bilibili-compact/);
    assert.match(adapters, /better-ndm-bilibili-yield\{display:none\}/);
    // Concessions may only ever shrink or hide our own chip. Any rule that
    // reaches for a native toolbar item to make room is the original bug.
    assert.doesNotMatch(adapters, /\.video-toolbar-item-text\s*\{[^}]*display:\s*none/);
    assert.doesNotMatch(adapters, /toolbar-right-note[^\n]*\{[^}]*(display|width|flex)/);
    // Width is half the decision and mutation observers do not see a resize.
    assert.match(adapters, /addEventListener\("resize"/);
    assert.match(adapters, /removeEventListener\("resize"/);
});
