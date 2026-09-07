# Authentication follow-up audit

Read-only findings against build 2026090804. These are pre-existing manual Digest-path defects, not a claim that every URLSession-managed Digest request fails. The live-parent release deliberately intercepts only Basic; Digest, NTLM, server trust and client certificates retain default challenge handling.

- `probeRemoteWithAuth` retries a HEAD created by `probeRemote`, but `prepareChallengeAuth` signs `request.method` (usually GET).
- The signed URI uses decoded URL path without its query; an encoded download target with parameters is not represented faithfully.
- `applyHeaders` writes cached proxy challenge authorization, then overwrites it with preemptive proxy Basic.
- A whole Digest authorization header is cached and reused for later methods and concurrent requests. The default nonce count is `00000001`; identical nonce/cnonce/count reuse can fail a strict server's replay checks. Actor serialization does not solve this protocol-state issue.
- One `authAuthorization/authIsProxy` pair cannot represent simultaneous independent origin and proxy challenges.
- The core helper hashes with MD5 while echoing the advertised algorithm, and loosely treats an auth-containing qop as auth. Unsupported algorithm/qop must not be represented as supported.

## Bounded repair design

Keep separate origin/proxy challenge state, not cached completed Digest headers. Prepare each actual method, encoded URL target and body before generating authorization; allocate nonce count in the engine actor and reset state only on a changed nonce. Preserve challenge authorization over preemptive Basic. Do not broaden NTLM handling: its transport-level handshake has separate connection requirements.

First build an independent server fixture that parses and verifies every Authorization response against the actual request line, rejects duplicate nonce/cnonce/count, and never simply accepts the second request. Cover HEAD followed by GET, encoded path plus query, concurrent Range requests, nonce refresh, unsupported algorithms and an actual HTTP proxy challenge with separate origin credentials. Verify proxy request-target form from captured requests. Existing once-401-then-200 range tests prove retry ownership, not Digest correctness.

This work remains pending. No additional authentication changes or public compatibility promises are made in this audit.
