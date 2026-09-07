# Engine port gaps and integrity audit — 2026-09-08

Scope: first audit `native/` against verified Neat 1.3/build 24 ARM64 function exports and reproduce integrity failures; subsequently implement the explicitly authorized fixes. The finding descriptions and parity table below record the pre-fix baseline. See the repair status immediately below for current changes. No decompiled code was copied into the product.

## Authorized repair status

- Added versioned `representation.json` containing a hashed request context, size and strong validator. Strong ETag is preferred; Last-Modified is accepted only when its accompanying origin Date establishes the RFC 9110 60-second strength condition. Weak ETags cannot authorize byte joining. URLs/cookies/credentials are not duplicated as plaintext in this new sidecar.
- Every conditional Range sends If-Range and validates the returned identity and total length **before** opening its part writer. A same-length representation change is a specific, localized error. A 200 response to conditional Range follows the existing clean full-response fallback, never append.
- Stable identity permits actual partial resume. Legacy/missing/changed identity with existing bytes causes a fresh download. Empty pre-seeded range layouts remain usable because there are no old bytes to trust.
- Merge uses a private staging file on the destination volume, synchronizes/closes it, then uses an exclusive atomic rename. Existing files survive collisions, failed output writes preserve parts, and a retry with unchanged identity can merge without any Range request. The non-Range finalization path also preserves existing destinations.
- The original two regression failures now pass. Expanded validation includes stable ETag resume from byte 32768, changed ETag fresh start, changed response identity rejection before write, strong Last-Modified resume, HEAD 405 without a validator, weak/date boundary checks, page-derived request context, and existing-file collision/merge-only retry. The request fingerprint includes pageURL because the engine derives Referer/Origin from it.
- Storage validation no longer credits an existing destination as reclaimable space; this changes the current engine call only, not the global budget helper contract. Known filename collisions are rejected before body requests, with exclusive final publication still protecting against later races.
- Full native run after the initial implementation: 823 XCTest cases, 6 existing environment skips, zero failures, plus 11 Swift Testing cases (`/tmp/ndm-integrity-full-native.log`). After the final review fixes and added tests: all 31 focused tests passed (20 existing engine integration + 11 new integrity tests), and all 3 StorageGuardTests passed (`/tmp/ndm-integrity-review-followup.log`, `/tmp/ndm-integrity-storage-guard.log`). `git diff --check` passed. No package or deployed app was built in this subtask; the parent task owns final release validation.


### Staging ownership and interrupted assembly follow-up

The new assembly candidate has its own `merge-staging.json` receipt in the task work directory. An empty candidate is created first; its canonical path, task ID, file device/inode/birth time and parent inode are atomically recorded before truncation or payload writes. Receipt persistence failure prevents the large output from being written. This is a process-crash recovery mechanism, not a claim of full power-loss durability.

At the next start, only the recorded regular file with matching identity can be reclaimed. Recovery does not scan directories or delete files based on a `.partial` prefix. Replaced paths, symlinks and unrelated similarly named files remain untouched. If the destination parent is unavailable or its device/inode differs, recovery retains the receipt and reports an error; an absent external disk must not be mistaken for an already-deleted file. Once the original directory is restored, cleanup can retry. Successful publication leaves the receipt pointing at the now-absent candidate path and never makes the published destination a cleanup target.

Normal failure cleans the owned candidate; cleanup failure retains the receipt. DownloadManager removal waits for the old writer, performs receipt recovery before deleting the row/work directory, and keeps both if recovery fails. Restart performs recovery after queue admission and writer shutdown but before replacing the old work directory. This closes the case where deleting a crash-interrupted task would otherwise destroy its only ownership evidence.

The merge loop now checks Task cancellation and the pause token between chunks, before synchronization and immediately before publication. HTTP pause has a thread-safe signal sent before waiting for the engine actor, because a synchronous copy can temporarily occupy that actor. The tests stop a merge after its first 1 MiB write, independently exercise cancellation and pause, and require no final output, intact complete input parts and reclaimed owned staging. They do not pretend an actor-isolated pause message can interrupt a busy actor by itself.

Final focused verification after these changes: **54 tests passed**, comprising 20 download integration, 11 representation/publication integrity, 13 receipt/cancellation/lifecycle and 7 existing cache lifecycle tests plus 3 storage guards. Log: `/tmp/ndm-receipt-final-tests.log`. Receipt cases include a disk-backed restart simulation, same-path inode replacement, symlink replacement, invalid task ownership, receipt write failure, successful publication, task removal/restart, and a missing-parent simulation of an offline destination. No actual machine power loss or forced physical disk removal was performed. The parent task owns the subsequent final full native run and build 2026090802 packaging. Engine source was frozen after independent review; no deployment is claimed by this report.

### Explicit performance and compatibility decision for review

The implementation chooses one clean full response when no strong validator is available. This applies even to a **first download**, since combining separate unvalidated responses cannot strictly prove they represent one generation. It may reduce throughput on servers that support Range but omit strong validators; this is a protocol-integrity tradeoff, not automatic tuning or evidence that the server permits only one connection.

| Situation | Strong validator | Missing/weak validator |
|---|---|---|
| First download | Up to configured 32 Range requests; existing scheduler remains active | One full response |
| Same-run retry/handoff | Same expected identity and conditional requests | No byte joining across separate attempts |
| Across-run partial resume | Reuse prefix only when persisted request context/size/validator match | Discard unverifiable legacy prefix and start fresh |
| Output failure after all parts complete | Preserve parts and retry assembly after validation | Parts remain on disk after failure, but current no-validator restart policy can require downloading again; no promise of merge-only retry is made here |

A less conservative first-download mode would need an explicit product decision acknowledging this integrity limit; it must not silently relabel unvalidated multi-request assembly as equivalent safety. Controlled Range fixtures now issue stable payload-derived ETags so existing 32-worker tests continue exercising the intended parallel path. Dedicated no-validator tests exercise the separate path instead of hiding that behavior change.

Protocol reference: [RFC 9110, If-Range and validator strength](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5). Final publication is atomic under normal process failure; the new work does not yet claim complete power-loss durability for all segment checkpoints.

## Highest-priority findings, reproduced

### P1 — Same-length resource replacement can publish mixed generations

`DownloadEngine.loadSegmentsForResume` checks contiguous coverage, total length and part lengths, but not resource identity. The inspected native sources have no ETag, Last-Modified or If-Range handling. `downloadSegmentStreaming` rejects a changed Content-Range total, but only comparing length cannot detect changed bytes at an unchanged URL and length.

New test: `DownloadEngineIntegrityRegressionTests.testSameLengthReplacementMustNotPublishMixedGeneration` seeds a valid 32 KiB old prefix and a matching 128 KiB segment plan, then serves a different 128 KiB representation from the local server. It completes successfully with old prefix plus new suffix; the output assertion fails. This specifically reproduces legacy resume without validator metadata; the fixture does not claim to emit an ETag.

Required behavior: capture and persist a representation validator when establishing the plan; send and validate conditional range requests; check identity before accepting body bytes. Define a safe policy for legacy/no-validator tasks rather than assuming unchanged length proves unchanged content. A changed strong validator requires an explicit new generation or safe restart; a weak validator is not interchangeable with a strong one. Also cover resource changes between simultaneous requests within one run, not only pause/resume.

Acceptance cases: same-length changed strong ETag, same ETag unchanged content, different length, weak/no ETag, changed Last-Modified where applicable, redirected URL, legacy segment plan, and change after HEAD but before a Range response. No mixed output may reach completed state. Preserve useful diagnostic context when safe resume cannot be established.

Original-app parity: **unknown**. The verified exports inspected here do not establish Neat's full validator policy. Do not claim this is either a Neat defect or a proven feature inherited from it.

### P1 — An output-side merge failure deletes already downloaded bytes

`DownloadEngine.start` wraps `mergeSegments` in a catch that unconditionally calls `discardSegmentArtifacts(reason: "merge failed")`. This conflates invalid input segments with failures opening/writing the destination. A permissions failure, disconnected target volume or disk-full error does not make healthy input parts unusable.

New test: `DownloadEngineIntegrityRegressionTests.testMergeOutputFailurePreservesCompleteSegmentsForRetry` seeds the entire valid 128 KiB payload, makes only the isolated destination directory unwritable, and starts the task. The merge fails as intended, but `segments.bin` and the complete part are deleted. Both preservation assertions fail. The temporary directory permission is restored in a defer block; no user destination is touched.

Required behavior: retain complete segments and plan for output failures; retry merge without another network download. Invalidate only inputs proven unusable. Build a private, task-owned output candidate and publish it after successful completion rather than exposing a preallocated partial result as the final filename.

Acceptance cases: permission denied, volume disappears, disk fills mid-copy, close/sync failure, retry after fixing destination, cancellation during merge, and missing/corrupt input segments. Distinguish recoverable output failures from invalid input. A healthy existing destination must survive failed replacement.

Original-app parity: **unknown** for cleanup after merge failure. Export `10005f66c.c` verifies independent merge output and 64 KiB copying with abort checks; it does not establish the complete caller cleanup policy.

## Reproduction result

```sh
swift test --package-path native --filter DownloadEngineIntegrityRegressionTests
```

Observed 2026-09-08: 2 tests, 3 assertion failures, 0 unexpected errors; execution 0.402 seconds after build. Local log: `/tmp/ndm-integrity-audit-tests.log`. The assertion messages identify mixed-generation completion and missing preserved input artifacts. These are product failures, not build failures. This audit did not rerun the entire suite or claim the existing passing tests cover these cases.

## What is actually equivalent, and what is not

Reference exports: `/Users/gaoyuan/NDM/reverse/dumps/verified-2026-09-08/export/`, exact sample hash recorded in `docs/reference/reverse/verified/manifest.json`. Function names are analyst assigned; pseudocode warnings remain relevant.

| Mechanism | Neat evidence | Current NDM behavior | Gap / verdict |
|---|---|---|---|
| Completed worker can receive more work without pause | `10003bd14.c` tests availability and changes socket state to ready or stopped; verified machine-code tests and runtime 32-to-52 segment observation | `downloadRound` consumes pending ranges, then chooses an active donor if a slot is free | Same observable mechanism under tested ordinary-file conditions, not a claim of identical scheduling timestamps or sockets |
| Prefer pending ranges before splitting | `10005e3b8.c` scans state 1 first | Pending array is drained before donor selection | Mechanism adopted |
| Largest unfinished tail and bounded small-tail policy | `10005e3b8.c`, selector and availability exports in verified report; 204,800 B selector versus 237,568 B availability are distinct checks | Uses original planning quantum for donor admission, stops on small tail, with separate explicit smart-tuning policy | Do not collapse original thresholds into one universal constant or call every NDM heuristic original behavior |
| Parent range mutation during a split | `10005e3b8.c` computes split point from start + completed + half remaining, calls `FUN_100063e04` on parent end, creates and links child | Cancels donor URLSession request, waits for closed writer, persists shortened parent plus child, then starts both | **Not an exact port.** Our parent remainder creates a new request and pays new setup cost. Other healthy workers survive. Export alone does not prove all read-loop synchronization or how already buffered parent bytes are discarded |
| File writer completion boundary | Neat uses its own file/socket abstractions; `100076d78.c` wraps write and throws on short/failing writes | URLSession delegate closes FileHandle in `finish` before resuming continuation; stale callbacks rejected by plan/worker tokens | Explicit safety boundary in our port. Need adversarial late-callback and stalled-body tests before replacing it with live boundary mutation |
| HTTP 429/503 admission | Reference limited-server runtime completes but retries extra requests; full state policy not reconstructed | Per-run cap decreases on refusal; only refused worker waits/retries; healthy requests survive | Deliberate NDM policy, not literal Neat logic. General transport failures still abort the round rather than using this special retry path |
| Pause/resume | Original-app runtime pause/resume fixture finished with matching bytes | Cancel token closes writers; disk byte lengths plus plan supply resume positions | Happy-path parity established. No equivalent proof yet for same-size resource replacement, power failure or interrupted merge |
| Crash and durable storage | Inspected exports do not establish metadata fsync/ordering protocol or complete crash recovery | Segment plan uses Data `.atomic`; parts use FileHandle writes/close and lengths as progress | Atomic replacement is not demonstrated power-loss durability. No explicit fsync/synchronize or durable-range journal in the inspected path; no claim of power-loss corruption is made without a crash test |
| Final assembly | `10005f66c.c` reads parts into separate output in 65,536-byte chunks; original runtime peak about 2.09× | Separate output, 1 MiB chunks, retains parts during copy | Same space-cost class, different buffering; double-space problem remains |
| Interrupting assembly | Original merge export checks stop/state inside the copy loop | `mergeSegments` is synchronous on the engine actor and has no stop check in its copy loop | Pause/cancel responsiveness during large merge needs a dedicated fix and test; network cancellation tests do not cover it |
| Publishing final result | Full original publication/rollback path remains unresolved | Removes existing final path, creates/truncates final file before copying | Current engine layer has no transaction preserving old output on failure. Higher-layer collision safeguards do not make this inner write atomic |

## Exact donor preservation: recommended next investigation

Do not implement live shortening merely by changing the segment table while a URLSession delegate continues writing. Currently each request has an immutable expected response range and owns an append-only part. If the parent keeps the old HTTP Range while a child receives its tail, the parent writer must atomically learn its new accepted end, cap a callback that crosses that end, and cancel its transport only after the new parent range is complete. Validation of expected network-body size must distinguish deliberate early completion from truncation.

The candidate order is: reserve a safe split point; synchronize with the donor's actual written offset; persist the new plan in the correct order; hand the child only unowned bytes; preserve earlier successful writes; prevent a late parent callback from consuming child-owned bytes. A metadata failure must leave the original ownership usable. A process kill at every boundary must resume with exact coverage. This is a port of a mechanism into a different asynchronous I/O model, not a textual pseudocode translation.

Before changing the writer, use a body-streaming fixture that sends multiple delayed chunks, records delivered bytes and request identifiers, and can stop/lie/disconnect at exact byte positions. Existing response-delay tests primarily delay headers and cannot by themselves prove live donor handoff behavior. Compare parent request survival, extra requested bytes, stable segment positions and final digest against Neat under the same fixture. Inspect the parent's end-update callee and receive/write loop together; the assignment export alone is insufficient.

## Single staging file: storage improvement after integrity gates

This is a new storage design, not something established by the verified original app. It can remove the ordinary-file merge copy, but sparse file length must never be mistaken for downloaded progress.

1. Create one task-owned staging file on the destination volume; map every accepted byte range to an offset write. Handle partial writes and validate response identity before writing.
2. Keep disjoint owned ranges and explicit received/durable intervals. Maintain a format version and generation validator; do not infer completed bytes from the staging file's logical length.
3. Define durability ordering: make data durable before committing a checkpoint that claims those bytes; atomically publish the corresponding range metadata. Select checkpoint batching based on performance measurements, not fsync on every network callback.
4. Publish via a same-volume atomic operation only after completeness/identity checks and output close succeed. Handle existing-name collisions without destroying unrelated files. A cross-volume move or format conversion can still require another full copy; do not promise universal 1× disk use.
5. Keep old part-based tasks readable. Prefer finishing them in the existing format initially. Any migration must preserve the old format until the replacement data and manifest are safely committed; migration itself may temporarily need extra space.

Required tests: overlapping or repeated callback ranges, short writes, ENOSPC at each write/checkpoint boundary, process kill before/after metadata replacement, sparse holes, out-of-order completion, restore on another volume, final-name collision, legacy task resume, and a measured peak allocated-byte budget. HLS/TS and remuxing have separate format and storage semantics; a direct HTTP offset file does not automatically solve media assembly.

## Reliability order

1. Fix and turn the two reproduced integrity regressions green; add the validator and output-failure matrix.
2. Make publication and merge cancellation recoverable, then add process-kill recovery tests and explicit durability scope.
3. Reconstruct and test live donor end mutation before claiming request-level parity with Neat.
4. Measure throughput, wasted bytes, progress stability and failure recovery on HTTPS/CDN/proxy scenarios using matched fixtures.
5. Introduce versioned offset storage behind controlled compatibility behavior after these gates, with measured disk-space and crash recovery evidence.

The goal is to reuse proven mechanisms as precisely as evidence allows while making unverified gaps visible. A successful decompile, an identical threshold or a long-lived competitor cannot substitute for validating the actual port's I/O and persistence boundaries.
