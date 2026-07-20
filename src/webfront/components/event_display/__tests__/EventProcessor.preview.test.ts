import { describe, expect, it } from 'vitest';
import type { Event } from '@/core/protocol/types';
import { LOCAL_FILE_SOURCE_MAX_BYTES } from '@/tools/runtimeMetadata';
import { EventProcessor } from '../EventProcessor';

function event(overrides: Record<string, unknown> = {}): Event {
  return {
    id: 'preview-event-1',
    msg: {
      type: 'ToolExecutionProgress',
      data: {
        tool_name: 'edit_file',
        call_id: 'call-1',
        session_id: 'session-1',
        turn_id: 'turn-1',
        timestamp: 123,
        progress_data: {
          type: 'local_file_change',
          status: 'completed',
          operation: 'modified',
          path: 'src/app.ts',
          size: 12,
          mtimeMs: 100,
          unifiedDiff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n',
          message: 'Modified src/app.ts',
          ...overrides,
        },
      },
    },
  };
}

describe('EventProcessor local file preview projection', () => {
  it('keeps the chat event and links it to the exact eligible preview item', () => {
    const processed = new EventProcessor('session-1').processEvent(event());
    expect(processed).toMatchObject({
      id: 'preview-event-1',
      category: 'tool',
      content: 'Modified src/app.ts',
      status: 'success',
      metadata: {
        toolName: 'edit_file',
        previewItemId: 'preview-event-1',
      },
    });
    expect(processed?.timestamp.getTime()).toBe(123);
  });

  it('does not advertise a preview link when the resulting file is ineligible', () => {
    const processed = new EventProcessor('session-1').processEvent(event({
      size: LOCAL_FILE_SOURCE_MAX_BYTES + 1,
    }));
    expect(processed?.content).toBe('Modified src/app.ts');
    expect(processed?.metadata?.previewItemId).toBeUndefined();
  });
});
