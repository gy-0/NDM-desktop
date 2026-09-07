# Live parent boundary evidence — 2026-09-08

The current user-selected `/Applications/NeatDownloadManager.app` still reports 1.3/build 24. Its universal container now contains only ARM64 and hashes to `08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`, unlike the earlier two-architecture container. The cause of that container change was not established. Crucially, extracting its ARM64 slice produces the exact previously audited SHA-256 `25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7`. The original code addresses below remain applicable. No reference application was modified or launched in this examination.

## Observed instructions and data flow

- `0x100063e04` stores the new end at segment offset `+0x38` and recomputes length at `+0x40` from the start at `+0x28`. It can update state and optionally persist metadata. The setter itself contains no observed lock operation; this does not prove absence of serialization in its callers.
- `0x100063f00` directly reads the end. The receive/write path can instead obtain current remaining bytes through `0x1000641e4`, which subtracts completed bytes (`+0x30`) from current length (`+0x40`).
- `0x100053a30` limits available receive capacity to the current remaining segment bytes.
- `0x100053f50` reads the current remaining count, passes the smaller of buffered length and that remaining count to a virtual writer, then reports the writer's returned byte count through `0x100063fc8`. If that reports completion it invokes the socket completion path. Afterwards it clears the buffered count.

This supplies a missing link between the previously verified split setter and payload handling: the downstream write boundary can change without reconstructing the original HTTP Range header. It does not, by itself, prove the original app's thread ownership, exact synchronization order, or that a particular live HTTP request survived a split. Those require separate runtime observations.

## Independent machine-code checks

`scripts/reverse/check-live-tail-write.py` maps the hash-pinned ARM64 instructions in Unicorn. It executes the original setter, receive-capacity function and buffered-write function, using synthetic socket/segment memory. The virtual file writer is intercepted to capture its byte-count argument; progress/state publication is intercepted rather than pretending to emulate the entire application.

| Old end | New end | Already completed | Buffered bytes | Original write argument |
|---:|---:|---:|---:|---:|
| 4095 | 2047 | 1024 | 2048 | 1024 |
| 4095 | 2047 | 1024 | 512 | 512 |
| 4095 | 2047 | 2047 | 65536 | 1 |
| 999999 | 500000 | 10000 | 65536 | 65536 |

All four checks passed, including the updated length, receive-capacity clamp, reported write count and buffer reset. This is original-instruction arithmetic evidence, **not** a filesystem, network, concurrency or crash-recovery test.

## Reproduction and artifacts

`scripts/reverse/TraceLiveTail.java` exported 21 target/caller functions with assembly and cross references from an isolated, read-only Ghidra project copy. It verifies the executable hash before inspecting addresses. Decompiled proprietary output stays outside the product repository.

Archived local evidence directory: `/Users/gaoyuan/NDM/reverse/dumps/live-parent-2026-09-08/`, containing `current.arm64`, `manifest.json`, `export/references.tsv`, the function exports, and `machine-write-results.json`. This is reference material only; product builds do not depend on that sibling directory. The independent instruction harness uses Unicorn 2.1.4; Ghidra is 12.1.3.

The NDM implementation must synchronize its URLSession writer, logical boundary and persisted plan explicitly. It cannot inherit an unknown original locking model from these arithmetic observations. Acceptance still requires a streaming server fixture proving an already-writing parent retains its original request, child ranges cover the remaining bytes exactly, final hashes match, and pause/retry/416 rollback/metadata failures preserve recoverable data.
