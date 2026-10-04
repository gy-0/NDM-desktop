# Original/current two-hop redirect comparison

The isolated original-engine harness now accepts `--compare-redirects` with
`--compare-host`. It serves two relative same-origin 302 hops followed by a
128 MiB file, waiting 150 ms before each response. Payload writes remain 64 KiB
per 8 ms per connection. Three trials alternate original/current order. The
optional `--compare-pause` uses the existing stable-partial checks at 25 percent.

```
python3 scripts/reverse/reuse/run.py --headless --compare-host native/.build/release/NDMHost --compare-redirects --compare-size-mib 128
python3 scripts/reverse/reuse/run.py --headless --compare-host native/.build/release/NDMHost --compare-redirects --compare-pause --compare-size-mib 128
```

Both commands passed, with all 12 output hashes correct. The original binary was
unchanged; owned processes exited and temporary application copies were removed.
Evidence: `core-audit-2026-10-04/macos-redirect-comparison.json`.

| Observation | Original | Current |
| --- | ---: | ---: |
| Fresh completion median, ms | 7056.97 | 6489.22 |
| Fresh first useful server body median, ms | 501.71 | 493.62 |
| Fresh total requests by trial | 9 / 12 / 10 | 12 / 12 / 12 |
| Pause/resume whole run median, ms, including intentional pause | 8637.77 | 8641.03 |
| Resume to useful server body median, ms | 275.50 | 481.28 |
| Requests after resume by trial | 7 / 9 / 8 | 15 / 15 / 15 |

The concrete topology difference is reproducible: original follows two redirects
once and starts later ranges directly on `/compare/object-*`. Current starts each
range at `/compare/redirect-*`, repeating both hops. Four fresh data requests thus
produce twelve HTTP requests. Original has variable tail requests; its total
request count is not equivalent to four fixed workers. Current fresh completion
is still faster in this fixture, so this is not evidence of a universal slowdown.
Original polling is 200 ms versus current 25 ms; server body timestamps share a
clock, whereas observed completion and progress retain sampling asymmetry.

Source correspondence: `DownloadEngine.swift` assigns `resolvedResourceURL` from
the first response and uses it for per-response identity checks, but subsequent
range construction still initializes `URLRequest(url: cleanURL)`. Avoidable
redirect work therefore exists even after the earlier first-response adoption.
No engine behavior was changed by this measurement.

Next implementation must preserve the effective request context, not just replace
the URL: an origin -> foreign origin -> origin chain intentionally drops captured
credentials permanently for that chain. Rebuilding the request from original
headers at the final same-origin URL could revive them. Authentication challenges,
proxy authentication, method/body restrictions, actual-response identity checks
and cancellation remain requirements. Revalidating the entry URL at a new resume
may intentionally retain one redirect chain to detect changed destinations; the
original's quicker resume is not by itself proof that bypassing that check is safe.

Scope is synthetic same-origin HTTP redirects. This is neither public CDN/TLS
acceptance nor cross-origin credential acceptance. Python syntax compilation,
missing-host CLI rejection, actual fresh/resume comparisons and diff checks passed.

## Reuse the validated route within an active transfer

The range transport now captures the effective URLRequest, original origin and
whether any hop crossed origins, after response range/identity checks and before
body handoff. The engine reuses this in-memory request for subsequent GET ranges,
replaces Range/If-Range, and regenerates authentication for the actual target.
It does not reapply captured caller headers over the resolved request. A chain
that crossed origins retains that state even when its destination is back on the
original origin; private headers and credential retries are not revived.
Further redirects and authentication challenges keep the initial origin boundary.

A new probe resets the context. Checkpoints still bind the user's original
request and resolved resource identity, and a new resume still follows the entry
URL to detect a changed target. No route URL or credential copy is added to disk.
POST/clean-stream behavior is unchanged. Actual response validator, total length,
range and final-URL checks still precede writes.

Targeted redirect and first-response tests passed (19 tests), including a new
origin -> foreign origin -> origin test with both captured private headers and
explicit user credentials. Existing tests now assert one discovery chain and
direct final-address ranges while retaining byte hashes and header checks.

Fresh and pause/resume release-host comparisons both passed: 12 exact outputs,
paused partial/receipt stability, original integrity and owned-process cleanup.
Raw evidence: `core-audit-2026-10-04/macos-resolved-route-after.json`.

| Current engine measurement | Before | After |
| --- | ---: | ---: |
| Fresh requests in each trial | 12 | 6 |
| Fresh completion median ms | 6489.22 | 6190.19 |
| Requests after resume in each trial | 15 | 6 |
| Resume to useful server body median ms | 481.28 | 476.72 |
| Whole pause/resume run median ms | 8641.03 | 7862.93 |

The new original-engine medians were 6665.95 ms fresh and 8188.03 ms with pause;
its resume-to-body median was 282.65 ms. Timing differences across runs are not
precise universal speed claims. The deterministic gain is removing redundant
redirect requests; initial resume still pays for the entry-chain identity check.

One attempted resume comparison failed before submission because the disk was
full. It is excluded from the results. Eighteen completed synthetic `.bin` files
from three explicitly identified earlier QA roots were hash-checked against their
reports and deleted, releasing 2,415,919,104 bytes. Logs and reports remain; the
cleanup manifest is archived with the evidence. The failed run's owned temporary
app copy was moved to Trash after space recovery. Installed apps and real download
profiles were not modified.

Final validation: `npm run build:native` passed; `npm run test:native` passed
729 engine tests (28 skipped), 563 Core tests, 32 Bridge tests and 11 Swift
Testing layout tests, all with zero failures. Full log:
`/tmp/ndm-redirect-route-full-native.log`. Diff checks passed. The release Host
was exercised directly; the installed Electron bundle has not been updated.


## Signed Electron package acceptance

`npm run package` passed, including the in-repository release Host build, renderer
build and stable Apple signature verification. No installed app was replaced.
The package's asar SHA-256 is
`6da973c13229a773fcdc148b9495ce76592bec0d733311174c2699e583762241`; embedded Host
SHA-256 is `8df12ce8b04b205a9894dac0b4555c05cc5d085ed68f0385eb61272fd7515c6c`.

`NDM_QA_REDIRECTS=1` extends the actual composer harness with two delayed 302 hops.
It asserts that each discovery visits the entry and intermediate URL exactly once,
that later ranges go directly to the final URL, and that no HEAD/one-byte probe
is reintroduced. With `NDM_QA_PAUSE_RESUME=1`, it expects one fresh discovery and
one resumed discovery. Request-to-first-body measurements follow all three paths.

Fresh and UI pause/resume runs both passed exact 16 MiB outputs, visible progress
and speed, HTTP 403 UI and HTML-file rejection. Fresh used six requests total;
the pause/resume run used six before and six after pause. Its paused counter was
stable for 500 ms and first resumed request carried the saved If-Range and a
nonzero suffix. Resume to first server body was 490 ms, including three deliberate
150 ms header delays and UI/control overhead. Each run fired confetti once; max
rAF gaps were 10.3 and 10.4 ms, with no measured >50 ms frame or long task.

The completed screenshot was inspected: task, library and inspector rendered.
This does not establish transient startup black-frame absence or resolve every
intermittent completion hitch. Evidence:
`core-audit-2026-10-04/macos-packaged-resolved-route.json`. The fixture reports
contain the exact bundle hashes, request traces and timings.

Before packaging, six hash-verified synthetic outputs from the completed
`ndm-original-reuse-sctm0o6w` comparison were deleted to release 805,306,368 bytes;
its reports/logs remain and the cleanup manifest is included in the new evidence.
The media-tool check passed without fetching; QA script syntax and diff checks
passed. Product source was unchanged in this acceptance step.
