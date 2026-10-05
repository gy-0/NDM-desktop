# Restore bounded service retries to the first download request

## Reproduction and cause

CI run 37244616566 and the local release Host both failed the existing real-HTTP
network recovery check: `/refused.bin` returns 503 with `Retry-After: 0`, but only
one request was observed instead of the expected initial attempt plus three
retries. The interrupted-body half still recovered four drops and verified the
exact file. See `core-audit-2026-10-04/macos-startup-service-before.json`.

The first GET now supplies metadata as well as the body, avoiding a preceding
HEAD. Its bootstrap returns unsuccessful HTTP responses for caller inspection;
the caller turned 503 into an immediate terminal error. Consequently the worker's
existing bounded 429/503 retry policy was never reached. This is a regression in
our startup path, not evidence of original Neat's precise HTTP retry policy.

## Correction

Bootstrap classifies 429 and 503 with the existing Retry-After parser. Safe,
bodyless GET/HEAD startup permits three service retries, honors Retry-After, uses
exponential fallback when absent, and imposes a 100 ms minimum to prevent a zero
delay request storm. Waiting checks pause/cancellation every 100 ms. Authentication
signatures are rebuilt with each attempt. POST/body requests remain single-shot;
other HTTP failures and transport retry policy remain separate. No HEAD preflight
is restored, and no failed response is published as a file.

## Validation

- StartupNetworkRecoveryTests: 11 passed, including transient/persistent 429 and
  503, exact recovered bytes, bounded request count, POST non-replay, and pause
  during a 30-second Retry-After.
- `npm run build:native`: passed.
- Release Host real-HTTP QA: passed; four interrupted transfers resumed at
  65536-byte advancing offsets, exact 2 MiB output, four startup refusals followed
  by a retryable error, and owned Host cleanup. Raw result:
  `core-audit-2026-10-04/macos-startup-service-after.json`.
- Full `npm run test:native`: passed with zero failures; Engine 744 (28 skipped),
  Core 563, Bridge 32, plus 11 Swift Testing layout checks. See
  `core-audit-2026-10-04/macos-startup-service-validation.json`.
- Legacy progress release-Host QA also passed: the same task restored 327,680
  durable bytes, resumed, and produced the exact 8 MiB file.
- Remote run [37245889005](https://github.com/gy-0/NDM-desktop/actions/runs/37245889005)
  passed all four jobs on `2c5d185106c3ff4f15fd10c8e3ab4ef0d46a5955`.
  Native macOS reported 1,339 tests (46 skipped), zero failures, release build
  success, and every Host integration step passed. The previously failing real
  HTTP check now observed four startup refusals and a retryable terminal error;
  four interrupted transfers recovered with exact bytes. See
  `core-audit-2026-10-04/startup-service-ci-final.json`.
- Installed application has not changed.
