# Original macOS SOCKS routing comparison

The hash-pinned original macOS 1.3 routes both 127.0.0.1 and a remote hostname
through SOCKS5. It fails when the proxy refuses the connection and does not fall
back to direct HTTP. This establishes a remaining functional gap: the maintained
Swift engine currently rejects SOCKS loopback destinations to prevent URLSession
from silently bypassing the proxy; it does not yet support that original behavior.

## Reproduction

```sh
python3 scripts/reverse/reuse/run.py --headless --audit-original-socks
```

The existing sandboxed original harness creates a separate profile, copy and
ports. Launch arguments set `HTTP_IsActive=1`, `HTTP_ProxyType=1`, proxy host/port
to the local fixture, and `SocksVersion=5`. The settings alone are not proof:
the fixture parses actual SOCKS5 CONNECT handshakes and records requested
destination, port and forwarded byte counts. It connects exclusively to its
owned loopback HTTP fixture, never the supplied remote hostname or another port.

| Case | Verified original result | Current boundary |
| --- | --- | --- |
| Loopback origin through working SOCKS5 | Four proxy CONNECTs, forwarded requests/responses, exact 1 MiB SHA-256 | Explicit rejection after bypass fix |
| `socks-fixture.ndm.invalid` through working SOCKS5 | Hostname sent to proxy, four CONNECTs, exact 1 MiB SHA-256 | Remote-name proxy transfer passes native integration test |
| Proxy refuses loopback CONNECT | Terminal error, SOCKS attempts recorded, zero HTTP origin requests | Explicit rejection before dispatch |

The original also attempts SOCKS4 after the SOCKS5 refusal. The fixture parses
and explicitly rejects those requests too. This does not prove SOCKS4 successful
transfer, authentication behavior, all retry policies, or public-network speed.

Evidence: `core-audit-2026-10-04/macos-original-socks.json`. The report verifies
original source integrity, original process shutdown and removal of the owned
copy to Trash. Payloads and reports remain in its temporary directory. No real
profile, installed NDM build, system proxy or system trust was changed.

## Remaining implementation target

Supporting SOCKS loopback should preserve the requested destination and HTTP
Host/TLS identity, route all requests through the selected proxy, retain proxy
authentication and remote DNS semantics, and preserve pause/resume/cancellation.
Rewriting a hostname to an arbitrary alias is not equivalent routing. Removing
the rejection without a proven transport fix would restore the silent bypass.

The immediate bypass fix therefore closes a correctness defect but does not
complete proxy feature parity. Working loopback SOCKS transfer and redirected
loopback transfer remain open acceptance cases for the current engine.
