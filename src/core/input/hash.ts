/**
 * Track 13 — non-cryptographic content fingerprint (FNV-1a, 32-bit).
 *
 * Used to derive idempotent `toolUseId`s so re-submitting the same blob does
 * not double-write (FileToolResultStore swallows EEXIST). Cross-platform and
 * synchronous; NOT a security primitive.
 */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
