# Tauri Command Contracts: Terminal Sandbox Mode

**Feature**: `016-terminal-sandbox-mode`
**Date**: 2026-02-12

## Modified Command: `terminal_execute`

Extends the existing `terminal_execute` Tauri command with sandbox parameters.

### Request Parameters

| Parameter        | Type                    | Required | Default   | Description                                      |
|------------------|-------------------------|----------|-----------|--------------------------------------------------|
| `command`        | string                  | yes      | —         | Shell command to execute                         |
| `cwd`            | string \| null          | no       | ~/ (%USERPROFILE%) | Working directory. Defaults to user home dir. Also used as the sandbox workspace (writable) directory. |
| `env`            | Map<string, string> \| null | no   | null      | Environment variables                            |
| `timeout`        | u64 \| null             | no       | 120000    | Timeout in ms (covers sandbox setup + execution) |
| `captureStdout`  | bool \| null            | no       | true      | Whether to capture stdout                        |
| `captureStderr`  | bool \| null            | no       | true      | Whether to capture stderr                        |
| `sandboxed`      | bool \| null            | no       | false     | Whether to run inside OS-native sandbox          |
| `workspaceAccess`| string \| null          | no       | "rw"      | Workspace mount mode: "rw", "ro", "none"         |
| `networkMode`    | string \| null          | no       | "host"    | Network mode: "sandbox", "host"                  |
| `bindMounts`     | BindMount[] \| null     | no       | []        | Additional host paths to mount                   |

### BindMount Object

| Field      | Type   | Description                              |
|------------|--------|------------------------------------------|
| `hostPath` | string | Absolute path on the host filesystem     |
| `access`   | string | Access level: "rw" or "ro"               |

### Response: TerminalResult

| Field        | Type   | Description                                    |
|--------------|--------|------------------------------------------------|
| `exitCode`   | i32    | Process exit code (-1 if failed to start)      |
| `stdout`     | string | Standard output (empty if not captured)        |
| `stderr`     | string | Standard error (empty if not captured)         |
| `sandboxed`  | bool   | Whether the command was actually sandboxed     |

### Error Response

Returns `String` error message for:
- Command timed out
- Failed to execute command
- Invalid sandbox configuration

Note: If sandbox runtime is not available and `sandboxed=true`, the command executes unsandboxed (graceful degradation). The `sandboxed` field in the response will be `false` and `stderr` will contain a warning.

---

## New Command: `sandbox_check_status`

Checks whether the sandbox runtime is available on the current platform.

### Request Parameters

None.

### Response: SandboxStatusResult

| Field     | Type   | Description                                                    |
|-----------|--------|----------------------------------------------------------------|
| `status`  | string | One of: "available", "unavailable", "needs-installation"       |
| `runtime` | string | Name of the sandbox runtime: "bwrap", "sandbox-exec", "appcontainer" |
| `os`      | string | Current OS: "linux", "macos", "windows"                        |
| `version` | string \| null | Runtime version string (if available)                   |
| `message` | string \| null | Human-readable status message                           |

---

## New Command: `sandbox_install_runtime`

Attempts to install the sandbox runtime (Linux only — installs bubblewrap).

### Request Parameters

None.

### Response: SandboxInstallResult

| Field     | Type   | Description                                      |
|-----------|--------|--------------------------------------------------|
| `success` | bool   | Whether installation succeeded                   |
| `message` | string | Human-readable result message                    |

### Error Response

Returns `String` error for:
- Not on Linux (macOS/Windows runtimes ship with the OS)
- Package manager not detected
- Installation command failed (includes stderr output)

---

## TypeScript Invocation Patterns

### Execute sandboxed command

```typescript
const result = await invoke<TerminalResult>('terminal_execute', {
  command: 'npm install',
  cwd: '/home/user/project',
  timeout: 120000,
  sandboxed: true,
  workspaceAccess: 'rw',
  networkMode: 'host',
  bindMounts: [
    { hostPath: '/home/user/.npmrc', access: 'ro' }
  ],
});
```

### Check sandbox status

```typescript
const status = await invoke<SandboxStatusResult>('sandbox_check_status');
// { status: 'available', runtime: 'bwrap', os: 'linux', version: '0.8.0' }
```

### Install sandbox runtime

```typescript
const result = await invoke<SandboxInstallResult>('sandbox_install_runtime');
// { success: true, message: 'bubblewrap installed successfully' }
```
