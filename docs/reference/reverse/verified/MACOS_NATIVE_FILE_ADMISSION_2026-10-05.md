# Remove serial classification from protected native file admission

The signed-package audit reproduced a HEAD classification request before the
Swift engine's initial GET. `addFromUrl` unconditionally awaited classification,
even for ordinary file names already protected by native response validation.
Removing the engine probe alone had not removed this renderer entry-point wait.

The renderer now directly creates macOS GET tasks for a conservative subset of
ordinary archive/document/installer/binary extensions covered by native
`HTTPFileResponsePolicy`. The engine validates Content-Type on the actual
response and reports `unexpectedWebPage` instead of publishing an HTML login or
error page. Durable preparation still precedes creation; no duplicate task or
speculative parallel download is introduced.

Explicit browser selection, supplied headers, Relay sessions, proxy target
pointers, embedded filename hints, URL credentials, non-GET/body requests, media
sites, unknown extensions and other platforms retain classification. This is a
bounded fast path, not a claim that every address no longer needs identification.

Behavior change: an anonymous direct file returning HTML now creates an error
task with the existing open-source-page action. It no longer silently probes the
preferred browser's cookies before task creation. Explicit session requests retain
classification/cookie handling; institutional proxy pointers retain their path.
This avoids paying that identification round trip for public files, while retaining
the no-false-completion invariant. It does not implement automatic post-error
browser-session recovery.

## Signed-package results

`npm test`: 777 passed, eight skipped, zero failed. Typecheck passed after correcting
the helper's request-type annotation. Build and `npm run package` passed, including
stable signature verification. No native source changed; the immediately preceding
full native test run was green.

Two runs of `NDM_QA_APP_PATH=.../dist/mac-arm64/NDM.app/Contents/MacOS/NDM
NDM_COMPLETION_FRAMES=1 node scripts/qa-electron-native-startup.mjs` passed:

- First request GET `bytes=0-`; no HEAD or one-byte probe for the 16 MiB file.
- Exact output bytes/SHA-256, live UI progress/speed and HTTP 403 error UI.
- A `.bin` endpoint returning HTML produced `#diag:unexpectedWebPage`, no final
  `login.bin`, and a GET without HEAD. The request was not reported complete.
- First server request at 31/28 ms; first server body at 181/181 ms, versus
  335/338 ms in the earlier same-fixture package (150 ms response delay).
  Visible progress varied 459/309 ms, so do not equate network savings with
  a guaranteed UI timing improvement.
- Completion worker active, exactly one celebration, no long tasks or frame gaps
  above 50 ms in these two runs. The earlier intermittent 141.8 ms observation
  remains unresolved; two clean runs do not prove it eliminated.

Raw evidence: `core-audit-2026-10-04/macos-native-file-admission.json`.
Package app.asar SHA-256:
`aa5d064616d975d443bac3adf1779f6c8c65d32a78230c4fe7a00f375bb4fc19`.
Installed `/Applications/NDM.app`, real profiles/downloads and original installer
were not replaced or modified. Public Internet and Windows acceptance are not
established by these local macOS runs.
