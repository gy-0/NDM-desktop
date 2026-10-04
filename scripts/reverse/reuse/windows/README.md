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
