/**
 * Build the windows-sandbox sidecar binary and copy it to tauri/binaries/
 * with the Tauri-expected target-triple filename.
 *
 * On non-Windows platforms this is a no-op (the sandbox helper is Windows-only).
 *
 * Run:  node scripts/build-sandbox.mjs
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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
  // Still create a placeholder so Tauri bundler doesn't fail
  const binDir = path.join(root, 'tauri', 'binaries');
  fs.mkdirSync(binDir, { recursive: true });
  const placeholder = path.join(binDir, `windows-sandbox-${mapping.triple}${mapping.ext}`);
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, '');
    if (mapping.ext === '') {
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
