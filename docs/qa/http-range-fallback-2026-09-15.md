# HTTP Range rejection recovery — 2026-09-15

## Confirmed failure

While the supplied CDN URL was valid, HEAD returned HTTP 200, PDF content type,
a strong ETag, and a length of 3,413,896 bytes. GET with `Range: bytes=0-0`
returned HTTP 416; ordinary GET returned HTTP 200 with the same file metadata.
The latter was a bounded metadata check, not a completed book download.

Six existing tasks on that CDN recorded `#diag:rangeNotSupported` with zero
durable bytes. The old engine handled ignored Range (HTTP 200) with a clean
GET, but treated rejected Range (HTTP 416) as terminal. HEAD metadata had
optimistically enabled segmentation.

## Change

- An initial Range 416 with no downloaded bytes gets one clean GET without
  Range or If-Range. This also works after HEAD is rejected and through redirects.
- Existing empty offset allocations are retired through validated ownership
  receipts, allowing retry. Saved nonzero progress and mid-transfer 416 remain
  protected; tail-split recovery keeps its existing ownership rules.
- Captured browser Range/If-Range cannot override engine-owned byte boundaries
  or reappear in a full request.
- Normal ranged downloads retain the requested connection limit. Authentication,
  expired-link and server failures are not treated as Range capability failures.
- No domain-specific rules, cookies, signed links, or user records are added to code.

## Large library startup repair

The first installed build exposed an existing quadratic query path: each row in
a Host snapshot called `progress`, which loaded and decoded the entire task
ledger again. A process sample on the 3,723-row library confirmed this path at
99% CPU. Startup cleanup also repeated the same full-library lookup.

The store now reads a task by primary key, using the existing decoder and an
additive index for ordered per-task headers. Cleanup retains its lifecycle lock,
current-state revalidation and ownership checks. Seven focused store tests pass.
An isolated release Host with 3,723 synthetic tasks and 29,784 synthetic headers
returned three complete lists in 130, 120 and 117 ms; all owned state was removed.

## Validation

Built from main `97c5495` plus only these repairs in an isolated detached checkout.
Unrelated Douyin changes in the working checkout are excluded from the package.

| Check | Result |
| --- | --- |
| Before-fix regression | Two new tests fail on the old engine |
| Focused native suites | 95 passed |
| Complete native suite | 1,203 XCTest, 24 skipped, zero failures; 11 Swift Testing passed |
| Desktop suite | 633 passed, 8 skipped, zero failures |
| TypeScript / renderer build | Passed |
| Release Host direct HEAD → 416 | Complete, exactly one rejected Range and one plain GET |
| Release Host HEAD 405 → probe 416 | Complete, exactly one rejected Range and one plain GET |
| Release Host cross-origin redirect → 416 | Complete, exactly one rejected Range and one plain GET |
| Release Host normal 206 | Complete; 14 overlapping Range response bodies observed |
| Release Host 403 / 410 | Fail once with the respective expired-link diagnostic |
| Delivered fixture integrity | 3,413,896 bytes; SHA-256 `b3aef50ada66dcefec0977ccf56b4afd11d1b668c3d5753d5d5051cb181caa55` |
| Isolated Host cleanup | All fixture tasks and owned state removed; processes and listener stopped |

Reproduce the local Host matrix with
`node scripts/qa-http-range-fallback.mjs`. Use `NDM_QA_HOST_PATH` to select the
installed binary and `--expect-broken` to assert the old failure behavior.

Browser site-safety policy subsequently blocked the domain. No further site
requests or workarounds were attempted after that block. Live-site post-fix
file delivery is therefore not claimed. The original signed URL's stated
expiry has passed; a fresh site-issued link is needed for a new live attempt.

## Package and application evidence

The normal package command completed native and renderer builds but stalled
while fetching Electron. Packaging was completed using the already installed
Electron 43.4.0 distribution via `electron-builder --mac --dir
-c.electronDist=/Users/gaoyuan/NDM-desktop/node_modules/electron/dist`, followed by
`scripts/sign-macos-bundle.mjs`. Both the application and Host pass strict stable
Apple signature verification. No signing or runtime security checks were disabled.

The signed packaged application showed the 3,413,896-byte fixture as complete.
Its Inspector SHA-256 calculation returned a match to the expected digest. The
fixture was created through the isolated Host RPC; manual Composer submission
is not claimed. The fixture task/file were removed and the isolated app and
fixture listeners were stopped.

Installed build **2026091502** passed deployment health checks and the real
application displayed all **3,723** original tasks with no active or queued
transfers. The installed Host returned the complete list in **193 ms**. All
original task fields, request headers, saved authentication rows, queue
preferences and creation/handoff receipts matched the pre-install SQLite
backup exactly. The previous app bundle and a restricted local database backup
were retained.

Installed and packaged hashes match:

- `app.asar`: `9c5794e7b411b619144526aacca46e08def52272bfbdaf4e2f91c1af00ae132a`
- Signed `NDMHost`: `6bb65fd4e1d3087f41e91ab1b4a43941fcdaf3fad76025d57a2dfa354359df24`

The complete final native suite was rerun after the store repair: 625 engine,
554 core and 24 bridge XCTest cases (24 skipped, zero failures), plus 11 Swift
Testing cases. The final release Host also repeated all six HTTP fixtures.
This release was validated on macOS; Windows runtime validation is not claimed.
