# CI platform boundaries and onboarding focus recovery

The native Windows download job passed after the mirror fsync fix, but ordinary
CI still failed. Investigation separates unsupported reference tooling, stale
renderer assertions, and one actual focus defect.

## Windows reference-tool tests

The original macOS research intake uses directory fsync, and its session relies
on a POSIX SIGTERM handler. On Windows these produced EPERM and missing graceful
shutdown receipts. Neither helper is used by the shipping Windows downloader.
They now reject Windows before side effects. POSIX contracts remain tested on
macOS/Linux; Windows tests the explicit rejection, empty directory and no child.
Snapshot/control tests and shipping downloader tests remain enabled everywhere.
We did not remove the pre-send durability barrier or substitute forceful Windows
termination for a graceful reference shutdown. See the research README boundary.

## Renderer QA and focus bug

The toolbar assertion searched the old search row for display options. Current
layout puts those controls in the action row; the test now verifies presence,
separation from search, and the detail toggle's rightmost position. A saved-draft
failure assertion also expected a hidden fallback notice; it now checks the
actual save error/retry control while retaining the no-unsaved-engine-request
assertion.

Full local QA then reproduced lost keyboard focus in onboarding. Focus events
showed exit-animation completion focusing the departing welcome heading. Its
removal triggered Base UI's immediate and next-frame popup focus recovery; the
next-frame call stole focus from the newly selected tab. The final fix focuses
only after entrance animation (opacity 1) and preserves focus already inside the
page. Intermediate guesses alone did not pass; the retained event trace was used
to identify the exit callback. No library focus trap is disabled.

## Local validation

- `npm test`: 798 tests, 788 passed, ten platform skips, zero failures.
- `npm run typecheck` and `npm run build`: passed on final source.
- Full built renderer QA: 50 checks passed, zero renderer errors, with an isolated
  headless installed Chrome. Bundled Playwright Chromium was absent locally;
  no user browser profile was used.
- Syntax/diff checks passed. Remote Windows/Linux validation is tracked by CI;
  local Chrome results are not a substitute for those runs.

Artifacts under `core-audit-2026-10-04/`: `onboarding-focus-before.json` records the
synthetic focus trace; `workspace-ci-repair-local.json` records all 50 checks.
Installed product visual acceptance remains separate and no package was deployed.
