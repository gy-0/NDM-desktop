# Explain actual connection limits without changing the configured ceiling

The original priority audit identified a user-visible ambiguity: requesting many
connections does not make an unverified source safe to splice into ranges. The
maintained native engine already preserves correctness by using a single clean
stream, but its reason was confined to logs. It also exported its live connection
target in the field the Electron inspector labels as the configured ceiling.

The Host now retains the persisted user ceiling in `connections`, alongside
existing `activeRequests` and `requestLimit`. An optional typed
`connectionLimitReason` describes a confirmed range refusal, unknown file size or
unverified resource identity while downloading. The renderer validates known
values, includes this field in snapshot equality, and displays a short explanation
under the connection settings. Unknown reasons and non-downloading states do not
show a stale message. No transport protection, requested limit or file identity
requirement is relaxed.

A response that advertises ranges but lacks a joinable identity already falls
back from the initial open-range response to a clean GET. The original reason
must survive that fallback; the final 200 response alone does not mean the server
refused ranges. The reason is also published during bootstrap body streaming,
not only after a single-stream file has already finished.

## Evidence

- The installed 0505 Host fails the new reason assertion, while completing its
  controlled downloads correctly: it does not publish the missing-identity reason.
- Native real-response tests distinguish safe ranges, missing validator, ignored
  Range and missing Content-Length; all final bytes must match.
- `node scripts/qa-connection-reason.mjs` passed against the real development
  Electron/React UI and isolated fixture events. It checks dynamic reason-only
  updates, unknown values, paused state and actual 280 px inspector resizing.
  The settings group's content and available widths both measured 240 px.
  The captured scrolled screenshot was visually inspected for text/button overlap.
- The existing broader inspector-actions script encounters a stale 16 px sidebar
  assertion (current typography is 14 px). It was not weakened; the new scoped QA
  proves this feature separately. The focused harness supplies mute-audio and
  isolates clipboard access, and exits only its owned synthetic-task app.
- [UI report](core-audit-2026-10-04/connection-limit-ui.json).

Final checks passed: `npm test` (788 passed, 10 skipped), typecheck, renderer
build, full native tests (Engine 747 with 28 skips, Core 563, Bridge 32, plus 11
layout tests), and native release build. The first native run exposed a reason
lost across clean-stream fallback; the final full run passed after correcting it.

`node scripts/qa-startup-throughput-audit.mjs --expect-fixed --expect-connection-reason`
passed with the actual release Host. The no-validator transfer kept configured
ceiling 8 throughout, exposed `unverifiedResource` while downloading, and cleared
the reason at completion. Strong-identity single/eight-connection and delayed-HEAD
cases carried no false limitation. All output bytes matched, no HEAD startup wait
returned, and owned fixture state was cleaned.
[Host report](core-audit-2026-10-04/connection-limit-host.json). This change is not in
installed build 2026100505. It reports the macOS engine's verified limitations;
Windows or other engines that omit the optional field are not assigned a guessed
reason. Actual installed-window visual acceptance still requires an unlocked Mac.
