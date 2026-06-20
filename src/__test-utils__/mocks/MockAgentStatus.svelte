<script lang="ts">
  import type { WorkXAgent } from '../../src/core/WorkXAgent';

  let { agent, reactive = false, showStatus = false }: {
    agent: WorkXAgent;
    reactive?: boolean;
    showStatus?: boolean;
  } = $props();

  let agentModel = $state('claude-3-5-sonnet-20241022');
  let approvalPolicy = $state('on-request');
  let agentStatus = $state('ready');

  $effect(() => {
    if (agent && reactive) {
      const config = agent.getConfig();
      agentModel = config.model;
      approvalPolicy = config.approval_policy;

      if (config.sandbox_policy?.mode === 'read-only') {
        agentStatus = 'restricted';
      }
    }
  });
</script>

<div class="agent-status">
  <div data-testid="agent-model">{agentModel}</div>
  <div data-testid="approval-policy">{approvalPolicy}</div>

  {#if showStatus}
    <div data-testid="agent-status">{agentStatus}</div>
  {/if}
</div>