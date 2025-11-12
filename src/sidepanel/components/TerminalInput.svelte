<script lang="ts">
  export let value: string = '';
  export let placeholder: string = '';
  export let onSubmit: (value: string) => void = () => {};
  export let disabled: boolean = false;

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      onSubmit(value);
    }
  }
</script>

<input
  type="text"
  bind:value
  {placeholder}
  {disabled}
  on:keypress={handleKeyPress}
  class="terminal-input"
  aria-label="Terminal input"
/>