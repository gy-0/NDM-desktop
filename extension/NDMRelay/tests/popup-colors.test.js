const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "popup.css"), "utf8");
const roots = Array.from(css.matchAll(/:root\s*\{([^}]+)\}/g), match => match[1]);

function tokens(block) {
    const result = {};
    for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) result[match[1]] = match[2];
    return result;
}

function rgb(hex) {
    return Array.from(hex.matchAll(/[0-9a-f]{2}/gi), match => parseInt(match[0], 16) / 255);
}

function luminance(hex) {
    const channels = rgb(hex).map(value => value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4));
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function wcagRatio(foreground, background) {
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

// APCA 0.98G constants, sufficient for guarding this small sRGB token set.
function apcaLuminance(hex) {
    const channels = rgb(hex).map(value => Math.pow(value, 2.4));
    const luminance = channels[0] * 0.2126729 + channels[1] * 0.7151522 + channels[2] * 0.072175;
    return luminance < 0.022 ? luminance + Math.pow(0.022 - luminance, 1.414) : luminance;
}

function apcaContrast(foreground, background) {
    const text = apcaLuminance(foreground);
    const surface = apcaLuminance(background);
    const sapc = surface > text
        ? (Math.pow(surface, 0.56) - Math.pow(text, 0.57)) * 1.14
        : (Math.pow(surface, 0.65) - Math.pow(text, 0.62)) * 1.14;
    if (Math.abs(sapc) < 0.1) return 0;
    return Math.abs((sapc > 0 ? sapc - 0.027 : sapc + 0.027) * 100);
}

function blend(foreground, background, alpha) {
    const foregroundChannels = rgb(foreground);
    const backgroundChannels = rgb(background);
    return "#" + foregroundChannels.map((value, index) => Math.round(
        (value * alpha + backgroundChannels[index] * (1 - alpha)) * 255
    ).toString(16).padStart(2, "0")).join("");
}

test("popup light and dark palettes keep modern neutrals and readable contrast", () => {
    assert.equal(roots.length, 2);
    roots.map(tokens).forEach((theme, index) => {
        const name = index === 0 ? "light" : "dark";
        const pairs = [
            ["body", theme.paper, theme.ink, 90],
            ["secondary", theme.fog, theme.raised, 75],
            ["muted", theme.mist, theme.raised, 60],
            ["primary action", theme["on-accent"], theme.accent, 60],
            ["resource action", theme.paper, theme.panel, 60]
        ];
        pairs.forEach(([role, foreground, background, minimumAPCA]) => {
            assert.ok(wcagRatio(foreground, background) >= 4.5, `${name} ${role} misses WCAG AA`);
            assert.ok(apcaContrast(foreground, background) >= minimumAPCA, `${name} ${role} misses APCA ${minimumAPCA}`);
        });
    });
});

test("actions use the neutral product palette instead of stock blue", () => {
    assert.match(css, /\.btn-accent\s*\{[^}]*background:\s*var\(--accent\)/s);
    assert.match(css, /\.resource-download\s*\{[^}]*color:\s*var\(--paper\)/s);
    assert.doesNotMatch(css, /#(?:365fd9|97acff|2f52c7|a9baff)/i);
    assert.doesNotMatch(css, /\.card-title\s*\{[^}]*var\(--accent/s);
});
