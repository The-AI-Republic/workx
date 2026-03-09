<script lang="ts">
  import { onMount } from 'svelte';

  let {
    testConfigInjection = false,
    showLoadingState = false,
    enableValidation = false,
    showProfileSelector = false,
    showProfileManagement = false,
    showErrors = false,
    handleErrors = false,
  }: {
    testConfigInjection?: boolean;
    showLoadingState?: boolean;
    enableValidation?: boolean;
    showProfileSelector?: boolean;
    showProfileManagement?: boolean;
    showErrors?: boolean;
    handleErrors?: boolean;
  } = $props();

  let currentModel = $state('claude-3-5-sonnet-20241022');
  let currentApproval = $state('on-request');
  let loading = $state(showLoadingState);
  let validationError = $state('');
  let configError = $state('');
  let showFallback = $state(false);

  onMount(() => {
    if (showLoadingState) {
      setTimeout(() => {
        loading = false;
      }, 100);
    }

    if (handleErrors) {
      try {
        // This would normally access AgentConfig
        throw new Error('Config access failed');
      } catch (error) {
        showFallback = true;
      }
    }
  });

  function handleModelInput(event: Event) {
    const target = event.target as HTMLInputElement;
    if (enableValidation && target.value === 'invalid-model') {
      validationError = 'Invalid model';
    } else {
      validationError = '';
    }
  }

  function handleProfileChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    if (target.value === 'development') {
      currentModel = 'claude-3-haiku-20240307';
      currentApproval = 'never';
    }
  }

  function createProfile() {
    // Mock profile creation
  }
</script>

{#if loading}
  <div data-testid="config-loading">Loading configuration...</div>
{:else if showFallback}
  <div data-testid="fallback-ui">Fallback UI</div>
{:else}
  <div class="settings-panel">
    {#if testConfigInjection}
      <select data-testid="model-select">
        <option>{currentModel}</option>
      </select>
    {/if}

    <div data-testid="current-model">{currentModel}</div>
    <div data-testid="current-approval">{currentApproval}</div>

    {#if enableValidation}
      <input data-testid="model-input" oninput={handleModelInput} />
      {#if validationError}
        <div data-testid="validation-error">{validationError}</div>
      {/if}
    {/if}

    {#if showProfileSelector}
      <select data-testid="profile-select" onchange={handleProfileChange}>
        <option value="default">Default</option>
        <option value="development" data-testid="profile-option">development</option>
      </select>
    {/if}

    {#if showProfileManagement}
      <div data-testid="create-profile-form">
        <input data-testid="profile-name-input" placeholder="Profile name" />
        <select data-testid="profile-model-select">
          <option value="claude-3-haiku-20240307">Haiku</option>
          <option value="claude-3-opus-20240229">Opus</option>
        </select>
        <button data-testid="create-profile-button" onclick={createProfile}>Create Profile</button>
        <div data-testid="profile-option">production</div>
      </div>
    {/if}

    {#if showErrors && configError}
      <div data-testid="config-error">{configError}</div>
    {/if}
  </div>
{/if}