<script lang="ts">
  /**
   * EventDisplay - Base component for rendering processed events
   *
   * This component selects the appropriate child component based on event category
   * and handles common event behaviors (collapsing, selection, interactions).
   */

  import type { ProcessedEvent } from '../../../../open_source/src/types/ui';
  import { formatTime } from '../../../../open_source/src/utils/formatters';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
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
  export let event: ProcessedEvent;
  export let selected: boolean = false;
  export let onClick: ((event: ProcessedEvent) => void) | undefined = undefined;
  export let onToggleCollapse:
    | ((event: ProcessedEvent, collapsed: boolean) => void)
    | undefined = undefined;

  // Local state
  let collapsed = event.collapsed ?? false;
  let currentTheme: UITheme = 'terminal';

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Update collapsed state when event changes
  $: collapsed = event.collapsed ?? false;

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
      const classes = ['event-display', 'message-bubble-container', 'mb-3', currentTheme];

      if (event.title === 'user') {
        classes.push('user-message');
      } else {
        classes.push('agent-message');
      }

      if (event.streaming) {
        classes.push('animate-pulse-subtle');
      }

      return classes.join(' ');
    }

    // For non-message events, keep original styling
    const classes = [
      'event-display',
      'border-l-2',
      'px-3',
      'py-2',
      'hover:bg-gray-800/50',
      'transition-colors',
      'cursor-pointer',
      currentTheme,
    ];

    if (selected) {
      classes.push('bg-gray-700/50', 'ring-1', 'ring-cyan-400');
    }

    if (event.style.bgColor) {
      classes.push(event.style.bgColor);
    }

    if (event.style.borderColor) {
      classes.push(event.style.borderColor);
    } else {
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
    <!-- Header outside bubble for user messages in chatgpt theme -->
    <div class="message-header">
      <span class="message-sender">{event.title === 'user' ? 'You' : 'BrowserX'}:</span>
      <span class="message-time">{formatTime(event.timestamp, 'relative')}</span>
    </div>
    <div class="message-container">
      <div class="message-content">
        <MessageEvent {event} />
        {#if event.streaming}
          <span class="text-cyan-400 text-xs animate-pulse ml-2" role="status" aria-live="polite">
            streaming...
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
    on:click={handleClick}
    on:keydown={handleKeyDown}
  >
    <!-- Event Header -->
    <div class="event-header flex items-center justify-between mb-1">
      <div class="flex items-center gap-2">
        <!-- Collapse indicator -->
        {#if event.collapsible}
          <button
            class="collapse-button transition-colors"
            on:click|stopPropagation={handleToggle}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
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
          <span class="event-icon">
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
          <span class="event-timestamp text-xs">
            {formatTime(event.timestamp, 'relative')}
          </span>
        </Tooltip>

        <!-- Title -->
        <span class="event-title text-sm">
          {event.title}
        </span>

        <!-- Status indicator -->
        {#if event.status}
          <span
            class="event-status text-xs px-1.5 py-0.5 rounded"
            class:status-running={event.status === 'running'}
            class:status-success={event.status === 'success'}
            class:status-error={event.status !== 'running' && event.status !== 'success'}
          >
            {event.status}
          </span>
        {/if}

        <!-- Streaming indicator -->
        {#if event.streaming}
          <span class="streaming-indicator text-xs animate-pulse" role="status" aria-live="polite">
            streaming...
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
  .event-display {
    font-size: 1rem; /* text-base: 16px */
  }

  /* Simple left/right message alignment */
  .message-bubble-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    margin-bottom: 0.75rem;
  }

  .message-bubble-container.agent-message {
    /* Agent messages: full width, left-aligned */
    align-items: flex-start;
  }

  .message-bubble-container.user-message {
    /* User messages: right-aligned */
    align-items: flex-end;
  }

  .message-bubble-container.agent-message .message-container {
    width: 100%;
  }

  .message-bubble-container.user-message .message-container {
    width: fit-content;
    max-width: 80%;
  }

  .message-bubble-container.user-message .message-header {
    /* Right-align header for user messages */
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .message-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.75rem;
  }

  .message-sender {
    font-weight: 600;
  }

  .agent-message .message-sender {
    color: #a78bfa; /* Purple for agent name */
  }

  .user-message .message-sender {
    color: #22d3ee; /* Cyan for user name */
  }

  .message-time {
    color: #9ca3af;
    font-size: 0.7rem;
  }

  .message-content {
    /* No border or background - clean layout */
  }

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

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
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

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .event-display.chatgpt {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  /* ChatGPT theme message styling */
  .message-bubble-container.chatgpt .message-sender {
    font-weight: 500;
  }

  /* Agent messages: dark text color */
  .message-bubble-container.chatgpt.agent-message .message-sender {
    color: var(--chat-text, #0d0d0d);
  }

  .message-bubble-container.chatgpt.agent-message .message-content {
    color: var(--chat-text, #0d0d0d);
  }

  .message-bubble-container.chatgpt .message-time {
    color: var(--chat-text-muted, #8e8ea0);
  }

  /* User messages: header outside bubble with blue color */
  .message-bubble-container.chatgpt.user-message .message-header {
    margin-bottom: 0.375rem;
  }

  .message-bubble-container.chatgpt.user-message .message-sender {
    color: var(--chat-primary, #60a5fa);
  }

  .message-bubble-container.chatgpt.user-message .message-time {
    color: var(--chat-text-muted, #8e8ea0);
  }

  /* User messages: blue bubble with white text */
  .message-bubble-container.chatgpt.user-message .message-container {
    background: var(--chat-primary, #60a5fa);
    border-radius: 1.25rem;
    padding: 0.5rem 1rem;
  }

  .message-bubble-container.chatgpt.user-message .message-content {
    color: #ffffff;
  }

  /* Remove paragraph margins inside user bubble */
  .message-bubble-container.chatgpt.user-message .message-content :global(p) {
    margin: 0;
    line-height: 1.4;
  }

  .message-bubble-container.chatgpt.user-message .message-content :global(p:not(:last-child)) {
    margin-bottom: 0.25em;
  }

  /* ChatGPT theme for non-message events - light grey text */
  .event-display.chatgpt:not(.message-bubble-container) {
    background: var(--chat-card-bg, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
    border-radius: 0.5rem;
    margin-bottom: 0.5rem;
    color: var(--chat-text, #0d0d0d);
  }

  .event-display.chatgpt:not(.message-bubble-container):hover {
    background: var(--chat-card-hover, #ececec);
  }

  /* ============================================
     Event Header Styles - Terminal (default)
     ============================================ */

  .collapse-button {
    color: #9ca3af;
  }

  .collapse-button:hover {
    color: #e5e7eb;
  }

  .event-timestamp {
    color: #6b7280;
  }

  .event-title {
    color: #00ff00;
  }

  .event-icon {
    color: #00ff00;
  }

  .status-running {
    background: rgba(34, 211, 238, 0.2);
    color: #22d3ee;
  }

  .status-success {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
  }

  .status-error {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  .streaming-indicator {
    color: #22d3ee;
  }

  /* ============================================
     Event Header Styles - ChatGPT Theme
     ============================================ */

  .event-display.chatgpt .collapse-button {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .event-display.chatgpt .collapse-button:hover {
    color: var(--chat-text, #0d0d0d);
  }

  .event-display.chatgpt .event-timestamp {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .event-display.chatgpt .event-title {
    color: var(--chat-text-secondary, #6e6e80);
  }

  .event-display.chatgpt .event-icon {
    color: var(--chat-text-secondary, #6e6e80);
  }

  .event-display.chatgpt .status-running {
    background: var(--chat-status-running-bg, rgba(96, 165, 250, 0.1));
    color: var(--chat-status-running, #60a5fa);
  }

  .event-display.chatgpt .status-success {
    background: var(--chat-status-success-bg, rgba(16, 185, 129, 0.1));
    color: var(--chat-status-success, #10b981);
  }

  .event-display.chatgpt .status-error {
    background: var(--chat-status-error-bg, rgba(239, 68, 68, 0.1));
    color: var(--chat-status-error, #ef4444);
  }

  .event-display.chatgpt .streaming-indicator {
    color: var(--chat-primary, #60a5fa);
  }
</style>
