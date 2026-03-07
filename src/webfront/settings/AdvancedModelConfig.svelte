<!--
  AdvancedModelConfig - Svelte component for viewing advanced model and provider configuration
  Displays IModelConfig and IProviderConfig fields as read-only information
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t, _t } from '../lib/i18n';
  import type { AgentConfig } from '@/config/AgentConfig';

  let {
    settingsConfig,
    modelId,
    providerId,
    onBack,
  }: {
    settingsConfig: AgentConfig | null;
    modelId: string;
    providerId: string;
    onBack?: () => void;
  } = $props();

  // State
  let isLoading = $state(true);

  // Model config fields (from IModelConfig)
  let modelName = $state('');
  let modelKey = $state('');
  let creator = $state('');
  let contextWindow = $state(0);
  let maxOutputTokens = $state(0);
  let supportsReasoning = $state(false);
  let reasoningEfforts: string[] = $state([]);
  let supportsReasoningSummaries = $state(false);
  let supportsVerbosity = $state(false);
  let verbosityLevels: string[] = $state([]);
  let supportsImage = $state(true);
  let releaseDate: string | null = $state(null);
  let deprecated = $state(false);
  let deprecationMessage: string | null = $state(null);
  let serviceTier: 'default' | 'flex' | 'priority' | undefined = $state(undefined);
  let pricingInputToken = $state('');
  let pricingOutputToken = $state('');
  let pricingLink = $state('');

  // Provider config fields (from IProviderConfig)
  let providerName = $state('');
  let organization: string | null = $state(null);
  let baseUrl: string | null = $state(null);
  let version: string | null = $state(null);
  let timeout = $state(60000);
  let retryMaxRetries = $state(3);
  let retryInitialDelay = $state(1000);
  let retryMaxDelay = $state(30000);
  let retryBackoffMultiplier = $state(2);

  onMount(async () => {
    await loadConfig();
  });

  async function loadConfig() {
    if (!settingsConfig) {
      isLoading = false;
      return;
    }

    try {
      isLoading = true;

      // Load model config - modelId is now a composite key (providerId:modelKey)
      const modelData = settingsConfig.getModelByKey(modelId);
      if (modelData?.model) {
        const model = modelData.model;
        modelName = model.name || '';
        modelKey = model.modelKey || '';
        creator = model.creator || '';
        contextWindow = model.contextWindow || 0;
        maxOutputTokens = model.maxOutputTokens || 0;
        supportsReasoning = model.supportsReasoning || false;
        reasoningEfforts = model.reasoningEfforts || [];
        supportsReasoningSummaries = model.supportsReasoningSummaries || false;
        supportsVerbosity = model.supportsVerbosity || false;
        verbosityLevels = model.verbosityLevels || [];
        supportsImage = model.supportsImage !== false;
        releaseDate = model.releaseDate || null;
        deprecated = model.deprecated || false;
        deprecationMessage = model.deprecationMessage || null;
        serviceTier = model.serviceTier;
        pricingInputToken = model.pricing?.inputToken || '';
        pricingOutputToken = model.pricing?.outputToken || '';
        pricingLink = model.pricing?.link || '';
      }

      // Load provider config
      const provider = settingsConfig.getProvider(providerId);
      if (provider) {
        providerName = provider.name || '';
        organization = provider.organization || null;
        baseUrl = provider.baseUrl || null;
        version = provider.version || null;
        timeout = provider.timeout || 60000;

        if (provider.retryConfig) {
          retryMaxRetries = provider.retryConfig.maxRetries ?? 3;
          retryInitialDelay = provider.retryConfig.initialDelay ?? 1000;
          retryMaxDelay = provider.retryConfig.maxDelay ?? 30000;
          retryBackoffMultiplier = provider.retryConfig.backoffMultiplier ?? 2;
        }
      }
    } catch (error) {
      console.error('[AdvancedModelConfig] Failed to load config:', error);
    } finally {
      isLoading = false;
    }
  }

  function handleBack() {
    onBack?.();
  }

  function formatNumber(num: number): string {
    return num.toLocaleString();
  }
</script>

<div class="advanced-config">
  <button class="back-button" onclick={handleBack}>{@html '&#8592;'} {$_t("Back to Model Config")}</button>

  <h2 class="config-title">{$_t("Advanced Configuration")}</h2>
  <p class="config-subtitle">{$_t("Model and provider settings loaded from default configuration (read-only)")}</p>

  {#if isLoading}
    <div class="loading">{$_t("Loading configuration...")}</div>
  {:else}
    <div class="config-display">
      <!-- Model Configuration Section -->
      <div class="config-section">
        <h3 class="section-title">{$_t("Model Configuration")}</h3>

        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">{$_t("Model Name")}</span>
            <span class="info-value">{modelName || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Model Key (API)")}</span>
            <span class="info-value code">{modelKey || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Creator")}</span>
            <span class="info-value">{creator || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Release Date")}</span>
            <span class="info-value">{releaseDate || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Context Window")}</span>
            <span class="info-value">{formatNumber(contextWindow)} {$_t("tokens")}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Max Output Tokens")}</span>
            <span class="info-value">{formatNumber(maxOutputTokens)} {$_t("tokens")}</span>
          </div>
        </div>

        <!-- Capabilities -->
        <div class="capabilities-section">
          <h4 class="subsection-title">{$_t("Capabilities")}</h4>
          <div class="capability-tags">
            <span class="tag {supportsImage ? 'enabled' : 'disabled'}">
              {supportsImage ? '✓' : '✗'} {$_t("Image Input")}
            </span>
            <span class="tag {supportsReasoning ? 'enabled' : 'disabled'}">
              {supportsReasoning ? '✓' : '✗'} {$_t("Reasoning")}
            </span>
            <span class="tag {supportsReasoningSummaries ? 'enabled' : 'disabled'}">
              {supportsReasoningSummaries ? '✓' : '✗'} {$_t("Reasoning Summaries")}
            </span>
            <span class="tag {supportsVerbosity ? 'enabled' : 'disabled'}">
              {supportsVerbosity ? '✓' : '✗'} {$_t("Verbosity Control")}
            </span>
            {#if deprecated}
              <span class="tag deprecated">⚠ {$_t("Deprecated")}</span>
            {/if}
          </div>
        </div>

        {#if supportsReasoning && reasoningEfforts.length > 0}
          <div class="info-item full-width">
            <span class="info-label">{$_t("Reasoning Efforts")}</span>
            <span class="info-value">{reasoningEfforts.join(', ')}</span>
          </div>
        {/if}

        {#if supportsVerbosity && verbosityLevels.length > 0}
          <div class="info-item full-width">
            <span class="info-label">{$_t("Verbosity Levels")}</span>
            <span class="info-value">{verbosityLevels.join(', ')}</span>
          </div>
        {/if}

        {#if deprecated && deprecationMessage}
          <div class="info-item full-width">
            <span class="info-label">{$_t("Deprecation Message")}</span>
            <span class="info-value warning">{deprecationMessage}</span>
          </div>
        {/if}

        {#if providerId === 'openai' && serviceTier}
          <div class="info-item full-width">
            <span class="info-label">{$_t("Service Tier")}</span>
            <span class="info-value">{serviceTier}</span>
          </div>
        {/if}

        <!-- Pricing -->
        {#if pricingInputToken || pricingOutputToken}
          <div class="pricing-section">
            <h4 class="subsection-title">{$_t("Pricing Information")}</h4>
            <div class="info-grid">
              <div class="info-item">
                <span class="info-label">{$_t("Input Token Price")}</span>
                <span class="info-value">{pricingInputToken || '-'}</span>
              </div>

              <div class="info-item">
                <span class="info-label">{$_t("Output Token Price")}</span>
                <span class="info-value">{pricingOutputToken || '-'}</span>
              </div>
            </div>

            {#if pricingLink}
              <div class="info-item full-width">
                <span class="info-label">{$_t("Pricing Page")}</span>
                <a href={pricingLink} target="_blank" rel="noopener noreferrer" class="info-link">
                  {pricingLink}
                </a>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Provider Configuration Section -->
      <div class="config-section">
        <h3 class="section-title">{$_t("Provider Configuration")}</h3>

        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">{$_t("Provider Name")}</span>
            <span class="info-value">{providerName || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Provider ID")}</span>
            <span class="info-value code">{providerId || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("Organization ID")}</span>
            <span class="info-value">{organization || '-'}</span>
          </div>

          <div class="info-item">
            <span class="info-label">{$_t("API Version")}</span>
            <span class="info-value">{version || '-'}</span>
          </div>
        </div>

        <div class="info-item full-width">
          <span class="info-label">{$_t("Base URL")}</span>
          <span class="info-value code">{baseUrl || '-'}</span>
        </div>

        <div class="info-item full-width">
          <span class="info-label">{$_t("Request Timeout")}</span>
          <span class="info-value">{formatNumber(timeout)} ms ({(timeout / 1000).toFixed(0)} seconds)</span>
        </div>

        <!-- Retry Configuration -->
        <div class="retry-section">
          <h4 class="subsection-title">{$_t("Retry Configuration")}</h4>
          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">{$_t("Max Retries")}</span>
              <span class="info-value">{retryMaxRetries}</span>
            </div>

            <div class="info-item">
              <span class="info-label">{$_t("Initial Delay")}</span>
              <span class="info-value">{formatNumber(retryInitialDelay)} ms</span>
            </div>

            <div class="info-item">
              <span class="info-label">{$_t("Max Delay")}</span>
              <span class="info-value">{formatNumber(retryMaxDelay)} ms</span>
            </div>

            <div class="info-item">
              <span class="info-label">{$_t("Backoff Multiplier")}</span>
              <span class="info-value">{retryBackoffMultiplier}x</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .advanced-config {
    padding: 1.5rem;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--browserx-primary);
    cursor: pointer;
    font-size: 0.9375rem;
    font-weight: 500;
    padding: 0.5rem 0;
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    transition: opacity 0.2s;
  }

  .back-button:hover {
    opacity: 0.8;
  }

  .config-title {
    margin: 0 0 0.25rem 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .config-subtitle {
    margin: 0 0 1.5rem 0;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
  }

  .loading {
    padding: 2rem;
    text-align: center;
    color: var(--browserx-text-secondary);
  }

  .config-display {
    max-width: 800px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .config-section {
    margin-bottom: 0;
    padding: 1rem 1.25rem;
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.75rem;
  }

  .section-title {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .subsection-title {
    margin: 1.5rem 0 1rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--browserx-text);
    padding-top: 1rem;
    border-top: 1px solid var(--browserx-border);
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }

  @media (max-width: 600px) {
    .info-grid {
      grid-template-columns: 1fr;
    }
  }

  .info-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .info-item.full-width {
    grid-column: 1 / -1;
    margin-top: 0.5rem;
  }

  .info-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .info-value {
    font-size: 0.9375rem;
    color: var(--browserx-text);
    word-break: break-word;
  }

  .info-value.code {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    background: var(--browserx-background);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.875rem;
  }

  .info-value.warning {
    color: #f59e0b;
  }

  .info-link {
    color: var(--browserx-primary);
    text-decoration: none;
    font-size: 0.875rem;
    word-break: break-all;
  }

  .info-link:hover {
    text-decoration: underline;
  }

  .capabilities-section {
    margin-top: 1.5rem;
  }

  .capability-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .tag.enabled {
    background: color-mix(in srgb, var(--browserx-success, #22c55e) 15%, transparent);
    color: var(--browserx-success, #22c55e);
  }

  .tag.disabled {
    background: var(--browserx-background);
    color: var(--browserx-text-secondary);
  }

  .tag.deprecated {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    color: #f59e0b;
  }

  .pricing-section, .retry-section {
    margin-top: 1rem;
  }
</style>
