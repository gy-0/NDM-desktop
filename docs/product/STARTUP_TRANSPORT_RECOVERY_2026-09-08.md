# Startup transport recovery

2026-09-08. This addresses startup failures separately from resumable worker disconnects. [Original instruction evidence](../reference/reverse/verified/TRANSPORT_RECOVERY.md) shows the reference's initial attempt plus three reschedules before the first data write, with distinct behavior for HTTP errors and initial DNS failure. Neat does not have NDM's identical HEAD/Range-zero probe abstraction; this is a bounded adaptation, not a claim of wire-level identity.

## Reproduced failure and repair

The initial loopback fixture returned HEAD 405, then sent a valid one-byte Range response header and closed TCP before sending its body. Before the repair the actual sequence was only HEAD, GET; URLSession returned -1005 and the task failed. There was no hidden URLSession retry. Evidence: `/tmp/ndm-startup-network-red.log`.

`probeRemoteWithAuth` now maintains a separate transport budget of three reschedules for safe GET/HEAD startup requests and explicit connection-lost, timeout or cannot-connect errors. Each retry rebuilds and signs requests instead of reusing an old Digest nonce count. Authentication challenge attempts remain separate. POST/PUT/PATCH, DNS/offline, certificate failures and explicit HTTP errors are not blindly replayed by this policy.

A Range probe returning 403/500 previously became non-range metadata and could lead to another full GET. It now fails explicitly. An empty resource explicitly reported as HTTP 416 with `Content-Range: bytes */0` remains compatible with the subsequent empty full response.

Pausing now cancels the active metadata request task without invalidating its URLSession. Full-suite testing caught a session invalidation/task-creation race; request-scoped cancellation removes that crash while retaining prompt pause. Stop checks before/after probe I/O and immediately after probe completion prevent a late response from allocating output or starting workers after the user pauses.

## Verification scope

`StartupNetworkRecoveryTests` has eight focused tests: two transient disconnects followed by correct full SHA; initial plus three failures with no worker start; exactly one body-bearing POST; no extra full GET after 403/500; prompt HEAD and Range probe pause without output allocation; rebuilt unique Digest nonce counts; HEAD-unsupported empty-file 416 compatibility; and pause-before-start without network or filesystem side effects. The original seven passed in `/tmp/ndm-startup-boundary-green.log`; final regression results are recorded below.

This does not prove full authentication, redirect, proxy or original timeout equivalence. The full behavior audit remains open. Native regression and release validation results follow.

Startup no longer resets an already-signalled pause. DownloadManager creates a new engine for resume, so a pause that wins the scheduling race must stop that engine before any startup I/O.

Final validation: full native suite passed 993 XCTest cases (7 skipped) and 11 Swift Testing cases in `/tmp/ndm-startup-full-native-fixed.log`. After the additional pause-before-start guard, all 26 affected startup/lifecycle/integrity cases passed in `/tmp/ndm-startup-final-focused.log`. No claim is made that the last guard received a second full-suite run.

Released locally as 2026.9.8 build 2026090829. Package/release-native build and stable signature verification passed; installed Host and app.asar match the signed package. Installed Host SHA-256: `26e30a862acd82889c7a4757f456315a38dec951b237ae23f156e0d22486129d`. Host list is healthy; original task 3745 remains complete at 63,544,014 bytes.
