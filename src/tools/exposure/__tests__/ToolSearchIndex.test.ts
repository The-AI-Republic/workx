import { describe, expect, it } from 'vitest';
import { ToolSearchIndex } from '../ToolSearchIndex';
import type { ToolExposureDecision } from '../ToolExposureTypes';

function deferred(name: string, description: string, source: 'mcp' | 'a2a' = 'mcp', serverName = 'github'): ToolExposureDecision {
  return {
    name,
    description,
    definition: {
      type: 'function',
      function: {
        name,
        description,
        strict: false,
        parameters: { type: 'object', properties: {} },
      },
    },
    profile: { source, serverName, searchHint: description },
    mode: 'deferred',
    reason: 'default-deferred-source',
    selected: false,
  };
}

describe('ToolSearchIndex', () => {
  it('supports exact select and keyword matching', () => {
    const index = new ToolSearchIndex([
      deferred('github__create_issue', 'Create a GitHub issue'),
      deferred('slack__send_message', 'Send a Slack message', 'mcp', 'slack'),
    ]);

    const result = index.search('github issue select:slack__send_message');
    expect(result.exactSelect).toEqual(['slack__send_message']);
    expect(result.matches[0].name).toBe('github__create_issue');
  });

  it('supports required terms and source/server queries', () => {
    const index = new ToolSearchIndex([
      deferred('github__create_issue', 'Create a GitHub issue'),
      deferred('research__summarize', 'Summarize research papers', 'a2a', 'research'),
    ]);

    expect(index.search('+github issue').matches.map((m) => m.name)).toEqual(['github__create_issue']);
    expect(index.search('a2a:research').matches.map((m) => m.name)).toEqual(['research__summarize']);
  });
});
