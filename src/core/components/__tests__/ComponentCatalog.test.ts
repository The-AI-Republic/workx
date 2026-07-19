import { describe, expect, it } from 'vitest';
import { ComponentCatalog, ComponentError, type ComponentDefinition } from '..';
import { DUCKDB_COMPONENT } from '@/desktop-runtime/components/builtinCatalog';

function definition(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    id: 'fixture-tool',
    displayName: 'Fixture Tool',
    description: 'Test component',
    version: '1.0.0',
    capabilities: ['fixture'],
    entrypoints: { fixture: 'bin/fixture' },
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
    artifacts: [
      {
        platform: 'linux-x64',
        url: 'https://example.test/fixture.zip',
        sha256: 'a'.repeat(64),
        downloadSizeBytes: 10,
        archive: {
          format: 'zip-single-file',
          entry: 'fixture',
          targetEntrypoint: 'fixture',
          maxExtractedBytes: 100,
        },
      },
    ],
    ...overrides,
  };
}

describe('ComponentCatalog', () => {
  it('registers immutable definitions and resolves platform artifacts', () => {
    const catalog = new ComponentCatalog([DUCKDB_COMPONENT]);
    const duckdb = catalog.get('duckdb');
    duckdb.displayName = 'mutated';

    expect(catalog.get('duckdb').displayName).toBe('DuckDB');
    expect(catalog.resolveArtifact('duckdb', 'linux-x64')).toMatchObject({
      downloadSizeBytes: 21_247_976,
      sha256: '1f2fa724fb054b3dbe1a9cbd13de5b76997d850e7087ec762ba88db04e0180cf',
    });
    expect(catalog.resolveArtifact('duckdb', 'win32-arm64').entrypointOverrides).toEqual({
      duckdb: 'bin/duckdb.exe',
    });
  });

  it('rejects unknown, duplicate, and unsupported components', () => {
    const catalog = new ComponentCatalog([definition()]);
    expect(() => catalog.get('missing')).toThrowError(ComponentError);
    expect(() => catalog.register(definition())).toThrow(/already registered/);
    expect(() => catalog.resolveArtifact('fixture-tool', 'darwin-arm64')).toThrow(/not available/);
  });

  it('rejects untrusted origins, unsafe IDs, and malformed hashes', () => {
    expect(
      () =>
        new ComponentCatalog([
          definition({
            artifacts: [
              {
                ...definition().artifacts[0],
                url: 'https://attacker.example/fixture.zip',
              },
            ],
          }),
        ])
    ).toThrow(/Untrusted artifact origin/);
    expect(() => new ComponentCatalog([definition({ id: '../escape' })])).toThrow(/Invalid/);
    expect(
      () =>
        new ComponentCatalog([
          definition({
            artifacts: [{ ...definition().artifacts[0], sha256: 'not-a-hash' }],
          }),
        ])
    ).toThrow(/SHA-256/);
  });
});
