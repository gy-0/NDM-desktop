# Default tail splitting: reproduced completion penalty

The original's verified largest-unfinished-range selection and threshold-based
handoff are documented in `LIVE_PARENT_BOUNDARY.md` and `BEHAVIOR_PARITY_AUDIT.md`.
The current implementation preserves the parent's HTTP request while transferring
ownership of its unwritten tail. This is a useful mechanism, but copying a split
threshold does not prove every additional request improves completion time.

Current `DownloadEngine.runRangePlan` skips `tailRebalancePlan` when `autoTune` is
false. That is the default (`AppSettings.smartConnectionsEnabled`). With smart
connections on, the legacy setup-payback heuristic is consulted. Its comments
still describe cancelling/reconnecting healthy requests, although live-parent
handoff has replaced that mechanism. Enabling the entire smart tuner is therefore
not an appropriate substitute for designing the tail decision around current
ownership and measured response costs.

## Release-host experiment

`node scripts/qa-tail-payback-audit.mjs` launches one isolated current release Host
with private HOME, support/output directories and free ports. It performs three
alternating trials each with smart connections off/on. Every task is 8 MiB with
four requested connections and the same synthetic bytes and strong ETag. The
fixture delays response headers by 10 ms for ranges starting below 6 MiB, and
450 ms for ranges starting at/above 6 MiB. It then writes 64 KiB every 8 ms.

Every run asserts the same four initial start offsets (0, 2, 4, 6 MiB), so this
comparison does not accidentally compare one initial connection against four.
The 8 MiB size is below the tuner's current 32 MiB startup threshold. Every final
file passes SHA-256 verification. The Host exits normally and owned state is
removed; the report remains. No installed application or user tasks are touched.

Evidence: `core-audit-2026-10-04/macos-tail-payback-baseline.json` records release
binary SHA, all requests/body timestamps, progress samples and completion times.

| Current setting | Median completion | Median request count |
| --- | ---: | ---: |
| Default, smart off | 1408 ms | 11 |
| Smart on | 864 ms | 4 |

All six files were correct. In this controlled slow-final-quarter scenario,
repeatedly splitting the delayed tail incurs extra response waits and makes the
default path finish later. Times include 50 ms RPC polling and are local fixture
measurements, not a public-site benchmark or an original-vs-current speed rank.
The old same-server original comparison remains separate evidence.

## Required next step

No production scheduling policy changes in this commit. Build a decision for a
single live donor that accounts for useful remaining bytes and the cost of a new
response, including a donor still waiting for its headers. Preserve the original
parent writer, ownership journal, rollback, healthy workers and large-stalled-tail
benefit. Re-run this fixture alongside large-tail, 32-worker, pause/resume and 416
rollback regressions before adopting it. Do not blindly enable the legacy global
smart tuner or claim this baseline already fixes the default behavior.
