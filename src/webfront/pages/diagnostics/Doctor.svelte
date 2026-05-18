<!--
  Doctor - Operational diagnostics report (Track 17)

  Renders the redacted DoctorReport served by the cross-platform
  `diagnostics.report` service. Discrete pass/warn/fail panel, mirroring
  claudy's Doctor screen but Svelte-rendered and consistent with Settings.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { DoctorReport } from '@/core/diagnostics';
  import { t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  let report: DoctorReport | null = $state(null);
  let loading: boolean = $state(true);
  let error: string | null = $state(null);

  let currentTheme = $derived($uiTheme);

  onMount(async () => {
    await loadReport();
  });

  async function loadReport() {
    loading = true;
    error = null;
    try {
      const client = await getInitializedUIClient();
      report = await client.serviceRequest<DoctorReport>('diagnostics.report');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function close() {
    push('/');
  }

  function symbol(status: 'pass' | 'warn' | 'fail'): string {
    return status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗';
  }
</script>

<div class="doctor-page" class:modern={currentTheme === 'modern'}>
  <div class="doctor-container">
    <div class="doctor-header">
      <h2 class="doctor-title">{t('Diagnostics')}</h2>
      <button class="close-button" onclick={close} aria-label={t('Close diagnostics')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="doctor-content">
      {#if loading}
        <div class="doctor-loading">{t('Running diagnostics…')}</div>
      {:else if error}
        <div class="doctor-error">
          <p>{t('Could not load diagnostics')}: {error}</p>
          <button class="retry-button" onclick={loadReport}>{t('Retry')}</button>
        </div>
      {:else if report}
        <div class="overall overall-{report.overall}">
          <span class="badge">{symbol(report.overall)}</span>
          <span>{t('Overall')}: {t(report.overall.toUpperCase())}</span>
          <span class="meta">
            {report.platformId} · {report.checks.length} {t('checks')} · {report.durationMs}{t('ms')}
          </span>
        </div>

        <ul class="check-list">
          {#each report.checks as check (check.id)}
            <li class="check check-{check.status}">
              <span class="badge">{symbol(check.status)}</span>
              <div class="check-body">
                <div class="check-title">{check.title}</div>
                <div class="check-detail">{check.detail}</div>
              </div>
            </li>
          {/each}
        </ul>

        <button class="retry-button" onclick={loadReport}>{t('Re-run')}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .doctor-page {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    overflow-y: auto;
    background: var(--color-bg, #000);
    color: var(--color-fg, #e0e0e0);
    font-family: var(--font-mono, monospace);
  }
  .doctor-container {
    width: 100%;
    max-width: 760px;
    padding: 16px;
  }
  .doctor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-border, #333);
    padding-bottom: 8px;
    margin-bottom: 12px;
  }
  .doctor-title {
    font-size: 16px;
    margin: 0;
  }
  .close-button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 4px;
  }
  .close-button:hover {
    opacity: 0.7;
  }
  .doctor-loading,
  .doctor-error {
    padding: 24px 8px;
    opacity: 0.85;
  }
  .overall {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--color-border, #333);
    border-radius: 4px;
    margin-bottom: 12px;
    font-weight: bold;
  }
  .overall .meta {
    margin-left: auto;
    font-weight: normal;
    opacity: 0.7;
    font-size: 12px;
  }
  .check-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .check {
    display: flex;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-border, #222);
  }
  .check-body {
    flex: 1;
  }
  .check-title {
    font-weight: bold;
  }
  .check-detail {
    opacity: 0.8;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .badge {
    width: 1.2em;
    text-align: center;
    font-weight: bold;
    flex-shrink: 0;
  }
  .check-pass .badge,
  .overall-pass .badge {
    color: #4caf50;
  }
  .check-warn .badge,
  .overall-warn .badge {
    color: #e0a000;
  }
  .check-fail .badge,
  .overall-fail .badge {
    color: #e05050;
  }
  .retry-button {
    margin-top: 14px;
    background: none;
    border: 1px solid var(--color-border, #444);
    color: inherit;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 4px;
    font-family: inherit;
  }
  .retry-button:hover {
    background: var(--color-border, #333);
  }
  .doctor-page.modern {
    font-family: var(--font-sans, system-ui, sans-serif);
  }
</style>
