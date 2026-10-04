# Windows POST: single-submission transport foundation

The current Windows task API still rejects non-GET/body-bearing requests before
creating tasks or receipts. This commit does not enable POST downloads in that
API. It supplies the separately tested streaming transport needed for integration;
task persistence, explicit restart behavior, cleanup and real aria2 orchestration
remain to be implemented and verified.

Original reference: `WINDOWS_ORIGINAL_2026-10-04.md`, section “Windows POST 方法、
正文与类型的动态验证”, and `core-audit-2026-10-04/windows-original-post-resume.json`.
The original Windows executable, exercised under CrossOver, preserved POST/body
but sent eight POST requests initially and eight after resume. This establishes
its functionality and repeated-submission behavior, not safety for arbitrary
stateful export endpoints. The current implementation must preserve method/body
without silently reproducing those submissions for each segment or retry.

`SingleSubmissionHTTPRelay` creates a random fixed-destination loopback route.
A route atomically claims its first GET and makes one initial upstream POST with
a copied binary body. An initial downstream `bytes=0-` is accepted but never
forwarded; suffix requests are rejected. Later/concurrent attempts receive 410
without contacting the origin, including after transport failures. The response
is streamed with backpressure and abort propagation, advertises no range support,
and validates status, identity encoding and declared length. Error bodies and
partial responses are not forwarded as successful files.

301/302/303 transition to GET and remove content headers. Cross-origin redirects
strip credentials and custom headers; HTTPS downgrade and URL credentials are
rejected. A 307/308 that would resend POST is explicitly rejected, pending an
explicit resubmission contract. This limitation is exposed as an error rather
than silently issuing GET or repeating a potentially stateful operation.

The existing Electron transport accepts an optional POST/body parameter. Its
GET callers remain unchanged. It continues using the configured isolated proxy
context and Chromium TLS verification, with manual redirects and no ambient
session cookies.

Validation:

- `npm test`: 769 passed, eight skipped, zero failures. New cases cover binary
  body copying, explicit headers/proxy, concurrent requests, initial/suffix
  ranges, redirect conversion, credential removal, failure/truncation, and abort.
- `npm run typecheck` and `npm run build`: passed.
- Extended `qa-http-response-guard-electron.mjs`: real Electron network stack
  through an isolated local HTTP proxy. The proxy received exactly one POST with
  bytes `00 ff 3d 26` and the synthetic cookie; a second downstream request was
  rejected. Existing GET response-identity checks passed in the same run.
- Report: `core-audit-2026-10-04/windows-post-electron-transport.json`.

The runtime ran on macOS Electron. It is neither native Windows acceptance nor
end-to-end Windows task support. Before enabling task admission, connect this
route to durable method/body intent, one-connection/no-retry aria2 options,
partial-file ownership, pause/restart policy, receipts and task lifecycle tests.
No installed app, user profile or existing download was modified.

Follow-up: [Windows POST task integration](WINDOWS_POST_TASK_2026-10-05.md) now connects this transport to task admission and durable non-replay behavior. The rejection described above is the historical state of the transport-only commit.
