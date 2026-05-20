import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  backgroundTaskStore,
  handleBackgroundTaskEvent,
} from '../backgroundTaskStore';

describe('backgroundTaskStore event routing', () => {
  it('applies background task lifecycle events to the badge store', () => {
    const taskId = `task-${Date.now()}`;

    handleBackgroundTaskEvent({
      type: 'BackgroundTaskStarted',
      data: {
        taskId,
        type: 'background_agent',
        description: 'Research something',
        startTime: 123,
      },
    });

    expect(get(backgroundTaskStore).tasks[taskId]).toMatchObject({
      id: taskId,
      status: 'running',
      description: 'Research something',
      isBackgrounded: true,
    });

    handleBackgroundTaskEvent({
      type: 'BackgroundTaskStateChanged',
      data: {
        taskId,
        prevStatus: 'running',
        status: 'completed',
      },
    });

    handleBackgroundTaskEvent({
      type: 'BackgroundTaskTerminated',
      data: {
        taskId,
        status: 'completed',
        endTime: 456,
        durationMs: 333,
        summary: 'done',
      },
    });

    expect(get(backgroundTaskStore).tasks[taskId]).toMatchObject({
      status: 'completed',
      endTime: 456,
      lastAgentMessage: 'done',
    });
  });
});
