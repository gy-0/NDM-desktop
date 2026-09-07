# Repository and decision-source audit — 2026-09-08

This is a read-only audit of the existing worktree, except for this new report. No files were removed, no branch or index was changed, and no commits were created. Counts describe the initial audit snapshot; concurrent work can change them. This report is an inventory and proposal, not a new restriction on product design.

## Git state and safe checkpoint

- Repository: `https://github.com/gy-0/NDM-desktop.git`.
- Branch at inspection: `main`, HEAD `ae1723c0508d5a05ae3c722cec3bb2ea7f169c6e` (`Polish download workspace, search, selection and safe task dialogs (#3)`). A read-only `git ls-remote origin refs/heads/main` returned the same hash. PR #3 is already in main history.
- Initial tracked WIP: 50 files, 1,418 additions and 532 deletions. The changes span product UI, native scheduling, bridge fields, release signing, regression checks and reference notes; they are not one small patch. Untracked files include both legitimate source/tests and generated Python bytecode.
- `git diff --check` passed at inspection. This only checks whitespace; it does not validate behavior or identify which previous author owns each hunk.
- Do not use `git add .`: `scripts/reverse/__pycache__/` and `scripts/reverse/runtime/__pycache__/` are presently untracked and not excluded by `.gitignore`. Keep these generated files local; add an ignore rule in a separate housekeeping edit if desired.

Safe next step: create a `codex/` topic branch from the current HEAD without resetting, stashing or discarding this worktree, then explicitly stage reviewed files/hunks. Do not amend or force-push main. A file being modified does not itself establish ownership of all its changes.

## Proposed review and commit groups

| Group | Main paths | Checks and coupling |
|---|---|---|
| Stable local signing and non-destructive deployment | `scripts/sign-macos-bundle.mjs`, `scripts/deploy-mac.mjs`, `docs/MACOS_SIGNING.md` | Verify built and installed designated requirements, graceful update with active-download refusal, packaged launch and permission reuse. These files are relatively independent of UI work. |
| Native request handoff, bounded server feedback, truthful request counts | `native/Sources/NDMCore/{Models/DownloadProgress.swift,Segments/SegmentFileFormat.swift}`, `native/Sources/NDMEngine/{DownloadEngine.swift,RangeStreamDownloader.swift,DiagnosticClassifier.swift}`, `native/Sources/NDMHost/main.swift`, native regression fixtures/tests, count-field hunks in `src/renderer/src/lib/{types.ts,store.ts}` and `components/Inspector.tsx`, `tests/storeSnapshotBehavior.test.mjs` | Native tests/release build plus TypeScript and snapshot checks; use hunk staging for Inspector/store because they also contain UI work. Include adoption evidence, but do not imply exact behavioral equivalence to Neat. |
| Download workspace, interaction and file-command polish | Remaining renderer changes; `src/main/index.ts`, `src/preload/index.ts`, `vite-env.d.ts`, `scripts/qa-file-commands.mjs`, workspace QA, `tests/{tableLayout,soundPolicy,progressMotion,inspectorControls,inspectorPresentation}.test.mjs`, `THIRD_PARTY.md`, `docs/{DESIGN_CRAFT,UX_POLISH_QA}.md` | Keep copy feedback, sound policy, responsive table, completion/open actions, and their dependencies together unless independently checked. `scripts/qa-workspace.mjs` spans both layout and engine-count presentation. Run the UI checks plus real packaged interaction QA. |
| Reference provenance and corrections | `docs/reference/reverse/specs/{06_SETTINGS,07_BROWSER_PROTOCOL}.md`, `docs/reference/reverse/verified/`, source-only `scripts/reverse/` | Review publishable evidence and paths, exclude bytecode and generated third-party artifacts, preserve the distinction between observations, pseudocode and product source. Harnesses require separately obtained reference samples and are not portable CI tests as-is. |
| Documentation and workflow clarification | `AGENTS.md`, new `docs/product/` reports, optional documentation status index | Inspect existing AGENTS changes explicitly; do not bury workflow changes inside cosmetic commits. Preserve historical notes, link current evidence, and mark hypotheses instead of deleting history. |

If shared files cannot be split without generating an untested intermediate state, use one coherent validated implementation commit for those coupled groups and separate only the independent signing or documentation group. Validate the exact staged tree before publication; tests on a larger worktree alone do not prove each partial commit builds.

## Current implementation ownership

The current repository has already completed the important architectural consolidation:

- `AGENTS.md` explicitly identifies `src/` as Electron/React and Windows engine, `native/` as the maintained macOS engine/host, and `extension/NDMRelay/` as the extension. The old Swift app UI is retired.
- `package.json` uses `swift build --package-path native -c release --product NDMHost`, and packages `native/.build/release/NDMHost`. Packaging does not take a sibling repository binary.
- `src/main/engine.ts:10` defaults development source to `join(app.getAppPath(), 'native')`; lines 156–158 distinguish packaged, local release and local debug host paths. `NDM_SOURCE` is an explicit development override, not a required sibling checkout.
- `README.md` and `docs/NATIVE_MIGRATION.md` describe this consolidation. The migration report records the import baseline and dated verification; its old test counts and ad-hoc signing result are historical, not the current release standard.

Older assistant memory describing two separately maintained product repositories must not override these live facts. The sibling reverse archive is reference material only. There is no architectural reason to restore the retired Swift UI or duplicate current engine changes into the old checkout.

## Documents that can mislead a new contributor

| Document | Finding | Recommended treatment |
|---|---|---|
| `docs/ELECTRON_PARITY_AUDIT.md` | Dated 2026-08-15 but calls `NDM/Sources/NDMApp` the current Swift product; includes gaps subsequently implemented, including per-task connection controls. | Add a prominent historical snapshot label and a link to current code/QA; use its needs as research leads, not the present backlog. |
| `docs/MONETIZATION.md` | Explicitly a proposal awaiting decisions, dated 2026-08-22, but language such as subscription being rejected and fixed free/Pro boundaries sounds final. | Retain as a hypothesis. Revalidate willingness to pay, support costs and competitive claims before pricing; do not implement paywalls from this document alone. `src/renderer/src/lib/license.ts` explicitly says its draft is not a security boundary. |
| `NDM市场调研简报.md` | Dated 2026-08-16. Prices and competitive capability claims are marked “verified” for that time. | Preserve dates and citations; new market research must establish current facts rather than inherit the label. No historical price is revalidated by this audit. |
| `docs/warm-copper-theme.md` | A proposed palette and old test-count checkpoint; it itself says the proposed global accent is not activated. | Mark design exploration, not approved direction. Current user taste, visual inspection, contrast and interaction quality govern a new design; a palette test is not a substitute for design judgment. |
| `docs/BETA_CANDIDATE_2026-08-17.md` | Already clearly dated; hashes, old native commit, ad-hoc signature and earlier tests describe that candidate only. | Keep as release evidence, not current readiness. |
| `docs/reference/reverse/specs/*` | Historical original-app notes include uncertain reconstructions and references only available in the old repository. The latest verified evidence has already corrected settings/protocol assumptions. | Keep as historical reference with a folder-level status entry linking `verified/`; resolve disagreements against binary/runtime evidence and current product tests. |
| `docs/reference/reverse/verified/README.md` | Correctly limits evidence to a particular sample and distinguishes original app from NDM. Its final “没有…改动 NDM 引擎” sentence describes the static-reference stage while a later adoption report contains actual NDM changes. | Clarify the time/stage boundary on the next documentation edit; use `NDM_ENGINE_ADOPTION.md` for subsequent adoption. |
| `docs/UX_POLISH_QA.md` | Contains dated revisions including an explicitly rejected fixed-width layout and later replacement. | Preserve the failed approach as provenance; summarize the latest accepted behavior at the top rather than treating every earlier sentence as a simultaneous requirement. |

A small documentation index with four statuses is sufficient: current architecture, proposed product decisions, dated verification, historical reference. Avoid a large new specification framework. Existing documents should help discover evidence; they should not constrain new ideas solely because an earlier assistant wrote them.

## Reference and distribution hygiene

This is an engineering provenance review, not a legal opinion or a complete license audit.

- `docs/reference/reverse/verified/README.md` calls the results reference material rather than original source, identifies exact executable hashes, and keeps binary/pseudocode/Ghidra outputs outside this repository. `scripts/reverse/README.md` explicitly preserves that separation. Maintain it for public commits and commercial packages; access to a binary or pseudocode is not evidence of a reuse license.
- Currently tracked `native/reverse/fixtures/segments/4125_segments.bin` is a format fixture, not a full executable. Record its provenance and required test purpose rather than automatically treating all files named `reverse` as disposable.
- Source-only research harnesses are useful, but their archived task IDs, paths and dependencies mean they are frozen experiments, not a clean-checkout test guarantee. Do not commit the external original app, exports, analyzer projects or generated downloads by adding entire archive directories.
- `package.json` includes only `out/**/*`, `THIRD_PARTY.md`, package metadata and explicit resources. Reverse docs/tools are not explicitly included as runtime resources. This configuration check is not a fresh inspection of every built archive.
- Existing `.gitignore` correctly excludes generated native tools, build output, and third-party shader extraction; it lacks the Python bytecode exclusions noted above.
- The app identity remains `com.neatdownloadmanager.ndm`, while the reference app is `com.NeatDownloadManager`. Before public commercial distribution, decide an independent brand and identifier strategy. Do not rename the existing identifier casually: current permission identity, settings, upgrades and continuity can depend on it. This is a migration and branding issue, not a reason to break existing installations now.
- `THIRD_PARTY.md` has relevant dependency notices and the new copy-feedback attribution. A commercial release still needs an actual bundled dependency/tool inventory; this audit has not verified every transitive license or upstream claim.
- The manifest/report files disclose local analyst paths such as `/Users/gaoyuan/NDM/reverse/dumps/...`. They are useful locally but should become portable placeholders or separate local provenance before a public research export. Do not remove the sample fingerprints or evidence boundaries while sanitizing paths.

## Outcome

The main problem is an uncheckpointed, mixed worktree and overlapping dated documents, not a need to discard the engine or restart the product. Make a reviewed checkpoint, separate current implementation from hypotheses, and evaluate the next product investment with current customer and runtime evidence. No historical document should silently decide pricing, palette, or download behavior.
