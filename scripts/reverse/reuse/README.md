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
transport, storage policy, or HTTPS/proxy-auth validation.
