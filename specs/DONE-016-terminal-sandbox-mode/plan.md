# Implementation Plan: Terminal Sandbox Mode

**Branch**: `016-terminal-sandbox-mode` | **Date**: 2026-02-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-terminal-sandbox-mode/spec.md`

## Summary

Add OS-native container/sandbox execution modes to the terminal command tool in the Pi desktop app. The terminal tool will support three execution modes: **safe** (always sandboxed), **power** (never sandboxed), and **auto** (LLM decides per-command, default). Platform-specific sandbox implementations: bubblewrap on Linux, sandbox-exec on macOS, AppContainer + Job Objects on Windows. The sandbox primarily restricts filesystem writes to the project directory while allowing network access by default. Users configure execution mode and sandbox access controls (workspace access, bind mounts, network mode) through settings.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (frontend) + Rust (Tauri 2.x backend)
**Primary Dependencies**: Tauri 2, tokio 1, serde, @tauri-apps/api, Svelte 4. New: `which` (Rust), `tempfile` (Rust), `windows`/`win32job` (Windows only)
**Storage**: `config.json` via existing TauriConfigStorage → Rust storage_commands.rs
**Testing**: Vitest (TypeScript unit tests), cargo test (Rust unit tests)
**Target Platform**: Linux (x86_64, aarch64), macOS (aarch64, x86_64), Windows 10+ (x86_64)
**Project Type**: Desktop app (Tauri — Rust backend + TypeScript/Svelte frontend)
**Performance Goals**: Sandbox overhead < 500ms startup latency per command
**Constraints**: No external dependencies requiring user installation (except bubblewrap on Linux, auto-installed). 2-minute default command timeout.
**Scale/Scope**: Single-user desktop app. ~8 new Rust files, ~3 modified TypeScript files, ~1 new TypeScript file, settings UI additions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution is a template placeholder (not project-specific). No gates to enforce. Proceeding.

**Post-Phase 1 re-check**: Design uses existing patterns (Tauri commands, ConfigStorage, ToolRegistry). No new architectural paradigms introduced. Passes.

## Project Structure

### Documentation (this feature)

```text
specs/016-terminal-sandbox-mode/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: Technology research & decisions
├── data-model.md        # Phase 1: Entity model & config schema
├── quickstart.md        # Phase 1: Architecture overview & file map
├── contracts/
│   ├── tauri-commands.md  # Tauri IPC command contracts
│   └── tool-schema.md    # LLM tool schema contract
├── checklists/
│   └── requirements.md   # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
tauri/
├── src/
│   ├── main.rs                      # MODIFY: register new commands
│   ├── terminal_commands.rs          # MODIFY: add sandbox params, route to executor
│   └── sandbox/                      # NEW: sandbox module
│       ├── mod.rs                    # SandboxExecutor trait, SandboxProfile, dispatch
│       ├── linux.rs                  # LinuxSandbox: bubblewrap invocation
│       ├── macos.rs                  # MacSandbox: sandbox-exec + SBPL generation
│       ├── windows.rs                # WindowsSandbox: AppContainer + Job Objects
│       └── status.rs                 # Runtime detection, availability check, auto-install
└── Cargo.toml                        # MODIFY: add which, tempfile, windows deps

src/
├── desktop/
│   ├── tools/
│   │   ├── terminal/
│   │   │   ├── TerminalTool.ts       # MODIFY: add sandboxed param, mode resolution
│   │   │   ├── SecurityFilter.ts     # NO CHANGES (blocklist applies regardless)
│   │   │   ├── SandboxManager.ts     # NEW: sandbox config, status, mode resolution
│   │   │   └── index.ts              # MODIFY: export SandboxManager
│   │   └── registerDesktopTools.ts   # MODIFY: pass sandbox config to tool registration
│   └── storage/
│       └── TauriConfigStorage.ts     # NO CHANGES (existing storage used as-is)
├── extension/
│   └── sidepanel/
│       └── ToolsSettings.svelte      # MODIFY: add execution mode + sandbox settings
└── config/
    └── AgentConfig.ts                # NO CHANGES (config keys accessed via storage)

tests/
├── desktop/
│   └── sandbox/                      # NEW: sandbox unit tests
│       ├── SandboxManager.test.ts
│       └── mode-resolution.test.ts
└── sidepanel/
    └── TerminalInput.test.ts         # EXISTING (may need sandbox-aware updates)
```

**Structure Decision**: This feature extends the existing dual-architecture (TypeScript frontend + Rust backend) by adding a new `sandbox` Rust module alongside the existing `terminal_commands`. The TypeScript side adds a `SandboxManager` to the existing terminal tool directory. No new top-level directories created.

## Complexity Tracking

No constitution violations to justify.
