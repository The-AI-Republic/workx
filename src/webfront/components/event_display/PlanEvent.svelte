<script lang="ts">
  /**
   * PlanEvent - Renders task plan steps with status markers
   *
   * Status markers:
   * - ✓ (green) for Completed steps
   * - → (cyan, animated) for InProgress steps
   * - • (dimmed) for Pending steps
   */

  import type { ProcessedEvent } from '@/types/ui';
  import type { PlanToolArgs, PlanStepArg } from '@/core/protocol/events';
  import { StepStatus } from '@/core/protocol/events';
  import { _t } from '../../lib/i18n';

  export let event: ProcessedEvent;

  $: planData = event.content as unknown as PlanToolArgs;
  $: plan = (planData?.plan || []) as PlanStepArg[];
  $: explanation = planData?.explanation;

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

  function getMarkerColor(status: StepStatus | string): string {
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

  function isInProgress(status: StepStatus | string): boolean {
    return status === StepStatus.InProgress || status === 'InProgress';
  }
</script>

<div class="p-2 px-3 rounded-md bg-gray-800/50 font-sans text-base">
  {#if explanation}
    <p class="mb-2 text-gray-400 italic">{explanation}</p>
  {/if}

  {#if plan.length > 0}
    <ul class="list-none m-0 p-0">
      {#each plan as item, i}
        <li class="py-1">
          <div class="flex items-center gap-2">
            <span class="font-bold w-4 text-center flex-shrink-0 {getMarkerColor(item.status)}" class:spin-marker={isInProgress(item.status)}>
              {getStatusMarker(item.status)}
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
