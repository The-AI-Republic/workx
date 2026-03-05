/**
 * Build the chrome-devtools-mcp sidecar binary.
 *
 * Why a launcher binary instead of compiling chrome-devtools-mcp directly:
 *   chrome-devtools-mcp is an ESM package with top-level await. @yao-pkg/pkg
 *   intercepts CJS require() for its virtual snapshot but NOT the Node.js
 *   ESM loader's file:// URL resolution. Compiling the ESM entry directly
 *   fails at runtime with ERR_MODULE_NOT_FOUND.
 *
 * Solution: compile sidecar-launcher.cjs (a simple CJS wrapper) with pkg.
 *   - pkg assets include chrome-devtools-mcp's JS files (accessible via fs.*)
 *   - At runtime the launcher extracts them to a temp dir and runs them with
 *     the system Node.js, where ESM import resolution works normally.
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

// Resolve the chrome-devtools-mcp build/src directory
const pkgMeta = require('chrome-devtools-mcp/package.json');
const binRelative = typeof pkgMeta.bin === 'string'
  ? pkgMeta.bin
  : (pkgMeta.bin['chrome-devtools-mcp'] ?? Object.values(pkgMeta.bin)[0]);

if (!binRelative) {
  console.error('Could not find bin entry in chrome-devtools-mcp/package.json');
  process.exit(1);
}

// The entry is at build/src/index.js; we want the build/src directory
const entryPath = path.resolve(root, 'node_modules/chrome-devtools-mcp', binRelative);
const cdmcpSrcDir = path.dirname(entryPath); // …/chrome-devtools-mcp/build/src

if (!fs.existsSync(cdmcpSrcDir)) {
  console.error(`chrome-devtools-mcp src dir not found: ${cdmcpSrcDir}`);
  process.exit(1);
}

// Map platform+arch → Tauri target triple and pkg target.
// Use node22 so the pkg-embedded runtime satisfies chrome-devtools-mcp's
// version check (requires Node 20.19+ or 22.12+).
const PLATFORM_MAP = {
  'win32-x64':    { triple: 'x86_64-pc-windows-msvc',   pkgTarget: 'node22-win-x64',    ext: '.exe' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin',      pkgTarget: 'node22-macos-arm64', ext: '' },
  'darwin-x64':   { triple: 'x86_64-apple-darwin',       pkgTarget: 'node22-macos-x64',  ext: '' },
  'linux-x64':    { triple: 'x86_64-unknown-linux-gnu',  pkgTarget: 'node22-linux-x64',  ext: '' },
};

const key = `${process.platform}-${process.arch}`;
const mapping = PLATFORM_MAP[key];
if (!mapping) {
  console.error(`Unsupported platform: ${key}. Supported: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  process.exit(1);
}

const binDir = path.resolve(root, 'tauri/binaries');
fs.mkdirSync(binDir, { recursive: true });

// On macOS, build for BOTH architectures so that universal builds
// (--target universal-apple-darwin) succeed.
const targets = process.platform === 'darwin'
  ? [PLATFORM_MAP['darwin-arm64'], PLATFORM_MAP['darwin-x64']]
  : [mapping];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function gatherFiles(dir, base) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      result.push(...gatherFiles(fullPath, base));
    } else {
      result.push(relPath);
    }
  }
  return result;
}

for (const target of targets) {
  const { triple, pkgTarget, ext } = target;
  const outputPath = path.join(binDir, `chrome-devtools-mcp-${triple}${ext}`);

  // Temp build directory — cleaned up at the end
  const buildDir = path.join(binDir, '_pkgbuild');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  console.log(`Building chrome-devtools-mcp sidecar`);
  console.log(`  Platform : ${key}`);
  console.log(`  Triple   : ${triple}`);
  console.log(`  CDMCP src: ${cdmcpSrcDir}`);
  console.log(`  Output   : ${outputPath}`);
  console.log('');

  // ── Step 1: copy launcher script ───────────────────────────────────────────
  console.log('Step 1: Copying launcher...');
  const launcherSrc = path.join(__dirname, 'sidecar-launcher.cjs');
  const launcherDst = path.join(buildDir, 'launcher.cjs');
  fs.copyFileSync(launcherSrc, launcherDst);

  // ── Step 2: copy chrome-devtools-mcp build/src → buildDir/cdmcp ────────────
  console.log('Step 2: Copying chrome-devtools-mcp files...');
  copyDir(cdmcpSrcDir, path.join(buildDir, 'cdmcp'));

  // Generate a flat file list so the launcher can enumerate assets at runtime.
  // pkg intercepts fs.readFileSync for snapshot files but NOT fs.readdirSync,
  // so the launcher needs to know exact paths ahead of time.
  const cdmcpFiles = gatherFiles(path.join(buildDir, 'cdmcp'), path.join(buildDir, 'cdmcp'));
  fs.writeFileSync(path.join(buildDir, 'cdmcp-files.json'), JSON.stringify(cdmcpFiles));
  console.log(`  Found ${cdmcpFiles.length} files to bundle`);

  // ── Step 3: write package.json with pkg assets config ──────────────────────
  console.log('Step 3: Writing pkg config...');
  fs.writeFileSync(
    path.join(buildDir, 'package.json'),
    JSON.stringify({
      name: 'chrome-devtools-mcp-launcher',
      version: '1.0.0',
      pkg: {
        assets: ['cdmcp/**/*', 'cdmcp-files.json'],
      },
    })
  );

  // ── Step 4: compile with pkg ───────────────────────────────────────────────
  console.log(`\nStep 4: Compiling with pkg (${pkgTarget})...`);
  execSync(
    `npx @yao-pkg/pkg launcher.cjs --target ${pkgTarget} --output "${outputPath}"`,
    { stdio: 'inherit', cwd: buildDir }
  );

  // ── Cleanup ────────────────────────────────────────────────────────────────
  fs.rmSync(buildDir, { recursive: true, force: true });

  // Make executable on Unix
  if (ext === '') {
    fs.chmodSync(outputPath, 0o755);
  }

  console.log(`\n✓ Sidecar built: ${outputPath}`);
  console.log('  (Launcher extracts chrome-devtools-mcp at runtime and runs it with system Node.js)\n');
}

// On macOS, create a universal binary via lipo for Tauri's bundler
// (--target universal-apple-darwin expects a binary named with that triple).
if (process.platform === 'darwin') {
  const arm64Bin = path.join(binDir, 'chrome-devtools-mcp-aarch64-apple-darwin');
  const x64Bin = path.join(binDir, 'chrome-devtools-mcp-x86_64-apple-darwin');
  const universalBin = path.join(binDir, 'chrome-devtools-mcp-universal-apple-darwin');
  console.log('Creating universal binary via lipo...');
  execSync(`lipo -create -output "${universalBin}" "${arm64Bin}" "${x64Bin}"`, { stdio: 'inherit' });
  fs.chmodSync(universalBin, 0o755);
  console.log(`✓ Universal sidecar: ${universalBin}`);
}
