# Relay queue admission and truthful feedback

## Reproduced baseline

Relay 1.4.9 silently evicts the first accepted intent when a disconnected queue receives its 22nd request (`pendingRelayQueue.shift()`). The existing page notice says the click is queued. This is a loss of accepted intent, not just an imprecise connection icon.

The independent full-worker VM / real Host fixture now has an `--overflow` mode. The baseline pinned from Git reports queue length 21 but `oldestRetained:false` (`/tmp/ndm-relay-admission-baseline.log`). It uses local HTTP, an isolated native Host and WebSocket; Chrome APIs are stubbed, so it does not certify a daily browser profile.

## Required behavior

- Bound pending admission, including asynchronous request preparation. Reject a new request at capacity, never displace one already accepted.
- Return a correlated extension receipt to the initiating content/popup action. Admission and WebSocket delivery are distinct from Host task creation or file completion.
- A rejection remains retryable. The automatic catcher must preserve the original browser download when it cannot admit the handoff.
- Preparation exceptions and oversized messages must release their reserved slot and report failure; no early success while preparation can still fail.
- Navigation, late replies, rapid clicks and disconnects must not create false acknowledgements or duplicate handoffs.

## Durability boundary

This patch does not introduce a Host per-request ACK or persist credentials/POST bodies. An in-memory queue does not survive service-worker termination. Chrome's official lifecycle documentation explicitly states that worker globals are lost on shutdown: [extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). A durable future handoff needs a deliberate storage and deduplication design, not a claim that reconnect testing proves restart persistence.

## Verification plan

`node scripts/qa-relay-worker-handoff.mjs --overflow`: queue 22 unique file requests while offline; retain and deliver the first 21 exactly once; reject the last; reconnect, verify every complete file hash, explicitly retry the rejected item and verify it completes once. Combined with the existing initial stale-socket case, the fixture creates 23 unique successful tasks. Fixtures must clean only their owned outputs/support paths.

Content and popup tests must separately prove failure messages, retained retry controls and correlated admission before showing accepted state. Automatic interception tests must prove no cancellation marker or tab removal on rejection. These checks do not imply compatibility with every website or installation of the extension into the user's browser.

## Implemented and checked — Relay 1.4.10

Admission reserves at most 21 objects before cookie/HEAD preparation, rejects overflow with `queue-full`, and releases slots after transfer to WebSocket or preparation failure. Content messages carry a request ID; popup and floating actions wait for the worker's preparation result. The floating control suppresses duplicate clicks while pending and stays available after rejection. Timeout copy explicitly says the status is unconfirmed. Browser cancellation and temporary-tab closure happen only following acceptance, and respect catcher/bypass state.

The content floating panel now uses the same neutral light/dark accent language as the toolbar popup, removing the old purple fills, outlines and shadows. Actual light/dark rejection screenshots were inspected.

Checks: 110 Relay tests and 28 isolated real-Chrome cases pass. Full-worker/local Host overflow fixture passes with 21 accepted, one rejected, then explicit retry: 23 unique total tasks including the original reconnect case, every file matches SHA-256 `4b640d85ab3ba30fd02c9fc9db4a8928f416322ad27022ea58a65aaee68a4df2`. Logs: `/tmp/ndm-relay-admission-final-check.log`, `/tmp/ndm-relay-admission-chrome-final.log`, `/tmp/ndm-relay-admission-final-live.log`. The first browser invocation could not locate Playwright's downloaded browser; final verification explicitly launches the installed Chrome binary in isolated contexts.

## Remaining boundaries

This does not promise exactly-once browser-to-Host delivery. A very small browser download can finish before asynchronous preparation allows cancellation; concurrent identical URLs can also exceed the existing single URL cancellation marker. Completed user files are never removed to hide duplicates. The tests use unique controlled URLs and cannot resolve ambiguity between different POST requests sharing one URL. The existing transport character-count ceiling is not a comprehensive UTF-8 frame-size guarantee. Worker termination durability and native task ACK/deduplication remain separate work.

## Signed package validation

Build 2026090826 includes Relay 1.4.10. The signed package's Host and worker pass the full 23-task unique-URL overflow/retry fixture; all bytes match the expected hash. The package's floating content script passes nine real-Chrome cases. Source and bundled bg/ct/popup/policy scripts and manifest match byte-for-byte. Logs: `/tmp/ndm-relay-admission-packaged-live.log` and `/tmp/ndm-relay-admission-packaged-ui.log`. The initial package attempt hit a terminated Electron download; a clean retry completed and passed stable signature verification. No production app was replaced by that failed attempt.

Package Host SHA-256: `a67f2aadc2b33cc3b10ed789a83a461dcda51ab90401611cd0302e904687a9dd`; worker: `7bb63659973b655cc7618f06a67bc5548df9916ee6c6e9c4cd271f71f4447723`. Browser extension installation/reload in the daily profile is not part of these isolated tests.
