# Unpinned Windows mirror failover can publish mixed bytes

Current status: newly created mirror tasks now use isolated source generations by
default. The initial blanket restriction described below is historical; legacy
tasks without ownership records remain blocked. See the final default-enablement
section for current validation and platform limits.

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


## Single-task lifecycle integration behind the internal QA gate

`WindowsDownloadEngine` now has an internal constructor option
`experimentalMirrorTransfers` used only by the isolated QA script. Production
callers do not enable it. New gated mirror tasks persist a random staging token
and selected source index. The source journal selects a fixed payload path on the
destination volume; the existing request identity and response guard still apply
to the selected source. Source changes clear old identity/progress before writing.
Each addUri contains one URI. Existing mirror tasks without this state remain
blocked and preserve their legacy artifacts.

After an aria2 terminal error, polling queues failover through the existing task
operation serialization, rechecks generation/GID/status, retires the old result,
advances the journal and starts the next source. Pause invalidates that generation.
Completion prepares and performs owned publication before reporting complete.
A lagging task ledger can recover committed publication on resume without making
another network request. Publication errors become visible task errors. Internal
payload names do not overwrite the user's displayed filename.

Actual Windows orchestration with macOS aria2 passed:

- `--lifecycle-experiment`: primary failed after 2 MiB, backup started without a
  Range, complete 8 MiB matched B, old A bytes remained, and only one public task
  existed. After simulating a task ledger lagging publication and relaunching,
  resume recovered complete status with zero new origin requests.
- `--pause-before-failover`: pausing primary settled its file; bytes stayed exactly
  equal for 700 ms and the backup received zero requests.
- Default `--expect-guard`: production mirror paths still rejected start/resume/
  restart without origin requests and preserved seeded partial/sidecar bytes.

Raw evidence: `core-audit-2026-10-04/windows-mirror-lifecycle.json`.
782 tests passed, eight skipped; typecheck/build/diff checks passed. Logs:
`/tmp/ndm-mirror-lifecycle-tests-final.log`,
`/tmp/ndm-mirror-lifecycle-types-final.log`,
`/tmp/ndm-mirror-lifecycle-build-final.log`.

Remaining gates before enabling production: pinned backup resume across relaunch,
restart into a new owned run, verified cleanup/delete behavior (currently explicitly
blocked for experimental mirror records), exhausted/initial-start error cases,
cancellation during the transition, and filesystem/platform acceptance. Renewal
and other task-edit operations also need auditing for source-journal binding.
The internal gate is temporary acceptance scaffolding, not feature completion.


## Pinned backup pause/relaunch/resume acceptance

`node scripts/qa-windows-mirror-identity-audit.mjs --backup-resume` passed.
Unlike the earlier unpinned fixture, this case uses the real representation probe
against a backup with a strong ETag and the actual response guard. Primary failure
switches the same task to backup B. Pause settles the backup writer, and both its
payload and aria2 sidecar remain byte-for-byte stable for 500 ms. After engine
shutdown/relaunch, backup is changed to same-length content C with another strong
ETag. Resume is rejected after exactly one backup metadata probe, with no payload
request and no mutation of saved payload or sidecar. Restoring version B permits
resume using nonzero ranges and its If-Range validator, with no requests to the
primary. Final bytes match all 8 MiB of B; old primary bytes remain preserved.
The completed-publication recovery check also passed without network requests.

The trace includes a metadata request and a no-Range guarded GET on resumed
aria2 startup before its suffix ranges. This acceptance establishes correctness,
not minimal startup round trips or a performance win. Reducing those requests
remains separate from preserving the identity checks. It is local macOS aria2
running Windows orchestration, not native Windows or public-network evidence.

Raw evidence: `core-audit-2026-10-04/windows-mirror-backup-resume.json`.
Runtime log: `/tmp/ndm-mirror-backup-resume-final.log`. This turn changes the QA
fixture only; its actual run and JavaScript syntax/diff checks passed. Production
mirror support remains gated pending restart, cleanup and the remaining lifecycle
acceptance cases above.


## Owned cleanup and task removal

The gated lifecycle now supports removing mirror tasks. Active writers first
settle via pause, then their aria2 result is retired. The task persists a keep/delete
removal intent before cleanup; a failed final task-ledger write can retry removal
without recreating absent staging. Tasks with removal intent cannot resume.

The journal validates registered directory identities and enumerates every file
before cleanup. Only payload.bin and its aria2 sidecar are accepted; unknown
entries or symlinks stop cleanup without recursive deletion. Published source
identity is checked. Cleanup intent is saved before unlinking, so reopening can
finish after some registered directories have already been removed. Published
output deletion requires its recorded parent and exact payload identity; replaced
output is preserved. Keeping output only removes staging links.

Tests cover unknown content preservation, changed output refusal, keeping a
published hard link, and partial cleanup recovery. Actual aria2 QA passed completed
task removal with both keep/delete choices and relaunch, plus paused partial task
removal with zero backup requests. All operations used private temporary paths.
Raw: `core-audit-2026-10-04/windows-mirror-cleanup.json`.

784 tests passed, eight skipped; typecheck/build/diff checks passed. Logs:
`/tmp/ndm-mirror-cleanup-tests-final.log`,
`/tmp/ndm-mirror-cleanup-types-final.log`, `/tmp/ndm-mirror-cleanup-build.log`.

This does not enable production mirrors. Restart/renewal, initial failure and
exhaustion cases, transition cancellation stress and native Windows filesystem
acceptance remain. A cleanup conflict is surfaced and retained for retry rather
than discarding the task's ownership record. Process-interruption tests do not
claim resistance to arbitrary hostile filesystem races or power-loss durability.


## Initial HTTP error and exhausted sources

Two additional actual-aria2 scenarios now run in the same gated task lifecycle:
`--primary-http-error` returns HTTP 403 from primary without a body, and
`--all-sources-fail` interrupts both differently valued sources after 2 MiB.

The first exhausted-source run exposed an observable transition bug: the journal
had selected backup, but the task still temporarily reported primary's error while
starting that backup. A list query interpreted this as terminal exhaustion before
backup payload existed. The engine now sets waiting and clears the old error before
starting the next source. Actual startup failure still restores error status.

After the fix, both scenarios passed. HTTP 403 switched to backup and delivered
its exact file. Exhaustion reported error only after both attempts failed, made
two source requests without cycling for a one-second observation, published no
final output and preserved both distinct partial files. Relaunch retained the
error and exact partial hashes without contacting either source. The original
failed trace is included, not reported as successful payload loss.

Raw: `core-audit-2026-10-04/windows-mirror-exhaustion.json`. These are local Windows
orchestration tests on macOS, with no production mirror enablement. They do not
cover every startup failure (for example failed state persistence or credentials).

Validation: 784 tests passed, eight skipped; typecheck/build/diff checks passed.
Logs: `/tmp/ndm-mirror-exhaustion-tests.log`,
`/tmp/ndm-mirror-exhaustion-types.log`, `/tmp/ndm-mirror-exhaustion-build.log`.


## Restart into a new owned run

Gated mirror tasks now implement explicit restart. Header/mirror preflight runs
before destructive work. The engine settles an active writer, retires the old
aria2 result and commits a new random run token as restart intent. It then deletes
only the verified published output and owned staging via the journal, commits the
new run with empty progress/identity, and starts primary again. Failed intent
persistence removes the in-memory intent; failed replacement-state persistence
retains intent for retry. Resume can finish a persisted pending restart before
starting a writer. Removal intent cannot be resumed or restarted.

Actual aria2 acceptance passed completed-task restart, paused-task restart and
relaunch with a deliberately persisted restart intent. Every case retained one
task ID, changed storage token, removed old owned staging and produced exact backup
bytes after a fresh primary/backup attempt. The intent case simulates the durable
boundary; it does not inject process death at every filesystem operation.
Raw: `core-audit-2026-10-04/windows-mirror-restart.json`.

784 tests passed, eight skipped; typecheck/build/diff checks passed. Logs:
`/tmp/ndm-mirror-restart-tests.log`, `/tmp/ndm-mirror-restart-types-final.log`,
`/tmp/ndm-mirror-restart-build.log`.

Source renewal is temporarily rejected for experimental mirror tasks before
changing their URL: mutating it while retaining the old cached journal would
silently select stale sources. A source-list renewal transaction remains required
before production enablement. Transition cancellation stress and native Windows
acceptance also remain. Ordinary production non-mirror tasks are unchanged.


## Cancellation while failover is probing

A delayed backup metadata response reproduced a responsiveness defect: pause was
queued behind startup and took 1535 ms for a 1500 ms probe; the backup even received
an actual payload GET before pause settled. This was not a throughput limitation.

The engine now owns an AbortController for each representation probe. Pause,
pause-all and remove deliver cancellation before entering task/proxy operation
queues, invalidate that task generation, and then perform the normal serialized
operation. Probe cancellation cannot degrade into an unpinned fresh transfer.
Shutdown also aborts outstanding probes. Pause-all retains the interrupted task IDs
so transient startup errors do not exclude them from the final paused state.
The Electron inspector combines the caller signal with its existing timeout.

Actual Windows orchestration + local aria2 passed individual pause (17 ms in the
final run; 12 ms in the initial corrected run) and pause-all (16 ms), with no backup
payload request during the following 1600 ms. The same 1500 ms fixture was used.
Real Electron/proxy transport separately cancelled its in-flight request in 1 ms;
identity response protection and binary POST single-submission regressions passed.
These are measured local fixture results, not general network latency promises.

Raw: `core-audit-2026-10-04/windows-probe-cancellation.json`. The cancellation
improvement applies to ordinary Windows HTTP tasks too; mirror enablement remains
gated. It only cancels the metadata stage here; other startup stages and all
transition interleavings are not claimed covered.

Final regression: 784 tests passed, eight skipped; typecheck/build/diff checks
passed. Logs: `/tmp/ndm-probe-cancel-tests-final.log`,
`/tmp/ndm-probe-cancel-types-final.log`, `/tmp/ndm-probe-cancel-build-final.log`.


## Ordinary-task cancellation and removal acceptance

Additional actual-engine/aria2 fixtures exercise the production non-mirror path:
`--single-probe-cancel` creates a paused ordinary task, starts it, waits until its
1500 ms metadata request reaches the server, then pauses it. The pending start
rejects with cancellation; pause settled in 7 ms, and the following 1600 ms had no
payload request or output file. Adding `--remove-during-probe` instead removes the
task in 7 ms with the same no-payload result. The gated mirror failover variant
`--remove-during-probe` settled in 28 ms, removed the task and never requested the
backup body after cancellation.

These are specific local timing observations, not absolute performance guarantees.
The ordinary cases do not use mirror task state or a mirror URI group. Raw report:
`core-audit-2026-10-04/windows-probe-cancel-operations.json`. Only QA/document files
changed for this acceptance; real runs plus syntax/diff checks passed.


## Verified link renewal without losing partial data

Experimental mirror tasks now accept renewal while paused/error/incomplete when
inspection of the new address matches the saved strong representation, including
its final canonical resource URL. Headers are prepared and cross-origin mirror
credential restrictions checked before probing. The probe is cancellable. Only
a verified replacement retires the old aria2 result and commits a source override
in the owned journal; the existing partial is then resumed through the normal
identity guard. An unpinned or different canonical resource cannot authorize
joining, even if its length and ETag happen to match.

The journal binds the original source list and separately persists validated URL
overrides, keeping the current generation and payload directory. Reopen restores
the override. Explicit restart carries the effective source list into its new run
rather than silently reverting to expired addresses. Public task URL reflects the
selected address. Removing/restarting/published tasks reject renewal before it
changes the source binding.

Unit coverage verifies retained bytes, reopen, effective-source carry-over, stale
generation and invalid schemes. Actual `--renew-backup --restart-mirror` passed:
a different same-size/ETag target was rejected without changing partial or sidecar;
an alias redirecting to the original canonical backup resumed exact bytes, remained
visible as the task URL and was used again after explicit restart. The trace and
new run's source list are both asserted. Raw:
`core-audit-2026-10-04/windows-mirror-renewal.json`.

This is conservative same-representation renewal, not permission to merge files
from arbitrary equivalent-looking CDN URLs. Unknown identity requires a fresh
explicit download. Production enablement, broader transition stress and native
Windows filesystem acceptance remain separate gates.

Final checks: 785 tests passed, eight skipped; typecheck/build/diff passed.
Logs: `/tmp/ndm-mirror-renew-tests-final.log`,
`/tmp/ndm-mirror-renew-types-verified.log`, `/tmp/ndm-mirror-renew-build-final.log`.


## Pause between source persistence and network startup

A deterministic test hook holds completion of the real state write after selecting
backup, before any backup probe exists. Before the fix, queuing pause at this
boundary still allowed a backup payload GET once the save returned. Cancelling
only an existing AbortController did not cover this gap.

The engine now latches pause/remove intent at request intake. Startup generation
checks and the post-addUri check also consult that latch; explicit resume, restart
or renewal clears it when their serialized operation begins. Existing-GID resume
rechecks before unpause after option updates. Pause-all carries interrupted startup
tasks through final settlement, without including idle completed tasks.

Actual `--pause-during-save` and `--pause-all-during-save` now show zero backup
requests before explicit resume; both subsequently resume to the exact complete
file. The normal pinned-backup pause/relaunch/changed-version rejection/resume
regression also passed. The persistence hook delays after a real successful write;
it is not an injected disk failure or proof for every async startup boundary.
Raw before/after evidence: `core-audit-2026-10-04/windows-start-interruption.json`.

Final regression: 785 tests passed, eight skipped; typecheck/build/diff passed.
Logs: `/tmp/ndm-start-intent-tests-final.log`,
`/tmp/ndm-start-intent-types-final.log`, `/tmp/ndm-start-intent-build-final.log`.


## Settling a cancelled addUri handoff

An actual aria2 fault-injection fixture held addUri's reply while requesting task
removal, then failed the first forceRemove call. Before the fix, startup swallowed
the stop failure and dropped the GID; removal returned success with aria2 still
active. This affects ordinary Windows transfers too, not only mirrors.

Cancelled admission now retains its GID and tracks the unsettled transfer until
aria2 reports complete/error/removed. Stop/restart/remove likewise wait for a
terminal status instead of treating forceRemove acknowledgement as settlement.
A five-second bound prevents indefinite RPC waiting, but a timeout or stop error
preserves the handle and files. A queued pause also recognizes the retained writer.
No cleanup is authorized by a swallowed cancellation error.

Actual tests passed both cases: one injected stop failure is recovered by queued
removal, leaving no live GID or file; persistent stop failure returns an error with
its live GID and file retained. Mirror restart and keep-file removal passed the
new settlement path. The first full regression exposed an old shutdown mock that
returned the string OK for tellStatus; it now models active -> removed and asserts
terminal observation precedes result deletion, retaining the existing shutdown
and receipt checks.

Raw: `core-audit-2026-10-04/windows-admission-removal.json`. Local aria2 was real;
only the RPC reply gate and stop failure were injected. Native Windows and process
crash behavior beyond these boundaries remain separate acceptance scopes.

Final regression: 785 tests passed, eight skipped; typecheck/build/diff passed.
Logs: `/tmp/ndm-admission-settle-tests-final.log`,
`/tmp/ndm-admission-settle-types-final.log`, `/tmp/ndm-admission-settle-build-final.log`.


## Default enablement for new tasks

New mirror tasks now enter the staged single-source lifecycle without an internal
QA opt-in. `enableMirrorTransfers: false` remains an internal rollback option.
The test fixture omits this option for normal scenarios, exercising the production
default. Old records without a source ownership journal are not migrated by
guessing: resume/restart preserve existing files and ask for a new task.

Cross-origin mirror groups allow only User-Agent, Accept and Accept-Language
custom headers; other headers, including application-specific API keys, cannot be
forwarded to a different source origin. Same-origin headers remain supported.
Filesystem identities with zero inode numbers are rejected rather than treated as
proof of ownership. Publication requires a same-volume exclusive hard link; an
unsupported filesystem reports failure and retains staging instead of falling
back to an unverified copy.

Validation: `npm test` passed 785 tests with eight skips; typecheck and build
passed. The default-option local aria2 matrix covers failover and publication
recovery, backup renewal plus restart, owned output removal, source exhaustion,
pause-all during persistence, and the rollback/legacy guard. Archived evidence:
`core-audit-2026-10-04/windows-mirror-default.json`. These tests execute Windows
orchestration on macOS, not native Windows filesystem or packaged OS acceptance.
No installed application or real download profile was modified.
