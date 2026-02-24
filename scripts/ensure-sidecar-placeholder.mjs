/**
 * Ensure a placeholder chrome-devtools-mcp sidecar binary exists so that
 * `cargo tauri dev` doesn't fail on the missing externalBin entry.
 *
 * The real sidecar is built by `npm run build:sidecar` (build-sidecar.mjs)
 * which is only needed for production builds. During development the MCP
 * server runs via Node.js directly, so an empty placeholder is sufficient.
 */

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
  console.log(`Unsupported platform for sidecar placeholder: ${key}, skipping.`);
  process.exit(0);
}

const binDir = path.join(root, 'tauri', 'binaries');
fs.mkdirSync(binDir, { recursive: true });

const placeholder = path.join(binDir, `chrome-devtools-mcp-${mapping.triple}${mapping.ext}`);
if (!fs.existsSync(placeholder)) {
  fs.writeFileSync(placeholder, '');
  if (mapping.ext === '') {
    fs.chmodSync(placeholder, 0o755);
  }
  console.log(`Created sidecar placeholder: ${placeholder}`);
} else {
  console.log(`Sidecar placeholder already exists: ${placeholder}`);
}
