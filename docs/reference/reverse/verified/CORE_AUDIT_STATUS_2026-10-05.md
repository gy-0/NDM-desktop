# Core-download audit: current status, 2026-10-05

This supersedes current-status claims in the historical 2026-10-04 priority audit.
The product remains Electron with the maintained Swift macOS engine and Windows
aria2 orchestration. Original Neat is reference evidence, not a replacement
backend. The active goal is not complete: native Windows acceptance, broader
protocol/recovery coverage and installed-product validation remain open.

## Requirement-by-requirement evidence

| Requirement | Current result | Authoritative evidence and boundary |
| --- | --- | --- |
| Assess original/reverse reliability | Key mechanisms have machine-code and isolated-runtime evidence; bulk decompilation is not treated as source truth | `CORE_PRIORITY_AUDIT_2026-10-04.md`, `WINDOWS_ORIGINAL_2026-10-04.md`; original Windows runs under CrossOver, not Windows OS acceptance |
| Windows same-size changed-file resume | Fixed pinned single-origin identity checks, including actual response checks after a successful probe | `WINDOWS_IDENTITY_GUARD_2026-10-04.md`; `windows-post-get-identity-regression.json` reruns unchanged, changed and changed-after-probe cases with real aria2 |
| Windows POST silently sent as GET | Engine API now preserves POST/body/content type and durably prevents ambiguous replay | `WINDOWS_POST_TASK_2026-10-05.md`; actual aria2 lifecycle and original reproduction; browser POST capture is not covered |
| POST pause/restart correctness | Paused data remains intact; automatic continuation refuses replay; explicit restart is a fresh submission; missing restored authorization rejects before deleting bytes | `windows-post-task.json`, `windows-post-restart-preflight.json`; POST resume and body-preserving redirects are explicit limits |
| Startup HEAD/extra-response wait | macOS fresh eligible GET adopts its first open-range response; no HEAD or one-byte preflight in that path | `MACOS_FIRST_RESPONSE_STARTUP_2026-10-05.md`; native regressions, release Host comparison, actual Electron composer/file hash evidence; saved-range resume still validates identity |
| Startup shows zero speed despite receiving bytes | Added one early measured body-rate target; subsequent one-second cadence remains | `MACOS_STARTUP_SPEED_FEEDBACK_2026-10-05.md`; actual Electron observation 1213 ms before versus 405 ms after in one local pair |
| Default tail splitting adds latency | Added donor-specific body-time/setup-cost decision, preserving live parent and ownership | `MACOS_TAIL_PAYBACK_2026-10-05.md`; six outputs correct, default median 1408 to 880 ms and 11 to four requests in the delayed-tail fixture |
| Tail split recovery and many workers | Large stalled tails and sustained 32-worker handoff remain; small waiting 32-worker pool no longer creates speculative children | Full native run exposed one obsolete fault-fixture geometry; corrected fixture plus all affected integration/recovery suites passed 28 tests. Details in tail-payback note; do not label the pre-correction full command green |
| Unverified mirror switching | New tasks default to isolated file generations per source; failover, pause/resume, renewal, restart, publication and cleanup have local runtime evidence. Legacy unowned records preserve files and reject unsafe continuation | `WINDOWS_UNPINNED_MIRRORS_2026-10-05.md`, `windows-mirror-default.json`; actual aria2 on macOS, native Windows/filesystem acceptance still open |
| Keep work reviewable | Scoped commits on main, pushed after validation | Git history; no changes to the user-provided original installer, installed apps, or real download profiles |

Artifact filenames above resolve under `core-audit-2026-10-04/` unless they are
Markdown notes. Passing a fixture proves its assertions, not every protocol or
site. Server body timestamps, engine progress observations and Electron-visible
feedback are different measurements and must not be conflated.

## Work still required

1. Validate the implemented Windows mirror lifecycle on native Windows and its
   supported filesystems. Local aria2 verifies orchestration and ownership rules;
   it does not prove NTFS/reparse-point or installer behavior. Unsupported hard
   links or unprovable filesystem identities currently fail while retaining data.
2. Expand current/original comparisons to TLS/proxy/CDN-like conditions and
   sustained large transfers, including speed ramp and recovery. Existing local
   normal/header-delay results cannot establish public-site superiority.
3. Validate native Windows execution and the packaged Electron product. macOS
   execution of Windows orchestration and CrossOver original runs do not satisfy
   that platform gate. Preserve installed tasks during any deployment.
4. Validate browser-to-task POST capture separately from engine API support.
   The API now works; that is not evidence that every browser integration emits
   the necessary method/body or supports safe resubmission.

The previously reported startup black screen and completion-fireworks stutter
also remain product acceptance items. Loading-shell smoke and actual development
Electron downloads were verified; they do not prove the user's installed build
or the requested final fireworks performance. Keep these visible rather than
inferring completion from downloader tests.

## Chronological evidence updates

Earlier statements in this section describe the state at each milestone; later
entries supersede them. The table and work list above summarize current status.

### Original/current cross-check

A fresh release build and the alternating original/current comparison passed
after the startup and tail fixes. All 12 files matched; original source integrity
and owned-process cleanup were verified. In the 150 ms response-delay scenario,
median observed completion was 1811.85 ms current versus 2145.40 ms original,
with four versus eight median requests. Normal medians were 1461.93 versus
1751.15 ms. See `MACOS_ENGINE_COMPARISON_2026-10-05.md` for measurement boundaries
and `macos-current-original-after-tail.json` for raw evidence. This does not close
the outstanding product/platform work listed above.

Real-download fireworks timing now has development evidence: three isolated runs
had no long tasks or frame gaps above 50 ms, with event-to-fire 13.2–14.5 ms.
See `MACOS_COMPLETION_FRAMES_2026-10-05.md`; worker pixel presentation and packaged
acceptance remain unproven. This verifies the existing warmup implementation.


128 MiB sustained comparison is now recorded in
`MACOS_SUSTAINED_COMPARISON_2026-10-05.md`: 12 exact outputs, similar middle-transfer
rates, with normal completion differences too small to distinguish from snapshot
sampling. Broader TLS/proxy/endurance coverage remains open. A full native rerun
exposed a flaky FTP proxy timeout and a reproducible tail-test synchronization
error; the latter was corrected and all five recovery tests passed. Full-suite
revalidation subsequently passed (see below).


Full native revalidation after the targeted-child synchronization fix exited 0:
727 engine tests (28 skipped), 563 core tests, 32 bridge tests, and 11 Swift Testing
layout tests, all with zero failures. Both the earlier FTP proxy timeout case and
32-worker legacy/v2 recovery passed within this full run. Log:
`/tmp/ndm-native-full-after-targeted-child.log`. Earlier failed runs remain recorded
as diagnostic history, not substituted for this result.


Signed packaged acceptance now found two outstanding signals: the composer still
awaits HEAD classification before GET (three reproductions), and one of two
completion measurements showed a 141.8 ms rAF gap despite worker activation.
These are not acceptance passes. The engine-only first-response improvement
stands, but the whole product's startup-delay item remains open. See
`MACOS_COMPLETION_FRAMES_2026-10-05.md` and `macos-packaged-startup-gap.json`.
Installed app remains unchanged and still lacks worker warmup.


The packaged composer HEAD gap is now fixed for protected ordinary macOS file
GETs; two signed-package runs passed no-HEAD, exact file, HTTP 403 UI and HTML
rejection checks. See `MACOS_NATIVE_FILE_ADMISSION_2026-10-05.md`, including the
explicit behavior boundary for anonymous login pages versus requested browser
sessions. Other URL/platform paths retain classification. The earlier occasional
completion frame gap and installed deployment remain open.


Controlled original/current pause-resume comparison now passed 12 exact outputs
and one-second payload/receipt stability checks. Current high-delay resume has
an extra sequential one-byte identity probe (332.09 ms versus original 264.74 ms
median to useful server body, with different control overhead). See
`MACOS_PAUSE_RESUME_2026-10-05.md`. Candidate improvement is combining identity
validation with the first resumed range, retaining changed-resource protection;
this optimization is not implemented by the audit.


Pinned v2 resume now validates and adopts its first unfinished range response,
eliminating the one-byte preflight in eligible plans while retaining the legacy
and pending-tail paths. The release-host comparison passed 12 outputs; current
high-delay resume-to-body median fell from 332.09 ms to 163.47 ms. Corrected
recovery/redirect suites passed 25 tests. The subsequent full native run passed
728 engine tests (28 skipped), 563 Core, 32 Bridge and 11 layout tests. Packaged
Electron UI pause/resume also passed with exact output and no one-byte preflight.
See `MACOS_RESUME_FIRST_RESPONSE_2026-10-05.md`. Installed deployment, occasional
completion stutter, safe Windows mirrors and broader protocol acceptance remain
open, so the overall goal is not complete.


## Current Windows mirror and cancellation boundary

Safe staged mirror failover is now enabled by default for newly created tasks.
Legacy tasks without owned source records remain blocked with their files preserved. Actual Windows orchestration with local
macOS aria2 has verified single-task fresh-source failover, pinned backup
pause/relaunch/resume and changed-version rejection, initial HTTP 403 fallback,
source exhaustion, output publication recovery, owned cleanup, restart and saved
restart intent recovery. See `WINDOWS_UNPINNED_MIRRORS_2026-10-05.md` for traces and
individual boundaries. Same-representation source renewal is now implemented and verified for these
owned tasks; different or unpinned resources remain rejected to preserve
partial data. Renewed addresses also survive explicit restart. Filesystem
and native Windows acceptance remain distinct from local orchestration evidence.

Slow representation-probe cancellation is fixed in the shared Windows path:
pause/remove abort before entering the operation queue, and Electron forwards the
abort signal. Ordinary non-mirror pause/remove, mirror pause/pause-all/remove and
real Electron transport cancellation passed. Earlier full regression after this
source change passed 784 tests (eight skipped), typecheck and build. This does not
establish cancellation performance for every other startup stage.

Overall goal remains active: native Windows mirror acceptance, remaining startup
round trips, public-network/protocol and native-platform acceptance, occasional
completion hitch, and installed deployment are still outstanding. No installed
app or production download profile has been replaced by these QA runs.

Completion profiling now includes six additional signed-package launches and a
four-download burst with exact output verification; no >50 ms frame gaps were
observed. This does not close the previous intermittent hitch. The suspected rapid Meta+N transition race was subsequently traced to a changing
placeholder selector in QA. Stable textbox/popup selectors passed four- and
eight-download shortcut runs; no product shortcut defect was established. See MACOS_COMPLETION_FRAMES_2026-10-05.md.

Two-hop redirect comparison now passes 12 exact original/current outputs and
pause-stability checks. It exposes a concrete remaining overhead: current repeats
both redirect hops per range while original uses the resolved address. Current
resume-to-useful-body median was 481.28 ms versus original 275.50 ms in this
fixture; response identity and credential scoping must survive any optimization.
See `MACOS_REDIRECT_COMPARISON_2026-10-05.md`. This is a measured open gap, not a fix.

Resolved-route reuse is now implemented in the macOS engine: later GET ranges
reuse validated request context while preserving original-origin and crossed-hop
credential boundaries. New resume still validates the entry route. Fresh requests
fell from 12 to 6 and post-resume requests from 15 to 6 in the two-hop comparison;
12 output hashes and paused-file checks passed. See the implementation update in
`MACOS_REDIRECT_COMPARISON_2026-10-05.md`; broader TLS/proxy/platform and packaged
acceptance remain separate.

The resolved-route optimization now also passes signed packaged Electron fresh
and UI pause/resume acceptance with its own embedded Host: one redirect chain
per discovery, exact output, error/HTML checks and one completion burst. See
`macos-packaged-resolved-route.json`. Installed deployment and transient
startup/occasional completion-frame acceptance remain open.
