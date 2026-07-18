# WorkX Managed Component Runtime

Status: Implemented
Date: 2026-07-17
First component: DuckDB CLI 1.5.4

## 1. Purpose

WorkX needs optional local capabilities such as analytical databases, language runtimes, media processors, OCR engines, and browser runtimes. Bundling every capability would make the base desktop package unnecessarily large, while installing tools into the operating system would require administrator access and create version/PATH conflicts.

The managed component runtime gives WorkX a third option: install trusted, version-pinned components on demand into a private per-user WorkX home. The user explicitly approves each installation. WorkX selects the artifact, verifies it, owns its lifecycle, and invokes its exact path without changing the system PATH.

## 2. WorkX Home Layout

The shared default root is `~/.workx`. `WORKX_HOME` may override it with an absolute path for development, enterprise policy, or portable environments.

```text
~/.workx/
├── components/                         # Persistent managed installations
│   └── duckdb/
│       └── 1.5.4/
│           └── linux-x64/
│               ├── component.json
│               ├── NOTICE.txt
│               └── bin/duckdb
├── downloads/                          # Partial downloads and cross-process locks
├── workspaces/                         # Ephemeral execution data
│   └── analysis/<job-id>/
├── plugins/                            # Existing plugin storage; unchanged
├── styles/                             # Existing user styles; unchanged
└── logs/
```

Existing Tauri configuration, SQLite databases, and OS-keychain data remain in their current platform-standard locations. This feature does not migrate or duplicate them.

## 3. Architecture

```text
Settings UI / attended desktop agent
                 |
                 v
       ComponentRuntimeHandle
                 |
                 v
        NodeComponentManager
          |       |       |
          |       |       +-- ComponentRunner -> exact executable path
          |       +---------- WorkXWorkspaceManager -> ephemeral job roots
          +------------------ ComponentCatalog -> trusted pinned metadata
```

Responsibilities:

- `ComponentCatalog`: validates and resolves trusted definitions and platform artifacts. It does not download or execute anything.
- `NodeComponentManager`: creates the private directories, downloads, verifies, installs, repairs, lists, leases, and removes components.
- `ComponentRunner`: invokes only catalog-resolved entrypoints with `shell: false`, a bounded timeout, and bounded output.
- `WorkXWorkspaceManager`: creates job-scoped directories, tracks activity, removes completed work, and sweeps abandoned idle workspaces.
- `ComponentRuntimeHandle`: keeps component failure non-fatal to the rest of WorkX and gives services a stable status endpoint.

Plugins and components remain different concepts. Plugins add WorkX behavior, skills, hooks, agents, commands, or MCP configuration. Components provide native executables or managed runtimes. A future plugin manifest may declare component capability dependencies without sharing installation code.

## 4. Trusted Component Contract

Every built-in component definition includes:

- Stable component ID and display metadata.
- Pinned version.
- Capability names.
- Logical entrypoints.
- Platform-specific artifact URL, exact byte size, SHA-256, archive entry, and extracted-size limit.
- Post-install health check.
- Publisher, source repository, trusted HTTPS origins, homepage, and license.

The model cannot supply or override a URL, checksum, executable path, version, or archive entry. It may request only a component ID already present in the catalog.

## 5. Installation Transaction

Installation is an atomic, fail-closed transaction:

1. Resolve the component and current OS/architecture in the trusted catalog.
2. Acquire an in-process promise and a cross-process filesystem lock.
3. Stream the artifact into `~/.workx/downloads` with a hard expected-size bound.
4. Require the final byte count to exactly match the catalog.
5. Compute and compare SHA-256 before decompression.
6. Extract only the declared single-file entry into a staging directory.
7. Enforce the maximum extracted size and executable permissions.
8. Write component provenance, license notice, entrypoint hashes, and install metadata.
9. Run the pinned health check without a shell.
10. Rename the staging directory into its versioned final location.
11. Delete the archive and staging directory on both success and failure.

An existing valid installation is verified and reused. A corrupt installation is repaired through the same transaction. Multiple versions can coexist because version and platform are path segments.

## 6. Consent and Access Policy

There are two installation entrypoints:

- Settings: clicking Install opens a confirmation showing component, version, download size, destination, and the fact that system PATH is unchanged.
- Agent: `component_install` passes through the desktop approval system.

Component installation is an explicit consent boundary. The approval system's `requiresExplicitUserApproval` flag forces a fresh human response even in YOLO mode and ignores remembered session decisions or plugin approval hooks. A trusted-context `hardDeny` rejects remote, unattended, app-server, scheduler, connector, and sub-agent installation attempts before any prompt is shown.

Management services independently require the `desktop-runtime-main` Tauri channel. Tool handlers independently re-check the immutable original turn snapshot. These repeated checks prevent a registration or approval regression from becoming authorization.

## 7. Execution and Uninstallation

Callers request `(componentId, entrypoint)` rather than a filesystem path. The manager validates the installed record and returns an exact path under the component root.

`ComponentRunner`:

- Requires an absolute workspace path.
- Uses `spawn` with `shell: false`.
- Adds only child-process environment values; it does not mutate WorkX or system PATH.
- Applies timeout and combined stdout/stderr byte limits.
- Holds a component lease for the process lifetime.

Uninstall is rejected while a component has an active lease. Release is idempotent. This prevents deletion during managed execution and handles Windows' stricter executable-file semantics.

## 8. Workspace Lifecycle

Managed components are persistent. Query data, generated scripts, local database files, and intermediate results belong in a workspace and are ephemeral.

Each workspace has a marker containing identity, kind, owner PID, creation time, and last activity. Consumers refresh activity while a job runs. Completed jobs are removed immediately. The manager checks every minute and removes same-process workspaces idle for five minutes; abandoned workspaces from dead processes are also removed. Live workspaces owned by another WorkX process are not deleted.

The component runtime currently supplies this lifecycle API. Future agent-facing staging and sandboxed-computation tools will use it for bounded PostgreSQL/MySQL results, DuckDB databases, scripts, and derived artifacts. Those tools remain composable so the model can choose a strategy rather than being forced through one analysis orchestrator.

## 9. DuckDB First Component

DuckDB 1.5.4 is pinned from the official GitHub release for:

- Linux x64 and ARM64.
- macOS Intel and Apple Silicon.
- Windows x64 and ARM64.

Each platform artifact has its release-published byte size and SHA-256 embedded in the catalog. The health check runs `duckdb -version` and requires version 1.5.4. The executable is not added to PATH.

Installing DuckDB makes the local engine available to trusted WorkX runtime code. It does not by itself implement cross-source staging or expose unrestricted SQL/shell execution to the model.

## 10. User Interface

Settings includes a desktop-only Components page showing:

- Component state: not installed, installed, needs repair, or unsupported.
- Version and platform.
- Download and installed sizes.
- Capabilities and license.
- Install/repair, verify, and remove operations.
- The resolved private component directory.

Component-runtime initialization is non-fatal. If it fails, the page shows a retryable unavailable state while the rest of WorkX remains usable.

## 11. Verification

Committed tests cover:

- Catalog trust, hashes, duplicates, IDs, origins, and platform selection.
- WorkX home resolution and safe absolute override behavior.
- Install progress, exact sizes, checksums, extraction, health checks, records, leases, repair, deduplication, cleanup, and unsupported targets.
- Process execution, no-shell invocation, timeouts, output limits, and release.
- Workspace create/touch/remove/idle-sweep behavior and path traversal denial.
- Desktop management service authorization.
- Agent snapshot propagation, mandatory approval in YOLO mode, and remote hard denial.
- Settings disclosure, confirmation, install state, and unavailable behavior.
- An opt-in integration test that downloads the real official DuckDB artifact, verifies it, executes it, and uninstalls it from a temporary WorkX home.

Run the live component acceptance case with:

```bash
WORKX_TEST_COMPONENT_DOWNLOAD=true \
  npx vitest run src/desktop-runtime/components/__tests__/duckdb-download.integration.test.ts
```

## 12. Deferred Extensions

- Signed remote WorkX catalogs and enterprise mirror support.
- HTTP proxy/auth configuration and resumable downloads.
- Update/rollback UI across multiple installed versions.
- Per-component disk quotas and least-recently-used cleanup.
- Multi-file archive extractors and platform code-signing/notarization validation.
- Plugin-declared component capability dependencies.
- Agent-facing bounded staging and sandboxed component-execution tools that can invoke DuckDB.
- A separately downloadable, sandboxed Python analysis runtime.
