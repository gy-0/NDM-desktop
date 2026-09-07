# Interface craft pass — 2026-09-07

## References and adaptation

Reviewed Opensource UI at commit e9828c390d32b4d3c94e9e2af1488023d7887b15:
https://github.com/bidyut10/opensourceui

- `components/buttons/copy-button.tsx`: adapted the fixed icon and stacked-label slots. NDM confirms only an acknowledged clipboard write, reports failure and allows retry. Delayed callbacks cannot update an unmounted control or overwrite a newer operation.
- `components/buttons/segmented-toggle-button.tsx`: recessed track / raised selection informed NDM's existing controlled segmented component. Existing semantics and backend ownership remain intact.
- `components/buttons/inset-button.tsx`: quiet layered surfaces informed action controls, using NDM's own theme tokens.
- `components/buttons/download-button.tsx`: inspected for its state transition; its timed simulated success was deliberately excluded. Download progress and submission completion remain engine-driven.

The MIT copyright and complete license are in THIRD_PARTY.md, included in app.asar. No runtime dependency or remote asset was added.

## Changes

- One subtle blue selection treatment across navigation and task selection; distinct hover and selected states.
- Add-download entry and action buttons have restrained depth and press feedback.
- File identity uses the system sans-serif face; the NDM wordmark retains its brand typography.
- Settings grouped surfaces separate controls from the page and share consistent inset spacing.
- Toggle travel is interruptible and stops cleanly at either end. Pending writes show a thumb spinner and prevent duplicate input.
- Copy icon transitions and fixed-width confirmation preserve layout; failure is visible and never becomes success.
- Segmented control selection honors reduced motion. CSS control effects also honor the system preference.
- Composer submission shows a real pending indicator; source parsing and completion logic are unchanged.
- Sidebar resize ends and restores the cursor on window blur.

## Verification

Run npm test, npm run typecheck, npm run build, and scripts/qa-workspace.mjs. The renderer QA includes real React interactions with an isolated mock bridge, clipboard rejection and retry, theme/settings screenshots, keyboard and resize behavior. It does not claim a new live download has occurred.

Inspect the packaged app with the real library before delivery. Native host and Relay behavior are unaffected by this craft pass. The earlier engine repair remains in the checkout and is retained during packaging.

## Recorded result

250 behavior tests, typecheck and production build passed. 29 renderer QA scenarios passed without renderer errors, including clipboard failure/retry and five settings pages in both themes. The packaged app was installed and launched; its real library, Movist details, download settings and empty composer were inspected without starting or changing downloads.

Installed/source app.asar SHA-256 both equal bd80a0bc2ab8053436dfe363863b63cbd33ebbdb3bec9149430a93612af64f6c. The installed bundle passed strict/deep signature verification. This pass covers the named surfaces and interactions, rather than asserting a complete design certification of the product.


## User-directed correction

The user rejected the blue-violet sidebar treatment and the raised add-download entry. Both are reverted to neutral surfaces; switches and theme swatches are neutral as well. Transfer colors are blue without violet tint.

The first copy pass missed the list-row icon. Both the row and details now use CopyFeedbackIcon; runtime QA asserts intermediate opacity frames and reduced-motion behavior.

Opening a file now uses its default application, even when an installation receipt exists. Explicit NDM installation uses system:install-disk-image. Row/detail/double-click targets remain the original download; the success notification retains separate installed-app actions. Successful installation no longer automatically reveals the app in Finder.

page, droplet and release sound recipes are globally suppressed through one dispatcher, including declarative data-cuelume attributes. Composer cancellation has no cue. Existing opt-in sound preferences are retained.

Verified: 251 behavior tests, 30 renderer QA scenarios, completion journey QA, and real Electron IPC with an isolated fake engine and intercepted shell operations. The IPC check covers default opening before/after installation, row/detail/double-click targets, no automatic Finder, and explicit Finder reveal. No real app was installed or launched by that test.

Correction deployed to /Applications/NDM.app and launched. Source/installed app.asar SHA-256: aeb53d412520ea3fc639a88a44118498d6f8e1e346748964551af37fac1733ce. Installed signature verification passed. Confirmed the neutral sidebar in the real library; opened and dismissed Settings, library cleanup and Composer without changing tasks. Audio policy is verified through its centralized code path and tests, not a claim of an acoustic recording.
