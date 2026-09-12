# Relay browser session wire verification

The real Chrome extension preserves the initiating browser session when a download reaches the bridge. A newly anonymous handoff has its own token and an empty cookie jar, so the same URL cannot inherit the previous handoff's authorization. Refresh requests reread the original cookie store after a service worker restart.

## Evidence

Run with `node scripts/qa-relay-session-wire.mjs`. It launches installed Chrome in a disposable profile and loads the current extension through Chrome's extension debugging protocol. `NDM_QA_BROWSER_PATH` may point to another compatible Chrome executable. The extension copy uses an ephemeral loopback bridge port; no production application or browser profile is connected.

[Recorded result](assets/2026-09-12-relay-session/session-wire-report.json): all seven scenarios passed in Chrome 152.0.7977.83 with Relay 1.4.13.

| Scenario | Observed result |
| --- | --- |
| Authenticated ordinary attachment | The real HTTP request succeeds with eligible root and HttpOnly path cookies. The bridge receives the same session; the page cannot read the HttpOnly cookie. |
| Native video action | The injected YouTube-style button sends through the content script and worker. Wire fields 13, 14, and 15 contain the browser, scoped Netscape jar, and opaque token. Domain, host-only, path, Secure, and HttpOnly semantics survive. |
| Cookie rotation | A bridge refresh request returns the cookie value currently in Chrome, rather than the original handoff value. |
| Same URL after sign-out | A second click produces a different token, an empty jar, and no previous Cookie or Authorization header. Unrelated cookies remain present in the browser during this check. |
| Refresh of the old token after sign-out | Refresh returns an empty jar; the previous authorization is not replayed. |
| Actual service worker stop/start | Chrome stops and restarts the worker. A marker in the old JavaScript global disappears; two routing entries recover from `chrome.storage.session`. After the originating tab navigates to another domain, both tokens still reread the original cookie store and receive updated cookies for the original video URL. |
| Invalid refresh identity | A different domain, a different URL path, and an unknown token receive no session response. A subsequent valid response acts as a barrier on the ordered socket, catching late incorrect responses. |

The stored registry contains only identifiers, expiry, and browser routing fields. Reports include cookie names and scope metadata, but no cookie values, encoded jars, or session token values. Temporary profiles, extension copies, and attachment files are removed after the run.

## Review notes

The session identity is an opaque token bound to a normalized URL and the original store/partition context. Navigating the original tab elsewhere does not redirect later cookie collection. Storage recovery is tested by stopping the worker rather than reloading the extension: extension reload has different `storage.session` semantics and would not test routine worker suspension.

The receiver validates wire data with synthetic cookies and acknowledges ordinary handoffs. The YouTube page is a routed DOM fixture; no real YouTube account is involved. This proves browser collection, content-script handoff, worker recovery, and bridge serialization. It does not prove native cookie import, extractor authorization, real-site availability, incognito-store behavior, or a completed media file. Those remain separate end-to-end checks.
