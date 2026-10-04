# Original/current pause-resume comparison, 2026-10-05

Run the unchanged original macOS engine and current release Swift Host on the
same 128 MiB loopback payload, four requested connections, three alternating
trials in normal and 150 ms response-header-delay scenarios:

```
python3 scripts/reverse/reuse/run.py --headless \
  --compare-host native/.build/release/NDMHost --compare-size-mib 128 --compare-pause
```

Pause when observed progress reaches 25 percent. Verify partial payload hashes
and plan/identity receipts stay unchanged for one second, then resume and check
the entire final file hash. Original segment files live in its private support
directory. Current offset storage has a sparse payload in the private destination;
the harness resolves its owned receipt, validates that parent/name belong to the
fixture, and hashes that payload too. Checking support metadata alone would not
establish that payload writers stopped. Only this strengthened run is accepted.

All 12 final files matched. Both engines' paused payloads were stable. Original
source integrity, temporary-copy cleanup and both owned process exits passed.
The initial exploratory run is excluded because its current-engine paused check
covered receipts but not the destination payload.

| Scenario | Engine | Resume to useful server body, median ms | Resume requests, median | Server body writes beyond durable remainder, median bytes |
| --- | --- | ---: | ---: | ---: |
| Normal | Original | 111.44 | 5 | 147456 |
| Normal | Current | 19.67 | 5 | 1 |
| Header delay | Original | 264.74 | 9 | 458752 |
| Header delay | Current | 332.09 | 5 | 1 |

Raw evidence: `core-audit-2026-10-04/macos-pause-resume-comparison.json`.

The current engine resumes with a one-byte `bytes=0-0` resource probe, followed
by four bounded ranges carrying If-Range. The original resumes with open-ended
ranges and no If-Range/If-Match in these traces. The extra sequential verification
round trip explains an observed high-latency disadvantage, but must not simply
be removed: mutable-resource protection is a correctness requirement. A next
optimization should validate identity using the first unfinished range response
before admitting its bytes, and retain changed-resource rejection tests.

Durable remainder is derived from original segment file sizes or current receipt
range durablePrefix values, not lagging progress snapshots. The server counter
counts successful body write/flush calls, not client-consumed or wire-acknowledged
bytes. It can include read-ahead canceled after a segment boundary. Current had
one high-delay trial with 65537 extra server-written bytes; other current trials
had only the one-byte probe. Do not interpret this as a universal bandwidth bound.

Original control uses an injected command mailbox and periodic snapshots;
current control uses RPC. Their acknowledgment timings are not directly comparable
engine-only latencies. Resume-to-body includes those control differences, and
completion uses asymmetric polling. Paused bytes also differ between trials,
so absolute remaining completion time is not a like-for-like throughput ranking.
The harness suppresses throughput figures that cross the deliberate pause.

Validation: Python syntax compilation and the actual 12-case runtime passed.
No product engine code changed. This proves controlled pause/resume, not process
restart recovery, network failure recovery, TLS/proxy behavior, public websites,
or Windows acceptance. Real user profiles and downloads were untouched.
