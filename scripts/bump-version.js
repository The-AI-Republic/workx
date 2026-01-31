#!/usr/bin/env node

/**
 * Bump version script for Chrome Extension
 * Sets the version in manifest.json to the provided version argument,
 * or increments the patch version if no argument is provided.
 *
 * Usage:
 *   node bump-version.js           # Increments patch version (0.0.9 -> 0.0.10)
 *   node bump-version.js 1.2.3     # Sets version to 1.2.3
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');

function bumpVersion() {
  try {
    // Read manifest.json
    const manifestContent = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(manifestContent);

    if (!manifest.version) {
      console.error('Error: No version field found in manifest.json');
      process.exit(1);
    }

    const oldVersion = manifest.version;
    let newVersion;

    // Check if a version was provided as argument
    const providedVersion = process.argv[2];

    if (providedVersion) {
      // Validate the provided version format
      const versionParts = providedVersion.split('.');
      if (versionParts.length !== 3 || !versionParts.every(part => /^\d+$/.test(part))) {
        console.error('Error: Provided version must be in format X.Y.Z (e.g., 1.2.3)');
        process.exit(1);
      }
      newVersion = providedVersion;
      console.log(`Setting version from ${oldVersion} to ${newVersion} (from git tag)`);
    } else {
      // Parse current version and increment patch
      const versionParts = oldVersion.split('.');
      if (versionParts.length !== 3) {
        console.error('Error: Current version must be in format X.Y.Z');
        process.exit(1);
      }

      const major = parseInt(versionParts[0], 10);
      const minor = parseInt(versionParts[1], 10);
      const patch = parseInt(versionParts[2], 10);

      newVersion = `${major}.${minor}.${patch + 1}`;
      console.log(`Bumping version from ${oldVersion} to ${newVersion}`);
    }

    // Update version in manifest
    manifest.version = newVersion;

    // Write back to manifest.json with proper formatting
    const updatedContent = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(MANIFEST_PATH, updatedContent, 'utf8');

    console.log(`✅ Version updated successfully to ${newVersion}`);
    console.log(`Updated: ${MANIFEST_PATH}`);

  } catch (error) {
    console.error('Error bumping version:', error.message);
    process.exit(1);
  }
}

// Run the script
bumpVersion();
