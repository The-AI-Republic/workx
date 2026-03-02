# Contract: npm Scripts

**Feature**: 030-rust-unit-tests
**Date**: 2026-02-20

## Scripts (package.json)

### `npm test`

**Before**:
```json
"test": "vitest"
```

**After**:
```json
"test": "bash tauri/scripts/test-rust.sh && vitest"
```

**Behavior**:
- Runs `cargo test` via `test-rust.sh` first
- If cargo test fails → exits with non-zero code (vitest never starts)
- If cargo test passes → starts vitest
  - Locally: watch mode (default vitest behavior)
  - In CI (CI env var set): single-run mode (vitest auto-detects)

### `npm run test:rust`

**New script**:
```json
"test:rust": "bash tauri/scripts/test-rust.sh"
```

**Behavior**:
- Runs only Rust tests via `cargo test`
- Independent of TypeScript test suite
- Exits with cargo test's exit code

### `npm run test:all`

**Removed**. The unified `npm test` replaces this. Vitest auto-detects CI environment.

---

## Shell Script: `tauri/scripts/test-rust.sh`

**Purpose**: Bridge between npm and cargo test

**Contract**:
```bash
#!/usr/bin/env bash
# Exit codes:
#   0 — all Rust tests passed
#   1 — Rust tests failed or compilation error
#   127 — Rust toolchain not found

# 1. Check for cargo binary
# 2. Run: cargo test --manifest-path tauri/Cargo.toml
# 3. Exit with cargo's exit code
```

**Error handling**:
- Missing Rust toolchain → stderr message: "Error: Rust toolchain not found. Install via https://rustup.rs" → exit 127
- Compilation error → cargo's native error output → exit 1
- Test failure → cargo's native test output → exit 1
- All tests pass → exit 0

---

## CI Workflow: `.github/workflows/ci.yml`

### Test Job (modified)

**Before**:
```yaml
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: npm run test:all
```

**After**:
```yaml
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: npm
    - uses: dtolnay/rust-toolchain@stable
    - uses: actions/cache@v4
      with:
        path: |
          ~/.cargo/registry
          ~/.cargo/git
          tauri/target
        key: ${{ runner.os }}-cargo-${{ hashFiles('tauri/Cargo.lock') }}
        restore-keys: ${{ runner.os }}-cargo-
    - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
    - run: npm ci
    - run: npm test
    - name: Rust Coverage
      run: |
        cargo install cargo-tarpaulin --locked
        cargo tarpaulin --manifest-path tauri/Cargo.toml --out stdout
```
