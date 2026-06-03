#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const baseDir = path.join(root, '.ai_design', 'agent_improvements');
const ledgerPath = path.join(baseDir, 'track_status.yml');
const readmePath = path.join(baseDir, 'README.md');

const ledger = YAML.parse(fs.readFileSync(ledgerPath, 'utf-8'));
const readme = fs.readFileSync(readmePath, 'utf-8');
const tracks = Array.isArray(ledger?.tracks) ? ledger.tracks : [];
const errors = [];

const suffixByStatus = {
  done: '_DONE',
  abandoned: '_ABANDONED',
  deferred: '_DEFERRED',
};

for (const track of tracks) {
  if (!track?.id || !track?.path || !track?.code_status || !track?.design_status) {
    errors.push(`Malformed track row: ${JSON.stringify(track)}`);
    continue;
  }

  const trackDir = path.join(baseDir, track.path);
  if (!fs.existsSync(trackDir)) {
    errors.push(`Missing directory for track ${track.id}: ${track.path}`);
    continue;
  }

  const requiredSuffix = suffixByStatus[track.code_status];
  if (requiredSuffix && !track.path.endsWith(requiredSuffix)) {
    errors.push(`Track ${track.id} code_status=${track.code_status} but path lacks ${requiredSuffix}: ${track.path}`);
  }

  if (track.code_status === 'open' && /_(DONE|ABANDONED|DEFERRED)$/.test(track.path)) {
    errors.push(`Track ${track.id} code_status=open but path looks terminal: ${track.path}`);
  }

  const readmeNeedle = `./${track.path}/design.md`;
  if (!readme.includes(readmeNeedle)) {
    errors.push(`README missing design link for track ${track.id}: ${readmeNeedle}`);
  }
}

const legacy = Array.isArray(ledger?.legacy_design_sets) ? ledger.legacy_design_sets : [];
for (const dir of legacy) {
  const legacyPath = path.join(root, '.ai_design', dir);
  if (!fs.existsSync(legacyPath)) {
    errors.push(`Missing legacy design set listed in ledger: ${dir}`);
  }
}

if (errors.length > 0) {
  console.error('Agent improvement status check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Agent improvement status check passed (${tracks.length} tracks, ${legacy.length} legacy design sets).`);
