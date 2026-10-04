# Public trusted HTTPS segmented pause/resume

Both the current release Host and installed 2026100503 Host complete a public
29,186,321-byte HTTPS archive after pausing with partial durable data. Direct and
SOCKS paths produce exactly the same SHA-256 as an independent curl download:
`12445c7b3db3126c41190bfdc1c8239c39c719404e844babbd015a1bc3fafcd4`.

## Reproduction

```
python3 scripts/reverse/reuse/check_public_tls.py --pause-resume --expect-proxy-diagnostic
python3 scripts/reverse/reuse/check_public_tls.py --pause-resume --host /Applications/NDM.app/Contents/Resources/bin/NDMHost
```

The fixed public resource is
`https://www.python.org/ftp/python/3.13.0/Python-3.13.0.tgz`.
Nothing is extracted or executed. Default TLS validation stays enabled. The
loopback SOCKS relay permits only `www.python.org:443`, relaying encrypted bytes
without TLS termination. Each run owns a fresh profile, ports, files and Host;
the real app/download library is untouched. Owned Hosts stopped after testing.

## Assertions and evidence

The harness requests four connections and pauses after observing at least 1 MiB.
It verifies paused status, an owned offset-storage receipt, a segmented plan,
a positive durable prefix smaller than the file, and identical hashes/sizes of
partial payload and support files across one second. It then resumes, checks
successful completion and hashes the whole output against curl. SOCKS resume
must create new accepted routes. Paused/cancelled connections may end before
receiving bytes; aggregate successful two-way transport is still required.
The original small-file mode retains its stricter every-route byte assertion.

| Host / path | Durable bytes at pause | Ranges | Exact final file |
| --- | --- | --- | --- |
| Release / direct | 1,455,303 | 4 | Yes |
| Release / SOCKS | 2,012,359 | 4 | Yes |
| Installed / direct | 2,586,067 | 4 | Yes |
| Installed / SOCKS | 2,195,438 | 4 | Yes |

The installed report also retains the engine logs: ranged worker requests and
retained-parent tail handoffs occur after resume. These are engine observations,
not server-side plaintext traces. The initial release run predates adding the
log capture and explicit multiple-range assertion; its saved receipt has four
ranges and was inspected separately. The final script ran against the installed
Host with all assertions enabled, except the new diagnostic expectation.

The refused-proxy negative case returns error, zero completed bytes and no final
file in both runs. Release reports the new proxy-specific diagnostic; installed
2026100503 still reports CFNetwork 310 as generic, as expected before deployment.

Raw evidence under `core-audit-2026-10-04/`:

- `macos-public-tls-resume-release.json`
- `macos-public-tls-resume-installed.json`

Python compilation and `git diff --check` passed. This change touches QA only.

## Limits

This is one public origin/file, not original-engine comparison, broad CDN
coverage, sustained endurance or a speed benchmark. Each path ran once; pause
points differ. The proxy sees encrypted byte counts, not HTTP Range headers.
The test proves stable paused storage and exact final output, not zero redundant
wire bytes. Abrupt established-TLS connection loss, full process restart,
HTTPS loopback support and HLS remain separate gaps. Running the installed Host
in isolation is not installed Electron visual acceptance.
