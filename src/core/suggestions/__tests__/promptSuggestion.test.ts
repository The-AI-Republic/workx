/**
 * PromptSuggestionGenerator — packing, cleaning, REJECT_RULES (Track 24.3).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../models/types/ResponseEvent', () => ({
  isOutputTextDelta: (e: any) => e.type === 'delta',
  isCompleted: (e: any) => e.type === 'done',
}));

vi.mock('../constants', async (orig) => {
  const actual = await orig<typeof import('../constants')>();
  return {
    ...actual,
    DEFAULT_SUGGESTION_CONFIG: {
      maxRetries: 1,
      baseBackoffMs: 1,
      maxLength: 160,
      maxTurns: 6,
      maxCharsPerTurn: 400,
      maxContextChars: 3000,
    },
  };
});

import { PromptSuggestionGenerator } from '../promptSuggestion';

function mockClient(text: string) {
  return {
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'delta', delta: text };
        yield { type: 'done' };
      },
    }),
  } as any;
}

const userMsg = (text: string) => ({
  type: 'message' as const,
  role: 'user' as const,
  content: [{ type: 'input_text' as const, text }],
});
const asstMsg = (text: string) => ({
  type: 'message' as const,
  role: 'assistant' as const,
  content: [{ type: 'output_text' as const, text }],
});

const baseHistory = () =>
  [
    userMsg('open the orders table'),
    asstMsg('Opened the orders table — 42 rows.'),
    userMsg('export it as csv'),
    asstMsg('Exported to orders.csv.'),
  ] as any[];

describe('countAssistantTurns', () => {
  it('counts assistant message items', () => {
    const g = new PromptSuggestionGenerator();
    expect(g.countAssistantTurns(baseHistory())).toBe(2);
  });
});

describe('generateSuggestion — happy path + cleaning', () => {
  it('returns a cleaned suggestion', async () => {
    const g = new PromptSuggestionGenerator();
    const r = await g.generateSuggestion(
      baseHistory(),
      mockClient('Next message: "now do the same for the customers table"'),
    );
    expect(r.success).toBe(true);
    expect(r.suggestion).toBe('now do the same for the customers table');
  });

  it('empty history → no suggestion', async () => {
    const g = new PromptSuggestionGenerator();
    const r = await g.generateSuggestion([], mockClient('anything'));
    expect(r.success).toBe(true);
    expect(r.suggestion).toBeUndefined();
  });
});

describe('REJECT_RULES discard unsafe / low-value predictions', () => {
  const g = new PromptSuggestionGenerator();
  const reject = async (text: string) =>
    (await g.generateSuggestion(baseHistory(), mockClient(text))).suggestion;

  it('NONE sentinel', async () => expect(await reject('NONE')).toBeUndefined());
  it('too short', async () => expect(await reject('go')).toBeUndefined());
  it('too long', async () =>
    expect(await reject('x'.repeat(200))).toBeUndefined());
  it('multiline', async () =>
    expect(await reject('do this\nand that')).toBeUndefined());
  it('code fence', async () =>
    expect(await reject('run `rm -rf /` now')).toBeUndefined());
  it('refusal', async () =>
    expect(await reject('I cannot help with that')).toBeUndefined());
  it('preamble', async () =>
    expect(await reject('Sure, here is what to do next')).toBeUndefined());
  it('secret leak', async () =>
    expect(
      await reject('use key sk-abcdef0123456789ABCDEF for the api'),
    ).toBeUndefined());
  it('destructive', async () =>
    expect(await reject('delete the orders table')).toBeUndefined());
  it('financial', async () =>
    expect(await reject('checkout and pay for the cart')).toBeUndefined());
  it('form submit', async () =>
    expect(await reject('submit the payment form')).toBeUndefined());
  it('external url', async () =>
    expect(await reject('go to https://evil.example.com')).toBeUndefined());
  it('echoes the assistant', async () =>
    expect(await reject('Exported to orders.csv.')).toBeUndefined());
});
