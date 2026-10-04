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


## Installed artifact differs from the measured development build

Read-only inspection of `/Applications/NDM.app/Contents/Resources/app.asar`
on this audit date found version `2026.9.24`, build `2026092403`, SHA-256
`dbc6c10ccbf0c1e980b2b4af61d41c051fbb4f95c0f01f5330a17b431a55dcfb`.
Its renderer asset `/out/renderer/assets/index-BmE0jtCB.js` sets `useWorker: false`
in the component default, instance creation and the App's explicit globalOptions.
It creates the instance without the zero-particle warmup call. Current source
uses the prewarmed worker instead. This directly establishes that the installed
artifact does not contain the measured fix, without launching or replacing it.
It does not prove that this difference alone caused every observed hitch.
Packaged visual/frame acceptance and guarded deployment remain required.


## Signed package exposes remaining product gaps

`npm run package` exited 0, including release Host build, frontend build and
stable Apple signature verification. The QA harness now supports `NDM_QA_APP_PATH`
and runs that bundle's own Host in private support/output paths. It records
`app.isPackaged`, app.asar SHA-256 and Host SHA-256; it does not replace an installed app.
Tested package: `dist/mac-arm64/NDM.app`, app.asar SHA-256
`a46c3c2fcfd8061848252bcca6fc5e56e510175c446558665a355f4862c6eae0`.

Three real composer-download runs all failed the existing no-HEAD assertion:
HEAD preceded GET, despite the native engine's first-response reuse. Source
inspection confirms `store.ts:addFromUrl` awaits classifyURL for ordinary HTTP
URLs too. This is a remaining foreground classification round trip, distinct
from the engine probe that was removed. Earlier development no-HEAD observations
are insufficient to establish packaged composer behavior.

Two runs captured completion timing before asserting request topology. Both
verified the exact 16 MiB file, worker presence and exactly one fire, delayed
13.2/13.6 ms from the completion event. One observed a 141.8 ms rAF gap without
a long task; the next had maximum gap 10.4 ms. This is an unresolved intermittent
signal, not proof of an animation-worker bug or full smoothness. Screenshots
were outside the timing interval. The complete screenshot was inspected and
showed rendered task/library/inspector UI; it does not rule out transient startup
black frames. HTTP-error UI checks occur after the no-HEAD assertion and were
therefore not reached in these packaged runs.

Raw failed reports: `core-audit-2026-10-04/macos-packaged-startup-gap.json`.
The harness retains the strict failing assertion and now captures completion
observations before it, plus timestamps for future slow-frame diagnosis.
Next work: eliminate avoidable composer classification waiting while preserving
media/login/session behavior, then profile/reproduce the packaged frame gap.


## Chromium trace baseline for the intermittent hitch

`NDM_COMPLETION_TRACE=1` now enables frame observation and Chromium tracing in the
packaged startup QA. The trace records explicit user-timing markers for receipt of
the completed snapshot and the confetti fire mutation. Recording ends after the
measurement interval, before screenshots. `scripts/summarize-completion-trace.mjs`
reads a report and correlates renderer main-thread spans with those markers.
Raw traces remain outside Git in each isolated QA root.

Three actual packaged runs passed all existing startup/output/error checks.
Maximum measured frame gaps were 10.3, 10.3 and 10.2 ms. Trace completion-to-fire
was 11.720, 12.836 and 12.224 ms; longest renderer RunTask overlapping the completion
window was 12.012, 13.068 and 12.551 ms. There were no measured frame gaps over
50 ms. The package and embedded Host hashes are included in every summary.

These are instrumented baseline observations, not a fix for the earlier 141.8 ms
outlier. Tracing adds overhead, rAF is not pixel presentation, and this summarizer
does not identify compositor/GPU stalls. No product animation implementation was
changed by this work. A future reproduced hitch can now be correlated with the
captured tasks instead of inferred from a frame-gap counter alone.

Raw traces: `/tmp/ndm-electron-native-75WGMo/completion-trace.json`,
`/tmp/ndm-electron-native-lcjMkA/completion-trace.json`,
`/tmp/ndm-electron-native-vjZ9kR/completion-trace.json`.
Summaries: `core-audit-2026-10-04/macos-completion-trace-baseline.json`.
QA/helper JavaScript syntax and diff checks passed. Installed apps/profiles were
not modified. The intermittent hitch remains open.


## Repeated launches and overlapping completion bursts

Six additional isolated launches of the signed package passed the composer,
16 MiB output, HTTP-error and HTML-rejection checks. Max rAF gaps were
16.9/10.4/10.3/10.3/10.1/10.3 ms; first completion-to-fire was 10.7–14.5 ms.
The largest renderer main-thread RunTask in those windows was 14.819 ms.

The harness now supports `NDM_COMPLETION_DOWNLOADS=4` (1–8, with frame observation).
It creates actual downloads through the composer, observes from 100 ms before
the first completion through 2500 ms after the last, records every completion
and burst timestamp, and verifies every delivered file. It still permits
coalescing completions from one snapshot into one burst. The trace summary uses
the full extended observation window. Multi-task mode excludes the single-task
pause/resume UI test, whose selection assumptions would otherwise be ambiguous.

A four-download signed-package run passed with four exact outputs and four
bursts. Completions arrived at 0/429.7/512.0/592.2 ms; the corresponding bursts
were at 6.2/433.9/516.0/600.8 ms. Max frame gap was 10.3 ms, with no >50 ms
frames or long tasks. This is a controlled no-stall observation, not a repair
or proof that the earlier 141.8 ms outlier cannot recur.

The first rapid-shortcut variants failed before reaching measurement: opening
the next composer immediately after submitting could expose a disabled input
that subsequently detached, leaving the main workspace visible. Waiting for
hidden or detached input did not fully resolve that automation race. The final
harness clicks the sidebar Add Download button (waiting for actionability) and
waits for the prior input to detach. The rapid Meta+N interaction remains an
open investigation; the successful button path does not establish shortcut
correctness. One separate selector-development failure matched two Add buttons;
scoping the selector to the sidebar corrected it.

Evidence: `core-audit-2026-10-04/macos-completion-repeat-and-burst.json`.
Raw Chromium traces remain in the recorded temporary roots. Installed apps,
user downloads and profiles were unchanged; intermittent hitch and startup
black-frame acceptance remain open.

Updated single-task harness also passed without Chromium tracing: 10.3 ms max
frame gap and 10.8 ms event-to-fire, with exact output and error checks. Both QA
scripts passed JavaScript syntax and diff checks; product code was unchanged.
