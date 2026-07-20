import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const srcRoot = resolve(__dirname, '../..');
const typographyPath = join(srcRoot, 'styles/typography.css');

function readSource(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf8');
}

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
    const message = readSource('webfront/components/event_display/MessageEvent.svelte');
    const input = readSource('webfront/components/MessageInput.svelte');
    const eventDisplay = readSource('webfront/components/event_display/EventDisplay.svelte');

    expect(message).toMatch(/markdown-content[^"\n]*text-base/);
    expect(input).toMatch(/terminal-textarea[^"\n]*text-base/);
    expect(eventDisplay).toMatch(/flex items-center gap-2 mb-1 text-meta font-normal/);
    expect(eventDisplay).not.toContain('text-xs italic');
  });

  it('does not shrink explicit action and form controls to microcopy sizes', () => {
    const violations: string[] = [];
    const interactiveTag = /<(button|input|select|textarea|label|a)\b[\s\S]*?>/g;
    const microcopyUtility = /\btext-(?:2xs|xs)\b/;

    for (const file of collectStyleFiles(join(srcRoot, 'webfront')).filter((path) =>
      path.endsWith('.svelte')
    )) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(interactiveTag)) {
        if (microcopyUtility.test(match[0])) {
          violations.push(`${relative(srcRoot, file)}: <${match[1]}> uses a microcopy size`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps active timestamps and secondary facts on the 13px metadata role', () => {
    const history = readSource('webfront/components/chat/ChatHistoryList.svelte');
    const usage = readSource('webfront/components/usage/UsageList.svelte');
    const jobItem = readSource('webfront/components/scheduler/SchedulerJobItem.svelte');
    const jobDetail = readSource('webfront/components/scheduler/JobDetailModal.svelte');
    const schedulerPopup = readSource('webfront/components/scheduler/SchedulerPopup.svelte');
    const dataSources = readSource('webfront/settings/DataSourcesSettings.svelte');

    expect(history.match(/shrink-0 text-meta font-normal opacity-70/g)).toHaveLength(5);
    expect(usage).toMatch(/text-meta font-normal[\s\S]*?formatDate\(session\.lastTimestamp\)/);
    expect(usage).toMatch(/text-meta font-normal[\s\S]*?session\.models\[0\]/);
    expect(jobItem).toMatch(/mt-1 text-meta font-normal/);
    expect(jobDetail.match(/items-center gap-2 text-meta font-normal/g)).toHaveLength(3);
    expect(schedulerPopup.match(/gap-2 mb-2 text-meta font-normal/g)).toHaveLength(4);
    expect(dataSources).toMatch(/\.timestamp,[\s\S]*?font-size: var\(--text-meta\);/);
    expect(dataSources).toMatch(/\.revision-meta[\s\S]*?font-size: var\(--text-meta\);/);
  });

  it('keeps legacy scoped control CSS on the 14px interface role', () => {
    const modelSettings = readSource('webfront/settings/ModelSettings.svelte');
    const securitySettings = readSource('webfront/settings/SecuritySettings.svelte');
    const backgroundTasks = readSource('webfront/components/BackgroundTasksBadge.svelte');

    expect(modelSettings).toMatch(/\.btn-sm[\s\S]*?font-size: var\(--text-sm\);/);
    expect(securitySettings).toMatch(/\.btn-action[\s\S]*?font-size: var\(--text-sm\);/);
    expect(securitySettings).toMatch(/\.form-field label[\s\S]*?font-size: var\(--text-sm\);/);
    expect(backgroundTasks).toMatch(/\.task-row[\s\S]*?font-size: var\(--text-sm\);/);
  });
});
