#!/usr/bin/env node

/**
 * Environment file validation script
 * Checks that required .env files exist before running build/dev commands
 *
 * Usage:
 *   node scripts/check-env.js extension  # Check src/extension/.env
 *   node scripts/check-env.js desktop    # Check src/desktop/.env
 *   node scripts/check-env.js all        # Check both
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const ENV_PATHS = {
  extension: resolve(projectRoot, 'src/extension/.env'),
  desktop: resolve(projectRoot, 'src/desktop/.env'),
};

const ENV_EXAMPLE_PATH = resolve(projectRoot, '.env.example');

function checkEnvFile(target) {
  const envPath = ENV_PATHS[target];
  if (!envPath) {
    console.error(`\x1b[31mError: Unknown target "${target}"\x1b[0m`);
    console.error(`Valid targets: ${Object.keys(ENV_PATHS).join(', ')}, all`);
    process.exit(1);
  }

  if (!existsSync(envPath)) {
    console.error(`\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
    console.error(`\x1b[31mError: Missing .env file for ${target}\x1b[0m`);
    console.error(`\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
    console.error(`\nExpected: ${envPath}`);
    console.error(`\nTo fix this, copy the example file and customize it:`);
    console.error(`\n  cp .env.example src/${target}/.env`);
    console.error(`\nThen edit src/${target}/.env with your configuration values.`);
    console.error(`\nSee README.md for more information about environment configuration.\n`);
    return false;
  }
  return true;
}

function main() {
  const target = process.argv[2];

  if (!target) {
    console.error('Usage: node scripts/check-env.js <extension|desktop|all>');
    process.exit(1);
  }

  // Check that .env.example exists (sanity check)
  if (!existsSync(ENV_EXAMPLE_PATH)) {
    console.error(`\x1b[33mWarning: .env.example not found at ${ENV_EXAMPLE_PATH}\x1b[0m`);
  }

  let success = true;

  if (target === 'all') {
    for (const t of Object.keys(ENV_PATHS)) {
      if (!checkEnvFile(t)) {
        success = false;
      }
    }
  } else {
    success = checkEnvFile(target);
  }

  if (!success) {
    process.exit(1);
  }

  console.log(`\x1b[32m✓ Environment file(s) validated for: ${target}\x1b[0m`);
}

main();
