/**
 * ScheduleManager
 *
 * Manages schedule events: CRUD, RRULE expansion, EXDATE exceptions,
 * alarm management, and virtual instance generation for calendar display.
 *
 * This handles "when to run" — separated from "how to run" (JobExecutor).
 */

import { v4 as uuidv4 } from 'uuid';
import type { IScheduleStorage } from '../models/types/ScheduleContracts';
import type { IExecutionStorage } from '../models/types/ScheduleContracts';
import type {
  ScheduleEvent,
  CalendarInstance,
  CalendarInstanceStatus,
  ScheduleEventException,
} from '../models/types/ScheduleEvent';
import { createScheduleEvent } from '../models/types/ScheduleEvent';
import type { ISchedulerAlarms } from '../models/types/SchedulerContracts';
import {
  expandInstances,
  getNextInstance,
  rruleToDescription,
} from './rruleAdapter';

/**
 * Callback to fire when an alarm triggers for an event instance.
 */
export type AlarmFiredHandler = (scheduleEventId: string, instanceTime: number, input: string) => Promise<void>;

export class ScheduleManager {
  private alarmFiredHandler: AlarmFiredHandler | null = null;

  constructor(
    private scheduleStorage: IScheduleStorage,
    private executionStorage: IExecutionStorage,
    private alarms: ISchedulerAlarms,
  ) {}

  /**
   * Set the callback for when an alarm fires (delegates to JobExecutor).
   */
  setAlarmFiredHandler(handler: AlarmFiredHandler): void {
    this.alarmFiredHandler = handler;
  }

  // ==========================================================================
  // Event CRUD
  // ==========================================================================

  /**
   * Create a new schedule event and arm its first alarm.
   */
  async createEvent(
    input: string,
    scheduledTime: number,
    rrule: string | null = null,
    id?: string,
    options?: { skipAlarmAndValidation?: boolean }
  ): Promise<ScheduleEvent> {
    if (!options?.skipAlarmAndValidation) {
      const now = Date.now();
      if (scheduledTime <= now) {
        throw new Error('Scheduled time must be in the future');
      }
    }

    const eventId = id || uuidv4();
    const event = createScheduleEvent(eventId, input, scheduledTime, rrule);
    await this.scheduleStorage.createEvent(event);

    // Arm alarm for the first occurrence (skip if caller already managed the alarm)
    if (!options?.skipAlarmAndValidation) {
      try {
        await this.alarms.createJobAlarm(eventId, scheduledTime);
      } catch (error) {
        await this.scheduleStorage.deleteEvent(eventId);
        throw error;
      }
    }

    return event;
  }

  /**
   * Get a single event by ID.
   */
  async getEvent(id: string): Promise<ScheduleEvent | null> {
    return this.scheduleStorage.getEvent(id);
  }

  /**
   * Edit an entire series (all future instances).
   */
  async editSeries(
    eventId: string,
    updates: Partial<Pick<ScheduleEvent, 'input' | 'scheduledTime' | 'rrule' | 'enabled'>>
  ): Promise<void> {
    const event = await this.scheduleStorage.getEvent(eventId);
    if (!event) throw new Error(`Schedule event not found: ${eventId}`);

    // Validate scheduledTime is in the future if being updated
    if (updates.scheduledTime !== undefined && updates.scheduledTime <= Date.now()) {
      throw new Error('Scheduled time must be in the future');
    }

    await this.scheduleStorage.updateEvent(eventId, {
      ...updates,
      updatedAt: Date.now(),
    });

    // If the scheduled time changed, re-arm the alarm
    if (updates.scheduledTime !== undefined || updates.enabled !== undefined) {
      await this.alarms.clearJobAlarm(eventId);
      const updatedEvent = await this.scheduleStorage.getEvent(eventId);
      if (updatedEvent && updatedEvent.enabled) {
        await this.armNextAlarm(eventId);
      }
    }
  }

  /**
   * Edit a single instance by creating an exception.
   */
  async editInstance(
    eventId: string,
    instanceTime: number,
    overrides: { overrideInput?: string; overrideTime?: number }
  ): Promise<void> {
    const event = await this.scheduleStorage.getEvent(eventId);
    if (!event) throw new Error(`Schedule event not found: ${eventId}`);

    const exception: ScheduleEventException = {
      scheduleEventId: eventId,
      instanceTime,
      ...overrides,
    };

    // Upsert: delete existing then create
    await this.scheduleStorage.deleteException(eventId, instanceTime);
    await this.scheduleStorage.createException(exception);
  }

  /**
   * Delete a single instance by adding an EXDATE.
   */
  async deleteInstance(eventId: string, instanceTime: number): Promise<void> {
    const event = await this.scheduleStorage.getEvent(eventId);
    if (!event) throw new Error(`Schedule event not found: ${eventId}`);

    const exdates = [...event.exdates, instanceTime];
    await this.scheduleStorage.updateEvent(eventId, {
      exdates,
      updatedAt: Date.now(),
    });

    // Clean up any exception for this instance
    await this.scheduleStorage.deleteException(eventId, instanceTime);
  }

  /**
   * Delete an entire event series.
   */
  async deleteEvent(eventId: string): Promise<void> {
    await this.alarms.clearJobAlarm(eventId);
    await this.scheduleStorage.deleteAllExceptions(eventId);

    // Clean up orphaned execution records
    const executions = await this.executionStorage.getExecutionsByEvent(eventId);
    for (const exec of executions) {
      await this.executionStorage.deleteExecution(exec.id);
    }

    await this.scheduleStorage.deleteEvent(eventId);
  }

  /**
   * Enable or disable an event.
   */
  async setEnabled(eventId: string, enabled: boolean): Promise<void> {
    await this.scheduleStorage.updateEvent(eventId, {
      enabled,
      updatedAt: Date.now(),
    });

    if (enabled) {
      await this.armNextAlarm(eventId);
    } else {
      await this.alarms.clearJobAlarm(eventId);
    }
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * Get all enabled events with future scheduled times (replaces legacy getScheduledJobs).
   */
  async getScheduledEvents(): Promise<ScheduleEvent[]> {
    const events = await this.scheduleStorage.getEnabledEvents();
    const now = Date.now();
    return events.filter(e => {
      if (e.rrule) {
        // Recurring events are always "scheduled" while enabled
        return true;
      }
      // One-shot: only if scheduledTime is in the future
      return e.scheduledTime > now;
    });
  }

  /**
   * Get enabled events that are past their scheduled time with no execution
   * (replaces legacy getMissedJobs).
   */
  async getMissedInstances(): Promise<Array<{ event: ScheduleEvent; instanceTime: number }>> {
    const events = await this.scheduleStorage.getEnabledEvents();
    const now = Date.now();
    const missed: Array<{ event: ScheduleEvent; instanceTime: number }> = [];

    for (const event of events) {
      if (event.rrule) {
        // For recurring: find instances between scheduledTime and now with no execution
        const instances = expandInstances(
          event.rrule,
          event.scheduledTime,
          event.scheduledTime,
          now,
          event.exdates
        );
        for (const instanceTime of instances) {
          const execution = await this.executionStorage.getExecutionByInstance(event.id, instanceTime);
          if (!execution) {
            missed.push({ event, instanceTime });
          }
        }
      } else {
        // One-shot: missed if scheduledTime < now and no execution
        if (event.scheduledTime < now) {
          const execution = await this.executionStorage.getExecutionByInstance(event.id, event.scheduledTime);
          if (!execution) {
            missed.push({ event, instanceTime: event.scheduledTime });
          }
        }
      }
    }

    return missed;
  }

  /**
   * Get all events (for reconciliation, etc.)
   */
  async getAllEvents(): Promise<ScheduleEvent[]> {
    return this.scheduleStorage.getAllEvents();
  }

  // ==========================================================================
  // Instance Expansion
  // ==========================================================================

  /**
   * Get all calendar instances within a time range.
   * Expands RRULE, applies exceptions/exdates, merges with execution records.
   */
  async getInstancesInRange(startTime: number, endTime: number): Promise<CalendarInstance[]> {
    const events = await this.scheduleStorage.getEventsInRange(startTime, endTime);
    const executions = await this.executionStorage.getExecutionsInRange(startTime, endTime);

    // Index executions by [eventId, instanceTime]
    const executionMap = new Map<string, typeof executions[number]>();
    for (const exec of executions) {
      executionMap.set(`${exec.scheduleEventId}:${exec.instanceTime}`, exec);
    }

    const instances: CalendarInstance[] = [];

    for (const event of events) {
      // Get exceptions for this event
      const exceptions = await this.scheduleStorage.getExceptions(event.id);
      const exceptionMap = new Map(
        exceptions.map(ex => [ex.instanceTime, ex])
      );

      // Expand instances
      let instanceTimes: number[];
      if (event.rrule) {
        instanceTimes = expandInstances(
          event.rrule,
          event.scheduledTime,
          startTime,
          endTime,
          event.exdates
        );
      } else {
        // One-shot event: just the scheduled time
        if (event.scheduledTime >= startTime && event.scheduledTime <= endTime) {
          instanceTimes = [event.scheduledTime];
        } else {
          instanceTimes = [];
        }
      }

      const rruleDesc = event.rrule
        ? rruleToDescription(event.rrule, event.scheduledTime)
        : undefined;

      for (const time of instanceTimes) {
        const exception = exceptionMap.get(time);
        const effectiveTime = exception?.overrideTime ?? time;
        const effectiveInput = exception?.overrideInput ?? event.input;

        const execKey = `${event.id}:${time}`;
        const execution = executionMap.get(execKey);

        let status: CalendarInstanceStatus;
        if (execution) {
          switch (execution.status) {
            case 'running': status = 'running'; break;
            case 'completed': status = 'completed'; break;
            case 'failed': status = 'failed'; break;
            case 'cancelled': status = 'cancelled'; break;
            default: status = 'upcoming'; break;
          }
        } else if (effectiveTime < Date.now()) {
          status = 'missed';
        } else {
          status = 'upcoming';
        }

        instances.push({
          scheduleEventId: event.id,
          instanceTime: effectiveTime,
          input: effectiveInput,
          status,
          executionId: execution?.id,
          isVirtual: !execution,
          rruleDescription: rruleDesc,
          enabled: event.enabled,
        });
      }
    }

    // Sort by instance time
    instances.sort((a, b) => a.instanceTime - b.instanceTime);
    return instances;
  }

  // ==========================================================================
  // Alarm Management
  // ==========================================================================

  /**
   * Arm the next alarm for an event (finds the next future occurrence).
   */
  async armNextAlarm(eventId: string): Promise<void> {
    const event = await this.scheduleStorage.getEvent(eventId);
    if (!event || !event.enabled) return;

    await this.alarms.clearJobAlarm(eventId);

    const now = Date.now();

    if (event.rrule) {
      const nextTime = getNextInstance(
        event.rrule,
        event.scheduledTime,
        now,
        event.exdates
      );
      if (nextTime) {
        await this.alarms.createJobAlarm(eventId, nextTime);
      }
    } else {
      // One-shot: only arm if still in the future
      if (event.scheduledTime > now) {
        await this.alarms.createJobAlarm(eventId, event.scheduledTime);
      }
    }
  }

  /**
   * Handle an alarm firing for an event.
   * Determines the instance time and delegates to JobExecutor via callback.
   */
  async handleAlarmFired(eventId: string): Promise<void> {
    const event = await this.scheduleStorage.getEvent(eventId);
    if (!event || !event.enabled) return;

    // Determine which instance just fired
    const now = Date.now();
    let instanceTime: number;

    if (event.rrule) {
      // Find the most recent instance at or before now (with 5s tolerance for alarm jitter)
      const instances = expandInstances(
        event.rrule,
        event.scheduledTime,
        event.scheduledTime,
        now + 5000,
        event.exdates
      );
      if (instances.length === 0) return;
      // Use the last instance that is at or before now (not future)
      const pastInstances = instances.filter(t => t <= now + 5000);
      if (pastInstances.length === 0) return;
      instanceTime = pastInstances[pastInstances.length - 1];
    } else {
      instanceTime = event.scheduledTime;
    }

    // Check for exception overrides
    const exception = await this.scheduleStorage.getException(eventId, instanceTime);
    const effectiveInput = exception?.overrideInput ?? event.input;

    // Delegate to JobExecutor
    if (this.alarmFiredHandler) {
      await this.alarmFiredHandler(eventId, instanceTime, effectiveInput);
    }

    // Note: alarm re-arming is handled by the executionCompleteHandler callback
    // (wired in Scheduler constructor) to avoid double-arming.
  }

  /**
   * Arm alarms for all enabled events on startup.
   */
  async restoreAlarms(): Promise<void> {
    const events = await this.scheduleStorage.getEnabledEvents();
    for (const event of events) {
      await this.armNextAlarm(event.id);
    }
  }
}
