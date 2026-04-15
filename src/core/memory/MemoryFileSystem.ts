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
    return createTauriFileSystem();
  }
  if (__BUILD_MODE__ === 'server') {
    return createNodeFileSystem();
  }
  throw new Error(
    `Memory filesystem not supported in build mode: ${__BUILD_MODE__}`
  );
}

async function createTauriFileSystem(): Promise<{
  fs: FileSystem;
  memoryDir: string;
}> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { homeDir, join } = await import('@tauri-apps/api/path');

  const home = await homeDir();
  const memoryDir = await join(home, '.airepublic-pi', 'memory');

  const fs: FileSystem = {
    readFile: async (path: string) => {
      const content = await invoke<string | null>('skills_read_file', { path });
      return content ?? '';
    },
    writeFile: async (path: string, content: string) => {
      await invoke('skills_write_file', { path, content });
    },
    ensureDir: async (path: string) => {
      await invoke('skills_ensure_dir', { path });
    },
    exists: async (path: string) => {
      try {
        const content = await invoke<string | null>('skills_read_file', { path });
        return content !== null;
      } catch {
        return false;
      }
    },
  };

  return { fs, memoryDir };
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
