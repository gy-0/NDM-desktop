# Real-download completion frame audit, 2026-10-05

The existing worker warmup fix is commit `3adf4c2`. This audit adds evidence,
not another product implementation change. Fireworks remain enabled.

## Method

Run `NDM_COMPLETION_FRAMES=1 node scripts/qa-electron-native-startup.mjs`.
The existing harness creates an isolated release Swift Host and Electron profile,
submits a real 16 MiB file through the composer, verifies every output byte,
and checks a subsequent HTTP 403 failure. Installed apps/profiles are untouched.
The additional optional observer records renderer snapshot arrival, the fireworks
invocation attribute, requestAnimationFrame intervals, long tasks, and worker presence.
It measures from 100 ms before completion through 2500 ms after completion.
Screenshots are excluded from this interval; capture overhead must not be confused
with a product stall. Observers are disconnected after measurement.

## Observations

| Run | Event-to-fire ms | Maximum frame gap ms | Frames over 50 ms | Long tasks | Fires |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing development output | 14.5 | 10.4 | 0 | 0 | 1 |
| Fresh frontend build, first run | 13.2 | 10.3 | 0 | 0 | 1 |
| Fresh frontend build, second run | 13.3 | 10.3 | 0 | 0 | 1 |

All three observed 312 animation-frame samples, a blob worker, correct file
contents and no renderer errors. The release Host hash is recorded in each raw
report. A separate three-event synthetic check also had no long tasks or gaps
above 50 ms, with invocation delays 3.6–8 ms.

Raw evidence: `core-audit-2026-10-04/macos-real-completion-frames.json`.
Validation: `npm run build`, script syntax check, three actual-download runs,
and the existing synthetic completion frame audit passed.

## Boundaries and next acceptance

No hitch was reproduced in these isolated development runs. The counters prove
animation invocation; renderer rAF does not measure worker-rendered particle
presentation, GPU/compositor stalls, or the time the user first sees pixels.
The QA asserts useful samples, exactly one invocation, and worker presence;
performance values are observations, not a universal enforced latency budget.
Muted audio, one ordinary file, a small library and local HTTP do not cover an
installed build, installer completion, a busy library or simultaneous completions.
Packaged/installed visual acceptance remains open; do not infer it from this audit.
