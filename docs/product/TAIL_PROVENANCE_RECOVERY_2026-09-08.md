# Recovering speculative tails across engine restarts

The reproduced baseline is in [the 416 investigation](TAIL_RESUME_416_INVESTIGATION_2026-09-08.md). This repair preserves the distinction between an automatic speculative tail and an invalid original Range request. It does not infer provenance from a segment ID or simply merge every non-first segment that returns 416.

## Persistence model

`tail-split-provenance.json` is advisory, versioned metadata shared by legacy part files and v2 offset storage. It binds a canonical ordered list of segment IDs/start/end values to the existing representation context hash. It records each child's original donor bounds and whether the server has already disabled further automatic tail stealing. Payload progress is not inferred from this metadata.

There are two entries: the committed layout and a candidate layout. Before a split or rollback changes the actual segment plan, the journal atomically records the candidate while retaining the entry matching the current plan. Reopening selects only the exact layout and representation match. A crash before the plan write therefore uses the previous entry; a crash after it uses the candidate. A fresh transfer explicitly discards old provenance even if its layout coincides. Missing, corrupt or mismatched advisory metadata cannot authorize rollback.

The engine persists split state while holding the donor lease lock, before shortening that lease or launching the child. Rollback retains the existing writer-drain boundary and adjacent-range containment checks. V2 uses its existing continuous-prefix-preserving plan replacement. Legacy speculative child bytes are discarded, not appended to the donor as if they were continuous. Explicit connection replanning clears old tail origins and retains the server-disable flag; this patch does not infer new ancestry for a manually redesigned layout.

Single-stream transfers, including unknown length and empty content with a validator, are excluded from this bounded-range journal. A no-length full response must not be rejected by the metadata's range validation.

## Verification scope

The journal tests model interruption before/after plan commit, repeated failed plan commits, failure writing the journal, exact resource/layout matching, fresh-state replacement and rejection of invalid first-segment provenance. These are state-boundary tests, not a claim of a physical power-cut experiment. Legacy `segments.bin` retains its existing durability scope.

The engine fixture repeats the same nonstandard server refusal that previously failed after pause/reopen, in both storage formats. Success requires a real rollback log and byte-for-byte matching completed file. Initial Range 416 remains fatal. Partial-child coverage also inserts a real 64 KiB prefix in both formats before refusal. Unknown-length and empty single-stream responses remain valid. A legacy plan-commit failure verifies that speculative child bytes are removed before their ID can be released. The 64 MiB fixture starts with 32 segments in both formats, waits for a real automatic split, pauses and reopens, then verifies rollback and the complete output byte for byte.

Full native regression: 964 XCTest cases (7 environment skips), plus 11 Swift Testing cases passed. `scripts/qa-tail-resume-host.mjs` additionally kills a real isolated Host process after the first automatic child request and resumes in a new process; it verifies the refused child, retained donor prefix, rollback and full SHA-256. This process fixture uses four initial connections and v2 storage; the 32-connection and legacy cases are covered by the native engine fixtures above.

Signed build 2026090827 process fixture passed: Host SHA-256 `0ae8838838569887e90697b2a927afb6f93034b2b62c01fd09cb83c26902347b`, 8,388,608-byte output SHA-256 `e0171442a4dbc5a2dcbe5efb94a9b3fec4273039fd32d6c78e311ff5f6c629ce`. It observed one original donor request, a persisted child origin, one refused child after restart, retained donor prefix and actual rollback. Evidence: `/tmp/ndm-tail-provenance-signed-host.log`; full native evidence: `/tmp/ndm-tail-provenance-full-native.log`. Generated fixture payload/database/preferences were removed after termination; the small report remains.
