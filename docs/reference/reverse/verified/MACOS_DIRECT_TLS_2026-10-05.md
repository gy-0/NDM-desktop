# Direct TLS certificate comparison

The original macOS Neat 1.3 accepted a newly generated self-signed localhost
certificate in two isolated runs. The maintained Swift engine rejected it before
any HTTP request in both runs. Preserve the current engine's protection; matching
original behavior here would weaken correctness rather than improve experience.

## Reproduction and evidence

```sh
python3 scripts/reverse/reuse/run.py --headless \
  --compare-host native/.build/release/NDMHost \
  --compare-size-mib 1 --compare-untrusted-tls
```

The fixture generates a fresh RSA certificate with localhost/127.0.0.1 SANs.
Neither engine receives custom trust. System trust and installed applications are
unchanged. A separate Python connection trusts only the fixture certificate and
downloads the exact payload, proving the HTTPS server works. A default-trust
Python connection rejects it with `SSLCertVerificationError`.

Confirmation evidence: `core-audit-2026-10-04/macos-direct-untrusted-tls.json`.

| Engine | Observed result |
| --- | --- |
| Original macOS 1.3 | Complete; four HTTP range requests; exact 1 MiB SHA-256 |
| Current release Swift Host | Error `#diag:sslFailure`; zero HTTP requests, zero completed bytes, empty output directory |

The original source hash remained unchanged, its isolated copy was stopped and
trashed, and the isolated Swift Host stopped. Reports and synthetic payload stay
in the reported temporary directory. The injected original controller contains
no TLS/trust override; it controls intake and observes task state.

The earlier `--tls-upstream --identity-guard` experiment terminates TLS in Python
and presents HTTP to the original engine. It is proxy validation, not direct
original-engine certificate evidence. This new mode exercises HTTPS directly.

The comparison's `passed` means the current engine rejects this certificate and
the fixture controls pass. It does **not** mean the original rejects it. A timeout
is recorded as inconclusive, never as rejection. A completed original output is
hash-checked, so status alone is not treated as proof of successful transfer.

## Boundary

This confirms one self-signed certificate case for the hash-pinned macOS 1.3
original and this release Host. It does not establish all original versions'
certificate policy, hostname/expiry handling, trusted public HTTPS performance,
proxy behavior, Windows behavior, or Electron error presentation. No production
engine change is required by this result. Python syntax and the isolated runtime
comparison passed; native suites were not rerun for QA-only changes.
