import { describe, expect, it, vi } from 'vitest';
import type { ResponseItem } from '@/core/protocol/types';
import type { RolloutStorageProvider } from '../provider';
import type { RolloutItemRecord } from '../types';
import { loadHistoryPage, projectHistoryRecords } from '../history';

const timestamp = (sequence: number) => new Date(sequence * 1000).toISOString();

function record(sequence: number, type: string, payload: unknown): RolloutItemRecord {
  return { rolloutId: 'session', timestamp: timestamp(sequence), sequence, type, payload };
}

function message(
  role: string,
  text: string,
  options: { id?: string; client_id?: string } = {},
): ResponseItem {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    ...options,
  };
}

function memoryProvider(records: RolloutItemRecord[]): RolloutStorageProvider {
  return {
    getMetadata: vi.fn().mockResolvedValue({ itemCount: records.length }),
    getLastSequenceNumber: vi.fn().mockResolvedValue(
      records.reduce((maximum, item) => Math.max(maximum, item.sequence), -1),
    ),
    getItemsByRolloutIdRange: vi.fn(async (_sessionId, range) => {
      const filtered = records
        .filter((item) => range.afterSequence === undefined || item.sequence > range.afterSequence)
        .filter((item) => range.beforeSequence === undefined || item.sequence < range.beforeSequence)
        .sort((left, right) => range.direction === 'desc'
          ? right.sequence - left.sequence
          : left.sequence - right.sequence);
      return filtered.slice(0, range.limit);
    }),
  } as unknown as RolloutStorageProvider;
}

describe('canonical rollout history projection', () => {
  it('keeps stable item order when a later snapshot updates the same item', () => {
    const projected = projectHistoryRecords([
      record(1, 'turn_start', { submissionId: 'turn-1', clientMessageId: 'client-1', startedAt: 1 }),
      record(2, 'response_item', message('user', 'hello', { client_id: 'client-1' })),
      record(3, 'response_item', message('assistant', 'draft', { id: 'agent-1' })),
      record(4, 'response_item', message('assistant', 'final', { id: 'agent-1' })),
      record(5, 'turn_completion', { submissionId: 'turn-1', outcome: 'complete', completedAt: 5 }),
    ]);

    expect(projected.items.map((item) => item.id)).toEqual(['user:client-1', 'response:agent-1']);
    expect((projected.items[1].response as Extract<ResponseItem, { type: 'message' }>).content[0])
      .toMatchObject({ text: 'final' });
    expect(projected.items[1].sequence).toBe(3);
    expect(projected.turns[0]).toMatchObject({
      id: 'turn-1', clientMessageId: 'client-1', status: 'completed',
    });
  });

  it('keeps display history free of tool output and model-only secret fields', () => {
    const projected = projectHistoryRecords([
      record(1, 'turn_start', { submissionId: 'turn-1' }),
      record(2, 'response_item', {
        ...message('assistant', 'visible', { id: 'agent-1' }),
        reasoning_content: 'private chain of thought',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'secret', arguments: 'token' } }],
      }),
      record(3, 'response_item', {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'raw tool secret',
      }),
      record(4, 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,very-large' }],
      }),
    ]);

    expect(projected.items).toHaveLength(2);
    expect(JSON.stringify(projected.items)).toContain('visible');
    expect(JSON.stringify(projected.items)).not.toContain('private chain of thought');
    expect(JSON.stringify(projected.items)).not.toContain('raw tool secret');
    expect(JSON.stringify(projected.items)).not.toContain('token');
    expect(JSON.stringify(projected.items)).not.toContain('very-large');
  });

  it('returns ten newest turns and a cursor that loads the next ten without overlap', async () => {
    const records: RolloutItemRecord[] = [record(0, 'session_meta', {})];
    for (let turn = 1; turn <= 21; turn += 1) {
      const base = turn * 4;
      records.push(
        record(base, 'turn_start', { submissionId: `turn-${turn}`, clientMessageId: `client-${turn}` }),
        record(base + 1, 'response_item', message('user', `user ${turn}`, { client_id: `client-${turn}` })),
        record(base + 2, 'response_item', message('assistant', `agent ${turn}`, { id: `agent-${turn}` })),
        record(base + 3, 'turn_completion', { submissionId: `turn-${turn}`, outcome: 'complete' }),
      );
    }
    const provider = memoryProvider(records);
    const newest = await loadHistoryPage(provider, 'session', { limit: 10 });
    const older = await loadHistoryPage(provider, 'session', {
      limit: 10,
      beforeSequence: newest.nextCursor!,
    });

    expect(newest.turns.map((turn) => turn.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `turn-${index + 12}`),
    );
    expect(older.turns.map((turn) => turn.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `turn-${index + 2}`),
    );
    expect(new Set([...newest.items, ...older.items].map((item) => item.id)).size).toBe(40);
    expect(older.nextCursor).not.toBeNull();
  });

  it('paginates legacy response-only rollouts on user-message boundaries', async () => {
    const records = [record(0, 'session_meta', {})];
    for (let turn = 1; turn <= 12; turn += 1) {
      records.push(
        record(turn * 2, 'response_item', message('user', `user ${turn}`)),
        record(turn * 2 + 1, 'response_item', message('assistant', `agent ${turn}`)),
      );
    }
    const page = await loadHistoryPage(memoryProvider(records), 'session', { limit: 10 });
    expect(page.turns).toHaveLength(10);
    expect(page.items[0].response).toMatchObject({ role: 'user' });
    expect(page.nextCursor).not.toBeNull();
  });

  it('unwraps legacy JSON-serialized inputs without reinterpreting modern JSON text', () => {
    const genuineJson = JSON.stringify({ type: 'text', text: 'keep this JSON' });
    const projected = projectHistoryRecords([
      record(1, 'response_item', message(
        'user',
        JSON.stringify({ type: 'text', text: 'legacy text' }),
      )),
      record(2, 'response_item', message(
        'user',
        JSON.stringify({ type: 'image', image_url: 'data:image/png;base64,legacy' }),
      )),
      record(3, 'turn_start', { submissionId: 'modern', clientMessageId: 'modern-client' }),
      record(4, 'response_item', message('user', genuineJson, { client_id: 'modern-client' })),
    ]);

    const responses = projected.items.map((item) => item.response);
    expect(responses[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'input_text', text: 'legacy text' }],
    });
    expect(responses[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'input_image', image_url: '' }],
    });
    expect(responses[2]).toMatchObject({
      client_id: 'modern-client',
      content: [{ type: 'input_text', text: genuineJson }],
    });
    expect(JSON.stringify(responses)).not.toContain('base64,legacy');
  });

  it('fills a partially marked page from the older legacy segment', async () => {
    const records = [
      record(0, 'session_meta', {}),
      record(1, 'response_item', message('user', 'legacy 1')),
      record(2, 'response_item', message('assistant', 'legacy answer 1')),
      record(3, 'response_item', message('user', 'legacy 2')),
      record(4, 'response_item', message('assistant', 'legacy answer 2')),
      record(5, 'response_item', message('user', 'legacy 3')),
      record(6, 'response_item', message('assistant', 'legacy answer 3')),
      record(7, 'turn_start', { submissionId: 'marked-4' }),
      record(8, 'response_item', message('user', 'marked 4')),
      record(9, 'turn_completion', { submissionId: 'marked-4', outcome: 'complete' }),
      record(10, 'turn_start', { submissionId: 'marked-5' }),
      record(11, 'response_item', message('user', 'marked 5')),
      record(12, 'turn_completion', { submissionId: 'marked-5', outcome: 'complete' }),
    ];

    const page = await loadHistoryPage(memoryProvider(records), 'session', { limit: 4 });

    expect(page.turns).toHaveLength(4);
    expect(page.items.map((item) => (item.response as any).content[0].text)).toEqual([
      'legacy 2',
      'legacy answer 2',
      'legacy 3',
      'legacy answer 3',
      'marked 4',
      'marked 5',
    ]);
    expect(page.nextCursor).toBe(3);
  });

  it('finds an older page through a long non-history event inventory', async () => {
    const records: RolloutItemRecord[] = [
      record(0, 'turn_start', { submissionId: 'old-turn' }),
      record(1, 'response_item', message('user', 'old user')),
      ...Array.from({ length: 300 }, (_, index) => (
        record(index + 2, 'event_msg', { type: 'debug' })
      )),
      record(302, 'turn_start', { submissionId: 'new-turn' }),
      record(303, 'response_item', message('user', 'new user')),
    ];
    const page = await loadHistoryPage(memoryProvider(records), 'session', { limit: 1 });
    expect(page.nextCursor).toBe(302);
  });

  it('rejects malformed cursors before calling the provider range API', async () => {
    const provider = memoryProvider([record(0, 'session_meta', {})]);
    await expect(loadHistoryPage(provider, 'session', { beforeSequence: -1 }))
      .rejects.toThrow('history cursor');
  });

  it('excludes appends newer than its captured canonical revision', async () => {
    const records = [
      record(0, 'turn_start', { submissionId: 'turn-1' }),
      record(1, 'response_item', message('user', 'committed')),
      record(2, 'response_item', message('assistant', 'committed answer')),
      record(3, 'response_item', message('assistant', 'racing append')),
    ];
    const provider = memoryProvider(records);
    vi.mocked(provider.getLastSequenceNumber).mockResolvedValue(2);
    const page = await loadHistoryPage(provider, 'session');
    expect(page.revision).toBe(3);
    expect(JSON.stringify(page.items)).not.toContain('racing append');
  });
});
