#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
DEST="${NDM_TOOL_OUTPUT_DIR:-$ROOT/native/Vendor/Tools}"
LICENSES="$DEST/Licenses"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ndm-media-tools.XXXXXX")"
# These paths are created by mktemp in this script; use the system binary so a
# user-installed Trash-first `rm` shim cannot break deterministic cleanup.
trap '/bin/rm -rf -- "$WORK"' EXIT

YTDLP_VERSION="${YTDLP_VERSION:-2026.07.04}"
DENO_VERSION="${DENO_VERSION:-2.9.3}"
FFMPEG_VERSION="${FFMPEG_VERSION:-8.1.2}"
MINIMUM_MACOS="${NDM_MINIMUM_MACOS:-13.0}"
FFMPEG_SIGNING_FINGERPRINT="FCF986EA15E6E293A5644F10B4322F04D67658D8"

[[ "$MINIMUM_MACOS" == <->(|.<->)(|.<->) ]] \
  || { print -u2 "Invalid NDM_MINIMUM_MACOS: $MINIMUM_MACOS"; exit 1; }

arch="$(uname -m)"
case "$arch" in
  arm64) deno_arch="aarch64" ;;
  x86_64) deno_arch="x86_64" ;;
  *) print -u2 "Unsupported Mac architecture: $arch"; exit 1 ;;
esac

mkdir -p "$DEST" "$LICENSES"

print "Preparing official yt-dlp $YTDLP_VERSION (unpackaged macOS runtime)…"
ytdlp_base="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"
# The onefile `yt-dlp_macos` re-extracts and re-scans on every launch (~25s).
# The unpackaged zip keeps Python next to the launcher so later launches are
# ~0.2s after Gatekeeper's one-time assessment.
curl -fL "$ytdlp_base/yt-dlp_macos.zip" -o "$WORK/yt-dlp.zip"
curl -fL "$ytdlp_base/SHA2-256SUMS" -o "$WORK/yt-dlp-sums"
ytdlp_sha="$(awk '$2 == "yt-dlp_macos.zip" {print $1}' "$WORK/yt-dlp-sums")"
[[ -n "$ytdlp_sha" ]] || { print -u2 "yt-dlp checksum missing"; exit 1; }
[[ "$(shasum -a 256 "$WORK/yt-dlp.zip" | awk '{print $1}')" == "$ytdlp_sha" ]] \
  || { print -u2 "yt-dlp checksum mismatch"; exit 1; }
unzip -q "$WORK/yt-dlp.zip" -d "$WORK/yt-dlp-onedir"
[[ -x "$WORK/yt-dlp-onedir/yt-dlp_macos" && -d "$WORK/yt-dlp-onedir/_internal" ]] \
  || { print -u2 "yt-dlp zip is missing the unpackaged runtime"; exit 1; }
curl -fL "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$YTDLP_VERSION/LICENSE" \
  -o "$LICENSES/yt-dlp-Unlicense.txt"
curl -fL "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$YTDLP_VERSION/THIRD_PARTY_LICENSES.txt" \
  -o "$LICENSES/yt-dlp-third-party.txt"

print "Preparing official Deno $DENO_VERSION…"
deno_asset="deno-${deno_arch}-apple-darwin.zip"
deno_base="https://github.com/denoland/deno/releases/download/v$DENO_VERSION"
curl -fL "$deno_base/$deno_asset" -o "$WORK/deno.zip"
curl -fL "$deno_base/$deno_asset.sha256sum" -o "$WORK/deno.sha256sum"
deno_sha="$(awk '{print $1}' "$WORK/deno.sha256sum")"
[[ "$(shasum -a 256 "$WORK/deno.zip" | awk '{print $1}')" == "$deno_sha" ]] \
  || { print -u2 "Deno checksum mismatch"; exit 1; }
unzip -q -j "$WORK/deno.zip" deno -d "$WORK/deno-unpacked"
curl -fL "https://raw.githubusercontent.com/denoland/deno/v$DENO_VERSION/LICENSE.md" \
  -o "$LICENSES/deno-MIT.txt"

print "Building dependency-free FFmpeg $FFMPEG_VERSION from signed source…"
ffmpeg_base="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
curl -fL "$ffmpeg_base" -o "$WORK/ffmpeg.tar.xz"
curl -fL "$ffmpeg_base.asc" -o "$WORK/ffmpeg.tar.xz.asc"
curl -fL "https://ffmpeg.org/ffmpeg-devel.asc" -o "$WORK/ffmpeg-devel.asc"
mkdir -m 700 "$WORK/gnupg"
GNUPGHOME="$WORK/gnupg" gpg --batch --import "$WORK/ffmpeg-devel.asc" >/dev/null 2>&1
fingerprints="$(GNUPGHOME="$WORK/gnupg" gpg --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" {print $10}')"
print "$fingerprints" | grep -qx "$FFMPEG_SIGNING_FINGERPRINT" \
  || { print -u2 "Unexpected FFmpeg signing key"; exit 1; }
GNUPGHOME="$WORK/gnupg" gpg --batch --verify "$WORK/ffmpeg.tar.xz.asc" "$WORK/ffmpeg.tar.xz"
mkdir "$WORK/ffmpeg-source"
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK/ffmpeg-source" --strip-components=1
(
  cd "$WORK/ffmpeg-source"
  export MACOSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS"
  ./configure \
    --prefix="$WORK/ffmpeg-install" \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-shared \
    --enable-static \
    --disable-autodetect \
    --extra-cflags="-mmacosx-version-min=$MINIMUM_MACOS" \
    --extra-ldflags="-mmacosx-version-min=$MINIMUM_MACOS" \
    --enable-audiotoolbox \
    --enable-videotoolbox \
    --enable-securetransport
  make -j"$(sysctl -n hw.logicalcpu)" ffmpeg
)
cp "$WORK/ffmpeg-source/ffmpeg" "$WORK/ffmpeg"
cp "$WORK/ffmpeg-source/COPYING.LGPLv2.1" "$LICENSES/ffmpeg-LGPL-2.1.txt"

rm -rf "$DEST/_internal"
cp -R "$WORK/yt-dlp-onedir/_internal" "$DEST/_internal"
cp "$WORK/yt-dlp-onedir/yt-dlp_macos" "$DEST/yt-dlp"
cp "$WORK/ffmpeg" "$DEST/ffmpeg"
cp "$WORK/deno-unpacked/deno" "$DEST/deno"
chmod 755 "$DEST/yt-dlp" "$DEST/ffmpeg" "$DEST/deno"
# Downloaded zip members carry quarantine; strip it so the first local launch
# is not another 25s Gatekeeper scan of every nested library.
xattr -cr "$DEST/yt-dlp" "$DEST/_internal" 2>/dev/null || true

for tool in yt-dlp ffmpeg deno; do
  # Universal Mach-O files include an extra per-architecture header in otool's
  # output. Only indented dependency rows are dylib paths.
  forbidden="$(otool -L "$DEST/$tool" | awk '/^[[:space:]]+\// {print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
  [[ -z "$forbidden" ]] || { print -u2 "$tool is not standalone: $forbidden"; exit 1; }
done

for encoder in h264_videotoolbox aac; do
  "$DEST/ffmpeg" -hide_banner -encoders 2>/dev/null \
    | grep -Eq "[[:space:]]${encoder}[[:space:]]" \
    || { print -u2 "ffmpeg is missing required encoder: $encoder"; exit 1; }
done

minimum_versions() {
  vtool -show-build "$1" | awk '
    $1 == "cmd" && $2 == "LC_VERSION_MIN_MACOSX" { block = "legacy"; next }
    $1 == "cmd" && $2 == "LC_BUILD_VERSION" { block = "build"; next }
    block == "legacy" && $1 == "version" { print $2; block = ""; next }
    block == "build" && $1 == "minos" { print $2; block = ""; next }
  '
}

version_at_most() {
  awk -v actual="$1" -v declared="$2" 'BEGIN {
    split(actual, a, "."); split(declared, d, ".")
    for (i = 1; i <= 3; i++) {
      av = (a[i] == "" ? 0 : a[i]) + 0
      dv = (d[i] == "" ? 0 : d[i]) + 0
      if (av < dv) exit 0
      if (av > dv) exit 1
    }
    exit 0
  }'
}

for tool in yt-dlp ffmpeg deno; do
  while IFS= read -r tool_minimum; do
    [[ -z "$tool_minimum" ]] && continue
    version_at_most "$tool_minimum" "$MINIMUM_MACOS" \
      || { print -u2 "$tool requires macOS $tool_minimum, above NDM's $MINIMUM_MACOS minimum"; exit 1; }
  done < <(minimum_versions "$DEST/$tool")
done

print "Prepared zero-setup media toolchain in $DEST"
