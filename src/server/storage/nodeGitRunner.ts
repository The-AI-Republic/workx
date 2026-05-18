/**
 * Node GitRunner + filesystem helpers for the git-based plugin fetch
 * (server runtime). Desktop would supply a Rust-backed runner; the
 * extension uses the GitHub tarball path instead.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitRunner, GitRunResult } from '@/core/plugins/git';

/** child_process-backed GitRunner. */
export const nodeGitRunner: GitRunner = (args, opts): Promise<GitRunResult> => {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 124, stdout, stderr: stderr + '\n[timed out]' });
    }, opts.timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
};

export async function nodeMkTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'browserx-plugin-'));
}

export async function nodeWalkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        await walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk(root, '');
  return out;
}

export async function nodeReadBytes(p: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(p));
}

export async function nodeRemoveDir(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/** `git -C <dir> rev-parse HEAD` → 40-hex sha, or undefined. */
export async function nodeResolveHeadSha(cloneDir: string): Promise<string | undefined> {
  const res = await nodeGitRunner(['-C', cloneDir, 'rev-parse', 'HEAD'], {
    env: {},
    timeoutMs: 15_000,
  });
  if (res.code !== 0) return undefined;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}
