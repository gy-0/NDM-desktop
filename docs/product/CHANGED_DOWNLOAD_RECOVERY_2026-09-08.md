# Changed download recovery — build 2026090821

A v2 checkpoint that cannot be safely resumed previously fell through to the generic diagnostic, exposing `NDMEngine.OffsetDownloadStorage.Failure error 1` and incorrectly promising to keep partial data when offering a restart. The engine correctly refused unsafe byte joining; its recovery presentation was wrong.

The new persisted `downloadRecordChanged` diagnostic explains in Chinese and English that the source file or local download record changed and recommends downloading again. It intentionally does not infer a remote change from every local ownership mismatch. Only the two typed representation/ownership errors map to it; disk-full and unrelated storage failures retain their own classifications. No storage ownership check or automatic cleanup policy changed.

The Inspector now presents failure information directly below the filename, before artwork, links and tuning controls. Failed-task Enter/double-click follow the same restart action as the retry button; the redundant context-menu Continue entry is removed for failures. Paused/incomplete tasks still use resume, and bulk resume semantics are unchanged. Restart can discard verified owned old partial data; this diagnostic makes no promise to retain it. If ownership verification prevents cleanup, restart still fails safely.

## Evidence

- The real Electron fixture `scripts/qa-changed-download-recovery.mjs` initially reproduced the raw internal error using the old release Host (`/tmp/ndm-record-recovery-live.log`).
- The fixture creates an isolated support directory and local HTTP server, downloads a prefix, pauses, verifies a v2 receipt with durable bytes, changes the ETag and all payload bytes without changing length, resumes into the expected error, checks the visible diagnostic and context menu, then triggers recovery through the actual UI.
- Final signed-package runs exercise button, Enter and double-click independently. Each completes the same task ID with SHA-256 `38cb8731097a991e42ad53ad1e83e530ff77e4d75fc6751b10d51b07de29f707`, matching the full replacement payload. The script checks the failure card is in the initial viewport and removes its own download through the isolated Host. Logs: `/tmp/ndm-record-recovery-packaged-{button,enter,double}.log`.
- Native regression: 942 XCTest cases, 7 environment skips, zero failures; 11 Swift Testing cases also pass (`/tmp/ndm-record-recovery-native.log`). UI: 288 tests, typecheck and build pass. Stable-signed package built successfully.

This is a local controlled representation-change test, not a claim of every site's compatibility or power-loss durability. UI snapshots also exposed the previous below-the-fold error card, which was moved and rechecked in the final package.
