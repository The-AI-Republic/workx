/**
 * Build the desktop runtime sidecar bundle (Track 43 P4 packaging).
 *
 * What this produces, under `tauri/sidecar/desktop-runtime/`:
 *
 *   ├── index.mjs                   ← from `npm run build:desktop-runtime`
 *   ├── package.json                ← `{ "type": "module" }`
 *   ├── native/
 *   │   ├── better_sqlite3.node     ← copied from node_modules
 *   │   └── (sqlite-vec, …)         ← any other native addons we depend on
 *   └── node_modules/
 *       └── better-sqlite3/         ← minimal runtime tree (only the .node
 *           ├── build/Release/      ←  addon + its CJS entry point are
 *           │   └── better_sqlite3.node
 *           ├── lib/                ←  needed; the bindings.gyp/deps/ are not)
 *           └── package.json
 *
 * Tauri's `bundle.resources` packages the whole tree alongside the app
 * binary. The Rust supervisor launches `node <resourceDir>/desktop-runtime/index.mjs`
 * and Node resolves better-sqlite3 from the bundled node_modules.
 *
 * What we do _not_ do here:
 *   - Bundle Node.js itself. The runtime expects Node 20.19+/22+ on PATH;
 *     packaging Node is a P4 follow-up (it doubles the installer size).
 *   - Compile the runtime with @yao-pkg/pkg. The runtime uses dynamic
 *     `import()`, top-level await, and native addons — all of which fight
 *     with pkg's CJS-snapshot model (the chrome-devtools-mcp sidecar runs
 *     into the same issue). System Node is the path.
 *
 * Run:  node scripts/build-desktop-runtime-sidecar.mjs
 * Or:   npm run build:desktop-runtime-sidecar
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const req = createRequire(import.meta.url);

const distEntry = path.join(root, 'dist/desktop-runtime/index.mjs');
const sidecarDir = path.join(root, 'tauri/sidecar/desktop-runtime');

function info(msg) { console.log(`[build-desktop-runtime-sidecar] ${msg}`); }

function step(name, fn) {
  process.stdout.write(`[build-desktop-runtime-sidecar] ${name}… `);
  try {
    fn();
    process.stdout.write('ok\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error(err);
    process.exit(1);
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

step('1) build dist/desktop-runtime via Vite', () => {
  execSync('npm run build:desktop-runtime', { cwd: root, stdio: 'inherit' });
  if (!fs.existsSync(distEntry)) {
    throw new Error(`Expected ${distEntry} after build, not found`);
  }
});

step('2) reset sidecar output dir', () => {
  rmrf(sidecarDir);
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(
    path.join(sidecarDir, 'package.json'),
    JSON.stringify({ name: 'apple-pi-desktop-runtime', type: 'module', private: true }, null, 2),
  );
});

step('3) copy runtime bundle', () => {
  copyFile(distEntry, path.join(sidecarDir, 'index.mjs'));
  // Vite emits a source map alongside the bundle — keep it for diagnostics.
  const mapSrc = `${distEntry}.map`;
  if (fs.existsSync(mapSrc)) copyFile(mapSrc, path.join(sidecarDir, 'index.mjs.map'));
});

/**
 * Copy a single npm dep's *runtime* tree (lib + native addon + package.json)
 * into the sidecar's node_modules so Node can resolve it. We skip
 * deps/, bindings.gyp, prebuilds for OTHER targets, etc., to keep the
 * bundle small.
 */
function copyRuntimeDep(name, picks) {
  const depRoot = path.dirname(req.resolve(`${name}/package.json`));
  const dst = path.join(sidecarDir, 'node_modules', name);
  fs.mkdirSync(dst, { recursive: true });
  copyFile(path.join(depRoot, 'package.json'), path.join(dst, 'package.json'));
  for (const rel of picks) {
    const s = path.join(depRoot, rel);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, rel);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

step('4) copy better-sqlite3 native addon + lib', () => {
  copyRuntimeDep('better-sqlite3', ['lib', 'build/Release/better_sqlite3.node']);
});

step('5) copy sqlite-vec native artifact (if installed)', () => {
  try {
    copyRuntimeDep('sqlite-vec', ['dist', 'src']);
  } catch (err) {
    info(`sqlite-vec not installed; skipping (${err?.code ?? 'EOTHER'})`);
  }
});

step('6) self-test (load the bundled native addon via the bundled node_modules)', () => {
  // Spawn `node` with cwd = sidecarDir so it resolves modules from the
  // bundled node_modules. Loading better-sqlite3 dispatches to the .node
  // addon — if that fails we know the bundle is unusable BEFORE shipping.
  execSync(
    `node -e "require('better-sqlite3'); console.log('addon-ok')"`,
    { cwd: sidecarDir, stdio: 'inherit' },
  );
});

info('done; output: ' + sidecarDir);
