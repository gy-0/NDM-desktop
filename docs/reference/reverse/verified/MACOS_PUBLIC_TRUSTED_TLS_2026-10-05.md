# Public trusted HTTPS: release and installed Host

The current Swift engine successfully downloaded a public HTTPS file directly
and through the explicit SOCKS adapter with default certificate validation.
This closes the basic trusted-HTTPS success gap left by the self-signed rejection
experiment; it is not an original/current speed comparison or a large-file test.

## Reproduction and controls

```
python3 scripts/reverse/reuse/check_public_tls.py
python3 scripts/reverse/reuse/check_public_tls.py --host /Applications/NDM.app/Contents/Resources/bin/NDMHost
python3 scripts/reverse/reuse/check_proxy_routing.py
```

The smoke fetches `https://www.python.org/static/img/python-logo.png` with curl
(default trust, environment proxy disabled), then downloads the same URL through
three isolated Host tasks: direct, successful SOCKS5, refused SOCKS5. Each run owns
its profile, ports, output directory, child Host and loopback proxy. It leaves
system trust/settings and the running application's task library untouched.

The shared SOCKS fixture remains loopback-only by default. The public smoke opts
into one pinned destination, `www.python.org:443`, and rejects any other hostname
or port. It relays opaque TLS bytes without terminating or weakening TLS. The
existing local routing regression also passed after this fixture change.

## Observed results

| Target | Direct | SOCKS | Refused SOCKS |
| --- | --- | --- | --- |
| Release Host | Complete, 15,770 bytes | Complete, same SHA-256; one bidirectional SOCKS route | Error, zero completed bytes, no final output |
| Installed 2026100503 Host | Complete, 15,770 bytes | Complete, same SHA-256; one bidirectional SOCKS route | Error, zero completed bytes, no final output |

All four successful outputs match the curl control:
`9c121e619bfe02eaba582d7080eea46fd53ec0b50717e6794a948fada4ae8f3c`.
Installed Host SHA-256:
`14112a3c012e8fe643e7e04706d7e3c713904349c03227cbc2178ab48d07e4aa`.
Both owned Hosts stopped normally through the harness cleanup. Refusal is
currently displayed as generic CFNetwork error 310; clearer proxy diagnostics
remain a usability opportunity.

Artifacts under `core-audit-2026-10-04/`:

- `macos-public-trusted-tls-release.json`
- `macos-public-trusted-tls-installed.json`
- `macos-proxy-fixture-recheck.json`

## Boundaries

Only one small public file and one attempt per case are covered. Timings include
polling and uncontrolled network/cache differences, so no speed advantage is
claimed. The proxy log proves successful SOCKS traversal, while the refusal case
proves failure and no completed output; it is not a packet capture proving zero
attempted direct sockets. This does not establish multi-range HTTPS recovery,
HTTPS loopback support, HLS routing, original parity, native Windows acceptance,
or the installed Electron window's visual behavior. Those remain open.
