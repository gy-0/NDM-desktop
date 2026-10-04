# Unpinned Windows mirror failover can publish mixed bytes

The prior single-origin identity work rejected mirror groups only when the main
URL supplied a pinned representation. Without an identity, `split=1` and
`max-tries=1` were insufficient: aria2 still moved to another URI in the group
and appended to the existing bytes.

`scripts/qa-windows-mirror-identity-audit.mjs` reproduces this with the actual
Windows task implementation and isolated local aria2. Two 8 MiB sources have no
ETag and different uniform content. The primary drops after 2 MiB; the backup
supports ranges. Before this change, the request trace was:

1. GET primary, no Range; receive 2 MiB of A.
2. GET backup, `bytes=2097152-8388607`; receive 6 MiB of B.

The task reported complete. Its 8 MiB SHA-256 was
`e34d4c43c1878d6a950735953bbc7c499c343b64c05bfe3554e57e666d58888d`,
matching neither source. `windows-unpinned-mirror-before.json` records this false
completion. This is not a hypothetical incompatibility or a missing speed win.

The start gate now rejects every unverified mirror group, regardless of whether
the primary happens to return a validator. Resume and explicit restart apply the
same gate before unpausing, replacing writers or deleting existing artifacts.
Existing cross-origin credential validation still runs. Task intent, mirror
ordering and creation receipts remain persistent; no silent primary-only fallback
is substituted. Previously stored partial files are preserved.

This is a deliberate feature restriction: Windows mirror transfer is unavailable
until verified mirror identity or fresh-file failover exists. A full implementation
must stage each unverified source as a separate file generation, never append its
bytes to another source, and test pause/restart/cleanup and publication. Re-enabling
raw multi-URI addUri is not a valid fix. The original reference engine's segmented
behavior supplies no proof that unrelated mirror URLs identify the same bytes;
its known mutable-source issues must not be adopted as correctness standards.

After the guard, `--expect-guard` verifies zero origin requests and no produced
file for a fresh task, then seeds an owned partial and sidecar, restarts the engine
and confirms both resume/restart reject while preserving their exact bytes.
Evidence: `windows-unpinned-mirror-guard.json`. Runtime used macOS aria2 with the
Windows orchestration code; native Windows acceptance remains open.

`npm test`: 774 passed, eight skipped, zero failures. Typecheck, build and diff
checks passed. No installed app, existing download or reference installer changed.
