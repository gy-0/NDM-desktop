# Single-file download storage migration

Status: native v2 storage backend implemented and independently exercised; production downloader integration NOT enabled. Installed build 2026090810 still uses separate HTTP part files and final assembly, with approximately two-file peak storage. This document is an implementation direction, not a new compatibility promise.

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

The backend serializes its own writes. Callers must preserve lease→storage lock order and enforce task-generation ownership: two recovered backend instances must never write the same task concurrently. Cleanup API, runtime storage selection, downloader/writer integration and storage budgeting remain outstanding. Failed initial creation can leave an empty unregistered candidate; ownership-aware cleanup must be completed before enabling production selection. Current user downloads still use the legacy engine path.

## Required production changes

1. Introduce a versioned storage interface for completed-prefix lookup, writer creation, replanning, fallback invalidation, cleanup and publication. Keep legacy files readable. Start v2 with new tasks; do not silently reinterpret existing `segments.bin` or convert an old task merely because its final size is known.
2. Create an owned `.partial` in the final destination directory. Persist task identity, file and parent identity, resource validator and request-context hash. Verify those identities on recovery and cleanup; a replaced path must not authorize deleting or publishing another file. An offline destination preserves recovery metadata.
3. Write with `pwrite` at absolute offsets, preserving the existing locked transfer lease. Handle short writes, EINTR and ENOSPC. Track successful bytes separately from durable committed bytes; shared seek positions and append-only assumptions no longer apply.
4. Persist data before atomically publishing a versioned coverage manifest. Restore only committed prefixes; uncommitted tails may be downloaded again. A file's logical size, sparse holes or leftover bytes are never evidence of completion. Fail closed on invalid ranges/overlaps, incompatible representation or ownership mismatch.
5. Preserve split transactions: calculate using actual written bytes under the parent lease, commit a valid range plan before releasing a shortened parent and starting the child. Child rejection and 416 rollback must stop/drain affected writers before changing coverage. Invalidated bytes remain untrusted even if physically present in the shared file.
6. Once durable coverage is exactly `[0,total)` and all writers are drained, synchronize and exclusively publish on the same volume. Record enough ownership evidence to recover a crash after rename but before the task database reports completion. Never overwrite a pre-existing user destination.
7. Update `OrdinaryDownloadStorageBudget` by storage version. Its current shared-volume calculation adds remaining work and destination space. New storage should reserve its single destination file and metadata; legacy tasks retain their current budget. Otherwise the old 2x preflight can reject files the new storage would fit.

Incremental migration of old tasks is a separate feature. Copying one part, synchronizing and committing a mixed-state receipt before deleting the old part could limit extra storage to the largest migrating part, but recovery must understand mixed legacy/v2 ownership. It is not safe to delete parts while retaining the current discard-staging-on-failure merge behavior.

## Integration acceptance

Before enabling v2, run actual NDMHost transfers with byte hashes and injected interruptions at data-write, data-sync, manifest publication and final rename boundaries. Cover repeated live tail splits, rejected children, pause/resume, representation changes, short writes/disk full, replaced paths, offline destination, existing target collisions and legacy task recovery. Verify storage preflight and measured peak allocation on the actual destination volume. Keep production selection explicit until these pass; the Python experiment cannot substitute for them.
