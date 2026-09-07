# Download workspace regression QA

The workspace uses the existing NDM theme tokens, Lucide icons and Base UI dependency. No new component package, font, CDN request or lockfile change is required.

## Behavior protected

- Search is an AND of normalized words across filename, title, source, source URL, captured page URL and collection title. Status/category scope still applies. Search results never reserve a hidden Hero row.
- Paused, queued, completed and failed filters are list views. A previously paused spotlight cannot disappear into a Hero that is not rendered.
- Range selection is anchored by task ID, not index. Shift arrows can grow, shrink and cross the anchor; selecting all includes the visible Hero.
- Batch pause/resume preserves the requested operation even if a live snapshot changes a row while an earlier request is pending. No-op rows are not toggled in the opposite direction. Engine acknowledgements and partial-failure reporting remain required.
- Shell task shortcuts do not run while modal surfaces, settings or menus own input, or during IME composition. Native controls retain their default keyboard actions. Cmd/Ctrl+F focuses search; Escape clears the query before leaving the field.
- Removal confirmation uses Base UI AlertDialog. Focus starts at Cancel, stays in the dialog, and returns to the previous control (or search if the control was removed). Failure keeps the task and both retry choices. In-flight dismissal is blocked and the chosen operation supplies the busy label.
- The sort menu and shortcut dialog use Base UI focus/dismissal behavior with local NDM styling. Platform names and modifiers reflect the preload platform.

## Commands

```
npm test
npm run typecheck
npm run test:relay
npm run build
npx playwright install --with-deps chromium
node scripts/qa-workspace.mjs
```

`NDM_QA_OUTPUT` selects the screenshot/report directory (default: an isolated system temporary directory). `NDM_QA_BROWSER` can select an already installed compatible Chromium executable. `--capture-only` captures the default workspace without running the interaction suite.

The browser script serves **the real built renderer** and injects a deterministic preload/engine fixture. It cannot touch the user's filesystem, production host, running downloads or browser credentials. Screenshots cover the dashboard, search recovery, sorting, multi-selection, modal confirmation/failure, narrow Inspector layout, light theme and Windows shortcut labels. Linux CI runs it after the desktop build and uploads the report/screenshots even on failure.

This is renderer regression coverage, **not** packaged Electron QA or macOS/Windows download end-to-end validation. Native tests and release compilation remain separate CI checks. No native engine, segment ownership, storage, resume, bridge protocol or installer behavior is changed by this workspace PR.
