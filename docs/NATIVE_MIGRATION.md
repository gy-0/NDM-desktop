# Native engine migration

2026-09-07: imported from the clean NDM checkout at commit `e7581ccc53af0e6a65a1e372a8012b0faae53105`.

Imported NDMCore, NDMEngine, NDMBridge, NDMHost, their three test suites, NDMRelay including tests, the segment-format fixture, the app icon, the media tool preparation script, and historical reverse/specs notes. The old repository and its history remain untouched. Swift app UI, CLI, standalone probes, old build outputs and full decompilation are not included.

`native/Package.swift` contains only the host and its dependencies/tests. The debug media tool lookup now resolves relative to its source file. Follow-up fixes make explicit nil compatibility-tool dependencies stay nil and use observed round throughput before the first periodic speed sample, avoiding needless short-tail reconnects. Electron runtime, extension discovery and packaging use this repository. Packaged host startup uses the resources directory as cwd, so installed apps do not need any source checkout.

The locally copied media tools are ignored generated files, not repository dependencies; a fresh checkout recreates them with `npm run fetch:mac-tools`. This requires network access, Xcode command line tools and GnuPG (plus nasm for x86 FFmpeg). Tool preparation is an explicit first-time step, not performed on every build.

The reverse specifications are historical documentation and may refer to files only present in the old repository. They describe the original product, not promises about the current engine. Current behavior is defined by source and tests.

## Verification and follow-up fixes

- Fixed the node TypeScript target and shared-source include. `npm run typecheck` checks both main/preload and renderer projects.
- Updated range integration fixtures to use the current immediate four-worker plan instead of the retired 960 KiB bootstrap. Ignored Range responses are checked for exactly one full GET; the short-tail case still forbids extra connections.
- Compatibility updates now discover the bundled tool in `configured()`, while explicit initializer dependencies are honored. The concurrency test has a bounded expectation instead of an indefinite wait.
- Preserved the segment-format fixture and the existing native, extension and JavaScript suites.
- Full native run passed: 806 XCTest cases (6 opt-in/environment skips, zero failures) plus 11 Swift Testing cases. The previous compatibility stall is resolved.
- JavaScript 197 tests and Relay 90 tests passed. Both TypeScript projects and Electron production build passed.
- An export of the exact staged source tree, excluding unrelated WIP, passed JavaScript tests, typecheck, production build, fresh native Release build, macOS packaging and deep ad-hoc signature verification.
- The staged app launched from an isolated temporary directory with a deliberately nonexistent NDM_SOURCE, completed a four-segment 2 MiB download from a local HTTP server, and matched the origin SHA-256. No installed app was replaced.

Media tool preparation was migrated but not downloaded/rebuilt end-to-end during migration; packaging uses copied local tools. A new checkout must run `npm run fetch:mac-tools` before packaging. Generated tool binaries and Swift build outputs are not committed.

The old repository remains unchanged. Historical reference notes may name it, but active runtime/build paths do not depend on it. Unrelated local renderer and Windows Cookie changes are excluded from this migration commit.
