# Relay dynamic resource focus — 1.4.9

When a player discovered another resource while its download chooser was open, `render()` replaced every choice button. The focused button disappeared, focus fell to the page body, and the chooser's local Escape handler no longer received key events. This was reproduced in isolated real Chrome after waiting for the initial open-focus animation frame; without that wait the initial focus callback could mask the bug.

Choices now expose their stable resource ID. Before rebuilding the list, Relay captures focus only if it belongs to that list; after rebuilding a still-visible, expanded chooser, it focuses the same resource rather than the same index. If that resource disappeared, the first available control is used. The alternatives toggle retains its own focus. A refresh while focus is elsewhere on the page does not steal it. Hidden players and collapsed panels do not receive restored focus.

Validation:

- Baseline: 5 passed / 1 failed in `/tmp/ndm-relay-focus-red.log`; failure was lost resource-button focus on discovery.
- Full Relay check: 108 passed; full isolated Chrome suite: 24 passed.
- Four new browser cases cover discovery plus Escape, outside focus, reorder/removal, and the alternatives toggle.
- The floating lifecycle suite can load the actual signed package's content script with `NDM_QA_CONTENT_SCRIPT`; all 8 cases passed against packaged Relay 1.4.9 (`/tmp/ndm-relay-focus-packaged.log`).
- Independent agent review found no blocking focus/visibility regressions. Syntax and diff checks pass; NDM build 2026090822 contains Relay 1.4.9.

These are real DOM/Shadow DOM checks with local page fixtures, not a claim that every live video website has been tested. Bundling a newer extension also does not prove the user's daily Chrome has reloaded it; its last verified installed copy remains older.
