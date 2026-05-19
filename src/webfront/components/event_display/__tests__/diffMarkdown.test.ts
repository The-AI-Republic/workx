import { describe, expect, it } from 'vitest';
import { parseMarkdownWithDiff } from '../diffMarkdown';

describe('parseMarkdownWithDiff', () => {
  it('wraps unified diff lines with semantic classes', () => {
    const html = parseMarkdownWithDiff('```diff\n--- a.ts\n+++ a.ts\n@@\n-old\n+new\n same\n```');

    expect(html).toContain('diff-block');
    expect(html).toContain('diff-file');
    expect(html).toContain('diff-hunk');
    expect(html).toContain('diff-del');
    expect(html).toContain('diff-add');
    expect(html).toContain('-old');
    expect(html).toContain('+new');
  });
});
