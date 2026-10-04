# First-response handoff transport

The original/current comparison demonstrated an extra response wait in the
current Swift startup path. Removing that wait requires retaining the first
response while the engine learns its metadata and establishes byte ownership.
Changing the Range header alone would leave a full-response writer competing
with segment workers.

`RangeStreamDownloader` now has an optional asynchronous `prepareRangeBody`
handoff for successful, validated 206 responses. It holds URLSession's response
disposition while the caller reserves a destination and prepares the existing
lease and offset storage. It holds neither the delegate thread nor the lease
lock while awaiting the caller. No body writer is opened before preparation
completes; metadata, identity and response-range validation remain ahead of this
handoff.

The caller retains the original lease object and sets its fresh owned range
under that lease's lock. Preparation cannot substitute a different ownership
lock or append arbitrary old bytes. The prepared range must start at the
requested byte and fit inside the response. The same network response then
writes directly through the existing offset storage or segment file writer.

An open-ended request now stops successfully when it satisfies a shorter owned
range. Previously, that stop condition required a numeric request end and could
not clip `bytes=0-`. Truncation uses the validated response byte count, so bounded
requests and resumed suffixes retain the equivalent condition.

Cancellation while response preparation is suspended cancels the held response,
completes the transfer without waiting for the planner, and rejects late planner
completion before opening a writer. A failed transport also cancels the pending
preparation task. The caller must still own and clean up any resources it creates
inside its asynchronous preparation callback.

Real loopback HTTP tests cover:

- Holding response headers until range ownership is ready, then writing exactly
  a 96 KiB prefix from a 512 KiB open-ended response with one request.
- Cancelling while the planner deliberately ignores task cancellation; the
  transfer returns promptly and a late planner return cannot create a file.
- Returning from Swift task cancellation while another thread owns the lease
  lock; the cancellation hook cannot synchronously wait for the writer.
- Rejecting a mismatched ETag before invoking the planner or touching an existing
  destination.
- Creating offset storage from first-response metadata, adopting its first
  64 KiB, fetching only the remaining range, and publishing the exact complete
  128 KiB payload through existing storage publication.

The first full regression run exposed a cancellation lock inversion in the new
hook during `TailResume416InvestigationTests`. A thread sample showed Swift task
cancellation holding its task-status lock while waiting for the lease lock, and
the delegate holding that lease lock while resuming the Swift continuation.
The hook now immediately cancels URLSession and dispatches pending-preparation
cleanup off the cancellation stack. Ordinary workers keep their previous
nonblocking cancellation path. The new deterministic lock test plus all five
tail-resume/rollback tests passed after the correction (10 selected tests total).
The stalled owned test process was terminated; no product download was stopped.

This commit is transport groundwork, not the completed startup optimization.
`DownloadEngine` still uses its existing one-byte probe. Next integrate this
handoff with fresh-GET metadata delivery, first-worker admission and task lifetime;
retain the established resume, unvalidated-response fallback, 200/416 handling,
authentication, cancellation, and POST replay policies. Then rerun the original
comparison and verify packaged runtime behavior before claiming an experience
improvement. No installed application is changed by this work.

Final validation: `npm run test:native` passed (722 engine XCTest cases, including
28 skipped; 561 core and 32 bridge cases; 11 additional Swift Testing cases).
`npm run build:native` and `git diff --check` passed. Test/source/binary evidence
is recorded in `core-audit-2026-10-04/macos-first-response-handoff.json`.

Follow-up implementation and measurements: [First-response startup](MACOS_FIRST_RESPONSE_STARTUP_2026-10-05.md). The limitations above describe this earlier baseline/transport milestone.
