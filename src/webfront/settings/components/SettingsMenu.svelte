<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../lib/i18n';
  import SettingsSearch from './SettingsSearch.svelte';

  let {
    onCategorySelected,
  }: {
    onCategorySelected?: (data: { categoryId: string; scrollToId?: string }) => void;
  } = $props();

  // Desktop detection for conditional settings filtering
  let isDesktop = $state(false);
  onMount(async () => {
    try {
      await import('@tauri-apps/api/core');
      isDesktop = true;
    } catch {
      isDesktop = false;
    }
  });

  // Track whether search is active to hide/show category cards
  let searchActive = $state(false);

  function handleSearchResult(data: { categoryId: string; scrollToId: string }) {
    onCategorySelected?.({
      categoryId: data.categoryId,
      scrollToId: data.scrollToId,
    });
  }

  function handleSearchActive(data: { active: boolean }) {
    searchActive = data.active;
  }

  interface Category {
    id: string;
    label: string;
    description: string;
    icon: string;
  }

  const categories: Category[] = [
    {
      id: 'model-config',
      label: t('Model Config'),
      description: t('Configure AI model and API keys'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
        <path d="M2 17l10 5 10-5"></path>
        <path d="M2 12l10 5 10-5"></path>
      </svg>`
    },
    {
      id: 'general',
      label: t('General'),
      description: t('User preferences and interface settings'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M12 1v6m0 6v6m5.66-17.66l-3 3m-3.46 3.46l-3 3m17.66 5.66l-6 0m-6 0l-6 0m17.66-5.66l-3 3m-3.46 3.46l-3 3"></path>
      </svg>`
    },
    {
      id: 'keyboard-shortcuts',
      label: t('Keyboard Shortcuts'),
      description: t('View and customize app keyboard shortcuts'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="5" width="18" height="14" rx="2"></rect>
        <path d="M7 9h.01M11 9h.01M15 9h.01M17 13h.01M13 13h.01M9 13h.01M7 17h10"></path>
      </svg>`
    },
    {
      id: 'memory',
      label: t('Memory'),
      description: t('Long-term memory across conversations'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2a4 4 0 0 1 4 4v1a3 3 0 0 1 3 3v1a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2v-1a3 3 0 0 1 3-3V6a4 4 0 0 1 4-4z"></path>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
      </svg>`
    },
    {
      id: 'storage',
      label: t('Storage & Cache'),
      description: t('Cache behavior and data retention'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
      </svg>`
    },
    {
      id: 'tools',
      label: t('Tools'),
      description: t('Browser automation tool toggles'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
      </svg>`
    },
    {
      id: 'mcp-servers',
      label: t('MCP Servers'),
      description: t('Connect to external MCP tool servers'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
        <circle cx="7" cy="10" r="1.5"></circle>
        <circle cx="12" cy="10" r="1.5"></circle>
        <circle cx="17" cy="10" r="1.5"></circle>
      </svg>`
    },
    {
      id: 'approval',
      label: t('Approval & Safety'),
      description: t('Action approval mode, trusted domains, risk settings'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
      </svg>`
    },
    {
      id: 'security',
      label: t('Security'),
      description: t('Credential encryption and PIN protection'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        <circle cx="12" cy="16" r="1"></circle>
      </svg>`
    },
    {
      id: 'extension',
      label: t('Extension & Permission'),
      description: t('Extension configuration and permissions'),
      icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>`
    }
  ];

  function selectCategory(categoryId: string) {
    onCategorySelected?.({ categoryId });
  }
</script>

<div class="settings-menu">
  <h2 class="menu-title">{t("Settings")}</h2>
  <SettingsSearch
    {isDesktop}
    onResultSelected={handleSearchResult}
    onSearchActive={handleSearchActive}
  />
  <div class="categories-grid" class:hidden-but-present={searchActive}>
    {#each categories as category}
      <button
        class="category-card"
        onclick={() => selectCategory(category.id)}
        aria-label={t('Open $1$ settings', { substitutions: [category.label] })}
        tabindex={searchActive ? -1 : 0}
      >
        <div class="category-header">
          <div class="category-icon">
            {@html category.icon}
          </div>
          <h3 class="category-label">{category.label}</h3>
        </div>
        <p class="category-description">{category.description}</p>
      </button>
    {/each}
  </div>
</div>

<style>
  .settings-menu {
    padding: 1.5rem;
  }

  .menu-title {
    margin: 0 0 1.5rem 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .categories-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }

  .categories-grid.hidden-but-present {
    visibility: hidden;
    pointer-events: none;
  }

  .category-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 1.25rem;
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
    width: 100%;
  }

  .category-card:hover {
    background: color-mix(in srgb, var(--browserx-surface) 90%, var(--browserx-text));
    border-color: var(--browserx-primary);
    transform: translateY(-2px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }

  .category-card:active {
    transform: translateY(0);
  }

  .category-header {
    display: flex;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .category-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-right: 0.75rem;
    padding: 0.375rem;
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
    border-radius: 0.375rem;
    color: var(--browserx-primary);
  }

  .category-label {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .category-description {
    margin: 0;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    line-height: 1.5;
  }
</style>
