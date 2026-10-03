#!/usr/bin/env bash
# Type-checks and lints the shell for aarch64-apple-darwin from Linux (CI or agents), so the
# `#[cfg(target_os = "macos")]` code (UserNotifications, Keychain, vibrancy, launchd) is
# compiled even without a Mac. No linking happens, so no macOS SDK is needed; clang compiles
# the one Objective-C helper (objc2-exception-helper) that has no SDK dependency.
#
#   scripts/package/check-macos-target.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/apps/desktop/src-tauri"

rustup target list --installed | grep -qx aarch64-apple-darwin || rustup target add aarch64-apple-darwin

if [[ "$(uname -s)" != "Darwin" ]]; then
  export CC_aarch64_apple_darwin="${CC_aarch64_apple_darwin:-clang}"
  export AR_aarch64_apple_darwin="${AR_aarch64_apple_darwin:-llvm-ar}"
fi
cargo clippy --all-targets --target aarch64-apple-darwin -- -D warnings
echo "aarch64-apple-darwin: clippy clean"
