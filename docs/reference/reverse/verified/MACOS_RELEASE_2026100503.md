# macOS build 2026100503 acceptance and installation

The signed Electron package now includes explicit SOCKS transport for ordinary
HTTP file downloads. It was installed at `/Applications/NDM.app` after isolated
packaged acceptance. HTTPS loopback and HLS proxy limitations documented in
`MACOS_SOCKS_FILE_TRANSPORT_2026-10-05.md` remain open.

## Packaged runtime

Both runs use the package's embedded Host, a synthetic 3,748-record library,
two delayed redirects, an owned SOCKS5 fixture and a 16 MiB synthetic payload.
The app composer, task UI and completion fireworks are exercised. Byte hashes,
HTTP 403 presentation, HTML rejection and no historical-task restart all pass.

| Case | Maximum renderer frame gap | Completion-to-fire | Other evidence |
| --- | ---: | ---: | --- |
| UI pause/resume | 41.7 ms | 12.4 ms | Paused counter stable; resume-to-first-server-body 486 ms; 14 proxy routes |
| Established worker disconnect | 49.9 ms | 11.3 ms | Failed prefix begins repair after 784 ms; 10 proxy routes |

No renderer long tasks or frame gaps over 50 ms were recorded. These measurements
are renderer timing, not proof of pixel presentation on an unlocked desktop.
Raw reports: `core-audit-2026-10-04/macos-packaged-socks-resume.json` and
`macos-packaged-socks-disconnect.json`.

The QA runner adds `NDM_QA_SOCKS=1`. Its Python helper owns only a loopback SOCKS
fixture and writes routes after stdin EOF. The runner waits for helper shutdown
and checks destination ports, SOCKS version and forwarded bytes before retaining
a passing result. It does not alter system proxy settings.

## Build and deployment

`npm run package` compiled successfully but its initial signing step failed in
Electron Framework with a Code Signing subsystem error while only 187 MiB was
free. After deleting hash-verified, stopped-test synthetic payloads, rerunning
the signing script succeeded. Low disk space is the likely cause; the error
itself did not state `ENOSPC`. Payload cleanup manifests retain exact paths,
sizes and hashes; reports/screenshots were preserved.

The installed app had no active or queued transfers. A private before-snapshot
was saved, followed by normal AppKit termination with the exact bundle path and
PID checked; both app and Host exited. Deployment used
`node scripts/deploy-mac.mjs --skip-build --keep-backup`.

All 3,748 task rows retained identical sorted values for `id`, `status`, `url`,
`filename`, `folderPath`, `completedBytes` and `fileSize`. Digest:
`60d60aee28329cd8aa643fadaf2df16dfd48cf465fe780ae0e14c1c0074da3fd`.
Private rows remain mode 0600 outside the repository. Installed asar/Host hashes
match the package, and standalone deep/strict codesign verification passed.
See `core-audit-2026-10-04/macos-installed-2026100503.json`.

The previous app is retained at
`/Applications/.NDM-backup-84db05d8-6526-4351-8d84-3d3e8b34306f.app`.
The installed app launched and answered engine RPC. Computer-use inspection
reported the Mac locked, so actual installed-window/black-screen visual
acceptance remains pending. Browser extension reload is a separate item.

Version metadata regression, QA JavaScript syntax and Python syntax checks pass.
Native production code is unchanged from the prior validated transport commit;
this release increments the build number and adds packaged runtime evidence.
