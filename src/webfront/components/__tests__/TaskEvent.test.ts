import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import TaskEvent from '@/webfront/components/event_display/TaskEvent.svelte';
import { showTokenUsage } from '@/webfront/stores/tokenUsageStore';
import type { ProcessedEvent } from '@/types/ui';

function makeEvent(overrides: Partial<ProcessedEvent>): ProcessedEvent {
  return {
    id: 'evt-1',
    category: 'task',
    timestamp: new Date(),
    title: 'Task',
    content: '',
    style: {},
    collapsible: false,
    ...overrides,
  } as ProcessedEvent;
}

describe('TaskEvent', () => {
  it('renders the failure reason even when token usage display is off', () => {
    showTokenUsage.setShowTokenUsage(false);

    render(TaskEvent, {
      props: {
        event: makeEvent({
          title: 'Task failed',
          content: 'ModelClientError: no LLM credit account for this identity',
          status: 'error',
        }),
      },
    });

    expect(
      screen.getByText('ModelClientError: no LLM credit account for this identity'),
    ).toBeTruthy();
  });

  it('hides the completion card when token usage display is off', () => {
    showTokenUsage.setShowTokenUsage(false);

    render(TaskEvent, {
      props: {
        event: makeEvent({
          title: 'Task complete',
          content: 'Task complete',
          status: 'success',
        }),
      },
    });

    expect(screen.queryByText('Task complete')).toBeNull();
  });

  it('shows the completion card when token usage display is on', () => {
    showTokenUsage.setShowTokenUsage(true);

    render(TaskEvent, {
      props: {
        event: makeEvent({
          title: 'Task complete',
          content: 'Task complete',
          status: 'success',
        }),
      },
    });

    expect(screen.getByText('Task complete')).toBeTruthy();
  });
});
