import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  ComponentCatalog,
  ComponentError,
  type ComponentArtifact,
  type ComponentDefinition,
  type ComponentInstallOptions,
  type ComponentLease,
  type ComponentManager,
  type ComponentPlatform,
  type ComponentRuntimeStatus,
  type ComponentView,
  type InstalledComponentRecord,
} from '@/core/components';
import type { WorkXPaths } from './workxPaths';
import { runManagedProcess } from './runManagedProcess';

const RECORD_FILE = 'component.json';
const NOTICE_FILE = 'NOTICE.txt';
const DOWNLOAD_STALE_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 60_000;

export interface NodeComponentManagerOptions {
  paths: WorkXPaths;
  platform: ComponentPlatform | null;
  catalog: ComponentCatalog;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  idFactory?: () => string;
  healthCheckRunner?: (
    executablePath: string,
    definition: ComponentDefinition,
    signal?: AbortSignal
  ) => Promise<void>;
}

interface InspectedInstallation {
  view: ComponentView;
  definition: ComponentDefinition;
  artifact?: ComponentArtifact;
  installDir?: string;
  record?: InstalledComponentRecord;
}

export class NodeComponentManager implements ComponentManager {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly healthCheckRunner?: NodeComponentManagerOptions['healthCheckRunner'];
  private readonly activeUses = new Map<string, number>();
  private readonly ownedLeaseFiles = new Set<string>();
  private readonly installs = new Map<string, Promise<ComponentView>>();
  private readonly lifetimeAbort = new AbortController();
  private initialized = false;
  private stopping = false;

  constructor(private readonly options: NodeComponentManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.healthCheckRunner = options.healthCheckRunner;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.options.paths.components, { recursive: true }),
      fs.mkdir(this.options.paths.downloads, { recursive: true }),
      fs.mkdir(this.options.paths.workspaces, { recursive: true }),
      fs.mkdir(this.options.paths.logs, { recursive: true }),
    ]);
    await this.cleanupStaleDownloads();
    this.initialized = true;
  }

  status(): ComponentRuntimeStatus {
    if (this.stopping) {
      return {
        state: 'stopping',
        available: false,
        rootPath: this.options.paths.root,
        componentsPath: this.options.paths.components,
        workspacesPath: this.options.paths.workspaces,
      };
    }
    return {
      state: this.initialized ? 'ready' : 'unavailable',
      available: this.initialized,
      rootPath: this.options.paths.root,
      componentsPath: this.options.paths.components,
      workspacesPath: this.options.paths.workspaces,
      ...(!this.initialized ? { errorCode: 'COMPONENTS_UNAVAILABLE' as const } : {}),
    };
  }

  async list(): Promise<ComponentView[]> {
    this.assertAvailable();
    return Promise.all(
      this.options.catalog.list().map((definition) => this.inspect(definition))
    ).then((items) => items.map((item) => item.view));
  }

  async get(componentId: string): Promise<ComponentView> {
    this.assertAvailable();
    return (await this.inspect(this.options.catalog.get(componentId))).view;
  }

  async install(
    componentId: string,
    options: ComponentInstallOptions = {}
  ): Promise<ComponentView> {
    this.assertAvailable();
    const existing = this.installs.get(componentId);
    if (existing) return existing;
    const operation = this.installOnce(componentId, options).finally(() => {
      if (this.installs.get(componentId) === operation) this.installs.delete(componentId);
    });
    this.installs.set(componentId, operation);
    return operation;
  }

  async verify(componentId: string, signal?: AbortSignal): Promise<ComponentView> {
    this.assertAvailable();
    this.throwIfAborted(signal);
    const inspected = await this.inspect(this.options.catalog.get(componentId));
    if (
      inspected.view.state !== 'installed' ||
      !inspected.record ||
      !inspected.installDir ||
      !inspected.artifact
    ) {
      throw new ComponentError(
        inspected.view.state === 'unsupported'
          ? 'COMPONENT_UNSUPPORTED'
          : 'COMPONENT_NOT_INSTALLED',
        `${inspected.definition.displayName} is not installed.`
      );
    }

    for (const [name, relativePath] of Object.entries(inspected.record.entrypoints)) {
      this.throwIfAborted(signal);
      const executablePath = this.safeJoin(inspected.installDir, relativePath);
      const stat = await fs.lstat(executablePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new ComponentError(
          'COMPONENT_INVALID',
          `${inspected.definition.displayName} entrypoint '${name}' is missing or unsafe.`
        );
      }
      const actualHash = await this.sha256File(executablePath);
      if (actualHash !== inspected.record.fileSha256[name]) {
        throw new ComponentError(
          'COMPONENT_INVALID',
          `${inspected.definition.displayName} failed its installed-file integrity check.`
        );
      }
    }

    await this.runHealthCheck(
      inspected.definition,
      inspected.installDir,
      inspected.record.entrypoints,
      signal
    );
    const nextRecord: InstalledComponentRecord = {
      ...inspected.record,
      lastVerifiedAt: this.now().toISOString(),
    };
    await this.writeRecord(inspected.installDir, nextRecord);
    return this.viewFrom(inspected.definition, inspected.artifact, 'installed', nextRecord);
  }

  async uninstall(componentId: string): Promise<void> {
    this.assertAvailable();
    const definition = this.options.catalog.get(componentId);
    await this.assertNotBusy(componentId, definition.displayName);
    if (!this.options.platform) return;
    await this.withFileLock(componentId, undefined, async () => {
      await this.assertNotBusy(componentId, definition.displayName);
      const installDir = this.installDir(definition, this.options.platform!);
      await fs.rm(installDir, { recursive: true, force: true });
      await this.removeEmptyParents(installDir, definition.id);
    });
  }

  async resolveEntrypoint(componentId: string, entrypoint: string): Promise<string> {
    const inspected = await this.inspect(this.options.catalog.get(componentId));
    if (inspected.view.state !== 'installed' || !inspected.record || !inspected.installDir) {
      throw new ComponentError(
        inspected.view.state === 'unsupported'
          ? 'COMPONENT_UNSUPPORTED'
          : 'COMPONENT_NOT_INSTALLED',
        `${inspected.definition.displayName} is not installed.`
      );
    }
    const relativePath = inspected.record.entrypoints[entrypoint];
    if (!relativePath) {
      throw new ComponentError(
        'COMPONENT_NOT_FOUND',
        `${inspected.definition.displayName} does not provide '${entrypoint}'.`
      );
    }
    return this.safeJoin(inspected.installDir, relativePath);
  }

  async acquireEntrypoint(componentId: string, entrypoint: string): Promise<ComponentLease> {
    this.assertAvailable();
    return this.withFileLock(componentId, undefined, async () => {
      const executablePath = await this.resolveEntrypoint(componentId, entrypoint);
      this.activeUses.set(componentId, (this.activeUses.get(componentId) ?? 0) + 1);
      let leaseFile: string | undefined;
      let component: ComponentView;
      try {
        leaseFile = await this.createLeaseFile(componentId);
        component = await this.get(componentId);
        await this.touchLastUsed(componentId).catch(() => undefined);
      } catch (error) {
        await this.releaseUse(componentId, leaseFile);
        throw error;
      }
      let released = false;
      return {
        component,
        executablePath,
        release: async () => {
          if (released) return;
          released = true;
          await this.releaseUse(componentId, leaseFile);
        },
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.lifetimeAbort.abort();
    await Promise.allSettled([...this.installs.values()]);
    this.installs.clear();
    if (this.activeUses.size === 0) {
      await Promise.allSettled(
        [...this.ownedLeaseFiles].map((lease) => fs.rm(lease, { force: true }))
      );
      this.ownedLeaseFiles.clear();
    }
  }

  private async installOnce(
    componentId: string,
    options: ComponentInstallOptions
  ): Promise<ComponentView> {
    const definition = this.options.catalog.get(componentId);
    if (!this.options.platform) {
      throw new ComponentError(
        'COMPONENT_UNSUPPORTED',
        `${definition.displayName} is unsupported on this operating system.`
      );
    }
    const artifact = this.options.catalog.resolveArtifact(componentId, this.options.platform);
    const signal = this.combinedSignal(options.signal);
    options.onProgress?.({ stage: 'preparing', componentId });

    return this.withFileLock(componentId, signal, async () => {
      const current = await this.inspect(definition);
      if (current.view.state === 'installed') {
        try {
          return await this.verify(componentId, signal);
        } catch {
          await this.assertNotBusy(componentId, definition.displayName);
        }
      }

      const installDir = this.installDir(definition, this.options.platform!);
      const parentDir = path.dirname(installDir);
      const operationId = this.idFactory();
      const stageDir = path.join(parentDir, `.install-${operationId}`);
      const archivePath = path.join(
        this.options.paths.downloads,
        `${definition.id}-${definition.version}-${this.options.platform}-${operationId}.zip.part`
      );
      await fs.mkdir(parentDir, { recursive: true });
      await fs.mkdir(stageDir, { recursive: true });

      try {
        await this.downloadArtifact(definition, artifact, archivePath, signal, options.onProgress);
        options.onProgress?.({ stage: 'verifying', componentId });
        const archiveHash = await this.sha256File(archivePath);
        if (archiveHash !== artifact.sha256) {
          throw new ComponentError(
            'COMPONENT_CHECKSUM_MISMATCH',
            `${definition.displayName} download failed its SHA-256 check.`
          );
        }

        options.onProgress?.({ stage: 'installing', componentId });
        const archiveBytes = await fs.readFile(archivePath);
        let files: Record<string, Uint8Array>;
        let targetEntrySeen = false;
        let targetEntryInvalid = false;
        try {
          files = unzipSync(archiveBytes, {
            filter: (entry) => {
              if (entry.name !== artifact.archive.entry) return false;
              if (
                targetEntrySeen ||
                entry.originalSize < 1 ||
                entry.originalSize > artifact.archive.maxExtractedBytes
              ) {
                targetEntryInvalid = true;
                return false;
              }
              targetEntrySeen = true;
              return true;
            },
          });
        } catch (error) {
          throw new ComponentError(
            'COMPONENT_ARCHIVE_INVALID',
            `${definition.displayName} download is not a valid ZIP archive.`,
            false,
            { cause: error }
          );
        }
        if (targetEntryInvalid) {
          throw new ComponentError(
            'COMPONENT_ARCHIVE_INVALID',
            `${definition.displayName} archive contains an invalid or oversized target entry.`
          );
        }
        const payload = files[artifact.archive.entry];
        if (!payload || payload.byteLength < 1) {
          throw new ComponentError(
            'COMPONENT_ARCHIVE_INVALID',
            `${definition.displayName} archive is missing '${artifact.archive.entry}'.`
          );
        }
        if (payload.byteLength > artifact.archive.maxExtractedBytes) {
          throw new ComponentError(
            'COMPONENT_ARCHIVE_INVALID',
            `${definition.displayName} extracted payload exceeds its safety limit.`
          );
        }

        const entrypoints = {
          ...definition.entrypoints,
          ...(artifact.entrypointOverrides ?? {}),
        };
        const targetRelativePath = entrypoints[artifact.archive.targetEntrypoint];
        const executablePath = this.safeJoin(stageDir, targetRelativePath);
        await fs.mkdir(path.dirname(executablePath), { recursive: true });
        await fs.writeFile(executablePath, payload, { mode: 0o755 });
        if (!artifact.platform.startsWith('win32-')) await fs.chmod(executablePath, 0o755);

        const fileSha256 = {
          [artifact.archive.targetEntrypoint]: createHash('sha256').update(payload).digest('hex'),
        };
        const installedAt = this.now().toISOString();
        const notice = [
          `${definition.displayName} ${definition.version}`,
          `Publisher: ${definition.source.publisher}`,
          `Source: ${definition.source.repository}`,
          `License: ${definition.license.name} (${definition.license.url})`,
          `Artifact: ${artifact.url}`,
          `Artifact SHA-256: ${artifact.sha256}`,
          '',
        ].join('\n');
        await fs.writeFile(path.join(stageDir, NOTICE_FILE), notice, 'utf8');
        const record: InstalledComponentRecord = {
          schemaVersion: 1,
          id: definition.id,
          version: definition.version,
          platform: artifact.platform,
          installedAt,
          lastVerifiedAt: installedAt,
          installedSizeBytes: payload.byteLength + Buffer.byteLength(notice),
          artifact: {
            url: artifact.url,
            sha256: artifact.sha256,
            downloadSizeBytes: artifact.downloadSizeBytes,
          },
          entrypoints,
          fileSha256,
        };
        await this.writeRecord(stageDir, record);

        options.onProgress?.({ stage: 'health_check', componentId });
        await this.runHealthCheck(definition, stageDir, entrypoints, signal);
        this.throwIfAborted(signal);
        await fs.rm(installDir, { recursive: true, force: true });
        await fs.rename(stageDir, installDir);
        options.onProgress?.({ stage: 'completed', componentId });
        return this.viewFrom(definition, artifact, 'installed', record);
      } finally {
        await Promise.allSettled([
          fs.rm(archivePath, { force: true }),
          fs.rm(stageDir, { recursive: true, force: true }),
        ]);
      }
    });
  }

  private async inspect(definition: ComponentDefinition): Promise<InspectedInstallation> {
    if (!this.options.platform) {
      return {
        definition,
        view: this.viewFrom(definition, undefined, 'unsupported'),
      };
    }
    let artifact: ComponentArtifact;
    try {
      artifact = this.options.catalog.resolveArtifact(definition.id, this.options.platform);
    } catch (error) {
      if (error instanceof ComponentError && error.code === 'COMPONENT_UNSUPPORTED') {
        return { definition, view: this.viewFrom(definition, undefined, 'unsupported') };
      }
      throw error;
    }
    const installDir = this.installDir(definition, this.options.platform);
    const recordPath = path.join(installDir, RECORD_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(recordPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          definition,
          artifact,
          installDir,
          view: this.viewFrom(definition, artifact, 'not_installed'),
        };
      }
      return {
        definition,
        artifact,
        installDir,
        view: this.viewFrom(definition, artifact, 'invalid', undefined, 'COMPONENT_INVALID'),
      };
    }
    try {
      const record = JSON.parse(raw) as InstalledComponentRecord;
      const expectedEntrypoints = {
        ...definition.entrypoints,
        ...(artifact.entrypointOverrides ?? {}),
      };
      if (
        record.schemaVersion !== 1 ||
        record.id !== definition.id ||
        record.version !== definition.version ||
        record.platform !== artifact.platform ||
        record.artifact.sha256 !== artifact.sha256 ||
        JSON.stringify(record.entrypoints) !== JSON.stringify(expectedEntrypoints)
      ) {
        throw new Error('Installed component record does not match the trusted catalog.');
      }
      for (const relativePath of Object.values(record.entrypoints)) {
        const target = this.safeJoin(installDir, relativePath);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe entrypoint.');
      }
      return {
        definition,
        artifact,
        installDir,
        record,
        view: this.viewFrom(definition, artifact, 'installed', record),
      };
    } catch {
      return {
        definition,
        artifact,
        installDir,
        view: this.viewFrom(definition, artifact, 'invalid', undefined, 'COMPONENT_INVALID'),
      };
    }
  }

  private viewFrom(
    definition: ComponentDefinition,
    artifact: ComponentArtifact | undefined,
    state: ComponentView['state'],
    record?: InstalledComponentRecord,
    errorCode?: ComponentView['errorCode']
  ): ComponentView {
    return {
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
      version: definition.version,
      ...(artifact
        ? { platform: artifact.platform, downloadSizeBytes: artifact.downloadSizeBytes }
        : {}),
      capabilities: [...definition.capabilities],
      state,
      ...(record
        ? {
            installedSizeBytes: record.installedSizeBytes,
            installedAt: record.installedAt,
            lastVerifiedAt: record.lastVerifiedAt,
            ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
          }
        : {}),
      license: { ...definition.license },
      homepage: definition.homepage,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private installDir(definition: ComponentDefinition, platform: ComponentPlatform): string {
    return path.join(this.options.paths.components, definition.id, definition.version, platform);
  }

  private safeJoin(baseDir: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new ComponentError('COMPONENT_PATH_INVALID', 'Component path is not relative.');
    }
    const base = path.resolve(baseDir);
    const target = path.resolve(base, relativePath);
    if (target === base || !target.startsWith(`${base}${path.sep}`)) {
      throw new ComponentError(
        'COMPONENT_PATH_INVALID',
        'Component path escapes its install root.'
      );
    }
    return target;
  }

  private async writeRecord(installDir: string, record: InstalledComponentRecord): Promise<void> {
    const recordPath = path.join(installDir, RECORD_FILE);
    const temporaryPath = `${recordPath}.${this.idFactory()}.tmp`;
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, recordPath);
  }

  private async downloadArtifact(
    definition: ComponentDefinition,
    artifact: ComponentArtifact,
    destination: string,
    signal: AbortSignal,
    onProgress?: ComponentInstallOptions['onProgress']
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(artifact.url, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: { Accept: 'application/octet-stream' },
      });
    } catch (error) {
      if (signal.aborted) {
        throw new ComponentError(
          'COMPONENT_INSTALL_CANCELLED',
          `${definition.displayName} installation was cancelled.`
        );
      }
      throw new ComponentError(
        'COMPONENT_DOWNLOAD_FAILED',
        `Could not download ${definition.displayName}.`,
        true,
        { cause: error }
      );
    }
    if (!response.ok || !response.body) {
      throw new ComponentError(
        'COMPONENT_DOWNLOAD_FAILED',
        `${definition.displayName} download returned HTTP ${response.status}.`,
        response.status >= 500
      );
    }

    const file = await fs.open(destination, 'wx', 0o600);
    let receivedBytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        this.throwIfAborted(signal);
        const next = await reader.read();
        if (next.done) break;
        receivedBytes += next.value.byteLength;
        if (receivedBytes > artifact.downloadSizeBytes) {
          throw new ComponentError(
            'COMPONENT_DOWNLOAD_SIZE_MISMATCH',
            `${definition.displayName} download exceeded the pinned size.`
          );
        }
        let offset = 0;
        while (offset < next.value.byteLength) {
          const { bytesWritten } = await file.write(
            next.value,
            offset,
            next.value.byteLength - offset
          );
          if (bytesWritten < 1) {
            throw new ComponentError(
              'COMPONENT_DOWNLOAD_FAILED',
              `${definition.displayName} download could not be written to disk.`,
              true
            );
          }
          offset += bytesWritten;
        }
        onProgress?.({
          stage: 'downloading',
          componentId: definition.id,
          receivedBytes,
          totalBytes: artifact.downloadSizeBytes,
        });
      }
    } catch (error) {
      if (error instanceof ComponentError) throw error;
      if (signal.aborted) {
        throw new ComponentError(
          'COMPONENT_INSTALL_CANCELLED',
          `${definition.displayName} installation was cancelled.`
        );
      }
      throw new ComponentError(
        'COMPONENT_DOWNLOAD_FAILED',
        `${definition.displayName} download was interrupted.`,
        true,
        { cause: error }
      );
    } finally {
      await file.close();
      reader.releaseLock();
    }
    if (receivedBytes !== artifact.downloadSizeBytes) {
      throw new ComponentError(
        'COMPONENT_DOWNLOAD_SIZE_MISMATCH',
        `${definition.displayName} download size did not match the trusted catalog.`
      );
    }
  }

  private async runHealthCheck(
    definition: ComponentDefinition,
    installDir: string,
    entrypoints: Record<string, string>,
    signal?: AbortSignal
  ): Promise<void> {
    const relativePath = entrypoints[definition.healthCheck.entrypoint];
    const executablePath = this.safeJoin(installDir, relativePath);
    if (this.healthCheckRunner) {
      await this.healthCheckRunner(executablePath, definition, signal);
      return;
    }
    const result = await runManagedProcess(executablePath, definition.healthCheck.args, {
      timeoutMs: definition.healthCheck.timeoutMs,
      maxOutputBytes: 64 * 1024,
      signal,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (
      result.exitCode !== 0 ||
      !new RegExp(definition.healthCheck.expectedOutputPattern, 'i').test(output)
    ) {
      throw new ComponentError(
        'COMPONENT_HEALTH_CHECK_FAILED',
        `${definition.displayName} did not pass its post-install health check.`
      );
    }
  }

  private async sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const file = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest('hex');
    } finally {
      await file.close();
    }
  }

  private async touchLastUsed(componentId: string): Promise<void> {
    const inspected = await this.inspect(this.options.catalog.get(componentId));
    if (!inspected.record || !inspected.installDir) return;
    await this.writeRecord(inspected.installDir, {
      ...inspected.record,
      lastUsedAt: this.now().toISOString(),
    });
  }

  private combinedSignal(external?: AbortSignal): AbortSignal {
    if (!external) return this.lifetimeAbort.signal;
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([external, this.lifetimeAbort.signal]);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    external.addEventListener('abort', abort, { once: true });
    this.lifetimeAbort.signal.addEventListener('abort', abort, { once: true });
    if (external.aborted || this.lifetimeAbort.signal.aborted) controller.abort();
    return controller.signal;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted || this.stopping) {
      throw new ComponentError(
        'COMPONENT_INSTALL_CANCELLED',
        'Component installation was cancelled.'
      );
    }
  }

  private assertAvailable(): void {
    if (!this.initialized || this.stopping) {
      throw new ComponentError(
        'COMPONENTS_UNAVAILABLE',
        'WorkX managed components are unavailable.',
        true
      );
    }
  }

  private async withFileLock<T>(
    componentId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const lockDir = path.join(this.options.paths.downloads, '.locks');
    await fs.mkdir(lockDir, { recursive: true });
    const platform = this.options.platform ?? 'unsupported';
    const lockPath = path.join(lockDir, `${componentId}-${platform}.lock`);
    const started = Date.now();
    while (true) {
      this.throwIfAborted(signal);
      try {
        await fs.mkdir(lockPath);
        try {
          await fs.writeFile(
            path.join(lockPath, 'owner.json'),
            `${JSON.stringify({ schemaVersion: 1, ownerPid: process.pid })}\n`,
            { encoding: 'utf8', mode: 0o600, flag: 'wx' }
          );
        } catch (error) {
          await fs.rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const ownerPid = await fs
          .readFile(path.join(lockPath, 'owner.json'), 'utf8')
          .then((raw) => {
            const owner = JSON.parse(raw) as { schemaVersion?: number; ownerPid?: number };
            return owner.schemaVersion === 1 && Number.isInteger(owner.ownerPid)
              ? owner.ownerPid
              : null;
          })
          .catch(() => null);
        if (ownerPid && this.processIsAlive(ownerPid)) {
          if (Date.now() - started > LOCK_WAIT_MS) {
            throw new ComponentError(
              'COMPONENT_INSTALL_LOCKED',
              `Another WorkX process is managing '${componentId}'.`,
              true
            );
          }
          await this.delay(200, signal);
          continue;
        }
        const stat = await fs.stat(lockPath).catch(() => null);
        if (ownerPid || (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS)) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started > LOCK_WAIT_MS) {
          throw new ComponentError(
            'COMPONENT_INSTALL_LOCKED',
            `Another WorkX process is managing '${componentId}'.`,
            true
          );
        }
        await this.delay(200, signal);
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  private async delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(
          new ComponentError('COMPONENT_INSTALL_CANCELLED', 'Component installation was cancelled.')
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private async cleanupStaleDownloads(): Promise<void> {
    const entries = await fs.readdir(this.options.paths.downloads, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name !== '.locks' && entry.name !== '.leases')
        .map(async (entry) => {
          const target = path.join(this.options.paths.downloads, entry.name);
          const stat = await fs.stat(target).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs > DOWNLOAD_STALE_MS) {
            await fs.rm(target, { recursive: true, force: true });
          }
        })
    );
  }

  private async removeEmptyParents(installDir: string, componentId: string): Promise<void> {
    const versionDir = path.dirname(installDir);
    const componentDir = path.join(this.options.paths.components, componentId);
    for (const candidate of [versionDir, componentDir]) {
      try {
        const entries = await fs.readdir(candidate);
        if (entries.length === 0) await fs.rmdir(candidate);
      } catch {
        // A concurrent process may have created another version; leave it alone.
      }
    }
  }

  private async createLeaseFile(componentId: string): Promise<string> {
    const leaseDir = path.join(this.options.paths.downloads, '.leases');
    await fs.mkdir(leaseDir, { recursive: true });
    const platform = this.options.platform ?? 'unsupported';
    const leaseFile = path.join(
      leaseDir,
      `${componentId}-${platform}-${process.pid}-${this.idFactory()}.json`
    );
    await fs.writeFile(
      leaseFile,
      `${JSON.stringify({
        schemaVersion: 1,
        componentId,
        platform,
        ownerPid: process.pid,
        createdAt: this.now().toISOString(),
      })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    this.ownedLeaseFiles.add(leaseFile);
    return leaseFile;
  }

  private async releaseUse(componentId: string, leaseFile?: string): Promise<void> {
    const remaining = Math.max(0, (this.activeUses.get(componentId) ?? 1) - 1);
    if (remaining) this.activeUses.set(componentId, remaining);
    else this.activeUses.delete(componentId);
    if (leaseFile) {
      this.ownedLeaseFiles.delete(leaseFile);
      await fs.rm(leaseFile, { force: true });
    }
  }

  private async assertNotBusy(componentId: string, displayName: string): Promise<void> {
    if ((this.activeUses.get(componentId) ?? 0) > 0) {
      throw new ComponentError(
        'COMPONENT_BUSY',
        `${displayName} is currently in use and cannot be removed.`
      );
    }
    const leaseDir = path.join(this.options.paths.downloads, '.leases');
    const platform = this.options.platform ?? 'unsupported';
    const prefix = `${componentId}-${platform}-`;
    const entries = await fs.readdir(leaseDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) {
        continue;
      }
      const leaseFile = path.join(leaseDir, entry.name);
      try {
        const record = JSON.parse(await fs.readFile(leaseFile, 'utf8')) as {
          componentId?: string;
          platform?: string;
          ownerPid?: number;
        };
        if (
          record.componentId !== componentId ||
          record.platform !== platform ||
          !Number.isInteger(record.ownerPid)
        ) {
          throw new Error('Invalid lease record.');
        }
        if (this.processIsAlive(record.ownerPid!)) {
          throw new ComponentError(
            'COMPONENT_BUSY',
            `${displayName} is currently in use by another WorkX process.`
          );
        }
        await fs.rm(leaseFile, { force: true });
      } catch (error) {
        if (error instanceof ComponentError) throw error;
        const stat = await fs.stat(leaseFile).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs <= LOCK_STALE_MS) {
          throw new ComponentError(
            'COMPONENT_BUSY',
            `${displayName} has an active installation lease.`
          );
        }
        await fs.rm(leaseFile, { force: true });
      }
    }
  }

  private processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
