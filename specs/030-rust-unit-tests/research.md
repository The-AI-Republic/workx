# Research: Rust Unit Tests & CI/CD Integration

**Feature**: 030-rust-unit-tests
**Date**: 2026-02-20

## R1: Rust Test Framework Approach

**Decision**: Use Rust's built-in test framework (`#[test]`, `#[cfg(test)]`, `assert!` macros)

**Rationale**: The built-in framework is zero-dependency, requires no configuration, and is the standard for Rust projects. It supports:
- Co-located test modules (`#[cfg(test)] mod tests`)
- Test filtering (`cargo test <pattern>`)
- Parallel test execution (default)
- `--test-threads=1` for tests with shared state
- `#[should_panic]` for panic testing
- `#[ignore]` for slow/platform-specific tests

**Alternatives considered**:
- `rstest` (parameterized tests) — Useful but unnecessary complexity for initial test suite
- `proptest` (property-based testing) — Overkill for the current scope
- `criterion` (benchmarking) — Out of scope; focused on correctness, not performance

## R2: Coverage Tool Selection

**Decision**: Use `cargo-tarpaulin` for code coverage reporting

**Rationale**: cargo-tarpaulin is the most widely used Rust coverage tool, outputs to stdout for CI visibility, and runs on Linux (the CI environment). It integrates with `cargo test` seamlessly.

**Alternatives considered**:
- `cargo-llvm-cov` — More accurate (instrument-based) but requires nightly Rust or specific LLVM setup; harder to configure in CI
- `grcov` (Mozilla) — Powerful but more complex setup; better for large projects with existing LLVM infrastructure
- No coverage — Rejected per clarification (user wants coverage in CI)

**Constraints**:
- cargo-tarpaulin only runs on x86_64 Linux — fine for CI (ubuntu-latest) but not for local macOS/Windows dev
- Local coverage: developers on non-Linux can use `cargo-llvm-cov` optionally, but this is not part of the spec

## R3: npm ↔ cargo Integration Pattern

**Decision**: Shell script wrapper (`tauri/scripts/test-rust.sh`) called from npm scripts

**Rationale**:
- Simple, transparent, debuggable
- Handles Rust toolchain detection with clear error messages
- Works cross-platform (bash available on macOS, Linux, and Windows via Git Bash/WSL)
- npm script: `"test": "bash tauri/scripts/test-rust.sh && vitest"`
- The `&&` operator provides fail-fast: if `test-rust.sh` exits non-zero, vitest never starts

**Alternatives considered**:
- `concurrently` npm package — Runs in parallel but interleaves output; doesn't support fail-fast in the desired way
- Custom Node.js script (`scripts/test.js`) — More code to maintain; shell script is simpler and more transparent
- `npm-run-all` — Adds dependency; `&&` in shell achieves the same result

## R4: CI Workflow Modification Strategy

**Decision**: Add Rust toolchain + caching + cargo test to existing CI test job

**Rationale**: The existing CI has a `test` job that runs `npm run test:all`. We modify this single job to:
1. Install Rust stable toolchain (`dtolnay/rust-toolchain@stable`)
2. Cache cargo registry + build artifacts (reuse pattern from `release.yml`)
3. Install Linux system dependencies needed for Tauri compilation
4. Run `npm test` (which now runs cargo test + vitest)
5. Run coverage as a separate step

This approach keeps the CI simple (one test job) and the `npm test` command consistent between local and CI.

**Alternatives considered**:
- Separate Rust test job — More parallelism but duplicates checkout/setup; adds complexity
- Rust tests in lint job — Wrong semantic grouping
- Matrix strategy (test on multiple platforms) — Out of scope; CI runs on Ubuntu only per current configuration

## R5: Handling Global State in Tests (lazy_static)

**Decision**: Use test-specific IDs/keys and cleanup in test functions; document `--test-threads=1` for storage tests

**Rationale**: `storage_commands.rs` and `mcp_manager.rs` use `lazy_static!` global `Mutex<HashMap>`. Tests that modify this shared state could interfere. Solutions:
1. Use unique keys per test (e.g., `test_key_<test_name>`)
2. Clean up after each test in a `Drop` guard or explicit cleanup
3. For `ConfigStorage`: construct test instances directly (bypass the global singleton) by making `ConfigStorage::new()` testable with a temp directory

This avoids the need for `--test-threads=1` (which slows tests) while maintaining isolation.

**Alternatives considered**:
- `--test-threads=1` globally — Too slow; only needed if all tests share state
- Refactor to dependency injection — Too invasive for this feature; can be done incrementally later
- `serial_test` crate — Adds dependency; manual isolation is sufficient for now

## R6: Platform-Specific Test Strategy

**Decision**: Use `#[cfg(target_os = "...")]` on platform-specific tests; test shared logic unconditionally

**Rationale**: The sandbox modules (`linux.rs`, `macos.rs`, `windows.rs`) contain platform-specific code. Strategy:
- `build_command()` functions contain mostly pure logic (argument construction) — test on all platforms
- `is_available()` functions check for platform-specific binaries — test only on target OS
- `generate_sbpl()` in `macos.rs` is pure string building — test on all platforms
- Use `#[cfg(target_os = "linux")]` etc. for tests that require specific OS features

CI runs on Ubuntu, so Linux tests always run. macOS/Windows tests would only run on those platforms (not in current CI scope).

**Alternatives considered**:
- Skip all platform tests — Misses opportunity to test pure logic (SBPL generation, bwrap args)
- Multi-platform CI matrix — Out of scope; can be added later when the test suite is mature

## R7: Testability Tiers

**Decision**: Prioritize tests by testability tier, from easiest to hardest

**Rationale**: Based on source code analysis, functions fall into clear testability tiers:

| Tier | Approach | Files | Est. Tests |
|------|----------|-------|------------|
| 1 — Pure Logic | Direct testing, no mocking | sandbox/windows.rs, sandbox/macos.rs, sandbox/linux.rs, commands.rs, sandbox/mod.rs | ~45 |
| 2 — Extractable | Extract helper, test pure part | mcp_manager.rs, http_commands.rs, terminal_commands.rs, sandbox/status.rs, main.rs | ~35 |
| 3 — State-Dependent | Test setup with temp dirs/data | storage_commands.rs, browser_commands.rs, keychain_commands.rs | ~15 |
| **Total** | | **13 files** | **~95** |

This ordering maximizes coverage with minimal effort and risk.
