# Disconnected-range handoff

## Verified difference

`TRANSPORT_RECOVERY.md` describes original ARM64 cleanup at `0x100054554` and
`0x100064214`: disconnect cleanup releases the socket's segment ownership while
preserving its completed prefix. The failed socket's 4,500 ms cooldown does not
prevent another available socket from claiming unfinished work.

The maintained Swift engine preserved the prefix and healthy workers, but kept
the failed range lease inside its sleeping retry task. Healthy workers could
split part of that lease's unwritten tail; the remaining parent still waited for
the failed worker's cooldown. Applying the original socket delay to an exclusive
retained lease produced a different user-visible result.

## Before: actual original/current comparison

The isolated original process and current release Host downloaded the same
16 MiB synthetic payload, requesting four connections. A localhost server closed
exactly one nonzero ranged response after writing 256 KiB, short of its advertised
length. Other responses continued at 64 KiB per 8 ms. Engine order alternated
over three trials. All six final file hashes matched.

| Engine | Median observed completion | Failed-prefix continuation first body after disconnect |
| --- | ---: | --- |
| Original macOS 1.3 | 1151.20 ms | 634.41 / 635.87 / 650.12 ms |
| Current, before | 4916.93 ms | 4777.28 / 4762.82 / 4714.30 ms |

Current's first *child* repair response already arrived in 551–595 ms, so measuring
only the first recovery request would hide the delayed parent. Both engines
retained a nonzero failed prefix; this was latency, not observed corruption.
Original snapshot sampling is 200 ms versus 25 ms current polling, as recorded
in the comparison report. Those completion times are not exact last-byte times.

Evidence: `core-audit-2026-10-04/macos-disconnect-before.json`. Original binary
integrity and owned-process shutdown were verified; the user's installed apps
and profiles were not used by this comparison. The original universal hash was
`08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`.

## Current implementation

A successfully completed healthy range supplies one recovery opportunity when
queued work has been assigned and capacity is idle. Transport retry waits can
consume that opportunity before their 4.5-second cooldown expires. Already
waiting transport recovery takes precedence over splitting a live tail. An
opportunity is retained if the disconnect callback arrives just after the
healthy completion; each opportunity is consumed only once and belongs to one
download round.

This adapts the original scheduling behavior without transferring a live writer:
the existing lease resumes through `performRangeAttempt`, which still enforces
connection/admission limits and reconstructs the remaining range from storage.
`RangeStreamDownloader.finish` closes its handle and invalidates the old session
before resuming its continuation. No second writer, persisted-plan mutation, or
file deletion is introduced by the handoff.

HTTP admission/Retry-After waits do not receive recovery opportunities. With no
healthy completion, ordinary transport failures retain their existing delay.
Cancellation and replan checks run before an opportunity is consumed. Timeout,
startup first-body budgets, validator checks and terminal failures retain their
existing paths.

Run the original/current comparison with:

```sh
python3 scripts/reverse/reuse/run.py --headless \
  --compare-host native/.build/release/NDMHost --compare-size-mib 16 \
  --compare-disconnect
```

This fixture concerns established ranged-response interruption. It does not
establish public-network throughput, TLS/proxy behavior, installed-app behavior,
or native Windows acceptance.

## After and validation

Repeating the same alternating three-trial comparison with the rebuilt release
Host produced a **1087.11 ms** current median versus **1142.42 ms** original.
Current failed-prefix continuation first-body delays were **645.91, 628.09 and
636.21 ms**, versus the before-run 4.7-second waits. All six after-run outputs
matched their shared payload hash; all six reused a nonzero prefix and observed
healthy response writes after the injected disconnect. Both owned processes
stopped and the original source executable remained unchanged.

These engines choose different initial range geometry (recorded in each report),
and the payload is freshly generated for each comparison run. The conclusion is
that the fixed cooldown no longer strands this fixture's failed parent range,
not that a roughly 55 ms median lead proves general superiority over the original.

`npm run test:native` passed: 732 engine tests with 28 existing skips, 563 core,
32 bridge and 11 Swift layout tests, zero failures. The new integration test covers
both offset storage and legacy segments, verifies exact SHA and continuation of
the written prefix, and requires completion before the 4.5-second cooldown.
The single-worker repeated-disconnect test also requires at least eight seconds
before the third truncated response, guarding against loss of backoff when no
healthy worker completes. Unit tests verify one opportunity per completion and
callback-order handling. Pause, 32-worker recovery, identity, admission and tail
regressions passed in the full suite. `npm run build:native` passed.

After evidence: `core-audit-2026-10-04/macos-disconnect-after.json`. Full native
log: `/tmp/ndm-recovery-handoff-full.log`; release build log:
`/tmp/ndm-recovery-handoff-release.log`. The installed 2026100501 bundle remains
unchanged during this experiment; deploying this subsequent fix is separate.
