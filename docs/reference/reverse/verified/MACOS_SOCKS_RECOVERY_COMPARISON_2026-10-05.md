# Original/current SOCKS recovery comparison

The installed 2026100503 Swift Host matches original macOS Neat 1.3 on exact-file
correctness for controlled HTTP-over-SOCKS interruption and pause/resume cases.
All 18 outputs match their run's random 16 MiB payload. This adds original-engine
comparison to the earlier current-only packaged recovery QA.

## Reproduction

```
python3 scripts/reverse/reuse/run.py --headless --compare-host /Applications/NDM.app/Contents/Resources/bin/NDMHost --compare-size-mib 16 --compare-socks --compare-disconnect
python3 scripts/reverse/reuse/run.py --headless --compare-host /Applications/NDM.app/Contents/Resources/bin/NDMHost --compare-size-mib 16 --compare-socks --compare-pause
```

Both engines use one loopback SOCKS5 fixture, the same synthetic server and four
requested connections. Trials alternate engine order. The server writes 64 KiB
every 8 ms per connection. The delayed scenario adds 150 ms before headers.
The original executable's text and source hashes are verified unchanged; its
isolated copy is instrumented, re-signed and removed to Trash after the run.
Original and current owned processes stopped. Real profiles/downloads are not
used. The installed Host hash matches the 2026100503 deployment receipt.

## Interrupted established connection

One nonzero range is disconnected after 256 KiB has been sent. Three trials per
engine all complete with exact hashes, continue healthy workers after the fault,
and reuse a nonzero prefix of the interrupted range.

| Median measurement | Original | Current installed Host |
| --- | --- | --- |
| Submission to observed completion | 1089.63 ms | 1090.40 ms |
| Submission to first useful server body | 22.11 ms | 8.56 ms |
| Disconnect to resumed-prefix server body | 636.42 ms | 619.70 ms |

46 SOCKS5 routes carried bytes in both directions; none was rejected. These
results show comparable completion in this fixture, not public-network parity.
Original snapshots refresh every 200 ms; current RPC is polled every 25 ms.
Completion/progress timings therefore include unequal observation delays.
Server body timestamps share one monotonic clock, but are not UI paint times.

## Pause/resume

Three trials per engine in normal and delayed scenarios produce 12 exact files.
All paused segment/storage files remain unchanged for one second after pause
settles. Current storage receipts and payload ownership are checked by the
harness. Every case produces a useful resumed response.

| Median measurement | Original normal | Current normal | Original delayed | Current delayed |
| --- | --- | --- | --- | --- |
| Resume to first useful server body | 150.58 ms | 5.19 ms | 305.93 ms | 162.08 ms |
| Resume to completion | 555.17 ms | 528.30 ms | 767.51 ms | 861.40 ms |
| Server writes beyond durable remainder | 311296 bytes | 0 bytes | 532480 bytes | 98304 bytes |

These are observations, not equivalent-remaining-work speed benchmarks. Pause is
requested after observed 25% progress, but observation/control delays differ:
original pause acknowledgements took roughly 395–456 ms through the injected
controller, versus current RPC's 3–7 ms. Original files consequently had far more
durable bytes by the time they stopped. Original pause/resume control timings
must not be attributed entirely to the original download engine.

The extra-write metric counts server writes on requests begun after resume minus
the measured durable remainder. It is not a packet-level or client-received
redundancy measurement. 111 SOCKS routes were accepted: 102 returned bytes and
nine had request bytes but no returned bytes. Pausing/cancelling in-flight work is
allowed; successful byte transfer on every opened connection is not a requirement.
No claim about the exact cause of each empty return is made without per-route
lifecycle timestamps.

## Evidence and open scope

Raw artifacts in `core-audit-2026-10-04/`:

- `macos-socks-disconnect-original-current.json`
- `macos-socks-pause-original-current.json`

The installed Host runs with a fresh profile outside the real application. This
is not Electron visual acceptance. Both scenarios use HTTP inside SOCKS, not
TLS; trusted large/ranged HTTPS recovery, HTTPS loopback routing and HLS remain
open. The public small-file HTTPS smoke is documented separately and does not
close those gaps. No production change was needed for these passing cases.
