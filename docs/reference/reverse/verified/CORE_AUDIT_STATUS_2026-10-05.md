# Core-download audit: current status, 2026-10-05

This supersedes current-status claims in the historical 2026-10-04 priority audit.
The product remains Electron with the maintained Swift macOS engine and Windows
aria2 orchestration. Original Neat is reference evidence, not a replacement
backend. The active goal is not complete: selected native Windows/NTFS download cases
now pass, while broader filesystem/protocol coverage and installed-product
validation remain open.

## Requirement-by-requirement evidence

| Requirement | Current result | Authoritative evidence and boundary |
| --- | --- | --- |
| Assess original/reverse reliability | Key mechanisms have machine-code and isolated-runtime evidence; bulk decompilation is not treated as source truth | `CORE_PRIORITY_AUDIT_2026-10-04.md`, `WINDOWS_ORIGINAL_2026-10-04.md`; original Windows runs under CrossOver, not Windows OS acceptance |
| Windows same-size changed-file resume | Fixed pinned single-origin identity checks, including actual response checks after a successful probe | `WINDOWS_IDENTITY_GUARD_2026-10-04.md`; `windows-post-get-identity-regression.json` plus native Windows `windows-native-after-publication-fix/identity.json` cover unchanged, changed and changed-after-probe cases |
| Windows POST silently sent as GET | Engine API now preserves POST/body/content type and durably prevents ambiguous replay | `WINDOWS_POST_TASK_2026-10-05.md`; actual aria2 lifecycle and original reproduction; native Windows `windows-native-after-publication-fix/post.json` also passes; arbitrary browser POST body capture is not claimed |
| POST pause/restart correctness | Paused data remains intact; automatic continuation refuses replay; explicit restart is a fresh submission; missing restored authorization rejects before deleting bytes | `windows-post-task.json`, `windows-post-restart-preflight.json`; POST resume and body-preserving redirects are explicit limits |
| Startup HEAD/extra-response wait | macOS fresh eligible GET adopts its first open-range response; no HEAD or one-byte preflight in that path | `MACOS_FIRST_RESPONSE_STARTUP_2026-10-05.md`; native regressions, release Host comparison, actual Electron composer/file hash evidence; saved-range resume still validates identity |
| Startup shows zero speed despite receiving bytes | Added one early measured body-rate target; subsequent one-second cadence remains | `MACOS_STARTUP_SPEED_FEEDBACK_2026-10-05.md`; actual Electron observation 1213 ms before versus 405 ms after in one local pair |
| Default tail splitting adds latency | Added donor-specific body-time/setup-cost decision, preserving live parent and ownership | `MACOS_TAIL_PAYBACK_2026-10-05.md`; six outputs correct, default median 1408 to 880 ms and 11 to four requests in the delayed-tail fixture |
| Tail split recovery and many workers | Large stalled tails and sustained 32-worker handoff remain; small waiting 32-worker pool no longer creates speculative children | Full native run exposed one obsolete fault-fixture geometry; corrected fixture plus all affected integration/recovery suites passed 28 tests. Details in tail-payback note; do not label the pre-correction full command green |
| Unverified mirror switching | New tasks default to isolated file generations per source; failover, pause/resume, renewal, restart, publication and cleanup have local runtime evidence. Legacy unowned records preserve files and reject unsafe continuation | `WINDOWS_UNPINNED_MIRRORS_2026-10-05.md`, `WINDOWS_NATIVE_PUBLICATION_2026-10-05.md`; selected lifecycle, backup resume and restart-intent cases now pass on Windows/NTFS after fixing publication fsync; broader filesystem/installer acceptance remains open |
| Large-library completion/fireworks hitch | Fixed repeated Electron contextBridge object copies; packaged 3,748-record fixture improved from 374.8–391.9 ms maximum gaps to 41.7 ms single / 50.8 ms three completions / 42.1 ms after resume, preserving fireworks | `MACOS_LARGE_LIBRARY_COMPLETION_2026-10-05.md`; renderer timing only; installed 2026100503, visual acceptance pending unlock |
| Established connection drops near completion | Fixed failed lease waiting through socket cooldown after healthy workers finish; local 16 MiB median improved from 4916.93 to 1087.11 ms (original after-run 1142.42 ms), exact outputs preserved | `MACOS_DISCONNECT_HANDOFF_2026-10-05.md`; full native suite and release Host comparison; installed in 2026100503; visual acceptance pending unlock |
| SOCKS silently bypassed for local file destinations | Ordinary HTTP now uses explicit SOCKS transport; pause/resume and redirects remain correct. HTTPS loopback stays blocked pending a transport fix | `MACOS_SOCKS_FILE_TRANSPORT_2026-10-05.md`; native tests, release Host, 12 exact original/current outputs, signed-package pause/resume and fault QA; installed 2026100503; HLS/HTTPS loopback and visual acceptance remain open |
| Keep work reviewable | Scoped commits on main, pushed after validation | Git history; original installer preserved; installed macOS update 2026100503 retained all 3,748 tasks in the compared fields |

Artifact filenames above resolve under `core-audit-2026-10-04/` unless they are
Markdown notes. Passing a fixture proves its assertions, not every protocol or
site. Server body timestamps, engine progress observations and Electron-visible
feedback are different measurements and must not be conflated.

## Work still required

1. Expand Windows acceptance beyond the five passed native NTFS scenarios.
   Identity, POST, mirror lifecycle, backup resume and restart-intent recovery
   now have actual Windows runner evidence. Reparse-point adversarial cases,
   unselected lifecycle variants, other filesystems and installer behavior are
   not established by that job. Unsupported hard links or unprovable filesystem
   identities still fail while retaining data.
2. Expand current/original comparisons to TLS/proxy/CDN-like conditions and
   sustained large transfers, including speed ramp and recovery. Existing local
   normal/header-delay results cannot establish public-site superiority.
   Direct self-signed TLS rejection is now verified: current rejects before HTTP,
   while the original macOS 1.3 accepts and downloads the exact fixture. Preserve
   current protection; see `MACOS_DIRECT_TLS_2026-10-05.md`. Basic public trusted
   HTTPS now passes directly and through SOCKS in release and installed Hosts; see
   `MACOS_PUBLIC_TRUSTED_TLS_2026-10-05.md`. A 29 MB public archive also passes
   segmented pause/resume, forced tunnel disconnect and paused-Host restart; see
   `MACOS_PUBLIC_TLS_RESUME_2026-10-05.md`,
   `MACOS_PUBLIC_TLS_DISCONNECT_2026-10-05.md`, and
   `MACOS_PUBLIC_TLS_HOST_RESTART_2026-10-05.md`. These are current-engine, single-origin
   cases; original public-site comparison, active-write crash consistency, broader
   origins/certificates and endurance remain open. Original SOCKS5 loopback/name routing
   and refusal are now measured. Ordinary HTTP file routing is implemented and
   compared; HTTPS loopback and HLS remain restricted. See
   `MACOS_SOCKS_FILE_TRANSPORT_2026-10-05.md`.
3. Validate the packaged Electron product and Windows installer/UI. Native
   Windows download fixtures now supplement macOS orchestration and CrossOver
   original research, but do not prove installed UI behavior. Preserve installed
   tasks during any deployment; recent diagnostic/focus fixes are not yet installed.
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

Browser POST audit found and fixed a separate duplicate submission: top-level
form downloads were first submitted by Chrome, then replayed by NDM after response
headers. Relay 1.4.18 now leaves observed POST and its redirect chain browser-owned.
Real main-frame/iframe/303 form checks verify one body submission and exact output;
an ordinary GET handoff still passes. This does not implement pre-submission form
transfer into NDM. See `RELAY_POST_SINGLE_SUBMISSION_2026-10-05.md`.

### Large-library completion bottleneck

Read-only installed inventory exposed a 3,748-task scale missing from earlier
small-library QA. The matching synthetic packaged fixture reproduced two
350–390 ms completion gaps. CPU sampling localized the dominant cost to repeated
contextBridge event-object copying for UI subscribers. Shared serialized delivery
and serialized list/notification summaries reduced final packaged maxima to
41.7 ms (single), 50.8 ms (three completions), and 42.1 ms (pause/resume). All files
matched and fireworks remained; 788 TS tests passed with eight existing skips.
See `MACOS_LARGE_LIBRARY_COMPLETION_2026-10-05.md` and
`macos-large-library-completion.json`. This supersedes the earlier inability to
reproduce the large stall; installed-product and startup-black-screen acceptance
are still open. The installed app and its real tasks were not modified.

### Packaged delayed-window startup check

`qa-window-startup.mjs` now accepts a packaged executable, reads its exact renderer
assets from app.asar, and preserves a report and loading-shell screenshot. In
`macos-packaged-window-startup.json`, early second-instance wake could not show
the unpainted window. With HTML delivered and the module held for 2,004 ms, the
window remained hidden, including a second wake; capturePage contained the
loading text but was not user-visible. Releasing the module mounted the real UI,
and subsequent hide/wake restored visibility. This verifies this delayed-load
path in the packaged main process with a fake isolated engine, not the original
installed-build black-screen cause or every GPU/crash scenario. The harness now
flushes HTML headers before holding the body so attachment does not deadlock.

### Installed build 2026100501

The guarded installation is now complete: version 2026.10.5, verified Apple
signature, installed/package asar and Host hash parity, running installed
processes and healthy engine RPC. All 3,748 task IDs/statuses/URLs/names/paths/byte
counts/sizes matched the private pre-update snapshot. The old bundle is retained.
The exact release package passed combined large-library, delayed-redirect and
pause/resume QA with a 34.6 ms maximum completion frame interval. See
`MACOS_INSTALLED_2026100501.md` and `macos-installed-2026100501.json`.
Actual installed-window inspection is still pending because the Mac is locked;
health checks do not close that visual gate. Browser Relay reload is also separate
from bundling version 1.4.18.

### Disconnected parent-range handoff

A new paired fault fixture closed one established nonzero range after 256 KiB.
Original completed in about 1.15 seconds; current retained a small parent suffix
through its 4.5-second cooldown and needed about 4.92 seconds. The scheduler now
allows one transport recovery opportunity per healthy completion with idle
capacity, while preserving admission, cancellation and no-healthy-worker backoff.
After-run current median was 1.087 seconds versus original 1.142 seconds, with
all exact file hashes matching. Full native tests and release build passed.
See `MACOS_DISCONNECT_HANDOFF_2026-10-05.md` and before/after JSON artifacts.
This fix is later than installed build 2026100501; installed deployment and
visual acceptance remain separate gates.

### Installed build 2026100502: actual composer disconnect recovery

The next signed macOS release includes the disconnected-suffix handoff fix.
The exact package passed an actual composer download with 3,748 synthetic history
records, a delayed two-hop redirect chain, and one forced nonzero-range disconnect
after 256 KiB. The failed prefix resumed receiving body after 781 ms (below the
3,500 ms fixture budget), final bytes matched, and subsequent ranges retained
the learned redirect route. Completion maximum rAF interval was 41.9 ms with one
fireworks invocation after 12.1 ms and no renderer long tasks.

Build 2026100502 was installed with the previous bundle retained at
`/Applications/.NDM-backup-a6fcd0e9-7787-4d56-8727-f4a336ca1035.app`.
The old app was normally quit by verified process identity after confirming no
active tasks; both old PIDs exited before the bundle swap. All 3,748 task IDs,
statuses, URLs, names, folder paths, completed bytes and sizes matched the private
before snapshot. Installed/package asar and Host hashes matched, deep/strict
signature verification passed, and new installed processes/engine RPC were live.
See `macos-installed-2026100502.json`. Actual installed-window visual acceptance
still awaits unlock; browser Relay reload and native Windows acceptance remain
separate.

To regain build space, 12 hash-verified synthetic outputs (192 MiB) from the
before/after disconnect comparison were removed from only their owned output
directories. Reports/logs remain. Paths, sizes and hashes are recorded in
`disconnect-payload-cleanup.json`; no real download or old-app backup was removed.


Signed build 2026100503 now passes packaged SOCKS pause/resume and disconnect
acceptance with the 3,748-row fixture, exact outputs and retained fireworks. It is
installed with identical compared real-task fields, matching asar/Host hashes and
deep/strict signing verification. `MACOS_RELEASE_2026100503.md` records evidence
and the retained backup. Actual installed-window inspection remains pending
because computer-use reports the Mac locked. HTTPS loopback, HLS proxy and native
Windows work remain open.

### Installed Host / original SOCKS recovery comparison

`MACOS_SOCKS_RECOVERY_COMPARISON_2026-10-05.md` adds 18 exact 16 MiB outputs:
six established-connection interruption cases and twelve pause/resume cases.
Both engines reuse interrupted prefixes and preserve stable paused files.
Interrupted completion medians are essentially equal (1089.63 / 1090.40 ms).
Pause timing and remaining work differ because of original instrumentation and
sampling; no general speed superiority is claimed. HTTP-over-SOCKS only; large
trusted HTTPS and installed visual acceptance remain open.

### Proxy failure explanation

`MACOS_PROXY_FAILURE_DIAGNOSTIC_2026-10-05.md` records the reproduced generic
CFNetwork 310 message and its domain/code-specific replacement. Release Host
runtime now returns a localized proxy connection failure with retry guidance;
normal public TLS downloads still match. Full native tests/build passed.
This diagnostic change is source/release-Host verified, not yet installed in
2026100503. It does not change transport behavior or close HTTPS loopback limits.

### Public trusted HTTPS archive pause/resume

`MACOS_PUBLIC_TLS_RESUME_2026-10-05.md` adds a 29,186,321-byte fixed Python archive
through direct and SOCKS paths in both release and installed 2026100503 Hosts.
All four paused files remained stable for one second and completed with the
independent curl hash. Four-range receipts and renewed proxy connections were
verified. This closes the single-origin trusted HTTPS pause/resume smoke gap;
abrupt TLS disconnection, endurance, original comparison and other origins
remain unverified. It is not a throughput or visual-acceptance claim.

### Public HTTPS mid-transfer disconnection

`MACOS_PUBLIC_TLS_DISCONNECT_2026-10-05.md` closes the single-origin abrupt TLS
connection loss smoke gap: after a non-initial SOCKS connection forwards over
1 MiB, the fixture closes it. Both release and installed Hosts automatically
recover and deliver the exact 29,186,321-byte archive. Logs confirm healthy-worker
handoff releases the failed segment's cooldown. Single uncontrolled trials do
not prove speed superiority or broad-origin reliability; original public-site
comparison, endurance and other protocol/platform limits remain open.

### Paused public HTTPS tasks across process restart

`MACOS_PUBLIC_TLS_HOST_RESTART_2026-10-05.md` verifies release-Host replacement
after a confirmed durable pause. Direct and SOCKS tasks restore paused IDs and
progress, preserve exact partial-file/receipt hashes, then complete with the
independent archive hash. The owned paused processes receive SIGTERM and their
exit is awaited. This closes controlled paused-Host restart coverage, not active
write crash consistency or Electron Quit/visual acceptance.

### Native Windows/NTFS recovery evidence and completion fix

`WINDOWS_NATIVE_PUBLICATION_2026-10-05.md` supersedes the blanket macOS-only
boundary for the five selected Windows core scenarios. A real Windows runner
reproduced `EPERM: fsync` when publishing a complete mirror payload. Commit
`7a36707` changes the owned settled payload handle from read-only to non-truncating
read/write. The Windows download recovery job then passes identity, POST, mirror
publication, backup pause/resume and restart-intent recovery on NTFS. Full
installer/UI and broader filesystem coverage remain open. The ordinary Desktop
CI jobs still fail (Windows unit suite, Linux UI QA); do not infer overall CI
success from the dedicated download job.
