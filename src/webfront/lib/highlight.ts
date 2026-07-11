/**
 * highlight (WORKXOS-7, Phase 2) — a tiny, dependency-free, escape-safe syntax
 * highlighter for the preview panel's code viewer.
 *
 * Design constraints:
 *  - **No new dependency.** The desktop bundle stays lean (same rationale as the
 *    hand-rolled diff parser); a full grammar engine (shiki/highlight.js) is
 *    overkill for read-only preview.
 *  - **Escape-first, always.** Every run of source text is HTML-escaped *before*
 *    it is wrapped in a token span, so agent-authored file content can never
 *    inject markup into the `{@html}` sink that renders this output. This is the
 *    load-bearing security property — see the tests.
 *  - **Heuristic, not a parser.** It recognizes comments, strings, numbers and a
 *    common keyword set across C-like / scripting languages. Mis-tokenization at
 *    worst mis-colors a token; it can never corrupt or unescape content.
 */

const KEYWORDS = new Set([
  // control flow / declarations shared across many languages
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'return', 'yield', 'await', 'async', 'function', 'fn', 'def',
  'class', 'struct', 'enum', 'interface', 'trait', 'impl', 'type', 'const',
  'let', 'var', 'val', 'mut', 'static', 'public', 'private', 'protected',
  'export', 'import', 'from', 'as', 'package', 'module', 'use', 'require',
  'new', 'delete', 'this', 'self', 'super', 'extends', 'implements', 'try',
  'catch', 'finally', 'throw', 'throws', 'raise', 'with', 'in', 'of', 'is',
  'not', 'and', 'or', 'true', 'false', 'null', 'nil', 'none', 'undefined',
  'void', 'int', 'float', 'double', 'bool', 'boolean', 'string', 'char',
  'match', 'when', 'where', 'pub', 'namespace', 'using', 'lambda', 'end',
  'elif', 'then', 'begin', 'select', 'where', 'insert', 'update', 'delete',
]);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escape a raw source run. The only thing standing between agent file
 *  content and the `{@html}` sink. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function span(cls: string, raw: string): string {
  return `<span class="hl-${cls}">${escapeHtml(raw)}</span>`;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * Highlight source into an HTML string of escaped text + `hl-*` token spans.
 * `lang` is advisory (selects `#`/`--` line-comment styles); the scanner is
 * otherwise language-agnostic.
 */
export function highlightCode(source: string, lang = ''): string {
  const src = source ?? '';
  const hashComments = /^(py|rb|sh|bash|zsh|yaml|yml|toml|ini|conf|cfg|pl|r)$/i.test(lang);
  const dashComments = /^(sql|lua|hs|ada)$/i.test(lang);

  let out = '';
  let i = 0;
  const n = src.length;
  // Accumulates plain text between tokens; flushed (escaped) before each token.
  let plain = '';
  const flush = () => {
    if (plain) {
      out += escapeHtml(plain);
      plain = '';
    }
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Block comment /* ... */
    if (c === '/' && next === '*') {
      flush();
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out += span('comment', src.slice(i, j));
      i = j;
      continue;
    }

    // Line comments: //, plus #-style / --style per language.
    const isLineComment =
      (c === '/' && next === '/') ||
      (hashComments && c === '#') ||
      (dashComments && c === '-' && next === '-');
    if (isLineComment) {
      flush();
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += span('comment', src.slice(i, j));
      i = j;
      continue;
    }

    // Strings: ", ', ` — with backslash escapes.
    if (c === '"' || c === "'" || c === '`') {
      flush();
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++; // skip escaped char
        j++;
      }
      j = Math.min(n, j + 1);
      out += span('string', src.slice(i, j));
      i = j;
      continue;
    }

    // Numbers (incl. hex, decimals).
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(next ?? ''))) {
      flush();
      let j = i;
      while (j < n && /[0-9a-fA-Fxob._]/.test(src[j])) j++;
      out += span('number', src.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) {
        flush();
        out += span('keyword', word);
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += c;
    i++;
  }
  flush();
  return out;
}
