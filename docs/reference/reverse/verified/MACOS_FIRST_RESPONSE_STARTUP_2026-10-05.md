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
