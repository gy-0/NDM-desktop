# HRBEU MP4: transport recovery regression

The user's task 3745, `哈尔滨工程大学.mp4`, stopped with `#diag:connectionLost` after persisting 43,815,986 of 63,544,014 bytes (69%). The 32 initial requests and automatic tail splits were recorded; the failed build did not retry a transient URLSession error within the worker. Its task group cancelled sibling workers on the first propagated failure.

## Reference, then implementation

We verified the current installed official Neat ARM64 slice against the archived slice and inspected its actual disconnect/timeout branches. [Instruction evidence](../reference/reverse/verified/TRANSPORT_RECOVERY.md) distinguishes downloading/restart, resumability and timeout. [The actual official App downloaded this same URL](../reference/reverse/verified/HRBEU_TRANSPORT_RUNTIME.md) with 32 configured connections, survived three server-closed-connection events without user intervention and produced the correct complete file. This is not a claim that the two complete engines are equivalent.

NDM now retries only the failed resumable Range worker for explicit URLSession transient transport errors. Ordinary disconnect waits 4.5 seconds, timeout reschedules without an added wait. There is no arbitrary three-attempt exhaustion for an already downloading resumable worker. Every attempt reconstructs its Range from the latest lease boundary and actual stored prefix; healthy workers retain their requests. Pause, cancellation and replanning interrupt the wait. Transport retry does not lower the connection ceiling, and server admission refusals retain their separate policy.

Certificate/authentication errors, representation changes, invalid ranges and file I/O errors are not swallowed. This patch does not claim Neat-equivalent startup probe retries or nonresumable-stream recovery. URLSession's timeout detection also remains distinct from the original socket timer; the verified alignment is the resumable worker's recovery behavior.

## Evidence

- Before the repair, a local server closing TCP after 64 KiB generated real URLSession `-1005` and failed the entire task: `/tmp/ndm-worker-network-red.log`.
- After the repair, four tests cover both legacy and v2 final SHA, 32 initial workers with one interrupted request and 31 preserved original requests, pause during backoff, and three sequential disconnects on one worker followed by pause with retained data: `/tmp/ndm-worker-network-green.log`.
- The release Host downloaded the public HRBEU URL with 32 connections. Three actual `NSURLErrorDomain(-1005)` events on workers 17, 21 and 26 were retried. The task completed, 63,544,014 bytes, SHA-256 `b9ea30651a7ff2cd7bf5e8734b44b5316b59d4897ea4df9063eeb4b957fcef8b`, exactly matching the independently downloaded official Neat output. Release Host SHA-256: `679c08849e78a819aceefadad06975040297022df4a7784f6e5799d6845b3d4a`.
- NDM's observed run was about 80 seconds; the official run about 74 seconds. They were sequential, network/proxy conditions and other load were not controlled, and these are not comparative throughput benchmark results.

NDM isolated evidence: `/tmp/ndm-hrbeu-recovery-qa.log` and `/var/folders/28/7yq61yhd23sb8zz0ynmnsz500000gn/T/ndm-hrbeu-recovery-1ael5vw0/report.json`/`transfer.log`. Generated test database and payload were removed. A reusable site-specific verification entry is `scripts/qa-hrbeu-network-recovery.py`; it must only use an isolated Host and requires the known complete SHA, so a changed upstream file needs separate revalidation.

Full regression: 986 XCTest cases (7 environment skips), plus 11 Swift Testing cases passed; `/tmp/ndm-worker-recovery-full-native.log`.
