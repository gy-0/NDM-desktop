# Browser POST replay during automatic handoff

Real Chromium with the existing Relay automatically handed a top-level form
attachment to NDM after the browser had already submitted it. The controlled
origin recorded two POSTs with identical `fixture=synthetic` bodies. One Chrome
download was created, interrupted and erased; one NDM task completed. Correct
output bytes therefore concealed a duplicate non-idempotent submission.
The iframe form already remained browser-owned and submitted only once.

The new fixture requires one origin submission, exact method/body and output
hash, not merely a completed file. It reproduces the old main-frame failure in
`relay-post-single-submission.json` alongside the corrected observations.

Relay 1.4.18 now leaves observed POST responses browser-owned. Request state
remembers that the browser submitted POST across the same request's redirects,
including POST -> 303 -> GET. It does not create a native handoff or cancel/erase
the browser item. State is released by the existing request-completion cleanup.
The guard also recognizes POST directly if prior request state is unavailable.
Explicit engine/API POST support is unchanged.

After validation used a temporary extension copy, ephemeral browser profile,
private Swift Host support directory and loopback ports. Main-frame POST, iframe
POST and main-frame POST -> 303 -> GET all passed: one exact submitted body, one
completed browser file with matching SHA-256, no browser interruption/erasure and
no NDM task. An ordinary GET iframe download still handed off to NDM and delivered
correct bytes. The extension's manifest, package and running-worker versions are
all 1.4.18. All 244 Relay tests passed, including the new POST/redirect regression.

The default Playwright browser version was absent; the initial launch-only
failures are not accepted runtime evidence. The actual runs explicitly used the
already-installed Chromium 147 testing binary at the `chromium-1217` cache path.
No browser installation, real profile, installed NDM or existing download changed.

This is a correctness fix for automatic capture after submission, not arbitrary
browser-form support inside NDM. Transferring a form before its first submission,
file uploads, raw/binary bodies, service-worker lifetime boundaries and other
browser versions need their own acceptance. Legacy body-serialization helpers
are not evidence for those capabilities. Keeping an already-started browser
response avoids a second submission and lets the user's original download finish.

Evidence: `core-audit-2026-10-04/relay-post-single-submission.json`. The records
include synthetic origin request hashes, Chrome events, bridge sends and final
ownership. Extension installation/reload in the user's browser remains separate.
