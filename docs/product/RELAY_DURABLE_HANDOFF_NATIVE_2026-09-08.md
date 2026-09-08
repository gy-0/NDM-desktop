# Relay durable handoff: native implementation

Status: native implementation and isolated Host QA; worker session outbox integration is still pending. The installed build 2026090827 and Relay 1.4.10 do not yet provide this end-to-end feature. This records implementation evidence for the [handoff plan](RELAY_DURABLE_HANDOFF_PLAN_2026-09-08.md), not completion of that plan.

## Native acceptance

`DownloadManager` now assembles the entire bridge task before insertion, including filename, MIME, POST body, headers, category and destination. `acceptRelayHandoff` binds a request ID to a sorted JSON SHA-256 of the original parsed message, independently of settings, inferred names or current timestamps. Store receipts contain the ID, payload hash, task ID and creation time; they do not duplicate request credentials.

`DownloadStore.commitRelayHandoff` runs task creation or Link Rescue update, header persistence and receipt insertion in one `BEGIN IMMEDIATE` transaction. A same-ID/same-payload replay returns the prior task ID without changing or starting it. A changed payload is rejected. Deleting a task preserves its receipt; replay returns `deleted` instead of recreating it. New user intents at the same URL use different IDs and remain independent.

`startAcceptedRelayHandoff` takes the task lifecycle lock and starts only an incomplete, non-awaiting task. A user pause or deletion that wins the boundary is preserved. Queue admission failure retains waiting state; other synchronous startup failures become visible, structured task errors.

## Protocol

The existing line protocol remains available. The new opt-in request is `NDMRelayDownload:` followed by JSON containing exactly `requestId` and the legacy `payload` string. IDs use 16–128 ASCII letters, digits, underscores or hyphens. The complete encoded envelope, including JSON escaping, must fit the 118,784-byte UTF-8 limit. The correlation ID never becomes an origin HTTP header.

A Host with the new callback advertises `durableHandoff: 1` in its Hello response. It returns `NDMRelayReceipt:` JSON with `requestId`, `status` (`accepted`, `rejected`, or `deleted`), optional `taskId`, and bounded static error codes. The response is sent once to the original connection; it is never redirected to another client after disconnect.

Accepted means the task and receipt are committed. It does not mean the network writer started or the file completed. A process exit after commit but before start can leave an incomplete task; a replay acknowledges its existence and does not silently resume a user-controlled task. Media composer pages remain unsupported by this durable file endpoint because their current UI broadcast is not persistent.

## Verification

Focused coverage includes complete POST/auth fixture preservation after reopen; settings-independent and header-order-independent replay; deleted tasks and payload conflicts; Link Rescue preserving the original path; startup failure visibility and delayed-start pause protection. Store tests use a real SQLite trigger to fail receipt insertion, verifying rollback of both new tasks and existing-task/header updates, and concurrent identical submissions. Bridge tests use real WebSocket connections to exercise capabilities, malformed requests, one receipt and disconnected-client isolation.

`node scripts/qa-relay-durable-handoff.mjs` passed with the debug Host SHA-256 `fc2f0c63a1a22a0bc77ff6c393a9e46afa0aa332309a90882f0a9ae68998b5e8`. It sends a request then closes without consuming the ACK, retries after task completion, restarts the Host and retries again, tests changed payload and a new same-URL intent, deletes the first task and replays it, then rejects a media page without creating a file task. The 65,536-byte result matched SHA-256 `4b640d85ab3ba30fd02c9fc9db4a8928f416322ad27022ea58a65aaee68a4df2`. Its isolated task database and payloads were removed; the small report remains at `/var/folders/28/7yq61yhd23sb8zz0ynmnsz500000gn/T/ndm-relay-durable-host-Pdoig2/report.json`.

This fixture is not evidence of Chrome service-worker recovery. Extension session storage, capability negotiation before delivery, ACK-based outbox deletion, degraded legacy behavior and actual worker-stop/restart testing remain required before claiming end-to-end delivery.

Full native regression passed: 982 XCTest cases (7 environment skips), plus 11 Swift Testing cases; `/tmp/ndm-relay-durable-full-native.log`. The standalone session outbox module adds 9 tests to the existing Relay suite (119 passing total). It serializes initialization/admission/deletion, accepts only after session persistence, preserves entries after failed removal and bounds final UTF-8 envelopes. It is not yet imported by `bg.js`; worker lifecycle integration remains pending.

Release compilation (`npm run build:native`) and the same real Host QA also passed: Host SHA-256 `5edf993cec668e9e8a953dfe2c5d1f344803e293b1ddbf8ea7cc147cd7de6f31`; `/tmp/ndm-relay-durable-release-qa.log`. This release executable has not yet been packaged or installed; deployment waits for worker integration.
