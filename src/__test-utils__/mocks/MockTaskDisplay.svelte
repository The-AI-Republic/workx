<script lang="ts">
  import type { AgentTask } from '../../src/core/AgentTask';

  let { task, reactive = false, showExecution = false }: {
    task: AgentTask;
    reactive?: boolean;
    showExecution?: boolean;
  } = $props();

  let taskModel = $state('claude-3-haiku-20240307');
  let taskApproval = $state('untrusted');
  let executionModel = $state('');

  $effect(() => {
    if (task && reactive) {
      const config = task.getConfig();
      taskModel = config.model;
      taskApproval = config.approval_policy;
    }
  });

  function executeTask() {
    if (task) {
      const config = task.getConfig();
      executionModel = config.model;
    }
  }
</script>

<div class="task-display">
  <div data-testid="task-model">{taskModel}</div>
  <div data-testid="task-approval">{taskApproval}</div>

  {#if showExecution}
    <button data-testid="execute-button" onclick={executeTask}>Execute</button>
    {#if executionModel}
      <div data-testid="execution-model">{executionModel}</div>
    {/if}
  {/if}
</div>