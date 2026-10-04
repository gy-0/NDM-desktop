# Original Windows engine intake investigation

Static research only. No Windows execution or product integration is implied.
Input: the user's NeatDM.exe extracted from the installer, SHA-256
`60b06db7dfeb6fffb1be82f8ad059d61bdb1b1a3889439b56eaac162e64c0f37`.

Against the existing analyzed Ghidra project, run:

```sh
analyzeHeadless /tmp/ndm-original-windows-20261004/project NeatWindows \
  -process NeatDM.exe -noanalysis -readOnly \
  -scriptPath scripts/reverse/reuse/windows \
  -postScript TraceWindowsReuse.java /tmp/ndm-original-windows-20261004/reuse
```

The script exports string references, intake candidates and instructions using
message 0x40e. Decompiled output stays outside the repository. Function addresses
are specific to this exact binary. Imported types/calling conventions are still
inferred; do not call candidates based only on pseudocode.

Verified static path:

- `004e25c0`: NeatWebSocketListener, port 0x2717 (10007), 127.0.0.1.
- `004e1400` / `004e0eb0`: handshake parsing/reply, neatextension.v1.
- `004e0c20` -> `004e1990` -> `004e1c80`: receive/frame/body processing.
- `004e1c80`, call near `004e1f5c`: allocated request buffer and byte length are
  passed through PostMessageW with message 0x40e to the main-window handle.

0x40e is an internal pointer-bearing message, not a proven external IPC API.
Do not send pointers from another process or assume Windows will marshal them.
The owner/freeing path and target window procedure still need tracing. Pause,
resume, persistent IDs, authentication and hidden-window behavior are not yet
verified. Local Parallels currently reports its Windows 11 entry as invalid;
no usable Windows runtime was identified in this investigation.

Additional static control path (same pinned x86 binary):

- NeatDownloadWindow vtable 0x566240, slot +0x80 -> 0x4fbb50.
- Existing engine at window+0x468: engine slot +4 -> 0x40bef0 -> slot +0x10
  -> 0x4c1290 -> 0x4be960(engine, 3), the Paused state.
- Absent engine: window slot +0x94 -> 0x4f8c10, constructs/configures an engine
  and starts a thread.
- Engine notifications use 0x40c/0x40d with heap pointers via 0x4c2e90.

These are static, version-specific candidates. A state write is not proof that
writers have stopped. No runtime controller or external pointer-bearing message
sender is supplied. Receiver ownership and actual lifecycle tests remain open.
