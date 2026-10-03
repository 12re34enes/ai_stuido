#!/usr/bin/env bash
# Builds a self-contained "AI Studio.app" (Apple Silicon) with studiod embedded.
#
#   scripts/package/build-macos-app.sh            # release .app, ad-hoc signed
#   scripts/package/build-macos-app.sh --dmg      # also a .dmg
#   scripts/package/build-macos-app.sh --debug    # debug build (faster, devtools enabled)
#   scripts/package/build-macos-app.sh --skip-tauri   # only (re)build the embedded backend
#
# What it does
#   1. Downloads python-build-standalone (CPython 3.13, aarch64-apple-darwin, install_only),
#      verifies its SHA-256 against the release's SHA256SUMS, caches it in scripts/package/.cache/.
#   2. Installs studiod + its locked dependencies (backend/uv.lock, wheels only) into that
#      interpreter and places it at apps/desktop/src-tauri/resources/backend/python/.
#      tauri.conf.json bundles resources/backend/ as Contents/Resources/backend/, where the shell
#      finds <Resources>/backend/python/bin/python3 and runs `python3 -m aistudio install-agent`
#      (LaunchAgent app.aistudio.studiod → `python3 -m aistudio serve`).
#   3. Signs every Mach-O file of the embedded Python, runs `pnpm tauri build`, then signs the app
#      (ad-hoc `codesign --force --deep -s -` by default).
#
# Environment
#   PBS_TAG         python-build-standalone release (default 20261001; "latest" resolves it)
#   PY_VERSION      CPython version inside that release (default 3.13.16)
#   PBS_TRIPLE      default aarch64-apple-darwin (x86_64-unknown-linux-gnu lets CI validate the
#                   payload on Linux together with --skip-tauri)
#   PBS_FLAVOR      install_only (default) or install_only_stripped
#   ALLOW_SDIST=1   allow building dependencies from source if a wheel is missing
#   SIGN_IDENTITY   "-" (ad-hoc, default) or "Developer ID Application: Name (TEAMID)"
#   NOTARY_PROFILE  notarytool keychain profile; when set (with a Developer ID) the app is
#                   notarized and stapled. Create it once with:
#                   xcrun notarytool store-credentials AIStudio --apple-id … --team-id …
#
# Developer ID / notarization notes
#   - Hardened runtime is enabled for Developer ID signatures; the embedded Python gets
#     scripts/package/entitlements/python.plist (unsigned executable memory for ctypes/cffi,
#     library validation off for extension modules) and the app gets entitlements/app.plist.
#   - Sign inside-out (this script does): Python Mach-O files → app binary → bundle. `--deep` is
#     only used for ad-hoc signatures.
#   - After notarization: `xcrun stapler staple "AI Studio.app"`; verify with
#     `spctl -a -vv "AI Studio.app"`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/package"
DESKTOP="$ROOT/apps/desktop"
TAURI_DIR="$DESKTOP/src-tauri"
RESOURCES="$TAURI_DIR/resources/backend"
CACHE="$HERE/.cache"

PBS_TAG="${PBS_TAG:-20261001}"
PY_VERSION="${PY_VERSION:-3.13.16}"
PBS_TRIPLE="${PBS_TRIPLE:-aarch64-apple-darwin}"
PBS_FLAVOR="${PBS_FLAVOR:-install_only}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

SKIP_BACKEND=0
SKIP_TAURI=0
BUILD_MODE=release
BUNDLES=app
WORK_DIR=""
trap '[[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"' EXIT

log() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mHata:\033[0m %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --skip-backend) SKIP_BACKEND=1 ;;
    --skip-tauri) SKIP_TAURI=1 ;;
    --debug) BUILD_MODE=debug ;;
    --dmg) BUNDLES=app,dmg ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "bilinmeyen seçenek: $arg" ;;
  esac
done

IS_MAC=0
[[ "$(uname -s)" == "Darwin" ]] && IS_MAC=1

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' bulunamadı ($2)"; }
need curl "https://curl.se"
need tar "system tar"
need uv "https://docs.astral.sh/uv/"

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# ---------------------------------------------------------------------------------------------
# 1. python-build-standalone
# ---------------------------------------------------------------------------------------------
fetch_python() {
  mkdir -p "$CACHE"
  if [[ "$PBS_TAG" == "latest" ]]; then
    PBS_TAG="$(curl -fsSL https://raw.githubusercontent.com/astral-sh/python-build-standalone/latest-release/latest-release.json \
      | sed -n 's/.*"tag": *"\([0-9]*\)".*/\1/p')"
    [[ -n "$PBS_TAG" ]] || die "python-build-standalone son sürümü çözülemedi"
  fi
  local base="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG"
  ARCHIVE_NAME="cpython-${PY_VERSION}+${PBS_TAG}-${PBS_TRIPLE}-${PBS_FLAVOR}.tar.gz"
  ARCHIVE="$CACHE/$ARCHIVE_NAME"
  local sums="$CACHE/SHA256SUMS-$PBS_TAG"
  [[ -s "$sums" ]] || curl -fsSL "$base/SHA256SUMS" -o "$sums"
  local expected
  expected="$(awk -v n="$ARCHIVE_NAME" '$2 == n {print $1}' "$sums")"
  [[ -n "$expected" ]] || die "$ARCHIVE_NAME bu sürümde yok (PY_VERSION/PBS_TAG kontrol edin)"
  if [[ ! -s "$ARCHIVE" || "$(sha256 "$ARCHIVE")" != "$expected" ]]; then
    log "İndiriliyor: $ARCHIVE_NAME"
    curl -fL --progress-bar "$base/${ARCHIVE_NAME//+/%2B}" -o "$ARCHIVE.part"
    mv "$ARCHIVE.part" "$ARCHIVE"
  fi
  [[ "$(sha256 "$ARCHIVE")" == "$expected" ]] || die "SHA-256 uyuşmuyor: $ARCHIVE_NAME"
  log "Doğrulandı: $ARCHIVE_NAME"
}

# ---------------------------------------------------------------------------------------------
# 2. Embedded backend
# ---------------------------------------------------------------------------------------------
build_backend() {
  fetch_python
  WORK_DIR="$(mktemp -d)"
  local work="$WORK_DIR"
  local prefix="$RESOURCES/python"

  log "Python açılıyor"
  rm -rf "$prefix"
  mkdir -p "$RESOURCES"
  # Extract in place: bytecode compiled below records final (relative to bundle) paths.
  tar -xzf "$ARCHIVE" -C "$RESOURCES"
  local py="$prefix/bin/python3"
  [[ -x "$py" ]] || die "python3 bulunamadı: $py"

  log "studiod bağımlılıkları kuruluyor (backend/uv.lock)"
  (cd "$ROOT/backend" && uv export --frozen --no-dev --no-editable --no-hashes --no-emit-project \
    --format requirements-txt -o "$work/requirements.txt" >/dev/null)
  local binary_only=(--only-binary ':all:')
  [[ "${ALLOW_SDIST:-0}" == "1" ]] && binary_only=()
  local pip=(uv pip install --python "$py" --break-system-packages --no-cache --compile-bytecode)
  "${pip[@]}" "${binary_only[@]}" -r "$work/requirements.txt"
  "${pip[@]}" --no-deps "$ROOT/backend"

  log "Gereksiz dosyalar temizleniyor"
  # bin/: only the interpreter is needed (console scripts carry build-machine shebangs).
  local real_python
  real_python="$(cd "$prefix/bin" && readlink python3 || true)"
  if [[ -n "$real_python" && -f "$prefix/bin/$real_python" ]]; then
    rm "$prefix/bin/python3"
    mv "$prefix/bin/$real_python" "$prefix/bin/python3"
  fi
  find "$prefix/bin" -mindepth 1 ! -name python3 -exec rm -rf {} +
  local stdlib
  stdlib="$(echo "$prefix"/lib/python3.*)"
  rm -rf "$stdlib"/test "$stdlib"/idlelib "$stdlib"/tkinter "$stdlib"/turtledemo "$stdlib"/ensurepip \
    "$stdlib"/lib-dynload/_tkinter* "$prefix"/lib/tcl* "$prefix"/lib/tk* "$prefix"/lib/itcl* \
    "$prefix"/lib/thread* "$prefix"/lib/pkgconfig "$prefix"/share "$prefix"/include
  find "$prefix" -name '*.a' -delete
  # Development symlinks (libpython3.13.so -> .so.1.0) are not needed at run time.
  find "$prefix/lib" -maxdepth 1 -type l \( -name '*.so' -o -name '*.dylib' \) -delete
  # Tauri copies resources file by file (following links): materialise what is left.
  while IFS= read -r -d '' link; do
    cp -RL "$link" "$link.materialized"
    rm "$link"
    mv "$link.materialized" "$link"
  done < <(find "$prefix" -type l -print0)

  # Smoke test when the interpreter can run on this machine.
  if "$py" -c 'import sys' >/dev/null 2>&1; then
    "$py" -c 'import aistudio, aistudio.__main__, fastapi, uvicorn, keyring; print("aistudio", aistudio.__version__)'
    "$py" -m aistudio --help >/dev/null
  else
    log "Bu makinede çalıştırılamayan hedef ($PBS_TRIPLE): duman testi atlandı"
  fi

  local backend_version
  backend_version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/backend/pyproject.toml" | head -1)"
  cat > "$RESOURCES/manifest.json" <<JSON
{
  "python": "$PY_VERSION",
  "pythonBuildStandalone": "$PBS_TAG",
  "triple": "$PBS_TRIPLE",
  "backend": "$backend_version",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  log "Gömülü motor hazır: $(du -sh "$prefix" | awk '{print $1}')"
}

# ---------------------------------------------------------------------------------------------
# 3. Signing + Tauri build (macOS only)
# ---------------------------------------------------------------------------------------------
codesign_file() {
  local file="$1" entitlements="$2"
  if [[ "$SIGN_IDENTITY" == "-" ]]; then
    codesign --force --sign - "$file"
  else
    codesign --force --timestamp --options runtime --entitlements "$entitlements" \
      --sign "$SIGN_IDENTITY" "$file"
  fi
}

sign_python() {
  log "Gömülü Python imzalanıyor ($SIGN_IDENTITY)"
  local count=0
  while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q 'Mach-O'; then
      codesign_file "$file" "$HERE/entitlements/python.plist"
      count=$((count + 1))
    fi
  done < <(find "$RESOURCES/python" -type f \( -perm -u+x -o -name '*.so' -o -name '*.dylib' \) -print0)
  log "$count Mach-O dosyası imzalandı"
}

build_app() {
  need pnpm "https://pnpm.io"
  need codesign "Xcode Command Line Tools"
  local target_dir="${CARGO_TARGET_DIR:-$TAURI_DIR/target}"
  local flags=(--bundles "$BUNDLES")
  [[ "$BUILD_MODE" == debug ]] && flags+=(--debug)

  log "Arayüz ve kabuk derleniyor (tauri build ${flags[*]})"
  (cd "$DESKTOP" && APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY" pnpm tauri build "${flags[@]}")

  local app="$target_dir/$BUILD_MODE/bundle/macos/AI Studio.app"
  [[ -d "$app" ]] || die "uygulama paketi bulunamadı: $app"

  log "Uygulama imzalanıyor"
  if [[ "$SIGN_IDENTITY" == "-" ]]; then
    codesign --force --deep --sign - "$app"
  else
    codesign_file "$app/Contents/MacOS/ai-studio" "$HERE/entitlements/app.plist"
    codesign_file "$app" "$HERE/entitlements/app.plist"
  fi
  codesign --verify --strict --verbose=2 "$app"

  if [[ -n "$NOTARY_PROFILE" && "$SIGN_IDENTITY" != "-" ]]; then
    log "Notarize ediliyor ($NOTARY_PROFILE)"
    local zip="$target_dir/$BUILD_MODE/bundle/macos/AI-Studio-notarize.zip"
    ditto -c -k --keepParent "$app" "$zip"
    xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$app"
    rm -f "$zip"
  fi

  log "Hazır: $app"
  cat <<EOF

Sonraki adımlar:
  1. Uygulamayı /Applications'a taşıyın (LaunchAgent bu yolu kaydeder; taşırsanız uygulama
     açılışta ajanı yeniden kurar).
  2. İlk açılışta macOS iki şey sorabilir:
     - Bildirim izni (Onayla / Reddet / Aç butonları için gerekli)
     - "AI Studio" Anahtar Zinciri öğesine erişim → "Her Zaman İzin Ver"
       (ad-hoc imzada her yeniden derlemeden sonra tekrar sorulabilir)
  3. Motor günlükleri: ~/Library/Application Support/AI Studio/logs/
     Kabuk günlükleri: ~/Library/Logs/app.aistudio.desktop/shell.log
EOF
}

if [[ $SKIP_BACKEND -eq 0 ]]; then
  build_backend
else
  [[ -x "$RESOURCES/python/bin/python3" ]] || die "--skip-backend: $RESOURCES/python yok"
fi

if [[ $SKIP_TAURI -eq 1 ]]; then
  log "--skip-tauri: yalnız gömülü motor hazırlandı"
  exit 0
fi
[[ $IS_MAC -eq 1 ]] || die ".app yalnız macOS'ta paketlenebilir (Linux'ta --skip-tauri kullanın)"
[[ "$(uname -m)" == "arm64" ]] || log "Uyarı: Apple Silicon dışı makinede aarch64 paketi derleniyor"
sign_python
build_app
