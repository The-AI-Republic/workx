# Data Model: Rust Unit Tests & CI/CD Integration

**Feature**: 030-rust-unit-tests
**Date**: 2026-02-20

This feature does not introduce new data entities. Instead, this document maps the **test coverage model** — which existing Rust modules, functions, and data structures are covered by the new test suite.

## Test Coverage Map

### Module: commands.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `greet(name: &str) -> String` | Pure | Format validation |
| `get_platform_info() -> PlatformInfo` | Pure | Field population check |
| `get_project_root() -> Result<String, String>` | System I/O | Skip (integration only) |

**Structs**: `PlatformInfo { os, arch, version }`

### Module: storage_commands.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `ConfigStorage::get(key)` | Pure (map lookup) | Existing key, missing key |
| `ConfigStorage::set(key, value)` | Hybrid (JSON parse + save) | String value, JSON object, invalid JSON |
| `ConfigStorage::remove(key)` | Hybrid (map + save) | Key removal verification |
| `ConfigStorage::get_all()` | Pure (map iteration) | Empty map, populated map |
| `ConfigStorage::clear()` | Hybrid (clear + save) | Cleared state verification |
| `config_storage_*()` Tauri commands | State-dependent | Via ConfigStorage methods |

**Structs**: `ConfigStorage { data: Map<String, Value>, config_path: Option<PathBuf> }`

### Module: http_commands.rs

| Function / Logic | Testability | Tests Planned |
|-----------------|-------------|---------------|
| HTTP method parsing | Extract → Pure | Valid methods (GET, POST, etc.), invalid method |
| Status text mapping | Extract → Pure | Known codes (200, 404, 500), unknown code |
| Header conversion | Extract → Pure | Valid headers, non-UTF-8 fallback |
| Base64 chunk encoding | Extract → Pure | Known byte sequences |

**Structs**: `HttpEvent { Headers, Chunk, End, Error }`

### Module: terminal_commands.rs

| Function / Logic | Testability | Tests Planned |
|-----------------|-------------|---------------|
| Shell detection per platform | Extract → Pure | Linux→bash, macOS→zsh, Windows→powershell |
| ANSI escape stripping | Extract → Pure | With escapes, without, invalid UTF-8 |
| Exit code extraction | Extract → Pure | Valid code, None→-1, overflow |

**Structs**: `TerminalResult { exit_code, stdout, stderr, sandboxed }`, `DirectResult { exit_code, output }`

### Module: mcp_manager.rs

| Function / Logic | Testability | Tests Planned |
|-----------------|-------------|---------------|
| Command allowlist validation | Extract → Pure | Valid (npx, node, deno), invalid, full path |
| Tool definition transformation | Extract → Pure | With/without description, schema handling |
| Content block transformation | Extract → Pure | Text, Image, Audio, Unknown variants |
| Resource transformation | Extract → Pure | URI, name, description, mime_type |
| Resource content matching | Extract → Pure | Text content, Blob content |

**Structs**: `McpToolDef`, `McpContentBlock`, `McpToolResult`, `McpResourceDef`, `McpResourceContent`

### Module: sandbox/mod.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `WorkspaceAccess::from_str_opt()` | Pure | "ro", "none", "rw", None |
| `NetworkMode::from_str_opt()` | Pure | "sandbox", "host", None |
| `build_profile()` | Path ops | With/without cwd, standard writable paths |

**Structs**: `WorkspaceAccess`, `NetworkMode`, `BindMount`, `SandboxProfile`

### Module: sandbox/linux.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `LinuxSandbox::build_command()` | Pure | System mounts, workspace RW/RO/None, bind mounts, network isolation, process isolation, final args |

### Module: sandbox/macos.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `escape_sbpl_path()` | Pure | Valid path, spaces, quote char |
| `MacSandbox::generate_sbpl()` | Pure | Basic structure, workspace rules, writable paths, bind mounts, network rules |

### Module: sandbox/windows.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `WindowsSandbox::is_available()` | Pure | Always false |
| `WindowsSandbox::build_command()` | Pure | Workspace variations, env handling |

### Module: sandbox/status.rs

| Function / Logic | Testability | Tests Planned |
|-----------------|-------------|---------------|
| `is_apparmor_userns_restricted()` | File read | "1"→true, "0"→false, missing→false |
| `is_userns_clone_disabled()` | File read | "0"→true, "1"→false, missing→false |
| Distro ID parsing from os-release | Extract → Pure | ubuntu, fedora, arch, missing |
| Package manager selection | Extract → Pure | apt-get, dnf, pacman, zypper, unsupported |

### Module: main.rs

| Function | Testability | Tests Planned |
|----------|-------------|---------------|
| `load_png_image()` | Pure | Valid RGB PNG, RGBA PNG, invalid data |
| Dark theme string parsing | Extract → Pure | "Dark"→true, other→false (macOS); GTK parsing (Linux) |

### Module: keychain_commands.rs

| Function / Logic | Testability | Tests Planned |
|-----------------|-------------|---------------|
| Error mapping logic | Extract → Pure | `NoEntry` → `Ok(None)`, other errors → `Err` |
| `keychain_list_accounts()` | Pure | Always returns error (not implemented) |

## Total Coverage Target

| Category | Files | Est. Tests |
|----------|-------|------------|
| Tier 1 — Pure Logic | 5 files | ~45 tests |
| Tier 2 — Extractable Logic | 5 files | ~35 tests |
| Tier 3 — State-Dependent | 3 files | ~15 tests |
| **Total** | **13 files** | **~95 tests** |
