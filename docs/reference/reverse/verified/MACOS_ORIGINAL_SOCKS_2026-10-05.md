# Original macOS SOCKS routing comparison

Update: ordinary HTTP file SOCKS routing is now implemented and compared in
`MACOS_SOCKS_FILE_TRANSPORT_2026-10-05.md`. References below to current rejection
describe the pre-adapter audit state; HTTPS loopback remains an open gap.

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

## URLSession configuration experiment

`python3 scripts/reverse/reuse/check_proxy_api.py` compiles a standalone Swift
URLSession probe and checks three configurations against the same fixture:

1. Existing `connectionProxyDictionary` SOCKS5 keys.
2. Explicit SOCKS enable, empty exceptions list and disabled simple-host exclusion.
3. Network `ProxyConfiguration(socksv5Proxy:)` with `allowFailover = false` and
   empty excluded domains, via `URLSessionConfiguration.proxyConfigurations`.

Each configuration is checked with a literal loopback destination and a remote
`.invalid` hostname, with successful and rejected SOCKS CONNECTs: 12 cases total.
All three configurations bypassed the proxy for loopback, even when it rejected
connections. All three demonstrably used SOCKS for the remote hostname, succeeded
when allowed and failed without origin traffic when rejected. This positive
control rules out a completely ignored proxy configuration as the explanation.

Raw evidence, including the exact host OS version:
`core-audit-2026-10-04/macos-socks-api-routing.json`. This is system API evidence
on that OS, not cross-version acceptance or a production fix. The installed SDK
marks the newer API macOS 14+, while this package supports macOS 13+. Merely
switching APIs would neither fix the observed bypass nor cover the minimum OS.

The existing `FTPTransport.swift` already performs explicit SOCKS4/5 negotiation
over `NWConnection`, including credentials and cancellation. Reusing that byte
transport is a candidate for the next implementation step. HTTP must retain its
existing range ownership, validators, TLS identity and redirect protections;
the experiment does not authorize removing the fail-closed guard first.

## Raw Network.framework routing follow-up

`python3 scripts/reverse/reuse/check_nw_proxy_api.py` also tested raw
`NWConnection` TCP with its own `NWParameters.PrivacyContext`, a SOCKS5
`ProxyConfiguration`, `allowFailover = false`, and empty excluded domains.
This is separate from the earlier URLSession experiment. Both allowed and
rejected proxy cases for literal `127.0.0.1` reached the local origin directly
with zero proxy routes. A `.invalid` hostname positive control used the relay
and reached the origin only when allowed; rejection produced no origin request.
Thus the bypass is observable below URLSession on the tested macOS 27.2 build
26B5091g, not merely an ignored URLSession setting.

Raw report: `core-audit-2026-10-04/macos-nw-proxy-routing.json`. The reproducible
probe exchanges only local synthetic HTTP bytes; it does not test TLS trust,
older macOS versions, or a production workaround. A replacement using this
proxy configuration alone cannot be assumed to solve the loopback restriction.
Explicit SOCKS negotiation plus a correctly authenticated TLS transport remains
an implementation boundary; the existing rejection was not removed.
