<script lang="ts">
  /**
   * PlanEvent - Renders task plan with status markers
   *
   * Supports both legacy PlanToolArgs format and new TaskUpdateEvent format.
   *
   * Status markers:
   * - ✓ (green) for completed tasks
   * - → (cyan, animated) for in_progress tasks
   * - • (dimmed) for pending tasks
   * - ✗ (red) for deleted tasks
   */

  import type { ProcessedEvent } from '@/types/ui';
  import type { PlanToolArgs, PlanStepArg, TaskUpdateEvent } from '@/core/protocol/events';
  import type { TaskSummary } from '@/core/taskmanager/types';
  import { StepStatus } from '@/core/protocol/events';
  import { _t } from '../../lib/i18n';

  let { event }: { event: ProcessedEvent } = $props();

  // Detect format: TaskUpdateEvent has allTasks, PlanToolArgs has plan
  let rawData = $derived(event.content as unknown as (PlanToolArgs | TaskUpdateEvent));
  let isTaskFormat = $derived('allTasks' in (rawData || {}));

  // Legacy PlanToolArgs
  let legacyPlan = $derived(!isTaskFormat ? (rawData as PlanToolArgs)?.plan || [] : []);
  let explanation = $derived(!isTaskFormat ? (rawData as PlanToolArgs)?.explanation : undefined);

  // New TaskUpdateEvent
  let taskData = $derived(isTaskFormat ? (rawData as TaskUpdateEvent) : null);
  let tasks = $derived(taskData?.allTasks || []);

  // Status helpers for legacy format
  function getLegacyStatusMarker(status: StepStatus | string): string {
    switch (status) {
      case StepStatus.Completed:
      case 'Completed':
        return '✓';
      case StepStatus.InProgress:
      case 'InProgress':
        return '→';
      case StepStatus.Pending:
      case 'Pending':
      default:
        return '•';
    }
  }

  function getLegacyMarkerColor(status: StepStatus | string): string {
    switch (status) {
      case StepStatus.Completed:
      case 'Completed':
        return 'text-green-500';
      case StepStatus.InProgress:
      case 'InProgress':
        return 'text-cyan-500';
      default:
        return 'text-gray-400';
    }
  }

  function isLegacyInProgress(status: StepStatus | string): boolean {
    return status === StepStatus.InProgress || status === 'InProgress';
  }

  // Status helpers for new task format
  function getTaskStatusMarker(status: string): string {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '→';
      case 'deleted': return '✗';
      case 'pending':
      default: return '•';
    }
  }

  function getTaskMarkerColor(status: string): string {
    switch (status) {
      case 'completed': return 'text-green-500';
      case 'in_progress': return 'text-cyan-500';
      case 'deleted': return 'text-red-400';
      default: return 'text-gray-400';
    }
  }

  function isTaskInProgress(status: string): boolean {
    return status === 'in_progress';
  }

  function getBlockedByText(task: TaskSummary): string {
    if (!task.blockedBy || task.blockedBy.length === 0) return '';
    return `blocked by #${task.blockedBy.join(', #')}`;
  }
</script>

<div class="p-2 px-3 rounded-md bg-gray-800/50 font-sans text-base">
  {#if isTaskFormat}
    <!-- New TaskUpdateEvent format -->
    {#if tasks.length > 0}
      <ul class="list-none m-0 p-0">
        {#each tasks as task}
          <li class="py-1">
            <div class="flex items-center gap-2">
              <span class="font-bold w-4 text-center flex-shrink-0 {getTaskMarkerColor(task.status)}" class:spin-marker={isTaskInProgress(task.status)}>
                {getTaskStatusMarker(task.status)}
              </span>
              <span class="text-gray-400 text-sm flex-shrink-0">#{task.id}</span>
              <span class="{task.status === 'pending' ? 'text-gray-500' : 'text-gray-200'}">
                {task.subject}
              </span>
              {#if getBlockedByText(task)}
                <span class="text-meta font-normal text-yellow-500/60 ml-1">({getBlockedByText(task)})</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-gray-500 italic">{$_t("No tasks in plan")}</p>
    {/if}
  {:else}
    <!-- Legacy PlanToolArgs format -->
    {#if explanation}
      <p class="mb-2 text-gray-400 italic">{explanation}</p>
    {/if}

    {#if legacyPlan.length > 0}
      <ul class="list-none m-0 p-0">
        {#each legacyPlan as item, i}
          <li class="py-1">
            <div class="flex items-center gap-2">
              <span class="font-bold w-4 text-center flex-shrink-0 {getLegacyMarkerColor(item.status)}" class:spin-marker={isLegacyInProgress(item.status)}>
                {getLegacyStatusMarker(item.status)}
              </span>
              <span class="{item.status === 'Pending' || item.status === StepStatus.Pending ? 'text-gray-500' : 'text-gray-200'}">
                {item.step}
              </span>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-gray-500 italic">{$_t("No steps in plan")}</p>
    {/if}
  {/if}
</div>

<style>
  .spin-marker {
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
