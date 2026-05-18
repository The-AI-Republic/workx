import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import BackgroundTasksBadge from '@/webfront/components/BackgroundTasksBadge.svelte';
import { handleBackgroundTaskEvent } from '@/webfront/stores/backgroundTaskStore';

describe('BackgroundTasksBadge', () => {
  it('renders live background task state from task events', async () => {
    const taskId = `badge-task-${Date.now()}`;

    handleBackgroundTaskEvent({
      type: 'BackgroundTaskStarted',
      data: {
        taskId,
        type: 'background_agent',
        description: 'Run background research',
        startTime: Date.now(),
      },
    });

    render(BackgroundTasksBadge);

    const badge = screen.getByTestId('background-tasks-badge');
    expect(badge.textContent).toContain('1');

    await fireEvent.click(screen.getByTitle('Background tasks'));
    expect(screen.getByText('Run background research')).toBeTruthy();

    handleBackgroundTaskEvent({
      type: 'BackgroundTaskStateChanged',
      data: {
        taskId,
        prevStatus: 'running',
        status: 'completed',
      },
    });

    expect(screen.getByText('Run background research')).toBeTruthy();
  });
});
