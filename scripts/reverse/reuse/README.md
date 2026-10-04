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
