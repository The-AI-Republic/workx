<script lang="ts">
  import type { AgentTask } from '../../src/core/AgentTask';

  export let task: AgentTask;
  export let reactive = false;
  export let showExecution = false;

  let taskModel = 'claude-3-haiku-20240307';
  let taskApproval = 'untrusted';
  let executionModel = '';

  $: if (task && reactive) {
    const config = task.getConfig();
    taskModel = config.model;
    taskApproval = config.approval_policy;
  }

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
    <button data-testid="execute-button" on:click={executeTask}>Execute</button>
    {#if executionModel}
      <div data-testid="execution-model">{executionModel}</div>
    {/if}
  {/if}
</div>