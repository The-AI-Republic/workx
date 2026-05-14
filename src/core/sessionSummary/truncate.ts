/**
 * Section-aware truncation of the summary.md content for prompt injection.
 *
 * - Per-section cap: 2000 characters (claudy parity, MAX_SECTION_LENGTH)
 * - Total soft cap: ~12,000 tokens, computed as 12000 * 4 chars (1:4 heuristic
 *   matching estimateRequestTokens)
 * - Truncate at the last newline before the cap. Never mid-line.
 * - Append "\n[... section truncated for length ...]" when a section gets cut
 *   (matches claudy's marker exactly).
 */

import { MAX_SECTION_CHARS, MAX_TOTAL_TOKENS } from './prompts';

const SECTION_TRUNCATION_MARKER = '\n[... section truncated for length ...]\n';
const MAX_TOTAL_CHARS = MAX_TOTAL_TOKENS * 4;

/**
 * Truncate per-section and then apply a soft total cap. Returns the (possibly
 * shorter) content ready to inject into the compact prompt or system extension.
 */
export function truncateSessionSummaryForCompact(content: string): string {
  // Split on '# ' at start of line — keeps the heading attached to its body
  // and the leading whitespace before each section.
  const sections = content.split(/(?=^# )/m);
  const truncatedSections = sections.map(truncateSection);
  let out = truncatedSections.join('');

  if (out.length > MAX_TOTAL_CHARS) {
    const cut = out.lastIndexOf('\n', MAX_TOTAL_CHARS);
    const safe = cut > 0 ? cut : MAX_TOTAL_CHARS;
    out = out.slice(0, safe) + '\n[... summary truncated for length ...]\n';
  }
  return out;
}

function truncateSection(section: string): string {
  if (section.length <= MAX_SECTION_CHARS) return section;
  const cut = section.lastIndexOf('\n', MAX_SECTION_CHARS);
  const sliceEnd = cut > 0 ? cut : MAX_SECTION_CHARS;
  return section.slice(0, sliceEnd) + SECTION_TRUNCATION_MARKER;
}
