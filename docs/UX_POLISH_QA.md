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
