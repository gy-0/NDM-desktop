# Original/current public HTTPS archive comparison

Both engines downloaded the fixed Python 3.13.0 source archive from
`https://www.python.org/ftp/python/3.13.0/Python-3.13.0.tgz`. An independent curl
control and both outputs contained 29,186,321 bytes and matched SHA-256
`12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4`.

Command: `python3 scripts/reverse/reuse/run.py --headless --compare-host native/.build/release/NDMHost --compare-public-tls`.
Raw evidence: `core-audit-2026-10-04/macos-original-current-public-tls.json`.

The unchanged macOS original 1.3 runs from an owned signed copy with an isolated
profile. Its sandbox still permits only loopback connections. A SOCKS5 relay
allows only `www.python.org:443`; both engines use this same relay, forwarding TLS
without interception or custom trust. Both request four connections, while actual
tunnel counts include startup/reconnection behavior and do not measure concurrent
workers. The current binary hash and all route records are preserved in the report.

| Engine | First observed progress | Observed completion | SOCKS routes |
| --- | ---: | ---: | ---: |
| Original 1.3 | 1016.15 ms | 5813.18 ms | 10 |
| Current Swift Host | 738.41 ms | 4515.35 ms | 5 |

This is one sequential pair, original first. CDN/cache/network conditions are
uncontrolled; original snapshots refresh every 200 ms while current RPC is polled
every 25 ms. These are observed progress/completion timings, not first packet,
first disk write or Electron paint. The pair does not establish general speed
superiority, direct public HTTPS behavior for the original, or endurance/recovery.

Initial harness attempts failed before the reference could reach the destination:
direct network access was sandboxed, and HTTP proxy settings do not populate
the original's separate HTTPS settings. Enabling `HTTPS_IsActive` alone still
left its proxy endpoint unset. Setting `HTTPS_ProxyAddress`, `HTTPS_ProxyPort`
and `HTTPS_ProxyType` produced verified SOCKS traffic and the passing result.
These configuration failures are not classified as original-engine defects.

Both owned processes stopped, the original source hash remained unchanged, and
the temporary app copy was moved to Trash. No production profile or installed
current app was changed. Python syntax checks and the live comparison passed.
