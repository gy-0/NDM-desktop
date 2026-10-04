# Proxy connection failure diagnostic

The public HTTPS smoke reproduced a correct transport refusal with an unhelpful
`#diag:generic|...CFNetwork error 310` result. The original's SOCKS refusal is
already recorded in `MACOS_ORIGINAL_SOCKS_2026-10-05.md`; this change improves the
current product's explanation without changing routing, retry policy or TLS.

The macOS SDK's `CFNetworkErrors.h` identifies 306 as HTTP proxy connection
failure, 310 as HTTPS proxy connection failure and 311 as an unexpected CONNECT
response. `DiagnosticClassifier` now recognizes only those codes in the
CFNetwork domain. It persists `#diag:proxyConnectionFailed`, which renders a
localized proxy-specific title, guidance to check reachability/settings and a
retry action. The host already sends this presentation to Electron.

Origin 502, HTTP 407, certificate rejection, unrelated domains using the same
numbers and unrelated CFNetwork codes retain their own meanings. No diagnosis
is inferred from the fact that a task happened to have a proxy configured.
HTTP adapter-generated 502 remains outside this narrow mapping; distinguishing
it from an actual origin 502 requires response-correlated transport evidence.

The classifier tests cover domain/code boundaries. Core tests cover persistence
round trips and English/Chinese presentation. The public smoke's new
`--expect-proxy-diagnostic` option requires the stored diagnostic, renderer-bound
title and retry action in addition to exact direct/proxied downloads and refusal
without a final file. Production installation still requires a later package;
this source change does not alter the currently installed 2026100503 binary.

## Validation results

- `npm run test:native`: 741 engine tests (28 skipped), 563 core tests,
  32 bridge tests and 11 layout tests; zero failures. Log:
  `/tmp/ndm-proxy-diagnostic-full.log`.
- `npm run build:native`: passed; log
  `/tmp/ndm-proxy-diagnostic-build.log`.
- `python3 scripts/reverse/reuse/check_public_tls.py --expect-proxy-diagnostic`:
  passed. Direct and proxied public downloads still match the curl SHA-256.
  Refused SOCKS reports zero completed bytes, no final output,
  `#diag:proxyConnectionFailed`, Chinese proxy-specific title/message/summary,
  and `primaryAction: retry`. The owned Host stopped.
- Raw after evidence:
  `core-audit-2026-10-04/macos-proxy-diagnostic-live.json`.
  Before evidence: `macos-public-trusted-tls-release.json` in the same directory.
- Python syntax and `git diff --check` passed.

No new Electron package or installed-window acceptance is claimed in this change.
