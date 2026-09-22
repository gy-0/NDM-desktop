These Latin WOFF2 files use the same Instrument Serif, Instrument Sans and IBM Plex Mono families as the desktop app. They were copied from the repository's installed `@fontsource` packages, preserving their original bytes.

`app/layout.tsx` loads them with `next/font/local` so production builds do not need Google Fonts access. License notices are served from `public/licenses/`. The separate Noto Serif SC stylesheet remains a browser-time network resource; this change does not claim fully offline typography.
