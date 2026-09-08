# Engine gap repairs

This batch addresses the concrete failures in [the Neat comparison audit](../reference/reverse/verified/ENGINE_GAPS_2026-09-08.md). Reference behavior is evidence for specific control flow, not a claim of complete binary equivalence.

## Behavior

- A resumable task with actual file bytes retains healthy workers when another worker repeatedly receives temporary 503/429. The local retry no longer fails the entire task after three reschedules. Retry-After is respected; absent server timing uses bounded exponential delay. HTTP 503 alone no longer reduces connection capacity.
- HTTP 429 temporarily reduces admission. After a quiet interval of at least five seconds (and no earlier than Retry-After), a waiting worker can cautiously probe one additional slot. A new refusal resets the quiet interval. This is an explicit NDM policy, not claimed as identical Neat rate-limit handling.
- Before any real file bytes exist, only the first pending Range enters the network. Its transport errors have a task-wide initial-plus-three budget. As soon as actual writes exist, the pool ramps up without waiting for the entire first segment. Existing durable prefixes bypass bootstrap admission. A HEAD response and a preallocated file's logical size are not evidence of successful transfer.
- Full successful responses obtained during fallback probing are kept on disk and adopted into the existing single-stream publication path instead of discarded and requested again. Body-bearing methods use their actual first request without a synthetic Range. A successful POST therefore submits the form once. Unexpected partial POST responses are rejected rather than combined unsafely.
- Full-body probe responses are no longer aggregated into a Data value. Final publication remains exclusive; collisions do not overwrite user files. Existing offset storage identity checks remain in force.

## Boundaries

This does not make all request construction identical to Neat. The HEAD/range metadata abstraction remains. The first-body temporary HTTP refusal budget is an NDM bounded policy; original generic HTTP startup failures have different routing. TLS, authentication, changed representations, invalid ranges, disk failures and user cancellation are not blindly retried.

Fallback bootstrap uses Foundation's disk download task. Its live progress and bandwidth reporting are not yet unified with the Range streaming delegate. Temporary bootstrap staging can use extra disk space; this batch does not claim a one-copy disk guarantee for that fallback. The offset-based segmented download path remains separate.

## Verification

Focused regression evidence and final release checks are recorded below after completion. Diagnostic scripts retain their historical bug-reproduction default and add `--expect-fixed` for post-repair verification; a successful historical diagnostic run means the old bug was reproduced, not fixed.

- Full native run: 1003 XCTest cases across targets (7 skipped) plus 11 Swift Testing cases. Five existing test methods reported nine failed assertions/errors because their fixtures assumed all original HTTP requests precede child requests, or instantaneous first-body delivery. The 416 fixtures now target child byte geometry; auth/write-failure fixtures keep a real first prefix streaming long enough to trigger their intended failure. Their strict rollback, latest-boundary, write-stop and SHA assertions remain. A second entire suite was not run: all affected suites were rerun successfully (3 integration cases, 11 auth/bootstrap cases, 5 continuous/reopened 416 cases); final storage refinement then passed 22 storage/bootstrap/receipt cases. Full initial log: `/tmp/ndm-gap-full-native.log`; reruns: `/tmp/ndm-gap-tail-fixtures.log`, `/tmp/ndm-gap-final-boundaries.log`, `/tmp/ndm-gap-tail-resume-final.log`, `/tmp/ndm-gap-final-storage.log`.
- New admission regressions: 3 passed, covering legacy/v2 SHA after five temporary 503s, pause during persistent 503, and 429 ceiling recovery while a healthy request remains active. First-body regressions cover configured 1/32 connections, both stores, and resuming a real 64 KiB prefix through four subsequent disconnects.
- Release Host SHA before signing: `533bf3d31d9f954c816835fc9273acb56a0b020ad36bd32e00cb9d82b709904e`. Native release build, renderer build, packaging and stable Apple signing passed.
- [Release probe evidence](engine-gap-fixes-2026-09-08/probe.json): GET fallback sends one full body; POST submits once without Range; 1 MiB sent for each 1 MiB SHA-correct output.
- [Release startup evidence](engine-gap-fixes-2026-09-08/starting.json): one successful HEAD, four zero-body Range attempts, terminal error at 0 bytes in 0.126 seconds. No unlimited pre-body retry.
- [Release 503 evidence](engine-gap-fixes-2026-09-08/admission.json): four temporary refusals, fifth request succeeds, task completes with full SHA and capacity stays 8. Byte-zero request is not restarted. Normal live tail handoff shortens that request's ownership; therefore its server-side response need not send the original entire range. The fixed QA distinguishes that documented handoff from the old global task error. Initial fixed-mode QA had an overly strict full-original-response assertion, corrected without changing the engine or weakening final SHA/one-request/error-state checks.
- Bootstrap staging is registered before payload writes; next start recovers its receipt. Adoption retires that receipt before a possible cross-volume merge uses its own receipt. Same-volume publication uses rename and no longer reserves another payload-sized allocation.

Installed and launched `/Applications/NDM.app` build `2026090830`; installed Host and app.asar match the signed package. Host list is healthy. Signed Host SHA: `de4a2b24d639ef1cef9bbbdf6b3579ff59f6f1dbe5ad3e84947c7e9e252ece94`. No user downloads were active at deployment, so no task IDs were paused. This update’s old bundle was permanently removed after health verification.
