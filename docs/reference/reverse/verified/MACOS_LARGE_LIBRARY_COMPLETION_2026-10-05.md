# Large-library completion hitch: Electron bridge

The existing Electron UI and maintained Swift engine remain the product. This
fix addresses a reproduced product-layer delay; replacing the download engine
would not address its cause.

## Reproduction and cause

A read-only installed-library check found 3,748 tasks and no downloading/waiting
tasks. No installed task, profile or application was changed. The QA harness now
creates a separate synthetic SQLite library with the same status counts (341
complete, 421 error, 2,979 incomplete, seven paused). URLs are localhost fixtures;
no real user URLs or task records are stored in this evidence.

With that library, a packaged-app composer download reproduced completion frame
gaps of 374.8 and 357.8 ms. Chromium tracing found corresponding renderer tasks
lasting 382.174 and 360.313 ms. An independent CPU-profile run reproduced gaps
of 391.9 and 350.8 ms, with 642.9 ms aggregate self time in the preload event
listener across the recorded run. The particle worker was already running.

Each thumbnail and other UI consumer previously subscribed through preload
separately. Every full snapshot crossed contextBridge as a large object graph
for every subscription, even when the consumer only needed installation events.
The renderer also sent a full object summary back through the bridge.

## Change

- Share one preload event subscription among renderer consumers, parsing one
  serialized event and distributing it inside the renderer. Release the
  subscription when the last consumer unmounts; reconnect on remount.
- Serialize initial list replies and outgoing task summaries across the isolated
  world. Preserve full/partial snapshots, notification-baseline readiness,
  installation events and temporary-bandwidth events.
- Keep the legacy object API for existing callers and QA mocks. No raw Electron
  IPC object is exposed. The native engine and persisted task schema are unchanged.
- Keep fireworks and their worker; no animation was removed or reduced here.

## Actual packaged-app results

| Scenario | Largest completion-window rAF gap | First event-to-fire | Fires |
| --- | ---: | ---: | ---: |
| Before, single, Chromium trace | 374.8 ms | 35.9 ms | 1 |
| Before, single, CPU profile | 391.9 ms | 35.4 ms | 1 |
| After, single, Chromium trace | 41.7 ms | 13.1 ms | 1 |
| After, three downloads, Chromium trace | 50.8 ms | 8.2 ms | 3 |
| After, pause/resume, Chromium trace | 42.1 ms | 11.9 ms | 1 |

The final single, three-download and pause/resume runs recorded no renderer long tasks. The
three-download run still had one 50.8 ms frame interval; this is a substantial
reduction, not a claim of perfect frame pacing. All completed 16 MiB outputs
matched exactly, historical tasks never restarted, HTTP 403 displayed the
expected error, and an HTML login response was not published as the file.
The single-run completed screenshot was inspected. Pause counters stayed stable
for 500 ms; resume used a nonzero bounded Range with the saved If-Range,
received the first server body after 176 ms and passed the 100 ms frame budget.

Development-only intermediate profiling (51.5 ms maximum) is retained separately
and is not substituted for the packaged result. Two initial packaged attempts
failed before submitting any download because the QA locator waited for the
background Add Download button while onboarding was open. The harness now waits
for and dismisses the fresh-profile dialog first. A large-library resume attempt
also exposed an ambiguous QA button locator; controls are now scoped to the
selected fixture task. Failed attempts are retained and excluded from passing
performance results.

Validation: 788 TypeScript tests passed, eight existing skips, typecheck passed;
`npm run package` built the in-repository native Host, renderer and signed bundle.
The new tests cover shared delivery to 30 subscribers, remount/cleanup, legacy
fallback, malformed serialized input, initial/full/partial task views, completed
bytes, notification readiness and task removal. No native source changed.

Evidence: `core-audit-2026-10-04/macos-large-library-completion.json` includes
artifact hashes, report paths, frame samples and trace summaries. CPU profiles
and full traces remain at their isolated temporary paths.

Reproduce (add `NDM_COMPLETION_DOWNLOADS=3` or `NDM_QA_PAUSE_RESUME=1` separately):

```sh
NDM_QA_APP_PATH="$PWD/dist/mac-arm64/NDM.app/Contents/MacOS/NDM" \
NDM_QA_LARGE_LIBRARY=1 NDM_COMPLETION_TRACE=1 \
NDM_COMPLETION_MAX_FRAME_MS=100 node scripts/qa-electron-native-startup.mjs
```

The optional frame budget turns a recurrence of the several-hundred-millisecond
hitch into a QA failure. rAF/renderer traces are not physical pixel-presentation
measurements. This local fixture does not prove public-site throughput or close
the startup-black-screen investigation. The installed app still requires guarded
deployment and task-preservation verification.
