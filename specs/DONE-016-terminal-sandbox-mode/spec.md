# Feature Specification: Terminal Sandbox Mode

**Feature Branch**: `016-terminal-sandbox-mode`
**Created**: 2026-02-12
**Status**: Draft
**Input**: User description: "Add OS-native container/sandbox execution modes (safe/power/auto) to the terminal command tool"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Safe Mode Enforced Sandboxing (Priority: P1)

A user working on a project wants maximum protection when the AI assistant executes terminal commands. They enable "safe mode" in settings, which ensures every command runs inside an OS-native sandbox. The sandbox restricts filesystem writes to only the project working directory, allows network access by default, and provides process isolation. If the sandbox cannot be established (e.g., missing system component), the command continues to execute unsandboxed but with a clear warning to the user indicating that sandbox protection is unavailable.

**Why this priority**: This is the core value proposition — protecting users from unintended side effects of AI-executed commands. Without safe mode, users must trust that every command the AI generates is correct, which creates risk for system integrity.

**Independent Test**: Can be fully tested by enabling safe mode in settings, running a series of commands (both safe and risky), and verifying that all execute within the sandbox. Attempting to write outside the project directory or access the network should fail.

**Acceptance Scenarios**:

1. **Given** safe mode is enabled and the user is on Linux, **When** the AI executes `ls -la`, **Then** the command runs inside a bubblewrap sandbox and returns results normally.
2. **Given** safe mode is enabled, **When** the AI executes a command that writes to a path outside the project directory (e.g., `echo "test" > /etc/test`), **Then** the command fails with a permission/access error from the sandbox.
3. **Given** safe mode is enabled on macOS, **When** the AI executes `curl https://example.com`, **Then** the command succeeds because network access is allowed by default in the sandbox.
4. **Given** safe mode is enabled and the sandbox runtime is not available (e.g., bubblewrap not installed on Linux), **When** the system detects this on startup, **Then** the system automatically installs the required sandbox tool. If installation fails, commands continue to execute unsandboxed with a clear warning displayed to the user.
5. **Given** safe mode is enabled, **When** the AI executes `npm install` in the project directory, **Then** the command succeeds because the sandbox allows writes to the project directory and network access is allowed by default.

---

### User Story 2 - Auto Mode with LLM Decision Making (Priority: P1)

A user wants the AI assistant to intelligently decide whether each command needs sandbox protection. In auto mode (the default), the system provides the AI with execution mode context and risk information. The AI evaluates each command and decides whether to run it directly (for safe, routine commands) or in the sandbox (for commands that modify the filesystem, access the network, or carry elevated risk).

**Why this priority**: Auto mode is the default experience for all users. It balances safety with convenience — read-only commands like `ls`, `cat`, and `git status` run directly for speed, while potentially risky commands like `rm`, `npm install`, or `curl` run sandboxed.

**Independent Test**: Can be tested by leaving the default auto mode, issuing a mix of safe and risky commands, and verifying that the AI correctly routes each to direct or sandboxed execution. The execution mode chosen should be visible in the command output.

**Acceptance Scenarios**:

1. **Given** auto mode is active, **When** the AI decides to run `git status`, **Then** it executes directly without sandbox overhead because it is a read-only command.
2. **Given** auto mode is active, **When** the AI decides to run `rm -r node_modules`, **Then** it executes inside the sandbox because the command deletes files.
3. **Given** auto mode is active, **When** the AI executes any command, **Then** the result indicates which execution mode was used (sandboxed or direct).
4. **Given** auto mode is active, **When** the AI receives the tool definition, **Then** it includes context about the available execution modes and guidance on when to use each.

---

### User Story 3 - Power Mode for Unrestricted Execution (Priority: P2)

An advanced user who understands the risks wants maximum speed and no sandbox overhead. They enable "power mode" in settings, which executes all commands directly on the host OS without any container isolation. The existing security blocklist still applies (fork bombs, `rm -rf /`, etc.) to prevent catastrophic mistakes, but no filesystem or network restrictions are imposed.

**Why this priority**: Power mode serves experienced developers who prioritize speed and full system access. It is opt-in and preserves the existing security filter as a safety net.

**Independent Test**: Can be tested by enabling power mode, running commands, and verifying they execute directly with full system access. Blocklisted commands should still be blocked.

**Acceptance Scenarios**:

1. **Given** power mode is enabled, **When** the AI executes `ls -la /etc`, **Then** the command runs directly on the host shell and returns full results.
2. **Given** power mode is enabled, **When** the AI executes `rm -rf /`, **Then** the command is still blocked by the security filter blocklist.
3. **Given** power mode is enabled, **When** the AI executes `curl https://api.example.com`, **Then** the command succeeds with full network access.

---

### User Story 4 - Execution Mode Settings (Priority: P2)

A user wants to change the terminal execution mode through the application settings. They can choose between safe, power, or auto mode. The setting persists across sessions. When changed, it takes effect for the next command execution without requiring an app restart.

**Why this priority**: Settings provide user control over their security posture. Without configurable settings, users are locked into one mode.

**Independent Test**: Can be tested by changing the execution mode in settings and verifying the next command uses the new mode.

**Acceptance Scenarios**:

1. **Given** the user opens settings, **When** they navigate to terminal settings, **Then** they see the execution mode option with three choices: safe, power, and auto (default).
2. **Given** the user changes from auto to safe mode, **When** the AI executes the next command, **Then** it runs inside the sandbox.
3. **Given** the user sets power mode, **When** they close and reopen the app, **Then** power mode is still selected.

---

### User Story 5 - Platform-Specific Sandbox Availability (Priority: P3)

A user on any supported platform (Linux, macOS, Windows) can use safe mode with the appropriate OS-native sandbox technology. The system automatically selects and configures the correct sandbox for the current platform. If a required component is missing (e.g., bubblewrap on Linux), the system attempts to install it automatically.

**Why this priority**: Cross-platform support ensures all users can benefit from sandboxing, but each platform uses a different native mechanism, making this a complex implementation concern.

**Independent Test**: Can be tested on each platform by enabling safe mode and verifying the correct sandbox technology is used (bubblewrap on Linux, sandbox-exec on macOS, AppContainer on Windows).

**Acceptance Scenarios**:

1. **Given** a Linux system without bubblewrap installed, **When** the user enables safe mode, **Then** the system detects that bubblewrap is missing and attempts to install it via the system package manager.
2. **Given** a macOS system, **When** safe mode is enabled, **Then** commands execute via sandbox-exec with a dynamically generated Seatbelt profile.
3. **Given** a Windows system, **When** safe mode is enabled, **Then** commands execute inside an AppContainer with restricted filesystem and network access.
4. **Given** bubblewrap installation fails on Linux (e.g., no sudo access), **When** the user tries to enable safe mode, **Then** the system shows a clear message explaining what is needed and how to install it manually.

---

### User Story 6 - Sandbox Access Controls (Priority: P2)

A user wants fine-grained control over how the sandbox interacts with their real system. There are three main ways a sandboxed command can touch the host: workspace access (how the project directory is mounted), explicit bind mounts (additional host paths exposed to the sandbox), and network mode (whether the sandbox shares the host network). The user can configure these in settings to tighten or loosen the sandbox boundary based on their needs.

**Why this priority**: The three execution modes (safe/power/auto) control *whether* to sandbox, but access controls determine *how restrictive* the sandbox is. This gives advanced users the ability to tune the sandbox to their workflow — e.g., read-only workspace for code review, or mounting `~/.ssh` for git operations over SSH.

**Independent Test**: Can be tested by configuring each access control dimension independently and verifying the sandbox enforces the configured restrictions. For example, setting workspace access to read-only and verifying that write commands fail inside the sandbox.

**Acceptance Scenarios**:

1. **Given** workspace access is set to `rw` (read-write, the default), **When** a sandboxed command writes a file to the project directory, **Then** the file is written to the real project directory on the host.
2. **Given** workspace access is set to `ro` (read-only), **When** a sandboxed command attempts to write to the project directory, **Then** the write fails with a permission error.
3. **Given** workspace access is set to `none`, **When** a sandboxed command attempts to read files in the project directory, **Then** it cannot see any host project files.
4. **Given** an explicit bind mount is configured (e.g., `~/.ssh` mounted read-only), **When** a sandboxed command runs `git clone` via SSH, **Then** it succeeds because the SSH keys are accessible inside the sandbox.
5. **Given** network mode is set to `host` (the default), **When** a sandboxed command connects to a local development server on the host, **Then** it succeeds because the sandbox shares the host network stack.
6. **Given** network mode is set to `sandbox` (isolated), **When** a sandboxed command attempts to connect to a service on localhost, **Then** it can reach external network but cannot access host-local services.

---

### Edge Cases

- Network access is allowed by default in the sandbox, so commands like `npm install` and `pip install` work without special handling.
- What happens when the sandbox itself crashes or fails mid-execution? The system should return the sandbox process exit code and stderr with clear messaging. If sandbox setup fails before the command runs, the command should fall back to unsandboxed execution with a warning.
- What happens when a command requires write access to paths outside the project directory (e.g., `~/.npmrc`, `/tmp`)? The sandbox profile should include common ancillary paths (temp directories, package manager config) as writable.
- What happens when the user switches modes while a command is running? The mode change should apply to the next command, not affect the currently running one.
- What happens when the LLM in auto mode incorrectly chooses direct execution for a risky command? The existing SecurityFilter blocklist still applies as a safety net regardless of execution mode.
- What happens on an older Linux kernel that does not support bubblewrap? The system should detect this and inform the user that safe mode requires bubblewrap, falling back gracefully.
- What happens when the project working directory is on a network mount or symlinked path? The sandbox must resolve real paths correctly to apply write permissions.
- What happens when a user configures a bind mount to a path that doesn't exist? The system should validate bind mount paths at configuration time and warn the user.
- What happens when a bind mount overlaps with the workspace directory? The system should detect conflicts and use the most specific mount configuration.
- What happens when network mode is `host` but the platform sandbox doesn't support shared networking? The system should warn the user and document platform limitations.
- What happens when workspace access is `none` but the command needs to operate on project files? The command will fail — this is the intended behavior for maximum isolation, and the LLM should be informed of the workspace access level.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support three terminal execution modes: `safe` (always sandboxed), `power` (never sandboxed), and `auto` (LLM decides per-command). The default mode MUST be `auto`.
- **FR-002**: In `safe` mode, the system MUST execute every terminal command inside an OS-native sandbox. If the sandbox cannot be established, the command MUST continue to execute unsandboxed but MUST display a clear warning to the user indicating that sandbox protection is unavailable.
- **FR-003**: In `power` mode, the system MUST execute commands directly on the host OS shell. The existing security filter blocklist MUST still be enforced.
- **FR-004**: In `auto` mode, the system MUST provide the LLM with execution mode context (available modes, current sandbox capability, command risk level) so the LLM can choose between sandboxed and direct execution for each command. The tool schema MUST include a `sandboxed` boolean parameter that the LLM explicitly sets per invocation to indicate its choice.
- **FR-005**: On Linux, the system MUST use bubblewrap (`bwrap`) as the sandbox runtime. If bubblewrap is not installed, the system MUST attempt to install it automatically via the system package manager (`apt`, `dnf`, `pacman`).
- **FR-006**: On macOS, the system MUST use `sandbox-exec` with dynamically generated Seatbelt (SBPL) profiles as the sandbox runtime.
- **FR-007**: On Windows, the system MUST use AppContainer with Job Objects as the sandbox runtime.
- **FR-008**: The sandbox MUST restrict filesystem write and delete operations to the **workspace directory** and a set of **standard writable paths**. Read access MUST be allowed system-wide. The writable scope is:
  - **Workspace directory**: The `cwd` passed to the command. If no `cwd` is specified, defaults to the user's home directory (`~/` on Linux/macOS, `%USERPROFILE%` on Windows). This is the directory the LLM or user designates as the active working directory for the command. It changes per command invocation based on the `cwd` parameter.
  - **Standard temporary directories**: `/tmp`, platform temp dirs (`/private/var/folders` on macOS, `%TEMP%` on Windows), and the user's cache directory (`~/.cache`).
  - **Package manager caches**: `~/.npm`, `~/.yarn`, `~/.cache/pip`, `~/.cargo`, `~/.local` — common writable paths that package managers and build tools require.
  - **User-configured bind mounts**: Any additional paths the user has explicitly allowed via FR-019.
  - Any write or delete attempt outside these paths MUST be blocked by the kernel-level sandbox with a permission error.
- **FR-009**: The sandbox MUST allow network access by default. The sandbox primarily restricts filesystem writes and process scope.
- **FR-010**: The execution mode setting MUST be user-configurable through the application settings interface and MUST persist across sessions.
- **FR-011**: The command execution result MUST indicate which execution mode was used (sandboxed or direct) so the LLM and user can verify the execution context.
- **FR-012**: Only the terminal tool commands MUST be sandboxed. The application itself MUST continue to run directly on the host OS without container isolation.
- **FR-013**: The system MUST detect sandbox runtime availability at startup and report the sandbox status (available, unavailable, or needs installation) to the settings interface.
- **FR-014**: The sandbox MUST enforce process isolation where the platform supports it (PID namespace on Linux via bubblewrap, process restrictions on macOS via Seatbelt, process isolation on Windows via AppContainer).
- **FR-015**: In `auto` mode, the LLM's execution mode choice MUST still be subject to the SecurityFilter — the blocklist applies regardless of which execution mode the LLM selects.
- **FR-016**: The system MUST log sandbox-related events to the existing application log, including: execution mode used per command, sandbox violation blocks, sandbox runtime status changes, and sandbox installation events.
- **FR-017**: The default command timeout MUST be extended to 2 minutes (120 seconds). A single timeout MUST cover the entire execution lifecycle including sandbox setup and command execution.
- **FR-018**: The sandbox MUST support a configurable **workspace access** level that controls how the project directory is mounted: `rw` (read-write, default — the agent can create, delete, and modify files in the project directory), `ro` (read-only — the agent can only read project files), or `none` (the agent cannot see host project files at all).
- **FR-019**: The sandbox MUST support user-configurable **explicit bind mounts** that expose additional host paths into the sandbox. Each bind mount MUST specify a host path and an access level (`rw` or `ro`). This allows users to selectively grant access to paths outside the project directory (e.g., `~/.ssh` for git SSH operations, `~/.config` for tool configs).
- **FR-020**: The sandbox MUST support a configurable **network mode**: `host` (default — shares the host network stack, allowing access to localhost services like local databases and dev servers) or `sandbox` (full external network access but isolated from host-local services).
- **FR-021**: Workspace access, bind mounts, and network mode settings MUST be user-configurable through the settings interface and MUST persist across sessions.

### Key Entities

- **Execution Mode**: The terminal execution strategy (`safe`, `power`, `auto`). Determines how commands are dispatched. Stored as a user preference.
- **Sandbox Profile**: A platform-specific configuration that defines what the sandboxed process can access. Composed from three access control dimensions (workspace access, bind mounts, network mode) plus platform defaults. Generated dynamically per command based on the working directory and user configuration.
- **Workspace Access**: Controls how the project directory is mounted into the sandbox (`rw`, `ro`, or `none`). The most common impact point between sandbox and host.
- **Bind Mount**: An explicit user-configured mapping that exposes an additional host path into the sandbox with a specified access level (`rw` or `ro`). Allows selective "piercing" of the sandbox boundary for specific needs (e.g., SSH keys, tool configs).
- **Network Mode**: Controls the sandbox's network isolation level: `sandbox` (external network access, isolated from host-local services) or `host` (shares the host network stack).
- **Sandbox Runtime**: The platform-specific sandbox implementation (bubblewrap on Linux, sandbox-exec on macOS, AppContainer on Windows). Detected and managed by the system.
- **Sandbox Status**: The availability state of the sandbox runtime on the current platform (available, unavailable, needs-installation, installing). Checked at startup and exposed to settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Commands in safe mode that attempt to write outside allowed directories (project directory, temp directories, configured bind mounts) are blocked 100% of the time by the sandbox.
- **SC-002**: Workspace access levels (`rw`, `ro`, `none`) are enforced correctly 100% of the time — read-only prevents writes, none prevents all access.
- **SC-003**: In auto mode, the LLM correctly identifies commands that benefit from sandboxing (file-modifying, network-accessing, privilege-escalating) at least 90% of the time.
- **SC-004**: Sandbox overhead adds no more than 500ms to command startup time compared to direct execution.
- **SC-005**: Safe mode is functional on all three supported platforms (Linux, macOS, Windows) using each platform's native sandbox technology.
- **SC-006**: When a sandbox runtime is missing on Linux, automatic installation succeeds without user intervention on systems where the user has package manager access.
- **SC-007**: The execution mode setting is discoverable in the settings interface and changeable in under 3 clicks/interactions.
- **SC-008**: 100% of commands blocked by the SecurityFilter blocklist remain blocked regardless of execution mode (safe, power, or auto).

## Clarifications

### Session 2026-02-12

- Q: In auto mode, how does the LLM communicate its sandbox decision to the system? → A: The tool schema includes a `sandboxed` boolean parameter the LLM explicitly sets per invocation.
- Q: How should the system determine which sandboxed commands get network access? → A: Network access is allowed by default in the sandbox. The sandbox primarily restricts filesystem writes and process scope, not network.
- Q: Should the system log sandbox-related events for debugging and auditing? → A: Yes, log sandbox decisions and violations to the existing app log (mode used, sandbox blocks, install events).
- Q: How should timeouts work for sandboxed commands? → A: Single timeout covers everything (sandbox setup + command execution). Default timeout extended to 2 minutes (120 seconds).
- Addition: Sandbox access controls — three configurable dimensions added: Workspace Access (`rw`/`ro`/`none`), Explicit Bind Mounts (additional host paths with access levels), Network Mode (`sandbox`/`host`). These control how the sandbox interacts with the real system.

## Assumptions

- **A-001**: Linux users on distributions shipping bubblewrap by default (Fedora, Ubuntu with Flatpak) will have the smoothest safe mode experience. Other distributions will require the auto-install step.
- **A-002**: macOS `sandbox-exec` remains functional despite its deprecated status, consistent with its continued use by Apple system services, Chromium, and other industry tools.
- **A-003**: Windows users are on Windows 10 or later, which provides the AppContainer APIs needed for sandboxing.
- **A-004**: The LLM can make reasonable sandbox routing decisions when provided with command risk context and execution mode descriptions in the tool definition.
- **A-005**: Common ancillary paths (temp directories, package manager caches, shell config files) are known per-platform and can be pre-configured in sandbox profiles.
- **A-006**: For Linux auto-install of bubblewrap, the system may need to prompt for elevated privileges (sudo). If the user declines or lacks sudo access, the system will provide manual installation instructions instead.
