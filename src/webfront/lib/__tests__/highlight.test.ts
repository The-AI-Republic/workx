import { describe, expect, it } from 'vitest';
import { escapeHtml, highlightCode } from '../highlight';

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert("x&y")</script>'`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&#39;',
    );
  });
});

describe('highlightCode — security (escape-first)', () => {
  it('never emits a raw agent-authored angle bracket into the output', () => {
    const evil = `const x = "</span><img src=x onerror=alert(1)>";`;
    const html = highlightCode(evil, 'ts');
    // The only tags present are our own hl-* spans; agent content is escaped.
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;/span&gt;');
  });

  it('escapes ampersands and quotes inside identifiers and plain text', () => {
    const html = highlightCode('a && b < c', 'js');
    expect(html).toContain('&amp;&amp;');
    expect(html).toContain('&lt; c');
    expect(html).not.toMatch(/<(?!\/?span)/); // no tags other than <span>/<\/span>
  });

  it('escapes content inside strings and comments', () => {
    const html = highlightCode(`x = "<b>" // <hr>`, 'py');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&lt;hr&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<hr>');
  });
});

describe('highlightCode — tokenization', () => {
  it('wraps keywords, strings, numbers and comments in hl-* spans', () => {
    const html = highlightCode(`const n = 42; // note`, 'ts');
    expect(html).toContain('<span class="hl-keyword">const</span>');
    expect(html).toContain('<span class="hl-number">42</span>');
    expect(html).toContain('<span class="hl-comment">// note</span>');
  });

  it('honors #-style comments for python-like languages only', () => {
    expect(highlightCode('x = 1 # hi', 'py')).toContain('<span class="hl-comment"># hi</span>');
    // In a C-like language, # is not a comment.
    expect(highlightCode('x = 1 # hi', 'ts')).not.toContain('hl-comment');
  });

  it('handles block comments and unterminated strings without throwing', () => {
    expect(() => highlightCode('/* open comment', 'ts')).not.toThrow();
    expect(() => highlightCode('x = "unterminated', 'ts')).not.toThrow();
    expect(highlightCode('/* a */', 'ts')).toContain('<span class="hl-comment">/* a */</span>');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(highlightCode('')).toBe('');
    expect(highlightCode(undefined as unknown as string)).toBe('');
  });
});
