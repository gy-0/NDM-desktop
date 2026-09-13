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

## hash-wasm

https://github.com/Daninet/hash-wasm

NDM uses the unmodified hash-wasm 4.12.0 streaming MD4 API to verify ED2K
content during offline publication on Windows. Source commit:
`373b796205ab55fb4a657374dad6ea589bf75815`. The exact npm archive integrity
is recorded in `package-lock.json`. ED2K chunking and publication ownership
checks are NDM code; the digest implementation is reused from this package.

MIT License

Copyright (c) 2020 Dani Biró

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

Embedded C implementations might use other, similarly permissive licenses.
Check the beginning of the files from the /src directory.

Special thank you to the authors of original C algorithms:
- Alexander Peslyak <solar@openwall.com>
- Aleksey Kravchenko <rhash.admin@gmail.com>
- Colin Percival
- Stephan Brumme <create@stephan-brumme.com>
- Steve Reid <steve@edmweb.com>
- Samuel Neves <sneves@dei.uc.pt>
- Solar Designer <solar@openwall.com>
- Project Nayuki
- ARM Limited
- Yanbo Li dreamfly281@gmail.com, goldboar@163.comYanbo Li
- Mark Adler
- Yann Collet

### Embedded MD4 implementation

This is an OpenSSL-compatible implementation of the RSA Data Security, Inc.
MD4 Message-Digest Algorithm (RFC 1320).

Homepage:
http://openwall.info/wiki/people/solar/software/public-domain-source-code/md4

Author:
Alexander Peslyak, better known as Solar Designer <solar at openwall.com>

This software was written by Alexander Peslyak in 2001.  No copyright is
claimed, and the software is hereby placed in the public domain.
In case this attempt to disclaim copyright and place the software in the
public domain is deemed null and void, then the software is
Copyright (c) 2001 Alexander Peslyak and it is hereby released to the
general public under the following terms:

Redistribution and use in source and binary forms, with or without
modification, are permitted.

There's ABSOLUTELY NO WARRANTY, express or implied.

(This is a heavily cut-down "BSD license".)

This differs from Colin Plumb's older public domain implementation in that
no exactly 32-bit integer data type is required (any 32-bit or wider
unsigned integer data type will do), there's no compile-time endianness
configuration, and the function prototypes match OpenSSL's.  No code from
Colin Plumb's implementation has been reused; this comment merely compares
the properties of the two independent implementations.

The primary goals of this implementation are portability and ease of use.
It is meant to be fast, but not as fast as possible.  Some known
optimizations are not included to reduce source code size and avoid
compile-time configuration.

Modified for hash-wasm by Dani Biró

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
