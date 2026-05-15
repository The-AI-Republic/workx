import { describe, it, expect } from 'vitest';
import { detectBashEscape, buildBashInputMarker } from '../bashEscape';
import { processUserInput } from '../processUserInput';
import type { FunnelContext } from '../types';

describe('detectBashEscape', () => {
  it('detects a leading ! and strips it', () => {
    expect(detectBashEscape('!ls -la')).toEqual({ command: 'ls -la' });
    expect(detectBashEscape('   !  echo hi  ')).toEqual({ command: 'echo hi' });
  });
  it('ignores non-escapes and a bare !', () => {
    expect(detectBashEscape('hello')).toBeNull();
    expect(detectBashEscape('!')).toBeNull();
    expect(detectBashEscape('  !   ')).toBeNull();
  });
});

describe('buildBashInputMarker', () => {
  it('wraps the command (claudy parity)', () => {
    expect(buildBashInputMarker('ls')).toBe('<bash-input>ls</bash-input>');
  });
});

function ctx(hasShellExec: boolean): FunnelContext {
  return {
    sessionId: 's',
    origin: { channel: 'local' },
    platform: { hasShellExec, hasBrowserTools: false, hasRealTabs: false } as FunnelContext['platform'],
  };
}

describe('processUserInput — Stage 4 shell escape', () => {
  it('rewrites !cmd to a <bash-input> marker on a shell-capable platform', async () => {
    const r = await processUserInput([{ type: 'text', text: '!git status' }], ctx(true));
    expect(r.shouldQuery).toBe(true);
    expect((r.items[0] as { text: string }).text).toBe(
      '<bash-input>git status</bash-input>',
    );
  });

  it('leaves !cmd as literal text + systemNote when no shell', async () => {
    const r = await processUserInput([{ type: 'text', text: '!rm -rf /' }], ctx(false));
    expect((r.items[0] as { text: string }).text).toBe('!rm -rf /');
    expect(r.systemNote).toContain('Shell escape');
  });

  it('a bash escape bypasses mention parsing', async () => {
    const r = await processUserInput(
      [{ type: 'text', text: '!cat @page' }],
      ctx(true),
    );
    // Marker produced; no <page> item appended (treated as a command).
    expect((r.items[0] as { text: string }).text).toBe(
      '<bash-input>cat @page</bash-input>',
    );
    expect(r.items).toHaveLength(1);
  });
});
