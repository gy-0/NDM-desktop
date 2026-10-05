# Public HTTPS active Host crash recovery

The maintained release Host completes the pinned Python 3.13.0 archive after
its owned process is killed during active post-checkpoint HTTPS writes, both
directly and through SOCKS. Both 29,186,321-byte outputs match the independent
curl control and fixed SHA-256:
`12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4`.

```sh
python3 scripts/reverse/reuse/check_public_tls.py --pause-resume --crash-after-resume --expect-proxy-diagnostic
```

The harness uses an isolated HOME, support directory, output directory, ports
and owned child Host. After establishing a durable paused checkpoint and proving
its files stable for one second, it resumes, waits for new reported bytes more
than 64 KiB past the checkpoint, then SIGKILLs that child handle only. The receipt
must retain at least the acknowledged checkpoint. It restarts the same profile,
verifies interrupted storage is unchanged at startup, and resumes the same task.

An active interrupted task restores as `incomplete`, per
`DownloadStore.recoverInterruptedTasks`, whereas a task stopped after a durable
pause restores as `paused`. The first harness attempt incorrectly expected the
paused state; its assertion was corrected to the actual active-crash contract.
No production recovery logic was changed to accommodate this test.

| Path | Progress immediately before crash | Durable bytes after crash | Restored bytes | New proxy routes after restart |
| --- | ---: | ---: | ---: | ---: |
| Direct | 1,386,034 | 1,308,201 | 1,308,201 | 0 |
| SOCKS | 1,923,923 | 1,780,545 | 1,780,545 | 7 |

All logged post-restart worker Range requests started above zero. The relay
carries opaque TLS bytes, so that observation is engine-log evidence, not an
independent origin-side Range capture. Complete-file hashes and exact interrupted
storage snapshots are independently checked by the harness. Refused SOCKS still
produces zero completed bytes, no final file, rejected routes and the expected
localized diagnostic. The final owned Host stopped normally in cleanup.

[Raw report](core-audit-2026-10-04/macos-public-tls-active-crash.json) identifies
Host SHA `7c545137916d5566b44ff27cbaadbb9dbc4c2b88e992ec29dd61d075d7a47314`.
Python syntax and diff checks passed. This extends QA only; the exercised release
Host already includes the separately tested HLS fix.

This is one public origin and one deliberate crash point per transport after a
known checkpoint. It does not establish power-loss durability, every receipt
commit boundary, long-duration throughput, other certificates/origins, original
engine parity under HTTPS crash, or installed Electron visual acceptance.
