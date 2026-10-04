# Resume metadata and payload from one validated response

The pause audit found a sequential one-byte metadata request before resumed
payload ranges. This costs another response round trip on delayed links.

For a bound v2 offset receipt, GET without a body, no legacy artifacts, and no
speculative tail origins requiring rollback, startup now recovers the owned
plan and selects the first unfinished segment. It sends that remaining bounded
range with the saved If-Range validator. Its response is held at the existing
header/body rendezvous while startup validates the exact range, total size,
validator, request identity and redirected target identity. Only the validated
plan then binds the existing offset-storage writer to the response. Restored
prefix bytes remain part of progress, without being counted as newly received.

Legacy, unbound/unsupported and pending-tail-rollback paths keep their prior
probe behavior. Ignored ranges, changed/missing validators, changed totals and
changed redirect identities cannot authorize appending. Pause cancels the
header/body rendezvous and leaves prior payload and receipts intact. Storage
capacity is checked for the resumed owned allocation, not as a second full body.

## Validation

Initial targeted existing suites passed. The first complete native run executed
728 engine tests (28 skipped), finding four assertions in three tests that encoded
the old probe ordering. The zero-body fixture had excluded request 2 as metadata;
with direct resume it therefore failed to inject its intended four interruptions.
That fixture now truncates four actual suffix requests, retains all final-byte
and durable-prefix assertions, and expects one fewer total request. Redirect and
ignored-range tests now assert the new request count/range while keeping identity,
private-header and no-mutation checks.

The corrected four affected suites passed all 25 tests. A new six-mode integration
case verifies exact resumed bytes, same-size changed validator, missing validator,
changed total, ignored Range and pause during headers. It checks a single bounded
GET with saved If-Range and unchanged payload/receipt on every rejected/paused
case. Release Host build passed. The final full native run passed: 728 engine
tests (28 skipped), 563 Core, 32 Bridge and 11 layout tests, with zero failures.
Log: `/tmp/ndm-resume-first-response-full-final.log`. The earlier failed run
remains diagnostic evidence. Other logs: `/tmp/ndm-resume-first-response-full.log`,
`/tmp/ndm-resume-first-response-affected.log`,
`/tmp/ndm-resume-first-response-release.log`.

## Actual release-host comparison

The original/current 128 MiB pause comparison passed all 12 exact output hashes,
one-second stable paused payload/receipt checks, original-source integrity and
owned-process cleanup. None of the six current-engine traces contained a
`bytes=0-0` probe. The prior and current runs use the same fixture protocol, but
are separate runs rather than a claim of identical machine timing.

| Scenario | Engine | Resume-to-useful-body median ms | Resume-to-complete median ms | Resume requests median |
| --- | --- | ---: | ---: | ---: |
| Normal | Original | 129.97 | 4162.00 | 6 |
| Normal | Current | 3.92 | 4113.16 | 4 |
| Header delay | Original | 294.07 | 4853.83 | 8 |
| Header delay | Current | 163.47 | 4393.39 | 5 |

Current delayed first-body median was 332.09 ms in the earlier baseline; the
removed sequential request accounts for the roughly 169 ms reduction here.
Request/control/snapshot asymmetry, different paused byte counts, server writes
versus consumed bytes and loopback-only limits remain as documented in
`MACOS_PAUSE_RESUME_2026-10-05.md`. No Internet, TLS/proxy, native Windows or
installed Electron performance claim follows from these measurements. The
existing installed and packaged apps were not replaced by this release-Host QA.

Raw evidence: `core-audit-2026-10-04/macos-resume-first-response.json`.


## Packaged Electron UI acceptance

Rebuilt and signed with `npm run package`, then ran:

```sh
NDM_QA_APP_PATH="$PWD/dist/mac-arm64/NDM.app/Contents/MacOS/NDM" NDM_COMPLETION_FRAMES=1 NDM_QA_PAUSE_RESUME=1 node scripts/qa-electron-native-startup.mjs
```

Passed using isolated support/download/profile directories and the Host embedded
in that package. The script clicks the actual pause and continue buttons. After
pausing at 524288 bytes, the reported counter stayed stable for 500 ms. The first
resumed request was `bytes=524288-4194303` with the saved strong If-Range. No HEAD
or one-byte probe occurred; final 16 MiB output matched every expected byte.
Resume-click to first server body was 189 ms with 150 ms fixture header delay.
Initial visible progress/speed appeared at 255/256 ms. HTTP 403 presentation,
HTML rejection without final output, and renderer-error checks also passed.

Completion produced one worker-backed celebration, event-to-fire 15.7 ms,
311 frame samples, maximum rAF gap 17.2 ms and no gap over 50 ms or long task.
This one run does not resolve the previously observed intermittent frame hitch.
Pause counter stability is UI evidence; the earlier comparison separately
validated paused payload and receipt hashes. The complete screenshot showed the
library and inspector rendered; it does not exclude a transient startup frame.

Raw report: `core-audit-2026-10-04/macos-packaged-resume.json`.
Runtime artifacts: `/tmp/ndm-electron-native-fF88KE`; build log:
`/tmp/ndm-resume-packaged-build.log`. The installed application and production
downloads were not modified. This package's app.asar is unchanged from the prior
UI build; its embedded Host hash in the report identifies the updated engine.
