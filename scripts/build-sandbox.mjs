/**
 * Build the windows-sandbox sidecar binary and copy it to tauri/binaries/
 * with the Tauri-expected target-triple filename.
 *
 * Why this script exists:
 *   Tauri's `externalBin` requires sidecar binaries to exist at build time,
 *   named as `<name>-<target-triple>[.exe]`. Previously, `beforeBuildCommand`
 *   ran `cargo build` directly, which failed on non-Windows platforms because
 *   the sandbox crate uses Windows-only APIs. This script handles the
 *   cross-platform logic: build + copy on Windows, create an empty placeholder
 *   on macOS/Linux so the Tauri bundler doesn't error on the missing file.
 *
 * Run:  node scripts/build-sandbox.mjs
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Map Node.js platform-arch to Rust target triple and binary extension.
// Tauri expects sidecar binaries named: <name>-<triple>[.ext]
const PLATFORM_MAP = {
  'win32-x64':    { triple: 'x86_64-pc-windows-msvc',   ext: '.exe' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin',      ext: '' },
  'darwin-x64':   { triple: 'x86_64-apple-darwin',       ext: '' },
  'linux-x64':    { triple: 'x86_64-unknown-linux-gnu',  ext: '' },
};

const key = `${process.platform}-${process.arch}`;
const mapping = PLATFORM_MAP[key];

if (!mapping) {
  console.log(`Unsupported platform for sandbox build: ${key}, skipping.`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('windows-sandbox is Windows-only, skipping build.');
  // Create empty placeholders so Tauri bundler doesn't fail on the
  // missing externalBin entry. The file is never executed on non-Windows.
  // On macOS, create placeholders for BOTH architectures so that
  // universal builds (--target universal-apple-darwin) succeed.
  const binDir = path.join(root, 'tauri', 'binaries');
  fs.mkdirSync(binDir, { recursive: true });
  const triples = process.platform === 'darwin'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin']
    : [mapping.triple];
  for (const triple of triples) {
    const placeholder = path.join(binDir, `windows-sandbox-${triple}`);
    if (!fs.existsSync(placeholder)) {
      fs.writeFileSync(placeholder, '');
      fs.chmodSync(placeholder, 0o755);
    }
  }
  process.exit(0);
}

const { triple, ext } = mapping;

console.log('Building windows-sandbox sidecar');
console.log(`  Platform: ${key}`);
console.log(`  Triple:   ${triple}`);

// Build the sandbox helper
execSync(
  'cargo build --release -p windows-sandbox --manifest-path tauri/Cargo.toml',
  { stdio: 'inherit', cwd: root }
);

// Copy to tauri/binaries/ with the target-triple name
const binDir = path.join(root, 'tauri', 'binaries');
fs.mkdirSync(binDir, { recursive: true });

const src = path.join(root, 'tauri', 'target', 'release', `windows-sandbox${ext}`);
const dst = path.join(binDir, `windows-sandbox-${triple}${ext}`);

fs.copyFileSync(src, dst);
console.log(`\n  Copied: ${dst}`);
