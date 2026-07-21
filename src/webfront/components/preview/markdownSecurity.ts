import DOMPurify from 'dompurify';

export function isSafeExternalPreviewHref(href: string): boolean {
  return /^https?:/i.test(href);
}

export function sanitizePreviewMarkdownHtml(rawHtml: string): string {
  const sanitized = DOMPurify.sanitize(rawHtml, {
    FORBID_TAGS: [
      'audio',
      'base',
      'button',
      'embed',
      'form',
      'iframe',
      'img',
      'input',
      'link',
      'meta',
      'object',
      'option',
      'script',
      'select',
      'source',
      'style',
      'textarea',
      'track',
      'video',
    ],
    FORBID_ATTR: ['srcset', 'style'],
  });
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  for (const anchor of Array.from(doc.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href');
    if (!href || !isSafeExternalPreviewHref(href)) anchor.removeAttribute('href');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  return doc.body.innerHTML;
}
