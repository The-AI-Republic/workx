# Quickstart: Rust Unit Tests & CI/CD Integration

**Feature**: 030-rust-unit-tests
**Date**: 2026-02-20

## Prerequisites

- Rust stable toolchain installed (`rustup` recommended)
- Node.js 22+ with npm
- Project dependencies installed (`npm ci`)

## Running Tests

### All Tests (Rust + TypeScript)

```bash
npm test
```

This runs:
1. `cargo test` (Rust) — runs first, fail-fast if any test fails
2. `vitest` (TypeScript) — starts only if Rust tests pass; watch mode locally, single-run in CI

### Rust Tests Only

```bash
npm run test:rust
```

Or directly:

```bash
cargo test --manifest-path tauri/Cargo.toml
```

### Single Rust Module

```bash
cargo test --manifest-path tauri/Cargo.toml <module_name>
```

Examples:
```bash
cargo test --manifest-path tauri/Cargo.toml commands
cargo test --manifest-path tauri/Cargo.toml storage_commands
cargo test --manifest-path tauri/Cargo.toml mcp_manager
cargo test --manifest-path tauri/Cargo.toml sandbox
```

### Rust Test with Output

```bash
cargo test --manifest-path tauri/Cargo.toml -- --nocapture
```

## Writing a New Rust Test

Tests are co-located in each source file. Add to the existing `#[cfg(test)]` module:

```rust
// At the bottom of tauri/src/your_module.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_your_function() {
        let result = your_function("input");
        assert_eq!(result, "expected");
    }

    #[test]
    fn test_edge_case() {
        let result = your_function("");
        assert!(result.is_err());
    }
}
```

## Coverage (CI Only)

Coverage runs automatically in CI via `cargo-tarpaulin`. To run locally on Linux:

```bash
cargo install cargo-tarpaulin
cargo tarpaulin --manifest-path tauri/Cargo.toml --out stdout
```

## CI Pipeline

The CI pipeline (`.github/workflows/ci.yml`) runs on every PR:
1. **Lint** — `npm run lint`
2. **Type Check** — `npm run type-check`
3. **Test** — `npm test` (Rust + TypeScript) + coverage reporting

Rust toolchain and cargo dependencies are cached between runs.

## Troubleshooting

**"Rust toolchain not found"**: Install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

**Compilation error vs test failure**: Cargo test output clearly separates compilation errors (shown first with `error[E...]`) from test failures (shown as `test ... FAILED`).

**Slow first run**: The first `cargo test` compiles all dependencies (~2-3 min). Subsequent runs use cached artifacts and are much faster (<30s).
