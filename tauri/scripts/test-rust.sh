#!/usr/bin/env bash
# Run Rust unit tests for the Tauri backend.
# Called by npm scripts ("test", "test:rust") and CI.

set -euo pipefail

# Skip gracefully when cargo is not installed (e.g. frontend-only devs)
if ! command -v cargo &>/dev/null; then
  echo "SKIP: cargo not found — Rust tests skipped. Install the Rust toolchain if needed: https://rustup.rs" >&2
  exit 0
fi

# Resolve the repo root (this script lives in tauri/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."
MANIFEST="$SCRIPT_DIR/../Cargo.toml"

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: Cargo.toml not found at $MANIFEST" >&2
  exit 1
fi

# Ensure the frontend dist directory exists so tauri::generate_context!() compiles.
# The actual frontend build is not needed for unit tests.
mkdir -p "$REPO_ROOT/dist/desktop"

echo "Running Rust tests..."
cargo test --manifest-path "$MANIFEST" 2>&1
