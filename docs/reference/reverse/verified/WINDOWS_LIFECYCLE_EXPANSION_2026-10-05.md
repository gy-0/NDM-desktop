# Expanded native Windows lifecycle acceptance

The Windows download CI job now includes three existing isolated aria2 scenarios
that were previously outside its five-case acceptance set:

- `--pause-all-during-save`: hold persistence of the switch to a backup source,
  queue pause-all, then release persistence. No backup request may start, the
  task remains paused, and explicit resume must deliver the exact backup bytes.
- `--remove-during-probe`: delete during a deliberately delayed backup metadata
  probe. Removal must finish before the delayed response, remain removed and
  create no subsequent backup body request.
- `--remove-during-admission --stop-always-fails`: inject failure stopping an
  admitted aria2 writer. Deletion must fail while retaining its task, GID and
  file; it must not discard ownership of an active writer.

All three local runs passed using the actual Windows orchestration code and
isolated aria2 on macOS. Probe removal took 22 ms against a 1,500 ms delayed
response; pause-all caused zero backup requests before explicit resume; the stop
failure retained the active writer. These are **local orchestration results**,
not Windows filesystem acceptance. YAML parsing and diff checks passed.

[Local reports](core-audit-2026-10-04/windows-lifecycle-expanded-local/).
The native Windows job will upload `mirror-pause-save.json`,
`mirror-remove-probe.json` and `admission-stop-failure.json` with the other
`windows-download-recovery` artifacts. Actual Windows results must be inspected
before marking these cases native-validated. No production engine code changed.
