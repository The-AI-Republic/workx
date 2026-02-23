/**
 * Build chrome-devtools-mcp as a self-contained Tauri sidecar binary.
 *
 * Uses @yao-pkg/pkg to compile the Node.js package into a standalone
 * executable that embeds the Node.js runtime. The output is placed in
 * tauri/binaries/ with the Tauri-required target-triple suffix.
 *
 * Run:  node scripts/build-sidecar.mjs
 * Or:   npm run build:sidecar
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Resolve the chrome-devtools-mcp binary entry point
const pkgMeta = require('chrome-devtools-mcp/package.json');
const binField = pkgMeta.bin;
const binRelative = typeof binField === 'string'
  ? binField
  : (binField['chrome-devtools-mcp'] ?? Object.values(binField)[0]);

if (!binRelative) {
  console.error('Could not find bin entry in chrome-devtools-mcp/package.json');
  process.exit(1);
}

const entryPath = path.resolve(root, 'node_modules/chrome-devtools-mcp', binRelative);
if (!fs.existsSync(entryPath)) {
  console.error(`Entry point not found: ${entryPath}`);
  process.exit(1);
}

// Map platform+arch → Tauri target triple and pkg target
const PLATFORM_MAP = {
  'win32-x64':    { triple: 'x86_64-pc-windows-msvc',   pkgTarget: 'node20-win-x64',    ext: '.exe' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin',      pkgTarget: 'node20-macos-arm64', ext: '' },
  'darwin-x64':   { triple: 'x86_64-apple-darwin',       pkgTarget: 'node20-macos-x64',  ext: '' },
  'linux-x64':    { triple: 'x86_64-unknown-linux-gnu',  pkgTarget: 'node20-linux-x64',  ext: '' },
};

const key = `${process.platform}-${process.arch}`;
const mapping = PLATFORM_MAP[key];
if (!mapping) {
  console.error(`Unsupported platform: ${key}. Supported: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  process.exit(1);
}

const { triple, pkgTarget, ext } = mapping;
const binDir = path.resolve(root, 'tauri/binaries');
fs.mkdirSync(binDir, { recursive: true });

const outputPath = path.join(binDir, `chrome-devtools-mcp-${triple}${ext}`);

console.log(`Building chrome-devtools-mcp sidecar`);
console.log(`  Platform : ${key}`);
console.log(`  Triple   : ${triple}`);
console.log(`  Entry    : ${entryPath}`);
console.log(`  Output   : ${outputPath}`);
console.log('');

execSync(
  `npx @yao-pkg/pkg "${entryPath}" --target ${pkgTarget} --output "${outputPath}"`,
  { stdio: 'inherit', cwd: root }
);

// Make executable on Unix
if (ext === '') {
  fs.chmodSync(outputPath, 0o755);
}

console.log(`\n✓ Sidecar built: ${outputPath}`);
