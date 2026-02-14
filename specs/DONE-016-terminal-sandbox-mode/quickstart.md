# Quickstart: Terminal Sandbox Mode

**Feature**: `016-terminal-sandbox-mode`
**Date**: 2026-02-12

## Overview

This feature adds OS-native sandbox isolation to the terminal command tool in the Pi desktop app. Commands can run in three modes: **safe** (always sandboxed), **power** (never sandboxed), **auto** (LLM decides per-command, default).

## Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────┐
│  TypeScript (Frontend)                                        │
│                                                               │
│  TerminalTool.execute()                                       │
│    ├─ SecurityFilter.check()  ← blocklist always applies      │
│    ├─ Mode resolution (safe/power/auto → sandboxed boolean)   │
│    └─ invoke('terminal_execute', { sandboxed, ... })          │
│                                                               │
├──────────────── Tauri IPC ────────────────────────────────────┤
│                                                               │
│  Rust (Backend) — terminal_commands.rs                        │
│                                                               │
│  terminal_execute()                                           │
│    ├─ sandboxed=false → Command::new(shell).arg("-c").arg(cmd)│
│    └─ sandboxed=true  → SandboxExecutor::execute(cmd, profile)│
│                                                               │
│  SandboxExecutor (trait)                                      │
│    ├─ LinuxSandbox   → bwrap --ro-bind ... -- bash -c "cmd"  │
│    ├─ MacSandbox     → sandbox-exec -p "profile" zsh -c "cmd"│
│    └─ WindowsSandbox → AppContainer + Job Objects             │
│                                                               │
│  New Tauri Commands:                                          │
│    ├─ sandbox_check_status   → SandboxStatusResult            │
│    └─ sandbox_install_runtime → SandboxInstallResult          │
└───────────────────────────────────────────────────────────────┘
```

## Files to Create/Modify

### New Files (Rust)

| File | Purpose |
|------|---------|
| `tauri/src/sandbox/mod.rs` | SandboxExecutor trait + SandboxProfile struct |
| `tauri/src/sandbox/linux.rs` | LinuxSandbox: bubblewrap invocation |
| `tauri/src/sandbox/macos.rs` | MacSandbox: sandbox-exec + SBPL profile generation |
| `tauri/src/sandbox/windows.rs` | WindowsSandbox: AppContainer + Job Objects |
| `tauri/src/sandbox/status.rs` | Sandbox runtime detection + auto-install |

### New Files (TypeScript)

| File | Purpose |
|------|---------|
| `src/desktop/tools/terminal/SandboxManager.ts` | Sandbox config management, status checking |

### Modified Files

| File | Changes |
|------|---------|
| `tauri/src/terminal_commands.rs` | Add sandbox parameters, route to SandboxExecutor |
| `tauri/src/main.rs` | Register new Tauri commands |
| `tauri/Cargo.toml` | Add `which`, `tempfile`, Windows crate deps |
| `src/desktop/tools/terminal/TerminalTool.ts` | Add `sandboxed` param, mode resolution logic |
| `src/desktop/tools/terminal/SecurityFilter.ts` | No changes (blocklist applies regardless) |
| `src/desktop/tools/terminal/index.ts` | Export SandboxManager |
| `src/desktop/tools/registerDesktopTools.ts` | Pass sandbox config to tool, update schema |
| `src/extension/sidepanel/ToolsSettings.svelte` | Add execution mode + sandbox settings UI |

## Implementation Order

1. **Rust sandbox module** — Create `tauri/src/sandbox/` with trait + Linux bwrap implementation
2. **Extend terminal_execute** — Add sandbox parameters to existing Tauri command
3. **Sandbox status commands** — Detection + auto-install
4. **TypeScript integration** — SandboxManager + TerminalTool mode resolution
5. **macOS sandbox-exec** — SBPL profile generation
6. **Windows AppContainer** — Win32 API integration
7. **Settings UI** — Execution mode selector + sandbox config
8. **Tool schema update** — LLM-facing description with sandbox context

## Key Design Decisions

- **Single Tauri command**: Extend `terminal_execute` rather than adding a separate sandboxed command
- **Network allowed by default**: Sandbox focuses on filesystem write restriction
- **Workspace access levels**: rw (default), ro, none — controls project dir mounting
- **LLM explicit choice**: `sandboxed` boolean in tool schema for auto mode
- **2-minute timeout**: Covers sandbox setup + command execution
- **Existing config storage**: Uses `config.json` via TauriConfigStorage
