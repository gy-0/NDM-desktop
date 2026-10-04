# Windows POST task integration

This follows `WINDOWS_POST_TRANSPORT_2026-10-05.md` and enables ordinary single-URL
HTTP POST in the Windows engine API when its full-response transport is available.
It does not add POST capture to the browser extension or claim Windows OS QA.

The original Windows reference preserved POST/body but repeated submissions for
segments and resume (`windows-original-post-resume.json`, described in
`WINDOWS_ORIGINAL_2026-10-04.md`). Our task path instead uses the single-submission
relay, one aria2 connection, no transport retries or suffix continuation, and no
GET/HEAD representation probe. POST response bytes still use the existing aria2
file ownership, bandwidth and progress machinery.

Request contract matches the native Host: `body` is UTF-8 text; `postData` is
strict base64 for binary bytes. Supplying both, malformed bodies, methods other
than GET/POST, or POST mixed with media/mirrors/non-HTTP URLs is rejected before
task/receipt creation. Empty POST is valid. Bodies are limited to 16 MiB.

The private atomic task ledger stores versioned base64 bytes, content type,
required header names and a durable attempted flag. The existing state writer
creates files with mode 0600; base64 is encoding, not encryption. Request body
and header values are not exposed in public task snapshots. Authorization/custom
header values retain the existing in-memory-only policy. A restored task missing
required headers fails before submission and asks for a fresh source request.

Creation receipts include the normalized POST body hash and content type without
changing historical GET digests. Changed content cannot reuse an old receipt;
a lost-reply replay returns the existing task. Before handing a route to aria2,
the task writes its attempted marker. Failed marker persistence prevents network
dispatch; the in-memory attempt also stays latched. A crash after that commit
cannot automatically resubmit an ambiguous request.

Pause settles aria2 and preserves the partial file. Relay cancellation caused by
that pause is no longer reported as a transfer error. Once submitted, ordinary
resume (including after process restart) refuses automatic replay. Explicit
`restart` uses the existing stop/owned-artifact cleanup, commits a fresh attempt,
and starts from zero. Replacing only the URL is rejected for POST. The public
connection/segment presentation reflects the actual single connection.

This is an explicit functionality boundary: POST responses cannot generally be
resumed from offsets without resubmitting the operation. Users must choose a new
download attempt; the implementation does not pretend saved bytes are safely
resumable. Body-preserving 307/308 redirects remain rejected. These limitations
must not be described as parity with all original POST behaviors.

## Runtime evidence

`scripts/qa-windows-post-task.mjs` runs the actual Windows task implementation with
an isolated aria2 daemon and local HTTP origin. It creates an unstarted binary
POST, restarts the engine, starts and pauses after partial progress, restarts
again, verifies resume makes no network request and leaves the partial hash
unchanged, then explicitly restarts and checks the complete 8 MiB output. Exactly
two origin requests are permitted: original submission and explicit restart;
both must preserve POST, binary body, content type and absence of Range.

Unit coverage additionally checks request/body binding in creation receipts,
no public body disclosure, invalid request rejection, durable dispatch ordering,
failed disk write, and missing authorization after reload. Existing GET and
response-identity regression tests remain in the full suite.

No installed app or existing downloads were modified. Local runtime evidence
uses macOS aria2 and is not native Windows acceptance.

Final local validation: `npm test` passed 773 cases with eight skipped and zero
failures; `npm run typecheck`, `npm run build` and `git diff --check` passed.
`windows-post-task.json` records the lifecycle run: 1,507,328 bytes paused, no
implicit second request, and final SHA-256
`43dd1899f8637d264e067f5cef676862aee24e8de2e549575d5722cc3769d4c5`.
The original `--post-only` reproduction now accepts the task, completes with
exact output and records only POST (`windows-post-original-repro-fixed.json`).
The old `--expect-post-rejected` switch now explicitly omits the required
transport callback to exercise unsupported-host rejection, rather than claiming
the fully configured product rejects all POST downloads.

GET identity regression also passed with the actual aria2 orchestration:
unchanged content resumed to the correct file; same-size changed content and
content changed after the probe were stopped. See
`windows-post-get-identity-regression.json`.

## Follow-up: validate restart prerequisites before deleting prior bytes

A new regression reproduced an ordering bug in the initial integration: after
relaunch removed transient Authorization headers, explicit restart deleted the
old payload and aria2 sidecar before rejecting missing authentication. The
pre-fix test failed with ENOENT reading the previously saved fixture.

POST restart now checks transport availability and refreshable/required headers
before stopping the old task, removing artifacts or resetting its attempted
marker. Startup shares the same validation. This is a local preflight, not a
claim that remote authentication or later network success can be predicted.

The added test preserves both files, the exact persisted ledger and attempted
marker on rejection. Full tests passed: 774 passed, eight skipped, zero failures.
Typecheck, build and diff checks passed. The expanded real aria2 harness also
passed: a separate authorization-bearing POST was paused, the process restarted,
and the rejected restart left payload and sidecar SHA-256 unchanged, made no
new request and left the ledger unchanged. The previous explicit-restart success
case still completed with exact bytes. Evidence:
`core-audit-2026-10-04/windows-post-restart-preflight.json`.

This continues to be Windows task code executed with macOS aria2, not a native
Windows or installed-product verification.
