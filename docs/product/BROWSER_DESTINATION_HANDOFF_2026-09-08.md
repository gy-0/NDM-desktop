# Browser destination handoff — staged implementation

Status: the persistence and manager boundary are implemented; the production Host bridge and Electron UI are **not yet connected**. Installed build 2026090823 remains the user-facing release. Existing bridge calls keep their default immediate-start behavior. Do not describe this as a shipped browser destination picker.

## Why a durable task instead of an in-memory URL prompt

Ordinary Relay requests currently go through `NDMHost/main.swift` → `addFromBridge` → `start`. Browser headers, cookies, method, POST data and alternate tracks must not be reduced to a plain Composer URL. A memory-only prompt also loses the handoff on Host restart. The existing authenticated request stays in the Host task store; future renderer messages need only task ID, display filename, source hostname and current destination.

`DownloadTask.awaitingDestination` is optional for legacy JSON compatibility; only true blocks starting. SQLite migration adds a default-zero column. New opt-in manager calls create paused tasks with that marker before any writer starts. Existing calls default false. The confirmation API holds the per-task lifecycle lock, requires the marked task to be paused with no running writer or work artifacts, checks the selected directory exists, and persists the directory together with clearing the marker. Duplicate confirmation returns the original confirmed task rather than moving it again.

Start and restart refuse the marker before work-directory cleanup. Scheduling refuses it and scheduled-start scanning skips it. Closing a future picker must leave this task pending; explicit task removal remains the existing cleanup path. Directory confirmation and engine start are deliberately separate: a crash between them leaves a normal paused task in the chosen directory, which can continue normally.

Link Rescue is different: a fresh browser capture may update an expired existing task. Even when the caller requests directory confirmation for new downloads, rescue retains the existing task's directory and resume path. It cannot be treated as a fresh task or have its partial file relocated.

## Current tests

- Core: optional JSON compatibility, SQLite column migration from a prior schema, true/false/nil insert/update/reopen, preserved headers/POST data and unaffected neighboring rows (`DestinationConfirmationStoreTests`).
- Manager: real local HTTP transfer, pending task reloaded through a new store/manager, no network requests before confirmation, start/restart/schedule rejection, duplicate confirmation cannot change destination, confirmed file bytes match and Cookie reaches the server (`BrowserDestinationTests`).
- Invalid/offline destination and a task work directory containing an existing partial both retain the marker and existing data.
- LinkRescue regression explicitly opts into pending destinations but requires the rescued old task to retain its directory and normal resume state.

## Integration still required

1. Add a backward-compatible settings choice, defaulting to the current quick handoff: ask for destination for each new ordinary browser download.
2. Host passes the preference to `addFromBridge`, branches on the returned marker, broadcasts a pending prompt instead of starting it, and exposes a confirmation request. Do not broadcast authentication headers or POST bodies. Snapshot must expose only the marker needed for recovery UI.
3. Electron routes pending tasks through an accessible lightweight destination dialog, with default/explicit project folder selection. Multiple handoffs need a visible queue; closing a dialog cannot discard tasks. Relaunch must recover pending prompts from durable tasks.
4. Confirm then start, reporting queue admission and directory errors truthfully. Directory-unavailable errors keep the pending choice; startup failure after a successful confirmation leaves the chosen path intact.
5. Verify an actual Relay WebSocket capture → pending task → directory selection → authenticated file completion with byte hash, plus cancel, duplicate confirmations, two incoming files and restart while pending. Only then package and deploy the complete user flow.

No site-compatibility, browser extension installation, or end-user delivery claim follows from the manager-only tests.

Validation checkpoint: full native regression passes 947 XCTest cases (7 environment skips, zero failures) plus 11 Swift Testing cases (`/tmp/ndm-destination-gate-native.log`). Independent review checked lock ownership, start/restart/scheduling gates, duplicate confirmation and rescue behavior. Release Host build is validated separately in `/tmp/ndm-destination-gate-build.log`; no package/deployment is part of this staged foundation.
