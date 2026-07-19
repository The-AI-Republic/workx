import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const srcRoot = resolve(__dirname, '../..');
const typographyPath = join(srcRoot, 'styles/typography.css');

function collectStyleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectStyleFiles(path);
    return path.endsWith('.css') || path.endsWith('.svelte') ? [path] : [];
  });
}

describe('Workx typography system', () => {
  it('defines the desktop typography scale as Tailwind theme tokens', () => {
    const typography = readFileSync(typographyPath, 'utf8');

    expect(typography).toContain('--font-chat:');
    expect(typography).toContain("'SF Pro Text'");
    expect(typography).toContain('--font-mono:');
    expect(typography).toContain('--text-xs: 0.75rem;');
    expect(typography).toContain('--text-meta: 0.8125rem;');
    expect(typography).toContain('--text-meta--line-height: 1.4;');
    expect(typography).toContain('--text-code-inline: 0.875em;');
    expect(typography).toContain('--text-code-inline--line-height: inherit;');
    expect(typography).toContain('--text-sm: 0.875rem;');
    expect(typography).toContain('--text-base: 1rem;');
    expect(typography).toContain('--text-sm--line-height: 1.4;');
    expect(typography).toContain('--text-base--line-height: 1.5;');
    expect(typography).toMatch(/body\s*{\s*@apply font-chat text-sm;/);
  });

  it('keeps component CSS on the shared theme instead of local typography values', () => {
    const violations: string[] = [];
    const rules = [
      ['font size', /font-size\s*:\s*(?:\d|\.)/g],
      ['arbitrary font size utility', /text-\[(?:\d|\.)/g],
      ['line height', /(?<!-)line-height\s*:\s*(?:\d|\.)/g],
      ['font weight', /font-weight\s*:\s*(?:[1-9]00|bold|normal)/g],
      ['letter spacing', /letter-spacing\s*:\s*(?:-?\d|\.)/g],
      [
        'font family',
        /font-family\s*:\s*(?:system-ui|-apple-system|ui-(?:mono|sans)space|['"]|monospace)/g,
      ],
    ] as const;

    for (const file of collectStyleFiles(srcRoot)) {
      if (file === typographyPath) continue;
      const source = readFileSync(file, 'utf8');
      for (const [label, pattern] of rules) {
        if (pattern.test(source)) violations.push(`${relative(srcRoot, file)}: ${label}`);
        pattern.lastIndex = 0;
      }
    }

    expect(violations).toEqual([]);
  });

  it('provides local fallbacks for the isolated extension overlay', () => {
    for (const relativePath of [
      'extension/content/ui_effect/ControlButtons.svelte',
      'extension/content/ui_effect/CursorAnimator.svelte',
    ]) {
      const source = readFileSync(join(srcRoot, relativePath), 'utf8');

      expect(source).toContain('font-family: var(');
      expect(source).toContain('--font-chat,');
      expect(source).toContain('font-size: var(--text-sm, 0.875rem);');
      expect(source).toContain('font-weight: var(--font-weight-semibold, 600);');
    }
  });

  it('uses the reading scale in chat and the interface scale for metadata', () => {
    const message = readFileSync(
      join(srcRoot, 'webfront/components/event_display/MessageEvent.svelte'),
      'utf8'
    );
    const input = readFileSync(join(srcRoot, 'webfront/components/MessageInput.svelte'), 'utf8');
    const eventDisplay = readFileSync(
      join(srcRoot, 'webfront/components/event_display/EventDisplay.svelte'),
      'utf8'
    );

    expect(message).toMatch(/markdown-content[^"\n]*text-base/);
    expect(input).toMatch(/terminal-textarea[^"\n]*text-base/);
    expect(eventDisplay).toMatch(/flex items-center gap-2 mb-1 text-meta font-normal/);
    expect(eventDisplay).not.toContain('text-xs italic');
  });
});
