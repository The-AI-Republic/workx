# Research: Terminal Sandbox Mode

**Feature**: `016-terminal-sandbox-mode`
**Date**: 2026-02-12

## Decision 1: Linux Sandbox Runtime

**Decision**: Use bubblewrap (`bwrap`) as the Linux sandbox runtime.

**Rationale**: Bubblewrap is the most practical unprivileged sandboxing tool for Linux. It composes namespaces, bind mounts, and seccomp into a single CLI invocation. It's used by Flatpak internally and is available in all major distro package repositories. It requires no root privileges when user namespaces are enabled (the common case). It can be invoked as a subprocess from Rust via `tokio::process::Command` with no special crate needed.

**Alternatives considered**:
- **Landlock + seccomp (kernel-native)**: No external dependency, but Landlock requires kernel 5.13+ and doesn't provide mount/PID namespace isolation. Would require maintaining BPF filter code. Better as a fallback layer, not primary.
- **Firejail**: More features but more complex, requires setuid installation on some distros, and the larger attack surface has led to security vulnerabilities.
- **Docker**: Heavyweight, requires Docker daemon installation, overkill for single-command sandboxing.

**Key implementation details**:
- Detection: `which bwrap` or `Command::new("bwrap").arg("--version")`
- Auto-install: Detect distro via `/etc/os-release`, then `apt install bubblewrap` / `dnf install bubblewrap` / `pacman -S bubblewrap`
- Invocation pattern:
  ```
  bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /etc /etc --symlink usr/lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp --bind <project_dir> <project_dir> --unshare-pid --unshare-ipc --new-session -- bash -c "<command>"
  ```
- Workspace access modes: `--bind` (rw), `--ro-bind` (ro), omit (none)
- Network: allowed by default (no `--unshare-net`); host mode = default behavior
- Bind mounts: additional `--bind`/`--ro-bind` args per user config

## Decision 2: macOS Sandbox Runtime

**Decision**: Use `sandbox-exec` with dynamically generated Seatbelt (SBPL) profiles.

**Rationale**: `sandbox-exec` is the only practical option for sandboxing arbitrary commands on macOS without requiring the user to install anything. It ships on every Mac since 10.5 (2007). Despite Apple marking it deprecated, it is still used by Apple's own system services, Chromium, Firefox, Anthropic's sandbox-runtime, OpenAI Codex CLI, and Google Gemini CLI. The SBPL profile language supports fine-grained per-path filesystem control with glob patterns.

**Alternatives considered**:
- **Apple Containerization Framework**: macOS 26+ only, Apple Silicon only, designed for Linux containers not macOS process isolation. Too new and heavyweight.
- **App Sandbox (entitlements)**: Applies to the entire app, not per-command. Requires code signing with specific entitlements. Not suitable for dynamic command sandboxing.

**Key implementation details**:
- Invocation: `sandbox-exec -p '<SBPL profile string>' zsh -c "<command>"`
- Can also use `-f <profile_file>` with a temp file for long profiles
- Profile generation: Build SBPL string dynamically from workspace access, bind mounts, and network mode settings
- Workspace access: `(allow file-write* (subpath "<project_dir>"))` for rw, `(allow file-read* (subpath ...))` for ro, omit for none
- Network: `(allow network*)` by default; can restrict with `(deny network*)`
- No PID namespace equivalent, but can restrict `process-exec*` and `process-fork`

## Decision 3: Windows Sandbox Runtime

**Decision**: Use AppContainer + Job Objects via the `windows` crate.

**Rationale**: AppContainer provides kernel-level process isolation built into Windows 8+. It restricts filesystem access, network capabilities, and process visibility. Job Objects complement it with resource limits (memory, CPU, process count). No admin required for per-user AppContainer profile creation. The `windows` crate provides complete Win32 API bindings in Rust.

**Alternatives considered**:
- **Windows Sandbox**: Requires Pro/Enterprise edition, Hyper-V, and boots a full Windows desktop. Way too heavyweight.
- **Restricted Tokens alone**: Don't provide namespace-level isolation. Weaker than AppContainer.
- **Microsoft LiteBox**: Experimental, not production-ready.

**Key implementation details**:
- Crates: `windows` (Win32 APIs), `win32job` (Job Objects), `windows-acl` (ACL management)
- Flow: `CreateAppContainerProfile()` → Set ACLs on project dir → `CreateProcessW()` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` → `AssignProcessToJobObject()`
- Workspace access: ACL grants on project directory (full access for rw, read-only for ro, no ACL for none)
- Network: Controlled by AppContainer capabilities (`internetClient` for external, omit for none)
- Most complex implementation of the three platforms

## Decision 4: Architecture — Modify Existing Command vs. New Command

**Decision**: Extend the existing `terminal_execute` Tauri command with a new `sandboxed` boolean parameter rather than creating a separate command.

**Rationale**: The existing terminal execution flow (security filter → Tauri invoke → shell execution) is the natural place to insert sandbox wrapping. Adding a separate command would duplicate timeout handling, output capture, and error handling logic. The TypeScript side already has a clean `execute()` method that can route based on the sandbox flag. This keeps the API surface minimal.

**Implementation**:
- Rust: Add `sandboxed: Option<bool>`, `workspaceAccess: Option<String>`, `networkMode: Option<String>`, `bindMounts: Option<Vec<BindMount>>` parameters to `terminal_execute`
- When `sandboxed=true`: wrap the command in platform-specific sandbox invocation before executing
- When `sandboxed=false` or `None`: execute directly (current behavior)

## Decision 5: Settings Storage

**Decision**: Use the existing `TauriConfigStorage` / `config.json` system for persisting execution mode and sandbox settings.

**Rationale**: The app already has a two-tier config storage system (TypeScript `TauriConfigStorage` → Rust `storage_commands.rs` → `config.json`). Terminal sandbox settings fit naturally as additional config keys. No new storage mechanism needed.

**Implementation**:
- Config keys: `terminal.executionMode` (safe/power/auto), `terminal.sandbox.workspaceAccess` (rw/ro/none), `terminal.sandbox.networkMode` (sandbox/host), `terminal.sandbox.bindMounts` (array)
- Read at `TerminalTool` initialization and on settings change
- Persist via existing `AgentConfig` → `ConfigStorage` → `config.json` flow

## Decision 6: LLM Tool Schema Extension

**Decision**: Add `sandboxed` boolean parameter to the terminal tool's JSON schema, with execution mode context in the tool description.

**Rationale**: Per the spec clarification (Q1), the LLM explicitly sets a `sandboxed` boolean per invocation in auto mode. The tool description provides guidance on when to sandbox. In safe mode, the parameter is ignored (always sandboxed). In power mode, the parameter is ignored (never sandboxed).

**Implementation**:
- Add to `TerminalTool.getToolDefinition()` inputSchema:
  ```typescript
  sandboxed: {
    type: 'boolean',
    description: 'Whether to execute in a sandboxed environment. In auto mode, set true for commands that modify files, install packages, or carry risk. Set false for read-only commands like ls, cat, git status.'
  }
  ```
- Update tool description to include execution mode context and sandbox capability status

## Decision 7: Cargo Dependencies

**Decision**: Add minimal dependencies — `which` for executable detection, `tempfile` for macOS SBPL profiles, and platform-specific crates only where needed.

**Rationale**: Keep dependency footprint small. `which` (finding bwrap in PATH) and `tempfile` (writing SBPL profiles) are lightweight. Windows crates (`windows`, `win32job`) are only compiled on Windows targets via `[target.'cfg(windows)'.dependencies]`.

**New dependencies**:
- `which = "7"` — Find executables in PATH (all platforms)
- `tempfile = "3"` — Temp file creation for SBPL profiles (macOS)
- `log = "0.4"` — Sandbox event logging (if not already present)
- `[target.'cfg(windows)'.dependencies]`: `windows`, `win32job`

## Decision 8: Edge Case Handling

### Path resolution (symlinks, network mounts)
All sandbox implementations MUST resolve paths to their real (canonical) form before applying write permissions. On the Rust side, use `std::fs::canonicalize()` on the workspace directory and bind mount paths before passing them to bwrap/sandbox-exec/AppContainer. This prevents symlink escapes (e.g., a symlink inside the workspace pointing to `/etc`) and ensures network-mounted paths resolve correctly.

### Mode switch during running command
Execution mode is read once at the start of each `terminal_execute` invocation. If the user changes the mode in settings while a command is running, the change takes effect on the next invocation only. No locking or synchronization needed — the mode is simply read from config at call time.

### Bind mount validation
Bind mount paths MUST be validated when the user saves settings:
- Check that the path exists on the host filesystem
- Check that the path is an absolute path
- Warn (but allow) if the path overlaps with the workspace directory — use the most specific mount (bind mount overrides workspace mount for overlapping subtrees)

### bwrap functional check (Linux)
Detection should go beyond `which bwrap`:
1. Check bwrap exists: `which bwrap`
2. Check bwrap is functional: run `bwrap --ro-bind /usr /usr -- /usr/bin/true` as a smoke test
3. If the smoke test fails (e.g., user namespaces disabled), report status as `unavailable` with a message explaining the kernel restriction

### Logging specification
Sandbox events logged to the existing app log with these categories:
- **INFO**: Execution mode used per command (`"Executing command in sandbox mode"` / `"Executing command directly"`)
- **INFO**: Sandbox runtime status at startup (`"Sandbox runtime: bwrap v0.8.0 available"`)
- **WARN**: Sandbox unavailable fallback (`"Sandbox unavailable, executing unsandboxed"`)
- **WARN**: Sandbox violation blocks (`"Sandbox blocked write to /etc/hosts"` — captured from stderr)
- **INFO**: Sandbox installation events (`"Installing bubblewrap via apt..."`, `"bubblewrap installed successfully"`)
- **ERROR**: Sandbox installation failure (`"Failed to install bubblewrap: <reason>"`)
