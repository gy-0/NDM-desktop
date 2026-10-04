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


## Separate-source generation experiment

`node scripts/qa-windows-mirror-identity-audit.mjs --fresh-generation-experiment`
passed using the actual WindowsDownloadEngine and local aria2. The primary
failed after 2 MiB; the engine was stopped and relaunched against the same state.
A second isolated task downloaded the backup into a separate generation directory.
Its first request had no Range, its final 8 MiB matched B exactly, and the failed
primary bytes retained their original hash. Exclusive same-volume hard-link
publication rejected an occupied destination with EEXIST, left its sentinel
unchanged, then published the complete backup at an unused destination.

This is a two-task architecture experiment, **not restored production mirror
support**. It establishes that independent existing engine transfers avoid the
previous mixed-file result. The test bypasses automatic mirror selection and
supplies no representation inspector, so it does not prove mirrored-task resume,
credential propagation, state transitions, publication recovery, or NTFS behavior.
The production guard remains necessary until those paths are integrated.

Implementation requirements derived from the current lifecycle:

- Keep one public task/creation receipt. Persist an ordered-source digest,
  selected index, attempt generation, and owned staging directory before addUri.
  Never place multiple unverified URIs in one aria2 request group.
- Run each selected source through the existing response identity guard. Resume
  only its own pinned bytes; changing source starts a new file. A missing validator
  cannot authorize appending after restart, including within the same source.
- Serialize automatic failover with pause/remove/restart and existing generation
  checks. Settle the old writer before switching; guard failures and exhausted
  transport failures need an explicit source-transition policy, not a catch-all
  retry that can override user pause or replay POST.
- Separate public destination from active artifact paths throughout taskOptions,
  prepareHTTPRepresentation, cleanup, startup recovery and publication. Old saved
  mirror tasks without generation receipts must preserve their artifacts.
- Persist publication intent and destination identity; recover a crash between
  publishing and recording completion without replacing unrelated user files.
  Same-volume hard-link support must be checked on Windows; this experiment is
  not a portable implementation or a cross-volume fallback.
- Validate backup pause/relaunch/resume, cancel during source transition, all
  sources failing, changed backup representation, destination collision, cleanup
  ownership and crash boundaries with actual orchestration before removing gates.

Raw evidence: `core-audit-2026-10-04/windows-mirror-generation-experiment.json`.
Only isolated temporary files were used; no installed application or user download
was changed.


## Durable attempt journal foundation

`WindowsMirrorAttempts` now persists ordered source selection and separate owned
attempt directories using atomic state replacement. Its binding includes the task,
canonical ordered URLs and real root path; directory device/inode IDs are decimal
strings, preserving full-width filesystem IDs. Opening verifies every recorded
attempt directory. Advance is serialized within the engine owner, requires the
expected generation, exclusively creates a new directory and commits its selection
before returning it. Failed or orphaned creations are preserved and cannot be
silently claimed as new payload. This layer never removes files or starts writers.

Tests cover process-object recreation, changed source order/task ID, duplicate
concurrent advance, exhaustion, preexisting orphan content and replaced directory
identities. The actual aria2 experiment now uses this journal, reconstructs it
after advancing and downloads from the recovered source/directory. It passed with
unchanged old bytes, complete backup and collision preservation. Raw evidence:
`core-audit-2026-10-04/windows-mirror-journal.json`.

This foundation is wired into the experiment, not the production task lifecycle.
Production integration and publication recovery remain required; the mirror guard
is still enabled. One engine must own a journal; cross-process locking is not
provided here. A failed initial commit leaves preserved orphan data requiring
recovery rather than automatically retrying into that directory.

Validation: 779 tests passed, eight skipped; typecheck passed. Logs are
`/tmp/ndm-mirror-journal-tests.log`, `/tmp/ndm-mirror-journal-types.log` and
`/tmp/ndm-mirror-journal-qa.log`.


## Publication intent and process-restart recovery

The attempt journal now supports `preparePublication` and `publish`. The caller
must first settle the writer and supply the completed byte count. Preparation
syncs the fixed `payload.bin`, records its device/inode, length and modification
time, and binds the canonical destination parent identity before exposing a final
path. Publication creates a same-volume exclusive hard link. If a process exits
between link creation and saving the published phase, reopening recognizes that
exact file and completes the record. A collision is never replaced. An already
published but subsequently removed file is not recreated. A prepared publication
blocks advancing to another source.

Tests exercise intent-only and link-before-commit recovery, repeated publication,
source mutation, destination collision, removed published output and malformed
receipts. These simulate process interruption boundaries, not power-loss durability
or NTFS behavior. Modification time plus file identity is not a cryptographic
integrity proof; the settled-writer requirement is still mandatory. Cross-volume
or unsupported hard links fail without replacing destinations or deleting staging;
no copy fallback has been implemented.

The actual two-task aria2 experiment now prepares publication, reconstructs the
journal and calls the new publication path. It passed with exact backup bytes and
preserved primary data. Raw report:
`core-audit-2026-10-04/windows-mirror-publication.json`.
Production single-task integration remains pending and its mirror guard remains.

Final validation: 782 tests passed, eight skipped; typecheck and build passed.
The first test run failed on macOS `/var` versus canonical `/private/var` path
comparison; the assertion now compares canonical paths without relaxing file
identity checks. Logs: `/tmp/ndm-mirror-publish-tests-verified.log`,
`/tmp/ndm-mirror-publish-types-final.log`, `/tmp/ndm-mirror-publish-build-final.log`.
