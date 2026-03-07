/**
 * Schedule Event Storage (IndexedDB)
 *
 * IndexedDB implementation of IScheduleStorage for extension/desktop modes.
 */

import type { StorageAdapter } from '../../storage/StorageAdapter';
import {
  SCHEDULE_EVENTS_STORE,
  SCHEDULE_EXCEPTIONS_STORE,
} from '../models/types/ScheduleContracts';
import type { IScheduleStorage } from '../models/types/ScheduleContracts';
import type {
  ScheduleEvent,
  ScheduleEventException,
} from '../models/types/ScheduleEvent';

export class ScheduleEventStorage implements IScheduleStorage {
  constructor(private db: StorageAdapter) {}

  // ==========================================================================
  // Event CRUD
  // ==========================================================================

  async createEvent(event: ScheduleEvent): Promise<void> {
    await this.db.put(SCHEDULE_EVENTS_STORE, event);
  }

  async getEvent(id: string): Promise<ScheduleEvent | null> {
    return this.db.get<ScheduleEvent>(SCHEDULE_EVENTS_STORE, id);
  }

  async updateEvent(id: string, updates: Partial<ScheduleEvent>): Promise<void> {
    const existing = await this.getEvent(id);
    if (!existing) throw new Error(`Schedule event not found: ${id}`);

    const updated: ScheduleEvent = {
      ...existing,
      ...updates,
      id, // Preserve ID
    };
    await this.db.put(SCHEDULE_EVENTS_STORE, updated);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.db.delete(SCHEDULE_EVENTS_STORE, id);
  }

  // ==========================================================================
  // Event Queries
  // ==========================================================================

  async getAllEvents(): Promise<ScheduleEvent[]> {
    return this.db.getAll<ScheduleEvent>(SCHEDULE_EVENTS_STORE);
  }

  async getEnabledEvents(): Promise<ScheduleEvent[]> {
    // IndexedDB stores booleans natively — query with true, not 1
    return this.db.queryByIndex<ScheduleEvent>(
      SCHEDULE_EVENTS_STORE,
      'by_enabled',
      true
    ).catch(() => {
      // Fallback: filter manually if index query fails
      return this.getAllEvents().then(all => all.filter(e => e.enabled));
    });
  }

  async getEventsInRange(startTime: number, endTime: number): Promise<ScheduleEvent[]> {
    // Get all events and filter — events with RRULE may have scheduledTime
    // before startTime but still generate instances within the range
    const all = await this.getAllEvents();
    return all.filter(event => {
      if (event.rrule) {
        // Recurring events: include if scheduledTime <= endTime
        // (caller will expand RRULE to check actual instances)
        return event.scheduledTime <= endTime;
      }
      // One-shot: check if scheduledTime falls in range
      return event.scheduledTime >= startTime && event.scheduledTime <= endTime;
    });
  }

  // ==========================================================================
  // Exception CRUD
  // ==========================================================================

  async createException(exception: ScheduleEventException): Promise<void> {
    // Use composite key for storage
    const key = `${exception.scheduleEventId}:${exception.instanceTime}`;
    await this.db.put(SCHEDULE_EXCEPTIONS_STORE, { ...exception, id: key });
  }

  async getExceptions(scheduleEventId: string): Promise<ScheduleEventException[]> {
    return this.db.queryByIndex<ScheduleEventException & { id: string }>(
      SCHEDULE_EXCEPTIONS_STORE,
      'by_event_id',
      scheduleEventId
    ).catch(() => {
      // Fallback: get all and filter
      return this.db.getAll<ScheduleEventException & { id: string }>(SCHEDULE_EXCEPTIONS_STORE)
        .then(all => all.filter(e => e.scheduleEventId === scheduleEventId));
    });
  }

  async getException(
    scheduleEventId: string,
    instanceTime: number
  ): Promise<ScheduleEventException | null> {
    const key = `${scheduleEventId}:${instanceTime}`;
    return this.db.get<ScheduleEventException>(SCHEDULE_EXCEPTIONS_STORE, key);
  }

  async deleteException(scheduleEventId: string, instanceTime: number): Promise<void> {
    const key = `${scheduleEventId}:${instanceTime}`;
    await this.db.delete(SCHEDULE_EXCEPTIONS_STORE, key);
  }

  async deleteAllExceptions(scheduleEventId: string): Promise<void> {
    const exceptions = await this.getExceptions(scheduleEventId);
    for (const ex of exceptions) {
      const key = `${ex.scheduleEventId}:${ex.instanceTime}`;
      await this.db.delete(SCHEDULE_EXCEPTIONS_STORE, key);
    }
  }
}
