/**
 * Platform-specific filesystem abstraction for CoreMemoryManager.
 * Provides read/write/exists/ensureDir for core-memory.md operations.
 */

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

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
  const { appDataDir, join } = await import('@tauri-apps/api/path');

  const dataDir = await appDataDir();
  const memoryDir = await join(dataDir, 'memory');

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
      const content = await invoke<string | null>('skills_read_file', { path });
      return content !== null;
    },
  };

  return { fs, memoryDir };
}

async function createNodeFileSystem(): Promise<{
  fs: FileSystem;
  memoryDir: string;
}> {
  const nodeFs = require('fs');
  const nodePath = require('path');
  const os = require('os');

  const memoryDir = nodePath.join(
    os.homedir(),
    '.airepublic-pi',
    'memory'
  );

  const fs: FileSystem = {
    readFile: async (path: string) =>
      nodeFs.readFileSync(path, 'utf-8') as string,
    writeFile: async (path: string, content: string) =>
      nodeFs.writeFileSync(path, content, 'utf-8'),
    ensureDir: async (path: string) =>
      nodeFs.mkdirSync(path, { recursive: true }),
    exists: async (path: string) => nodeFs.existsSync(path),
  };

  return { fs, memoryDir };
}
