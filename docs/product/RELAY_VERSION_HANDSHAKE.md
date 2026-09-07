# Relay running-version status

The extension worker sends `NDMRelayHello:` followed by JSON containing its executing-code version, protocol `1`, and role `worker` immediately after WebSocket upgrade. This precedes queued downloads but does not wait for a reply. Older hosts may ignore the announcement; downloads remain compatible.

The worker version is a source constant in `bg.js`, checked against the extension manifest and package metadata by runtime tests. Reading a newly replaced manifest from an old worker would falsely claim that the worker had updated. This field is a client report, not cryptographic software attestation.

The host stores valid worker announcements per live connection and clears them on disconnect. Unsupported or malformed announcements never become download messages or verified worker versions. `NDMRelayStatus:` replies with protocol `1` and the expected version from this running app's bundled extension manifest. Missing metadata stays unknown. The development host uses this checkout's extension directory, never a sibling repository.

`getBridgeStatus` includes both the configured and legacy listener's client counts and worker identities. Counts and identities are captured together within each bridge queue. A TCP connection awaiting upgrade, an ordinary popup probe, and a worker that has actually identified itself are distinct states.

The settings page reports unknown versions without declaring the bridge offline. A known old worker, including a mixture of old and new workers, prompts the user to reload the extension from the current app's directory. Extra unclassified probe sockets are not automatically classified as old versions.

## Boundaries and next steps

- No automatic `runtime.reload()` or reload loop is introduced. Merely installing a new `.app` does not prove Chrome has loaded its new extension code.
- This handshake identifies the background worker, not already injected content scripts. Existing web pages may still need refreshing.
- Changing an unpacked extension's source directory can change its Chrome identity and requires an explicit migration. Keep the previous source intact until the new extension is operational.
- A future reload action must record an attempt in durable extension storage, verify a new worker instance after reload, and avoid dropping pending download handoffs. Repeated `onInstalled` events alone are not proof of upgrade.

Validation covers malformed/unsupported announcements, a replaced manifest with an old executing worker, hello-before-download ordering, an older silent host, reconnect, settings state combinations, and a real isolated host's unknown/identified/disconnected lifecycle.
