# Browser destination handoff

The staged manager boundary is now connected through the production Host and Electron UI for local build 2026090824. The new Settings → Downloads option `浏览器下载前选择保存目录` defaults to false, preserving immediate handoff unless enabled. This covers ordinary file captures through Relay; it is not a claim that every video extraction or browser download uses this flow.

## Behavior and ownership

An enabled capture becomes a durable paused task marked `awaitingDestination` before any transfer request. Filename, destination and the pending marker are shown in Electron; authentication headers and POST bodies remain in the Host task store. The picker lets users select a project folder or retain the recorded default destination. Closing it leaves a recoverable task, visible as `待选目录`; task actions reopen it, and relaunch recovers pending prompts. Multiple captures are handled sequentially.

Confirmation and start share the manager's per-task lifecycle lock. Duplicate confirmations cannot relocate or restart an already confirmed task. Queue saturation admits the confirmed task to the normal waiting queue. A crash after persisting confirmation leaves an ordinary paused task in the chosen directory. Start/restart/scheduling cannot bypass a pending destination. A late RPC response cannot overwrite a newer completion snapshot or revive a deleted task.

The selected directory must exist, except for the task's recorded one-level category directory directly beneath an existing configured download root. Missing external-volume roots are never recreated. Existing work artifacts prevent relocation. Link Rescue retains the old task's filename, directory and partial state; Host no longer reapplies fresh-capture destination changes after rescue.

## Verification

- 953 XCTest cases, 7 environment skips, zero failures; 11 Swift Testing cases pass. Includes settings compatibility, durable marker migration, request metadata, lifecycle gates, queue admission, duplicate confirmation, category directory creation and absent-volume rejection.
- 289 frontend tests, type checking and production build pass. Store regression exercises an older confirmation reply arriving after completion or deletion.
- `scripts/qa-browser-destination-flow.mjs` launches actual Electron and Host in isolated support directories and ports. Two Relay-format WebSocket captures issue zero requests before confirmation. Cancel and relaunch preserve both tasks and the preference. One download uses a selected project directory, the other its default directory.
- The local server requires authentication; the second capture also requires its original POST body. Both completed files match SHA-256 `a866980a9c28b64fb487fa7d1fc952782d33234827465ab9291338551e37f85b`. Duplicate confirmation produces no new request or destination change.
- A 920×600 real Electron window fits the picker; forward/backward keyboard navigation remains inside it. Screenshot inspected. Only the native folder dialog result is substituted; transfer and persistence are real.

Logs: `/tmp/ndm-destination-flow-native.log`, `/tmp/ndm-destination-flow-tests.log`, `/tmp/ndm-destination-flow-live.log`. The fixture uses the real bridge protocol, not a daily Chrome profile or full browser-extension UI; no extension installation or broad site-compatibility claim follows from it.

The same live fixture passed against the signed build 2026090824 package, including authenticated GET/POST, relaunch recovery, both destination choices, byte hashes and duplicate confirmation. Log: `/tmp/ndm-destination-flow-packaged.log`.

Deployment verified: `/Applications/NDM.app` is build 2026090824, launched with a responsive Host; the previous deployment bundle was permanently removed after health verification. Installed/package hashes match: app.asar `df74eceed2714ccd9e12e4a6dc5cc21bf4bf7682eeef1427ffc3d783da3b151c`, Host `aa391b417308a84fec23ddcd2948ecd6ba7dcbcbf785f1e3befc71ddf37d575e`.

## Startup failure recovery — build 2026090825

The previously recorded confirmed-but-start-failed boundary is fixed. Non-queue startup errors persist an error task with its confirmed directory intact and the pending marker cleared. Host returns and broadcasts that failed task, closing the picker without a success notification. Duplicate confirmation remains idempotent; explicit retry uses the ordinary restart lifecycle.

A native fixture blocks the work root with a file, verifies no requests and a durable diagnostic, removes its own blocker and restarts to a complete byte-for-byte identical 65,536-byte file. Full native regression: 954 XCTest cases, 7 environment skips, zero failures, plus 11 Swift Testing cases (`/tmp/ndm-startup-feedback-native.log`).

The real Electron fixture injects a dangling symlink only at the new task work path, leaving its database writable. Installed build 24 fails to publish the startup error (`/tmp/ndm-startup-feedback-baseline24.log`). The fixed Host publishes failure, preserves the selected default directory, sends zero requests, and exposes the row retry action. Removing the fixture link and clicking that actual action completes the authenticated file with the same SHA-256 above (`/tmp/ndm-startup-feedback-green-final.log`). Earlier whole-support-directory chmod trials also blocked SQLite confirmation and were unsuitable for isolating this later startup failure. The row action is revealed by ordinary hover; prior completion notices are dismissed before this independent failure scenario.

Signed build 2026090825 passed the same full Electron/Host fixture, including startup failure visibility, explicit retry after repair, retained directory and authenticated file hash (`/tmp/ndm-startup-feedback-packaged.log`). No renderer or Relay source changed in this patch.
