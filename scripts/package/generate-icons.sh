#!/usr/bin/env bash
# Regenerates every app/tray icon from the SVG sources in apps/desktop/src-tauri/icons/svg/.
#
#   scripts/package/generate-icons.sh
#
# - App icons (icns/png/ico...) via `pnpm tauri icon` (resvg renderer, works on macOS and Linux).
# - Menu bar icons: 36x36 PNG (18pt @2x). idle/active/attention are template images
#   (black + alpha, macOS tints them for light/dark menu bars); critical is coloured.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/apps/desktop"
ICONS="$APP/src-tauri/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$APP"
pnpm -s tauri icon "$ICONS/svg/app-icon.svg" -o "$ICONS"
# Mobile assets are not used by this desktop-only app.
rm -rf "$ICONS/android" "$ICONS/ios" "$ICONS"/Square*Logo.png "$ICONS/StoreLogo.png"

mkdir -p "$ICONS/tray"
for variant in idle active attention critical; do
  pnpm -s tauri icon "$ICONS/svg/tray-$variant.svg" -o "$TMP/$variant" --png 36 >/dev/null
  cp "$TMP/$variant/36x36.png" "$ICONS/tray/$variant.png"
done
echo "Icons written to $ICONS"
