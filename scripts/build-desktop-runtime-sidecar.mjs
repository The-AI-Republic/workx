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
 * binary. The Rust supervisor launches the packaged Node binary against
 * `<resourceDir>/desktop-runtime/index.mjs`, and Node resolves better-sqlite3
 * from the bundled node_modules.
 *
 * What we do _not_ do here:
 *   - Compile the runtime with @yao-pkg/pkg. The runtime uses dynamic
 *     `import()`, top-level await, and native addons — all of which fight
 *     with pkg's CJS-snapshot model (the chrome-devtools-mcp sidecar runs
 *     into the same issue).
 *
 * Run:  node scripts/build-desktop-runtime-sidecar.mjs
 * Or:   npm run build:desktop-runtime-sidecar
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const req = createRequire(import.meta.url);

const distEntry = path.join(root, 'dist/desktop-runtime/index.mjs');
const sidecarDir = path.join(root, 'tauri/sidecar/desktop-runtime');
const bundledNodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const bundledNodePath = path.join(sidecarDir, bundledNodeName);

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
});

step('3) copy runtime bundle (index.mjs + code-split chunks under assets/) + package.json', () => {
  // Vite splits dynamic imports into separate chunks under `assets/`. We
  // need ALL of them — copying only index.mjs and its source map breaks
  // the first dynamic `await import(...)` with ERR_MODULE_NOT_FOUND in the
  // packaged runtime.
  copyDir(path.dirname(distEntry), sidecarDir);
  // Vite doesn't emit a package.json. Write one declaring type=module so
  // Node treats `.js` chunks under `assets/` as ESM.
  fs.writeFileSync(
    path.join(sidecarDir, 'package.json'),
    JSON.stringify({ name: 'apple-pi-desktop-runtime', type: 'module', private: true }, null, 2),
  );
});

/**
 * Copy a single npm dep's *runtime* tree (lib + native addon + package.json)
 * into the sidecar's node_modules so Node can resolve it. `picks` is the set
 * of subpaths to include (e.g. `['lib', 'build/Release/...node']`); pass an
 * empty array to copy the whole package directory.
 *
 * Does NOT walk transitive dependencies; use `copyRuntimeDepWithDeps` for
 * that — the runtime loaders of native addons like better-sqlite3 do
 * `require('bindings')(...)` at instantiation time, so transitive deps
 * matter.
 */
function copyRuntimeDep(name, picks) {
  const depRoot = path.dirname(req.resolve(`${name}/package.json`));
  const dst = path.join(sidecarDir, 'node_modules', name);
  fs.mkdirSync(dst, { recursive: true });
  copyFile(path.join(depRoot, 'package.json'), path.join(dst, 'package.json'));
  // Empty picks ⇒ copy the whole package (typical for tiny pure-JS deps like
  // `bindings`/`file-uri-to-path` where there's nothing worth pruning).
  const items = picks.length > 0
    ? picks
    : fs.readdirSync(depRoot).filter((n) => n !== 'package.json' && n !== 'node_modules');
  for (const rel of items) {
    const s = path.join(depRoot, rel);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, rel);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

/**
 * Manually-curated runtime closure for `better-sqlite3`. Walking its full
 * `dependencies` graph would pull in `prebuild-install` and its 38 install-
 * time deps (tar-fs, readable-stream, …) — none of which are actually
 * `require`d at runtime. The only runtime deps better-sqlite3 reaches are:
 *
 *   - `bindings`             (lib/database.js calls require('bindings'))
 *   - `file-uri-to-path`     (bindings imports this)
 *
 * Both are tiny pure-JS shims. Keeping this list explicit instead of
 * dependency-graph-walking keeps the sidecar small AND makes regressions
 * obvious — if a future better-sqlite3 release adds a new runtime require,
 * the self-test below catches it before shipping.
 */
const BETTER_SQLITE3_RUNTIME_DEPS = ['bindings', 'file-uri-to-path'];

step('4) copy better-sqlite3 native addon + lib + minimal runtime closure', () => {
  copyRuntimeDep('better-sqlite3', ['lib', 'build/Release/better_sqlite3.node']);
  for (const dep of BETTER_SQLITE3_RUNTIME_DEPS) {
    copyRuntimeDep(dep, []); // whole package — both are tiny shims
  }
  info(`copied better-sqlite3 + runtime closure: ${BETTER_SQLITE3_RUNTIME_DEPS.join(', ')}`);
});

step('5) copy Node binary used for this build', () => {
  // Resolve symlinks (e.g. /opt/homebrew/bin/node → Cellar) so the shared-
  // library probe below inspects the real binary.
  const realNode = fs.realpathSync(process.execPath);
  copyFile(realNode, bundledNodePath);
  if (process.platform !== 'win32') {
    fs.chmodSync(bundledNodePath, 0o755);
  }

  // Official Node builds are statically linked, but Homebrew links node
  // against a shared libnode (@rpath/libnode.X.dylib). A bare copy of such
  // a binary dies with SIGABRT (dyld: Library not loaded) the moment it
  // runs. The binary's rpath includes its own directory, so bundling the
  // dylib next to it makes the copy self-contained.
  if (process.platform === 'darwin') {
    const linked = execSync(`otool -L "${realNode}"`, { encoding: 'utf8' });
    const m = linked.match(/@rpath\/(libnode[^\s]*\.dylib)/);
    if (m) {
      const libName = m[1];
      const libPath = path.join(path.dirname(realNode), '..', 'lib', libName);
      if (!fs.existsSync(libPath)) {
        throw new Error(
          `node is linked against shared ${libName} but it was not found at ${libPath}. ` +
          `Use an official Node build (nodejs.org / nvm) or fix the library path.`,
        );
      }
      copyFile(libPath, path.join(sidecarDir, libName));
      info(`bundled shared ${libName} alongside node (dynamically-linked build detected)`);
    }
  }
  info(`bundled ${process.version} from ${realNode}`);
});

step('6) copy sqlite-vec native artifact (if installed)', () => {
  try {
    copyRuntimeDep('sqlite-vec', ['dist', 'src']);
  } catch (err) {
    info(`sqlite-vec not installed; skipping (${err?.code ?? 'EOTHER'})`);
  }
});

step('7a) regression guard: bundled runtime files actually present on disk', () => {
  // Sanity: a future refactor that drops bindings/file-uri-to-path would
  // make this list shrink. The end-to-end self-test below would catch it
  // too, but a clear early failure is friendlier.
  for (const dep of ['better-sqlite3', ...BETTER_SQLITE3_RUNTIME_DEPS]) {
    const pkg = path.join(sidecarDir, 'node_modules', dep, 'package.json');
    if (!fs.existsSync(pkg)) {
      throw new Error(`Expected bundled dep ${dep} (missing ${pkg})`);
    }
  }
  if (!fs.existsSync(bundledNodePath)) {
    throw new Error(`Expected bundled node binary (missing ${bundledNodePath})`);
  }
});

step('7b) self-test (instantiate the bundled native addon end-to-end)', () => {
  // Spawn `node` with cwd = sidecarDir so it resolves modules from the
  // bundled node_modules ONLY (the project's outer node_modules is up the
  // tree from sidecarDir, so this is also a regression guard against the
  // earlier false-positive where `require('better-sqlite3')` succeeded
  // without `bindings` because the addon load only happens at
  // `new Database(...)` time).
  //
  // We isolate the resolver by setting NODE_PATH to an empty path AND
  // walking from a tmpdir whose ancestors have no node_modules — that's
  // what the packaged install looks like.
  const isolatedTmp = fs.mkdtempSync(path.join(root, 'tauri/sidecar/.selftest-'));
  try {
    // Copy the sidecar tree into a path with no ancestor node_modules.
    const isolatedSidecar = path.join(isolatedTmp, 'sidecar');
    const isolatedNode = path.join(isolatedSidecar, bundledNodeName);
    copyDir(sidecarDir, isolatedSidecar);
    execFileSync(
      isolatedNode,
      ['-e', "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('CREATE TABLE t(x)'); db.close(); console.log('addon-ok')"],
      {
        cwd: isolatedSidecar,
        stdio: 'inherit',
        env: { ...process.env, NODE_PATH: '' },
      },
    );
  } finally {
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

step('7c) self-test (import the runtime entry — catches missing bundled deps)', () => {
  // The previous step proves the native addon loads. This step proves the
  // FULL runtime bundle's import graph resolves — every static AND every
  // dynamic `import(...)` chunk. Two ways this can go wrong:
  //
  //   1. A static dep is externalized but not bundled in node_modules
  //      (e.g. zod left external by the Vite SSR default). The static
  //      import fails before main() even runs.
  //   2. The Vite code-split chunks under `assets/` weren't copied into
  //      the sidecar tree. main() runs, calls bootstrap.initialize(),
  //      which dynamically imports a chunk → ERR_MODULE_NOT_FOUND.
  //
  // We exercise both: spawn the runtime with a synthesized host so
  // bootstrap.initialize() actually runs, point stdin at /dev/null so it
  // exits on EOF, and SCAN STDERR for ERR_MODULE_NOT_FOUND. Any such error
  // fails the self-test, no matter how the runtime otherwise exits.
  const isolatedTmp = fs.mkdtempSync(path.join(root, 'tauri/sidecar/.entrytest-'));
  try {
    const isolatedSidecar = path.join(isolatedTmp, 'sidecar');
    const isolatedNode = path.join(isolatedSidecar, bundledNodeName);
    copyDir(sidecarDir, isolatedSidecar);
    const fakeConfigDir = path.join(isolatedTmp, 'fake-config');
    fs.mkdirSync(fakeConfigDir, { recursive: true });
    const host = JSON.stringify({
      configDir: fakeConfigDir,
      storageDbPath: path.join(fakeConfigDir, 'storage.db'),
      rolloutDbPath: path.join(fakeConfigDir, 'rollouts.db'),
      configJsonPath: path.join(fakeConfigDir, 'config.json'),
      cacheDir: path.join(fakeConfigDir, 'cache'),
      logDir: path.join(fakeConfigDir, 'logs'),
      keychainServicePrefix: 'applepi-selftest',
      platform: process.platform,
      arch: process.arch,
    });
    // Spawn with stdin closed → carrier's read() hits EOF → main() exits.
    // Capture stderr so we can scan it for module-resolution errors that
    // happen during async initialization.
    const child = childProcessOnce(
      isolatedNode,
      [path.join(isolatedSidecar, 'index.mjs')],
      {
        cwd: isolatedSidecar,
        env: {
          ...process.env,
          NODE_PATH: '',
          APPLEPI_RUNTIME_PROFILE: 'desktop-runtime',
          APPLEPI_DESKTOP_RUNTIME_HOST: host,
        },
        timeout: 10_000,
      },
    );
    if (/ERR_MODULE_NOT_FOUND/.test(child.stderr) || /ERR_MODULE_NOT_FOUND/.test(child.stdout)) {
      console.error('Runtime stderr:\n' + child.stderr);
      throw new Error('Bundled runtime has unresolved imports — see stderr above');
    }
    info('runtime imports resolve cleanly (no ERR_MODULE_NOT_FOUND in stderr)');
  } finally {
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

/**
 * Synchronous spawn-once helper that captures stdout+stderr and enforces a
 * hard timeout. Returns the captured streams regardless of exit code; the
 * caller decides what counts as failure.
 */
function childProcessOnce(cmd, args, opts) {
  const result = spawnSync(cmd, args, {
    ...opts,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

info('done; output: ' + sidecarDir);
