<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Calendar, DayGrid, TimeGrid, Interaction } from '@event-calendar/core';
  import '@event-calendar/core/dist/index.css';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import type { CalendarEvent } from '../../lib/calendarUtils';

  export let events: CalendarEvent[] = [];
  export let initialView: string = 'timeGridWeek';

  const dispatch = createEventDispatcher();

  let currentTheme: UITheme = 'terminal';
  let calendarEl: HTMLDivElement;
  let calendarComponent: any;

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function getCalendarOptions() {
    return {
      view: initialView,
      events: events,
      headerToolbar: {
        start: 'prev,next today',
        center: 'title',
        end: 'dayGridMonth,timeGridWeek,timeGridDay',
      },
      editable: true,
      eventStartEditable: true,
      selectable: true,
      nowIndicator: true,
      scrollTime: '08:00:00',
      dateClick: (info: any) => {
        dispatch('dateClick', { date: info.date, dateStr: info.dateStr });
      },
      eventClick: (info: any) => {
        dispatch('eventClick', { event: info.event, el: info.el, jsEvent: info.jsEvent });
      },
      eventDrop: (info: any) => {
        dispatch('eventDrop', { event: info.event, oldEvent: info.oldEvent });
      },
      datesSet: (info: any) => {
        dispatch('datesSet', { start: info.start, end: info.end, view: info.view });
      },
      select: (info: any) => {
        dispatch('select', { start: info.start, end: info.end, startStr: info.startStr, endStr: info.endStr });
      },
    };
  }

  onMount(() => {
    if (calendarEl) {
      calendarComponent = new Calendar({
        target: calendarEl,
        props: {
          plugins: [DayGrid, TimeGrid, Interaction],
          options: getCalendarOptions(),
        },
      });
    }
  });

  onDestroy(() => {
    unsubTheme();
    if (calendarComponent) {
      calendarComponent.$destroy();
    }
  });

  // Update events when they change
  $: if (calendarComponent) {
    calendarComponent.setOption('events', events);
  }

  export function getApi() {
    return calendarComponent;
  }
</script>

<div
  class="calendar-wrapper {currentTheme === 'terminal' ? 'calendar-terminal' : 'calendar-modern'}"
  bind:this={calendarEl}
></div>

<style>
  .calendar-wrapper {
    width: 100%;
    min-height: 400px;
  }

  /* Terminal theme overrides */
  .calendar-terminal :global(.ec) {
    --ec-bg-color: #0a0a0a;
    --ec-border-color: rgba(0, 255, 0, 0.2);
    --ec-text-color: #00ff00;
    --ec-today-bg-color: rgba(0, 255, 0, 0.05);
    --ec-highlight-color: rgba(0, 255, 0, 0.1);
    --ec-active-bg-color: rgba(0, 255, 0, 0.15);
    --ec-btn-bg-color: transparent;
    --ec-btn-border-color: rgba(0, 255, 0, 0.3);
    --ec-btn-text-color: #00ff00;
    --ec-btn-hover-bg-color: rgba(0, 255, 0, 0.1);
    --ec-btn-active-bg-color: rgba(0, 255, 0, 0.2);
    --ec-btn-active-border-color: #00ff00;
    --ec-now-indicator-color: #00ff00;
    --ec-event-text-color: #000;
    --ec-list-day-bg-color: rgba(0, 255, 0, 0.05);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .calendar-terminal :global(.ec-toolbar) {
    color: #00ff00;
  }

  .calendar-terminal :global(.ec-day-head) {
    color: rgba(0, 255, 0, 0.7);
  }

  /* Modern theme overrides */
  .calendar-modern :global(.ec) {
    --ec-bg-color: var(--color-chat-bg, #fff);
    --ec-border-color: var(--color-chat-border, #e5e7eb);
    --ec-text-color: var(--color-chat-text, #1f2937);
    --ec-today-bg-color: rgba(96, 165, 250, 0.05);
    --ec-highlight-color: rgba(96, 165, 250, 0.1);
    --ec-active-bg-color: rgba(96, 165, 250, 0.15);
    --ec-now-indicator-color: #3b82f6;
    --ec-event-text-color: #fff;
  }

  :global(.dark) .calendar-modern :global(.ec) {
    --ec-bg-color: var(--color-chat-bg-dark, #1a1a2e);
    --ec-border-color: var(--color-chat-border-dark, #374151);
    --ec-text-color: var(--color-chat-text-dark, #e5e7eb);
  }
</style>
