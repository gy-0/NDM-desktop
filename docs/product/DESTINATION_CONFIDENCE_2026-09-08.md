# Destination confidence — build 2026090823

The next workflow priority is getting browser downloads into the intended project directory. Current source inspection found that ordinary Relay transfers create and start a Host task directly, while media pages can enter Composer. Composer itself hid the destination under Options and asynchronously loaded defaults without respecting user edits. A delayed settings reply could therefore replace a just-selected project folder.

## Shipped foundation

Composer now always displays its destination row. Rename and connection options remain collapsible. Each open/close transition invalidates earlier folder selections; a picker reply from a closed session cannot affect the next one. Per-field edit tracking prevents late defaults from overriding an explicitly chosen folder or connection count. Opening a new Composer clears the previous task's destination; changing a link within the same session retains the selection. This is a per-download choice, not an implicit global-default change.

The independent real Electron fixture `scripts/qa-composer-destination.mjs` uses controlled main-process IPC replies, never the user's file chooser or download library. Installed build 2026090822 failed when a late default replaced the selected directory (`/tmp/ndm-destination-red.log`). The new renderer passes: destination initially visible, late defaults ignored, explicit project path and 8 connections submitted, old chooser reply ignored after reopening. It also checks the row fits a 920×600 window. This proves UI state and request arguments, not actual filesystem permissions or byte delivery.

288 frontend tests, typecheck and build pass. Existing Composer keyboard QA performs 50 forward/backward Tab presses, Escape and focus restoration; all pass. An independent agent reviewed lifecycle, cancel and out-of-order boundaries. Signed-package destination and keyboard QA are rerun before deployment.

## Next workflow, not yet shipped

1. Give ordinary browser transfers an explicit optional destination-selection path before starting a writer; preserve the quick default path. Avoid moving a partially written task just to simulate this.
2. Offer recently used project folders with clear one-task semantics and an explicit default option; verify offline external-volume behavior.
3. Make onboarding show actual Relay handshake/version evidence instead of treating an opened extension directory as installation success.
4. Demonstrate browser intent → selected directory → interruption → successful verified file, then validate it with target users. No paid conversion or retention claim is supported yet.

## Research context

Official competitor documentation already describes category-based folder selection and optional reuse of the last chosen category directory ([IDM Save To options](https://www.internetdownloadmanager.com/support/options.html), [starting downloads](https://www.internetdownloadmanager.com/support/using_idm/starting.html)). [Folx](https://www.mac-downloader.com/multiple-downloads-mac.html) also documents changing destination folders. These are capability references, not evidence of demand size or proof that copying their interaction is optimal. Our design inference is to make the current destination explicit and preserve intentional user choices before adding remembered destinations.

Final signed-package verification passed both controlled-order destination checks and keyboard checks (`/tmp/ndm-destination-packaged.log`, `/tmp/ndm-destination-packaged-keyboard.log`).
