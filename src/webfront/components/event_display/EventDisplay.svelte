<script lang="ts">
  /**
   * EventDisplay - Base component for rendering processed events
   *
   * This component selects the appropriate child component based on event category
   * and handles common event behaviors (collapsing, selection, interactions).
   */

  import type { ProcessedEvent } from '@/types/ui';
  import { formatTime } from '@/utils/formatters';
  import { uiTheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import Tooltip from '../common/Tooltip.svelte';
  import MessageEvent from './MessageEvent.svelte';
  import ErrorEvent from './ErrorEvent.svelte';
  import TaskEvent from './TaskEvent.svelte';
  import ToolCallEvent from './ToolCallEvent.svelte';
  import ReasoningEvent from './ReasoningEvent.svelte';
  import OutputEvent from './OutputEvent.svelte';
  import ApprovalEvent from './ApprovalEvent.svelte';
  import PlanEvent from './PlanEvent.svelte';
  import SystemEvent from './SystemEvent.svelte';

  // Props
  let {
    event,
    selected = false,
    onClick,
    onToggleCollapse,
  }: {
    event: ProcessedEvent;
    selected?: boolean;
    onClick?: (event: ProcessedEvent) => void;
    onToggleCollapse?: (event: ProcessedEvent, collapsed: boolean) => void;
  } = $props();

  // Local state
  let collapsed: boolean = $derived(event.collapsed ?? false);
  let currentTheme = $derived($uiTheme);

  function handleClick() {
    if (onClick) {
      onClick(event);
    }
  }

  function handleToggle() {
    if (!event.collapsible) return;

    collapsed = !collapsed;
    event.collapsed = collapsed;

    if (onToggleCollapse) {
      onToggleCollapse(event, collapsed);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Don't intercept keys when user is typing in an input/textarea
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (event.collapsible) {
        handleToggle();
      } else {
        handleClick();
      }
    }
  }

  // Apply styling classes from event.style
  function getContainerClasses(): string {
    // For chat messages, use different layout
    if (event.category === 'message') {
      const classes = [
        'text-base',
        'flex',
        'flex-col',
        'w-full',
        'mb-3',
        currentTheme === 'modern' ? 'font-chat' : 'font-terminal',
      ];

      if (event.title === 'user') {
        classes.push('items-end');
      } else {
        classes.push('items-start');
      }

      if (event.streaming) {
        classes.push('animate-pulse-subtle');
      }

      return classes.join(' ');
    }

    // For non-message events, keep original styling
    const classes = [
      'text-base',
      'border-l-2',
      'px-3',
      'py-2',
      'transition-colors',
      'cursor-pointer',
      currentTheme === 'modern'
        ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark rounded-lg mb-2 text-chat-text dark:text-chat-text-dark hover:bg-chat-card-hover dark:hover:bg-chat-card-hover-dark'
        : 'font-terminal hover:bg-gray-800/50',
    ];

    if (selected) {
      classes.push('bg-gray-700/50', 'ring-1', 'ring-cyan-400');
    }

    if (event.style.bgColor) {
      classes.push(event.style.bgColor);
    }

    if (event.style.borderColor) {
      classes.push(event.style.borderColor);
    } else if (currentTheme !== 'modern') {
      classes.push('border-gray-600');
    }

    if (event.streaming) {
      classes.push('animate-pulse-subtle');
    }

    return classes.join(' ');
  }

  function getTitleClasses(): string {
    const classes = ['text-sm'];

    if (event.style.textColor) {
      classes.push(event.style.textColor);
    }

    if (event.style.textWeight) {
      classes.push(event.style.textWeight);
    }

    if (event.style.textStyle === 'italic') {
      classes.push('italic');
    }

    return classes.join(' ');
  }
</script>

{#if event.category === 'message'}
  <!-- Simple left/right aligned messages with sender labels -->
  <div class={getContainerClasses()}>
    <!-- Header outside bubble for user messages in modern theme -->
    <div class="flex items-center gap-2 mb-1 text-sm
      {event.title === 'user' ? 'justify-end gap-2' : ''}">
      <span class="{currentTheme === 'modern'
        ? (event.title === 'user'
          ? 'font-medium text-chat-primary dark:text-chat-primary-dark'
          : 'font-medium text-chat-text dark:text-chat-text-dark')
        : (event.title === 'user'
          ? 'font-semibold text-cyan-400'
          : 'font-semibold text-violet-400')}">{event.title === 'user' ? t('You') : t('BrowserX')}:</span>
      {#if event.title !== 'user' && event.modelKey}
        <span class="text-sm italic
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-gray-500'}">{event.modelKey.includes(':') ? event.modelKey.split(':').slice(1).join(':') : event.modelKey}</span>
      {/if}
      <span class="text-sm
        {currentTheme === 'modern'
          ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
          : 'text-gray-400'}">{formatTime(event.timestamp, 'relative')}</span>
    </div>
    <div class="{event.title === 'user' ? 'w-fit max-w-[80%]' : 'w-full'}
      {currentTheme === 'modern' && event.title === 'user'
        ? 'bg-chat-primary dark:bg-chat-primary-dark rounded-[1.25rem] px-4 py-2'
        : ''}">
      <div class="{currentTheme === 'modern'
        ? (event.title === 'user' ? 'text-white' : 'text-chat-text dark:text-chat-text-dark')
        : ''}">
        <MessageEvent {event} />
        {#if event.streaming}
          <span class="text-cyan-400 text-sm animate-pulse ml-2" role="status" aria-live="polite">
            {$_t("streaming...")}
          </span>
        {/if}
      </div>
    </div>
  </div>
{:else}
  <!-- Original event display layout for non-message events -->
  <article
    class={getContainerClasses()}
    tabindex="0"
    role="article"
    aria-label={`${event.category} event: ${event.title}`}
    aria-expanded={event.collapsible ? !collapsed : undefined}
    onclick={handleClick}
    onkeydown={handleKeyDown}
  >
    <!-- Event Header -->
    <div class="flex items-center justify-between mb-1">
      <div class="flex items-center gap-2">
        <!-- Collapse indicator -->
        {#if event.collapsible}
          <button
            class="transition-colors
              {currentTheme === 'modern'
                ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark'
                : 'text-gray-400 hover:text-gray-200'}"
            onclick={(e) => { e.stopPropagation(); handleToggle(); }}
            aria-label={collapsed ? t('Expand') : t('Collapse')}
          >
            {#if collapsed}
              <span>▶</span>
            {:else}
              <span>▼</span>
            {/if}
          </button>
        {/if}

        <!-- Icon -->
        {#if event.style.icon}
          <span class="{currentTheme === 'modern'
            ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'text-term-green'}">
            {#if event.style.icon === 'error'}
              ⚠
            {:else if event.style.icon === 'success'}
              ✓
            {:else if event.style.icon === 'info'}
              ℹ
            {:else if event.style.icon === 'warning'}
              ⚠
            {:else if event.style.icon === 'tool'}
              🔧
            {:else if event.style.icon === 'thinking'}
              💭
            {/if}
          </span>
        {/if}

        <!-- Timestamp -->
        <Tooltip content={formatTime(event.timestamp, 'absolute')}>
          <span class="text-sm
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
              : 'text-gray-500'}">
            {formatTime(event.timestamp, 'relative')}
          </span>
        </Tooltip>

        <!-- Title -->
        <span class="text-sm
          {currentTheme === 'modern'
            ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'text-term-green'}">
          {event.title}
        </span>

        <!-- Status indicator -->
        {#if event.status}
          <span
            class="text-sm px-1.5 py-0.5 rounded
              {event.status === 'running'
                ? (currentTheme === 'modern'
                  ? 'bg-chat-status-running/10 dark:bg-chat-status-running-dark/10 text-chat-status-running dark:text-chat-status-running-dark'
                  : 'bg-cyan-400/20 text-cyan-400')
                : event.status === 'success'
                  ? (currentTheme === 'modern'
                    ? 'bg-chat-status-success/10 dark:bg-chat-status-success-dark/10 text-chat-status-success dark:text-chat-status-success-dark'
                    : 'bg-green-500/20 text-green-500')
                  : (currentTheme === 'modern'
                    ? 'bg-chat-status-error/10 dark:bg-chat-status-error-dark/10 text-chat-status-error dark:text-chat-status-error-dark'
                    : 'bg-red-500/20 text-red-500')}"
          >
            {event.status}
          </span>
        {/if}

        <!-- Streaming indicator -->
        {#if event.streaming}
          <span class="text-sm animate-pulse
            {currentTheme === 'modern'
              ? 'text-chat-primary dark:text-chat-primary-dark'
              : 'text-cyan-400'}" role="status" aria-live="polite">
            {$_t("streaming...")}
          </span>
        {/if}
      </div>
    </div>

    <!-- Event Content -->
    {#if !collapsed || !event.collapsible}
      <div class="event-content ml-6 mt-2">
        {#if event.category === 'error'}
          <ErrorEvent {event} />
        {:else if event.category === 'task'}
          <TaskEvent {event} />
        {:else if event.category === 'tool'}
          <ToolCallEvent {event} />
        {:else if event.category === 'reasoning'}
          <ReasoningEvent {event} />
        {:else if event.category === 'output'}
          <OutputEvent {event} />
        {:else if event.category === 'approval'}
          <ApprovalEvent {event} />
        {:else if event.category === 'plan'}
          <PlanEvent {event} />
        {:else if event.category === 'system'}
          <SystemEvent {event} />
        {:else}
          <!-- Fallback for unknown categories -->
          <div class="text-gray-400 text-sm">
            {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
          </div>
        {/if}
      </div>
    {/if}
  </article>
{/if}

<style>
  .animate-pulse-subtle {
    animation: pulse-subtle 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  @keyframes pulse-subtle {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.95;
    }
  }

  .event-content {
    animation: slideDown 0.2s ease-out;
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Modern Chat user bubble paragraph spacing */
  :global(.user-bubble-content p) {
    margin: 0;
    line-height: 1.4;
  }

  :global(.user-bubble-content p:not(:last-child)) {
    margin-bottom: 0.25em;
  }
</style>
