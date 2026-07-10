/**
 * Stage the ripgrep binary as a Tauri externalBin sidecar.
 *
 * The desktop build (Tauri WebView) cannot spawn processes from JS; the
 * Rust `ripgrep_execute` command resolves `rg` as: system PATH → this
 * bundled sidecar (placed next to the app exe by Tauri). This script
 * copies the `@vscode/ripgrep` binary to tauri/binaries/rg-<triple><ext>
 * so Tauri's bundler picks it up.
 *
 * macOS universal builds (`--target universal-apple-darwin`) compile BOTH
 * arches and Tauri resolves the externalBin per concrete target, so it needs
 * rg-aarch64-apple-darwin AND rg-x86_64-apple-darwin present. @vscode/ripgrep
 * ships one platform package per arch and npm only installs the host arch, so
 * on macOS we force-install both arch packages and stage each (plus a lipo'd
 * universal, mirroring build-sidecar.mjs). Staging only the host arch is what
 * broke the v3.0.0 macOS release: `resource path rg-x86_64-apple-darwin doesn't exist`.
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

const binDir = path.resolve(root, 'tauri/binaries');
fs.mkdirSync(binDir, { recursive: true });

/** Resolve a platform package's `rg` binary, or null if not installed. */
function resolveRg(pkg) {
  try {
    return require.resolve(`${pkg}/bin/rg`);
  } catch {
    return null;
  }
}

/** Copy an rg binary to tauri/binaries/rg-<triple><ext> and mark it executable. */
function stage(srcRgPath, triple, ext = '') {
  const out = path.join(binDir, `rg-${triple}${ext}`);
  fs.copyFileSync(srcRgPath, out);
  if (ext === '') fs.chmodSync(out, 0o755);
  console.log(`✓ ripgrep sidecar staged: ${out}`);
  return out;
}

if (process.platform === 'darwin') {
  const arches = [
    { pkg: '@vscode/ripgrep-darwin-arm64', triple: 'aarch64-apple-darwin' },
    { pkg: '@vscode/ripgrep-darwin-x64', triple: 'x86_64-apple-darwin' }
  ];

  // npm installs only the host arch's optional package; pull in whichever arch
  // packages are missing (force past the os/cpu guard) so both are on disk.
  if (arches.some((a) => !resolveRg(a.pkg))) {
    // Pin to the installed @vscode/ripgrep version so the arch binaries match.
    const hostRg = require('@vscode/ripgrep').rgPath;
    const version = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(hostRg), '..', 'package.json'), 'utf8')
    ).version;
    const spec = arches.map((a) => `${a.pkg}@${version}`).join(' ');
    console.log(`Installing ripgrep arch packages: ${spec}`);
    execSync(`npm install --no-save --force ${spec}`, { cwd: root, stdio: 'inherit' });
  }

  const outs = arches.map((a) => {
    const src = resolveRg(a.pkg);
    if (!src) {
      console.error(`Could not resolve ${a.pkg}/bin/rg after install.`);
      process.exit(1);
    }
    return stage(src, a.triple);
  });

  // Universal binary for Tauri's universal-apple-darwin bundler path.
  const universal = path.join(binDir, 'rg-universal-apple-darwin');
  execSync(`lipo -create -output "${universal}" "${outs[0]}" "${outs[1]}"`, { stdio: 'inherit' });
  fs.chmodSync(universal, 0o755);
  console.log(`✓ ripgrep universal sidecar: ${universal}`);
} else {
  // Windows / Linux: single arch, host binary is sufficient.
  const PLATFORM_MAP = {
    'win32-x64': { triple: 'x86_64-pc-windows-msvc', ext: '.exe' },
    'linux-x64': { triple: 'x86_64-unknown-linux-gnu', ext: '' }
  };
  const key = `${process.platform}-${process.arch}`;
  const mapping = PLATFORM_MAP[key];
  if (!mapping) {
    console.error(`Unsupported platform: ${key}. Supported: ${Object.keys(PLATFORM_MAP).join(', ')}, darwin-*`);
    process.exit(1);
  }
  const { rgPath } = require('@vscode/ripgrep');
  if (!rgPath || !fs.existsSync(rgPath)) {
    console.error(`@vscode/ripgrep binary not found at ${rgPath}. Run npm install.`);
    process.exit(1);
  }
  stage(rgPath, mapping.triple, mapping.ext);
}
