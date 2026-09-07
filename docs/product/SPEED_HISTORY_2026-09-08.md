# Speed history repair — 2026-09-08

Baseline: build 2026090806 discarded unchanged-speed arrivals because Inspector's effect depended on the numeric speed while the store intentionally reused unchanged task objects. Actual renderer QA received another identical snapshot and still observed only `M 283.0 10.0`, with zero history width. The previous SVG fill also closed to the plot's left edge even when the first measured point was recent, and path morphing changed command count whenever a sample arrived.

## Implemented behavior

- Full and partial engine snapshots publish a small per-task telemetry event before list deduplication. Only current subscribers receive it. Unchanged task objects and list notification suppression remain intact.
- The selected Inspector records genuine received speed values at a maximum two samples per second, without the previous EMA or a timer fabricating new observations. It unsubscribes and clears on task change, pause or unmount.
- A rolling 30-second history retains one predecessor for the visible left-edge line intersection, with at most 64 points. Clock rollback or a gap longer than the window starts fresh history. Time represents renderer receipt, not an engine-side measurement timestamp; sub-500ms peaks can be missed.
- The chart animates the time viewport and vertical scale, reprojects actual observations on each frame, and clips out-of-window geometry. It does not morph incompatible SVG paths or generate a fixed number of fake observations.
- A first sample is a point, empty history stays empty, and filled area begins at the first observation. The vertical scale includes the visible left-edge intersection; its label says curve peak. Zero data reports zero rather than the protected plotting denominator.
- The chart directly subscribes to the system reduced-motion media query. The installed Motion hook only captures its initial preference; retaining it would leave running animations active after a preference change.

## Evidence

`scripts/qa-speed-history.mjs` failed against the old signed application with zero constant-speed history width. The corrected actual renderer observed about 6.09 SVG units of constant-speed history, 36 distinct paths during a new sample, matching line/fill bounds at the recent edge, immediate runtime reduced-motion settling and no chart after pause. Logs: `/tmp/ndm-speed-history-red.log`, `/tmp/ndm-speed-history-green.log`.

279 script/UI-logic tests and typecheck passed. Tests cover unchanged full/partial telemetry without list identity changes, unsubscribe, missing/invalid measurements, sample spacing, clock changes, long gaps, predecessor retention, empty/first/zero geometry, viewport interpolation and left-edge scale.

The broader transfer-motion QA now seeds real observations after opening Inspector and checks finite multi-point geometry plus intermediate frames instead of an obsolete 39-cubic-segment expectation. Its FPS counter also now starts at the same instant as its elapsed-time interval. The corrected run passed with 119.5 measured FPS, 36 speed-path states, continuous progress, pause/resume and task spotlight checks, with no renderer errors. This is isolated deterministic QA, not a throughput benchmark or a claim that all app motion has been visually reviewed.

Final signed-package and deployment evidence is recorded in the release notes. Browser Relay migration, authentication follow-up and single-file offset storage remain separate pending work.
