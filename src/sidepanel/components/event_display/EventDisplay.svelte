<script lang="ts">
  /**
   * EventDisplay - Base component for rendering processed events
   *
   * This component selects the appropriate child component based on event category
   * and handles common event behaviors (collapsing, selection, interactions).
   */

  import type { ProcessedEvent } from '../../../types/ui';
  import { formatTime } from '../../../utils/formatters';
  import MessageEvent from './MessageEvent.svelte';
  import ErrorEvent from './ErrorEvent.svelte';
  import TaskEvent from './TaskEvent.svelte';
  import ToolCallEvent from './ToolCallEvent.svelte';
  import ReasoningEvent from './ReasoningEvent.svelte';
  import OutputEvent from './OutputEvent.svelte';
  import ApprovalEvent from './ApprovalEvent.svelte';
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
      const classes = ['event-display', 'message-bubble-container', 'mb-3'];

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
  <!-- Chat-style message bubble layout -->
  <div class={getContainerClasses()}>
    <div class="message-bubble">
      <div class="message-header">
        <span class="message-sender">{event.title === 'user' ? 'You' : 'BrowserX'}</span>
        <span class="message-time">{formatTime(event.timestamp, 'relative')}</span>
      </div>
      <div class="message-content-wrapper">
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
    <div class="flex items-center justify-between mb-1">
      <div class="flex items-center gap-2">
        <!-- Collapse indicator -->
        {#if event.collapsible}
          <button
            class="text-gray-400 hover:text-gray-200 transition-colors"
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
          <span class={`icon-${event.style.icon} ${event.style.iconColor || event.style.textColor}`}>
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
        <span class="text-gray-500 text-xs" title={formatTime(event.timestamp, 'absolute')}>
          {formatTime(event.timestamp, 'relative')}
        </span>

        <!-- Title -->
        <span class={getTitleClasses()}>
          {event.title}
        </span>

        <!-- Status indicator -->
        {#if event.status}
          <span
            class="text-xs px-1.5 py-0.5 rounded {event.status === 'running'
              ? 'bg-cyan-500/20 text-cyan-400'
              : event.status === 'success'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-red-500/20 text-red-400'}"
          >
            {event.status}
          </span>
        {/if}

        <!-- Streaming indicator -->
        {#if event.streaming}
          <span class="text-cyan-400 text-xs animate-pulse" role="status" aria-live="polite">
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
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New',
      monospace;
  }

  /* Chat-style message bubbles */
  .message-bubble-container {
    display: flex;
    width: 100%;
    padding: 0.25rem 0.5rem;
    animation: slideIn 0.2s ease-out;
  }

  .message-bubble-container.agent-message {
    justify-content: flex-start;
  }

  .message-bubble-container.user-message {
    justify-content: flex-end;
  }

  .message-bubble {
    max-width: 80%;
    min-width: 200px;
    padding: 0.75rem 1rem;
    border-radius: 12px;
    position: relative;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .agent-message .message-bubble {
    background: rgba(139, 92, 246, 0.15); /* Purple tint for agent */
    border: 1px solid rgba(139, 92, 246, 0.3);
    border-bottom-left-radius: 4px;
  }

  .user-message .message-bubble {
    background: rgba(6, 182, 212, 0.15); /* Cyan tint for user */
    border: 1px solid rgba(6, 182, 212, 0.3);
    border-bottom-right-radius: 4px;
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    font-size: 0.75rem;
    opacity: 0.7;
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
  }

  .message-content-wrapper {
    display: flex;
    align-items: flex-start;
    flex-direction: column;
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

  /* Dark mode adjustments */
  @media (prefers-color-scheme: dark) {
    .agent-message .message-bubble {
      background: rgba(139, 92, 246, 0.12);
      border-color: rgba(139, 92, 246, 0.25);
    }

    .user-message .message-bubble {
      background: rgba(6, 182, 212, 0.12);
      border-color: rgba(6, 182, 212, 0.25);
    }
  }
</style>
