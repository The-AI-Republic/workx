import {
  ComponentCatalog,
  type ComponentArtifact,
  type ComponentDefinition,
  type ComponentPlatform,
} from '@/core/components';

const DUCKDB_VERSION = '1.5.4';
const DUCKDB_RELEASE_ROOT = `https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}`;

function duckDbArtifact(
  platform: ComponentPlatform,
  releasePlatform: string,
  downloadSizeBytes: number,
  sha256: string,
  windows = false
): ComponentArtifact {
  return {
    platform,
    url: `${DUCKDB_RELEASE_ROOT}/duckdb_cli-${releasePlatform}.zip`,
    sha256,
    downloadSizeBytes,
    archive: {
      format: 'zip-single-file',
      entry: windows ? 'duckdb.exe' : 'duckdb',
      targetEntrypoint: 'duckdb',
      maxExtractedBytes: 160 * 1024 * 1024,
    },
    ...(windows ? { entrypointOverrides: { duckdb: 'bin/duckdb.exe' } } : {}),
  };
}

export const DUCKDB_COMPONENT: ComponentDefinition = {
  id: 'duckdb',
  displayName: 'DuckDB',
  description:
    'Local analytical SQL engine used to combine and process bounded data from multiple sources.',
  version: DUCKDB_VERSION,
  capabilities: ['local-sql', 'csv', 'json', 'parquet', 'multi-source-analysis'],
  entrypoints: { duckdb: 'bin/duckdb' },
  healthCheck: {
    entrypoint: 'duckdb',
    args: ['-version'],
    expectedOutputPattern: '\\bv?1\\.5\\.4\\b',
    timeoutMs: 10_000,
  },
  license: {
    name: 'MIT',
    url: 'https://github.com/duckdb/duckdb/blob/v1.5.4/LICENSE',
  },
  homepage: 'https://duckdb.org/',
  source: {
    publisher: 'DuckDB Foundation',
    repository: 'https://github.com/duckdb/duckdb',
    trustedOrigins: ['https://github.com'],
  },
  artifacts: [
    duckDbArtifact(
      'linux-x64',
      'linux-amd64',
      21_247_976,
      '1f2fa724fb054b3dbe1a9cbd13de5b76997d850e7087ec762ba88db04e0180cf'
    ),
    duckDbArtifact(
      'linux-arm64',
      'linux-arm64',
      19_255_662,
      '377f03fb9f17ab5a78f28f829cbfcb5333da8ab3c2d0788f27694f81df77ed29'
    ),
    duckDbArtifact(
      'darwin-x64',
      'osx-amd64',
      18_561_984,
      '36e35ae59f417fb0b7e6c5e0b962f887e2b73ad52efc694b76e71fc57bd35b0a'
    ),
    duckDbArtifact(
      'darwin-arm64',
      'osx-arm64',
      16_319_183,
      'd6c35195683fd1378e5624b01ca390069d399f8341c38986b7e3dfa0b3470d10'
    ),
    duckDbArtifact(
      'win32-x64',
      'windows-amd64',
      12_909_728,
      '09e27c773eaab396754cbaa8fdbc5055c0006db4a579439839c7bb671894610f',
      true
    ),
    duckDbArtifact(
      'win32-arm64',
      'windows-arm64',
      13_842_342,
      'ef9925eab44f01d3a885fa5e612d1e27e692c0aa8f25f20599d0fffb42d8d29c',
      true
    ),
  ],
};

export function createBuiltinComponentCatalog(): ComponentCatalog {
  return new ComponentCatalog([DUCKDB_COMPONENT]);
}

export function componentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): ComponentPlatform | null {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  if (platform === 'win32' && arch === 'arm64') return 'win32-arm64';
  return null;
}
