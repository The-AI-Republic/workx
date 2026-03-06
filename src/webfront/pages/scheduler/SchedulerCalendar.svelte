<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { isWideMode } from '../../stores/layoutStore';
  import { _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { tryGetMessageService } from '@/core/messaging';
  import { jobsToCalendarEvents, type CalendarEvent } from '../../lib/calendarUtils';
  import CalendarWrapper from '../../components/scheduler/CalendarWrapper.svelte';
  import ScheduleJobModal from '../../components/scheduler/ScheduleJobModal.svelte';
  import EventPopover from '../../components/scheduler/EventPopover.svelte';

  let currentTheme: UITheme = 'terminal';
  let calendarEvents: CalendarEvent[] = [];
  let initialView = 'timeGridWeek';
  let eventUnsubscribers: Array<() => void> = [];

  // Date range for current view
  let viewStart: number = 0;
  let viewEnd: number = 0;

  // Schedule modal state
  let showScheduleModal = false;
  let prefillDate = '';
  let prefillTime = '';

  // Popover state
  let showPopover = false;
  let popoverJob: any = null;
  let popoverPosition = { x: 0, y: 0 };

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  const unsubWide = isWideMode.subscribe((wide) => {
    initialView = wide ? 'timeGridWeek' : 'timeGridDay';
  });

  function handleSchedulerEvent(message: { type: string }) {
    if (message.type === MessageType.SCHEDULER_EVENT) {
      fetchEvents();
    }
  }

  async function fetchEvents() {
    if (!viewStart || !viewEnd) return;
    try {
      const response = await sendMessage<{ data?: { jobs?: any[] }; jobs?: any[] }>(
        MessageType.SCHEDULER_GET_ALL_JOBS_IN_RANGE,
        { startTime: viewStart, endTime: viewEnd }
      );
      const data = response?.data || response;
      const jobs = data?.jobs || [];
      const theme = currentTheme === 'modern' ? 'modern' : 'terminal';
      calendarEvents = jobsToCalendarEvents(jobs, theme);
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to fetch events:', error);
    }
  }

  function handleDatesSet(e: CustomEvent<{ start: Date; end: Date }>) {
    viewStart = e.detail.start.getTime();
    viewEnd = e.detail.end.getTime();
    fetchEvents();
  }

  function handleDateClick(e: CustomEvent<{ date: Date; dateStr: string }>) {
    const date = e.detail.date;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    prefillDate = `${year}-${month}-${day}`;

    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    if (hours === '00' && minutes === '00') {
      // Month view click — default to next rounded hour
      const now = new Date();
      now.setHours(now.getHours() + 1, 0, 0, 0);
      prefillTime = `${String(now.getHours()).padStart(2, '0')}:00`;
    } else {
      prefillTime = `${hours}:${minutes}`;
    }

    showPopover = false;
    showScheduleModal = true;
  }

  function handleEventClick(e: CustomEvent<{ event: any; jsEvent: MouseEvent }>) {
    const job = e.detail.event.extendedProps?.job;
    if (!job) return;

    popoverJob = job;
    popoverPosition = { x: e.detail.jsEvent.clientX, y: e.detail.jsEvent.clientY };
    showPopover = true;
  }

  async function handleEventDrop(e: CustomEvent<{ event: any; oldEvent: any }>) {
    const event = e.detail.event;
    const jobId = event.id;
    const newTime = event.start.getTime();

    try {
      await sendMessage(MessageType.SCHEDULER_RESCHEDULE_JOB, { jobId, scheduledTime: newTime });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to reschedule job:', error);
      await fetchEvents(); // Revert by re-fetching
    }
  }

  async function handleSchedule(e: CustomEvent<{ input: string; scheduledTime: number; recurrence?: any }>) {
    const { input, scheduledTime, recurrence } = e.detail;
    showScheduleModal = false;

    try {
      const payload: any = { input, scheduledTime };
      if (recurrence) payload.recurrence = recurrence;
      await sendMessage(MessageType.SCHEDULER_SCHEDULE_JOB, payload);
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to schedule job:', error);
    }
  }

  async function handlePopoverTrigger(e: CustomEvent<{ jobId: string }>) {
    showPopover = false;
    try {
      await sendMessage(MessageType.SCHEDULER_TRIGGER_JOB, { jobId: e.detail.jobId });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to trigger job:', error);
    }
  }

  async function handlePopoverCancel(e: CustomEvent<{ jobId: string }>) {
    showPopover = false;
    try {
      await sendMessage(MessageType.SCHEDULER_CANCEL_JOB, { jobId: e.detail.jobId });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to cancel job:', error);
    }
  }

  onMount(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleSchedulerEvent);
    }
    const service = tryGetMessageService();
    if (service) {
      const unsub = service.on(MessageType.SCHEDULER_EVENT, () => fetchEvents());
      if (unsub) eventUnsubscribers.push(unsub);
    }
  });

  onDestroy(() => {
    unsubTheme();
    unsubWide();
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleSchedulerEvent);
    }
    eventUnsubscribers.forEach(fn => fn());
  });
</script>

<div class="flex flex-col h-full {currentTheme === 'modern' ? 'font-chat' : 'font-terminal'}">
  <!-- Header -->
  <div class="flex items-center gap-3 px-4 py-3 shrink-0
    {currentTheme === 'modern'
      ? 'border-b border-chat-border dark:border-chat-border-dark'
      : 'border-b border-term-dim-green'}">
    <button
      class="p-1.5 rounded cursor-pointer transition-all duration-200 border-none
        {currentTheme === 'modern'
          ? 'bg-transparent text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
          : 'bg-transparent text-term-dim-green hover:bg-[rgba(0,255,0,0.1)] hover:text-term-green'}"
      on:click={() => push('/scheduler')}
      title={$_t('Back to Scheduler')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </button>
    <h1 class="m-0 text-base font-semibold
      {currentTheme === 'modern'
        ? 'text-chat-text dark:text-chat-text-dark'
        : 'text-term-green'}">
      {$_t('Calendar')}
    </h1>
  </div>

  <!-- Calendar -->
  <div class="flex-1 overflow-auto p-2">
    <CalendarWrapper
      events={calendarEvents}
      {initialView}
      on:datesSet={handleDatesSet}
      on:dateClick={handleDateClick}
      on:eventClick={handleEventClick}
      on:eventDrop={handleEventDrop}
    />
  </div>
</div>

<!-- Schedule Job Modal -->
<ScheduleJobModal
  show={showScheduleModal}
  input=""
  {prefillDate}
  {prefillTime}
  on:close={() => showScheduleModal = false}
  on:schedule={handleSchedule}
/>

<!-- Event Popover -->
{#if showPopover && popoverJob}
  <EventPopover
    job={popoverJob}
    show={showPopover}
    position={popoverPosition}
    on:trigger={handlePopoverTrigger}
    on:cancel={handlePopoverCancel}
    on:close={() => showPopover = false}
  />
{/if}
