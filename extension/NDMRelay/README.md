# NDM Relay

NDM Relay is the Chrome companion for NDM. It sends intentional downloads to the
Mac app and turns detected videos into a small, native-looking download control.
It is maintained by Yuan Gao. Its browser identity and local bridge endpoint are
NDM-specific, so it can coexist with the original Neat app and extension.
Required third-party notices remain in `LICENSE` and are not presented as the
current extension author.

## Toolbar popup

- Clicking the toolbar icon opens a compact popup that mirrors the app's
  walnut/dawn design language (dark & light via `prefers-color-scheme`).
- The popup probes the local bridge itself (`ws://127.0.0.1:51873`), so the
  connection dot is always fresh even when the service worker was suspended.
- It shows the current tab's detected-media count with a **显示下载选项**
  action, and a switch for **接管浏览器下载** (download catching).
- UI strings are localized through `_locales` (zh_CN default, en fallback);
  context menus and the action title use the same catalog.
- Relay items queue while NDM is still launching: requests sent before the
  bridge socket opens are flushed in order on connect instead of dropping all
  but the most recent one.
- Toolbar icons are generated from the app's own brand icon (`NDM.icns`), and
  the badge uses the app's copper accent.


## Safer download catching

- Only top-level download navigations are handed to NDM automatically.
- DAT/BIN responses, XHR traffic, hidden frames, and ordinary page subresources
  are not treated as user-requested downloads.
- If a hidden/subresource response still makes Chrome create a suspicious
  DAT/BIN/BLOB/MAP/PART/TMP download, NDM Relay cancels and removes that browser
  download. Explicit top-level opens and context-menu downloads remain allowed.
- A deliberately opened MP4 or attachment still goes to NDM.
- Right-click a link or image and choose **Download with NDM** when
  you explicitly want to send it to the app.

## Clearer video choices

- One clear **Choose quality and download** action is shown first.
- Duplicate qualities are collapsed and raw TS fragments are hidden.
- Other useful formats stay behind an **Other formats** disclosure.
- On X/Twitter, a native-looking **NDM** action is added to each video post.
- On YouTube watch pages, **Download with NDM** sits beside the existing video
  actions instead of floating over the player.
- On current Bilibili video pages, **NDM 下载** is part of the same toolbar row
  as like, coin, favorite, and share. The canonical BV/av page URL is sent to
  the Mac resolver.
- On current TikTok video pages, **Download with NDM** joins the page's action
  section and sends the canonical `@user/video/id` URL.
- Vimeo, Instagram, and Douyin have canonical page adapters and
  conservative inline insertion points. If a site changes its toolbar markup,
  NDM Relay leaves the page untouched instead of falling back to a permanent
  overlay; the generic media panel remains available as a fallback only when
  that in-page inject is missing.
- Once an adapted site's in-page button is present, the legacy floating
  **Choose quality and download** strip (and its NDM count badge) stays hidden
  so it does not compete with the native-looking control. On Bilibili/YouTube
  video URLs the float is never mounted at all (media sniffs during login-heavy
  normal profiles used to fight SPA hydration). Ordinary sites keep the hover
  float; document/installer **Page resources** shelves still appear when real
  files are detected.
- Bilibili injection waits until `window.load`, then watches only the video
  toolbar subtree — never `documentElement` or the whole `body` — so the player
  and comment section can finish hydrating in a normal (non-incognito) profile.
- Both site actions send a canonical page URL with the `media-page` route. The
  Mac app resolves the real video, opens its quality picker, and downloads the
  selected rendition; the raw page HTML is never treated as the file.
- X/Twitter page resolution suppresses raw TS transport responses, including
  large or unnumbered variants that would otherwise look like real choices.

The generic badge appears while the pointer is over detected media, then gets
completely out of the way. The NDM Relay toolbar icon shows a detected-media
count and restores the nearest panel on demand, so hiding the overlay never
makes the controls undiscoverable. Right-click the toolbar icon to pause or
resume ordinary browser download catching.

## Useful page resources

- Embedded PDF, Word, Excel, PowerPoint, CSV, EPUB/MOBI/AZW3, ZIP/RAR/7Z/TAR,
  DMG, and PKG responses appear only in the NDM Relay toolbar popup.
- Each row shows the real filename, type, size when known, and source host.
- Detection never starts a download. The URL is sent to NDM only after the user
  presses **Download**, and that button always uses the row's own URL — never
  the tab's video page.
- Tiny responses (< 1 KB), background `txt` responses even when mislabeled as attachments,
  telemetry hosts such as `data.bilibili.com`, and junk names like `web.txt` are
  excluded so the shelf stays useful.
- Signed/range variants and strong filename/type/size mirrors of the same
  resource are collapsed. JavaScript, JSON,
  images, DAT/BIN traffic, and raw video transport fragments are excluded.
- Page resources never inject a shelf, panel, or persistent pill into the site.
  The toolbar badge announces useful detections; opening Relay reveals the list.
- Direct installers/archives/documents (`.dmg`, `.pdf`, `.zip`, …) captured from
  a video site still download as ordinary files. Only media sniffs and explicit
  video-page actions enter the yt-dlp quality flow.

## Installation

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select this `extension/NDMRelay` directory. Reload the extension after changing
its source files.

## Tests

```sh
npm test          # run all contract tests (node --test tests/*.test.js)
npm run check     # syntax-check every script, then run all tests
```
