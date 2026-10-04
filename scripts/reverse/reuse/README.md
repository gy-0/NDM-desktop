# Direct original-engine control experiment (macOS)

Run from the primary repository:

```sh
python3 scripts/reverse/reuse/run.py
```

This is a research adapter, not a shipped downloader or an engine SDK. It requires
macOS, Python 3, clang, codesign, sandbox-exec and `/usr/bin/trash`, plus the exact
original `/Applications/NeatDownloadManager.app` SHA pinned in `run.py`. No Python
third-party dependencies are required.

The script creates a uniquely named `/Applications/NDMEngineProbe-*.app` copy,
changes only its bundle identity/signature, and verifies the engine text-section
hash against the source. It builds `probe.m` and loads it into that copy. The
library remaps the browser bridge port and uses runtime-checked Objective-C
method signatures to read task state and call pause/resume; it does not patch the
C++ downloader. Command files are confined to a private temporary directory. This
is an experimental file mailbox, not a general RPC endpoint or arbitrary method
invocation service.

The test uses a unique profile, output directory, bridge port and loopback HTTP
server. Sandbox rules deny non-loopback networking and writes to the real home
directory, plus reads of the original product's database/preferences paths. It
asserts the actual support/output paths and starts from an empty task library.
It does not open the user's NDM task library or stop their downloader.

Assertions:

- An ordinary 32 MiB download is received by the original engine using its own
  WebSocket intake protocol.
- Progress and task ID come from engine controller methods, not window titles.
- Programmatic pause reaches non-working state; all four segment files remain
  byte-identical over one second.
- Programmatic resume advances the same task.
- A second settled pause survives process exit; a newly launched process loads
  exactly the same record and unchanged segment files. `resumeDownload:` takes a
  **row index**, looked up by task ID; it is not called with the ID as an index.
- Completion waits for the original record's `Complete` state, then verifies the
  final byte count and SHA-256. File existence alone is not completion because
  the original creates the final path while merging.
- The reference process stops, the source remains unchanged and the test App copy
  is moved to Trash. Small reports and the owned synthetic output remain in the
  printed temporary directory for inspection.

Original windows may still appear. This experiment does not prove a reliable
headless backend, authentication/permission-dialog routing, all error recovery,
Windows compatibility, product integration, or redistribution permission. Those
are separate gates; do not label this research script a production engine.

Optional background experiment:

```sh
python3 scripts/reverse/reuse/run.py --headless
```

This mode intercepts `NSWindow.orderWindow:relativeTo:` in the research process
and suppresses ordering windows on screen. It does not answer dialogs or alter
download decisions. The snapshot records intercepted presentation requests,
visible-window samples (every 200 ms), and authentication state. Both before and
after engine restart, the harness requires zero samples of visible windows; this
is instrumentation evidence, not a screen recording or proof of every AppKit
presentation path. The full download/hash checks still apply. A subsequent HTTP
404 must produce an original error record while snapshots continue arriving.
Authentication, sheets/modal sessions, permission prompts and arbitrary errors
remain unverified. Suppressing presentation alone is not a production solution
for interactions that require user input.

The background run also submits a Basic-auth HTTP 401 challenge. It requires
`isAuthenticating == true` and a fresh snapshot. The adapter intercepts
`beginSheet:completionHandler:` only for `NeatAuthWindow`, retains its original
completion block, and exposes the pending count. An explicit `cancel-auth`
command removes the saved block before calling it with `NSModalResponseCancel`.
The original callback performs its normal state transition. The harness requires
one pending callback before cancellation, zero afterwards, one completion, zero
visible-window samples, and an Error record. This cancellation case uses no credentials.

Earlier evidence deliberately records `authenticationStayedHidden: false` with
the ordinary-window hook alone. The current harness asserts this field is true;
it no longer calls `handleAuthWindow:` directly as a substitute for sheet
completion. Non-auth sheets remain unverified. Passing this fixture is not a production-readiness claim.

The extended authentication fixture creates two simultaneous Basic-auth
challenges. A wrong synthetic password for task A must produce a new challenge
without affecting B; cancelling B must leave A awaiting input. Submitting the
correct synthetic credentials for A must complete a byte-identical download,
while B remains an error with no final output. All four completion callbacks
(including the earlier standalone cancellation) must be released and no visible
windows sampled. `submit-auth` fills the original authentication controller's
fields, disables its Remember option, and invokes its retained completion with
OK. Type checks guard those outlets. Credentials are synthetic and used only
in the private temporary fixture mailbox/profile; request logs record a boolean
match, never the Authorization header. This is not yet a production credential
transport, storage policy, or proxy-auth validation.

Submission now serializes this isolated single producer: after an acknowledged
new record, wait at least 550 ms before the next intake message. This accounts
for the verified original 500 ms global intake suppression. WebSocket 101 or a
successful send alone is not acceptance: the harness waits for exactly one new
original record ID and reports it. Zero IDs time out; multiple IDs are ambiguous
and fail. It never blindly resends an uncertain request. Six consecutive caller
submissions must produce six distinct IDs and expected HTTP 404 outcomes. This
is not multi-producer correlation, crash-safe idempotency, or production retry
logic; those remain integration work.

Resource identity audit:

```sh
python3 scripts/reverse/reuse/run.py --headless --identity-change
```

After the second settled pause, the server replaces the payload with different
random bytes of exactly the same length and changes its strong ETag. The engine
then restarts and resumes its persisted task. The server honors If-Match (412 on
mismatch) and If-Range (full 200 on mismatch); it does not deliberately violate
those conditionals. Each response retains its own body snapshot. The report
compares the completed output with both versions byte by byte and records
conditional headers and ETags. A stale or mixed file raises an assertion and
leaves `passed: false`; this is an audit finding, not a successful reuse test.
The normal cleanup still stops the owned process and trashes its copied App.

Experimental response identity guard:

```sh
python3 scripts/reverse/reuse/run.py --headless --identity-change --identity-guard
python3 scripts/reverse/reuse/run.py --headless --identity-guard
```

`identity_guard.py` forwards only to the fixture's fixed loopback origin. It pins
an initial strong ETag per path and checks every successful upstream response
before reading/forwarding its body. Missing/weak/different ETags produce 412 to
the original engine. It does not trust conditional-request compliance or add a
preflight HEAD. The changed-resource case must enter Error, create no final file,
and leave saved segments byte-identical. The normal run retains all download,
restart, authentication and intake assertions through the same guard.

This is a research adapter, not production HTTP/HTTPS proxying. Redirects,
cookies, cache variation, weak/no validators, size/range consistency, persistent
queue recovery and automatic fresh-download policy are not implemented here.
The JSON pin file uses atomic replacement but is not a proven crash-durable
store. By default only the original engine restarts; see --restart-guard below for
reconstructing the guard server instance from its saved state.

Verified TLS upstream fixture:

```sh
python3 scripts/reverse/reuse/run.py --headless --identity-guard --tls-upstream
python3 scripts/reverse/reuse/run.py --headless --identity-guard --tls-upstream --identity-change
```

The harness generates a one-day test certificate/key in its private temporary
directory. Only the guard's private SSLContext trusts it; no Keychain/system trust
changes occur. The guard requires CERT_REQUIRED and hostname checking. An initial
negative test using ordinary system trust must reject that test certificate,
return an empty 502 response and create no resource pin. The real test uses the
trusted context and the same identity/download checks over TLS upstream.
The original engine still receives loopback HTTP from the guard. This verifies
the adapter's TLS transport, not original-engine native TLS, public-site
compatibility, redirects, client certificates or production trust provisioning.

Original POST semantics audit (direct transport):

```sh
python3 scripts/reverse/reuse/run.py --headless --post-audit
```

Submits the original bridge protocol with method POST and its historical
`__0NeatPostData9__:` body delimiter. The fixture requires byte-identical URL-encoded
ASCII form data (including a percent-encoded Unicode value and repeated keys),
rejects GET with 405, and rejects a wrong body with 400. Every received POST logs
its body hash/length and Range, then serves a deterministic export payload.
Completion requires the full file SHA and all requests retaining POST/body.
This is a repeatable export fixture: it does not authorize replaying arbitrary
POST actions with side effects. Windows behavior, binary bodies, redirects and
POST through the identity guard remain separate unverified work. The CLI refuses
to combine this audit with the GET-only guard.

Structured engine progress: the adapter checks and observes the original
`handleEngineNotifyDownload:` method, preserving its normal invocation. For this
pinned binary its payload is `bytes@bytesPerSecond@ETA@start*completed@...`.
The adapter publishes numeric `engineProgress.completedBytes`, `bytesPerSecond`
and segment start/completed pairs. It does not scrape labels or estimate bytes
from a displayed percentage. Invalid payloads clear the observation. The harness
requires the sum of segment bytes to equal total completed bytes and checks that
this total agrees with the independently exposed percent for the known fixture.
Progress remains the last notification: callers must combine it with working,
authentication and record states, particularly for paused tasks.

Submission receipts: `receipts.py` persists pending requests before sending, using
file fsync, atomic replacement and directory fsync, then records the accepted
original task ID. Replaying a confirmed key returns the same ID; changing the
request under that key is rejected. An unresolved pending request blocks new
submissions. Recovery only accepts one new GET record matching URL/method outside
the saved pre-send ID set; missing/ambiguous records and unknown POST bodies stay
uncertain and are never resent automatically. This relies on the isolated single
producer and same original profile.

The live harness deliberately loses acknowledgement after original acceptance,
then recovers the saved receipt in a fresh Python process using a read-only
query of the isolated original database (its in-memory list omits URL/method). Replaying the request
must return the same ID with only one created record. Six recovery and negative
contract tests run with:

```sh
python3 -m unittest discover -s scripts/reverse/reuse -p test_receipts.py
```

This does not prove power-loss durability, multi-process locking, profile
migration, or the full production adapter lifecycle. Journal recovery is tested
in a new process; the complete app has not switched to this backend.

Guard state reload:

```sh
python3 scripts/reverse/reuse/run.py --headless --identity-guard --tls-upstream --restart-guard
python3 scripts/reverse/reuse/run.py --headless --identity-guard --tls-upstream --restart-guard --identity-change
```

The original process exits after a settled pause. The guard server is shut down
and reconstructed on the same loopback port using its saved pin store, before
the original restarts. Unchanged content must resume successfully; changed content
must be rejected with old segments intact. This reconstructs the server object,
not the entire Python driver process. Pin files include a schema version and
fixed origin (including transport/port); malformed, legacy or mismatched stores
fail closed instead of resetting to an empty map. Writes fsync both file and
containing directory. Actual power loss and whole-driver restart remain untested.
Run all nine current helper tests with `python3 -m unittest discover -s
scripts/reverse/reuse -p 'test_*.py'` (one line).

Pause acknowledgement now means settled control state: the probe invokes the
original method, then waits on subsequent main-queue ticks for `isWorking` to
become false before writing a successful reply (`accepted: true`, `settled:
true`, `workingAfter: false`). A monotonic ten-second deadline returns an error
instead of claiming success. No blocking sleep is added to the original main
thread. The harness additionally checks all segment hashes stay unchanged for
one second after that reply. Authentication/wait interactions reject pause/resume
with `interaction-required`; authentication cancellation remains explicit.
Resume acknowledgement still means command accepted, not first bytes received.
The file mailbox remains a single-producer research interface, not a concurrent
production RPC queue.

## Windows original under CrossOver

`python3 scripts/reverse/reuse/windows/smoke.py /path/to/extracted/NeatDM.exe`
creates a fresh private Windows 10 64-bit bottle on macOS. It requires the
locally installed CrossOver and the SHA-pinned original x86 EXE; it does not
download dependencies or use an existing bottle. A private EXE copy changes only
the immediate port operand at VA `0x004e269c` (PE offset `0xe1a9c` instruction,
operand starts one byte later). No download algorithm is changed.

The child sandbox denies real-home writes and non-loopback IP traffic; known
NDM data directories are read-protected. Home-pointing symlinks in the new bottle
are replaced with private directories, leaving their original targets untouched.
The probe validates HTTP 101 and the per-request WebSocket accept digest for
`neatextension.v1`. Finally it stops and waits for only this absolute-path bottle's
wineserver, checks the source EXE is unchanged, and retains logs/report in the
printed temporary directory. No download is submitted, and no product backend
is switched. This proves executable startup and bridge connectivity under the
compatibility layer, not transfer correctness or native Windows acceptance.

Add `--transfer` to submit a generated 8 MiB loopback HTTP fixture through that
same bridge. The server records actual request methods and ranges. Success
requires the downloaded file's size and SHA-256 to match the generated source
and the unique original database task to have status `Complete` (read-only query);
the fixture is never saved into the real Downloads directory. Add `--inspect-ui` to compile the
read-only `inspect.c` helper with `i686-w64-mingw32-gcc`, use a throttled 32 MiB
fixture, and save an inventory of the original process's windows and controls
to `windows.txt`. It does not click or change any controls.

`--transfer --pause-resume` uses the same slow fixture. The helper finds the
original process by its main window class, requires exactly one download window
with the fixture's exact URL, and verifies button 1051 is enabled and labeled
Pause/Resume before sending BM_CLICK. This deliberately exercises the original
window controller, not an assumed internal function ABI. Pause acceptance is
followed by comparing nonempty segment-file hashes one second apart. The harness
then resumes, requires subsequent Range requests to start at nonzero offsets,
and verifies both the completed database task and final SHA. The helper does not
operate any task outside the newly created bottle. This is not yet a headless
production adapter. Process-restart recovery requires the flag below.

Add `--restart-engine` to `--transfer --pause-resume` to stop and wait for the
private Wine bottle after segments settle, verify the persisted paused task and
unchanged segment hashes, and start a new original process. Recovery uses the
existing record: the helper matches the saved task ID against visible list-item
lParam, additionally checks the filename, reads the toolbar's Resume command ID,
clears prior selections, selects only that row and
invokes Resume. Standard-control buffers are allocated in the target process
and freed after use; no helper-local pointer is sent as remote item data. The
final task ID must match the paused ID. No WebSocket task is re-submitted.
The test stops an already-paused engine; it does not simulate power loss while
writing. The controller requires the target in the visible list (at most 512
rows); it is not a general production task API.

Add `--multi-task` to the direct GET restart test to retain a completed second
task, reject an unknown ID without transfer activity, restore the paused task by
ID, and verify the other task's status and file hash remain unchanged. Submit
both tasks through the same persistent WebSocket connection. In two experiments,
a second simultaneous connection completed the handshake but did not create its
task, including when held open; the precise receiver mechanism is unverified.

Use `--cc /absolute/path/to/compiler-wrapper` when MinGW is not on PATH. A wrapper
executing `zig cc -target x86-windows-gnu "$@"` was tested with Zig 0.17.0.
Compiler availability is checked before creating the private bottle.

Add `--identity-change` to `--transfer --pause-resume` to replace the paused
resource with same-length bytes (every byte XOR 255) and a different strong ETag.
Each response captures one immutable body/ETag pair. The fixture honors If-Match
and If-Range and records whether the original sends them. An original Complete
record with a wrong SHA fails the run and records exact old/new byte counts.

Add `--identity-guard` to route GETs through the same research response guard used
by the Mac harness. It pins and checks the actual response ETag before forwarding
body data. For the changed-resource case, success requires an original Error
record, a recorded guard rejection, unchanged saved segment hashes, and no final
file. Without `--identity-change`, success still requires normal resumed transfer,
nonzero Range offsets, Complete, and correct SHA. The guard remains a fixed-origin
loopback research component, not a production proxy or a fix deployed to the
current aria2 backend. Windows HTTPS and POST are not covered by these guard
commands. `--restart-engine` restarts only the original process/bottle while the
Python fixture and guard keep running.

`--transfer --pause-resume --post-audit` uses a repeatable local export endpoint
which rejects any method other than POST, any altered request body, or a missing/
changed Content-Type. The bridge carries the body after `__0NeatPostData9__:` and
the explicit Content-Type header, matching the Relay wire format. Every initial
and resumed segment request must preserve all three, and the durable task must
still record POST. The original can repeat the POST once per connection and again
on resume; this result does not authorize repeating arbitrary state-changing
POSTs. Add `--restart-engine` to verify persisted POST recovery. Binary bodies,
redirects and production integration are unverified. POST audit rejects the GET-only guard and identity
mutation flags rather than implying those combinations work.

## Desktop command transport (macOS reference adapter)

`src/main/original/control.ts` provides the desktop-side serialized command
transport for the instrumented reference process. It supports pause/resume and
explicit authentication replies; this does not select a new EngineClient backend.
Each command uses a random nonce. Matching negative replies remain negative;
stale replies are ignored. Cross-process exclusive lock creation and atomic
no-replace command publication prevent overwriting another producer's command.
A timeout or malformed matching reply after publication leaves the lock as an
uncertain outcome. Never delete that lock based on age or replay automatically;
reconciliation/recovery still needs a production implementation. The directory
must belong to the explicitly launched isolated reference process.

To validate against the actual original engine, bundle
`scripts/reverse/reuse/desktop-control.mjs` with esbuild (Node platform, ESM),
then run `python3 scripts/reverse/reuse/run.py --headless --desktop-control
/absolute/path/to/bundle.mjs`. The harness sends credentials through stdin and
counts acknowledged transport calls in `desktopControlReplies`. It continues
to verify pause settlement, restart recovery, file hashes, authentication and
absence of visible original windows. This CLI is an isolated QA entry point;
the installed application and its existing download backend remain unchanged.

Verified 2026-10-05: `core-audit-2026-10-04/macos-desktop-control.json` records
9 desktop transport replies, 32 MiB byte verification, successful original-process
restart recovery and authentication flows, zero visible-window samples, unchanged
source binary and terminated private process. Desktop checks: typecheck/build
passed; 751 tests, 743 passed and 8 skipped. This proves command transport against
macOS original 1.3, not full desktop backend integration or Windows behavior.

## Desktop task snapshots

`src/main/original/snapshot.ts` converts the isolated macOS adapter's snapshots
into the desktop task wire shape. The in-memory original list contains formatted
sizes such as `32.0 MB`, not exact metadata. The probe therefore reads an explicit
field whitelist from NeatDB using a read-only connection, joins it by durable ID
with list status and live engine progress, and exports no POST body/credential
fields. Failed DB reads suppress the sample instead of publishing an empty list.
The current research probe reads metadata every 200 ms; large-library overhead
and production notification/caching remain unvalidated.

The reader requires the currently launched PID and a fresh timestamp, rejects
duplicate/orphan IDs and inconsistent segment bytes, and zeros inactive speed.
Persisted percentages without live progress remain display fractions, never
fabricated exact completed-byte counts. A numeric percentage without a running
engine is `incomplete`, not `downloading`. Original folderpath can remain empty
until completion; the mapper preserves this unknown path and requires it for a
completed record. This is task-data adaptation, not yet an activated backend.

Live verification on 2026-10-05 passed with the desktop reader: two settled pause
snapshots and the completed library snapshot were checked by the harness, and an
additional sample captured a real transferring task alongside completed/error
records. Evidence: `macos-desktop-snapshots.json`,
`macos-desktop-live-snapshot.json`, and the initial display-field discovery
`macos-display-metadata-discovery.json` in core-audit-2026-10-04. The 32 MiB
output matched its fixture; all original windows stayed hidden; the test process
stopped, test copy went to Trash and installed original binary remained unchanged.
Typecheck/build passed; 747 tests passed, 8 skipped.

## Owned-process lifecycle

`src/main/original/session.ts` owns one explicitly spawned reference process.
A directory-scoped exclusive session lock prevents competing launches; a retained
lock is never removed merely because it is old. Readiness requires a fresh,
validated snapshot from that child's PID. Child output is drained, duplicate
start/stop calls share their operation, and unexpected exit invalidates reads.
Stopping during startup waits for the owned launch; stopping an idle session
prevents a later launch through that session.

Shutdown reads actual worker flags, refuses pending authentication/waiting,
pauses running workers through the nonce-matched control transport, requires a
newer sample with no working workers, then sends SIGTERM only to its own child
and waits for exit. Uncertain settlement or exit leaves the process retained;
there is no force-kill, name-based process lookup, automatic restart or replay.
The caller must stop admitting new downloads during shutdown; production intake
and crash/stale-lock recovery are still outstanding.

Bundle `desktop-session.mjs` with esbuild (Node/ESM), then add
`--desktop-session /absolute/path/to/bundle.mjs` alongside `--desktop-control`
to the Mac harness. In this mode the harness deliberately resumes an active
transfer before shutdown, verifies stable saved segments after the lifecycle
manager exits, restarts through a new session, and verifies the same task ID and
final SHA. Session receipts identify both wrapper and actual engine PIDs.

A live shutdown race was found: the task could finish and remove its controller
between the worker snapshot and pause delivery. The resulting negative reply is
now reconciled with a newer validated sample; shutdown proceeds only if that
worker has disappeared or is no longer working/waiting/authenticating. An unknown
command outcome still blocks shutdown. Failure evidence is retained in
`macos-session-shutdown-race.txt`; that failed run is not counted as a pass.
The harness now preserves reports on cleanup failure and retains a research app
copy while its managed process may still be alive.

Verified 2026-10-05 after the reconciliation fix: `macos-desktop-session.json`
records two successful managed process exits, active-transfer settlement,
stable saved segments, recovery of the same task in a new engine process,
32 MiB fixture SHA equality, hidden original windows and authentication checks.
Both test processes exited and the research copy was trashed; the installed
original stayed unchanged. Typecheck/build passed; 753 tests passed, 8 skipped.
This remains an opt-in research runner, not a switched production EngineClient.

## Desktop task intake

`src/main/original/intake.ts` submits HTTP GET and UTF-8 POST requests on one
persistent original-extension WebSocket channel. Calls are serialized, spaced
from confirmed acceptance to satisfy the original 500 ms gate, and matched to
new durable IDs using exact URL/method plus the prior ID set. More than one new
record is ambiguous, never an excuse to pick the first row. A separate intake
lock excludes competing desktop producers in the same support directory.

The fsynced journal records a request fingerprint and pending entry before send.
Confirmed keys return the same ID without creating another task. A pending GET
can be reconciled against exactly one matching new record by a later client;
a pending POST cannot be recovered by URL alone because the snapshot does not
prove its body identity. Any unresolved entry blocks further creation. There is
no timeout resend. The journal stores a hash, not raw POST bodies. Binary POST,
arbitrary headers, redirect semantics, production packaging and Windows runtime
validation of this TypeScript transport remain outstanding.

The desktop-session QA runner now routes submissions through this class while
retaining the Python receipt checks as an independent outer client. Add
`--post-audit` to verify repeatable POST body delivery. Original-session shutdown
stops admitting fixture submissions and drains intake before settling the engine.

Live macOS verification on 2026-10-05 passed: `macos-desktop-intake.json` records
13 desktop-created tasks, sequential burst acceptance, original-engine restart,
authentication flows, receipt recovery and a repeatable POST with exact body and
32 MiB output SHA. The research processes stopped and copy was trashed; installed
original remained unchanged. The final first-use spacing refinement is covered
by the transport tests; the live run used the preceding conservative spacing.
This does not yet select the original engine in Electron's EngineClient.
