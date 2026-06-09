#!/usr/bin/env node
/**
 * WorkX Identity Management CLI
 *
 * Manages owner platform identities for channel plugins.
 *
 * Usage:
 *   node scripts/applepi-identity.js list
 *   node scripts/applepi-identity.js add <platform> <userId>
 *   node scripts/applepi-identity.js remove <platform> <userId>
 *
 * Examples:
 *   node scripts/applepi-identity.js add slack U1234567
 *   node scripts/applepi-identity.js add telegram 12345678
 *   node scripts/applepi-identity.js list
 *   node scripts/applepi-identity.js remove slack U1234567
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG_PATH = process.env.APPLEPI_CONFIG_PATH ??
  path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.applepi-server', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const [,, command, platform, userId] = process.argv;

const config = loadConfig();
if (!config.owner) config.owner = {};
if (!config.owner.identities) config.owner.identities = {};

switch (command) {
  case 'list':
    console.log('Owner Identities:');
    for (const [p, ids] of Object.entries(config.owner.identities)) {
      console.log(`  ${p}: ${(ids || []).join(', ')}`);
    }
    if (Object.keys(config.owner.identities).length === 0) {
      console.log('  (none configured)');
    }
    break;

  case 'add':
    if (!platform || !userId) {
      console.error('Usage: applepi-identity add <platform> <userId>');
      process.exit(1);
    }
    if (!config.owner.identities[platform]) {
      config.owner.identities[platform] = [];
    }
    if (!config.owner.identities[platform].includes(userId)) {
      config.owner.identities[platform].push(userId);
      saveConfig(config);
      console.log(`Added ${platform}:${userId}`);
    } else {
      console.log(`Already exists: ${platform}:${userId}`);
    }
    break;

  case 'remove':
    if (!platform || !userId) {
      console.error('Usage: applepi-identity remove <platform> <userId>');
      process.exit(1);
    }
    if (config.owner.identities[platform]) {
      config.owner.identities[platform] = config.owner.identities[platform].filter(id => id !== userId);
      if (config.owner.identities[platform].length === 0) {
        delete config.owner.identities[platform];
      }
      saveConfig(config);
      console.log(`Removed ${platform}:${userId}`);
    } else {
      console.log(`Not found: ${platform}:${userId}`);
    }
    break;

  default:
    console.log('Usage: applepi-identity <list|add|remove> [platform] [userId]');
    process.exit(1);
}
