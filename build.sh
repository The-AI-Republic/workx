#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: ./build.sh [--install] [cargo-tauri-build-args...]

Builds the WorkX Tauri desktop app for local testing.

By default this runs an unsigned build:
  cargo tauri build --no-sign

The Tauri build also runs the configured beforeBuildCommand, which rebuilds:
  - desktop web UI
  - desktop runtime sidecar
  - chrome-devtools-mcp sidecar

Examples:
  ./build.sh
  ./build.sh --install
  ./build.sh --bundles deb
  ./build.sh --install --bundles deb
  ./build.sh --debug

Set APPLEPI_SIGN=1 to omit --no-sign and use Tauri signing env vars.
EOF
  exit 0
fi

INSTALL_AFTER_BUILD=0
BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL_AFTER_BUILD=1
      shift
      ;;
    *)
      BUILD_ARGS+=("$1")
      shift
      ;;
  esac
done

latest_match() {
  local pattern="$1"
  local latest
  latest="$(ls -td $pattern 2>/dev/null | head -n 1 || true)"
  if [[ -z "$latest" ]]; then
    echo "error: no artifact found for pattern: $pattern" >&2
    exit 1
  fi
  printf '%s\n' "$latest"
}

latest_match_optional() {
  local pattern="$1"
  ls -td $pattern 2>/dev/null | head -n 1 || true
}

install_ubuntu() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "error: ubuntu install target must be run on Linux" >&2
    exit 1
  fi
  if ! command -v apt >/dev/null 2>&1; then
    echo "error: apt was not found; ubuntu install target requires apt" >&2
    exit 1
  fi

  local deb
  deb="$(latest_match "$ROOT_DIR/tauri/target/release/bundle/deb/WorkX_*_amd64.deb")"
  echo "Installing $deb"
  sudo apt install --reinstall "$deb"
}

install_mac() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: mac install target must be run on macOS" >&2
    exit 1
  fi

  local app
  app="$(latest_match "$ROOT_DIR/tauri/target/release/bundle/macos/"*.app)"
  local dest="/Applications/$(basename "$app")"
  echo "Installing $app to $dest"
  sudo rm -rf "$dest"
  sudo ditto "$app" "$dest"
  open "$dest"
}

install_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *)
      echo "error: windows install target must be run from Windows bash" >&2
      exit 1
      ;;
  esac
  if ! command -v powershell.exe >/dev/null 2>&1; then
    echo "error: powershell.exe was not found" >&2
    exit 1
  fi

  local installer
  installer="$(latest_match_optional "$ROOT_DIR/tauri/target/release/bundle/msi/"*.msi)"
  if [[ -z "$installer" ]]; then
    installer="$(latest_match "$ROOT_DIR/tauri/target/release/bundle/nsis/"*.exe)"
  fi
  if command -v cygpath >/dev/null 2>&1; then
    installer="$(cygpath -w "$installer")"
  fi

  echo "Installing $installer"
  powershell.exe -NoProfile -Command "Start-Process -FilePath '$installer' -Wait -Verb RunAs"
}

install_for_current_os() {
  case "$(uname -s)" in
    Linux) install_ubuntu ;;
    Darwin) install_mac ;;
    MINGW*|MSYS*|CYGWIN*) install_windows ;;
    *)
      echo "error: unsupported install OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

desktop_env_value() {
  local key="$1"
  local env_file="$ROOT_DIR/src/desktop/.env"
  local line value
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi
  line="$(grep -E "^[[:space:]]*${key}=" "$env_file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 0
  fi
  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s\n' "$value"
}

EFFECTIVE_AUTH_BASE_URL="${VITE_AUTH_BASE_URL:-$(desktop_env_value VITE_AUTH_BASE_URL)}"
if [[ -z "$EFFECTIVE_AUTH_BASE_URL" ]]; then
  EFFECTIVE_AUTH_BASE_URL="${VITE_HOME_PAGE_BASE_URL:-$(desktop_env_value VITE_HOME_PAGE_BASE_URL)}"
fi
echo "WorkX build auth base URL: ${EFFECTIVE_AUTH_BASE_URL:-not configured}"
if [[ -n "${APPLEPI_AUTH_BASE_URL:-}" && -z "${VITE_AUTH_BASE_URL:-}" ]]; then
  echo "Note: APPLEPI_AUTH_BASE_URL affects runtime Node code only; set VITE_AUTH_BASE_URL for the desktop WebView build."
elif [[ -n "${APPLEPI_HOME_PAGE_BASE_URL:-}" && -z "${VITE_HOME_PAGE_BASE_URL:-}" && -z "${VITE_AUTH_BASE_URL:-}" ]]; then
  echo "Note: APPLEPI_HOME_PAGE_BASE_URL affects runtime Node code only; set VITE_AUTH_BASE_URL for the desktop WebView build."
fi

cd "$ROOT_DIR/tauri"

if [[ "${APPLEPI_SIGN:-0}" == "1" ]]; then
  cargo tauri build "${BUILD_ARGS[@]}"
else
  cargo tauri build --no-sign "${BUILD_ARGS[@]}"
fi

if [[ "$INSTALL_AFTER_BUILD" == "1" ]]; then
  install_for_current_os
fi
