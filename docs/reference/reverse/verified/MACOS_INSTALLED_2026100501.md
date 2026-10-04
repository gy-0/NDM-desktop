# Installed macOS build 2026100501

Version 2026.10.5 (2026100501) was packaged, signed, installed at
`/Applications/NDM.app`, and launched on 2026-10-05. This brings the maintained
Swift download improvements and large-library Electron bridge fix into the
installed product. It does not replace the architecture or original-reference
comparison work.

## Pre-install acceptance

`npm run package` built the repository Host and frontend and verified the Apple
signature. After the version bump, 788 TypeScript tests passed with eight
existing skips and typecheck passed. The exact release package passed an isolated 3,748-record library
test with two delayed redirects and pause/resume enabled:

- Actual composer submission, progress/speed display and byte-for-byte 16 MiB
  output verification; no historical fixture task restarted.
- Resume counters remained stable for 500 ms, used a nonzero bounded Range with
  the saved If-Range, and received the first server body after 485 ms including
  the intentionally delayed redirect chain.
- Completion maximum rAF interval 34.6 ms, no intervals over 50 ms and no renderer
  long tasks; fireworks fired once after 10.5 ms and the worker was present.
- HTTP 403 appeared as an error; the HTML login response was rejected as a file.

This is localhost acceptance, not public-network throughput evidence. The earlier
packaged delayed-startup fixture also verified that premature second-instance
wake does not show the unpainted window; its report distinguishes a captured
hidden loading shell from user-visible content.

## Deployment and preservation

The initial deployment stopped before any bundle swap because AppleScript
reported -600 despite the installed app still running. After checking there
were no active/queued/starting/merging tasks and verifying the exact bundle path,
`NSRunningApplication.terminate` requested normal quit of PID 38506. The local
AppKit header documents this as normal quit, distinct from `forceTerminate`.
Both old application and Host PIDs exited before deployment was retried. No
force kill was used.

`node scripts/deploy-mac.mjs --skip-build --keep-backup` then installed and
launched the new build. It paused no task IDs. The previous bundle remains at:

`/Applications/.NDM-backup-8531b844-b519-4cc8-8f30-367d09674fc5.app`

All 3,748 tasks retained the compared fields: ID, status, URL, filename, folder
path, completed bytes and file size. Their sorted JSON SHA-256 before and after
was `60d60aee28329cd8aa643fadaf2df16dfd48cf465fe780ae0e14c1c0074da3fd`.
Private task records remain outside the repository; only the digest is published.

Installed and packaged artifact hashes matched:

| Artifact | SHA-256 |
| --- | --- |
| app.asar | `10f81a9050007df1842687d776eab7a55801b02652de7a6169881ac23a537380` |
| NDMHost | `1a52ee19473fb6915408c63864488006681ed0077ad153b2a4096c2e63f99d3f` |

The installed bundle passed `codesign --verify --deep --strict`. New processes
were observed at the installed paths (app PID 2579, Host PID 2606), and engine
RPC returned the retained library. Bundled Relay is 1.4.18; the user's browser
extension has not been reloaded or otherwise changed.

## Remaining acceptance

The native window inspection tool reported that the Mac was locked. Actual
installed-window visual acceptance is therefore pending an unlock. Engine
health, process identity, signature and hash parity do not prove that visual
gate or establish the cause of the user's original black-screen screenshot.
The broader goal remains active, including original/current protocol and
recovery comparisons and native Windows acceptance.

Raw release QA and deployment summary:
`core-audit-2026-10-04/macos-installed-2026100501.json`.
