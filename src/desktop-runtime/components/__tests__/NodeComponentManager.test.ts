import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentCatalog, ComponentError, type ComponentDefinition } from '@/core/components';
import { NodeComponentManager } from '../NodeComponentManager';
import { resolveWorkXPaths } from '../workxPaths';

const payload = Buffer.from('fixture executable');
const archive = Buffer.from(
  'UEsDBBQAAAAIAPlm8VyNyacLFAAAABIAAAAHAAAAZml4dHVyZUvLrCgpLUpVSK1ITS4tSUzKSQUAUEsBAhQAFAAAAAgA+WbxXI3JpwsUAAAAEgAAAAcAAAAAAAAAAAAAAAAAAAAAAGZpeHR1cmVQSwUGAAAAAAEAAQA1AAAAOQAAAAAA',
  'base64'
);
const archiveHash = createHash('sha256').update(archive).digest('hex');

function archiveResponse(): Response {
  const bytes = archive.buffer.slice(
    archive.byteOffset,
    archive.byteOffset + archive.byteLength
  ) as ArrayBuffer;
  return new Response(bytes);
}

function definition(sha256 = archiveHash, size = archive.byteLength): ComponentDefinition {
  return {
    id: 'fixture-tool',
    displayName: 'Fixture Tool',
    description: 'Fixture component',
    version: '1.0.0',
    capabilities: ['fixture'],
    entrypoints: { fixture: 'bin/fixture' },
    artifacts: [
      {
        platform: 'linux-x64',
        url: 'https://example.test/fixture.zip',
        sha256,
        downloadSizeBytes: size,
        archive: {
          format: 'zip-single-file',
          entry: 'fixture',
          targetEntrypoint: 'fixture',
          maxExtractedBytes: 1024,
        },
      },
    ],
    healthCheck: {
      entrypoint: 'fixture',
      args: ['--version'],
      expectedOutputPattern: '1\\.0\\.0',
      timeoutMs: 1000,
    },
    license: { name: 'MIT', url: 'https://example.test/license' },
    homepage: 'https://example.test/',
    source: {
      publisher: 'Fixture',
      repository: 'https://example.test/repo',
      trustedOrigins: ['https://example.test'],
    },
  };
}

describe('NodeComponentManager', () => {
  let root: string;
  let healthCheck: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workx-components-'));
    healthCheck = vi.fn(async (executablePath: string) => {
      expect(await fs.readFile(executablePath, 'utf8')).toBe('fixture executable');
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function manager(component = definition(), fetchImpl = vi.fn(async () => archiveResponse())) {
    const value = new NodeComponentManager({
      paths: resolveWorkXPaths({ env: { WORKX_HOME: root } }),
      platform: 'linux-x64',
      catalog: new ComponentCatalog([component]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthCheckRunner: healthCheck,
    });
    return { value, fetchImpl };
  }

  it('installs, verifies, leases, and removes a pinned component', async () => {
    const { value, fetchImpl } = manager();
    await value.initialize();
    expect(await value.get('fixture-tool')).toMatchObject({ state: 'not_installed' });

    const stages: string[] = [];
    const installed = await value.install('fixture-tool', {
      onProgress: (progress) => stages.push(progress.stage),
    });
    expect(installed).toMatchObject({
      state: 'installed',
      installedSizeBytes: expect.any(Number),
      downloadSizeBytes: archive.byteLength,
    });
    expect(stages).toEqual([
      'preparing',
      'downloading',
      'verifying',
      'installing',
      'health_check',
      'completed',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);

    const executablePath = await value.resolveEntrypoint('fixture-tool', 'fixture');
    expect(executablePath.startsWith(root)).toBe(true);
    expect(await fs.readFile(executablePath, 'utf8')).toBe('fixture executable');
    expect(await value.verify('fixture-tool')).toMatchObject({ state: 'installed' });

    const lease = await value.acquireEntrypoint('fixture-tool', 'fixture');
    await expect(value.uninstall('fixture-tool')).rejects.toMatchObject({ code: 'COMPONENT_BUSY' });
    const secondProcessView = manager().value;
    await secondProcessView.initialize();
    await expect(secondProcessView.uninstall('fixture-tool')).rejects.toMatchObject({
      code: 'COMPONENT_BUSY',
    });
    await lease.release();
    await lease.release();
    await secondProcessView.uninstall('fixture-tool');
    expect(await value.get('fixture-tool')).toMatchObject({ state: 'not_installed' });
    await secondProcessView.dispose();
    await value.dispose();
  });

  it('deduplicates concurrent installs and repairs a corrupted executable', async () => {
    const delayedFetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return archiveResponse();
    });
    const { value } = manager(definition(), delayedFetch);
    await value.initialize();
    const [first, second] = await Promise.all([
      value.install('fixture-tool'),
      value.install('fixture-tool'),
    ]);
    expect(first.state).toBe('installed');
    expect(second.state).toBe('installed');
    expect(delayedFetch).toHaveBeenCalledTimes(1);

    const executablePath = await value.resolveEntrypoint('fixture-tool', 'fixture');
    await fs.writeFile(executablePath, 'tampered');
    await expect(value.verify('fixture-tool')).rejects.toMatchObject({
      code: 'COMPONENT_INVALID',
    });
    await value.install('fixture-tool');
    expect(await fs.readFile(executablePath, 'utf8')).toBe('fixture executable');
    expect(delayedFetch).toHaveBeenCalledTimes(2);
    await value.dispose();
  });

  it('serializes installation across manager instances', async () => {
    const firstFetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return archiveResponse();
    });
    const secondFetch = vi.fn(async () => archiveResponse());
    const first = manager(definition(), firstFetch).value;
    const second = manager(definition(), secondFetch).value;
    await Promise.all([first.initialize(), second.initialize()]);

    const [firstResult, secondResult] = await Promise.all([
      first.install('fixture-tool'),
      second.install('fixture-tool'),
    ]);

    expect(firstResult.state).toBe('installed');
    expect(secondResult.state).toBe('installed');
    expect(firstFetch.mock.calls.length + secondFetch.mock.calls.length).toBe(1);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('extracts only the catalog entry and rejects its declared oversized payload', async () => {
    const filteredArchive = Buffer.from(
      zipSync({
        fixture: Uint8Array.from(payload),
        'ignored.bin': new Uint8Array(4096).fill(7),
      })
    );
    const filteredDefinition = definition(
      createHash('sha256').update(filteredArchive).digest('hex'),
      filteredArchive.byteLength
    );
    const filtered = manager(
      filteredDefinition,
      vi.fn(async () => new Response(filteredArchive))
    ).value;
    await filtered.initialize();
    await expect(filtered.install('fixture-tool')).resolves.toMatchObject({ state: 'installed' });
    await filtered.uninstall('fixture-tool');

    const oversizedArchive = Buffer.from(zipSync({ fixture: new Uint8Array(2048).fill(1) }));
    const oversizedDefinition = definition(
      createHash('sha256').update(oversizedArchive).digest('hex'),
      oversizedArchive.byteLength
    );
    const oversized = manager(
      oversizedDefinition,
      vi.fn(async () => new Response(oversizedArchive))
    ).value;
    await oversized.initialize();
    await expect(oversized.install('fixture-tool')).rejects.toMatchObject({
      code: 'COMPONENT_ARCHIVE_INVALID',
    });
    await Promise.all([filtered.dispose(), oversized.dispose()]);
  });

  it('fails closed on checksum and size mismatches and removes partial downloads', async () => {
    const checksumManager = manager(definition('f'.repeat(64))).value;
    await checksumManager.initialize();
    await expect(checksumManager.install('fixture-tool')).rejects.toMatchObject({
      code: 'COMPONENT_CHECKSUM_MISMATCH',
    });
    expect(await checksumManager.get('fixture-tool')).toMatchObject({ state: 'not_installed' });

    const sizeManager = manager(definition(archiveHash, archive.byteLength - 1)).value;
    await sizeManager.initialize();
    await expect(sizeManager.install('fixture-tool')).rejects.toMatchObject({
      code: 'COMPONENT_DOWNLOAD_SIZE_MISMATCH',
    });
    const downloads = await fs.readdir(resolveWorkXPaths({ env: { WORKX_HOME: root } }).downloads);
    expect(downloads.filter((entry) => entry.endsWith('.part'))).toEqual([]);
  });

  it('reports unsupported platforms without attempting a download', async () => {
    const fetchImpl = vi.fn();
    const value = new NodeComponentManager({
      paths: resolveWorkXPaths({ env: { WORKX_HOME: root } }),
      platform: null,
      catalog: new ComponentCatalog([definition()]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthCheckRunner: healthCheck,
    });
    await value.initialize();
    expect(await value.get('fixture-tool')).toMatchObject({ state: 'unsupported' });
    await expect(value.install('fixture-tool')).rejects.toBeInstanceOf(ComponentError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
