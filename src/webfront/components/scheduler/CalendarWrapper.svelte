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
  }: {
    events?: CalendarEvent[];
    initialView?: string;
    ondatesset?: (detail: { start: Date; end: Date; view: any }) => void;
    ondateclick?: (detail: { date: Date; dateStr: string }) => void;
    oneventclick?: (detail: { event: any; el: any; jsEvent: MouseEvent }) => void;
    oneventdrop?: (detail: { event: any; oldEvent: any }) => void;
    onselect?: (detail: { start: Date; end: Date; startStr: string; endStr: string }) => void;
  } = $props();

  let currentTheme = $state<UITheme>('terminal');

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  let calendarOptions = $derived({
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
      ondateclick?.({ date: info.date, dateStr: info.dateStr });
    },
    eventClick: (info: any) => {
      oneventclick?.({ event: info.event, el: info.el, jsEvent: info.jsEvent });
    },
    eventDrop: (info: any) => {
      oneventdrop?.({ event: info.event, oldEvent: info.oldEvent });
    },
    datesSet: (info: any) => {
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
