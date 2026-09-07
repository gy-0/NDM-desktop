# Relay content identity preservation

Relay 1.4.5 retains URL fields that select the requested video. The old normalizer removed Bilibili's `p` selector and Vimeo's unlisted access hash before the inline action handed the page to NDM. A successful handoff could therefore identify the wrong part or lose access context.

Bilibili now retains positive integer `p` values (normalizing leading zeroes). Vimeo retains the known ten-character hexadecimal path hash and the embedded player's `h` parameter, normalizing these to the page URL. Tracking/autoplay parameters remain excluded. No new logging was added.

Validation: Relay syntax and all 96 contract tests pass. Four isolated Chrome headless browser tests pass, including clicking a reused Bilibili toolbar after a part change and handing off a synthetic Vimeo access hash without console output. These tests use local intercepted fixtures, not the user's profile or private URLs. They establish adapter behavior; they do not establish current anonymous Vimeo extraction compatibility or a full-chain logging audit.

The running user Chrome installation is still a separate migration step. Shipping this extension inside NDM does not itself reload or replace an already installed unpacked extension.
