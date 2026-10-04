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

## Implemented default live-donor decision

The default path now consults the selected donor's actual body progress under
its existing lease lock. The writer establishes a sample after the first
successful write, excluding already-restored bytes, and resets it when opening a
new response sink. Once at least 50 ms of body movement is observed, splitting
requires the estimated remaining body time to exceed twice the measured response
setup estimate (with a 100 ms floor). With the parent retained, halving the tail
can save approximately half its remaining time; a fresh response must repay that
cost. This is a conservative heuristic, not a throughput guarantee.

Without a useful body sample, a remaining range of 2 MiB or less is left alone;
a larger stalled range can still hedge. This floor is our policy, not a recovered
Neat constant. It avoids repeatedly splitting small ranges whose current response
has not begun producing bytes. The original minimum split threshold, largest
donor selection, ownership journal, live parent boundary, rollback and server
refusal handling remain in place. The optional global smart tuner and its old
policy are not enabled by default or replaced in this change.

The 32-worker handoff fixture now has sustained body transfer so that a child can
actually save time; it still verifies creation beyond the initial 32 segments,
retention of the parent, no whole-plan restart and exact output. The previous
small/header-wait-only fixture is retained separately and now checks that the
initial 32 requests suffice. This distinguishes useful concurrency from merely
asserting that more requests occurred. The large-stalled-range and unrelated
healthy-range retention tests remain.

The same alternating release-host fixture passed all six output checks after
this change: default median 880 ms / four requests, smart-on 876 ms / four
requests. The recorded pre-change default was 1408 ms / eleven requests.
`macos-tail-payback-after.json` records the rebuilt binary hash and raw samples.
These remain separate local runs, with polling and system-load variance; no
claim about Internet-wide speedup or superiority to original Neat follows.

## Validation and fixture correction

`npm run build:native` passed, as did the release-host experiment above. The
complete native suite initially reported failures only in the 32-connection
reopened-416 fixture: it required a speculative child from an untouched 2 MiB
range, which the new policy intentionally leaves alone. Its later EEXIST was a
consequence of the task completing before the fixture's expected pause.

The fixture now uses 128 MiB instead of 64 MiB for 32 connections, giving its
header-delayed donor 4 MiB. It still requires an actual child request, a durable
split before pause, reopening both legacy/offset formats, 416 recovery and exact
final bytes. No assertions were removed. After this test-only correction, the
affected engine integration, live-payback and entire tail-resume-416 suites were
rerun together: 28 tests passed, zero failures. The other tests in the complete
run passed; the complete command itself was not rerun after the fixture change.
The retained 32-small-waiting-range test also passed separately. `git diff
--check` passed. A stale generated codesign `.cstemp` was moved to Trash during
build recovery; no installed app or reference binary was changed.
