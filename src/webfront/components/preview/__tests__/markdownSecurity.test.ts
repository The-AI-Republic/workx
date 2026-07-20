import { describe, expect, it } from 'vitest';
import {
  isSafeExternalPreviewHref,
  sanitizePreviewMarkdownHtml,
} from '../markdownSecurity';

describe('preview Markdown security', () => {
  it('removes executable and embedded content, including images', () => {
    const html = sanitizePreviewMarkdownHtml(`
      <script>alert(1)</script>
      <img src="https://example.com/tracker.png" onerror="alert(1)">
      <iframe src="https://example.com"></iframe>
      <p style="background:url(https://example.com/t)">Safe text</p>
    `);

    expect(html).toContain('Safe text');
    expect(html).not.toMatch(/script|img|iframe|onerror|style=|tracker/i);
  });

  it('keeps only explicit safe external links and hardens them', () => {
    const html = sanitizePreviewMarkdownHtml(`
      <a id="web" href="https://example.com/docs">Docs</a>
      <a id="mail" href="mailto:test@example.com">Mail</a>
      <a id="js" href="javascript:alert(1)">Bad</a>
      <a id="relative" href="./local.md">Relative</a>
    `);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    expect(doc.querySelector('#web')?.getAttribute('href')).toBe('https://example.com/docs');
    expect(doc.querySelector('#mail')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('#web')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(doc.querySelector('#js')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('#relative')?.hasAttribute('href')).toBe(false);
  });

  it.each([
    ['https://example.com', true],
    ['http://localhost:3000', true],
    ['mailto:test@example.com', false],
    ['javascript:alert(1)', false],
    ['./README.md', false],
  ])('classifies %s as safe=%s', (href, expected) => {
    expect(isSafeExternalPreviewHref(href)).toBe(expected);
  });

  it('removes form controls and resource-loading media', () => {
    const html = sanitizePreviewMarkdownHtml(`
      <form action="https://example.com"><input name="secret"><button>Send</button></form>
      <video src="https://example.com/video.mp4"><source src="https://example.com/video.mp4"></video>
      <p>Visible copy</p>
    `);

    expect(html).toContain('Visible copy');
    expect(html).not.toMatch(/form|input|button|video|source|example\.com/i);
  });
});
