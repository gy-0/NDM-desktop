# Native Windows/NTFS recovery validation and publication fix

Running the actual Windows engine with the product's pinned aria2 on a Windows
runner exposed a real completion failure missed by macOS orchestration tests:
mirror payloads reached their final size but publication failed with
`EPERM: operation not permitted, fsync`.

`WindowsMirrorAttempts.preparePublication` opened the settled payload with `r`
before `FileHandle.sync()`. It now uses `r+`, allowing the Windows flush without
creating or truncating data. Existing ownership, link-count, size, publication
journal and exclusive destination checks remain in place.

## Before and after

- Before, commit `64bd7e4`, run
  https://github.com/gy-0/NDM-desktop/actions/runs/37243370100 :
  identity and POST cases pass; mirror lifecycle, backup resume and restart
  fail. Backup resume retains the explicit `EPERM ... fsync` error at full size.
- After, commit `7a36707`, run
  https://github.com/gy-0/NDM-desktop/actions/runs/37243617230 :
  **Windows native download recovery** job `111557111247` succeeds with all five
  scenario steps and artifact upload passing.
- Environment: Windows NT 10.0.26100.0, NTFS, Node 22, aria2 1.37.0. Downloaded
  archive and executable hashes match the product pins in
  `scripts/fetch-windows-tools.mjs`. The executable SHA-256 is
  `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2`.

The new CI job runs real local HTTP fixtures and isolated aria2 processes on
Windows. It covers unchanged/changed/changed-after-probe identity, POST bytes
and no ambiguous replay after restart, mirror generation publication, paused
backup validator rejection/resume, and restart intent/storage ownership. The
mirror reports show exact backup hashes, preserved primary partial data,
single-task recovery and no new requests when reopening completed publication.
These are no longer macOS-only orchestration results.

Raw reports are retained under `core-audit-2026-10-04/` in
`windows-native-before-publication-fix/` and
`windows-native-after-publication-fix/`. CI artifact name:
`windows-download-recovery`. The observational identity script now records its
actual platform instead of a hardcoded macOS scope description.

## Other validation and remaining limits

Local `npm test` passed: 796 tests, 788 passed, eight skipped, zero failures.
`npm run typecheck`, `npm run build`, JS syntax and YAML parse/check passed.
Existing publication recovery tests exercise this path, so a duplicate test
that only inspects the `r+` implementation was not added.

This is a **successful Windows download job**, not an entirely green CI run.
The same after-run has a failing Windows Desktop `npm test` step and a failing
Linux workspace UI QA step, whose details require separate investigation.
Native macOS CI was still running when this evidence was recorded. This note
does not treat those jobs as passing.

Windows installer/signing/UI acceptance, reparse-point adversarial coverage,
non-NTFS filesystems and all unselected mirror lifecycle variants remain outside
these five cases. Packaging/deployment has not been performed for this fix.
