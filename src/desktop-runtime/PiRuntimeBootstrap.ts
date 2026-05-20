import { ServerAgentBootstrap, type ServerAgentBootstrapOptions } from '@/server/agent/ServerAgentBootstrap';
import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import { getDesktopRuntimeHost } from './host';

/**
 * Public options for the desktop runtime sidecar's bootstrap.
 *
 * The desktop-runtime invariants are enforced internally — callers cannot
 * downgrade the profile or aim the bootstrap at a server data directory.
 */
export interface PiRuntimeBootstrapOptions {
  /** ChannelAdapter for runtime↔UI traffic; in production this is the stdio channel. */
  channel: ChannelAdapter;
  /**
   * Optional override for the data directory used by subsystems that don't
   * yet route through the desktop runtime host paths. Defaults to the host's
   * configDir. Tests use this to point at a temp directory.
   */
  dataDirOverride?: string;
}

/**
 * Desktop runtime sidecar bootstrap. Thin specialization over
 * {@link ServerAgentBootstrap} that locks in `profile='desktop-runtime'` and
 * resolves the data directory from {@link getDesktopRuntimeHost}.
 *
 * The "parameterization" required by Track 43 design.md (channel, platform
 * adapter, storage set, scheduler set, auth set, runtime host paths, control
 * bridge clients) is implemented as profile-branching inside
 * `ServerAgentBootstrap` — every branch keyed on `profile === 'desktop-runtime'`
 * substitutes the desktop wiring:
 *
 *   - **Channel**:           the channel passed here (StdioRuntimeChannel in
 *                            production; a test channel in unit tests).
 *   - **Platform adapter**:  DesktopRuntimePlatformAdapter
 *                            (platformId='desktop').
 *   - **Storage set**:       DesktopRuntimeStorageProvider /
 *                            DesktopRuntimeSQLiteAdapter /
 *                            DesktopRuntimeConfigStorageProvider against the
 *                            existing Rust-created file paths.
 *   - **Rollout storage**:   DesktopRuntimeRolloutStorageProvider over the
 *                            existing rollouts.db.
 *   - **Scheduler set**:     scheduler/execution storages backed by the
 *                            desktop SQLite file; OS-trust ops route to Rust
 *                            via control-frame bridges (scheduler.*,
 *                            notification.*, deeplink.*).
 *   - **Auth set**:          AuthManager constructed with a tokenGetter that
 *                            reads from the runtime credential store
 *                            (ControlFrameCredentialStore → keychain.* control
 *                            frames). Note: NO WebView tokenGetter functions
 *                            cross IPC — the runtime owns credentials.
 *   - **Runtime host paths**: {@link getDesktopRuntimeHost} returns the
 *                            resolved configDir, storageDbPath, rolloutDbPath,
 *                            configJsonPath, cacheDir, logDir,
 *                            browserMcpSidecarPath, projectRoot, keychain
 *                            service prefix, platform, arch.
 *   - **Prompt persona**:    `applepi` (the desktop persona), NOT
 *                            `applepi-server`.
 *   - **Server-only suppression**: backup manager, connector loader, health
 *                            HTTP, diagnostics monitor, config-file watcher
 *                            are all disabled.
 */
export class PiRuntimeBootstrap extends ServerAgentBootstrap {
  constructor(options: PiRuntimeBootstrapOptions) {
    const host = getDesktopRuntimeHost();
    const serverOptions: ServerAgentBootstrapOptions = {
      profile: 'desktop-runtime',
      dataDir: options.dataDirOverride ?? host.configDir,
      channel: options.channel,
    };
    super(serverOptions);
  }
}
