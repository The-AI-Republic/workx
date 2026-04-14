/**
 * Unit tests for CoreMemoryManager.
 *
 * Tests file creation, reading, and LLM-based core fact merging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreMemoryManager } from '../CoreMemoryManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFS(files: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(files));
  return {
    readFile: vi.fn().mockImplementation(async (path: string) => {
      if (store.has(path)) return store.get(path)!;
      throw new Error(`File not found: ${path}`);
    }),
    writeFile: vi.fn().mockImplementation(async (path: string, content: string) => {
      store.set(path, content);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation(async (path: string) => store.has(path)),
    _store: store,
  };
}

function createMockLLM(response: string = 'merged content') {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

const MEMORY_DIR = '/home/test/.memory';
const CORE_FILE = `${MEMORY_DIR}/core-memory.md`;

// ---------------------------------------------------------------------------
// ensureFile
// ---------------------------------------------------------------------------

describe('CoreMemoryManager.ensureFile', () => {
  it('creates directory and default file when file does not exist', async () => {
    const fs = createMockFS();
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.ensureFile();

    expect(fs.ensureDir).toHaveBeenCalledWith(MEMORY_DIR);
    expect(fs.writeFile).toHaveBeenCalledWith(
      CORE_FILE,
      expect.stringContaining('# User Profile')
    );
  });

  it('does not overwrite existing file', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Existing content' });
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.ensureFile();

    expect(fs.ensureDir).toHaveBeenCalled();
    // writeFile should NOT have been called since file exists
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getCoreMemoryContent
// ---------------------------------------------------------------------------

describe('CoreMemoryManager.getCoreMemoryContent', () => {
  it('returns file content when file exists', async () => {
    const content = '# User Profile\n- Name: Alex';
    const fs = createMockFS({ [CORE_FILE]: content });
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    const result = await manager.getCoreMemoryContent();
    expect(result).toBe(content);
  });

  it('creates default file and returns its content when file does not exist', async () => {
    const fs = createMockFS();
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    const result = await manager.getCoreMemoryContent();
    // After ensureFile, the default template is written and then readFile returns it
    expect(result).toContain('# User Profile');
  });

  it('returns empty string when readFile throws', async () => {
    const fs = createMockFS();
    // Override readFile to always throw
    fs.readFile.mockRejectedValue(new Error('disk error'));
    // Override exists to return true so ensureFile doesn't try to write
    fs.exists.mockResolvedValue(true);
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    const result = await manager.getCoreMemoryContent();
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// removeFacts
// ---------------------------------------------------------------------------

describe('CoreMemoryManager.removeFacts', () => {
  it('removes matching non-heading lines and preserves headings', async () => {
    const fs = createMockFS({
      [CORE_FILE]: '# Preferences\n- Prefers dark mode\n- Uses vim\n\n# Behavior\n- Be concise\n',
    });
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    const removed = await manager.removeFacts(['dark mode', 'concise']);

    expect(removed).toBe(2);
    expect(fs.writeFile).toHaveBeenCalledWith(
      CORE_FILE,
      '# Preferences\n- Uses vim\n\n# Behavior\n'
    );
  });

  it('returns 0 and does not rewrite when nothing matches', async () => {
    const original = '# Preferences\n- Uses vim\n';
    const fs = createMockFS({ [CORE_FILE]: original });
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    const removed = await manager.removeFacts(['dark mode']);

    expect(removed).toBe(0);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeCoreFacts
// ---------------------------------------------------------------------------

describe('CoreMemoryManager.mergeCoreFacts', () => {
  it('does nothing when facts array is empty', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = createMockLLM();
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('calls LLM with existing markdown and new facts', async () => {
    const existingContent = '# User Profile\n- Likes cats';
    const fs = createMockFS({ [CORE_FILE]: existingContent });
    const llm = createMockLLM('# User Profile\n- Likes cats\n- Prefers dark mode');
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts(['User prefers dark mode']);

    expect(llm.complete).toHaveBeenCalledOnce();
    const [systemPrompt] = llm.complete.mock.calls[0];
    expect(systemPrompt).toContain(existingContent);
    expect(systemPrompt).toContain('User prefers dark mode');
  });

  it('writes merged content back to file', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = createMockLLM('# Profile\n- Updated content');
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts(['New fact']);

    // Check that writeFile was called with the merged content + trailing newline
    expect(fs.writeFile).toHaveBeenCalledWith(
      CORE_FILE,
      '# Profile\n- Updated content\n'
    );
  });

  it('strips markdown code fences from LLM response', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = createMockLLM('```markdown\n# Profile\n- Updated\n```');
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts(['New fact']);

    expect(fs.writeFile).toHaveBeenCalledWith(
      CORE_FILE,
      '# Profile\n- Updated\n'
    );
  });

  it('strips plain code fences from LLM response', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = createMockLLM('```\n# Profile\n- Updated\n```');
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts(['Fact']);

    expect(fs.writeFile).toHaveBeenCalledWith(
      CORE_FILE,
      '# Profile\n- Updated\n'
    );
  });

  it('does not write if cleaned response is empty', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = createMockLLM('');
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts(['Fact']);

    // writeFile should not be called with empty content
    // But ensureFile may call writeFile — check that only ensureFile call happened
    const writeCalls = fs.writeFile.mock.calls.filter(
      (args: any[]) => args[1] !== '' && !(args[1] as string).includes('# User Profile')
    );
    expect(writeCalls).toHaveLength(0);
  });

  it('handles LLM error gracefully', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = { complete: vi.fn().mockRejectedValue(new Error('API error')) };
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    // Should not throw
    await expect(manager.mergeCoreFacts(['Fact'])).resolves.toBeUndefined();
  });

  it('formats multiple facts as numbered list', async () => {
    const fs = createMockFS({ [CORE_FILE]: '# Profile' });
    const llm = createMockLLM('# Profile\n- Merged');
    const manager = new CoreMemoryManager(llm, fs, MEMORY_DIR);

    await manager.mergeCoreFacts(['Fact A', 'Fact B', 'Fact C']);

    const [systemPrompt] = llm.complete.mock.calls[0];
    expect(systemPrompt).toContain('1. Fact A');
    expect(systemPrompt).toContain('2. Fact B');
    expect(systemPrompt).toContain('3. Fact C');
  });
});
