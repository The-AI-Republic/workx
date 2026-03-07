<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import type { RecurrenceRule, RecurrenceMode, RecurrenceIntervalUnit, RecurrenceEndCondition } from '@/core/models/types/Scheduler';

  export let recurrence: RecurrenceRule | null = null;

  const dispatch = createEventDispatcher<{ change: RecurrenceRule | null }>();

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(() => {
    unsubTheme();
  });

  // Local state derived from prop
  let mode: RecurrenceMode | 'none' = recurrence?.mode || 'none';
  let interval: number = recurrence?.interval || 1;
  let intervalUnit: RecurrenceIntervalUnit = recurrence?.intervalUnit || 'hours';
  let endCondition: RecurrenceEndCondition = recurrence?.endCondition || 'never';
  let endAfterCount: number = recurrence?.endAfterCount || 3;
  let endUntilDate: string = recurrence?.endUntilDate
    ? formatDateForInput(new Date(recurrence.endUntilDate))
    : '';

  function formatDateForInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Sync local state when parent resets the recurrence prop
  let syncingFromProp = false;
  $: {
    const propMode = recurrence?.mode || 'none';
    if (propMode !== mode || (!recurrence && mode !== 'none')) {
      syncingFromProp = true;
      mode = recurrence?.mode || 'none';
      interval = recurrence?.interval || 1;
      intervalUnit = recurrence?.intervalUnit || 'hours';
      endCondition = recurrence?.endCondition || 'never';
      endAfterCount = recurrence?.endAfterCount || 3;
      endUntilDate = recurrence?.endUntilDate
        ? formatDateForInput(new Date(recurrence.endUntilDate))
        : '';
      syncingFromProp = false;
    }
  }

  function emitChange() {
    // Don't re-emit when syncing from a prop change
    if (syncingFromProp) return;

    if (mode === 'none') {
      recurrence = null;
      dispatch('change', null);
      return;
    }

    const rule: RecurrenceRule = {
      mode,
      endCondition,
      completedCount: 0,
    };

    if (mode === 'custom') {
      rule.interval = interval;
      rule.intervalUnit = intervalUnit;
    }

    if (endCondition === 'after') {
      rule.endAfterCount = endAfterCount;
    } else if (endCondition === 'until' && endUntilDate) {
      rule.endUntilDate = new Date(endUntilDate + 'T23:59:59').getTime();
    }

    recurrence = rule;
    dispatch('change', rule);
  }

  // Re-emit on any local state change
  $: mode, interval, intervalUnit, endCondition, endAfterCount, endUntilDate, emitChange();

  const inputClass = (theme: UITheme) => theme === 'modern'
    ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
    : 'bg-black/50 border border-term-dim-green text-term-green font-terminal focus:outline-none focus:border-term-green';

  const labelClass = (theme: UITheme) => theme === 'modern'
    ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
    : 'text-term-dim-green';
</script>

<div class="flex flex-col gap-2">
  <!-- Repeat Mode -->
  <div>
    <span class="block text-xs mb-1 {labelClass(currentTheme)}">{$_t('Repeat')}</span>
    <select
      class="w-full px-2 py-1.5 text-sm rounded {inputClass(currentTheme)}"
      bind:value={mode}
    >
      <option value="none">{$_t('Does not repeat')}</option>
      <option value="daily">{$_t('Daily')}</option>
      <option value="weekly">{$_t('Weekly')}</option>
      <option value="monthly">{$_t('Monthly')}</option>
      <option value="custom">{$_t('Custom')}</option>
    </select>
  </div>

  {#if mode !== 'none'}
    <!-- Custom Interval -->
    {#if mode === 'custom'}
      <div class="flex gap-2 items-end">
        <div class="flex-1">
          <span class="block text-xs mb-1 {labelClass(currentTheme)}">{$_t('Every')}</span>
          <input
            type="number"
            min="1"
            max="999"
            class="w-full px-2 py-1.5 text-sm rounded {inputClass(currentTheme)}"
            bind:value={interval}
          />
        </div>
        <div class="flex-1">
          <select
            class="w-full px-2 py-1.5 text-sm rounded {inputClass(currentTheme)}"
            bind:value={intervalUnit}
          >
            <option value="minutes">{$_t('minutes')}</option>
            <option value="hours">{$_t('hours')}</option>
            <option value="days">{$_t('days')}</option>
            <option value="weeks">{$_t('weeks')}</option>
          </select>
        </div>
      </div>
    {/if}

    <!-- End Condition -->
    <div>
      <span class="block text-xs mb-1 {labelClass(currentTheme)}">{$_t('Ends')}</span>
      <select
        class="w-full px-2 py-1.5 text-sm rounded {inputClass(currentTheme)}"
        bind:value={endCondition}
      >
        <option value="never">{$_t('Never')}</option>
        <option value="after">{$_t('After X occurrences')}</option>
        <option value="until">{$_t('Until date')}</option>
      </select>
    </div>

    {#if endCondition === 'after'}
      <div>
        <span class="block text-xs mb-1 {labelClass(currentTheme)}">{$_t('After')}</span>
        <div class="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="999"
            class="w-20 px-2 py-1.5 text-sm rounded {inputClass(currentTheme)}"
            bind:value={endAfterCount}
          />
          <span class="text-sm {labelClass(currentTheme)}">{$_t('occurrences')}</span>
        </div>
      </div>
    {/if}

    {#if endCondition === 'until'}
      <div>
        <span class="block text-xs mb-1 {labelClass(currentTheme)}">{$_t('Until')}</span>
        <input
          type="date"
          class="w-full px-2 py-1.5 text-sm rounded picker-input {inputClass(currentTheme)}"
          bind:value={endUntilDate}
          min={formatDateForInput(new Date())}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  .picker-input::-webkit-calendar-picker-indicator {
    cursor: pointer;
  }
  :global(.terminal) .picker-input::-webkit-calendar-picker-indicator {
    filter: invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
  }
</style>
