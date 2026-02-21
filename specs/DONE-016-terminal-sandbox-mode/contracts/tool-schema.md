# Tool Schema Contract: Terminal Tool with Sandbox

**Feature**: `016-terminal-sandbox-mode`
**Date**: 2026-02-12

## Updated Tool Definition

The terminal tool schema exposed to the LLM via `ToolRegistry`.

### Schema (JSON Schema format)

```json
{
  "name": "terminal",
  "description": "Execute terminal/shell commands on the local system. Running on {os} with {shell} shell. Write commands using {shell} syntax. Terminal execution mode: {mode}. {sandbox_context}",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "The command to execute"
      },
      "cwd": {
        "type": "string",
        "description": "Working directory (optional)"
      },
      "timeout": {
        "type": "number",
        "description": "Timeout in milliseconds (default: 120000)"
      },
      "sandboxed": {
        "type": "boolean",
        "description": "Whether to run in a sandboxed environment. Only applicable in 'auto' mode. When sandboxed=true, the command runs inside an OS-native sandbox that enforces: (1) file writes and deletes are RESTRICTED to the working directory (cwd), temp directories, and package manager caches — any attempt to create, modify, or delete files outside these paths will fail with a permission error; (2) file reads are allowed system-wide; (3) network access is allowed. Set sandboxed=true for commands that modify files, install packages, delete content, or carry elevated risk. Set sandboxed=false for read-only commands (ls, cat, git status, grep, find). Ignored in 'safe' mode (always sandboxed) and 'power' mode (never sandboxed)."
      }
    },
    "required": ["command"]
  }
}
```

### Dynamic Description Templates

The tool description varies based on execution mode and platform:

**Auto mode (default)**:
```
Execute terminal/shell commands on the local system. Running on Linux with bash shell. Write commands using bash syntax.

Terminal execution mode: auto. You decide whether each command should run sandboxed or directly.

SANDBOX RESTRICTIONS: When sandboxed=true, the OS-native sandbox enforces kernel-level restrictions:
- File writes and deletes are ONLY allowed within the working directory (cwd), temp directories, and package manager caches. Any attempt to create, modify, or delete files outside these paths will fail with a permission error (EROFS/EPERM/ACCESS_DENIED).
- File reads are allowed system-wide — you can read any file on the system.
- Network access is allowed — commands like curl, wget, npm install work normally.
- The command sees the real host filesystem (not a virtual environment), but write operations are restricted.

WHEN TO SANDBOX:
- sandboxed=true: Commands that create, modify, or delete files (rm, mv, cp, touch, mkdir, npm install, pip install, git checkout, sed -i, tee, write redirects >). Also use for running untrusted scripts.
- sandboxed=false: Read-only commands (ls, cat, head, tail, pwd, git status, git log, git diff, grep, find, echo, which, env, whoami, df, du, ps, top).
- When in doubt, prefer sandboxed=true.

Workspace access: {workspaceAccess} (rw = read-write, ro = read-only, none = no host file access).
Sandbox status: available (bubblewrap). Commands are filtered for safety.
```

**Safe mode**:
```
Execute terminal/shell commands on the local system. Running on Linux with bash shell. Write commands using bash syntax.

Terminal execution mode: safe. All commands run inside an OS-native sandbox with kernel-level restrictions:
- File writes and deletes are ONLY allowed within the working directory (cwd), temp directories, and package manager caches. Any attempt to create, modify, or delete files outside these paths will fail with a permission error.
- File reads are allowed system-wide.
- Network access is allowed.
Workspace access: {workspaceAccess}.
The sandboxed parameter is ignored — all commands are sandboxed. Commands are filtered for safety.
```

**Power mode**:
```
Execute terminal/shell commands on the local system. Running on Linux with bash shell. Write commands using bash syntax.

Terminal execution mode: power. Commands run directly on the host system without sandbox restrictions. Full read/write/delete access to the entire filesystem. The sandboxed parameter is ignored. Commands are filtered for safety.
```

### ExecuteResult Extension

The result returned to the LLM includes sandbox execution context:

```typescript
interface ExecuteResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  blocked?: boolean;
  blockedReason?: string;
  error?: string;
  sandboxed: boolean;  // NEW — whether command was actually sandboxed
}
```

The `sandboxed` field in the result tells the LLM whether the command was actually run in a sandbox, regardless of what was requested. This is important for:
- Auto mode: confirms the LLM's choice was honored
- Safe mode: always `true` (when sandbox available)
- Power mode: always `false`
- Sandbox unavailable: `false` even if requested — command still executes unsandboxed with a warning (graceful degradation, never blocks execution)
