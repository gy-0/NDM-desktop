# Download workspace polish — September 2026

## Product decisions

- Keep library search, scope and global actions in one compact toolbar. Paused counts belong to the resume action instead of an additional full-height status header.
- Fit columns to the measured list pane on every resize. Preserve relative user preferences with readable minima; disclose time and size progressively, and move status into metadata at compact widths. Header and rows share the same grid. No horizontal overflow.
- Keep the complex liquid background moving between progress snapshots. The authoritative byte count remains the upper bound of the painted progress.
- Use blue/periwinkle accents in the dark and dawn themes. The earlier teal experiment was rejected by the user.
- Add subtle flow and leading-edge highlights inside the filled portion of progress bars. Enable by default, persist the preference under Settings > Downloads, and honor reduced motion. Pause/completion removes the active effect.
- Keep row progress visible alongside hover actions. Name the Inspector close action and support double-click width reset.

## Coverage

| Surface | Evidence |
| --- | --- |
| Library, columns and row actions | `qa-workspace.mjs`: pointer movement, header/row boundaries, keyboard adjustment, reset, visible progress without action overlap, long-list virtualization |
| Background and progress effects | Renderer frame-loop regression; Electron GPU rendering inspected in both themes; switch default, immediate change, reload persistence and reduced-motion behavior |
| Inspector | Named close action, width reset, responsive right split pane without covering the list; real-engine action and adjustment failure tests |
| Add download | `qa-ordinary-file.mjs`: composer keeps binary downloads out of media selection and downloads a deterministic 1 MiB file through the real host |
| Failure recovery | `qa-task-action-failures.mjs`: row, Inspector, keyboard and context-menu errors retain task visibility and allow recovery |
| Settings | `qa-task-adjustment-failures.mjs`: failed bandwidth, connection and schedule updates preserve acknowledged values and re-enable controls; progress-effect preference regression |
| Empty states | Initial snapshot loading, empty library, empty filter, unmatched search, clear/search-all recovery |
| Keyboard and narrow layouts | Modal focus, IME guards, native menu ownership, search focus, range selection, minimum-window Inspector layout |
| Wrong response body | Native integration fixture returns a 23-byte error body despite advertising a 65,536-byte file; download fails with byte-count diagnostics, discards the invalid cache and then resumes from a healthy source with exact-byte verification |

The Movist source additionally interrupted real transfers. An isolated resumed download completed and passed `hdiutil verify`. The original task exposed a corrupted 23-byte prefix retained from its first failed response. The corrupt completed file was moved to Trash and replaced with the verified isolated copy. The engine now discards completed responses with inconsistent lengths before any later resume. Source stability must not be inferred from the UI changes or the successful isolated copy.

## Verification commands

- `npm test`
- `npm run typecheck`
- `npm run build`
- `node scripts/qa-workspace.mjs`
- `node scripts/qa-ordinary-file.mjs`
- `node scripts/qa-task-action-failures.mjs`
- `node scripts/qa-task-adjustment-failures.mjs`
- `npm run test:native` plus the added short-response integration test
- `npm run test:relay`
- `npm run package`, signature and installed-resource verification

Run real-host QA after native compilation and signing have finished; use isolated support directories and ports. Preserve unrelated local changes.

## Final results

- 250 desktop behavior tests passed; typecheck and production renderer build passed.
- 27 workspace UI scenarios passed. Electron rendering and the installed preference switch were inspected separately.
- Real-host ordinary download, task-action failure, adjustment failure and proxy-settings scenarios passed in isolated environments.
- 807 native XCTest cases ran with zero failures (6 platform-dependent skips), plus 11 Swift Testing cases passed.
- Relay contract suite and macOS packaging/signature checks passed.
- The repaired Movist file in Downloads passed DMG verification and matches the verified isolated copy's SHA-256.

## Responsive layout correction

The previous fixed-pixel/horizontal-scroll choice failed the real window review and was replaced. Saved v2 widths are retired; v3 preferences are fitted proportionally to the available pane. Secondary fields progressively move out of the table as space narrows, while details keeps all information available.

- Checked 25 viewport widths from 920 to 1800 px with Inspector closed/open (50 geometries), including 1024 and 1220 px. No table overflow or list/Inspector overlap; 27 UI scenarios passed without renderer errors.
- Layout unit coverage exercises every 7 px from 240 to 2400 px, including extreme stored proportions.
- Inspected installed `/Applications/NDM.app` in the user's dawn theme with the real 3,677-task library. Full-width columns fit; Movist opens in the right split pane with a restrained icon preview.
- Installed app.asar SHA-256: `7b9dc791de5da14b025762d1a8164b73855bb78111fcc2f0cdfb0589fece446e`.
- This verifies the corrected surfaces; it does not claim every screen has completed a comprehensive design review.

### September 8 — neutral completion and stable heading

Removed green success accents across themes. Installation completion uses an 18 px title, 48 px artwork or a solid neutral check, restrained shadow, and two explicit actions; redundant completion detail is hidden. Removed the persistent shortcuts toolbar button; `?` still opens the accessible shortcut dialog. Removed the container rule shrinking the library heading. Automated resize coverage now asserts 20 px at every tested width with and without Inspector. Verified 251 tests, typecheck/build, 30 workspace scenarios, and isolated Electron file-command and installation-journey QA. Light/dark completion screenshots were visually inspected; no real installation was performed for these fixture checks.

### September 10 — workspace feedback round (hover collisions, pane scale, failure grammar)

User feedback from the running app: the details lane mixed ten font sizes and eight radii, the hover actions painted over the row's own status and size values, the top-right control was sort instead of the details toggle, the search field read as a 16px placeholder in a 28px box, tapping a speed preset flickered and only moved after the round trip, and a red-washed panel explained an expired link.

Root causes and repairs:

- **Dead type classes.** `index.css` carried an unlayered `button, input { font: inherit }`, which outranks every Tailwind utility layer. Every `text-*` class on a button or text field was ignored, so those controls inherited whatever size their container happened to have — the search input rendered at 16px and the details pane drifted per container. The duplicate rule is removed (preflight already declares it inside `@layer base`), so declared roles now apply. A whole-document audit of the default workspace found no element left at 16px.
- **Pane drift.** The details pane now uses four roles (18 / 13 / 12.5 / 11.5px) and two radii (control 7 / surface 12), plus one control metric (`h-control` 28px, `h-field` 32px). The "更多" disclosure is the same control as its neighbours.
- **Custom speed.** The four-tier segmented control (with 8.5px unit suffixes) is replaced by presets plus a real field, mirroring Settings › 下载. Tiers paint immediately and the engine acknowledgement still owns the durable value; a refused write rolls back and reports. Out-of-range input is refused before it reaches the engine.
- **Row hover collisions.** Row actions are a fixed 142px overlay at a 12px inset; `coveredTrailingColumns()` now decides which trailing columns that overlay would paint over, and those cells fade on hover instead of sitting under the buttons. Progress keeps its own lower line, so a transferring row never loses it.
- **Toolbar order and search.** The details toggle owns the top-right corner (sort moved inboard) and shows a pressed state; the search field shares the 32px control row and its text is the label role.
- **Failure grammar.** New rule set in `docs/ERROR_STATES.md`: colour is a signal, not a surface. A failure keeps the pane surface, marks severity with one icon, states what happened, then offers recovery. Applies to the details failure block, the install note, the engine/action/filter bands, and the row status. `tests/failurePresentation.test.mjs` asserts the grammar.

Also repaired in the harness (all stale against the in-flight details work, not caused by this pass):

- Column alignment compared a `display:none` header cell with the absolutely positioned progress cell; only in-flow columns are compared now.
- Download settings, the download link row and the per-task limit live behind disclosures; `openDownloadSettings()` opens them deliberately, and the copy-feedback check targets the visible control.
- The narrow-pane Inspector overlays the list on purpose; the resize and narrow-window checks now accept the overlay mode while still asserting the pane stays on screen and the search field stays visible.
- `qa-inspector-resize.mjs` measured the pane before React had committed a pointer-driven resize, so it could read the stylesheet's fallback width; it now waits until the pane renders exactly the width its own control reports.
- `qa-inspector-session.mjs` and `qa-polish.mjs` still used the pre-rename renew label and reached delete/copy fields without opening their disclosures.
- `qa-task-controls.mjs` drove the connection and speed controls before the pane had mounted; the disclosure helper waits for the pane instead of racing it.

Verification:

- `npm test` 298 passed; `npm run typecheck`; `npm run build`.
- `node scripts/qa-workspace.mjs` 37 scenarios passed with no renderer errors (screenshots in `NDM_QA_OUTPUT`: hover actions, toolbar order, per-task limit, failure details in both themes).
- Real app, real engine: `qa-workspace-redesign.mjs` (3,684 synthetic tasks, 1500/1220/1040/760/600 window widths), `qa-task-controls.mjs` (a real 1 MB/s cap held the transfer at 798 KB/s and 跟随全局 resumed it), `qa-task-adjustment-failures.mjs` (a killed host rolled the optimistic tier back while keeping the group enabled and the error associated), `qa-inspector-session.mjs`, `qa-inspector-selection.mjs`, `qa-inspector-resize.mjs`, `qa-polish.mjs`, `qa-zoom.mjs` — all passed with no console errors.
- Screenshots for review: `/tmp/ndm-craft-qa/{18-row-actions,19-toolbar,20-task-limit,21-failure-details,21b-failure-details-dawn}.png` and `/tmp/ndm-task-adjustment-errors.png`.
- Real-window and packaged-app inspection of the details pane remains the release-time check; no download, file or engine behavior was changed by this pass.

### September 12 — file dragging, settings hierarchy and continuous motion

- Completed list rows initiate Electron native file dragging; a selected group supplies its completed, existing files. The original files are retained. Main-process validation rejects missing files and directories, and failures use the existing three-second notice. Native host artwork is reused for drag images; a redundant Electron icon lookup caused a startup crash in the fixture and was removed.
- Settings navigation and Return use 16 px type, controls use 14 px, and supporting text uses 13 px. Download settings are grouped as 保存与文件 / 下载性能 / 下载记录. Progress appearance lives under 外观与声音; browser login choices live under 浏览器扩展. Bridge addresses and extension paths are inside 连接诊断. Settings clicks use the enabled press cue. Page changes reset scrolling and fade in over 160 ms with 4 px of travel.
- Inspector content retains its final width during the 200 ms outer reveal. Removing the competing minimum width prevents the late stop. URLs fill the line before wrapping instead of preferring a hyphen. Selected light-theme rows use a blue-gray wash, fine edge, inset highlight and subtle shadow. Mouse-selected rows no longer keep quick actions visible after hover ends; keyboard focus remains operable.
- Dawn transfer colors derive from the night blue/slate palette. A critically damped progress response carries velocity between 4 Hz snapshots, remains monotonic and never exceeds received bytes. Theme-specific shader tuning explicitly resets when switching themes.
- Checks: 301 tests, TypeScript, renderer/main build, in-repository native host build, and signed packaged-app QA passed. `qa-interaction-polish.mjs` covers 740/1400 px settings layouts, readable navigation, scroll reset, audible feedback generation, URL line geometry, hover exit, monotonic pane opening, single/multiple native drag payloads, and transient missing-file errors. Light/dark screenshots were inspected.
- `qa-transfer-motion.mjs` passed in dawn and walnut: approximately 119–120 fps, four distinct native GPU captures, continuous progress samples, pause/resume continuity and active-task handoff. Its obsolete pre-redesign row ETA and inspector-summary expectations were updated; numerical motion criteria remain intact.
- Verification boundary: native drag arguments were intercepted for automated assertions. Computer-use gestures also initiated native file dragging, but the independent receiving app did not produce a receipt; delivery after release in another app remains unverified. All fixtures use isolated support directories and ports.

### September 12 — keep outbound file drags quiet

- A native file drag can re-enter the originating renderer as a `Files` payload. The workspace previously displayed its inbound-link veil even when that payload was already classified as unsupported. The receiver now activates only for link-bearing types; local files passing over or dropped back onto NDM leave the workspace unchanged. Drag end also clears receiver state.
- The new interaction regression failed against the previous build with the unwanted veil visible, then passed after the fix. It covers file payloads over the workspace, selected row and inspector, quiet drop-back, retained selection and an unchanged task count. The blue-gray selection treatment is preserved.
- `qa-drop-entry.mjs` verifies that an external local file is ignored and an incoming HTTP link still opens the confirmation composer. Its isolated native engine completed the 6 MB fixture, reported the expected byte count and removed the fixture task with no renderer errors.
- Checks: 301 tests, TypeScript and production build passed. Native drag arguments remain intercepted for automated checks; this regression verifies receiver behavior, not delivery to another application.
