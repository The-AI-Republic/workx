/**
 * Stage the ripgrep binary as a Tauri externalBin sidecar.
 *
 * The desktop build (Tauri WebView) cannot spawn processes from JS; the
 * Rust `ripgrep_execute` command resolves `rg` as: system PATH → this
 * bundled sidecar (placed next to the app exe by Tauri). This script
 * copies the `@vscode/ripgrep` binary to tauri/binaries/rg-<triple><ext>
 * so Tauri's bundler picks it up.
 *
 * Run:  node scripts/build-ripgrep-sidecar.mjs   (or npm run build:ripgrep-sidecar)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const { rgPath } = require('@vscode/ripgrep');
if (!rgPath || !fs.existsSync(rgPath)) {
  console.error(`@vscode/ripgrep binary not found at ${rgPath}. Run npm install.`);
  process.exit(1);
}

const PLATFORM_MAP = {
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', ext: '.exe' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', ext: '' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', ext: '' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', ext: '' },
};

const key = `${process.platform}-${process.arch}`;
const mapping = PLATFORM_MAP[key];
if (!mapping) {
  console.error(`Unsupported platform: ${key}. Supported: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  process.exit(1);
}

const binDir = path.resolve(root, 'tauri/binaries');
fs.mkdirSync(binDir, { recursive: true });

const out = path.join(binDir, `rg-${mapping.triple}${mapping.ext}`);
fs.copyFileSync(rgPath, out);
if (mapping.ext === '') fs.chmodSync(out, 0o755);
console.log(`✓ ripgrep sidecar staged: ${out}`);

// macOS: Tauri's universal build expects the universal-apple-darwin triple.
// @vscode/ripgrep only ships the host arch, so duplicate it under the
// universal name (functional on the host arch; cross-arch packaging would
// need both @vscode/ripgrep-darwin-{arm64,x64} present).
if (process.platform === 'darwin') {
  const universal = path.join(binDir, 'rg-universal-apple-darwin');
  try {
    execSync(`lipo -create -output "${universal}" "${out}"`, { stdio: 'inherit' });
  } catch {
    fs.copyFileSync(out, universal);
  }
  fs.chmodSync(universal, 0o755);
  console.log(`✓ ripgrep universal sidecar: ${universal}`);
}
