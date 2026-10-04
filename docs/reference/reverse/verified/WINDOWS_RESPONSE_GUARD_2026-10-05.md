# Existing Windows engine: validate actual response identity

The existing aria2 backend now routes HTTP transfers with a persisted strong
identity through a fixed-destination loopback response guard. The original-engine
reuse experiment is not the production download path. The current macOS Swift
engine is unchanged by this fix.

Previously, the preflight could see version A, then an origin could ignore
If-Match/If-Range and return same-size version B to the resumed transfer. Request
conditions alone did not prevent a mixed file. Original-engine evidence also
shows this weakness (`windows-original-identity-mixed.json` and the corresponding
Mac original report); copying the original behavior would preserve the defect.

The guard validates each successful response's effective URL hash, strong ETag,
size/range and content encoding before forwarding body bytes. Identity failures
latch the task route and abort its other upstream responses. Already-saved bytes
are preserved, and the UI transitions to error only after aria2 reports a stopped
state. Normal network/HTTP failures remain transport failures; they are not
silently interpreted as resource replacement. Weak/missing validators retain the
existing clean single-stream/no-append policy.

The relay has an unguessable route for one fixed origin request. It does not
accept arbitrary destinations or forward credentials from loopback callers.
Task headers and selected proxy belong to the upstream Chromium transport;
aria2 bypasses proxies for the local route. Cross-origin redirects strip custom
credentials. Response bodies stream with backpressure, not whole-file buffering.
TLS certificate validation remains Chromium's default; no bypass was introduced.

Real Electron testing found that net.fetch leaves Response.url empty. With
manual redirects and no redirected response, the explicit current request URL
is used; unexpected automatic redirects are rejected. Both the failed discovery
and passing Chromium/proxy result are retained.

Evidence under `core-audit-2026-10-04/`:

- `windows-response-guard-noncompliant.json`: same-size replacement after the
  preflight, ignoring conditions, is rejected; persisted file SHA unchanged;
  aria2 writer status is error before UI failure is accepted.
- `windows-response-guard-controls.json`: unchanged 8 MiB resumes correctly;
  changes before the probe and between probe/transfer are rejected and saved
  bytes remain unchanged. This control run precedes the final explicit loopback
  proxy-bypass option; the noncompliant run includes that option.
- `windows-response-guard-electron-proxy.json`: actual Electron/Chromium uses
  the configured synthetic HTTP proxy, preserves synthetic credentials to the
  intended origin, transfers the unchanged response, and exposes zero body bytes
  from the changed response.
- `windows-response-guard-electron-empty-url.json`: retained failed integration
  discovery, not counted as a passing test.

Reproduce with `node scripts/qa-windows-resume-identity-audit.mjs --noncompliant
--expect-identity`, the same script with only `--expect-identity`, and
`node scripts/qa-http-response-guard.mjs`.

The aria2 orchestration runs used macOS aria2 and isolated synthetic endpoints.
They do not replace native Windows acceptance or real-site throughput testing.
The local relay adds a transport hop; its performance cost and concurrency under
large workloads still need measurements. A server that lies about its strong
ETag without changing any validated metadata cannot be detected from headers.

A pinned transfer cannot fall back to an unguarded mirror: such a combination
is rejected with an explicit message. Cross-URL identity proof for mirror sets
is not established by matching ETag strings; unpinned multi-mirror behavior
remains a separate audit item.

Final repository checks: typecheck and build passed; 768 tests discovered,
760 passed and 8 skipped. No installed application was replaced during this work.
