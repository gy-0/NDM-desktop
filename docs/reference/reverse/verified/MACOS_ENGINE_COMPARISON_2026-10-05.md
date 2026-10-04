# Current macOS engine versus original: startup baseline

The product direction remains Electron plus the existing in-repository Swift
engine. The original is a behavior/performance reference, not the replacement
backend. Preserve working storage, resume, identity checks and bridge contracts;
fix demonstrated gaps in the current engine rather than copying original bugs.

## Reproduction

```sh
npm run build:native
python3 scripts/reverse/reuse/run.py --headless --compare-host native/.build/release/NDMHost
```

The runner uses a signed isolated copy of original macOS 1.3/build 24 and an
isolated current release NDMHost, separate profiles/ports and synthetic files.
No installed product is replaced. Original executable hash is checked after the
run; owned test processes stop and the owned original copy goes to Trash.

Each engine downloads the same 32 MiB payload with four requested connections.
There are three trials per engine/scenario, alternating order. The server writes
64 KiB every 8 ms per connection. The latency scenario additionally delays every
response header by 150 ms. A 600 ms idle period before submission is excluded
from timings to avoid the original intake admission gate.

## Findings

The first baseline report is `core-audit-2026-10-04/macos-engine-comparison-baseline.json`.
All 12 outputs passed SHA-256 verification. Median timings, in milliseconds:

| Scenario | Engine | First useful server body | Observed completion |
| --- | --- | ---: | ---: |
| Normal | Original | 32.18 | 1473.91 |
| Normal | Current Swift | 24.18 | 1317.07 |
| 150 ms header delay | Original | 171.40 | 1916.11 |
| 150 ms header delay | Current Swift | 335.98 | 1953.70 |

The final runner was repeated after adding settings assertions, measurement
notes and guaranteed owned-host cleanup. Its separate 12 outputs also passed
SHA-256 verification; both engines stopped and the original executable remained
unchanged. Evidence: `core-audit-2026-10-04/macos-engine-comparison-repeat.json`.
The latency medians were 174.30 ms original versus 331.37 ms current for first
useful server body, reproducing the extra response wait. Normal observed
completion was 1373.77 ms original versus 1363.31 ms current, reinforcing that
small completion differences are not a stable throughput ranking.

The original starts with `Range: bytes=0-`, carries useful data on that response,
then opens additional ranges. Current Swift first completes `bytes=0-0`, obtains
metadata/identity, and starts the actual first segment in a second request.
The controlled delay therefore exposes an additional response wait before
useful data begins. This is a reproducible latency gap, not evidence that the
whole current engine is slower in every case.

The current pool also waits for actual payload bytes from the first segment
before admitting the remaining ranges (`performRangeAttempt`). That protects
its bounded zero-byte startup retry policy. Removing the gate without replacing
that policy would change correctness/retry behavior. It is a separate ramp-up
cost to assess alongside first-response reuse.

## Measurement boundaries and next work

First useful server body is measured on the same server monotonic clock and
excludes one-byte probes. It is not a client receive or Electron paint timestamp.
Original snapshots refresh every 200 ms; current RPC is polled every 25 ms, so
observed progress/completion timings contain different reporting delays. The
normal completion difference cannot alone establish a throughput advantage.
Neither run measures Electron launch, renderer stalls, public sites, proxies,
TLS handshakes, or native Windows behavior.

Production engine behavior is unchanged by this baseline commit. Next implement
and verify useful first-response adoption without discarding response identity,
byte-range ownership, pause/cancel safety, bounded startup retries, authentication,
redirect checks, full-response fallback, or POST no-replay semantics. Reuse this
comparison after the fix and run native regression/build checks before shipping.

Validation of this research-only change: Python compilation, two isolated
12-transfer comparisons, report invariant checks, and `git diff --check` passed.
The comparison host was rebuilt successfully with `npm run build:native`.

Follow-up implementation and measurements: [First-response startup](MACOS_FIRST_RESPONSE_STARTUP_2026-10-05.md). The limitations above describe this earlier baseline/transport milestone.
