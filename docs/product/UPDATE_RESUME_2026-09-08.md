# Updating with active downloads

The user authorized pausing active downloads for an app update rather than waiting for completion. `scripts/deploy-mac.mjs` now stages and verifies the signed package first, records the specific active tasks it pauses, waits for Host pause acknowledgements and writer drain, quits normally, installs and health-checks the new app, then resumes only those tasks. Previously paused tasks stay paused. The previous bundle is permanently removed only after health and selective recovery succeed.

A pause timeout is not a drain acknowledgement. Update aborts instead of force-killing. Installation failure attempts rollback; recovery failure on a healthy new app retains its backup instead of interrupting already-resumed transfers. RPC deadlines are absolute, so unrelated engine broadcasts cannot keep an update hanging indefinitely.

Validation: 17 lifecycle/RPC tests passed (`/tmp/ndm-deploy-tests-final.log`). `scripts/qa-deploy-resume.mjs` exercised the actual isolated Host and persisted offset storage: one active task drained at 262144 bytes, Host exited normally and restarted on the same profile, that task issued GET Range `262144-6291455` and completed with the expected SHA. A separately user-paused task stayed paused without new requests. Report: `/tmp/ndm-deploy-resume-qa.log`. This test does not replace the user's installed app; deployment verification is recorded separately.

The list/pause sequence is not a global Host maintenance lock. State is refreshed immediately before pausing and before quitting; task recovery is scoped to recorded IDs, never resume-all.

Recovery also retains attempted pause IDs before sending the command. If a pause succeeds but its ACK or the subsequent list fails, restoration re-queries those IDs and resumes only tasks then confirmed paused. Tests cover both acknowledgement outcomes and unavailable state reporting.

The final release Host and revised helper also passed the isolated restart test: `/tmp/ndm-build29-resume-qa.log`. Build 2026090829 was installed and launched using this deployment pipeline (`/tmp/ndm-build29-deploy.log`). No tasks were active at the actual swap, so the real update paused no user IDs; active-transfer recovery was proven in the isolated test, not claimed as an observed user-task interruption. Installed Host/asar matched the signed package, Host list was healthy, and this deployment old bundle was permanently removed.
