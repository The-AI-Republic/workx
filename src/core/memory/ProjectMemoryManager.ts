/**
 * Per-workspace project memory.
 *
 * This is intentionally separate from core-memory.md. Core memory follows the
 * user globally; project memory follows the selected code workspace.
 */

import type { FileSystem } from './types';

const DEFAULT_PROJECT_MEMORY = `# Project Memory

`;

export class ProjectMemoryManager {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: FileSystem,
    private readonly projectMemoryDir: string,
  ) {}

  private get sep(): string {
    return this.projectMemoryDir.includes('\\') ? '\\' : '/';
  }

  private get filePath(): string {
    const dir = this.projectMemoryDir.replace(/[/\\]$/, '');
    return `${dir}${this.sep}project-memory.md`;
  }

  async ensureFile(): Promise<void> {
    await this.fs.ensureDir(this.projectMemoryDir);
    if (!(await this.fs.exists(this.filePath))) {
      await this.fs.writeFile(this.filePath, DEFAULT_PROJECT_MEMORY);
    }
  }

  async getProjectMemoryContent(): Promise<string> {
    await this.ensureFile();
    return this.fs.readFile(this.filePath);
  }

  async appendFact(text: string): Promise<void> {
    const task = this.writeQueue.then(() => this.doAppendFact(text));
    this.writeQueue = task.catch(() => {});
    return task;
  }

  private async doAppendFact(text: string): Promise<void> {
    await this.ensureFile();
    const now = new Date();
    const stamp = now.toISOString();
    const existing = await this.fs.readFile(this.filePath);
    const next = `${existing.trimEnd()}\n\n- ${stamp}: ${text.trim()}\n`;
    await this.fs.writeFile(this.filePath, next);
  }

  async removeFacts(terms: string[]): Promise<number> {
    if (terms.length === 0) return 0;
    await this.ensureFile();

    const lowerTerms = terms.map((term) => term.toLowerCase());
    const content = await this.fs.readFile(this.filePath);
    let removed = 0;

    const next = content
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        const shouldRemove = lowerTerms.some((term) => trimmed.toLowerCase().includes(term));
        if (shouldRemove) removed += 1;
        return !shouldRemove;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();

    if (removed > 0) {
      await this.fs.writeFile(this.filePath, `${next}\n`);
    }
    return removed;
  }
}

export function sanitizeProjectMemoryKey(workspaceRoot: string): string {
  return workspaceRoot
    .trim()
    .replace(/[/\\:]+/g, '__')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'workspace';
}
