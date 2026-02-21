<script lang="ts">
  /**
   * PlanEvent V2 - Renders task plan with enriched metadata
   *
   * Status markers:
   * - ✓ (green) for Completed steps
   * - → (cyan, animated) for InProgress steps with activeDescription
   * - • (dimmed) for Pending steps
   * - ✗ (amber) for Blocked steps
   *
   * Feature: 029-planning-tool-v2
   */

  import type { ProcessedEvent } from '@/types/ui';
  import type { UpdatePlanArgs, PlanItemArg } from '@/core/protocol/events';
  import { StepStatus } from '@/core/protocol/events';
  import { _t } from '../../lib/i18n';

  export let event: ProcessedEvent;

  // Extract plan data from the event
  $: planData = event.content as unknown as UpdatePlanArgs;
  $: plan = (planData?.plan || []) as PlanItemArg[];
  $: explanation = planData?.explanation;

  function getStatusMarker(status: StepStatus | string): string {
    switch (status) {
      case StepStatus.Completed:
      case 'Completed':
        return '✓';
      case StepStatus.InProgress:
      case 'InProgress':
        return '→';
      case StepStatus.Blocked:
      case 'Blocked':
        return '✗';
      case StepStatus.Pending:
      case 'Pending':
      default:
        return '•';
    }
  }

  function getStatusClass(status: StepStatus | string): string {
    switch (status) {
      case StepStatus.Completed:
      case 'Completed':
        return 'completed';
      case StepStatus.InProgress:
      case 'InProgress':
        return 'in-progress';
      case StepStatus.Blocked:
      case 'Blocked':
        return 'blocked';
      case StepStatus.Pending:
      case 'Pending':
      default:
        return 'pending';
    }
  }

  function getBlockedByLabels(item: PlanItemArg): string {
    if (!item.dependsOn?.length) return '';
    const blockers = item.dependsOn
      .map((depId) => {
        const idx = plan.findIndex((s) => s.id === depId);
        return idx >= 0 ? `step ${idx + 1}` : depId;
      });
    return `blocked by: ${blockers.join(', ')}`;
  }

  function getMarkerColor(status: StepStatus | string): string {
    switch (status) {
      case StepStatus.Completed:
      case 'Completed':
        return 'text-green-500';
      case StepStatus.InProgress:
      case 'InProgress':
        return 'text-cyan-500';
      case StepStatus.Blocked:
      case 'Blocked':
        return 'text-amber-500';
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
            <!-- Status marker with optional spinner -->
            <span class="font-bold w-4 text-center flex-shrink-0 {getMarkerColor(item.status)}" class:spin-marker={isInProgress(item.status)}>
              {getStatusMarker(item.status)}
            </span>
            <!-- Step description -->
            <span class="{item.status === 'Pending' || item.status === StepStatus.Pending ? 'text-gray-500' : item.status === 'Blocked' || item.status === StepStatus.Blocked ? 'text-gray-500' : 'text-gray-200'}">
              {item.step}
            </span>
            <!-- Active description for InProgress steps -->
            {#if isInProgress(item.status) && item.activeDescription}
              <span class="text-cyan-400 italic text-sm">({item.activeDescription})</span>
            {/if}
            <!-- Blocked reason -->
            {#if (item.status === 'Blocked' || item.status === StepStatus.Blocked) && item.dependsOn?.length}
              <span class="text-amber-500/70 italic text-sm">({getBlockedByLabels(item)})</span>
            {/if}
          </div>

          <!-- Enriched metadata (indented under step) -->
          {#if item.files?.length}
            <div class="ml-6 text-xs text-gray-500 font-mono">
              files: {item.files.join(', ')}
            </div>
          {/if}
          {#if item.reuse?.length}
            <div class="ml-6 text-xs text-gray-500 font-mono">
              reuse: {item.reuse.join(', ')}
            </div>
          {/if}
          {#if item.verification}
            <div class="ml-6 text-xs text-gray-500 font-mono">
              verification: {item.verification}
            </div>
          {/if}
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
