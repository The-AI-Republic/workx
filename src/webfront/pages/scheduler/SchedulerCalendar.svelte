<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { uiTheme, themePreference, type UITheme } from '../../stores/themeStore';
  import { isWideMode } from '../../stores/layoutStore';
  import { AgentConfig } from '@/config/AgentConfig';
  import { _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { tryGetMessageService } from '@/core/messaging';
  import { jobsToCalendarEvents, instancesToCalendarEvents, type CalendarEvent } from '../../lib/calendarUtils';
  import CalendarWrapper from '../../components/scheduler/CalendarWrapper.svelte';
  import ScheduleJobModal from '../../components/scheduler/ScheduleJobModal.svelte';
  import EventPopover from '../../components/scheduler/EventPopover.svelte';

  let currentTheme = $state<UITheme>('terminal');
  let calendarEvents = $state<CalendarEvent[]>([]);
  let initialView = $state('timeGridWeek');
  let eventUnsubscribers: Array<() => void> = [];

  // Date range for current view
  let viewStart = $state(0);
  let viewEnd = $state(0);

  // Schedule modal state
  let showScheduleModal = $state(false);
  let prefillDate = $state('');
  let prefillTime = $state('');

  // Popover state
  let showPopover = $state(false);
  let popoverJob = $state<any>(null);
  let popoverPosition = $state({ x: 0, y: 0 });

  // Initialize theme from saved config (same as Scheduler.svelte)
  $effect(() => {
    AgentConfig.getInstance().then((config) => {
      const preferences = config.getConfig().preferences;
      if (preferences?.uiTheme) {
        themePreference.initialize(preferences.uiTheme);
      }
    });
  });

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  $effect(() => {
    const unsub = isWideMode.subscribe((wide) => {
      initialView = wide ? 'timeGridWeek' : 'timeGridDay';
    });
    return unsub;
  });

  function handleSchedulerEvent(message: { type: string }) {
    if (message.type === MessageType.SCHEDULER_EVENT) {
      fetchEvents();
    }
  }

  async function fetchEvents() {
    if (!viewStart || !viewEnd) return;
    try {
      const theme = currentTheme === 'modern' ? 'modern' : 'terminal';

      // Try new model first (SCHEDULE_GET_EVENTS_IN_RANGE returns CalendarInstances)
      let newModelEvents: CalendarEvent[] = [];
      try {
        const instanceResponse = await sendMessage<{ data?: { instances?: any[] }; instances?: any[] }>(
          MessageType.SCHEDULE_GET_EVENTS_IN_RANGE,
          { startTime: viewStart, endTime: viewEnd }
        );
        const instanceData = instanceResponse?.data || instanceResponse;
        const instances = instanceData?.instances || [];
        if (instances.length > 0) {
          newModelEvents = instancesToCalendarEvents(instances, theme);
        }
      } catch {
        // New model not available yet — fall through to legacy
      }

      // Legacy model (SCHEDULER_GET_ALL_JOBS_IN_RANGE returns SchedulerJobRecords)
      const response = await sendMessage<{ data?: { jobs?: any[] }; jobs?: any[] }>(
        MessageType.SCHEDULER_GET_ALL_JOBS_IN_RANGE,
        { startTime: viewStart, endTime: viewEnd }
      );
      const data = response?.data || response;
      const jobs = data?.jobs || [];
      const legacyEvents = jobsToCalendarEvents(jobs, theme);

      // Merge: new model events take precedence, deduplicate by event/job ID
      const newModelIds = new Set(newModelEvents.map(e => {
        // Instance IDs are "eventId:instanceTime" — extract the eventId part
        const colonIdx = e.id.indexOf(':');
        return colonIdx >= 0 ? e.id.substring(0, colonIdx) : e.id;
      }));
      const uniqueLegacy = legacyEvents.filter(e => !newModelIds.has(e.id));
      calendarEvents = [...newModelEvents, ...uniqueLegacy];
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to fetch events:', error);
    }
  }

  function handleDatesSet(detail: { start: Date; end: Date; view: any }) {
    viewStart = detail.start.getTime();
    viewEnd = detail.end.getTime();
    fetchEvents();
  }

  function handleDateClick(detail: { date: Date; dateStr: string }) {
    const date = detail.date;
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

  // Instance popover state
  let popoverInstance = $state<any>(null);

  function handleEventClick(detail: { event: any; jsEvent: MouseEvent }) {
    const instance = detail.event.extendedProps?.instance;
    const job = detail.event.extendedProps?.job;
    if (!instance && !job) return;

    popoverJob = job || null;
    popoverInstance = instance || null;
    popoverPosition = { x: detail.jsEvent.clientX, y: detail.jsEvent.clientY };
    showPopover = true;
  }

  async function handleEventDrop(detail: { event: any; oldEvent: any }) {
    const event = detail.event;
    const eventId = event.id as string;
    const newTime = event.start.getTime();
    const instance = event.extendedProps?.instance;

    try {
      if (instance) {
        // New model: edit instance with overrideTime
        await sendMessage(MessageType.SCHEDULE_EDIT_INSTANCE, {
          scheduleEventId: instance.scheduleEventId,
          instanceTime: instance.instanceTime,
          overrides: { overrideTime: newTime },
        });
      } else {
        // Legacy model: reschedule job
        await sendMessage(MessageType.SCHEDULER_RESCHEDULE_JOB, { jobId: eventId, scheduledTime: newTime });
      }
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to reschedule:', error);
      await fetchEvents(); // Revert by re-fetching
    }
  }

  async function handleSchedule(detail: { input: string; scheduledTime: number; recurrence?: any }) {
    const { input, scheduledTime, recurrence } = detail;
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

  async function handlePopoverTrigger(detail: { jobId: string }) {
    showPopover = false;
    try {
      await sendMessage(MessageType.SCHEDULER_TRIGGER_JOB, { jobId: detail.jobId });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to trigger job:', error);
    }
  }

  async function handlePopoverCancel(detail: { jobId: string }) {
    showPopover = false;
    try {
      await sendMessage(MessageType.SCHEDULER_CANCEL_JOB, { jobId: detail.jobId });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to cancel job:', error);
    }
  }

  async function handleDeleteInstance(detail: { scheduleEventId: string; instanceTime: number }) {
    showPopover = false;
    try {
      await sendMessage(MessageType.SCHEDULE_DELETE_INSTANCE, detail);
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to delete instance:', error);
    }
  }

  async function handleEditInstance(detail: { scheduleEventId: string; instanceTime: number }) {
    showPopover = false;
    const currentInput = popoverInstance?.input ?? popoverJob?.input ?? '';
    const newInput = window.prompt('Edit instance prompt:', currentInput);
    if (newInput === null || newInput === currentInput) return; // cancelled or unchanged
    try {
      await sendMessage(MessageType.SCHEDULE_EDIT_INSTANCE, {
        scheduleEventId: detail.scheduleEventId,
        instanceTime: detail.instanceTime,
        overrides: { overrideInput: newInput },
      });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to edit instance:', error);
    }
  }

  async function handleEditSeries(detail: { scheduleEventId: string }) {
    showPopover = false;
    const currentInput = popoverInstance?.input ?? popoverJob?.input ?? '';
    const newInput = window.prompt('Edit series prompt:', currentInput);
    if (newInput === null || newInput === currentInput) return;
    try {
      await sendMessage(MessageType.SCHEDULE_UPDATE_EVENT, {
        eventId: detail.scheduleEventId,
        updates: { input: newInput },
      });
      await fetchEvents();
    } catch (error) {
      console.error('[SchedulerCalendar] Failed to edit series:', error);
    }
  }

  function handleNewClick() {
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    prefillDate = `${year}-${month}-${day}`;
    prefillTime = `${String(now.getHours()).padStart(2, '0')}:00`;
    showPopover = false;
    showScheduleModal = true;
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
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleSchedulerEvent);
    }
    eventUnsubscribers.forEach(fn => fn());
  });
</script>

<div class="flex flex-col h-full {currentTheme}
  {currentTheme === 'modern'
    ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
    : 'font-terminal bg-term-bg text-term-green'}">
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
      onclick={() => push('/scheduler')}
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
    <button
      class="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs rounded cursor-pointer transition-all duration-200
        {currentTheme === 'modern'
          ? 'bg-chat-primary dark:bg-chat-primary-dark text-white border-none hover:opacity-90'
          : 'bg-transparent border border-term-dim-green text-term-green hover:bg-[rgba(0,255,0,0.1)]'}"
      onclick={handleNewClick}
      title={$_t('New Schedule')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      {$_t('New')}
    </button>
  </div>

  <!-- Calendar -->
  <div class="flex-1 overflow-auto p-2">
    <CalendarWrapper
      events={calendarEvents}
      {initialView}
      ondatesset={handleDatesSet}
      ondateclick={handleDateClick}
      oneventclick={handleEventClick}
      oneventdrop={handleEventDrop}
    />
  </div>
</div>

<!-- Schedule Job Modal -->
<ScheduleJobModal
  show={showScheduleModal}
  input=""
  {prefillDate}
  {prefillTime}
  onclose={() => showScheduleModal = false}
  onschedule={handleSchedule}
/>

<!-- Event Popover -->
{#if showPopover && (popoverJob || popoverInstance)}
  <EventPopover
    job={popoverJob}
    instance={popoverInstance}
    show={showPopover}
    position={popoverPosition}
    ontrigger={handlePopoverTrigger}
    oncancel={handlePopoverCancel}
    oneditinstance={handleEditInstance}
    oneditseries={handleEditSeries}
    ondeleteinstance={handleDeleteInstance}
    onclose={() => showPopover = false}
  />
{/if}
