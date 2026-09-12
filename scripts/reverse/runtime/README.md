# Frozen original-app runtime experiment (2026-09-08)

These are the actual local scripts used for the study described in
`docs/reference/reverse/verified/RUNTIME.md`, not general-purpose CI tests.
They use `/tmp/neat-runtime-audit`, HTTP 42080, and reference IPC 42007.
Do not run them concurrently with another experiment on those ports.

- `server.py`: 128 MiB deterministic file responses; controllable slow path,
  429 above four active handlers, and 96-entry HLS fixtures. Requires `fixture.ts`
  from the archived experiment. `pause` responses deliberately wait one second
  between 64 KiB writes to give a human time to pause.
- `send.py`: correct original-app bridge request, with URL relative to the local
  test server and optional `normal`/`hls` mode. Requires `websockets`. Deliberately
  omits field 3; that field is a second media URL in the reference app.
- `isolate.c`: compiler-built DYLD interposition only remaps local IPC 10007 to
  42007 in a separately signed test copy. Does not modify engine instructions.
- `isolation.sb`: test sandbox policy used with a separate CFFIXED_USER_HOME and
  a distinct bundle identifier. Never launch the installed official app with
  these testing mutations; use a copy and preserve the user-selected source.
- `analyze.py`: analyzes the frozen run, including known task IDs. Requires the
  exact archived data and downloaded outputs, not an arbitrary new task library.
  Output hashes are recorded in the report; generated download payloads are not included in the evidence archive.

Reproduction requires snapshotting the current source app, rechecking its version
and hashes, copying/signing a separate app directly under `/Applications`, and
verifying independent support-directory and port ownership. Launch the copy with
`HOME` and `CFFIXED_USER_HOME` set to the test profile. Pass DYLD_INSERT_LIBRARIES
via `/usr/bin/env` *inside* sandbox-exec. Startup arguments `-MaxConnections 32
-CompletionDialog 2 -AppAutoStart 2` set test configuration without editing the
user's preferences. Pause/resume was deliberately performed via the original UI;
all other download submissions used the WebSocket endpoint.

The completed reference app was stopped and the test bundle moved to Trash.
HTTP handlers and disk sampler were stopped. The source official app and product
NDM app were not replaced. Full raw evidence is archived at the path in RUNTIME.md.
