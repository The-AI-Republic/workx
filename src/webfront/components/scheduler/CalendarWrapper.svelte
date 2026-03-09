<script lang="ts">
  import { Calendar, DayGrid, TimeGrid, Interaction } from '@event-calendar/core';
  import '@event-calendar/core/index.css';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import type { CalendarEvent } from '../../lib/calendarUtils';

  let {
    events = [],
    initialView = 'timeGridWeek',
    ondatesset,
    ondateclick,
    oneventclick,
    oneventdrop,
    onselect,
    onnewclick,
  }: {
    events?: CalendarEvent[];
    initialView?: string;
    ondatesset?: (detail: { start: Date; end: Date; view: any }) => void;
    ondateclick?: (detail: { date: Date; dateStr: string }) => void;
    oneventclick?: (detail: { event: any; el: any; jsEvent: MouseEvent }) => void;
    oneventdrop?: (detail: { event: any; oldEvent: any }) => void;
    onselect?: (detail: { start: Date; end: Date; startStr: string; endStr: string }) => void;
    onnewclick?: () => void;
  } = $props();

  let currentTheme = $state<UITheme>('terminal');
  let currentView = $derived(initialView);

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  let calendarOptions = $derived({
    view: currentView,
    events: events,
    customButtons: {
      newEvent: {
        text: '+ New',
        click: () => onnewclick?.(),
      },
    },
    headerToolbar: {
      start: 'prev,next today newEvent',
      center: 'title',
      end: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    displayEventEnd: false,
    eventContent: (info: { event: any; timeText: string }) => {
      const time = document.createElement('div');
      time.className = 'ec-event-time';
      time.textContent = `start: ${info.timeText}`;
      const title = document.createElement('div');
      title.className = 'ec-event-title';
      title.textContent = info.event.title;
      return { domNodes: [time, title] };
    },
    editable: true,
    eventStartEditable: true,
    selectable: true,
    unselectAuto: true,
    selectMinDistance: 5,
    nowIndicator: true,
    scrollTime: '08:00:00',
    dateClick: (info: any) => {
      ondateclick?.({ date: info.date, dateStr: info.dateStr });
    },
    eventClick: (info: any) => {
      oneventclick?.({ event: info.event, el: info.el, jsEvent: info.jsEvent });
    },
    eventDrop: (info: any) => {
      oneventdrop?.({ event: info.event, oldEvent: info.oldEvent });
    },
    datesSet: (info: any) => {
      // Track user's view selection so it doesn't reset on data refresh
      if (info.view?.type) {
        currentView = info.view.type;
      }
      ondatesset?.({ start: info.start, end: info.end, view: info.view });
    },
    select: (info: any) => {
      onselect?.({ start: info.start, end: info.end, startStr: info.startStr, endStr: info.endStr });
    },
  });
</script>

<div class="calendar-wrapper {currentTheme === 'terminal' ? 'calendar-terminal' : 'calendar-modern'}">
  <Calendar plugins={[DayGrid, TimeGrid, Interaction]} options={calendarOptions} />
</div>

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
    --ec-button-bg-color: transparent;
    --ec-button-border-color: rgba(0, 255, 0, 0.3);
    --ec-button-text-color: #00ff00;
    --ec-button-active-bg-color: rgba(0, 255, 0, 0.2);
    --ec-button-active-border-color: #00ff00;
    --ec-button-active-text-color: #00ff00;
    --ec-now-indicator-color: #00ff00;
    --ec-event-text-color: #000;
    --ec-list-day-bg-color: rgba(0, 255, 0, 0.05);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .calendar-terminal :global(.ec-toolbar) {
    color: #00ff00;
  }

  .calendar-terminal :global(.ec-newEvent) {
    border-color: #00ff00;
    color: #00ff00;
    font-weight: 600;
    margin-left: 0.5rem;
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

  .calendar-modern :global(.ec-newEvent) {
    background-color: var(--color-chat-primary, #3b82f6);
    border-color: var(--color-chat-primary, #3b82f6);
    color: #fff;
    font-weight: 600;
    margin-left: 0.5rem;
  }

  :global(.dark) .calendar-modern :global(.ec-newEvent) {
    background-color: var(--color-chat-primary-dark, #2563eb);
    border-color: var(--color-chat-primary-dark, #2563eb);
    color: #fff;
  }

  :global(.dark) .calendar-modern :global(.ec) {
    --ec-bg-color: var(--color-chat-bg-dark, #1a1a2e);
    --ec-border-color: var(--color-chat-border-dark, #374151);
    --ec-text-color: var(--color-chat-text-dark, #e5e7eb);
    --ec-button-bg-color: var(--color-chat-bg-dark, #1a1a2e);
    --ec-button-border-color: var(--color-chat-border-dark, #374151);
    --ec-button-text-color: var(--color-chat-text-dark, #e5e7eb);
    --ec-button-active-bg-color: rgba(96, 165, 250, 0.2);
    --ec-button-active-border-color: #3b82f6;
    --ec-button-active-text-color: #e5e7eb;
  }
</style>
