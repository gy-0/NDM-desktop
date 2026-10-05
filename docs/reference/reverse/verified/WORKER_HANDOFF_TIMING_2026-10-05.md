# Worker recovery timing assertion

Release build 2026100504's CI run 37247064561 failed only the native
`testHealthyWorkerTakesOverDisconnectedSuffixBeforeCooldownExpires` elapsed-time
assertion: 4.041746973991394 seconds versus a 4-second whole-download limit.
The three other CI jobs passed. Product source matched the previously green
2c5d185 run; that does not turn this later failed run into a pass.

The intended invariant is that healthy capacity requests the failed suffix
before the failed worker's 4.5-second cooldown ends. Measuring whole-file
completion also includes prefix transfer, final disk synchronization and
finalization. The fixture now records monotonic arrival times alongside Range
requests. The assertion retains its 4-second bound but measures from the failed
range request to the first matching suffix request. Exact SHA, one truncation
and resumed offset checks remain. No production timing or retry policy changed.

All five WorkerNetworkRecoveryTests passed locally as part of the final
38-test HLS/protocol/worker rerun. The earlier full native run also passed.
New CI remains a separate acceptance result.

[Failed release CI record](core-audit-2026-10-04/deployment-0504-ci-final.json).

CI run 37248342699 at `b71dc51` subsequently passed all four jobs. Its native
job 111570650828 passed the handoff test (9.723 seconds for both fixture modes),
1,341 native tests with 46 skips and zero failures, release build and all Host
runtime checks. This confirms the per-handoff assertion passes without demanding
that two full fixture runs complete inside a single four-second window.
[Final CI record](core-audit-2026-10-04/hls-worker-ci-final.json).
