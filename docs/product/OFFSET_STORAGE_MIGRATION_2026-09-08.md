# Single-file download storage migration

Status: shipped in installed build 2026090811 for fresh known-length, strongly validated HTTP Range downloads. Real debug and signed Host crash/resume/hash checks pass. Legacy tasks, non-range and unknown-length paths retain separate parts and assembly. Earlier milestones below record the staged implementation; the final section records the installed state.

## Evidence

Current `SegmentRecord` contains start/end/link metadata but no durable completed byte count. `SegmentFileFormat` infers progress from each part's length. Pre-sizing one output file would therefore make file-length-based recovery incorrect. `DownloadEngine.mergeSegments` currently copies every part into a separately owned destination staging file and exclusively publishes it. `MergeStagingReceipt.recover` may delete abandoned assembly staging: that cleanup policy must never be applied to a v2 file containing valid download progress.

The isolated `scripts/experiments/offset-storage.py` ran 32 disjoint offset writers against a 32 MiB file. At the half-way checkpoint it persisted data before the prefix manifest, wrote an additional uncommitted incorrect suffix, and abruptly exited the child with code 86. A new process resumed from the manifest, overwrote the uncommitted suffix, and produced the expected SHA-256:

`980cdaf7ef68ede1a3d8ff2e1eeea5bb931f3feaa50e48a18b9f7159a0d20551`

Checkpoint samples, including simultaneous old/new manifest files, reached 33,562,624 allocated bytes (32 MiB plus 8 KiB). The half-complete file already reported the full 32 MiB allocated on this machine: do not promise allocation proportional to downloaded bytes. This measures owned file blocks, not the filesystem's global instantaneous peak. The experiment is not the NDM engine, network fault injection, dynamic splitting, rename recovery, or proof against machine power loss. The latest local result is `/tmp/ndm-offset-feasibility.json`.

[Apple's APFS documentation](https://developer.apple.com/documentation/foundation/about-apple-file-system) describes whole-file copy-on-write clones and sparse allocation. The installed SDK exposes whole-file `clonefile`/`fclonefileat`; that does not establish an API for concatenating arbitrary file extents. This design therefore uses offset writes rather than assuming zero-copy concatenation of existing parts.

## Native backend milestone

`native/Sources/NDMEngine/OffsetDownloadStorage.swift` now implements owned offset writes, versioned durable range prefixes, data-before-manifest synchronization, short-write/EINTR handling, range-plan replacement and exclusive publication. Initial manifest publication is exclusive; partial/parent/work identities are checked before mutation. A repeated publish verifies the destination identity and retries parent-directory synchronization. A publishing receipt identifies a rename completed before task-database acknowledgement.

Full native regression passes: 878 XCTest cases (7 skips, including the separately exercised process harness) and 11 Swift Testing cases, no failures. Fourteen focused tests pass, covering short writes and disk full, uncommitted suffix recovery, plan changes, 32 concurrent writers, metadata failure, path/symlink replacement, existing destinations, post-rename recovery and retrying failed directory sync. The directory-sync retry test first failed on the missing second sync, then passed after the fix.

`scripts/qa-offset-storage-crash.mjs` launches a real XCTest child with an allowlisted environment, waits for a durable half checkpoint, sends SIGKILL and launches a fresh recovery process. `OffsetStorageProcessTests` recovers only the saved half-prefixes, overwrites the uncommitted suffix and publishes the result. Node independently validates the 4 MiB output against deterministic expected bytes:

`a117210941a0b00dcb2d8577e680d84b6fa0eaf760d2afc654c953b9859d54fa`

The final owned-file allocation sample is 4,202,496 bytes (4 MiB plus 8 KiB). Log: `/tmp/ndm-offset-native-crash.log`. This tests the actual Swift backend, not an HTTP transfer or every interruption point. fsync and process-crash tests do not establish device power-loss guarantees.

The backend serializes its own writes. Callers must preserve lease→storage lock order and enforce task-generation ownership: two recovered backend instances must never write the same task concurrently. At this initial milestone, runtime selection and manager integration were outstanding; they are now connected as recorded below. A crash before initial receipt publication can still leave an empty unregistered candidate. Cleanup intentionally does not scan for files without a receipt.

## Required production changes

1. Introduce a versioned storage interface for completed-prefix lookup, writer creation, replanning, fallback invalidation, cleanup and publication. Keep legacy files readable. Start v2 with new tasks; do not silently reinterpret existing `segments.bin` or convert an old task merely because its final size is known.
2. Create an owned `.partial` in the final destination directory. Persist task identity, file and parent identity, resource validator and request-context hash. Verify those identities on recovery and cleanup; a replaced path must not authorize deleting or publishing another file. An offline destination preserves recovery metadata.
3. Write with `pwrite` at absolute offsets, preserving the existing locked transfer lease. Handle short writes, EINTR and ENOSPC. Track successful bytes separately from durable committed bytes; shared seek positions and append-only assumptions no longer apply.
4. Persist data before atomically publishing a versioned coverage manifest. Restore only committed prefixes; uncommitted tails may be downloaded again. A file's logical size, sparse holes or leftover bytes are never evidence of completion. Fail closed on invalid ranges/overlaps, incompatible representation or ownership mismatch.
5. Preserve split transactions: calculate using actual written bytes under the parent lease, commit a valid range plan before releasing a shortened parent and starting the child. Child rejection and 416 rollback must stop/drain affected writers before changing coverage. Invalidated bytes remain untrusted even if physically present in the shared file.
6. Once durable coverage is exactly `[0,total)` and all writers are drained, synchronize and exclusively publish on the same volume. Record enough ownership evidence to recover a crash after rename but before the task database reports completion. Never overwrite a pre-existing user destination.
7. Update `DirectDownloadStorageBudget` by storage version. Its current shared-volume calculation adds remaining work and destination space. New storage should reserve its single destination file and metadata; legacy tasks retain their current budget. Otherwise the old 2x preflight can reject files the new storage would fit.

Incremental migration of old tasks is a separate feature. Copying one part, synchronizing and committing a mixed-state receipt before deleting the old part could limit extra storage to the largest migrating part, but recovery must understand mixed legacy/v2 ownership. It is not safe to delete parts while retaining the current discard-staging-on-failure merge behavior.

## Integration acceptance

Before enabling v2, run actual NDMHost transfers with byte hashes and injected interruptions at data-write, data-sync, manifest publication and final rename boundaries. Cover repeated live tail splits, rejected children, pause/resume, representation changes, short writes/disk full, replaced paths, offline destination, existing target collisions and legacy task recovery. Verify storage preflight and measured peak allocation on the actual destination volume. Keep production selection explicit until these pass; the Python experiment cannot substitute for them.

## Integration audit follow-up

The pre-integration call graph derived prefixes directly from `seg.xN` files in queue selection, lease creation, donor selection, stream retries, progress and replanning. All must use one backend-aware prefix source; replacing only the response writer would produce incorrect scheduling and progress. A v2 manifest must be authoritative: corruption or an offline destination is not permission to silently select legacy storage.

`DownloadManager.startUnlocked` (restart), `remove`, and `reclaimCompletedArtifacts` must drain writers and process the owned v2 receipt before deleting the work directory. Failed cleanup retains both the task record and receipt. A published destination is user output, not disposable temporary storage. Recovery of an already-published receipt must precede the remote probe, so an expired source cannot prevent acknowledgement of an intact completed file.

Offset storage context must cover request fingerprint, validator type/value, representation length and identity version. The existing request fingerprint alone deliberately stays unchanged when the origin replaces a representation and is therefore insufficient to authorize checkpoint reuse.

## HTTP and lifecycle primitives verified

The optional `RangeStreamDownloader.offsetStorage` adapter now writes validated Range responses into the shared backend. Five actual local HTTP tests cover out-of-order absolute writes, prefix resume, ignored Range rejection without mutation, seven-byte short-write then ENOSPC recovery, and shortening a live parent while retaining its original HTTP response. The default remains the legacy file sink.

`OffsetDownloadStorage.inspect` verifies receipts without remote context or file preallocation, including published output recovery. `removeIncomplete` records a cleanup name before exclusive renaming and deleting the verified incomplete file; interrupted cleanup can retry. Published output is preserved. Manager must drain/release writers and serialize task generations before invoking cleanup. An unregistered empty file left by a crash before the initial receipt is not removed by directory scanning.

`DirectDownloadStorageBudget.Mode.offsetDestination` reserves one destination payload and credits only ownership-verified physical allocation. It does not count sparse logical file length as allocated bytes, and excludes metadata/safety reserve. Legacy mode remains the default.

Combined focused validation: 22 backend, 5 real HTTP adapter, 2 representation identity, 14 storage budget and 7 legacy transfer lease tests passed (50 total). Logs: `/tmp/ndm-offset-cleanup-final.log` and `/tmp/ndm-offset-cleanup-legacy.log`. This is targeted primitive validation, not a new full-suite or production engine end-to-end claim. This was the build10 development checkpoint before production integration.

## Production integration and real Host acceptance

Fresh ordinary HTTP Range tasks with known length and a strong representation validator now select offset storage. Existing `segments.bin`/`seg.x` tasks retain legacy storage; non-range/unknown-length paths and clean-stream fallback remain legacy. A present v2 receipt is authoritative: invalid representation, missing/replaced file or unavailable destination fails closed rather than silently replacing it.

Engine scheduling, live tail changes, manual connection replanning, stream prefix lookup, periodic checkpoints, pause/error drain, single-file budget and exclusive publication use the v2 backend. Checkpoints preserve actual written coverage atomically under the storage lock. Completed receipt inspection precedes the remote probe, with directory sync retried before acknowledgement.

Manager restart/remove drain writers before ownership-aware cleanup. Completed reclamation rejects still-running or incomplete tasks and retires only verified published receipts. Primary smart naming uses a durable old/new-name transaction, preserves collision protection and verifies the resulting inode; a crash before or after the rename is recoverable. Published output length is checked, not only inode. Legacy rows without a work directory remain removable.

`scripts/qa-offset-host.mjs` failed against installed build10 because no v2 receipt was created, then passed against the integrated debug Host (SHA-256 `8f2bde07f473b9cd1cbac0dcffc95b44d0662a4a985c1afc06ff9df595d482cf`). An isolated local strong-ETag server delivered 64 MiB through 32 initial Range requests, with 32 simultaneous active requests measured. Pause persisted 1,572,864 bytes; a subsequent resume and SIGKILL were followed by a new Host process recovering and completing the task. Independent final SHA-256:

`98dc891b284e4d84ac25b0c0a24fdbe39a7f0dbd643ad5e8aa06e02fc6258254`

Observed owned-file allocation peaked at 67,137,536 bytes (64 MiB plus 28 KiB, ratio 1.000427). This includes task metadata/logs and excludes the host process, global filesystem overhead and test-server memory; periodic sampling is not an instantaneous global peak guarantee. No legacy segment payload or owned partial remained after publication. Report: `/var/folders/28/7yq61yhd23sb8zz0ynmnsz500000gn/T/ndm-offset-host-R3np17/report.json`. Full native regression passes: 920 XCTest cases (7 environment skips) and 11 Swift Testing cases, zero failures (`/tmp/ndm-offset-production-full-native.log`). Signed-package Host validation also passed with identical final hash, 32 active requests and 67,137,536 sampled allocated bytes (`/tmp/ndm-offset-signed-host.log`). The packaged Electron handoff regression passed. Build 2026090811 was installed and launched; installed app.asar SHA-256 `0571067da59a85b1ce2854dae43a2c0be7e07a426b6c6dca7bcbbac325f6e2c5` and NDMHost `2f40fa3b481b7084ccab4898a61d4417f16747b2f8d1396cb0e0a11a7533dee7` match the signed package. Deployment health checks passed and the previous deployment bundle was permanently removed.

## Same-size replacement regression follow-up

`DownloadEngineOffsetIntegrationTests.testSameSizeReplacementCannotJoinCommittedOffsetBytes` persists a 32 KiB prefix in a 64 KiB v2 file, releases the storage instance, then starts the real engine against a local HTTP server with the same Content-Length and a different strong ETag. Recovery must fail with `identityMismatch`, issue no Range request, preserve both the partial bytes and manifest exactly, and publish no final file. Recovery using the original context still reports the committed 32 KiB prefix. This covers representation changes between checkpoint and resume; it does not simulate a mid-stream change or power loss.

Validation: 12 focused offset/Digest tests passed (`/tmp/ndm-offset-identity-followup.log`); full native regression passed with 940 XCTest cases, 7 environment skips and zero failures, plus 11 Swift Testing cases (`/tmp/ndm-offset-identity-full.log`). An independent agent reviewed the fixture and its evidence limits. This batch changes tests and historical documentation only; installed build 2026090820 remains the current product build.
