/**
 * Platform-specific filesystem abstraction for CoreMemoryManager.
 * Provides read/write/exists/ensureDir for core-memory.md operations.
 */

import type { FileSystem } from './types';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

/**
 * Create a platform-appropriate filesystem adapter.
 */
export async function createMemoryFileSystem(): Promise<{
  fs: FileSystem;
  memoryDir: string;
}> {
  if (__BUILD_MODE__ === 'desktop') {
    // Track 43: the agent (and memory FS) runs inside the Node runtime
    // sidecar after the cutover. The desktop WebView never calls this; the
    // legacy Tauri branch that invoked the deleted skills_* commands has
    // been removed. Any post-cutover caller in the WebView is a bug.
    throw new Error('Memory filesystem is owned by the runtime sidecar; the WebView must not call createMemoryFileSystem()');
  }
  if (__BUILD_MODE__ === 'server') {
    return createNodeFileSystem();
  }
  throw new Error(
    `Memory filesystem not supported in build mode: ${__BUILD_MODE__}`
  );
}

async function createNodeFileSystem(): Promise<{
  fs: FileSystem;
  memoryDir: string;
}> {
  // H2: Use async fs.promises instead of blocking *Sync calls
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const os = await import('os');

  const memoryDir = nodePath.join(
    os.homedir(),
    '.airepublic-pi',
    'memory'
  );

  const fsPromises = nodeFs.promises;
  const fs: FileSystem = {
    readFile: (path: string) => fsPromises.readFile(path, 'utf-8'),
    writeFile: (path: string, content: string) =>
      fsPromises.writeFile(path, content, 'utf-8'),
    ensureDir: async (path: string) => {
      await fsPromises.mkdir(path, { recursive: true });
    },
    exists: async (path: string) => {
      try {
        await fsPromises.access(path);
        return true;
      } catch {
        return false;
      }
    },
  };

  return { fs, memoryDir };
}
