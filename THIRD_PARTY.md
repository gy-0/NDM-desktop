# Third-party notices

## Beautiful UI
Copyright (c) 2026 Shane Levine  
https://www.beautifului.dev/  
MIT License. Task-row, sidebar, search, and loading motion were adapted.

## cuelume
https://www.npmjs.com/package/cuelume  
MIT License. Interaction sounds.

## Magic UI
https://magicui.design/
MIT License. Border Beam, Animated Shiny Text, and Confetti components were adapted.

## canvas-confetti
Copyright (c) 2021 James Womack
https://github.com/catdad/canvas-confetti
ISC License. Canvas-based completion and activation celebrations.

## aria2
Copyright (c) 2006, 2019 Tatsuhiro Tsujikawa
https://github.com/aria2/aria2
GPL-2.0-or-later. The unmodified Windows executable is invoked as a separate download helper. Its license is bundled under `Tools/windows/Licenses`.

## yt-dlp
https://github.com/yt-dlp/yt-dlp
The project is released into the public domain under the Unlicense. The standalone Windows executable also contains third-party components; its full third-party notices are bundled under `Tools/windows/Licenses`.

## Base UI

- Package: `@base-ui/react` (already used by the application).
- Source: https://base-ui.com/ · https://github.com/mui/base-ui
- License: MIT, Copyright (c) 2019 Material-UI SAS.
- Workspace integration: accessible sort menu, removal confirmation, and shortcut dialog. Styling is local NDM code. The package's MIT notice remains included with the dependency.

## Opensource UI

https://github.com/bidyut10/opensourceui

Fixed-slot copy feedback adapted from components/buttons/copy-button.tsx. Segmented and inset controls informed surface treatment. NDM retains its own acknowledged operations, tokens and accessibility behavior.

MIT License

Copyright (c) 2026 Bidyut Kundu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Aria2 Next auxiliary engine

https://github.com/AnInsomniacy/aria2-next

NDM uses the unmodified Aria2 Next 2.7.5 executable as a separate local JSON-RPC
helper for additional protocols. It is licensed under GPL-2.0-or-later with the
upstream OpenSSL linking exception, independently of the Motrix MIT application
modules. Source commit: `a9784ea8e36ae83f360ff5157b60c72eb8d96375`.

The bundled `Tools/aria2-next-manifest.json` records the exact platform, upstream
download URL and SHA-256. `Tools/Sources/aria2-next-2.7.5.tar.gz` contains the
corresponding upstream source, dependency sources and build scripts. Complete GPL
text, the linking exception and dependency notices are included under
`Tools/Licenses/aria2-next-2.7.5/` (under `Tools/windows/` on Windows). Sources are
provided without warranty under their original licenses. No engine source is
relicensed as MIT.

## Motrix Next

https://github.com/AnInsomniacy/motrix-next

The aria2 error-code mapping in `src/main/windows/aria2Errors.ts` is adapted from
`src/shared/aria2ErrorCodes.ts`. The backup envelope in `src/shared/settingsBackup.ts`
is adapted from `src/shared/utils/settingsBackup.ts`, and the input-file parser
structure in `src/shared/downloadImport.ts` from `src/shared/utils/batchHelpers.ts`.
Directory-rule extension and first-match semantics in `src/shared/directoryRules.ts`
and its native equivalent are adapted from `src/shared/utils/fileCategory.ts`.
All sources are pinned to commit `83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3`.
NDM replaces the Vue i18n dependency with Chinese recovery guidance, adds redaction
for error details, validates a settings allowlist without credentials, and preserves
task/mirror grouping with strict input validation and creation receipts. This reuse
covers the MIT application code; it does not include the separate Aria2 Next engine.

MIT License

Copyright (c) 2025-present AnInsomniacy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
