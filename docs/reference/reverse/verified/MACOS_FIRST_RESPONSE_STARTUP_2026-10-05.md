# Reuse the first response in current Swift startup

The original comparison found a second response wait before current Swift could
receive useful payload: a one-byte GET established metadata, then the first real
range requested those bytes again. New GET tasks now begin with `Range: bytes=0-`
and adopt that same response as the first segment. Electron and the existing
Swift storage/engine remain the product implementation.

`BootstrapRangeHandoff` releases metadata to startup while holding the response
body disposition. Startup validates the response, reserves the destination,
checks capacity, establishes representation identity and persists the range plan.
The first worker retains the original lease object, binds the response to offset
storage and consumes its assigned prefix. Other workers keep the existing
admission and retry policies. The original response stops at its owned boundary;
its remaining body cannot overlap other segments.

The handoff propagates completion/failure to suspended startup and body planning.
Cancellation drains through the existing task group; a connection-count replan
is classified as replan rather than a terminal cancellation error. Progress uses
the same segment/plan tokens, and the first request supplies a connection setup
sample for tail scheduling. Subsequent attempts request only missing bytes with
the established identity and redirect checks.

Scope and preserved behavior:

- Fresh GET with no saved offset receipt or legacy segment artifacts uses the
  first-response path. Resume and legacy work keep their established metadata
  validation before adopting saved bytes.
- A valid complete open 206 with a joinable validator can be segmented. Weak or
  absent validators, unknown totals or a shorter open response select a separate
  clean stream; none of their partial bytes are joined.
- An ignored Range returning 200 is still streamed once and adopted as a full
  body. Empty/416 behavior retains its clean-stream policy. Malformed responses
  fail before opening a body writer.
- POST and other body-bearing submissions retain the single-submission path.
  This change does not add POST replay.
- Existing per-response identity/encoding checks apply to other workers; a
  same-size ETag change cannot be joined to the adopted first response.

Regression fixtures that previously treated request 1 as a disposable one-byte
probe now inject body faults into request 1 for fresh downloads. Tests still
require bounded zero-byte startup retries, exact suffix recovery, zero durable
bytes after empty failures, intact partial mirror ownership, no premature
publication, and correct proxy/Digest credentials. The Digest fixture now parses
open-ended ranges correctly. Redirect tests use two actual segments so they
continue to check both the first response and regenerated Range requests at every
origin crossing, rather than reducing coverage to a single redirected request.

Integration tests also explicitly require a fresh single-connection task to
finish with exactly one GET, and reject a changed identity in other workers with
zero committed bytes in those ranges. The previous transport-only handoff note
remains historical evidence; this change activates that handoff in the engine.

No installed application is replaced. Loopback evidence does not establish
public-site speed, Electron paint latency, proxy/TLS performance, or native
Windows behavior.

## Release-host comparison

`macos-first-response-comparison.json` under `core-audit-2026-10-04/` records
the same 32 MiB, four-connection, alternating three-trial comparison used for the
baseline. All 12 complete files passed SHA-256 verification. Both owned engines
stopped, the original executable remained unchanged, and the copied original
application was moved to Trash. Current first requests are all `bytes=0-`.

Median milliseconds in this run:

| Scenario | Engine | First useful server body | Observed completion |
| --- | --- | ---: | ---: |
| Normal | Original | 29.76 | 1682.48 |
| Normal | Current Swift | 10.91 | 1490.49 |
| 150 ms header delay | Original | 187.30 | 2207.14 |
| 150 ms header delay | Current Swift | 170.46 | 1997.68 |

The previous repeated baseline had current first useful body at 331.37 ms in
the latency scenario. The new result removes approximately one 150 ms response
wait; the request trace confirms that this is response reuse, not displaying
probe bytes as progress. Current observed progress in this run had a median of
229.72 ms under latency (server writes and client progress are distinct).

Original progress snapshots refresh every 200 ms, versus 25 ms RPC polling for
the current engine. Completion/progress differences include that reporting
asymmetry. The original's total times also vary between runs, so these numbers
do not establish a general percentage throughput improvement or Internet-speed
ranking. The supported conclusion is removal of the redundant startup request
for eligible fresh GET tasks.

## Final validation

`npm run test:native` passed in one complete acceptance run: 724 engine tests
(including 28 skipped), 561 core tests, 32 bridge tests, and 11 additional Swift
Testing tests; zero failures. `npm run build:native` and `git diff --check` passed.
The release-host SHA in the comparison matches the built host. Source hashes
and command results are recorded in `core-audit-2026-10-04/macos-first-response-acceptance.json`.

## Actual Electron composer validation

`scripts/qa-electron-native-startup.mjs` launches the built Electron UI against
a separately owned release Host. Both use fresh profiles, support/output
directories and free ports. Clipboard IPC is replaced with empty fixture values;
no installed app, existing download or original reference binary is modified.
It retains its report, Host log and ready/active/complete/error screenshots in
the printed temporary directory. Run after `npm run build:native` and
`npm run build`, using `node scripts/qa-electron-native-startup.mjs`.

The automated interaction opens the composer, fills a local URL, and submits it
through Enter. The fixture contains 16 MiB of deterministic bytes, advertises a
strong ETag and ranges, delays each response by 150 ms, and writes 64 KiB every
12 ms. Assertions cover the real task, exact downloaded contents, first GET
`bytes=0-`, no HEAD or one-byte probe, nonzero visible progress before completion,
HTTP 403 diagnostics in the inspector, no duplicate task, and no page errors.

The retained report is `core-audit-2026-10-04/macos-electron-first-response.json`.
The final run observed 28 ms from submitting to the first server request,
179 ms to its first body write, and 515 ms to observing nonzero progress in the
actual DOM. The preceding run observed 26 / 176 / 297 ms respectively. These are
individual local fixture runs, not benchmark medians or Internet performance
claims. DOM observation includes 50 ms polling and prior RPC/locator waits; it
is an upper bound on discovering the changed UI, not precise display scanout.
The screenshots were inspected: progress and failure details are visible.

`npm run build` passed. The separate `qa-window-startup.mjs` smoke passed its
delayed-renderer loading-shell, early-wake visibility and subsequent-wake checks.
That smoke uses a fake engine; the download harness above uses the real Host.
These are development Electron runs, not an installed-package acceptance test.

A remaining experience issue is visible in the active screenshot: progress has
advanced while speed still reads 0 KB/s. `OneSecondSpeedSampler.consume` waits
at least one second before producing its first speed target. Startup speed
feedback needs a separate comparison and improvement; this validation does not
claim the entire download experience now exceeds the original.
