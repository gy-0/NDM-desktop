# macOS HLS proxy and playlist redirect correction

The maintained Swift HLS engine now reuses the ordinary-file SOCKS adapter for
playlist GETs, size probes, encryption keys, initialization maps and segments.
Each task owns its bridge and closes it on finish, failure, cancellation or VOD
pause. SOCKS4/5 protocol selection and remote DNS stay in the existing transport.
HTTP loopback is supported through that explicit adapter. HTTPS loopback and
unsupported external HTTP-proxy loopback remain rejected before origin traffic;
this change does not claim TLS-loopback feature parity with the original.

The original's verified SOCKS behavior is documented in
[the original routing comparison](MACOS_ORIGINAL_SOCKS_2026-10-05.md).
That evidence concerns ordinary files, not an original HLS acceptance run.

An encrypted-playlist regression exposed a separate existing defect: after a
playlist redirected to another origin, relative key/segment URLs still used the
entry URL and received 404. Playlist fetches now retain the final response URL.
Master variants, media segments, maps, keys, separate audio and live refreshes
resolve relative references against their actual playlist location. Newly built
requests scope captured headers to the original download origin before adding
internal proxy authentication, so the corrected derived requests do not revive
credentials stripped by a cross-origin redirect.

## Verification

- Before correction, the redirected encrypted fixture failed with HTTP 404.
- Native regression covers direct and SOCKS cross-port redirect, exact decrypted
  bytes, no captured origin credentials at the destination, SOCKS4/5 success and
  rejection without direct fallback, and prompt pause during bandwidth throttling.
- `scripts/reverse/reuse/check_hls_proxy_routing.py` drives a release Host using
  isolated support/HOME/ports. Its direct and SOCKS cases follow both master and
  media redirects, fetch relative initialization/segment resources and compare
  every output byte against an independent remux of the generated fMP4 fixture,
  then compares all 10 decoded video-frame hashes. Proxy rejection must produce
  no origin request.

The full native run passed: Engine 746 tests (28 skipped), Core 563, Bridge 32,
plus 11 layout tests. After the final header-boundary and test-timing edits,
all 38 affected HLS/protocol/worker tests passed. Release build passed. The
release Host's direct/SOCKS outputs matched the reference bytes and 10 frame
hashes; rejection made zero origin requests and its owned Host stopped.
[Runtime report](core-audit-2026-10-04/macos-hls-proxy-redirect.json).

The first runtime fixture used arbitrary bytes with an initialization map and
was correctly rejected at media finalization; it was replaced by a generated
MPEG-4 video in fMP4. The bundled ffmpeg lacks libx264, so fixture generation
uses its built-in MPEG-4 encoder. These fixture corrections did not change
production behavior. This is controlled local
HTTP evidence, not public-site HLS performance, minimum-macOS acceptance, or
visual acceptance of the installed Electron app. Installed build 2026100504 does
not contain this subsequent change.
