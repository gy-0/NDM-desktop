# Public HTTPS established-tunnel interruption

A forced loss of one established SOCKS/TLS connection now has public-origin
recovery evidence for both the release Host and installed 2026100503 Host. Both
finish the 29,186,321-byte Python archive with the independent curl SHA-256:
`12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4`.

## Reproduction

```
python3 scripts/reverse/reuse/check_public_tls.py --disconnect --expect-proxy-diagnostic
python3 scripts/reverse/reuse/check_public_tls.py --disconnect --host /Applications/NDM.app/Contents/Resources/bin/NDMHost
python3 scripts/reverse/reuse/check_proxy_routing.py
```

The fixture permits only `www.python.org:443`. It skips the initial SOCKS
connection and, once a later connection has forwarded at least 1 MiB of encrypted
response bytes, closes that socket. A lock permits exactly one injected fault.
It does not terminate TLS, change certificates, mutate bytes or alter the real
machine's network settings. Tasks, Host processes, ports and output directories
are isolated. The original fixture's default behavior remains unchanged.

The harness asserts one actual injected fault, subsequent connected routes
returning data, successful final completion and exact whole-file hash. It also
runs a direct baseline and refused-proxy negative control. Host logs and proxy
route timestamps/counters are retained. Python syntax and local default routing
regression passed; this is QA-only code.

## Observed recovery

| Target | Encrypted bytes forwarded before fault | Fault to observed complete |
| --- | --- | --- |
| Release Host | 1,070,726 | 2558.29 ms |
| Installed 2026100503 Host | 1,056,349 | 1500.00 ms |

Both engine logs show a worker receiving `NSURLErrorDomain(-1005)`, followed by
`RecoveryHandoff: healthy range finished; releasing one transport cooldown`.
Thus the previous healthy-worker handoff fix runs in this public TLS case; it
is not only a local HTTP-fixture result. Release logs show the interrupted range
7296580–14593159 resuming at 8342220 rather than its original start. Installed
logs retain the corresponding retry and handoff sequence.

The differing elapsed times are not a release/installed speed comparison. These
are single runs on an uncontrolled public connection with unequal fault timing,
TLS buffering, CDN/cache conditions and scheduling. Counter values are encrypted
bytes, not exact payload prefixes. No server-side plaintext Range capture or
original-engine public-site comparison is claimed.

## Evidence

Raw artifacts under `core-audit-2026-10-04/`:

- `macos-public-tls-disconnect-release.json`
- `macos-public-tls-disconnect-installed.json`
- `macos-proxy-fault-fixture-regression.json`

Both owned Hosts stopped after validation; the installed running app and its
real tasks were not used. Current source still has the newer proxy diagnostic;
installed 2026100503 correctly retains the older generic refusal message.

This covers a single tunnel disconnect on one public HTTPS archive. Process
crash/restart, broad-origin endurance, original public-network parity, HTTPS
loopback, HLS and installed visual acceptance remain distinct open items.
