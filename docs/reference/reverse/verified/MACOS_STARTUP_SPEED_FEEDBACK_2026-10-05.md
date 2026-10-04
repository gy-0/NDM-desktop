# Startup speed feedback in the current Swift engine

The actual Electron startup validation showed increasing completed bytes while
all speed surfaces still displayed zero. `DownloadManager.progressForPresentation`
replaces the raw engine rate with a shared `OneSecondSpeedSampler` target. The
sampler previously returned no target until at least one full second elapsed.

The original's verified research instrumentation (`scripts/reverse/reuse/probe.m`,
`captureProgress`) captures its native completed-byte and speed fields together.
`core-audit-2026-10-04/original-engine-reuse-progress.json` contains a nonzero native
rate during partial progress. That artifact does not establish the original's
exact first-speed latency or sampling formula. This change addresses the current
app's independently reproduced delay; it does not claim to reproduce an original
algorithm or prove a cross-product speed advantage.

The sampler now emits one early target after at least 200 ms with positive new
bytes, using actual elapsed time. It retains the initial baseline for the full
first-second rate. After that, the existing one-second cadence remains. The
manager caches the same early target for all observers; it does not generate a
new rate for every observer or animate guessed throughput. Empty sampling windows
while waiting for headers do not consume the early sample. Explicit reset and
clear re-arm it, and initial/restored bytes are excluded from its delta.

Deterministic tests cover the minimum measurement window, full-window accounting,
no movement, real elapsed time, restored bytes, reset/clear, delayed headers,
per-task independence and shared observer values. Existing negative-delta handling
remains intact. Transport, range ownership and persistence are unchanged.

The actual UI harness now waits for positive `[data-gallery-speed]` text in
addition to visible progress, verifies exact output bytes and HTTP failure UI,
and records both observations. With the prior release binary it observed progress
at 409 ms and nonzero speed at 1213 ms after submission (150 ms fixture header
delay). These measurements include test polling and are not exact paint timing.

After the release rebuild, the same harness observed progress at 403 ms and
nonzero speed at 405 ms. The active screenshot was inspected: the card, toolbar
and inspector all show 1.24 MB/s, with actual partial bytes and an ETA. Exact
16 MiB contents and expired-link diagnostics passed again. Reports including
binary SHA-256 are retained as `macos-startup-speed-before.json` and
`macos-startup-speed-after.json` in the same audit directory. These are one pair
of local runs; the result proves the first-second display hold was removed,
not increased transfer bandwidth or superiority to the original's speed display.

Validation: the full `npm run test:native` run passed (724 engine tests including
28 skipped, 562 core tests, 32 bridge tests and 11 Swift Testing cases). The final
small refinement that preserves warmup eligibility through empty windows was
then checked by rerunning `OneSecondSpeedSamplerTests` and
`DownloadManagerPresentationSpeedTests`: all seven passed.
`npm run build:native`, script syntax and `git diff --check` passed. No installed
application was replaced.
