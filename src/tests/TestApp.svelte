<script lang="ts">
  import TerminalContainer from '../webfront/components/TerminalContainer.svelte';
  import TerminalMessage from '../webfront/components/TerminalMessage.svelte';
  import TerminalInput from '../webfront/components/TerminalInput.svelte';

  let inputValue = '';

  function handleSubmit(value: string) {
    console.log('Submitted:', value);
  }
</script>

<TerminalContainer>
  <TerminalMessage type="system" content="System initialized" />
  <TerminalMessage type="default" content="Welcome to Browserx Terminal" />
  <TerminalMessage type="warning" content="Warning: Limited resources" />
  <TerminalMessage type="error" content="Error: Connection failed" />
  <TerminalMessage type="input" content="> user command" />
  <TerminalInput bind:value={inputValue} onSubmit={handleSubmit} placeholder="Enter command..." />
</TerminalContainer>