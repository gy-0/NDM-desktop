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

## Repair and validation

The independent verifier reproduced invalid encoded-target HEAD signatures in installed build 2026090807 (`/tmp/ndm-digest-host-installed07.log`). The fixture treats an initial Basic header followed by a Digest challenge as normal negotiation; it independently validates actual Digest responses using Node crypto, rather than accepting any second request.

The repair separates origin and proxy challenge state and generates each header from the actual request. MD5 and SHA-256 are supported for auth qop and the legacy no-qop form; unsupported algorithms and auth-int-only challenges fail explicitly. Signature inputs and proxy request-target forms follow [RFC 7616](https://www.rfc-editor.org/rfc/rfc7616.html). This is not a claim of complete RFC coverage.

A strict HTTP forward-proxy fixture also exposed URLSession transparently retrying a request with an already consumed proxy nonce count when the origin challenges it. Basic/Digest HTTP challenges are now returned to the engine for a newly signed request; TLS, client certificates and connection-bound NTLM retain default handling. HTTPS CONNECT Digest remains unsupported by the manual path.

Current independent real-host QA (`scripts/qa-digest-host.mjs`) passes MD5 and SHA-256 authenticated HEAD plus at least four Range requests, preserving encoded path/query and matching the final 4 MiB random payload SHA-256. Native proxy/nonce-refresh fixtures pass as well. The 19 focused checks pass, including the existing lease retry tests. A two-server fixture exercises authenticated redirects into Basic and Digest challenges during HEAD and Range GET: the second origin receives no Authorization and the engine returns the boundary rejection. Full native regression passes: 863 XCTest cases (6 environment skips) plus 11 Swift Testing cases, no failures. Signed-package validation and deployment remain pending at this point; do not infer deployment from development-host success.
