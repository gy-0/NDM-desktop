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
