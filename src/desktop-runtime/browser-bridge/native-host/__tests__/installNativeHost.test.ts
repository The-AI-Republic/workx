import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  NATIVE_HOST_NAME,
  buildHostManifest,
  installNativeHost,
} from '../installNativeHost';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('native host installation', () => {
  it('quotes POSIX paths and repairs token/wrapper permissions on overwrite', async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workx-native-O'Brien-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data-O'Brien");
    const relayPath = path.join(root, "relay-O'Brien.mjs");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'bridge-native-token'), 'old-token', { mode: 0o666 });
    await writeFile(path.join(dataDir, 'workx-native-host.sh'), '#!/bin/sh\n', { mode: 0o766 });
    await chmod(path.join(dataDir, 'bridge-native-token'), 0o666);
    await chmod(path.join(dataDir, 'workx-native-host.sh'), 0o766);
    await writeFile(
      relayPath,
      "process.stdout.write(JSON.stringify({ url: process.env.WORKX_APP_SERVER_URL, tokenFile: process.env.WORKX_BRIDGE_TOKEN_FILE }));\n",
    );

    const installed = await installNativeHost({
      nodePath: process.execPath,
      relayPath,
      appServerUrl: 'ws://127.0.0.1:18101',
      token: 'secret-token',
      extensionId: 'fdopfohnbeknmiklninbkkdknpenihki',
      dataDir,
      home: path.join(root, 'home'),
      platform: 'linux',
    });

    const run = spawnSync(installed.wrapperPath, { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      url: 'ws://127.0.0.1:18101',
      tokenFile: path.join(dataDir, 'bridge-native-token'),
    });
    expect((await stat(path.join(dataDir, 'bridge-native-token'))).mode & 0o777).toBe(0o600);
    expect((await stat(installed.wrapperPath)).mode & 0o777).toBe(0o700);
    expect(installed.written).toHaveLength(4);

    const manifest = JSON.parse(await readFile(installed.written[0], 'utf8'));
    expect(manifest).toEqual(
      buildHostManifest(installed.wrapperPath, 'fdopfohnbeknmiklninbkkdknpenihki'),
    );
    expect(manifest.name).toBe(NATIVE_HOST_NAME);
  });

  it('fails explicitly on Windows so callers use token-paired WebSocket fallback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workx-native-win-'));
    tempDirs.push(root);

    await expect(
      installNativeHost({
        nodePath: 'node.exe',
        relayPath: 'relay.mjs',
        appServerUrl: 'ws://127.0.0.1:18101',
        token: 'secret-token',
        extensionId: 'fdopfohnbeknmiklninbkkdknpenihki',
        dataDir: root,
        home: root,
        platform: 'win32',
      }),
    ).rejects.toThrow('pairing-token WebSocket fallback');
  });
});
