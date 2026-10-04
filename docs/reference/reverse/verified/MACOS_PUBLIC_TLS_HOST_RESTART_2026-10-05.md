# Public HTTPS paused task across Host restart

The release Host restores paused public HTTPS tasks from disk and completes them
correctly after its process is replaced. Both direct and SOCKS transfers of the
29,186,321-byte Python 3.13.0 archive match the independent curl hash:
`12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4`.

## Reproduction

```
python3 scripts/reverse/reuse/check_public_tls.py --pause-resume --restart-after-pause --expect-proxy-diagnostic
```

The new option requires pause/resume mode. The harness first awaits a paused task
and verifies owned partial payload/receipt/support files are stable for one
second. It then sends SIGTERM to its own paused Host, waits for that PID to exit,
checks storage again, and launches another Host with the same isolated profile
and ports. It waits for RPC readiness, requires the same task ID to remain paused
with positive saved progress, and rechecks exact storage hashes before resuming.
No proxy settings are reapplied after restart: the resumed SOCKS task must use
persisted settings and create new accepted routes.

This is a controlled process termination **after durable pause**, not an active
write crash, power failure, or the Electron application's normal Quit workflow.
The old processes exited with signal 15 (return code -15); no force-kill was used.

## Observed evidence

| Path | Old PID | New PID | Restored status | Restored completed bytes |
| --- | --- | --- | --- | --- |
| Direct | 24006 | 24009 | paused | 1881260 |
| SOCKS | 24009 | 24120 | paused | 2788960 |

The exact payload and receipt snapshots remain unchanged through shutdown and
startup in both cases. Positive restored progress is bounded by the durable
prefix sum; UI progress and durable checkpoint counts need not be identical.
Both resumed tasks complete with exact full-file hashes. The refused-proxy
negative control still produces zero bytes/no final file and the new localized
proxy failure diagnostic. The final owned Host stops in cleanup.

Raw report: `core-audit-2026-10-04/macos-public-tls-host-restart.json`.
Python syntax and `git diff --check` passed. Only QA code changed; no production
rebuild or deployment was necessary. Existing pause, TLS validation, exact-file
and proxy assertions remain in the exercised path.

## Remaining boundary

This is one release-Host run with an isolated profile, not installed Electron
visual acceptance or original-engine comparison. It covers saved paused tasks,
not abrupt interruption while a payload/receipt is being committed. Public
network timings are not a controlled performance comparison. Native Windows,
HTTPS loopback and HLS transport gaps remain separate.
