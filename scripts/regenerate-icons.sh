#!/usr/bin/env bash
#
# regenerate-icons.sh — rebuild the full WorkX icon set from the brand source SVGs.
#
# Source artwork lives in assets/brand/:
#   workx_icon_white.svg        white mark (used for app icon + dark-menu-bar tray)
#   workx_icon_black.svg        black mark (used for light-menu-bar tray)
#   workx_icon_theme_adjust.svg currentColor mark (in-HTML use; not rasterized here)
#
# Outputs:
#   tauri/icons/*                desktop/iOS/Android/Windows app icons
#   tauri/icons/tray-icon*.png   menu-bar tray icons (transparent marks)
#   src/static/AI RepublicLOGO01.png   Chrome extension toolbar/store icon
#
# App-icon treatment: white mark centered on a black squircle (rounded square),
# matching the prior white-on-black launcher look and guaranteeing visibility on
# both light and dark OS chrome.
#
# Usage:   scripts/regenerate-icons.sh
# Requires ImageMagick (`convert` / `identify`).

set -euo pipefail

if ! command -v convert >/dev/null 2>&1; then
  echo "error: ImageMagick (convert) is required" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAND="$REPO_ROOT/assets/brand"
ICONS_DIR="$REPO_ROOT/tauri/icons"
EXT_LOGO="$REPO_ROOT/src/static/AI RepublicLOGO01.png"

WHITE_SVG="$BRAND/workx_icon_white.svg"
BLACK_SVG="$BRAND/workx_icon_black.svg"

for f in "$WHITE_SVG" "$BLACK_SVG"; do
  [[ -f "$f" ]] || { echo "error: missing source $f" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Build the 1024px app-icon master: white mark on a black squircle ──────────
MASTER_SIZE=1024
RADIUS=$((MASTER_SIZE * 22 / 100))   # ~macOS squircle corner radius
MARK_SIZE=$((MASTER_SIZE * 62 / 100)) # mark occupies ~62%, leaving padding

convert -size ${MASTER_SIZE}x${MASTER_SIZE} xc:none -fill '#000000' \
  -draw "roundrectangle 0,0 $((MASTER_SIZE-1)),$((MASTER_SIZE-1)) $RADIUS,$RADIUS" \
  "$TMP/bg.png"
convert -background none "$WHITE_SVG" -resize ${MARK_SIZE}x${MARK_SIZE} "$TMP/mark.png"
convert "$TMP/bg.png" "$TMP/mark.png" -gravity center -composite "PNG32:$TMP/master.png"

MASTER="$TMP/master.png"

# Render an exact NxN square from a source image (SVG or PNG), fit + centered.
render_square() {
  local src="$1" out="$2" size="$3"
  convert -background none "$src" -resize "${size}x${size}" \
    -gravity center -extent "${size}x${size}" "PNG32:$out"
}

echo "Regenerating app icons in tauri/icons/ (white mark on black squircle) ..."
while IFS= read -r -d '' png; do
  rel="${png#"$ICONS_DIR/"}"
  # Tray icons are transparent marks, handled separately below.
  case "$rel" in
    tray-icon.png|tray-icon-dark.png) continue ;;
  esac
  dim="$(identify -format '%w' "$png")"
  render_square "$MASTER" "$png" "$dim"
  printf '  %-46s %sx%s\n' "$rel" "$dim" "$dim"
done < <(find "$ICONS_DIR" -name '*.png' -print0)

# ── Tray icons: transparent monochrome marks (system tints / theme switch) ────
echo "Regenerating tray icons ..."
tray_light="$ICONS_DIR/tray-icon.png"          # light menu bar -> black mark
tray_dark="$ICONS_DIR/tray-icon-dark.png"      # dark menu bar  -> white mark
if [[ -f "$tray_light" ]]; then
  dim="$(identify -format '%w' "$tray_light")"; render_square "$BLACK_SVG" "$tray_light" "$dim"
  printf '  %-46s %sx%s (black)\n' "tray-icon.png" "$dim" "$dim"
fi
if [[ -f "$tray_dark" ]]; then
  dim="$(identify -format '%w' "$tray_dark")"; render_square "$WHITE_SVG" "$tray_dark" "$dim"
  printf '  %-46s %sx%s (white)\n' "tray-icon-dark.png" "$dim" "$dim"
fi

# ── Multi-resolution Windows .ico and macOS .icns from the master ─────────────
echo "Building icon.ico ..."
convert "$MASTER" \
  \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 24x24 \) \
  \( -clone 0 -resize 32x32 \) \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \( -clone 0 -resize 256x256 \) \
  -delete 0 "$ICONS_DIR/icon.ico"

echo "Building icon.icns ..."
convert "$MASTER" -resize 1024x1024 "$ICONS_DIR/icon.icns"

# ── Chrome extension toolbar / store icon (single source, Chrome downscales) ──
if [[ -f "$EXT_LOGO" ]]; then
  render_square "$MASTER" "$EXT_LOGO" 128
  echo "Regenerated extension icon: ${EXT_LOGO#"$REPO_ROOT/"} (128x128)"
fi

echo "Done. Review with: git status && git diff --stat"
