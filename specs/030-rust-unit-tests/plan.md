# Implementation Plan: Rust Unit Tests & CI/CD Integration

**Branch**: `030-rust-unit-tests` | **Date**: 2026-02-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/030-rust-unit-tests/spec.md`

## Summary

Add Rust unit tests to the Tauri backend codebase (13 source files, ~1,731 lines), integrate them into the unified `npm test` command (cargo test runs first with fail-fast, then Vitest), update the CI/CD pipeline to install Rust toolchain with caching and run tests with coverage reporting, and remove the now-redundant `test:all` script.

## Technical Context

**Language/Version**: Rust 2021 edition (stable toolchain), TypeScript 5.9.2, Node.js 22
**Primary Dependencies**: Tauri v2, tokio v1, serde/serde_json, reqwest v0.12, keyring v3, rmcp v0.15, portable-pty v0.8, tempfile v3
**Storage**: File-based JSON config (ConfigStorage in storage_commands.rs)
**Testing**: `cargo test` (Rust built-in), Vitest v3.2.4 (TypeScript), cargo-tarpaulin (coverage)
**Target Platform**: Linux (Ubuntu), macOS, Windows (cross-platform Tauri app)
**Project Type**: Hybrid desktop app (Rust backend + TypeScript/Svelte frontend)
**Performance Goals**: Incremental Rust test run <30s locally; CI adds <3min after cache warm-up
**Constraints**: No external Rust test frameworks; use built-in `#[test]` + `#[cfg(test)]`; tests co-located in source files
**Scale/Scope**: 13 Rust source files across 5 modules; ~80+ unit test cases planned

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is unconfigured (template placeholders only). No gates to enforce. Proceeding with standard best practices:
- Tests co-located with source (idiomatic Rust pattern)
- No unnecessary abstractions (test what exists, extract only when needed for testability)
- Minimal dev-dependencies (only `tempfile` for test fixtures — already a regular dependency)

## Project Structure

### Documentation (this feature)

```text
specs/030-rust-unit-tests/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (test coverage map)
├── quickstart.md        # Phase 1 output (developer guide)
├── contracts/           # Phase 1 output (npm script contracts)
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
tauri/
├── Cargo.toml                    # Add [dev-dependencies] for cargo-tarpaulin
├── src/
│   ├── main.rs                   # Add #[cfg(test)] module: PNG decoding, dark theme parsing
│   ├── commands.rs               # Add #[cfg(test)] module: greet, platform info
│   ├── storage_commands.rs       # Add #[cfg(test)] module: config get/set/remove/clear
│   ├── keychain_commands.rs      # Add #[cfg(test)] module: error mapping, not-found handling
│   ├── browser_commands.rs       # Add #[cfg(test)] module: file_exists, port checking
│   ├── http_commands.rs          # Add #[cfg(test)] module: method parsing, header conversion, base64 encoding
│   ├── terminal_commands.rs      # Add #[cfg(test)] module: shell detection, ANSI stripping, exit code extraction
│   ├── mcp_manager.rs            # Add #[cfg(test)] module: command validation, content transformations
│   └── sandbox/
│       ├── mod.rs                # Add #[cfg(test)] module: enum parsing, profile building
│       ├── status.rs             # Add #[cfg(test)] module: distro detection, package manager selection
│       ├── linux.rs              # Add #[cfg(test)] module: bwrap arg construction
│       ├── macos.rs              # Add #[cfg(test)] module: SBPL generation, path escaping
│       └── windows.rs            # Add #[cfg(test)] module: fallback command building
├── scripts/
│   └── test-rust.sh              # Standalone Rust test runner (called by npm scripts)
.github/workflows/
└── ci.yml                        # Add Rust toolchain + cargo test + coverage step
package.json                      # Update test script, remove test:all, add test:rust
```

**Structure Decision**: Tests are co-located within each Rust source file using `#[cfg(test)] mod tests { ... }` — the idiomatic Rust pattern. No separate test directories needed for unit tests. A shell script `tauri/scripts/test-rust.sh` wraps `cargo test` execution from the project root.

## Implementation Approach

### Phase 1: Test Infrastructure (P1 + P2)

**1a. Create test runner script** (`tauri/scripts/test-rust.sh`)
- Checks for Rust toolchain availability (clear error if missing)
- Runs `cargo test --manifest-path tauri/Cargo.toml` from project root
- Exits with cargo test's exit code
- Used by npm scripts and CI

**1b. Update npm scripts** (`package.json`)
- `"test"`: Run `test-rust.sh` first, then `vitest` (fail-fast: if Rust fails, skip Vitest)
- `"test:rust"`: Run only `test-rust.sh`
- Remove `"test:all"`: No longer needed (Vitest auto-detects CI mode)
- Implementation: `"test": "bash tauri/scripts/test-rust.sh && vitest"` or equivalent cross-platform approach

**1c. Add initial test modules** (one per file, minimal)
- Add `#[cfg(test)] mod tests { use super::*; }` to each source file
- Add one simple passing test per module to verify infrastructure works

### Phase 2: CI/CD Integration (P3)

**2a. Update CI workflow** (`.github/workflows/ci.yml`)
- Add Rust toolchain installation: `dtolnay/rust-toolchain@stable` (reuse pattern from release.yml)
- Add cargo caching: `actions/cache@v4` with `~/.cargo/registry`, `~/.cargo/git`, `tauri/target` keyed by `Cargo.lock`
- Install system dependencies for Linux (webkit2gtk, etc.) — reuse from release.yml
- Change test step from `npm run test:all` to `npm test` (unified command)
- Add coverage step: `cargo tarpaulin --manifest-path tauri/Cargo.toml --out stdout` (or `cargo-llvm-cov`)

**2b. Coverage tooling**
- Install `cargo-tarpaulin` in CI: `cargo install cargo-tarpaulin`
- Run coverage as separate step after tests pass
- Output to stdout (visible in CI logs per FR-012)

### Phase 3: Comprehensive Tests (P4)

Write unit tests for each module, prioritized by testability:

**Tier 1 — Pure Logic (no mocking needed):**

| File | Tests | What's Tested |
|------|-------|---------------|
| `sandbox/windows.rs` | 5-8 | `is_available()`, `build_command()` workspace/env variations |
| `sandbox/macos.rs` | 15-18 | `escape_sbpl_path()`, `generate_sbpl()` all rule variations |
| `sandbox/linux.rs` | 12-15 | `build_command()` mount types, network isolation, process isolation |
| `commands.rs` | 3-4 | `greet()` format, `get_platform_info()` field population |
| `sandbox/mod.rs` | 8-10 | `WorkspaceAccess::from_str_opt()`, `NetworkMode::from_str_opt()`, `build_profile()` |

**Tier 2 — Extractable Logic (extract helpers, test pure parts):**

| File | Tests | What's Tested |
|------|-------|---------------|
| `mcp_manager.rs` | 12-15 | Command allowlist validation, content block transforms, resource transforms |
| `http_commands.rs` | 5-6 | HTTP method parsing, status text mapping, header conversion, base64 encoding |
| `terminal_commands.rs` | 5-7 | Shell detection, ANSI stripping, exit code extraction |
| `sandbox/status.rs` | 10-12 | Distro ID parsing, package manager selection, file-based checks |
| `main.rs` | 3-5 | `load_png_image()` with test fixtures, dark theme string parsing |

**Tier 3 — State-Dependent (needs test setup):**

| File | Tests | What's Tested |
|------|-------|---------------|
| `storage_commands.rs` | 7-9 | ConfigStorage get/set/remove/clear with in-memory data |
| `browser_commands.rs` | 4-5 | `file_exists()` with temp files, port availability |
| `keychain_commands.rs` | 3-4 | Error mapping logic, `NoEntry` → `Ok(None)` conversion |

### Refactoring Strategy

Some functions need minor refactoring to extract testable logic. The pattern is:

1. **Extract pure helper** from side-effect function
2. **Test the helper** (pure, no mocking)
3. **Leave the wrapper** as-is (integration tested later)

Examples:
- `mcp_manager.rs`: Extract `validate_command_allowlist(cmd: &str) -> Result<(), String>`
- `http_commands.rs`: Extract `parse_http_method(s: &str) -> Result<Method, String>`
- `terminal_commands.rs`: Extract `strip_ansi_and_decode(bytes: &[u8]) -> String`
- `sandbox/status.rs`: Extract `parse_distro_id(os_release: &str) -> &str`

These are small, focused extractions — not architectural changes.

## Complexity Tracking

> No constitution violations to justify. Design follows minimal complexity:
> - No external test frameworks (uses built-in `#[test]`)
> - No mocking crate for Phase 1-2 (tests target pure logic)
> - Tests co-located in source files (zero new directories)
> - Single shell script bridges npm ↔ cargo (no complex build tooling)
