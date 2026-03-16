<script lang="ts">
  let { value = $bindable(''), placeholder = '', onSubmit = (value: string) => {} }: {
    value?: string;
    placeholder?: string;
    onSubmit?: (value: string) => void;
  } = $props();

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
  onkeypress={handleKeyPress}
  class="terminal-input"
  aria-label="Terminal input"
/>