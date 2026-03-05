/**
 * Manages the core-memory.md file that stores always-inject preferences,
 * instructions, and behaviors. Uses LLM to merge new core facts into
 * the existing markdown structure.
 */

import coreMergePrompt from './prompts/core_merge.md?raw';

interface LLMCaller {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const DEFAULT_CORE_MEMORY = `# User Profile

# Preferences

# Instructions

# Behavior
`;

export class CoreMemoryManager {
  private llm: LLMCaller;
  private fs: FileSystem;
  private memoryDir: string;

  constructor(llm: LLMCaller, fs: FileSystem, memoryDir: string) {
    this.llm = llm;
    this.fs = fs;
    this.memoryDir = memoryDir;
  }

  private get filePath(): string {
    return `${this.memoryDir}/core-memory.md`;
  }

  /**
   * Ensure the core-memory.md file exists with a default template.
   */
  async ensureFile(): Promise<void> {
    await this.fs.ensureDir(this.memoryDir);
    const exists = await this.fs.exists(this.filePath);
    if (!exists) {
      await this.fs.writeFile(this.filePath, DEFAULT_CORE_MEMORY);
    }
  }

  /**
   * Read the current core memory content.
   */
  async getCoreMemoryContent(): Promise<string> {
    try {
      await this.ensureFile();
      return await this.fs.readFile(this.filePath);
    } catch (err) {
      console.warn('[Memory] Failed to read core-memory.md:', err);
      return '';
    }
  }

  /**
   * Merge new core facts into the existing core-memory.md using LLM.
   */
  async mergeCoreFacts(facts: string[]): Promise<void> {
    if (facts.length === 0) return;

    const existingMarkdown = await this.getCoreMemoryContent();
    const newFactsText = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const systemPrompt = coreMergePrompt
      .replace('{{existingMarkdown}}', existingMarkdown)
      .replace('{{newFacts}}', newFactsText);

    try {
      const updatedMarkdown = await this.llm.complete(systemPrompt, '');

      // Strip any markdown code fences the LLM might wrap the response in
      const cleaned = updatedMarkdown
        .replace(/^```(?:markdown)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

      if (cleaned.length > 0) {
        await this.fs.writeFile(this.filePath, cleaned + '\n');
      }
    } catch (err) {
      console.warn('[Memory] Core memory merge failed:', err);
    }
  }
}
