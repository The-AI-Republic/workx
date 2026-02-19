#!/usr/bin/env node

/**
 * Sync version across all config files for release builds.
 * Takes a version string from CLI arg and updates:
 *   - tauri/tauri.conf.json  → "version" field
 *   - tauri/Cargo.toml       → version = "..." under [package]
 *   - package.json           → "version" field
 *
 * Usage:
 *   node scripts/sync-version.js 1.0.0
 */

const fs = require('fs');
const path = require('path');

const TAURI_CONF_PATH = path.join(__dirname, '..', 'tauri', 'tauri.conf.json');
const CARGO_TOML_PATH = path.join(__dirname, '..', 'tauri', 'Cargo.toml');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

function syncVersion() {
  const version = process.argv[2];

  if (!version) {
    console.error('Usage: node scripts/sync-version.js <version>');
    console.error('Example: node scripts/sync-version.js 1.0.0');
    process.exit(1);
  }

  // Validate version format (X.Y.Z)
  const versionParts = version.split('.');
  if (versionParts.length !== 3 || !versionParts.every(part => /^\d+$/.test(part))) {
    console.error('Error: Version must be in format X.Y.Z (e.g., 1.0.0)');
    process.exit(1);
  }

  try {
    // Update tauri/tauri.conf.json
    const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf8'));
    tauriConf.version = version;
    fs.writeFileSync(TAURI_CONF_PATH, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
    console.log(`Updated tauri/tauri.conf.json → ${version}`);

    // Update tauri/Cargo.toml (replace version line under [package])
    let cargoToml = fs.readFileSync(CARGO_TOML_PATH, 'utf8');
    cargoToml = cargoToml.replace(
      /^(version\s*=\s*)"[^"]*"/m,
      `$1"${version}"`
    );
    fs.writeFileSync(CARGO_TOML_PATH, cargoToml, 'utf8');
    console.log(`Updated tauri/Cargo.toml → ${version}`);

    // Update package.json
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    packageJson.version = version;
    fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    console.log(`Updated package.json → ${version}`);

    console.log(`\nAll config files synced to version ${version}`);
  } catch (error) {
    console.error('Error syncing version:', error.message);
    process.exit(1);
  }
}

syncVersion();
