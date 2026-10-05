# Active transfer recovery after an isolated Host crash

The existing `qa-offset-host.mjs` exercises the production Host, not merely the
storage backend. Its fixture only recognized closed Range headers and therefore
treated today's first `bytes=0-` request as an unsegmented full response. The
fixture now accepts both open and closed ranges. Before deliberately killing its
own Host, it waits for downloading status and new received bytes beyond the
acknowledged pause checkpoint, rather than assuming a fixed sleep proves activity.

Command: `NDM_QA_HOST_PATH=native/.build/release/NDMHost node scripts/qa-offset-host.mjs`.
The Host contains the startup service retry fix `2c5d185`; its binary hash is in
`core-audit-2026-10-04/macos-active-host-crash.json`.

The strengthened run passed:

- 64 MiB patterned payload, 32 initial Range attempts, peak 32 active requests.
- Pause acknowledged a durable partial; no payload changes followed the ACK.
- Resume received additional bytes in downloading state, then the script sent
  SIGKILL only to the child Host it had spawned in an isolated support directory.
- The on-disk crash receipt retained at least the acknowledged pause checkpoint.
- A new Host using that profile resumed the same task; all restarted ranges began
  after byte zero, and the final SHA-256 matched the independent fixture payload.
- One completed payload remained, no owned partial or legacy segment payloads;
  measured peak allocation was approximately 1.0005 times the 64 MiB output.
- Fixture cleanup removed its payload, support and home directories, retaining
  only the report. No installed app or user download was accessed.

This proves the tested local HTTP Host crash/restart path with a prior checkpoint.
It does not establish power-loss durability, crash at every persistence boundary,
public HTTPS crash behavior, or Electron process/UI restart behavior. Uncheckpointed
bytes may be fetched again; they must not be mistaken for durable progress. No
product storage implementation was changed for this validation.
