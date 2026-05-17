/**
 * PersonaLoader — parsing + resolution (Track 24.2).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  parsePersona,
  resolvePersona,
  registerExternalPersonas,
  clearExternalPersonas,
} from '../PersonaLoader';

describe('parsePersona', () => {
  it('treats a no-frontmatter file as all body, keepCodingInstructions default true', () => {
    const p = parsePersona('Just be terse.', 'x');
    expect(p.prompt).toBe('Just be terse.');
    expect(p.name).toBe('x');
    expect(p.keepCodingInstructions).toBe(true);
  });

  it('parses the 3 known scalar keys and strips quotes; body is the prompt', () => {
    const raw = [
      '---',
      'name: "Terse"',
      "description: 'short replies'",
      'keepCodingInstructions: false',
      'unknownKey: ignored',
      '# a comment',
      '---',
      '',
      'Be very brief.',
    ].join('\n');
    const p = parsePersona(raw, 'file');
    expect(p.name).toBe('Terse');
    expect(p.description).toBe('short replies');
    expect(p.keepCodingInstructions).toBe(false);
    expect(p.prompt).toBe('Be very brief.');
  });

  it('absent keepCodingInstructions defaults to true', () => {
    const p = parsePersona('---\nname: a\n---\nbody', 'a');
    expect(p.keepCodingInstructions).toBe(true);
  });

  it('fail-soft: unterminated frontmatter is treated as body, never throws', () => {
    const p = parsePersona('---\nname: broken\nno closing fence', 'fb');
    expect(p.name).toBe('fb');
    expect(p.prompt).toContain('name: broken');
  });
});

describe('resolvePersona', () => {
  afterEach(() => clearExternalPersonas());

  it('returns null for unknown / empty (safe no-op)', () => {
    expect(resolvePersona(undefined)).toBeNull();
    expect(resolvePersona('')).toBeNull();
    expect(resolvePersona('does-not-exist')).toBeNull();
  });

  it('resolves a built-in persona by name (case-insensitive)', () => {
    const r = resolvePersona('Concise');
    expect(r).not.toBeNull();
    expect(r!.prompt).toContain('Concise');
    expect(r!.keepCodingInstructions).toBe(true);
  });

  it('external personas overlay built-ins', () => {
    registerExternalPersonas([
      { name: 'concise', description: '', keepCodingInstructions: false, prompt: 'OVERRIDDEN' },
    ]);
    const r = resolvePersona('concise');
    expect(r!.prompt).toBe('OVERRIDDEN');
    expect(r!.keepCodingInstructions).toBe(false);
  });
});
