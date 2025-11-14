<script lang="ts">
  // Terminal container wrapper component
</script>

<div class="terminal-container" role="log" aria-label="Terminal output">
  <slot />
</div>

<style>
  .terminal-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
</style>