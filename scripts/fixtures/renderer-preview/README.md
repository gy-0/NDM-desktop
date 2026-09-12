# Renderer fixture

Browser QA for the real renderer. It does not start Electron, the Swift host, or real downloads.

```sh
node scripts/qa-renderer-preview.mjs --port 5173
```

Open `http://127.0.0.1:5173/scripts/fixtures/renderer-preview/index.html`. Its visible controls configure an iframe of the actual App. The request log below the iframe shows probes, storage checks, draft revisions, and the exact creation options submitted by the UI.

To build static files for a separate HTTP server:

```sh
node scripts/qa-renderer-preview.mjs --build
```

Serve `out/renderer-preview` and open `/scripts/fixtures/renderer-preview/index.html`. Rebuild after changing production source if using static output.

Query parameters:

| Parameter | Values |
| --- | --- |
| `view` | `composer` (opens via real `openMediaComposer` event), `main` |
| `theme` | `dawn`, `walnut`, `noon` |
| `width`, `height` | iframe dimensions in controls page |
| `subtitles` | `none`, `available` |
| `formats` | `standard` (6), `extended` (10, with 144p as the ninth option) |
| `probe` | `success`, `recover` (first request fails), `fail`, `session` |
| `storage` | `comfortable`, `tight`, `insufficient` |
| `tasks` | `sample`, `empty` |
| `title`, `url` | optional media fixture strings |
| `traffic` | `0` hides the simulated macOS window buttons |

The draft bridge implements the renderer's version/revision protocol using the isolated `ndm.qa.composer-draft` localStorage key. It does not exercise encrypted native persistence. “清空 QA 草稿” resets only that fixture key.

Traffic lights are a visible geometry fixture at the current native origin `(16, 18)`, not native controls. The bridge reports zoom 1 and reads the browser's real fullscreen state. Native macOS traffic-light placement, fullscreen transitions, and Electron zoom still need native QA.

The fixture supports repeatable, isolated real-Chrome interaction checks through `node scripts/qa-composer-pr4.mjs`. Set `NDM_COMPOSER_QA_URL` to the preview origin and `NDM_COMPOSER_QA_OUTPUT` to an artifact directory. The suite exercises the real renderer with six scenarios across both themes, the native minimum window dimensions (720 × 600), extended qualities, subtitles, both containers, and probe retry. It saves screenshots, accessibility snapshots, geometry and the fixture's submitted request payloads. Engine replies remain simulated.

When `node_modules` is symlinked outside a worktree, use the production preview build above and serve `out/renderer-preview` from a static server: Vite's development filesystem allow list may otherwise block dependency font files. The QA suite fails on browser errors, including missing fonts, rather than accepting fallback-font screenshots.

Keep this directory together with `scripts/qa-renderer-preview.mjs` if retaining the fixture; generated `out/renderer-preview` is ignored and should not be committed.
