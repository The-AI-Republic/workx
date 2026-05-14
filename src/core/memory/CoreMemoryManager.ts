/**
 * Manages the core-memory.md file that stores always-inject preferences,
 * instructions, and behaviors. Uses LLM to merge new core facts into
 * the existing markdown structure.
 */

import coreMergePrompt from './prompts/core_merge.md?raw';
import type { LLMCaller, FileSystem } from './types';

const DEFAULT_CORE_MEMORY = `# User Profile

# Preferences

# Instructions

# Behavior
`;

export class CoreMemoryManager {
  private llm: LLMCaller;
  private fs: FileSystem;
  private memoryDir: string;
  private mergeQueue: Promise<void> = Promise.resolve();

  constructor(llm: LLMCaller, fs: FileSystem, memoryDir: string) {
    this.llm = llm;
    this.fs = fs;
    this.memoryDir = memoryDir;
  }

  private get filePath(): string {
    // Ensure no double-separator: strip trailing sep, then append
    // Preserve the separator style from the input path
    const sep = this.memoryDir.includes('\\') ? '\\' : '/';
    const dir = this.memoryDir.replace(/[/\\]$/, '');
    return `${dir}${sep}core-memory.md`;
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
   * Throws on read failure so callers (e.g. mergeCoreFacts) can abort
   * rather than treating a transient error as an empty document.
   */
  async getCoreMemoryContent(): Promise<string> {
    await this.ensureFile();
    return await this.fs.readFile(this.filePath);
  }

  /**
   * Remove core-memory lines matching the given search terms.
   * Headings are preserved so the template structure stays intact.
   */
  async removeFacts(terms: string[]): Promise<number> {
    if (terms.length === 0) return 0;

    const content = await this.getCoreMemoryContent();
    if (!content) return 0;

    const lowerTerms = terms.map(term => term.toLowerCase());
    let removed = 0;

    const filteredLines = content
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          return true;
        }

        const shouldRemove = lowerTerms.some(term => trimmed.toLowerCase().includes(term));
        if (shouldRemove) {
          removed++;
          return false;
        }

        return true;
      });

    if (removed === 0) return 0;

    const cleaned = filteredLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();

    await this.fs.writeFile(this.filePath, cleaned + '\n');
    return removed;
  }

  /**
   * Merge new core facts into the existing core-memory.md using LLM.
   */
  async mergeCoreFacts(facts: string[]): Promise<void> {
    if (facts.length === 0) return;

    // Serialize concurrent merges to prevent lost-update races on core-memory.md
    const task = this.mergeQueue.then(() => this._doMergeCoreFacts(facts));
    this.mergeQueue = task.catch((err) => {
      console.warn('[Memory] Core memory merge chain error (swallowed to keep queue alive):', err);
    });
    return task;
  }

  private async _doMergeCoreFacts(facts: string[]): Promise<void> {
    const existingMarkdown = await this.getCoreMemoryContent();
    const newFactsText = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const systemPrompt = coreMergePrompt
      .replace('{{existingMarkdown}}', () => existingMarkdown)
      .replace('{{newFacts}}', () => newFactsText);

    try {
      const updatedMarkdown = await this.llm.complete(systemPrompt, 'Merge the new facts into the markdown and return the complete updated file.');

      // Strip any markdown code fences the LLM might wrap the response in
      const cleaned = updatedMarkdown
        .replace(/^```(?:markdown)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

      // C3: Validate LLM output before writing
      if (cleaned.length === 0) return;

      // Must contain at least one markdown heading
      if (!cleaned.includes('#')) {
        console.warn('[Memory] Core memory merge rejected: output has no markdown headings');
        return;
      }

      // Prevent near-wipes: new content must be at least 50% of existing size
      if (existingMarkdown.length > 50 && cleaned.length < existingMarkdown.length * 0.5) {
        console.warn(
          `[Memory] Core memory merge rejected: output (${cleaned.length} chars) is less than 50% of existing (${existingMarkdown.length} chars)`
        );
        return;
      }

      await this.fs.writeFile(this.filePath, cleaned + '\n');
    } catch (err) {
      console.warn('[Memory] Core memory merge failed:', err);
    }
  }
}
