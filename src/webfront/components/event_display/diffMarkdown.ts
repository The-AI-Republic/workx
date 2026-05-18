import { marked } from 'marked';

export function parseMarkdownWithDiff(text: string): string {
  const html = marked.parse(text, {
    breaks: true,
    gfm: true,
  }) as string;

  return html.replace(
    /<pre><code class="language-(diff|patch)">([\s\S]*?)<\/code><\/pre>/g,
    (_match, lang: string, code: string) => {
      const lines = code.split('\n');
      const rendered = lines.map((line) => {
        const cls = diffLineClass(line);
        const body = line.length > 0 ? line : ' ';
        return `<span class="diff-line ${cls}">${body}</span>`;
      }).join('\n');
      return `<pre class="diff-block"><code class="language-${lang}">${rendered}</code></pre>`;
    },
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-context';
}
