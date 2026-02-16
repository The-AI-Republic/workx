# Data Model: Terminal Sandbox Mode

**Feature**: `016-terminal-sandbox-mode`
**Date**: 2026-02-12

## Entities

### ExecutionMode (enum)

The user's chosen terminal execution strategy.

| Value   | Description                                           |
|---------|-------------------------------------------------------|
| `safe`  | Always execute commands inside the OS-native sandbox  |
| `power` | Always execute commands directly on the host shell    |
| `auto`  | LLM decides per-command (default)                     |

**Stored as**: string in `config.json` at key `terminal.executionMode`
**Default**: `auto`

### WorkspaceAccess (enum)

Controls how the project directory is mounted into the sandbox.

| Value  | Description                                              |
|--------|----------------------------------------------------------|
| `rw`   | Read-write — agent can create, delete, modify files      |
| `ro`   | Read-only — agent can only read project files             |
| `none` | No access — agent is completely blinded to host files     |

**Stored as**: string in `config.json` at key `terminal.sandbox.workspaceAccess`
**Default**: `rw`

### NetworkMode (enum)

Controls the sandbox's network isolation level.

| Value     | Description                                                        |
|-----------|--------------------------------------------------------------------|
| `sandbox` | Full external network access, isolated from host-local services    |
| `host`    | Shares the host network stack, can access localhost services       |

**Stored as**: string in `config.json` at key `terminal.sandbox.networkMode`
**Default**: `host` (network allowed by default per spec clarification)

### BindMount

An explicit user-configured mapping that exposes a host path into the sandbox.

| Field      | Type   | Description                                    |
|------------|--------|------------------------------------------------|
| `hostPath` | string | Absolute path on the host filesystem           |
| `access`   | string | Access level: `rw` or `ro`                     |

**Stored as**: JSON array in `config.json` at key `terminal.sandbox.bindMounts`
**Default**: `[]` (empty — only project dir and standard temp dirs are mounted)

### SandboxStatus

The runtime availability state of the sandbox on the current platform.

| Value              | Description                                              |
|--------------------|----------------------------------------------------------|
| `available`        | Sandbox runtime is installed and ready                   |
| `unavailable`      | Platform does not support sandboxing                     |
| `needs-installation` | Sandbox runtime can be installed (Linux/bwrap only)    |
| `installing`       | Installation is in progress                              |

**Stored as**: runtime state only (not persisted — detected at startup)

### SandboxProfile (runtime, not persisted)

A platform-specific configuration generated dynamically per command execution.

| Field              | Type           | Description                                                      |
|--------------------|----------------|------------------------------------------------------------------|
| `workspaceAccess`  | WorkspaceAccess| How workspace dir is mounted                                     |
| `workspaceDir`     | string         | The `cwd` for this command — the directory the sandbox allows writes to. Defaults to the user's home directory (`~/` on Linux/macOS, `%USERPROFILE%` on Windows) if no `cwd` is specified. Changes per command based on the `cwd` parameter passed by the LLM. |
| `standardWritable` | string[]       | Platform-specific standard writable paths (temp dirs, package manager caches) — auto-populated, not user-configured |
| `bindMounts`       | BindMount[]    | Additional user-configured host paths to mount                   |
| `networkMode`      | NetworkMode    | Network isolation level                                          |
| `timeout`          | number         | Execution timeout in milliseconds                                |

**Generated from**: User settings + command context (`cwd`)
**Used by**: Platform-specific sandbox executors (bwrap, sandbox-exec, AppContainer)

### Standard Writable Paths (auto-populated per platform)

These paths are always writable inside the sandbox (in addition to the workspace dir and user bind mounts):

| Path | Platform | Purpose |
|------|----------|---------|
| `/tmp` | Linux, macOS | Temporary files |
| `/private/var/folders` | macOS | macOS temp storage |
| `%TEMP%` / `%TMP%` | Windows | Windows temp storage |
| `~/.cache` | Linux, macOS | General cache directory |
| `~/.npm` | All | npm cache |
| `~/.yarn` | All | Yarn cache |
| `~/.cache/pip` | All | pip cache |
| `~/.cargo` | All | Cargo/Rust cache |
| `~/.local` | Linux, macOS | User-local installs (pip --user, etc.) |

These are included automatically so that common development commands (`npm install`, `pip install`, `cargo build`, etc.) work without requiring the user to configure bind mounts.

## State Transitions

### SandboxStatus Lifecycle

```
App Startup
  ├─ [Linux] Check bwrap → found → available
  ├─ [Linux] Check bwrap → not found → needs-installation
  │    └─ User triggers install → installing → available / unavailable
  ├─ [macOS] Check sandbox-exec → always present → available
  └─ [Windows] Check AppContainer API → Win10+ → available / unavailable
```

### Execution Mode Decision Flow

```
Command received
  ├─ mode = safe → always sandbox
  ├─ mode = power → never sandbox (SecurityFilter still applies)
  └─ mode = auto
       ├─ LLM sets sandboxed=true → sandbox
       └─ LLM sets sandboxed=false → direct execution
       (SecurityFilter blocklist applies in ALL cases)
```

## Config Storage Schema

All settings stored under the `terminal` namespace in `config.json`:

```json
{
  "terminal.executionMode": "auto",
  "terminal.sandbox.workspaceAccess": "rw",
  "terminal.sandbox.networkMode": "host",
  "terminal.sandbox.bindMounts": [
    { "hostPath": "~/.ssh", "access": "ro" },
    { "hostPath": "~/.gitconfig", "access": "ro" }
  ]
}
```

## Relationships

```
ExecutionMode ──determines──> whether SandboxProfile is generated
SandboxProfile ──composed from──> WorkspaceAccess + BindMount[] + NetworkMode
SandboxProfile ──consumed by──> Platform Sandbox Executor (bwrap / sandbox-exec / AppContainer)
SandboxStatus ──gates──> availability of safe mode and auto-mode sandboxing
SecurityFilter ──applies to──> ALL commands regardless of ExecutionMode
```
