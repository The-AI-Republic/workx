<script lang="ts">
  /**
   * PlanEvent - Renders task plan with status indicators
   *
   * Status markers:
   * - ✓ (green) for Completed steps
   * - → (cyan) for InProgress steps
   * - • (dimmed) for Pending steps
   */

  import type { ProcessedEvent } from '../../../../open_source/src/types/ui';
  import type { UpdatePlanArgs, PlanItemArg } from '../../../../open_source/src/protocol/events';
  import { StepStatus } from '../../../../open_source/src/protocol/events';

  export let event: ProcessedEvent;

  // Extract plan data from the event
  $: planData = event.content as unknown as UpdatePlanArgs;
  $: plan = planData?.plan || [];
  $: explanation = planData?.explanation;

  /**
   * Get the status marker character for a step
   */
  function getStatusMarker(status: StepStatus | string): string {
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

  /**
   * Get the CSS class for a step based on its status
   */
  function getStatusClass(status: StepStatus | string): string {
    switch (status) {
      case StepStatus.Completed:
      case 'Completed':
        return 'completed';
      case StepStatus.InProgress:
      case 'InProgress':
        return 'in-progress';
      case StepStatus.Pending:
      case 'Pending':
      default:
        return 'pending';
    }
  }
</script>

<div class="p-2 px-3 rounded-md bg-gray-800/50 font-sans text-base">
  {#if explanation}
    <p class="mb-2 text-gray-400 italic">{explanation}</p>
  {/if}

  {#if plan.length > 0}
    <ul class="list-none m-0 p-0">
      {#each plan as item}
        <li class="flex items-center gap-2 py-1">
          <span class="font-bold w-4 text-center flex-shrink-0 {item.status === 'Completed' || item.status === StepStatus.Completed ? 'text-green-500' : item.status === 'InProgress' || item.status === StepStatus.InProgress ? 'text-cyan-500' : 'text-gray-400'}">
            {getStatusMarker(item.status)}
          </span>
          <span class="{item.status === 'Pending' || item.status === StepStatus.Pending ? 'text-gray-500' : 'text-gray-200'}">
            {item.step}
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-gray-500 italic">No steps in plan</p>
  {/if}
</div>
