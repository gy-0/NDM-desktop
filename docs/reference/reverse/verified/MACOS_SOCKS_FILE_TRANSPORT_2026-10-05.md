# Explicit SOCKS transport for native file downloads

Ordinary HTTP file downloads now route loopback destinations through SOCKS4/5,
instead of rejecting them or silently connecting directly. Original macOS 1.3
supports this behavior; see `MACOS_ORIGINAL_SOCKS_2026-10-05.md` for the reference
handshake and exact-output evidence.

## Implementation and preserved boundaries

Each SOCKS file task owns a loopback-only HTTP adapter with random, task-local
Basic credentials. The adapter uses the existing FTP byte transport's explicit
SOCKS negotiation. Plain HTTP is forwarded with the original encoded path/query;
internal proxy credentials are removed before forwarding. HTTPS uses CONNECT
and opaque byte forwarding, leaving URLSession responsible for TLS validation.

The existing engine still owns discovery, range identity, segment scheduling,
offset storage, publication and pause/resume. Cancellation closes the listener,
accepted connections and SOCKS upstreams. A refused TCP proxy port fails promptly
instead of waiting through the shared transport's 30-second connection deadline;
this opt-in behavior leaves existing FTP callers unchanged.

Cross-origin redirects continue stripping origin credentials. Only the adapter's
own local credential is restored after that check. Origin Digest uses the actual
origin-form request target, not the adapter's absolute-form incoming target.
External authenticated HTTP proxies retain their existing redirect restrictions.

## Verified results

- Native tests cover SOCKS4/5 authentication, credential removal at the origin,
  rejection of missing local adapter credentials, unavailable-proxy no-bypass,
  remote hostname routing, fresh/legacy redirects, origin credential stripping,
  byte-exact pause/resume, and encoded-path SHA-256 Digest authentication.
- First full run failed a tail-recovery fixture with `ENOSPC`. Verified owned
  synthetic payload cleanup released 848 MiB; reports/screenshots remain.
  `socks-space-cleanup.json` lists every removed path, size and hash.
- Full rerun passed 738 Engine tests (28 existing skips), 563 Core, 32 Bridge and
  11 layout tests. Log: `/tmp/ndm-socks-bridge-full-recheck.log`.
- After the HTTPS-loopback guard described below, all 50 affected proxy, Digest,
  redirect and protocol-control tests passed. Log:
  `/tmp/ndm-socks-final-guard-tests.log`. Release build passed.
- Release Host regression confirms direct HTTP and working SOCKS HTTP complete
  exact payloads; unavailable HTTP/SOCKS proxies fail without origin requests.
  Evidence: `core-audit-2026-10-04/macos-socks-file-release.json`.

### Same-fixture original/current comparison

```sh
python3 scripts/reverse/reuse/run.py --headless \
  --compare-host native/.build/release/NDMHost \
  --compare-size-mib 16 --compare-socks
```

Both engines use the same SOCKS5 fixture and random 16 MiB payload, four requested
connections, three alternating trials per scenario. All 12 output hashes match;
59 SOCKS CONNECT routes are recorded. Original source integrity and owned-process
shutdown passed. Raw evidence: `macos-socks-original-current.json` under the
artifact directory above.

| Median observed completion | Original | Current |
| --- | ---: | ---: |
| Normal fixture | 914.29 ms | 794.99 ms |
| 150 ms response-header delay | 1400.08 ms | 1071.52 ms |

Original snapshots refresh every 200 ms while current is polled every 25 ms.
These are controlled localhost results, not public-network superiority. Server
first-useful-body medians were respectively 21.24/11.04 ms normal and
175.11/163.69 ms delayed. These are server timestamps, not visible UI timing.

## HTTPS evidence and remaining gap

The first TLS test exposed that URLSession also bypasses the internal HTTP proxy
for **loopback HTTPS**. Its failure evidence is retained in
`macos-socks-loopback-tls-before-guard.json`: current rejected the certificate,
but no SOCKS route occurred, so this was not a proxy pass.

The final code keeps HTTPS loopback rejection before initial requests and
redirects. This remains a functional gap, not completed original parity.
Removing the guard without a proven TLS transport would reintroduce bypass.

For a fixture-only remote hostname, the release Host sends TLS through SOCKS and
rejects the self-signed certificate with zero HTTP origin requests/output bytes.
The proxy records 1550 upstream and 2436 downstream handshake bytes. Evidence:
`macos-socks-remote-tls.json`. This verifies rejection through the tunnel, not
successful trusted HTTPS or every certificate condition.

```sh
python3 scripts/reverse/reuse/run.py --headless \
  --compare-host native/.build/release/NDMHost --compare-size-mib 1 \
  --compare-untrusted-tls --tls-via-socks
```

HLS keeps its existing proxy path and loopback restriction. Native Windows,
macOS 13 execution, trusted public HTTPS, current HTTPS loopback support, and
packaged/installed acceptance remain separate work. The installed Electron app
was not replaced by these tests.


Release update: signed build 2026100503 now passes packaged SOCKS pause/resume
and disconnect QA and is installed with real task preservation verified. See
`MACOS_RELEASE_2026100503.md`. Installed visual inspection still awaits unlock.
