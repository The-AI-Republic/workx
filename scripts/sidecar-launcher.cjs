/**
 * Sidecar launcher for chrome-devtools-mcp.
 *
 * Compiled as a pkg binary (CJS entry point).
 *
 * Why this exists:
 *   chrome-devtools-mcp is an ESM package with top-level await.
 *   @yao-pkg/pkg intercepts CJS require() but NOT the Node.js ESM loader's
 *   file:// URL resolution, so the ESM entry can't be imported directly from
 *   the pkg snapshot. This launcher works around that by:
 *
 *   1. Reading each file from the snapshot via fs.readFileSync() — which pkg
 *      DOES intercept — and writing it to a real temp directory.
 *   2. Finding the system Node.js binary.
 *   3. Spawning node with the extracted entry point from the real filesystem,
 *      where the ESM loader can find it normally.
 *
 * stdio is inherited, so the MCP protocol (JSON-RPC over stdio) flows
 * transparently: Rust ↔ launcher ↔ chrome-devtools-mcp.
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Find system Node.js ───────────────────────────────────────────────────────

function findNodeExe() {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.NODE_EXE_PATH,
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    // Fall back to where.exe (searches user PATH)
    try {
      const out = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', timeout: 3000 });
      const first = out.trim().split('\n')[0].trim();
      if (first && fs.existsSync(first)) return first;
    } catch { /* where.exe not found or node not in PATH */ }
  } else {
    // macOS / Linux
    const candidates = ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const out = execFileSync('which', ['node'], { encoding: 'utf8', timeout: 3000 });
      const p = out.trim();
      if (p && fs.existsSync(p)) return p;
    } catch { /* not in PATH */ }
  }
  return null;
}

// ── Extract chrome-devtools-mcp from pkg snapshot ────────────────────────────

// pkg puts assets at a path relative to __dirname (the snapshot root).
// The build script copies chrome-devtools-mcp/build/src → cdmcp/ here,
// and generates cdmcp-files.json listing all relative paths (because pkg
// intercepts fs.readFileSync for snapshot assets but NOT fs.readdirSync).
const SNAPSHOT_CDMCP = path.join(__dirname, 'cdmcp');
const CACHE_DIR = path.join(os.tmpdir(), 'cdmcp-sidecar');
const CACHE_VER_FILE = path.join(CACHE_DIR, '.version');

// Load the pre-generated file list embedded by the build script.
// require() for JSON is intercepted by pkg and works in the snapshot.
const FILE_LIST = require('./cdmcp-files.json');

function copyFromSnapshot(relFiles, srcDir, dstDir) {
  for (const relFile of relFiles) {
    const src = path.join(srcDir, relFile);
    const dst = path.join(dstDir, relFile);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.writeFileSync(dst, fs.readFileSync(src)); } catch { /* skip */ }
  }
}

// Cache key: binary's mtime — changes when the app is updated, triggering
// a fresh extraction. Falls back to a constant if stat fails.
const cacheKey = (() => {
  try { return String(fs.statSync(process.execPath).mtimeMs); } catch { return 'v1'; }
})();

let cacheValid = false;
try {
  cacheValid =
    fs.readFileSync(CACHE_VER_FILE, 'utf8') === cacheKey &&
    fs.existsSync(path.join(CACHE_DIR, 'index.js'));
} catch { /* cache missing or corrupt */ }

if (!cacheValid) {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  copyFromSnapshot(FILE_LIST, SNAPSHOT_CDMCP, CACHE_DIR);
  // Mark directory as ESM so node treats .js files as ES modules
  fs.writeFileSync(path.join(CACHE_DIR, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(CACHE_VER_FILE, cacheKey);
}

// ── Find Node.js ─────────────────────────────────────────────────────────────

const nodeExe = findNodeExe();
if (!nodeExe) {
  process.stderr.write(
    '[chrome-devtools-mcp] ERROR: Node.js is required to use browser tools.\n' +
    'Please install Node.js 20.19+ from https://nodejs.org/ and restart the app.\n'
  );
  process.exit(1);
}

// ── Run chrome-devtools-mcp ───────────────────────────────────────────────────

const entryPoint = path.join(CACHE_DIR, 'index.js');
const child = spawn(nodeExe, [entryPoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code != null ? code : 0));

// Forward signals so the child is cleaned up if we're killed
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
