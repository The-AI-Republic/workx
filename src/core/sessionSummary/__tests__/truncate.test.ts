import { describe, it, expect } from 'vitest';
import { truncateSessionSummaryForCompact } from '../truncate';
import { MAX_SECTION_CHARS, MAX_TOTAL_TOKENS } from '../prompts';

describe('truncateSessionSummaryForCompact', () => {
  it('returns content unchanged when both per-section and total caps are below limits', () => {
    const content = `# Section A
content a

# Section B
content b
`;
    expect(truncateSessionSummaryForCompact(content)).toBe(content);
  });

  it('truncates an oversize section at a newline boundary', () => {
    const longBody = 'a'.repeat(MAX_SECTION_CHARS - 50) + '\n' + 'b'.repeat(200);
    const content = `# Big\n${longBody}\n`;
    const out = truncateSessionSummaryForCompact(content);

    // Truncation marker present
    expect(out).toContain('[... section truncated for length ...]');
    // Should be shorter than the original
    expect(out.length).toBeLessThan(content.length);
    // The cut should be on a newline, not mid-word
    const beforeMarker = out.split('[... section truncated')[0];
    expect(beforeMarker.endsWith('\n')).toBe(true);
  });

  it('applies the total cap when sections individually fit but together exceed it', () => {
    // 7 sections each just under 2000 chars → ~14000 chars total → ~3500 tokens
    // Not over the 12000-token total cap. So we exaggerate:
    const sectionBody = 'x'.repeat(MAX_SECTION_CHARS - 10);
    const content = Array.from({ length: 30 }, (_, i) => `# S${i}\n${sectionBody}\n`).join('');
    // Total chars: ~60000 → ~15000 tokens, over the 12000-token cap (48000 chars).
    const out = truncateSessionSummaryForCompact(content);

    expect(out.length).toBeLessThanOrEqual(MAX_TOTAL_TOKENS * 4 + 100); // small slack for marker
    expect(out).toContain('[... summary truncated for length ...]');
  });

  it('preserves section headers in the output', () => {
    const content = `# Pages Visited\n- example.com\n\n# Worklog\n- did stuff\n`;
    const out = truncateSessionSummaryForCompact(content);
    expect(out).toContain('# Pages Visited');
    expect(out).toContain('# Worklog');
  });
});
