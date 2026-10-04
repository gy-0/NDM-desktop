# File download SOCKS loopback bypass

Subsequent implementation: `MACOS_SOCKS_FILE_TRANSPORT_2026-10-05.md` supersedes
the HTTP loopback rejection below with actual SOCKS forwarding. HTTPS loopback
is still rejected because the system also bypasses HTTP CONNECT there.

## Reproduced defect

An isolated release NDMHost was configured with an unavailable SOCKS5 proxy at
127.0.0.1:1. Downloading a local HTTP fixture nevertheless reached the origin
directly and completed all 10,752 bytes. With an unavailable HTTP proxy the same
fixture correctly failed without an origin request. Direct mode completed as a
positive control. Evidence: `core-audit-2026-10-04/macos-file-proxy-before.json`.

This is a current-engine correctness defect discovered during the proxy audit,
not a measured original/current speed difference. Historical original specs list
SOCKS configuration and negotiation, but do not prove its loopback routing policy.
A subsequent independent run now proves original loopback SOCKS succeeds and
proxy refusal does not bypass; see `MACOS_ORIGINAL_SOCKS_2026-10-05.md`. The
current rejection remains a functional gap despite closing the bypass defect.

## Implementation

Reuse the existing HLS loopback destination recognition for ordinary file SOCKS
requests. Check before initial dispatch, streamed redirects, and probe redirects.
Remote proxy destinations remain supported; direct-mode local downloads remain
supported. The user receives an explicit error instead of a falsely successful
proxied download. Existing partial files are not deleted by the rejection.

The check covers localhost names, IPv4 loopback (including alternate literal
syntax), IPv6 loopback and IPv4-mapped IPv6 loopback. It does not resolve remote
names locally. This change does not add SOCKS transport support for loopback
destinations or prove DNS-alias behavior. HTTP proxy routing is unchanged.

## Validation

`FileProxyRoutingTests` covers unavailable SOCKS4/5, fresh open-range and legacy
one-byte-probe redirects to loopback, and successful byte-exact SOCKS5 transfer
through a fixture-only remote hostname. The initial full run included an obsolete
HEAD expectation in the new legacy test: actual legacy discovery uses GET with
`Range: bytes=0-0`. The assertion was corrected to verify that real request shape;
the failed run is retained as diagnostic history.

The release regression command is:

```sh
python3 scripts/reverse/reuse/check_proxy_routing.py
```

It owns one temporary profile, local server and Host child. Its report records
origin requests and terminal task states before assertions, so a bypass remains
visible even when the command fails. Installed applications and real tasks are
not used.

Final validation:

- Full native run: 735 Engine tests (28 existing skips), one failed assertion in
  the new test described above; Core 563, Bridge 32 and layout 11 passed.
  Log: `/tmp/ndm-file-proxy-full.log`.
- Corrected affected suites: 40 tests passed, including all three new tests,
  HTTP redirect security and protocol controls.
  Log: `/tmp/ndm-file-proxy-targeted.log`.
- `npm run build:native` passed.
- Release Host regression passed: direct completed 10,752 bytes; both unavailable
  proxies returned error with zero completed bytes and no origin requests.
  Evidence: `core-audit-2026-10-04/macos-file-proxy-after.json`.

This fix is in the source/release Host; the installed Electron bundle has not
been replaced by this change. Native Windows and current successful SOCKS loopback routing remain separate
acceptance work. Original routing is now independently measured as noted above.
