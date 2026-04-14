/**
 * DailyMemoryStore -- read/write/search/delete entries in date-sharded markdown files.
 * Each day has one file: YYYY-MM-DD.md in the memory directory.
 */
import type { FileSystem, MemoryCategory } from './types';

export interface MemoryEntry {
  time: string;       // HH:MM
  category: MemoryCategory;
  text: string;
  sourceDate: string;  // YYYY-MM-DD
}

/**
 * Format a Date as a local calendar date stamp (YYYY-MM-DD).
 * This keeps file sharding aligned with the displayed local time.
 */
export function formatLocalDateStamp(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class DailyMemoryStore {
  private fs: FileSystem;
  private memoryDir: string;

  constructor(fs: FileSystem, memoryDir: string) {
    this.fs = fs;
    this.memoryDir = memoryDir;
  }

  /** Get path separator style from memoryDir */
  private get sep(): string {
    return this.memoryDir.includes('\\') ? '\\' : '/';
  }

  /** Get the file path for a given date or special name */
  private filePath(name: string): string {
    const dir = this.memoryDir.replace(/[/\\]$/, '');
    return `${dir}${this.sep}${name}.md`;
  }

  /** Ensure the memory directory exists */
  async ensureDir(): Promise<void> {
    await this.fs.ensureDir(this.memoryDir);
  }

  /** Append a fact to today's daily file */
  async appendFact(text: string, category: MemoryCategory): Promise<void> {
    await this.ensureDir();
    const now = new Date();
    const date = this.formatDate(now);
    const time = this.formatTime(now);
    const path = this.filePath(date);

    const exists = await this.fs.exists(path);
    let content = '';
    if (exists) {
      content = await this.fs.readFile(path);
    }

    // If file is empty or new, add the date heading
    if (!content.trim()) {
      content = `# ${date}\n`;
    }

    // Append the new entry
    content += `\n## ${time} | ${category}\n${text}\n`;

    await this.fs.writeFile(path, content);

    // Update index so listDays can find this file
    await this.updateIndex(date);
  }

  /** Read and parse all entries from a specific date */
  async readDay(date: string): Promise<MemoryEntry[]> {
    const path = this.filePath(date);
    const exists = await this.fs.exists(path);
    if (!exists) return [];

    const content = await this.fs.readFile(path);
    return this.parseEntries(content, date);
  }

  /** Read entries from the most recent N days that have files */
  async readRecentDays(n: number): Promise<{ date: string; entries: MemoryEntry[] }[]> {
    const days = await this.listDays();
    const recentDays = days.slice(0, n);
    const results: { date: string; entries: MemoryEntry[] }[] = [];

    for (const day of recentDays) {
      const entries = await this.readDay(day);
      if (entries.length > 0) {
        results.push({ date: day, entries });
      }
    }
    return results;
  }

  /** List all available daily files, sorted newest first */
  async listDays(): Promise<string[]> {
    const indexPath = this.filePath('_index');
    const exists = await this.fs.exists(indexPath);
    if (!exists) return [];

    const content = await this.fs.readFile(indexPath);
    const days = content.split('\n').filter(l => l.trim());
    return days.sort().reverse(); // newest first
  }

  /** Update the day index when a new day is added */
  private async updateIndex(date: string): Promise<void> {
    const indexPath = this.filePath('_index');
    let content = '';
    const exists = await this.fs.exists(indexPath);
    if (exists) {
      content = await this.fs.readFile(indexPath);
    }
    const days = new Set(content.split('\n').filter(l => l.trim()));
    if (!days.has(date)) {
      days.add(date);
      await this.fs.writeFile(indexPath, Array.from(days).sort().join('\n') + '\n');
    }
  }

  /** Search all daily files for keyword matches */
  async searchKeywords(keywords: string[]): Promise<MemoryEntry[]> {
    const days = await this.listDays();
    const results: MemoryEntry[] = [];
    const lowerKeywords = keywords.map(k => k.toLowerCase());

    for (const day of days) {
      const entries = await this.readDay(day);
      for (const entry of entries) {
        const lowerText = entry.text.toLowerCase();
        const lowerCategory = entry.category.toLowerCase();
        const matches = lowerKeywords.some(
          kw => lowerText.includes(kw) || lowerCategory.includes(kw)
        );
        if (matches) {
          results.push(entry);
        }
      }
      // Cap results to prevent processing too many
      if (results.length >= 50) break;
    }

    return results;
  }

  /** Remove entries matching specific text from daily files */
  async removeEntries(textsToRemove: string[]): Promise<number> {
    const days = await this.listDays();
    let removed = 0;
    const lowerTexts = textsToRemove.map(t => t.toLowerCase());

    for (const day of days) {
      const path = this.filePath(day);
      const content = await this.fs.readFile(path);
      const entries = this.parseEntries(content, day);
      const remaining = entries.filter(e => {
        const shouldRemove = lowerTexts.some(t => e.text.toLowerCase().includes(t));
        if (shouldRemove) removed++;
        return !shouldRemove;
      });

      if (remaining.length !== entries.length) {
        // Rewrite the file
        if (remaining.length === 0) {
          await this.fs.writeFile(path, `# ${day}\n`);
        } else {
          let newContent = `# ${day}\n`;
          for (const entry of remaining) {
            newContent += `\n## ${entry.time} | ${entry.category}\n${entry.text}\n`;
          }
          await this.fs.writeFile(path, newContent);
        }
      }
    }

    return removed;
  }

  /** Parse markdown content into MemoryEntry array */
  private parseEntries(content: string, date: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    // Match sections: ## HH:MM | category\ncontent
    const sectionRegex = /^## (\d{2}:\d{2}) \| (\w+)\s*\n([\s\S]*?)(?=\n## |\n# |$)/gm;
    let match;
    while ((match = sectionRegex.exec(content)) !== null) {
      const [, time, category, text] = match;
      const trimmed = text.trim();
      if (trimmed) {
        entries.push({
          time,
          category: category as MemoryCategory,
          text: trimmed,
          sourceDate: date,
        });
      }
    }
    return entries;
  }

  /** Format a Date as YYYY-MM-DD */
  private formatDate(d: Date): string {
    return formatLocalDateStamp(d);
  }

  /** Format a Date as HH:MM */
  private formatTime(d: Date): string {
    return d.toTimeString().slice(0, 5);
  }
}
