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

## Actual Windows result

Run 37249181937 at `e172b5e` passed the native Windows download recovery job,
including all three new steps and artifact upload. Its environment report confirms
Windows NT 10.0.26100.0, NTFS and the pinned aria2 1.37.0 executable. Pause-all
issued zero backup requests until explicit resume, which produced correct bytes.
Probe removal took 49 ms and issued no backup body request. The injected stop
failure retained the active writer's GID, task and file.

[Windows artifacts](core-audit-2026-10-04/windows-lifecycle-expanded-native/).
These three scenarios now have actual Windows evidence in addition to the five
previous scenarios. This does not cover installer/UI, reparse points or other
filesystems. The separate macOS job was still running when this result was read.

The same run 37249181937 subsequently completed successfully in all four jobs.
[Final CI record](core-audit-2026-10-04/expanded-lifecycle-ci-final.json).
