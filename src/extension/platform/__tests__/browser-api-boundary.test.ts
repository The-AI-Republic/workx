import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALLOWED_BOUNDARIES = [
  /^src\/desktop\/polyfills\//,
  /^src\/extension\/auth\//,
  /^src\/extension\/background\//,
  /^src\/extension\/bridge\//,
  /^src\/extension\/channels\//,
  /^src\/extension\/platform\//,
  /^src\/tools\/WebSearchTool\.ts$/,
  /^src\/types\//,
  /^src\/webfront\/components\/common\//,
  /^src\/webfront\/lib\/gatewayCatalog\.ts$/,
  /^src\/webfront\/pages\/chat\/Main\.svelte$/,
];

function sourceFiles(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) output.push(...sourceFiles(path));
    else if (/\.(?:ts|svelte)$/.test(name)) output.push(path);
  }
  return output;
}

describe('browser API ownership boundary', () => {
  it('keeps raw chrome tab APIs out of core agent execution and feature tools', () => {
    const root = process.cwd();
    const offenders = sourceFiles(join(root, 'src'))
      .map((path) => relative(root, path).replace(/\\/g, '/'))
      .filter((path) => !path.includes('/__tests__/') && !path.includes('/__test-utils__/'))
      .filter((path) => {
        const source = readFileSync(join(root, path), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        return /chrome\.(?:tabs|tabGroups)\s*[.(]/.test(source);
      })
      .filter((path) => !ALLOWED_BOUNDARIES.some((boundary) => boundary.test(path)));
    expect(offenders).toEqual([]);
  });
});
