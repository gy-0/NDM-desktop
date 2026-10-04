# Original/current 128 MiB sustained comparison, 2026-10-05

The comparison harness now accepts `--compare-size-mib` (1–256, default 32,
comparison mode only) and records observed 10/25/50/75/90/100 percent milestones,
central-half throughput and overall throughput. The unchanged release Host and
an isolated signed copy of original macOS Neat 1.3 download identical payloads.

```
python3 scripts/reverse/reuse/run.py --headless \
  --compare-host native/.build/release/NDMHost --compare-size-mib 128
```

An exploratory run overlapped native tests and is excluded from the table.
The accepted run began after those tests exited, with no concurrent QA workload
launched by this task. It alternates engine order over three trials per scenario,
requests four connections, and uses 64 KiB server writes every 8 ms per connection.
The latency scenario adds 150 ms before each response header.

| Scenario | Engine | Completion median ms | First useful server body median ms | Central-half MiB/s median | Requests median |
| --- | --- | ---: | ---: | ---: | ---: |
| Normal | Original | 5655.71 | 14.32 | 22.78 | 6 |
| Normal | Current | 5597.02 | 9.80 | 23.56 | 4 |
| Header delay | Original | 6261.54 | 177.17 | 22.77 | 8 |
| Header delay | Current | 5885.68 | 164.46 | 23.87 | 5 |

All 12 output hashes match. Original source integrity, owned original-process
termination, temporary-copy cleanup and current Host termination are verified.
Raw reports: `core-audit-2026-10-04/macos-sustained-128mib.json`.

These results do not show a major steady-state throughput deficit in this
fixture. Normal completion differs by only about 59 ms, below the original's
200 ms snapshot cadence; do not call that a demonstrated speed win. Current RPC
polling is 25 ms, so observed progress/completion are asymmetric. First server
body uses the same server clock but is not UI feedback. Central-half rate uses
first observations at 25 and 75 percent, not packet-level measurement. Final
completion supplies the known payload byte count after file hash verification.

The fixture itself caps per-connection throughput. Neither peak link saturation,
TLS, public-site behavior, proxy overhead, nor long-duration stability is proven.
128 MiB here completes in roughly six seconds; it expands the earlier 32 MiB
comparison but is not an hours-long endurance test. No engine implementation was
changed by this measurement. Next comparisons should address latency/recovery
and proxy behavior rather than infer value from adding more connections alone.

Validation: Python syntax compilation and invalid-size/missing-comparison CLI
checks passed; the actual alternating comparison passed. The later full native
run found two failures documented in `MACOS_TAIL_PAYBACK_2026-10-05.md`; the fixture
correction passed its five-test suite, and full-suite revalidation is separate.
